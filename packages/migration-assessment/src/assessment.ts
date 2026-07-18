// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  ADAPTER_OPERATIONS,
  type AdapterCapability,
  type AdapterOperation,
} from "@webhook-portal/adapter-sdk";
import { isCanonicalContract } from "@webhook-portal/canonical-model";

import type {
  AssessmentDiagnostic,
  AssessmentInput,
  AssessmentIssue,
  CapabilityParityItem,
  EndpointMapping,
  EventMapping,
  MigrationAssessment,
  MigrationPhase,
  ObservabilityFeatures,
  ReadinessScore,
  RetentionFeatures,
  RollbackPrerequisite,
  ScoreComponent,
} from "./types.js";
import { parseInventoryExportJson } from "./import.js";
import { MIGRATION_ASSESSMENT_VERSION } from "./types.js";

export class AssessmentInputError extends Error {
  readonly diagnostics: readonly AssessmentDiagnostic[];

  constructor(diagnostics: readonly AssessmentDiagnostic[]) {
    super("Migration assessment input is invalid.");
    this.name = "AssessmentInputError";
    this.diagnostics = diagnostics;
  }
}

function assessmentInputDiagnostics(
  input: AssessmentInput,
): AssessmentDiagnostic[] {
  const diagnostics: AssessmentDiagnostic[] = [];
  if (!isCanonicalContract(input.contract)) {
    diagnostics.push({
      code: "INVALID_CANONICAL_CONTRACT",
      message: "contract must be a valid canonical contract.",
      pointer: "/contract",
      severity: "error",
    });
  }
  if (
    input.capabilities.kind !== "adapter_capabilities" ||
    typeof input.capabilities.adapter?.id !== "string" ||
    typeof input.capabilities.adapter.name !== "string" ||
    typeof input.capabilities.adapter.version !== "string"
  ) {
    diagnostics.push({
      code: "INVALID_CAPABILITY_DOCUMENT",
      message: "capabilities must be an adapter capability document.",
      pointer: "/capabilities",
      severity: "error",
    });
  } else {
    for (const operation of ADAPTER_OPERATIONS) {
      const item = input.capabilities.capabilities[operation];
      if (
        item === undefined ||
        item.operation !== operation ||
        !["degraded", "supported", "unsupported"].includes(item.status)
      ) {
        diagnostics.push({
          code: "INVALID_CAPABILITY_DOCUMENT",
          message: `Capability ${operation} is missing or invalid.`,
          pointer: `/capabilities/capabilities/${operation}`,
          severity: "error",
        });
      }
    }
  }
  const numericPolicyValues = [
    ["endpointLimit", input.targetPolicy?.endpointLimit],
    [
      "subscriptionLimitPerEndpoint",
      input.targetPolicy?.subscriptionLimitPerEndpoint,
    ],
    ["retry.maxAttempts", input.targetPolicy?.retry?.maxAttempts],
    ["retry.maxDurationSeconds", input.targetPolicy?.retry?.maxDurationSeconds],
    ["rate.maxBurst", input.targetPolicy?.rate?.maxBurst],
    [
      "rate.maxRequestsPerSecond",
      input.targetPolicy?.rate?.maxRequestsPerSecond,
    ],
  ] as const;
  for (const [name, value] of numericPolicyValues) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      diagnostics.push({
        code: "INVALID_TARGET_POLICY",
        message: `${name} must be a finite non-negative number.`,
        pointer: `/targetPolicy/${name.replaceAll(".", "/")}`,
        severity: "error",
      });
    }
  }
  return diagnostics;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function checksumInventory(
  inventory: AssessmentInput["inventory"],
): MigrationAssessment["inventoryChecksum"] {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(canonicalJson(inventory)).digest("hex"),
  };
}

function issueKey(issue: AssessmentIssue): string {
  return `${issue.code}\u0000${issue.sourceId ?? ""}\u0000${issue.message}`;
}

