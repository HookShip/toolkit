// SPDX-License-Identifier: Apache-2.0

import {
  ADAPTER_CAPABILITY_SCHEMA_ID,
  ADAPTER_CAPABILITY_SCHEMA_VERSION,
  ADAPTER_OPERATIONS,
  ADAPTER_SDK_VERSION,
  createCapabilityDocument,
  type AdapterCapabilityDeclaration,
  type AdapterCapabilityDocument,
  type AdapterOperation,
  type CapabilityConstraintValue,
} from "@webhook-portal/adapter-sdk";
import { isCredentialFieldName } from "@webhook-portal/canonical-model/redaction";
import {
  AssessmentInputError,
  assessMigration,
  parseInventoryExportJson,
  renderAssessmentJson,
  renderAssessmentMarkdown,
  type TargetPolicy,
} from "@webhook-portal/migration-assessment";

import {
  booleanOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import {
  CliCommandError,
  ensurePositionals,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import { assertSingleStdinConsumer } from "./io.js";
import {
  assertAllowedKeys,
  assertNoCredentialValues,
  artifactFormat,
  emitArtifact,
  nonNegativeInteger,
  nonNegativeNumber,
  optionalBoolean,
  readExactContract,
  readStructuredInput,
  requireRecord,
  requiredOption,
  safeString,
  isPlainRecord,
} from "./learning-support.js";

const CAPABILITY_DOCUMENT_KEYS = new Set([
  "$schema",
  "adapter",
  "capabilities",
  "generatedAt",
  "kind",
  "operations",
  "schemaVersion",
  "sdkVersion",
]);

const ADAPTER_KEYS = new Set(["homepage", "id", "name", "vendor", "version"]);

const CAPABILITY_KEYS = new Set([
  "constraints",
  "idempotency",
  "operation",
  "reason",
  "sideEffecting",
  "status",
]);

function capabilityConstraint(
  value: unknown,
  label: string,
): CapabilityConstraintValue {
  if (
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.length <= 100 &&
    (value.every((item) => typeof item === "string") ||
      value.every((item) => typeof item === "number" && Number.isFinite(item)))
  ) {
    return value as readonly string[] | readonly number[];
  }
  throw new CliCommandError(
    CLI_EXIT_CODES.invalid,
    "INVALID_CAPABILITY_DOCUMENT",
    `${label} has an unsupported constraint value.`,
  );
}

function capabilityDeclaration(
  value: unknown,
  operation: AdapterOperation,
): AdapterCapabilityDeclaration {
  if (
    value === "supported" ||
    value === "degraded" ||
    value === "unsupported"
  ) {
    return value;
  }
  const record = requireRecord(value, `Capability ${operation}`);
  assertAllowedKeys(record, CAPABILITY_KEYS, `Capability ${operation}`);
  if (record["operation"] !== undefined && record["operation"] !== operation) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_CAPABILITY_DOCUMENT",
      "Capability operation metadata is inconsistent.",
    );
  }
  const status = record["status"];
  if (
    status !== "supported" &&
    status !== "degraded" &&
    status !== "unsupported"
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_CAPABILITY_DOCUMENT",
      `Capability ${operation} has an invalid status.`,
    );
  }
  const idempotency = record["idempotency"];
  if (
    idempotency !== undefined &&
    idempotency !== "not_applicable" &&
    idempotency !== "required" &&
    idempotency !== "supported"
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_CAPABILITY_DOCUMENT",
      `Capability ${operation} has invalid idempotency metadata.`,
    );
  }
  const sideEffecting = record["sideEffecting"];
  if (sideEffecting !== undefined && typeof sideEffecting !== "boolean") {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_CAPABILITY_DOCUMENT",
      `Capability ${operation} has invalid side-effect metadata.`,
    );
  }
  let constraints: Record<string, CapabilityConstraintValue> | undefined;
  if (record["constraints"] !== undefined) {
    const rawConstraints = requireRecord(
      record["constraints"],
      `Capability ${operation} constraints`,
    );
    constraints = {};
    for (const [name, constraint] of Object.entries(rawConstraints)) {
      if (isCredentialFieldName(name)) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "CREDENTIAL_FIELD_REJECTED",
          "Credential fields are not accepted in capability constraints.",
        );
      }
      constraints[name] = capabilityConstraint(
        constraint,
        `Capability ${operation}`,
      );
    }
  }
  return {
    status,
    ...(idempotency === undefined ? {} : { idempotency }),
    ...(sideEffecting === undefined ? {} : { sideEffecting }),
    ...(record["reason"] === undefined
      ? {}
      : { reason: safeString(record["reason"], "Capability reason") }),
    ...(constraints === undefined ? {} : { constraints }),
  };
}

