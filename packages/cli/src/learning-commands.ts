// SPDX-License-Identifier: Apache-2.0

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  ADAPTER_CAPABILITY_SCHEMA_ID,
  ADAPTER_CAPABILITY_SCHEMA_VERSION,
  ADAPTER_OPERATIONS,
  ADAPTER_SDK_VERSION,
  createCapabilityDocument,
  validateCanonicalMetadataRecord,
  validateMetadataDeliveryAttemptInput,
  type AdapterCapabilityDeclaration,
  type AdapterCapabilityDocument,
  type AdapterOperation,
  type CanonicalMetadataRecord,
  type CapabilityConstraintValue,
  type MetadataDeliveryAttemptInput,
} from "@webhook-portal/adapter-sdk";
import {
  createCompatibilityReport,
  renderCompatibilityReportJson,
  renderCompatibilityReportMarkdown,
  type ReportView,
} from "@webhook-portal/compatibility-report";
import {
  canonicalize,
  type CanonicalContract,
  type ContractImportResult,
} from "@webhook-portal/contract-core";
import {
  AssessmentInputError,
  assessMigration,
  parseInventoryExportJson,
  renderAssessmentJson,
  renderAssessmentMarkdown,
  type TargetPolicy,
} from "@webhook-portal/migration-assessment";
import {
  SupportEvidenceError,
  canonicalJson,
  createEvidenceBundle,
  parseEvidenceBundle,
  renderEvidenceJson,
  renderEvidenceMarkdown,
  signEvidenceBundle,
  verifyEvidenceBundle,
  type EvidenceBundle,
  type EvidencePurpose,
  type EvidenceRecord,
  type EvidenceVerificationPolicy,
  type RetryCategory,
  type TrustedEvidenceKey,
} from "@webhook-portal/support-evidence";

import {
  booleanOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import { CliCommandError, type CliDependencies } from "./commands.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import {
  assertSingleStdinConsumer,
  atomicWriteFile,
  parseJsonOrYaml,
  readInputText,
} from "./io.js";
import { emitSuccess } from "./output.js";

const CONTRACT_LIMIT_BYTES = 4 * 1024 * 1024;
const STRUCTURED_LIMIT_BYTES = 1024 * 1024;
const KEY_LIMIT_BYTES = 16 * 1024;
const READ_TIMEOUT_MILLISECONDS = 5000;
const DEFAULT_EVIDENCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

type ArtifactFormat = "json" | "markdown";

function commandOutput(dependencies: CliDependencies, json: boolean) {
  return {
    json,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
  };
}

function resolveInputPath(cwd: string, value: string): string {
  return value === "-" ? value : path.resolve(cwd, value);
}

function resolveOutputPath(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

function ensurePositionals(
  positionals: readonly string[],
  expected: number,
): void {
  if (positionals.length !== expected) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "USAGE_ERROR",
      `Expected ${expected} positional argument(s).`,
    );
  }
}

function requiredOption(
  values: Readonly<Record<string, boolean | string | undefined>>,
  name: string,
): string {
  const value = stringOption(values, name);
  if (value === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "OPTION_REQUIRED",
      `--${name} is required.`,
    );
  }
  return value;
}