function sortedIssues(items: readonly AssessmentIssue[]): AssessmentIssue[] {
  const unique = new Map(items.map((item) => [issueKey(item), item]));
  return [...unique.values()].sort((left, right) =>
    compareText(issueKey(left), issueKey(right)),
  );
}

function capability(
  input: AssessmentInput,
  operation: AdapterOperation,
): AdapterCapability | undefined {
  return input.capabilities.capabilities[operation];
}

function mappingPlan(input: AssessmentInput): {
  readonly issues: AssessmentIssue[];
  readonly mappings: EndpointMapping[];
} {
  const contractEvents = input.contract.eventTypes.map((event) => ({
    externalName: event.externalName,
    id: event.id,
  }));
  const issues: AssessmentIssue[] = [];
  const mappings = [...input.inventory.endpoints]
    .sort((left, right) => compareText(left.id, right.id))
    .map((endpoint): EndpointMapping => {
      const events: EventMapping[] = [];
      if (endpoint.subscriptions === undefined) {
        issues.push({
          code: "SUBSCRIPTIONS_UNKNOWN",
          message:
            "Endpoint export omitted subscriptions; event scope must be established before migration.",
          sourceId: endpoint.id,
        });
      } else {
        for (const subscription of [...endpoint.subscriptions].sort(
          (left, right) => compareText(left.event, right.event),
        )) {
          const matches = contractEvents.filter(
            (event) =>
              event.id === subscription.event ||
              event.externalName === subscription.event,
          );
          if (matches.length === 1) {
            const match = matches[0];
            if (match !== undefined) {
              events.push({
                canonicalEventId: match.id,
                canonicalExternalName: match.externalName,
                sourceEvent: subscription.event,
                status: "mapped",
              });
            }
          } else if (matches.length === 0) {
            events.push({
              sourceEvent: subscription.event,
              status: "unmapped",
            });
            issues.push({
              code: "EVENT_UNMAPPED",
              message: `Subscription "${subscription.event}" has no canonical contract event.`,
              sourceId: endpoint.id,
            });
          } else {
            events.push({
              sourceEvent: subscription.event,
              status: "ambiguous",
            });
            issues.push({
              code: "EVENT_AMBIGUOUS",
              message: `Subscription "${subscription.event}" matches multiple canonical events.`,
              sourceId: endpoint.id,
            });
          }
        }
      }
      return {
        destinationIds: [...endpoint.destinationIds].sort(compareText),
        events,
        sourceEndpointId: endpoint.id,
        sourceProviderId: endpoint.providerId,
        targetReference: `endpoint:${endpoint.id}`,
      };
    });
  return { issues: sortedIssues(issues), mappings };
}

interface RequiredOperation {
  readonly operation: AdapterOperation;
  readonly reason: string;
  readonly required: boolean;
}

function requiredOperations(input: AssessmentInput): RequiredOperation[] {
  const endpoints = input.inventory.endpoints;
  const requirements = new Map<AdapterOperation, string>();
  if (endpoints.length > 0) {
    requirements.set(
      "endpoint.create",
      "At least one source endpoint requires target provisioning.",
    );
    requirements.set(
      "endpoint.verify",
      "Provisioned endpoints require verification before cutover.",
    );
  }
  if (endpoints.some((endpoint) => endpoint.subscriptions !== undefined)) {
    requirements.set(
      "subscription.replace",
      "Exported event subscriptions must be reproduced on the target.",
    );
  }
  if (
    endpoints.some(
      (endpoint) =>
        endpoint.state === "paused" || endpoint.state === "disabled",
    )
  ) {
    requirements.set(
      "endpoint.pause",
      "Paused or disabled source state must be representable on the target.",
    );
  }
  if (endpoints.some((endpoint) => endpoint.signing !== undefined)) {
    requirements.set(
      "secret.create",
      "Signing profiles require target signing material to be configured outside this read-only assessment.",
    );
  }
  if (
    endpoints.some(
      (endpoint) =>
        endpoint.observability.attemptLogs ||
        endpoint.observability.deliveryLogs ||
        endpoint.observability.metrics,
    )
  ) {
    requirements.set(
      "metadata.poll",
      "Source observability indicates migration monitoring is required.",
    );
  }
  return (
    [
      "endpoint.create",
      "endpoint.verify",
      "subscription.replace",
      "endpoint.pause",
      "secret.create",
      "metadata.poll",
    ] as const
  ).map((operation) => ({
    operation,
    reason:
      requirements.get(operation) ??
      "The assessed inventory does not require this operation.",
    required: requirements.has(operation),
  }));
}