function normalizeCapabilityDocument(
  input: unknown,
): AdapterCapabilityDocument {
  assertNoCredentialValues(input);
  const document = requireRecord(input, "Target capabilities");
  assertAllowedKeys(document, CAPABILITY_DOCUMENT_KEYS, "Target capabilities");
  for (const [field, expected] of [
    ["$schema", ADAPTER_CAPABILITY_SCHEMA_ID],
    ["kind", "adapter_capabilities"],
    ["schemaVersion", ADAPTER_CAPABILITY_SCHEMA_VERSION],
    ["sdkVersion", ADAPTER_SDK_VERSION],
  ] as const) {
    if (document[field] !== undefined && document[field] !== expected) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_CAPABILITY_DOCUMENT",
        `Target capability ${field} is unsupported.`,
      );
    }
  }
  const adapter = requireRecord(document["adapter"], "Target adapter");
  assertAllowedKeys(adapter, ADAPTER_KEYS, "Target adapter");
  const capabilities = requireRecord(
    document["capabilities"],
    "Target capabilities map",
  );
  const operationSet = new Set<string>(ADAPTER_OPERATIONS);
  for (const key of Object.keys(capabilities)) {
    if (!operationSet.has(key)) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_CAPABILITY_DOCUMENT",
        "Target capabilities contain an unknown operation.",
      );
    }
  }
  const declarations = Object.fromEntries(
    ADAPTER_OPERATIONS.map((operation) => {
      if (!Object.hasOwn(capabilities, operation)) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "INVALID_CAPABILITY_DOCUMENT",
          `Target capabilities must declare ${operation}.`,
        );
      }
      return [
        operation,
        capabilityDeclaration(capabilities[operation], operation),
      ];
    }),
  ) as Record<AdapterOperation, AdapterCapabilityDeclaration>;
  if (document["operations"] !== undefined) {
    if (
      !Array.isArray(document["operations"]) ||
      document["operations"].length !== ADAPTER_OPERATIONS.length
    ) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_CAPABILITY_DOCUMENT",
        "Target capability operations metadata is inconsistent.",
      );
    }
    const listed = new Set(
      document["operations"].map((item) =>
        isPlainRecord(item) && typeof item["operation"] === "string"
          ? item["operation"]
          : "",
      ),
    );
    if (
      ADAPTER_OPERATIONS.some((operation) => !listed.has(operation)) ||
      listed.size !== ADAPTER_OPERATIONS.length
    ) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_CAPABILITY_DOCUMENT",
        "Target capability operations metadata is inconsistent.",
      );
    }
  }
  try {
    return createCapabilityDocument({
      adapter: {
        id: safeString(adapter["id"], "adapter.id", 256),
        name: safeString(adapter["name"], "adapter.name", 256),
        version: safeString(adapter["version"], "adapter.version", 256),
        ...(adapter["homepage"] === undefined
          ? {}
          : {
              homepage: safeString(
                adapter["homepage"],
                "adapter.homepage",
                2048,
              ),
            }),
        ...(adapter["vendor"] === undefined
          ? {}
          : { vendor: safeString(adapter["vendor"], "adapter.vendor", 256) }),
      },
      capabilities: declarations,
      ...(document["generatedAt"] === undefined
        ? {}
        : {
            generatedAt: safeString(document["generatedAt"], "generatedAt", 64),
          }),
    });
  } catch {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_CAPABILITY_DOCUMENT",
      "Target capability document failed validation.",
    );
  }
}

const TARGET_POLICY_KEYS = new Set([
  "allowedSigningAlgorithms",
  "endpointLimit",
  "minimumRetention",
  "observability",
  "rate",
  "requireHttps",
  "requireRollbackExport",
  "requireSigning",
  "retry",
  "subscriptionLimitPerEndpoint",
]);