function enumOption<const Value extends string>(
  values: Readonly<Record<string, boolean | string | undefined>>,
  name: string,
  allowed: readonly Value[],
  fallback: Value,
): Value {
  const value = stringOption(values, name);
  if (value === undefined) {
    return fallback;
  }
  if (!allowed.includes(value as Value)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "INVALID_OPTION",
      `--${name} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as Value;
}

function optionalInteger(
  values: Readonly<Record<string, boolean | string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = stringOption(values, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "INVALID_OPTION",
      `--${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function artifactFormat(
  values: Readonly<Record<string, boolean | string | undefined>>,
  fallback: ArtifactFormat,
): ArtifactFormat {
  return enumOption(values, "format", ["json", "markdown"], fallback);
}

async function emitArtifact(
  dependencies: CliDependencies,
  options: {
    readonly content: string;
    readonly envelope: Readonly<Record<string, unknown>>;
    readonly humanSummary: readonly string[];
    readonly json: boolean;
    readonly outputPath?: string;
  },
): Promise<void> {
  if (options.outputPath !== undefined) {
    const destination = resolveOutputPath(dependencies.cwd, options.outputPath);
    await atomicWriteFile(destination, options.content);
    emitSuccess(
      commandOutput(dependencies, options.json),
      { ...options.envelope, output: destination },
      [...options.humanSummary, `Wrote ${destination}`],
    );
    return;
  }
  if (options.json) {
    emitSuccess(
      commandOutput(dependencies, true),
      options.envelope,
      options.humanSummary,
    );
    return;
  }
  dependencies.stdout.write(options.content);
  if (!options.content.endsWith("\n")) {
    dependencies.stdout.write("\n");
  }
}

async function readStructuredInput(
  input: string,
  name: string,
  dependencies: CliDependencies,
): Promise<unknown> {
  const source = await readInputText(
    resolveInputPath(dependencies.cwd, input),
    {
      stdin: dependencies.stdin,
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
    },
    {
      maxBytes: STRUCTURED_LIMIT_BYTES,
      timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    },
  );
  return parseJsonOrYaml(source, name);
}

function validContract(
  result: ContractImportResult,
  partialExitCode: CliExitCode,
): CanonicalContract {
  if (result.status === "partial") {
    throw new CliCommandError(
      partialExitCode,
      "CONTRACT_PARTIAL",
      "The contract contains unsupported or partial content.",
      result.diagnostics,
    );
  }
  if (result.status !== "valid" || result.contract === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "CONTRACT_INVALID",
      "The contract is invalid.",
      result.diagnostics,
    );
  }
  return result.contract;
}

async function readExactContract(
  input: string,
  dependencies: CliDependencies,
  partialExitCode: CliExitCode = CLI_EXIT_CODES.partial,
): Promise<CanonicalContract> {
  const source = await readInputText(
    resolveInputPath(dependencies.cwd, input),
    {
      stdin: dependencies.stdin,
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
    },
    {
      maxBytes: CONTRACT_LIMIT_BYTES,
      timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    },
  );
  return validContract(
    canonicalize(source, {
      sourceUri:
        input === "-" ? "stdin:" : path.resolve(dependencies.cwd, input),
      limits: { maxInputBytes: CONTRACT_LIMIT_BYTES },
    }),
    partialExitCode,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_INPUT",
      `${label} must be a plain object.`,
    );
  }
  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "UNKNOWN_FIELD",
        `${label} contains an unsupported field.`,
      );
    }
  }
}

function safeString(value: unknown, label: string, maximum = 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_INPUT",
      `${label} must be a bounded safe string.`,
    );
  }
  return value;
}

function looksLikeCredential(value: string): boolean {
  return (
    /^(?:basic|bearer)\s+\S+/iu.test(value) ||
    /^-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /^(?:AKIA[0-9A-Z]{12,}|gh[pousr]_|sk_(?:live|test)_|whsec_|xox[baprs]-)/u.test(
      value,
    ) ||
    /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/u.test(value)
  );
}

function assertNoCredentialValues(
  input: unknown,
  maximumValues = 100_000,
): void {
  const stack: unknown[] = [input];
  let inspected = 0;
  while (stack.length > 0) {
    inspected += 1;
    if (inspected > maximumValues) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INPUT_LIMIT_EXCEEDED",
        "Structured input exceeds the inspection limit.",
      );
    }
    const value = stack.pop();
    if (typeof value === "string") {
      if (looksLikeCredential(value)) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "CREDENTIAL_VALUE_REJECTED",
          "Credential material is not accepted by this command.",
        );
      }
    } else if (Array.isArray(value)) {
      stack.push(...value);
    } else if (isPlainRecord(value)) {
      stack.push(...Object.values(value));
    }
  }
}

export async function compatibilityReportCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    format: { type: "string" },
    audience: { type: "string" },
    out: { type: "string", short: "o" },
    "allow-breaking": { type: "boolean" },
  });
  ensurePositionals(parsed.positionals, 2);
  assertSingleStdinConsumer(
    parsed.positionals.map((input, index) => ({
      name: index === 0 ? "previous contract" : "next contract",
      usesStdin: input === "-",
    })),
  );
  const format = artifactFormat(parsed.values, "markdown");
  const audience = enumOption(
    parsed.values,
    "audience",
    ["producer", "consumer"],
    "producer",
  );
  const previous = await readExactContract(
    parsed.positionals[0]!,
    dependencies,
  );
  const next = await readExactContract(parsed.positionals[1]!, dependencies);
  const report = createCompatibilityReport(previous, next, {
    view:
      stringOption(parsed.values, "audience") === undefined
        ? "combined"
        : (audience as ReportView),
  });
  const content =
    format === "json"
      ? `${renderCompatibilityReportJson(report)}\n`
      : renderCompatibilityReportMarkdown(report);
  const outputPath = stringOption(parsed.values, "out");
  await emitArtifact(dependencies, {
    content,
    envelope: {
      command: "compatibility-report",
      format,
      status: report.status,
      audience: report.view,
      report,
    },
    humanSummary: [
      `Compatibility: ${report.status}`,
      `Decision: ${report.decision}`,
    ],
    json: booleanOption(parsed.values, "json"),
    ...(outputPath === undefined ? {} : { outputPath }),
  });
  if (
    report.status === "unknown" ||
    (report.status === "breaking" &&
      !booleanOption(parsed.values, "allow-breaking"))
  ) {
    return CLI_EXIT_CODES.incompatible;
  }
  return CLI_EXIT_CODES.success;
}

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
const CREDENTIAL_FIELD_PATTERN =
  /(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)/iu;

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
      if (CREDENTIAL_FIELD_PATTERN.test(name)) {
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

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TARGET_POLICY",
      `${label} must be a finite non-negative number.`,
    );
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = nonNegativeNumber(value, label);
  if (!Number.isSafeInteger(number)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TARGET_POLICY",
      `${label} must be an integer.`,
    );
  }
  return number;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TARGET_POLICY",
      `${label} must be a boolean.`,
    );
  }
  return value;
}

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