function capabilityParity(input: AssessmentInput): {
  readonly blockers: AssessmentIssue[];
  readonly items: CapabilityParityItem[];
  readonly warnings: AssessmentIssue[];
} {
  const blockers: AssessmentIssue[] = [];
  const warnings: AssessmentIssue[] = [];
  const items = requiredOperations(input).map(
    ({ operation, reason, required }): CapabilityParityItem => {
      const target = capability(input, operation);
      const status = !required
        ? "not-required"
        : target?.status === "supported"
          ? "supported"
          : target?.status === "degraded"
            ? "degraded"
            : "unsupported";
      if (required && status === "unsupported") {
        blockers.push({
          code: "TARGET_CAPABILITY_UNSUPPORTED",
          message: `Target adapter does not support required operation ${operation}.`,
          sourceId: operation,
        });
      } else if (required && status === "degraded") {
        warnings.push({
          code: "TARGET_CAPABILITY_DEGRADED",
          message: `Target adapter reports degraded support for ${operation}.`,
          sourceId: operation,
        });
      }
      return {
        operation,
        required,
        sourceReason: reason,
        status,
      };
    },
  );
  return {
    blockers: sortedIssues(blockers),
    items,
    warnings: sortedIssues(warnings),
  };
}

function securityGaps(input: AssessmentInput): {
  readonly blockers: AssessmentIssue[];
  readonly gaps: AssessmentIssue[];
  readonly warnings: AssessmentIssue[];
} {
  const blockers: AssessmentIssue[] = [];
  const gaps: AssessmentIssue[] = [];
  const warnings: AssessmentIssue[] = [];
  const allowedAlgorithms = input.targetPolicy?.allowedSigningAlgorithms;
  const destinations = new Map(
    input.inventory.destinations.map((destination) => [
      destination.id,
      destination,
    ]),
  );
  for (const endpoint of input.inventory.endpoints) {
    if (
      input.targetPolicy?.requireSigning === true &&
      endpoint.signing === undefined
    ) {
      const issue = {
        code: "SIGNING_REQUIRED",
        message:
          "Target policy requires signing but source metadata has no signing profile.",
        sourceId: endpoint.id,
      };
      gaps.push(issue);
      blockers.push(issue);
    }
    if (
      endpoint.signing !== undefined &&
      allowedAlgorithms !== undefined &&
      !endpoint.signing.algorithms.some((algorithm) =>
        allowedAlgorithms.includes(algorithm),
      )
    ) {
      const issue = {
        code: "SIGNING_ALGORITHM_UNSUPPORTED",
        message: `No source signing algorithm is allowed by target policy (${endpoint.signing.algorithms.join(", ")}).`,
        sourceId: endpoint.id,
      };
      gaps.push(issue);
      blockers.push(issue);
    }
    if (endpoint.signing !== undefined && !endpoint.signing.rotationSupported) {
      const issue = {
        code: "SIGNING_ROTATION_UNAVAILABLE",
        message:
          "Source signing profile does not report overlap rotation support.",
        sourceId: endpoint.id,
      };
      gaps.push(issue);
      warnings.push(issue);
    }
    if (input.targetPolicy?.requireHttps === true) {
      for (const destinationId of endpoint.destinationIds) {
        const destination = destinations.get(destinationId);
        if (
          destination !== undefined &&
          new URL(destination.url).protocol.toLowerCase() === "http:"
        ) {
          const issue = {
            code: "HTTPS_REQUIRED",
            message: `Destination "${destinationId}" uses HTTP while target policy requires HTTPS.`,
            sourceId: endpoint.id,
          };
          gaps.push(issue);
          blockers.push(issue);
        }
      }
    }
  }
  return {
    blockers: sortedIssues(blockers),
    gaps: sortedIssues(gaps),
    warnings: sortedIssues(warnings),
  };
}