const RETENTION_KEYS = new Set([
  "attemptLogDays",
  "deliveryLogDays",
  "payloadRetentionDays",
]);

const OBSERVABILITY_KEYS = new Set([
  "attemptLogs",
  "auditLogs",
  "deliveryLogs",
  "metrics",
  "replay",
]);

const RATE_KEYS = new Set(["maxBurst", "maxRequestsPerSecond", "supported"]);

const RETRY_KEYS = new Set(["maxAttempts", "maxDurationSeconds", "supported"]);

function parseTargetPolicy(input: unknown): TargetPolicy {
  assertNoCredentialValues(input);
  const record = requireRecord(input, "Target policy");
  assertAllowedKeys(record, TARGET_POLICY_KEYS, "Target policy");
  const policy: {
    allowedSigningAlgorithms?: string[];
    endpointLimit?: number;
    minimumRetention?: Record<string, number>;
    observability?: Record<string, boolean>;
    rate?: {
      supported: boolean;
      maxBurst?: number;
      maxRequestsPerSecond?: number;
    };
    requireHttps?: boolean;
    requireRollbackExport?: boolean;
    requireSigning?: boolean;
    retry?: {
      supported: boolean;
      maxAttempts?: number;
      maxDurationSeconds?: number;
    };
    subscriptionLimitPerEndpoint?: number;
  } = {};
  if (record["allowedSigningAlgorithms"] !== undefined) {
    if (
      !Array.isArray(record["allowedSigningAlgorithms"]) ||
      record["allowedSigningAlgorithms"].length > 32
    ) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TARGET_POLICY",
        "allowedSigningAlgorithms must be a bounded string array.",
      );
    }
    policy.allowedSigningAlgorithms = record["allowedSigningAlgorithms"].map(
      (item) => safeString(item, "Signing algorithm", 128),
    );
  }
  if (record["endpointLimit"] !== undefined) {
    policy.endpointLimit = nonNegativeInteger(
      record["endpointLimit"],
      "endpointLimit",
    );
  }
  if (record["subscriptionLimitPerEndpoint"] !== undefined) {
    policy.subscriptionLimitPerEndpoint = nonNegativeInteger(
      record["subscriptionLimitPerEndpoint"],
      "subscriptionLimitPerEndpoint",
    );
  }
  for (const key of [
    "requireHttps",
    "requireRollbackExport",
    "requireSigning",
  ] as const) {
    const value = optionalBoolean(record[key], key);
    if (value !== undefined) {
      policy[key] = value;
    }
  }
  if (record["minimumRetention"] !== undefined) {
    const retention = requireRecord(
      record["minimumRetention"],
      "minimumRetention",
    );
    assertAllowedKeys(retention, RETENTION_KEYS, "minimumRetention");
    policy.minimumRetention = Object.fromEntries(
      Object.entries(retention).map(([key, value]) => [
        key,
        nonNegativeNumber(value, `minimumRetention.${key}`),
      ]),
    );
  }
  if (record["observability"] !== undefined) {
    const observability = requireRecord(
      record["observability"],
      "observability",
    );
    assertAllowedKeys(observability, OBSERVABILITY_KEYS, "observability");
    policy.observability = Object.fromEntries(
      Object.entries(observability).map(([key, value]) => {
        const parsed = optionalBoolean(value, `observability.${key}`);
        if (parsed === undefined) {
          throw new CliCommandError(
            CLI_EXIT_CODES.invalid,
            "INVALID_TARGET_POLICY",
            `observability.${key} is required when declared.`,
          );
        }
        return [key, parsed];
      }),
    );
  }
  for (const key of ["rate", "retry"] as const) {
    if (record[key] === undefined) {
      continue;
    }
    const nested = requireRecord(record[key], key);
    assertAllowedKeys(nested, key === "rate" ? RATE_KEYS : RETRY_KEYS, key);
    const supported = optionalBoolean(nested["supported"], `${key}.supported`);
    if (supported === undefined) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TARGET_POLICY",
        `${key}.supported is required.`,
      );
    }
    if (key === "rate") {
      policy.rate = {
        supported,
        ...(nested["maxBurst"] === undefined
          ? {}
          : {
              maxBurst: nonNegativeNumber(nested["maxBurst"], "rate.maxBurst"),
            }),
        ...(nested["maxRequestsPerSecond"] === undefined
          ? {}
          : {
              maxRequestsPerSecond: nonNegativeNumber(
                nested["maxRequestsPerSecond"],
                "rate.maxRequestsPerSecond",
              ),
            }),
      };
    } else {
      policy.retry = {
        supported,
        ...(nested["maxAttempts"] === undefined
          ? {}
          : {
              maxAttempts: nonNegativeNumber(
                nested["maxAttempts"],
                "retry.maxAttempts",
              ),
            }),
        ...(nested["maxDurationSeconds"] === undefined
          ? {}
          : {
              maxDurationSeconds: nonNegativeNumber(
                nested["maxDurationSeconds"],
                "retry.maxDurationSeconds",
              ),
            }),
      };
    }
  }
  return policy as TargetPolicy;
}