const TIMELINE_ENVELOPE_KEYS = new Set(["command", "response"]);
const TIMELINE_PAGE_KEYS = new Set(["items", "nextCursor"]);
const TIMELINE_RECORDS_KEYS = new Set(["records"]);
const TIMELINE_ITEM_KEYS = new Set([
  "current",
  "deliveryId",
  "firstIngestedAt",
  "lastIngestedAt",
  "lateObservationCount",
  "observationCount",
  "payloadRetained",
  "reduction",
]);
const SENSITIVE_TIMELINE_FIELD =
  /(?:address|authorization|body|card|cookie|credential|customer|cvv|email|header|iban|password|payload|payment|phone|pii|privatekey|query|secret|ssn|taxid|token|url|uri)/u;

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function assertMetadataOnlyInput(input: unknown): void {
  const stack: unknown[] = [input];
  let inspected = 0;
  while (stack.length > 0) {
    inspected += 1;
    if (inspected > 100_000) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INPUT_LIMIT_EXCEEDED",
        "Timeline exceeds the metadata inspection limit.",
      );
    }
    const value = stack.pop();
    if (typeof value === "string") {
      if (looksLikeCredential(value)) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "SENSITIVE_TIMELINE_REJECTED",
          "Timeline input contains forbidden sensitive material.",
        );
      }
      continue;
    }
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (!isPlainRecord(value)) {
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (
        normalized !== "payloadretained" &&
        SENSITIVE_TIMELINE_FIELD.test(normalized)
      ) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "SENSITIVE_TIMELINE_REJECTED",
          "Timeline input contains a forbidden non-metadata field.",
        );
      }
      stack.push(item);
    }
  }
}

type TimelineSource =
  | { readonly kind: "metadata"; readonly value: unknown }
  | { readonly kind: "page"; readonly value: unknown };

function timelineSources(input: unknown): readonly TimelineSource[] {
  assertMetadataOnlyInput(input);
  if (Array.isArray(input)) {
    if (input.length === 0 || input.length > 1000) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TIMELINE",
        "Timeline must contain between 1 and 1000 records.",
      );
    }
    return input.map((value) => ({ kind: "metadata", value }));
  }
  const record = requireRecord(input, "Timeline");
  if (Object.hasOwn(record, "records")) {
    assertAllowedKeys(record, TIMELINE_RECORDS_KEYS, "Timeline");
    if (
      !Array.isArray(record["records"]) ||
      record["records"].length === 0 ||
      record["records"].length > 1000
    ) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TIMELINE",
        "Timeline must contain between 1 and 1000 records.",
      );
    }
    return record["records"].map((value) => ({ kind: "metadata", value }));
  }
  let page = record;
  if (Object.hasOwn(record, "response")) {
    assertAllowedKeys(record, TIMELINE_ENVELOPE_KEYS, "Timeline envelope");
    if (record["command"] !== undefined && record["command"] !== "timeline") {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TIMELINE",
        "Timeline command envelope is invalid.",
      );
    }
    page = requireRecord(record["response"], "Timeline response");
  }
  assertAllowedKeys(page, TIMELINE_PAGE_KEYS, "Timeline response");
  if (
    !Array.isArray(page["items"]) ||
    page["items"].length === 0 ||
    page["items"].length > 1000
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TIMELINE",
      "Timeline must contain between 1 and 1000 items.",
    );
  }
  return page["items"].map((value) => ({ kind: "page", value }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const SAFE_OPAQUE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:+-]*[A-Za-z0-9])?$/u;

function opaqueToken(value: string, prefix: string, maximum = 128): string {
  if (
    Buffer.byteLength(value, "utf8") <= maximum &&
    SAFE_OPAQUE_TOKEN.test(value) &&
    !looksLikeCredential(value) &&
    !/@/u.test(value)
  ) {
    return value;
  }
  return `${prefix}_${sha256(value).slice(0, 32)}`;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TIMESTAMP",
      `${label} must be an ISO-8601 timestamp.`,
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TIMESTAMP",
      `${label} must be an ISO-8601 timestamp.`,
    );
  }
  return new Date(milliseconds).toISOString();
}