const retentionKeys = [
  "attemptLogDays",
  "deliveryLogDays",
  "payloadRetentionDays",
] as const satisfies readonly (keyof RetentionFeatures)[];
const observabilityKeys = [
  "attemptLogs",
  "auditLogs",
  "deliveryLogs",
  "metrics",
  "replay",
] as const satisfies readonly (keyof ObservabilityFeatures)[];

function operationalGaps(input: AssessmentInput): AssessmentIssue[] {
  const gaps: AssessmentIssue[] = [];
  const targetRetention = input.targetPolicy?.minimumRetention;
  const targetObservability = input.targetPolicy?.observability;
  for (const endpoint of input.inventory.endpoints) {
    if (targetRetention !== undefined) {
      for (const key of retentionKeys) {
        const sourceDays = endpoint.retention[key];
        const targetDays = targetRetention[key];
        if (
          sourceDays !== undefined &&
          (targetDays === undefined || targetDays < sourceDays)
        ) {
          gaps.push({
            code: "RETENTION_PARITY_GAP",
            message: `Target ${key} (${targetDays ?? "unspecified"}) is below source ${sourceDays}.`,
            sourceId: endpoint.id,
          });
        }
      }
    }
    if (targetObservability !== undefined) {
      for (const key of observabilityKeys) {
        if (endpoint.observability[key] && targetObservability[key] !== true) {
          gaps.push({
            code: "OBSERVABILITY_PARITY_GAP",
            message: `Target does not guarantee source observability feature ${key}.`,
            sourceId: endpoint.id,
          });
        }
      }
    }
    const targetRetry = input.targetPolicy?.retry;
    if (endpoint.retry.supported && targetRetry?.supported === false) {
      gaps.push({
        code: "RETRY_PARITY_GAP",
        message: "Source supports retries but target policy does not.",
        sourceId: endpoint.id,
      });
    }
    const targetRate = input.targetPolicy?.rate;
    if (endpoint.rate.supported && targetRate?.supported === false) {
      gaps.push({
        code: "RATE_PARITY_GAP",
        message: "Source reports rate controls but target policy does not.",
        sourceId: endpoint.id,
      });
    }
    if (
      endpoint.rate.requestsPerSecond !== undefined &&
      targetRate?.maxRequestsPerSecond !== undefined &&
      targetRate.maxRequestsPerSecond < endpoint.rate.requestsPerSecond
    ) {
      gaps.push({
        code: "RATE_LIMIT_GAP",
        message: `Target rate ${targetRate.maxRequestsPerSecond} requests/second is below source ${endpoint.rate.requestsPerSecond}.`,
        sourceId: endpoint.id,
      });
    }
    if (
      endpoint.rate.burst !== undefined &&
      targetRate?.maxBurst !== undefined &&
      targetRate.maxBurst < endpoint.rate.burst
    ) {
      gaps.push({
        code: "RATE_BURST_GAP",
        message: `Target burst ${targetRate.maxBurst} is below source ${endpoint.rate.burst}.`,
        sourceId: endpoint.id,
      });
    }
    if (
      endpoint.retry.maxAttempts !== undefined &&
      targetRetry?.maxAttempts !== undefined &&
      targetRetry.maxAttempts < endpoint.retry.maxAttempts
    ) {
      gaps.push({
        code: "RETRY_ATTEMPT_LIMIT_GAP",
        message: `Target retry limit ${targetRetry.maxAttempts} is below source ${endpoint.retry.maxAttempts}.`,
        sourceId: endpoint.id,
      });
    }
    if (
      endpoint.retry.maxDurationSeconds !== undefined &&
      targetRetry?.maxDurationSeconds !== undefined &&
      targetRetry.maxDurationSeconds < endpoint.retry.maxDurationSeconds
    ) {
      gaps.push({
        code: "RETRY_DURATION_LIMIT_GAP",
        message: `Target retry duration ${targetRetry.maxDurationSeconds} seconds is below source ${endpoint.retry.maxDurationSeconds}.`,
        sourceId: endpoint.id,
      });
    }
  }
  return sortedIssues(gaps);
}