export async function migrationAssessCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    "target-capabilities": { type: "string" },
    "target-policy": { type: "string" },
    format: { type: "string" },
    out: { type: "string", short: "o" },
  });
  ensurePositionals(parsed.positionals, 2);
  const inventoryPath = parsed.positionals[0]!;
  const contractPath = parsed.positionals[1]!;
  const capabilitiesPath = requiredOption(parsed.values, "target-capabilities");
  const policyPath = stringOption(parsed.values, "target-policy");
  assertSingleStdinConsumer([
    { name: "inventory", usesStdin: inventoryPath === "-" },
    { name: "contract", usesStdin: contractPath === "-" },
    {
      name: "target capabilities",
      usesStdin: capabilitiesPath === "-",
    },
    { name: "target policy", usesStdin: policyPath === "-" },
  ]);

  const rawInventory = await readStructuredInput(
    inventoryPath,
    "migration inventory",
    dependencies,
  );
  let serializedInventory: string;
  try {
    serializedInventory = JSON.stringify(rawInventory);
  } catch {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "MIGRATION_INVENTORY_INVALID",
      "Migration inventory must be finite JSON or YAML data.",
    );
  }
  if (serializedInventory === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "MIGRATION_INVENTORY_INVALID",
      "Migration inventory must be an object.",
    );
  }
  const imported = parseInventoryExportJson(serializedInventory);
  if (!imported.ok || imported.inventory === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "MIGRATION_INVENTORY_INVALID",
      "Migration inventory failed the closed, credential-free schema.",
      imported.diagnostics,
    );
  }

  const contract = await readExactContract(
    contractPath,
    dependencies,
    CLI_EXIT_CODES.invalid,
  );
  const capabilities = normalizeCapabilityDocument(
    await readStructuredInput(
      capabilitiesPath,
      "target capabilities",
      dependencies,
    ),
  );
  const targetPolicy =
    policyPath === undefined
      ? undefined
      : parseTargetPolicy(
          await readStructuredInput(policyPath, "target policy", dependencies),
        );
  let assessment;
  try {
    assessment = assessMigration({
      capabilities,
      contract,
      inventory: imported.inventory,
      ...(targetPolicy === undefined ? {} : { targetPolicy }),
    });
  } catch (error) {
    if (error instanceof AssessmentInputError) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "MIGRATION_ASSESSMENT_INVALID",
        "Migration assessment input failed validation.",
        error.diagnostics,
      );
    }
    throw error;
  }
  const format = artifactFormat(parsed.values, "markdown");
  const content =
    format === "json"
      ? renderAssessmentJson(assessment)
      : renderAssessmentMarkdown(assessment);
  const outputPath = stringOption(parsed.values, "out");
  await emitArtifact(dependencies, {
    content,
    envelope: {
      command: "migration-assess",
      format,
      status: assessment.readiness.label,
      assessment,
    },
    humanSummary: [
      `Readiness: ${assessment.readiness.label}`,
      `Score: ${assessment.readiness.score}/100`,
      `Blockers: ${assessment.blockers.length}`,
    ],
    json: booleanOption(parsed.values, "json"),
    ...(outputPath === undefined ? {} : { outputPath }),
  });
  return assessment.readiness.blocked
    ? CLI_EXIT_CODES.incompatible
    : CLI_EXIT_CODES.success;
}