function retryCategory(
  record: MetadataDeliveryAttemptInput | CanonicalMetadataRecord,
): RetryCategory {
  if (record.status === "delivered") return "none";
  if (record.status === "retry_scheduled") return "scheduled";
  if (record.status === "exhausted" || record.status === "cancelled") {
    return "permanent";
  }
  if (record.status === "failed") {
    return record.retryable === true ? "transient" : "unknown";
  }
  return record.status === "attempting" || record.status === "pending"
    ? "scheduled"
    : "unknown";
}

interface EvidenceCandidate {
  readonly contractReference: {
    readonly contractId: string;
    readonly version: string;
    readonly checksum: {
      readonly algorithm: "sha256";
      readonly value: string;
    };
  };
  readonly environment?: string;
  readonly record: EvidenceRecord;
  readonly sourceId: string;
  readonly sourceMaterial: unknown;
  readonly tenantId?: string;
}

function evidenceCandidate(
  record: MetadataDeliveryAttemptInput | CanonicalMetadataRecord,
  ingestedAt: string,
  sourceId: string,
  sourceMaterial: unknown,
  identity?: { readonly environment: string; readonly tenantId: string },
): EvidenceCandidate {
  const eventChecksum = record.eventVersion.schemaChecksum;
  const providerAttemptReference =
    record.providerAttemptId ?? `${record.deliveryId}:${record.attempt}`;
  const evidence: EvidenceRecord = {
    recordType: "attempt",
    sourceId,
    occurredAt: canonicalTimestamp(record.occurredAt, "occurredAt"),
    ingestedAt: canonicalTimestamp(ingestedAt, "ingestedAt"),
    eventType: opaqueToken(record.eventVersion.eventType, "event"),
    eventVersion: opaqueToken(record.eventVersion.version, "version", 64),
    providerEventRef: opaqueToken(record.deliveryId, "delivery", 256),
    providerAttemptRef: opaqueToken(providerAttemptReference, "attempt", 256),
    endpointId: opaqueToken(record.endpointId, "endpoint"),
    status: opaqueToken(record.status, "status", 64),
    ...(record.responseStatusCode === undefined
      ? {}
      : { responseCode: record.responseStatusCode }),
    ...(record.durationMilliseconds === undefined
      ? {}
      : { latencyMs: record.durationMilliseconds }),
    retryCategory: retryCategory(record),
    ...(record.traceId === undefined
      ? {}
      : { traceId: opaqueToken(record.traceId, "trace") }),
    correlationId: opaqueToken(record.deliveryId, "correlation"),
  };
  return {
    contractReference: {
      contractId: opaqueToken(record.eventId, "contract"),
      version: opaqueToken(record.eventVersion.version, "version", 64),
      checksum: { algorithm: "sha256", value: eventChecksum },
    },
    record: evidence,
    sourceId,
    sourceMaterial,
    ...(identity === undefined ? {} : identity),
  };
}

function candidatesFromTimeline(input: unknown): readonly EvidenceCandidate[] {
  return timelineSources(input).map((source) => {
    if (source.kind === "metadata") {
      const validated = validateMetadataDeliveryAttemptInput(source.value);
      if (!validated.ok) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "INVALID_TIMELINE",
          "Timeline metadata failed the closed allowlist schema.",
          validated.issues,
        );
      }
      return evidenceCandidate(
        validated.value,
        validated.value.occurredAt,
        "timeline_export",
        validated.value,
      );
    }
    const item = requireRecord(source.value, "Timeline item");
    assertAllowedKeys(item, TIMELINE_ITEM_KEYS, "Timeline item");
    const validated = validateCanonicalMetadataRecord(item["current"]);
    if (!validated.ok) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TIMELINE",
        "Timeline current metadata failed validation.",
        validated.issues,
      );
    }
    const current = validated.value;
    const ingestedAt = canonicalTimestamp(
      item["lastIngestedAt"],
      "lastIngestedAt",
    );
    const sourceId = `source_${sha256(
      `${current.adapterId}\u0000${current.connectionId}`,
    ).slice(0, 24)}`;
    return evidenceCandidate(current, ingestedAt, sourceId, item, {
      environment: current.environment,
      tenantId: current.tenantId,
    });
  });
}

function optionTimestamp(
  values: Readonly<Record<string, boolean | string | undefined>>,
  name: string,
): string | undefined {
  const value = stringOption(values, name);
  return value === undefined
    ? undefined
    : canonicalTimestamp(value, `--${name}`);
}

function identifierMatches(identifier: unknown, actual: string): boolean {
  if (!isPlainRecord(identifier)) {
    return false;
  }
  if (identifier["kind"] === "opaque") {
    return identifier["value"] === actual;
  }
  return (
    identifier["kind"] === "hashed" &&
    identifier["algorithm"] === "sha256" &&
    identifier["value"] === sha256(actual)
  );
}