function policyLimitIssues(input: AssessmentInput): AssessmentIssue[] {
  const issues: AssessmentIssue[] = [];
  const endpointLimit = input.targetPolicy?.endpointLimit;
  if (
    endpointLimit !== undefined &&
    input.inventory.endpoints.length > endpointLimit
  ) {
    issues.push({
      code: "TARGET_ENDPOINT_LIMIT_EXCEEDED",
      message: `Inventory has ${input.inventory.endpoints.length} endpoints; target limit is ${endpointLimit}.`,
    });
  }
  const subscriptionLimit = input.targetPolicy?.subscriptionLimitPerEndpoint;
  if (subscriptionLimit !== undefined) {
    for (const endpoint of input.inventory.endpoints) {
      if (
        endpoint.subscriptions !== undefined &&
        endpoint.subscriptions.length > subscriptionLimit
      ) {
        issues.push({
          code: "TARGET_SUBSCRIPTION_LIMIT_EXCEEDED",
          message: `Endpoint has ${endpoint.subscriptions.length} subscriptions; target limit is ${subscriptionLimit}.`,
          sourceId: endpoint.id,
        });
      }
    }
  }
  return sortedIssues(issues);
}

function rollbackPrerequisites(input: AssessmentInput): RollbackPrerequisite[] {
  const pause = capability(input, "endpoint.pause");
  const remove = capability(input, "endpoint.delete");
  const rotate = capability(input, "secret.rotate_with_overlap");
  const canPauseOrRemove =
    (pause !== undefined && pause.status !== "unsupported") ||
    (remove !== undefined && remove.status !== "unsupported");
  const canRotate = rotate !== undefined && rotate.status !== "unsupported";
  const hasSigning = input.inventory.endpoints.some(
    (endpoint) => endpoint.signing !== undefined,
  );
  const sourceCanOverlap = input.inventory.endpoints
    .filter((endpoint) => endpoint.signing !== undefined)
    .every((endpoint) => endpoint.signing?.rotationSupported === true);
  return [
    {
      code: "SOURCE_INVENTORY_RETAINED",
      message:
        "The validated source inventory must be retained for rollback planning.",
      status: "met",
    },
    {
      code: "TARGET_DELIVERY_REVERSIBLE",
      message:
        "Target endpoints must be pausable or removable without provider console assumptions.",
      status: canPauseOrRemove ? "met" : "unmet",
    },
    {
      code: "SIGNING_OVERLAP",
      message:
        "Signed cutover requires overlap rotation on both source metadata and target adapter.",
      status: !hasSigning
        ? "met"
        : sourceCanOverlap && canRotate
          ? "met"
          : "unmet",
    },
    {
      code: "TARGET_CONFIGURATION_EXPORT",
      message:
        "A target configuration export must be captured after provisioning and before cutover.",
      status:
        input.targetPolicy?.requireRollbackExport === true
          ? "unmet"
          : "unknown",
    },
  ];
}