function assertScopeMatches(
  scope: unknown,
  candidates: readonly EvidenceCandidate[],
): void {
  const identities = candidates.filter(
    (
      candidate,
    ): candidate is EvidenceCandidate & {
      readonly environment: string;
      readonly tenantId: string;
    } =>
      candidate.environment !== undefined && candidate.tenantId !== undefined,
  );
  if (identities.length === 0) {
    return;
  }
  if (!isPlainRecord(scope)) {
    return;
  }
  if (
    identities.some(
      (candidate) => !identifierMatches(scope["tenantId"], candidate.tenantId),
    )
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "EVIDENCE_SCOPE_MISMATCH",
      "Timeline tenant metadata does not match the supplied scope.",
    );
  }
  if (
    scope["environmentId"] !== undefined &&
    identities.some(
      (candidate) =>
        !identifierMatches(scope["environmentId"], candidate.environment),
    )
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "EVIDENCE_SCOPE_MISMATCH",
      "Timeline environment metadata does not match the supplied scope.",
    );
  }
}

async function readKeyFile(
  value: string,
  baseDirectory: string,
  kind: "private" | "public",
): Promise<KeyObject> {
  if (value === "-") {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "KEY_STDIN_FORBIDDEN",
      `${kind === "private" ? "Private" : "Public"} keys must be read from a file, not stdin.`,
    );
  }
  const resolved = path.resolve(baseDirectory, value);
  let metadata;
  try {
    metadata = await stat(resolved);
  } catch {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "KEY_FILE_INVALID",
      `${kind === "private" ? "Private" : "Public"} key file could not be read.`,
    );
  }
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > KEY_LIMIT_BYTES
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "KEY_FILE_INVALID",
      `${kind === "private" ? "Private" : "Public"} key path must be a bounded regular file.`,
    );
  }
  if (kind === "private" && (metadata.mode & 0o077) !== 0) {
    throw new CliCommandError(
      CLI_EXIT_CODES.security,
      "PRIVATE_KEY_PERMISSIONS",
      "Private key file permissions must not grant group or other access.",
    );
  }
  try {
    const source = await readFile(resolved);
    return kind === "private"
      ? createPrivateKey(source)
      : createPublicKey(source);
  } catch {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "KEY_FILE_INVALID",
      `${kind === "private" ? "Private" : "Public"} key file is invalid.`,
    );
  }
}

function evidenceArtifact(
  bundle: EvidenceBundle,
  format: ArtifactFormat,
): string {
  const signatureStatus =
    bundle.signature === undefined ? "unsigned" : "signed";
  if (format === "markdown") {
    return renderEvidenceMarkdown(bundle).replace(
      "## Integrity\n\n",
      `## Integrity\n\n- Signature status: ${signatureStatus}\n`,
    );
  }
  const rendered = JSON.parse(renderEvidenceJson(bundle)) as Record<
    string,
    unknown
  >;
  return `${JSON.stringify({ ...rendered, signatureStatus }, null, 2)}\n`;
}

function forbiddenLiteralKeyArgument(args: readonly string[]): boolean {
  return args.some(
    (argument) =>
      argument === "--signing-key" ||
      argument.startsWith("--signing-key=") ||
      argument === "--private-key" ||
      argument.startsWith("--private-key="),
  );
}

export async function supportEvidenceCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  if (forbiddenLiteralKeyArgument(args)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "LITERAL_KEY_FORBIDDEN",
      "Private key material is accepted only through --signing-key-file.",
    );
  }
  const parsed = parseCommandArguments(args, {
    "case-id": { type: "string" },
    scope: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    purpose: { type: "string" },
    "expires-at": { type: "string" },
    "signing-key-file": { type: "string" },
    "key-id": { type: "string" },
    format: { type: "string" },
    out: { type: "string", short: "o" },
  });
  ensurePositionals(parsed.positionals, 1);
  const timelinePath = parsed.positionals[0]!;
  const scopePath = requiredOption(parsed.values, "scope");
  const signingKeyPath = stringOption(parsed.values, "signing-key-file");
  const keyId = stringOption(parsed.values, "key-id");
  if (signingKeyPath === "-") {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "KEY_STDIN_FORBIDDEN",
      "Private keys must be read from a permission-restricted file, not stdin.",
    );
  }
  if ((signingKeyPath === undefined) !== (keyId === undefined)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "INCOMPLETE_SIGNING_OPTIONS",
      "--signing-key-file and --key-id must be provided together.",
    );
  }
  assertSingleStdinConsumer([
    { name: "timeline", usesStdin: timelinePath === "-" },
    { name: "scope", usesStdin: scopePath === "-" },
  ]);

  const timeline = await readStructuredInput(
    timelinePath,
    "support timeline",
    dependencies,
  );
  const scope = await readStructuredInput(
    scopePath,
    "support scope",
    dependencies,
  );
  const candidates = candidatesFromTimeline(timeline);
  const inferredFrom = candidates.reduce((minimum, candidate) => {
    const value = Date.parse(candidate.record.occurredAt);
    return Math.min(minimum, value);
  }, Number.POSITIVE_INFINITY);
  const inferredTo = candidates.reduce((maximum, candidate) => {
    return Math.max(
      maximum,
      Date.parse(candidate.record.occurredAt),
      Date.parse(candidate.record.ingestedAt),
    );
  }, Number.NEGATIVE_INFINITY);
  const from =
    optionTimestamp(parsed.values, "from") ??
    new Date(inferredFrom).toISOString();
  const explicitTo = optionTimestamp(parsed.values, "to");
  const to =
    explicitTo ??
    new Date(
      inferredTo <= inferredFrom ? inferredFrom + 1 : inferredTo,
    ).toISOString();
  if (Date.parse(to) <= Date.parse(from)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_EVIDENCE_RANGE",
      "Evidence --to must be after --from.",
    );
  }
  const selected = candidates.filter((candidate) => {
    const occurredAt = Date.parse(candidate.record.occurredAt);
    return occurredAt >= Date.parse(from) && occurredAt <= Date.parse(to);
  });
  if (selected.length === 0) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "EMPTY_EVIDENCE",
      "The selected time range contains no timeline records.",
    );
  }
  assertScopeMatches(scope, selected);
  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.valueOf())) {
    throw new CliCommandError(
      CLI_EXIT_CODES.runtime,
      "CLOCK_INVALID",
      "The command clock returned an invalid time.",
    );
  }
  const createdAt = now.toISOString();
  const expiresAt =
    optionTimestamp(parsed.values, "expires-at") ??
    new Date(now.valueOf() + DEFAULT_EVIDENCE_LIFETIME_MS).toISOString();

  const groupedSources = new Map<
    string,
    { readonly material: unknown[]; count: number }
  >();
  for (const candidate of selected) {
    const group = groupedSources.get(candidate.sourceId) ?? {
      material: [],
      count: 0,
    };
    group.material.push(candidate.sourceMaterial);
    group.count += 1;
    groupedSources.set(candidate.sourceId, group);
  }
  const contractReferences = [
    ...new Map(
      selected.map((candidate) => [
        canonicalJson(candidate.contractReference),
        candidate.contractReference,
      ]),
    ).values(),
  ];
  let bundle: EvidenceBundle;
  try {
    bundle = createEvidenceBundle({
      supportCaseId: requiredOption(parsed.values, "case-id"),
      tenantScope: scope,
      selection: {
        from,
        to,
        purpose: enumOption(
          parsed.values,
          "purpose",
          [
            "case-review",
            "contract-verification",
            "delivery-verification",
            "incident-correlation",
            "provider-escalation",
            "timeline-review",
          ] as const satisfies readonly EvidencePurpose[],
          "case-review",
        ),
      },
      records: selected.map((candidate) => candidate.record),
      contractReferences,
      sources: [...groupedSources.entries()].map(([sourceId, source]) => ({
        sourceId,
        checksum: {
          algorithm: "sha256" as const,
          value: sha256(canonicalJson(source.material)),
        },
        recordCount: source.count,
      })),
      createdAt,
      expiresAt,
    });
  } catch (error) {
    if (error instanceof SupportEvidenceError) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        error.code,
        "Support evidence input failed metadata-only validation.",
        { path: error.path },
      );
    }
    throw error;
  }
  if (signingKeyPath !== undefined && keyId !== undefined) {
    const privateKey = await readKeyFile(
      signingKeyPath,
      dependencies.cwd,
      "private",
    );
    try {
      bundle = signEvidenceBundle(bundle, {
        keyId,
        privateKey,
        signedAt: createdAt,
      });
    } catch (error) {
      if (error instanceof SupportEvidenceError) {
        throw new CliCommandError(
          CLI_EXIT_CODES.security,
          error.code,
          "Support evidence signing failed.",
          { path: error.path },
        );
      }
      throw error;
    }
  }
  const format = artifactFormat(parsed.values, "json");
  const signatureStatus =
    bundle.signature === undefined ? "unsigned" : "signed";
  const outputPath = stringOption(parsed.values, "out");
  await emitArtifact(dependencies, {
    content: evidenceArtifact(bundle, format),
    envelope: {
      command: "support-evidence",
      format,
      status: signatureStatus,
      digest: bundle.digest,
      bundle,
    },
    humanSummary: [
      `Evidence digest: ${bundle.digest}`,
      `Signature status: ${signatureStatus}`,
      `Records: ${bundle.snapshot.recordCount}`,
    ],
    json: booleanOption(parsed.values, "json"),
    ...(outputPath === undefined ? {} : { outputPath }),
  });
  return CLI_EXIT_CODES.success;
}