const migrationPhases: readonly MigrationPhase[] = Object.freeze([
  {
    id: "discover",
    name: "Validate inventory and mappings",
    readOnlyAssessment: true,
    steps: [
      "Review provider/account scope, checksum, duplicates, and unknown subscriptions.",
      "Resolve every unmapped or ambiguous event against the canonical contract.",
    ],
  },
  {
    id: "provision",
    name: "Provision target outside this package",
    readOnlyAssessment: true,
    steps: [
      "Use an approved external workflow to create destinations, endpoints, subscriptions, and signing material.",
      "Capture a secret-free target configuration export for rollback.",
    ],
  },
  {
    id: "verify",
    name: "Verify parity and security",
    readOnlyAssessment: true,
    steps: [
      "Verify signing algorithms, HTTPS policy, retries, limits, retention, and observability.",
      "Send controlled tests through an external authorized workflow.",
    ],
  },
  {
    id: "cutover",
    name: "Controlled cutover",
    readOnlyAssessment: true,
    steps: [
      "Use dual delivery or a staged endpoint cohort where supported.",
      "Keep source delivery and signing overlap available until acceptance criteria pass.",
    ],
  },
  {
    id: "monitor",
    name: "Monitor acceptance criteria",
    readOnlyAssessment: true,
    steps: [
      "Compare delivery success, latency, retries, and event coverage.",
      "Trigger rollback if agreed thresholds are breached.",
    ],
  },
  {
    id: "decommission",
    name: "Decommission after rollback window",
    readOnlyAssessment: true,
    steps: [
      "Retain required audit and delivery records.",
      "Disable source delivery only after rollback prerequisites and retention obligations are satisfied.",
    ],
  },
]);

function component(
  id: ScoreComponent["id"],
  score: number,
  weight: number,
  rationale: string,
): ScoreComponent {
  const normalized = Math.max(0, Math.min(100, Math.round(score)));
  return {
    earned: Math.round((normalized * weight) / 100),
    id,
    rationale,
    score: normalized,
    weight,
  };
}

function readiness(
  mappings: readonly EndpointMapping[],
  parity: readonly CapabilityParityItem[],
  securityGaps: readonly AssessmentIssue[],
  operationalGapItems: readonly AssessmentIssue[],
  rollback: readonly RollbackPrerequisite[],
  blockers: readonly AssessmentIssue[],
): ReadinessScore {
  const eventMappings = mappings.flatMap((mapping) => mapping.events);
  const mappingScore =
    eventMappings.length === 0
      ? mappings.length === 0
        ? 100
        : 0
      : (eventMappings.filter((mapping) => mapping.status === "mapped").length /
          eventMappings.length) *
        100;
  const requiredParity = parity.filter((item) => item.required);
  const capabilityScore =
    requiredParity.length === 0
      ? 100
      : (requiredParity.reduce(
          (total, item) =>
            total +
            (item.status === "supported"
              ? 1
              : item.status === "degraded"
                ? 0.5
                : 0),
          0,
        ) /
          requiredParity.length) *
        100;
  const securityScore = Math.max(0, 100 - securityGaps.length * 25);
  const operationsScore = Math.max(0, 100 - operationalGapItems.length * 15);
  const rollbackScore =
    (rollback.reduce(
      (total, item) =>
        total +
        (item.status === "met" ? 1 : item.status === "unknown" ? 0.5 : 0),
      0,
    ) /
      rollback.length) *
    100;
  const components = [
    component(
      "mapping",
      mappingScore,
      30,
      `${eventMappings.filter((item) => item.status === "mapped").length}/${eventMappings.length} exported event mappings are exact.`,
    ),
    component(
      "capability",
      capabilityScore,
      25,
      `${requiredParity.filter((item) => item.status === "supported").length}/${requiredParity.length} required adapter operations are fully supported.`,
    ),
    component(
      "security",
      securityScore,
      20,
      `${securityGaps.length} signing or transport security gaps were identified.`,
    ),
    component(
      "operations",
      operationsScore,
      15,
      `${operationalGapItems.length} retry, retention, or observability gaps were identified.`,
    ),
    component(
      "rollback",
      rollbackScore,
      10,
      `${rollback.filter((item) => item.status === "met").length}/${rollback.length} rollback prerequisites are confirmed.`,
    ),
  ] as const;
  const score = components.reduce((total, item) => total + item.earned, 0);
  const blocked = blockers.length > 0;
  return {
    blocked,
    components,
    label: blocked
      ? "blocked"
      : score >= 80
        ? "high"
        : score >= 60
          ? "moderate"
          : "low",
    score,
    statement: blocked
      ? `Score ${score}/100 is informational; ${blockers.length} blocker(s) prevent readiness. This assessment never performs or guarantees migration.`
      : `Score ${score}/100 indicates planning readiness only. This assessment never performs or guarantees migration.`,
  };
}