function normalizeEvidenceArtifact(input: unknown): unknown {
  if (!isPlainRecord(input)) {
    return input;
  }
  assertMetadataOnlyInput(input);
  if (isPlainRecord(input["bundle"])) {
    assertAllowedKeys(
      input,
      new Set(["bundle", "command", "digest", "format", "output", "status"]),
      "Evidence command envelope",
    );
    if (input["command"] !== "support-evidence") {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_EVIDENCE_BUNDLE",
        "Evidence command envelope is invalid.",
      );
    }
    return input["bundle"];
  }
  if (
    isPlainRecord(input["evidence"]) &&
    isPlainRecord(input["integrity"]) &&
    typeof input["integrity"]["digest"] === "string"
  ) {
    assertAllowedKeys(
      input,
      new Set([
        "evidence",
        "format",
        "integrity",
        "limitations",
        "signatureStatus",
        "version",
      ]),
      "Evidence artifact",
    );
    return {
      snapshot: input["evidence"],
      digest: input["integrity"]["digest"],
      ...(input["integrity"]["signature"] === null ||
      input["integrity"]["signature"] === undefined
        ? {}
        : { signature: input["integrity"]["signature"] }),
    };
  }
  return input;
}

const TRUST_POLICY_KEYS = new Set([
  "allowHistoricalSignatures",
  "keys",
  "maximumClockSkewMs",
  "requireSignature",
]);
const TRUST_KEY_KEYS = new Set([
  "keyId",
  "publicKeyFile",
  "revocationMode",
  "revokedAt",
  "validFrom",
  "validUntil",
]);

async function trustPolicyFromFile(
  value: string,
  dependencies: CliDependencies,
): Promise<EvidenceVerificationPolicy> {
  const parsed = await readStructuredInput(
    value,
    "support evidence trust policy",
    dependencies,
  );
  assertNoCredentialValues(parsed);
  const record = requireRecord(parsed, "Trust policy");
  assertAllowedKeys(record, TRUST_POLICY_KEYS, "Trust policy");
  if (!Array.isArray(record["keys"]) || record["keys"].length > 100) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TRUST_POLICY",
      "Trust policy keys must be a bounded array.",
    );
  }
  const baseDirectory =
    value === "-"
      ? dependencies.cwd
      : path.dirname(path.resolve(dependencies.cwd, value));
  const keys: TrustedEvidenceKey[] = [];
  for (const raw of record["keys"]) {
    const key = requireRecord(raw, "Trust policy key");
    assertAllowedKeys(key, TRUST_KEY_KEYS, "Trust policy key");
    const revocationMode = key["revocationMode"];
    if (
      revocationMode !== undefined &&
      revocationMode !== "all" &&
      revocationMode !== "from-time"
    ) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_TRUST_POLICY",
        "Trust policy revocation mode is invalid.",
      );
    }
    keys.push({
      keyId: safeString(key["keyId"], "Trust key ID", 128),
      publicKey: await readKeyFile(
        safeString(key["publicKeyFile"], "Public key file", 2048),
        baseDirectory,
        "public",
      ),
      ...(key["validFrom"] === undefined
        ? {}
        : {
            validFrom: canonicalTimestamp(
              key["validFrom"],
              "Trust key validFrom",
            ),
          }),
      ...(key["validUntil"] === undefined
        ? {}
        : {
            validUntil: canonicalTimestamp(
              key["validUntil"],
              "Trust key validUntil",
            ),
          }),
      ...(key["revokedAt"] === undefined
        ? {}
        : {
            revokedAt: canonicalTimestamp(
              key["revokedAt"],
              "Trust key revokedAt",
            ),
          }),
      ...(revocationMode === undefined ? {} : { revocationMode }),
    });
  }
  const requireSignature = optionalBoolean(
    record["requireSignature"],
    "requireSignature",
  );
  const allowHistoricalSignatures = optionalBoolean(
    record["allowHistoricalSignatures"],
    "allowHistoricalSignatures",
  );
  const maximumClockSkewMs =
    record["maximumClockSkewMs"] === undefined
      ? undefined
      : nonNegativeInteger(record["maximumClockSkewMs"], "maximumClockSkewMs");
  return {
    keys,
    ...(requireSignature === undefined ? {} : { requireSignature }),
    ...(allowHistoricalSignatures === undefined
      ? {}
      : { allowHistoricalSignatures }),
    ...(maximumClockSkewMs === undefined ? {} : { maximumClockSkewMs }),
  };
}

export async function supportEvidenceVerifyCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    "public-key-file": { type: "string" },
    "trust-policy": { type: "string" },
    "key-id": { type: "string" },
    "valid-from": { type: "string" },
    "valid-until": { type: "string" },
    "revoked-at": { type: "string" },
    "revocation-mode": { type: "string" },
    "require-signature": { type: "boolean" },
    "allow-historical-signatures": { type: "boolean" },
    now: { type: "string" },
    "max-clock-skew-ms": { type: "string" },
  });
  ensurePositionals(parsed.positionals, 1);
  const bundlePath = parsed.positionals[0]!;
  const trustPolicyPath = stringOption(parsed.values, "trust-policy");
  const publicKeyPath = stringOption(parsed.values, "public-key-file");
  if (publicKeyPath === "-") {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "KEY_STDIN_FORBIDDEN",
      "Public keys must be read from a file, not stdin.",
    );
  }
  assertSingleStdinConsumer([
    { name: "evidence bundle", usesStdin: bundlePath === "-" },
    { name: "trust policy", usesStdin: trustPolicyPath === "-" },
  ]);
  const normalized = normalizeEvidenceArtifact(
    await readStructuredInput(
      bundlePath,
      "support evidence bundle",
      dependencies,
    ),
  );
  let policy: EvidenceVerificationPolicy =
    trustPolicyPath === undefined
      ? {}
      : await trustPolicyFromFile(trustPolicyPath, dependencies);
  if (publicKeyPath !== undefined) {
    let bundle: EvidenceBundle | undefined;
    try {
      bundle = parseEvidenceBundle(normalized);
    } catch {
      bundle = undefined;
    }
    const keyId =
      stringOption(parsed.values, "key-id") ?? bundle?.signature?.keyId;
    if (keyId === undefined) {
      throw new CliCommandError(
        CLI_EXIT_CODES.usage,
        "KEY_ID_REQUIRED",
        "--key-id is required when the bundle has no usable signature key ID.",
      );
    }
    const revocationMode = stringOption(parsed.values, "revocation-mode");
    if (
      revocationMode !== undefined &&
      revocationMode !== "all" &&
      revocationMode !== "from-time"
    ) {
      throw new CliCommandError(
        CLI_EXIT_CODES.usage,
        "INVALID_OPTION",
        "--revocation-mode must be all or from-time.",
      );
    }
    const validFrom = optionTimestamp(parsed.values, "valid-from");
    const validUntil = optionTimestamp(parsed.values, "valid-until");
    const revokedAt = optionTimestamp(parsed.values, "revoked-at");
    const key: TrustedEvidenceKey = {
      keyId,
      publicKey: await readKeyFile(publicKeyPath, dependencies.cwd, "public"),
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(validUntil === undefined ? {} : { validUntil }),
      ...(revokedAt === undefined ? {} : { revokedAt }),
      ...(revocationMode === undefined
        ? {}
        : {
            revocationMode: revocationMode as "all" | "from-time",
          }),
    };
    policy = { ...policy, keys: [...(policy.keys ?? []), key] };
  } else if (
    stringOption(parsed.values, "key-id") !== undefined ||
    optionTimestamp(parsed.values, "valid-from") !== undefined ||
    optionTimestamp(parsed.values, "valid-until") !== undefined ||
    optionTimestamp(parsed.values, "revoked-at") !== undefined ||
    stringOption(parsed.values, "revocation-mode") !== undefined
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "PUBLIC_KEY_REQUIRED",
      "Key validity and revocation options require --public-key-file.",
    );
  }
  const maximumClockSkewMs = optionalInteger(
    parsed.values,
    "max-clock-skew-ms",
    0,
    24 * 60 * 60 * 1000,
  );
  const verificationTime = optionTimestamp(parsed.values, "now");
  policy = {
    ...policy,
    ...(booleanOption(parsed.values, "require-signature")
      ? { requireSignature: true }
      : {}),
    ...(booleanOption(parsed.values, "allow-historical-signatures")
      ? { allowHistoricalSignatures: true }
      : {}),
    ...(verificationTime === undefined ? {} : { now: verificationTime }),
    ...(maximumClockSkewMs === undefined ? {} : { maximumClockSkewMs }),
  };
  let result;
  try {
    result = verifyEvidenceBundle(normalized, policy);
  } catch (error) {
    if (error instanceof SupportEvidenceError) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        error.code,
        "Support evidence verification policy is invalid.",
        { path: error.path },
      );
    }
    throw error;
  }
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    { command: "support-evidence-verify", ...result },
    [
      `Integrity: ${result.integrity}`,
      `Expiry: ${result.expiry}`,
      `Signature: ${result.signature}`,
      `Valid: ${String(result.valid)}`,
    ],
  );
  if (result.integrity === "malformed") {
    return CLI_EXIT_CODES.invalid;
  }
  return result.valid ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.security;
}