export function assessMigration(input: AssessmentInput): MigrationAssessment {
  const inputDiagnostics = assessmentInputDiagnostics(input);
  if (inputDiagnostics.length > 0) {
    throw new AssessmentInputError(inputDiagnostics);
  }
  let serializedInventory: string;
  try {
    serializedInventory = JSON.stringify(input.inventory);
  } catch {
    throw new AssessmentInputError([
      {
        code: "INVALID_INVENTORY",
        message: "inventory must be finite acyclic JSON.",
        pointer: "/inventory",
        severity: "error",
      },
    ]);
  }
  const validated = parseInventoryExportJson(serializedInventory);
  if (!validated.ok || validated.inventory === undefined) {
    throw new AssessmentInputError(validated.diagnostics);
  }
  const normalizedInput = { ...input, inventory: validated.inventory };
  const mapping = mappingPlan(normalizedInput);
  const parity = capabilityParity(normalizedInput);
  const security = securityGaps(normalizedInput);
  const operations = operationalGaps(normalizedInput);
  const limits = policyLimitIssues(normalizedInput);
  const rollback = rollbackPrerequisites(normalizedInput);
  const rollbackBlockers = rollback
    .filter((item) => item.status === "unmet")
    .map((item) => ({
      code: `ROLLBACK_${item.code}`,
      message: item.message,
    }));
  const blockers = sortedIssues([
    ...mapping.issues,
    ...parity.blockers,
    ...security.blockers,
    ...limits,
    ...rollbackBlockers,
  ]);
  const warnings = sortedIssues([
    ...parity.warnings,
    ...security.warnings,
    ...operations,
  ]);
  const subscriptions = normalizedInput.inventory.endpoints.reduce(
    (total, endpoint) => total + (endpoint.subscriptions?.length ?? 0),
    0,
  );
  return {
    assessmentVersion: MIGRATION_ASSESSMENT_VERSION,
    blockers,
    capabilityParity: parity.items,
    counts: {
      destinations: normalizedInput.inventory.destinations.length,
      endpoints: normalizedInput.inventory.endpoints.length,
      events: normalizedInput.contract.eventTypes.length,
      pausedEndpoints: normalizedInput.inventory.endpoints.filter(
        (endpoint) =>
          endpoint.state === "paused" || endpoint.state === "disabled",
      ).length,
      subscriptions,
    },
    endpointMappings: mapping.mappings,
    inventoryChecksum: checksumInventory(normalizedInput.inventory),
    migrationPhases,
    provider: normalizedInput.inventory.provider,
    readiness: readiness(
      mapping.mappings,
      parity.items,
      security.gaps,
      operations,
      rollback,
      blockers,
    ),
    retentionObservabilityGaps: operations,
    rollbackPrerequisites: rollback,
    signingSecurityGaps: security.gaps,
    targetAdapter: {
      id: normalizedInput.capabilities.adapter.id,
      name: normalizedInput.capabilities.adapter.name,
      version: normalizedInput.capabilities.adapter.version,
    },
    unmappedOrAmbiguous: mapping.issues,
    warnings,
  };
}
