// SPDX-License-Identifier: Apache-2.0

import { inspect } from "node:util";

import {
  ADAPTER_CAPABILITY_SCHEMA_ID,
  ADAPTER_CAPABILITY_SCHEMA_VERSION,
  ADAPTER_OPERATIONS,
  ADAPTER_SDK_VERSION,
  CANONICAL_METADATA_SCHEMA_VERSION,
  DEFAULT_ADAPTER_MAPPING_VERSION,
  REDACTED_SECRET,
  SecretValue,
  canonicalizeMetadataRecord,
  compareUtf16CodeUnits,
  isMappingVersion,
  isSideEffectingOperation,
  isWellFormedUnicode,
  redactSecrets,
  reduceDeliveryAttempt,
  validateCanonicalMetadataRecord,
  type AdapterCapabilityDocument,
  type AdapterCommand,
  type AdapterCommandResult,
  type AdapterOperation,
  type CanonicalDeliveryAttemptMetadata,
  type MetadataDeliveryAttemptInput,
} from "@webhook-portal/adapter-sdk";

export class AdapterConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConformanceError";
  }
}

export interface ConformanceAdapter {
  readonly capabilityDocument: AdapterCapabilityDocument;
  execute(command: AdapterCommand): Promise<AdapterCommandResult>;
}

export interface ConformanceSideEffectProbe {
  read(): number | Promise<number>;
  reset(): void | Promise<void>;
}

export interface IdempotencyConformanceProbe {
  readonly command: () => AdapterCommand;
  readonly restart: () => ConformanceAdapter | Promise<ConformanceAdapter>;
  readonly retryCommand: () => AdapterCommand;
}

export interface DeadlineConformanceProbe {
  readonly command: () => AdapterCommand;
  readonly wasCancelled: () => boolean | Promise<boolean>;
}

export interface SendTestTimeoutConformanceProbe {
  readonly command: () => AdapterCommand;
  readonly retryCommand: () => AdapterCommand;
  readonly restart: () => ConformanceAdapter | Promise<ConformanceAdapter>;
}

export interface SecretConformanceProbe {
  readonly plaintext: string;
  readonly secret: SecretValue;
}

export interface CommandAuthenticationProbeResult {
  readonly concurrentConsumeSafe: boolean;
  readonly conflictingReplayRejected: boolean;
  readonly duplicateRejected: boolean;
  readonly expiredRejected: boolean;
  readonly forgedRejected: boolean;
  readonly receiverVerified: boolean;
  readonly storedResultReplayed: boolean;
  readonly wrongScopeRejected: boolean;
}

export interface AcknowledgementAuthenticationProbeResult {
  readonly expiredRejected: boolean;
  readonly forgedRejected: boolean;
  readonly modifiedRejected: boolean;
  readonly replayedRejected: boolean;
  readonly signedVerified: boolean;
  readonly unsignedRejected: boolean;
  readonly wrongKeyRejected: boolean;
  readonly wrongScopeRejected: boolean;
}

export interface MetadataIngestProbeResult {
  readonly forgedRejected: boolean;
  readonly identityDerived: boolean;
  readonly signedVerified: boolean;
  readonly wrongScopeRejected: boolean;
}

export interface ConformanceSecurityProbes {
  acknowledgementAuthentication(): Promise<AcknowledgementAuthenticationProbeResult>;
  commandAuthentication(): Promise<CommandAuthenticationProbeResult>;
  metadataIngest(): Promise<MetadataIngestProbeResult>;
}

export interface AdapterConformanceFixture {
  readonly adapter: ConformanceAdapter;
  readonly commands: Partial<Record<AdapterOperation, () => AdapterCommand>>;
  readonly deadline?: DeadlineConformanceProbe;
  readonly idempotency?: IdempotencyConformanceProbe;
  readonly metadata?: CanonicalDeliveryAttemptMetadata;
  readonly name?: string;
  readonly reset?: () => void | Promise<void>;
  readonly security?: ConformanceSecurityProbes;
  readonly secrets?: readonly SecretConformanceProbe[];
  readonly sendTestTimeout?: SendTestTimeoutConformanceProbe;
  readonly sideEffects?: ConformanceSideEffectProbe;
}

export type ConformanceCaseStatus = "failed" | "passed";

export interface ConformanceCaseResult {
  readonly durationMilliseconds: number;
  readonly message?: string;
  readonly name: string;
  readonly status: ConformanceCaseStatus;
}

export interface AdapterConformanceReport {
  readonly failed: number;
  readonly name: string;
  readonly passed: boolean;
  readonly results: readonly ConformanceCaseResult[];
  readonly skipped: 0;
  readonly succeeded: number;
}

export interface AdapterConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

export interface ConformanceTestRunner {
  describe(name: string, body: () => void): void;
  test(name: string, body: () => Promise<void> | void): void;
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AdapterConformanceError(message);
  }
}

async function resetFixture(fixture: AdapterConformanceFixture): Promise<void> {
  await fixture.reset?.();
  await fixture.sideEffects?.reset();
}

function stableValue(value: unknown): string {
  return canonicalValue(redactSecrets(value));
}

function canonicalValue(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return candidate.map((item) => normalize(item));
    }
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function metadataInput(
  overrides: Partial<MetadataDeliveryAttemptInput> = {},
): MetadataDeliveryAttemptInput {
  return {
    kind: "delivery_attempt",
    schemaVersion: CANONICAL_METADATA_SCHEMA_VERSION,
    eventId: "event-conformance",
    deliveryId: "delivery-conformance",
    endpointId: "endpoint-conformance",
    eventVersion: {
      eventType: "invoice.paid",
      version: "2026-07-01",
      schemaChecksum: "a".repeat(64),
    },
    attempt: 1,
    sequence: 1,
    status: "attempting",
    occurredAt: "2026-07-01T00:00:00.000Z",
    mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
    ...overrides,
  };
}

function defaultMetadata(
  overrides: Partial<MetadataDeliveryAttemptInput> = {},
): CanonicalDeliveryAttemptMetadata {
  return canonicalizeMetadataRecord(metadataInput(overrides), {
    tenantId: "tenant-conformance",
    environment: "test",
    connectionId: "connection-conformance",
    adapterId: "adapter-conformance",
  });
}

function deriveMetadata(
  record: CanonicalDeliveryAttemptMetadata,
  overrides: Partial<MetadataDeliveryAttemptInput> = {},
  identityOverrides: Partial<{
    readonly adapterId: string;
    readonly connectionId: string;
    readonly environment: string;
    readonly tenantId: string;
  }> = {},
): CanonicalDeliveryAttemptMetadata {
  const {
    adapterId,
    connectionId,
    dedupeKey: _dedupeKey,
    environment,
    tenantId,
    ...input
  } = record;
  void _dedupeKey;
  return canonicalizeMetadataRecord(
    {
      ...input,
      ...overrides,
      eventVersion: {
        ...input.eventVersion,
        ...overrides.eventVersion,
      },
      mappingVersion: {
        ...input.mappingVersion,
        ...overrides.mappingVersion,
      },
    },
    {
      tenantId: identityOverrides.tenantId ?? tenantId,
      environment: identityOverrides.environment ?? environment,
      connectionId: identityOverrides.connectionId ?? connectionId,
      adapterId: identityOverrides.adapterId ?? adapterId,
    },
  );
}

const capabilityOperations = new Set<string>(ADAPTER_OPERATIONS);
const capabilityStatuses = new Set<string>([
  "degraded",
  "supported",
  "unsupported",
]);
const idempotencyStatuses = new Set<string>([
  "not_applicable",
  "required",
  "supported",
]);
const maximumIdentityLength = 256;
const maximumReasonLength = 2_048;
const maximumConstraintCount = 64;
const maximumConstraintKeyLength = 128;
const maximumConstraintStringLength = 2_048;
const maximumConstraintArrayLength = 64;
const unsafeText = /[\u0000-\u001f\u007f]/u;

function inspectClosedObject(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  issues: string[],
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object.`);
    return undefined;
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const result = Object.create(null) as Record<string, unknown>;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push(`${path} must be a plain object.`);
    }
    const ownKeys = Reflect.ownKeys(value);
    for (const key of ownKeys) {
      if (typeof key !== "string") {
        issues.push(`${path} must not contain symbol fields.`);
        continue;
      }
      if (!allowed.has(key)) {
        issues.push(`${path} has unknown field ${key}.`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        issues.push(`${path}.${key} must be an enumerable data property.`);
        continue;
      }
      result[key] = descriptor.value;
    }
    for (const key of requiredKeys) {
      if (!Object.hasOwn(value, key)) {
        issues.push(`${path} is missing required field ${key}.`);
      }
    }
  } catch {
    issues.push(`${path} could not be safely inspected.`);
    return undefined;
  }
  return result;
}

function inspectArray(
  value: unknown,
  path: string,
  maximumLength: number,
  issues: string[],
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array.`);
    return undefined;
  }
  if (value.length > maximumLength) {
    issues.push(`${path} exceeds its maximum length.`);
    return undefined;
  }
  const result: unknown[] = [];
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      issues.push(`${path} must be a plain array.`);
    }
    const expectedIndexes = new Set(
      Array.from({ length: value.length }, (_unused, index) => String(index)),
    );
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") {
        continue;
      }
      if (typeof key !== "string" || !expectedIndexes.has(key)) {
        issues.push(`${path} contains an unknown array field.`);
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        issues.push(`${path}[${index}] must be an enumerable data property.`);
        result.push(undefined);
      } else {
        result.push(descriptor.value);
      }
    }
  } catch {
    issues.push(`${path} could not be safely inspected.`);
    return undefined;
  }
  return result;
}

function validateSafeString(
  value: unknown,
  path: string,
  maximumLength: number,
  issues: string[],
  allowEmpty = false,
): value is string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength ||
    !isWellFormedUnicode(value) ||
    unsafeText.test(value)
  ) {
    issues.push(`${path} must be a bounded safe string.`);
    return false;
  }
  return true;
}

function validateConstraintScalar(
  value: unknown,
  path: string,
  issues: string[],
): "number" | "string" | undefined {
  if (typeof value === "boolean") {
    issues.push(`${path} must be a bounded JSON constraint scalar.`);
    return undefined;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  ) {
    return "number";
  }
  if (typeof value === "string") {
    return validateSafeString(
      value,
      path,
      maximumConstraintStringLength,
      issues,
      true,
    )
      ? "string"
      : undefined;
  }
  issues.push(`${path} must be a bounded JSON constraint scalar.`);
  return undefined;
}

function validateConstraints(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object.`);
    return;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push(`${path} must be a plain object.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumConstraintCount) {
      issues.push(`${path} has too many entries.`);
      return;
    }
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        !validateSafeString(
          key,
          `${path} key`,
          maximumConstraintKeyLength,
          issues,
        )
      ) {
        if (typeof key !== "string") {
          issues.push(`${path} must not contain symbol fields.`);
        }
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        issues.push(`${path}.${key} must be an enumerable data property.`);
        continue;
      }
      const constraint = descriptor.value;
      if (typeof constraint === "boolean") {
        continue;
      }
      if (Array.isArray(constraint)) {
        const entries = inspectArray(
          constraint,
          `${path}.${key}`,
          maximumConstraintArrayLength,
          issues,
        );
        if (entries === undefined || entries.length === 0) {
          continue;
        }
        let scalarType: "number" | "string" | undefined;
        for (let index = 0; index < entries.length; index += 1) {
          const entryType = validateConstraintScalar(
            entries[index],
            `${path}.${key}[${index}]`,
            issues,
          );
          if (entryType === undefined) {
            continue;
          }
          scalarType ??= entryType;
          if (entryType !== scalarType) {
            issues.push(`${path}.${key} must contain one scalar type.`);
          }
        }
        continue;
      }
      validateConstraintScalar(constraint, `${path}.${key}`, issues);
    }
  } catch {
    issues.push(`${path} could not be safely inspected.`);
  }
}

function validateCapabilityStructure(
  value: unknown,
  path: string,
  issues: string[],
): Readonly<Record<string, unknown>> | undefined {
  const capability = inspectClosedObject(
    value,
    path,
    ["idempotency", "operation", "sideEffecting", "status"],
    ["constraints", "reason"],
    issues,
  );
  if (capability === undefined) {
    return undefined;
  }
  if (
    typeof capability["operation"] !== "string" ||
    !capabilityOperations.has(capability["operation"])
  ) {
    issues.push(`${path}.operation is invalid.`);
  }
  if (
    typeof capability["status"] !== "string" ||
    !capabilityStatuses.has(capability["status"])
  ) {
    issues.push(`${path}.status is invalid.`);
  }
  if (
    typeof capability["idempotency"] !== "string" ||
    !idempotencyStatuses.has(capability["idempotency"])
  ) {
    issues.push(`${path}.idempotency is invalid.`);
  }
  if (typeof capability["sideEffecting"] !== "boolean") {
    issues.push(`${path}.sideEffecting must be boolean.`);
  }
  if (
    Object.hasOwn(capability, "reason") &&
    !validateSafeString(
      capability["reason"],
      `${path}.reason`,
      maximumReasonLength,
      issues,
      true,
    )
  ) {
    // validateSafeString records the structural issue.
  }
  if (Object.hasOwn(capability, "constraints")) {
    validateConstraints(
      capability["constraints"],
      `${path}.constraints`,
      issues,
    );
  }
  return capability;
}

function validateCapabilityDocumentValue(document: unknown): readonly string[] {
  const structuralIssues: string[] = [];
  const topLevel = inspectClosedObject(
    document,
    "The capability document",
    [
      "$schema",
      "adapter",
      "capabilities",
      "kind",
      "operations",
      "schemaVersion",
      "sdkVersion",
    ],
    ["generatedAt"],
    structuralIssues,
  );
  if (topLevel === undefined) {
    return Object.freeze(structuralIssues);
  }
  if (topLevel["$schema"] !== ADAPTER_CAPABILITY_SCHEMA_ID) {
    structuralIssues.push(
      "The capability document schema identifier is invalid.",
    );
  }
  if (topLevel["kind"] !== "adapter_capabilities") {
    structuralIssues.push("The capability document kind is invalid.");
  }
  if (topLevel["schemaVersion"] !== ADAPTER_CAPABILITY_SCHEMA_VERSION) {
    structuralIssues.push("The capability document schema version is invalid.");
  }
  if (topLevel["sdkVersion"] !== ADAPTER_SDK_VERSION) {
    structuralIssues.push("The capability document SDK version is invalid.");
  }

  const adapter = inspectClosedObject(
    topLevel["adapter"],
    "The capability document adapter",
    ["id", "name", "version"],
    ["homepage", "vendor"],
    structuralIssues,
  );
  if (adapter !== undefined) {
    for (const field of ["id", "name", "version"] as const) {
      validateSafeString(
        adapter[field],
        `The capability document adapter.${field}`,
        maximumIdentityLength,
        structuralIssues,
      );
    }
    for (const field of ["homepage", "vendor"] as const) {
      if (Object.hasOwn(adapter, field)) {
        validateSafeString(
          adapter[field],
          `The capability document adapter.${field}`,
          maximumIdentityLength,
          structuralIssues,
          true,
        );
      }
    }
  }
  if (
    Object.hasOwn(topLevel, "generatedAt") &&
    !validateSafeString(
      topLevel["generatedAt"],
      "The capability document generatedAt",
      128,
      structuralIssues,
    )
  ) {
    // validateSafeString records the structural issue.
  }

  const operationEntries = inspectArray(
    topLevel["operations"],
    "The capability document operations",
    ADAPTER_OPERATIONS.length,
    structuralIssues,
  );
  if (
    operationEntries !== undefined &&
    operationEntries.length !== ADAPTER_OPERATIONS.length
  ) {
    structuralIssues.push(
      "The capability document must declare every operation.",
    );
  }
  const operationCapabilities = new Map<
    AdapterOperation,
    Readonly<Record<string, unknown>>
  >();
  const operationCounts = new Map<AdapterOperation, number>();
  for (const [index, value] of (operationEntries ?? []).entries()) {
    const capability = validateCapabilityStructure(
      value,
      `The capability document operations[${index}]`,
      structuralIssues,
    );
    const operation = capability?.["operation"];
    if (
      capability !== undefined &&
      typeof operation === "string" &&
      capabilityOperations.has(operation)
    ) {
      const typedOperation = operation as AdapterOperation;
      operationCounts.set(
        typedOperation,
        (operationCounts.get(typedOperation) ?? 0) + 1,
      );
      operationCapabilities.set(typedOperation, capability);
    }
  }
  for (const operation of ADAPTER_OPERATIONS) {
    const count = operationCounts.get(operation) ?? 0;
    if (count === 0) {
      structuralIssues.push(`${operation} is missing.`);
    } else if (count > 1) {
      structuralIssues.push(`${operation} is declared more than once.`);
    }
  }

  const capabilities = inspectClosedObject(
    topLevel["capabilities"],
    "The capability document capabilities",
    ADAPTER_OPERATIONS,
    [],
    structuralIssues,
  );
  const indexedCapabilities = new Map<
    AdapterOperation,
    Readonly<Record<string, unknown>>
  >();
  if (capabilities !== undefined) {
    for (const operation of ADAPTER_OPERATIONS) {
      const capability = validateCapabilityStructure(
        capabilities[operation],
        `The capability document capabilities.${operation}`,
        structuralIssues,
      );
      if (capability !== undefined) {
        indexedCapabilities.set(operation, capability);
      }
    }
  }

  if (structuralIssues.length > 0) {
    return Object.freeze(structuralIssues);
  }

  const issues: string[] = [];
  if (
    typeof topLevel["generatedAt"] === "string" &&
    !Number.isFinite(Date.parse(topLevel["generatedAt"]))
  ) {
    issues.push("The capability document generatedAt is invalid.");
  }
  for (const operation of ADAPTER_OPERATIONS) {
    const capability = operationCapabilities.get(operation);
    const indexed = indexedCapabilities.get(operation);
    if (capability === undefined || indexed === undefined) {
      continue;
    }
    if (canonicalValue(indexed) !== canonicalValue(capability)) {
      issues.push(`${operation} differs between indexes.`);
    }
    if (capability["sideEffecting"] !== isSideEffectingOperation(operation)) {
      issues.push(`${operation} misstates side effects.`);
    }
    if (
      capability["sideEffecting"] === true &&
      capability["idempotency"] !== "required"
    ) {
      issues.push(`${operation} must require idempotency.`);
    }
  }
  if (
    !ADAPTER_OPERATIONS.includes("secret.rotate_with_overlap") ||
    (ADAPTER_OPERATIONS as readonly string[]).includes("secret.rotate-overlap")
  ) {
    issues.push("The secret overlap operation name violates the frozen API.");
  }
  return Object.freeze(issues);
}

export function validateCapabilityDocument(
  document: unknown,
): readonly string[] {
  try {
    return validateCapabilityDocumentValue(document);
  } catch {
    return Object.freeze([
      "The capability document could not be safely inspected.",
    ]);
  }
}

function plainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateOperationResult(
  operation: AdapterOperation,
  result: AdapterCommandResult,
): readonly string[] {
  const issues: string[] = [];
  if (!isSideEffectingOperation(operation) && result.sideEffects !== "none") {
    issues.push(`${operation} incorrectly reported side effects.`);
  }
  if (result.status === "unsupported" || result.status === "failure") {
    issues.push(`${operation} returned ${result.status} in its success probe.`);
    return issues;
  }
  if (result.status === "unknown") {
    issues.push(`${operation} returned unknown in its normal success probe.`);
    return issues;
  }
  const value = result.value;
  if (!plainObject(value)) {
    issues.push(`${operation} did not return an operation-specific object.`);
    return issues;
  }
  if (operation.startsWith("endpoint.")) {
    const endpointStates = new Set([
      "active",
      "deleted",
      "paused",
      "pending",
      "unknown",
    ]);
    if (
      !plainObject(value["endpoint"]) ||
      typeof value["endpoint"]["state"] !== "string" ||
      !endpointStates.has(value["endpoint"]["state"]) ||
      !isMappingVersion(value["endpoint"]["mappingVersion"])
    ) {
      issues.push(`${operation} returned an invalid endpoint result.`);
    }
    if (
      operation === "endpoint.delete" &&
      typeof value["deleted"] !== "boolean"
    ) {
      issues.push("endpoint.delete must return deleted.");
    }
    if (
      operation === "endpoint.verify" &&
      typeof value["verified"] !== "boolean"
    ) {
      issues.push("endpoint.verify must return verified.");
    }
  } else if (operation.startsWith("subscription.")) {
    const subscriptionStates = new Set([
      "active",
      "paused",
      "pending",
      "unknown",
    ]);
    if (
      !plainObject(value["subscription"]) ||
      typeof value["subscription"]["state"] !== "string" ||
      !subscriptionStates.has(value["subscription"]["state"]) ||
      !isMappingVersion(value["subscription"]["mappingVersion"])
    ) {
      issues.push(`${operation} returned an invalid subscription result.`);
    }
  } else if (operation.startsWith("secret.")) {
    const secretStates = new Set([
      "active",
      "overlapping",
      "pending",
      "revoked",
      "unknown",
    ]);
    if (
      !plainObject(value["secret"]) ||
      typeof value["secret"]["state"] !== "string" ||
      !secretStates.has(value["secret"]["state"]) ||
      !isMappingVersion(value["secret"]["mappingVersion"])
    ) {
      issues.push(`${operation} returned an invalid secret result.`);
    }
  } else if (operation === "send_test") {
    if (
      typeof value["accepted"] !== "boolean" ||
      (value["state"] !== "accepted" && value["state"] !== "pending")
    ) {
      issues.push("send_test returned an invalid dispatch result.");
    }
  } else if (operation === "request_replay") {
    if (
      typeof value["accepted"] !== "boolean" ||
      (value["state"] !== "accepted" && value["state"] !== "pending")
    ) {
      issues.push("request_replay returned an invalid replay result.");
    }
  } else if (
    operation === "metadata.poll" ||
    operation === "metadata.backfill"
  ) {
    if (
      !Array.isArray(value["records"]) ||
      !Array.isArray(value["reductions"]) ||
      typeof value["hasMore"] !== "boolean"
    ) {
      issues.push(`${operation} returned an invalid metadata result.`);
    } else if (
      value["records"].some(
        (record) => !validateCanonicalMetadataRecord(record).ok,
      )
    ) {
      issues.push(`${operation} returned non-canonical metadata records.`);
    }
  }
  if (isSideEffectingOperation(operation) && result.sideEffects === "none") {
    issues.push(`${operation} did not report its side-effect outcome.`);
  }
  return Object.freeze(issues);
}

function supportedOperations(
  fixture: AdapterConformanceFixture,
): readonly AdapterOperation[] {
  if (
    validateCapabilityDocument(fixture.adapter.capabilityDocument).length > 0
  ) {
    return [];
  }
  return ADAPTER_OPERATIONS.filter((operation) => {
    const status =
      fixture.adapter.capabilityDocument.capabilities[operation].status;
    return status === "supported" || status === "degraded";
  });
}

function unsupportedOperations(
  fixture: AdapterConformanceFixture,
): readonly AdapterOperation[] {
  if (
    validateCapabilityDocument(fixture.adapter.capabilityDocument).length > 0
  ) {
    return [];
  }
  return ADAPTER_OPERATIONS.filter(
    (operation) =>
      fixture.adapter.capabilityDocument.capabilities[operation].status ===
      "unsupported",
  );
}

function supportedSideEffects(
  fixture: AdapterConformanceFixture,
): readonly AdapterOperation[] {
  return supportedOperations(fixture).filter((operation) =>
    isSideEffectingOperation(operation),
  );
}

function secretCases(
  fixture: AdapterConformanceFixture,
): readonly SecretConformanceProbe[] {
  return (
    fixture.secrets ?? [
      {
        plaintext: "adapter-conformance-secret-7d43f6",
        secret: new SecretValue("adapter-conformance-secret-7d43f6"),
      },
    ]
  );
}

function withoutCredential(command: AdapterCommand): AdapterCommand {
  const context = { ...command.context };
  delete context.credential;
  return {
    ...command,
    context,
  } as AdapterCommand;
}

export function createAdapterConformanceCases(
  fixture: AdapterConformanceFixture,
): readonly AdapterConformanceCase[] {
  const cases: AdapterConformanceCase[] = [
    {
      name: "capability document is complete and honest",
      async run() {
        const issues = validateCapabilityDocument(
          fixture.adapter.capabilityDocument,
        );
        ensure(issues.length === 0, issues.join(" "));
        for (const operation of supportedOperations(fixture)) {
          ensure(
            fixture.commands[operation] !== undefined,
            `Supported capability ${operation} is missing its mandatory probe.`,
          );
        }
      },
    },
    {
      name: "every supported operation returns its typed result",
      async run() {
        for (const operation of supportedOperations(fixture)) {
          const factory = fixture.commands[operation];
          ensure(factory !== undefined, `${operation} has no command probe.`);
          await resetFixture(fixture);
          const result = await fixture.adapter.execute(factory());
          const issues = validateOperationResult(operation, result);
          ensure(issues.length === 0, issues.join(" "));
        }
      },
    },
    {
      name: "unsupported operations return before side effects",
      async run() {
        const unsupported = unsupportedOperations(fixture);
        if (unsupported.length === 0) {
          return;
        }
        const operation = unsupported.find(
          (candidate) => fixture.commands[candidate] !== undefined,
        );
        ensure(
          operation !== undefined,
          "At least one unsupported operation requires a mandatory probe.",
        );
        const factory = fixture.commands[operation];
        ensure(factory !== undefined, "The unsupported probe is unavailable.");
        await resetFixture(fixture);
        const before = await fixture.sideEffects?.read();
        const result = await fixture.adapter.execute(factory());
        const after = await fixture.sideEffects?.read();
        ensure(
          result.status === "unsupported" && result.sideEffects === "none",
          `${operation} did not return explicit unsupported.`,
        );
        if (before !== undefined && after !== undefined) {
          ensure(
            before === after,
            `${operation} performed a side effect before returning unsupported.`,
          );
        }
      },
    },
    {
      name: "side-effecting calls require authenticated credentials",
      async run() {
        const operation = supportedSideEffects(fixture)[0];
        if (operation === undefined) {
          return;
        }
        ensure(
          fixture.sideEffects !== undefined,
          "Side-effect certification requires a side-effect probe.",
        );
        const factory = fixture.commands[operation];
        ensure(factory !== undefined, `${operation} has no command probe.`);
        await resetFixture(fixture);
        const before = await fixture.sideEffects.read();
        const result = await fixture.adapter.execute(
          withoutCredential(factory()),
        );
        const after = await fixture.sideEffects.read();
        ensure(
          result.status === "failure" &&
            (result.error.code === "authentication_required" ||
              result.error.code.startsWith("auth.")),
          "A side-effecting command accepted missing authentication.",
        );
        ensure(
          before === after,
          "An unauthenticated command performed a side effect.",
        );
      },
    },
    {
      name: "durable idempotency suppresses duplicate side effects",
      async run() {
        if (supportedSideEffects(fixture).length === 0) {
          return;
        }
        ensure(
          fixture.idempotency !== undefined &&
            fixture.sideEffects !== undefined,
          "Side-effect certification requires durable idempotency and side-effect probes.",
        );
        await resetFixture(fixture);
        const command = fixture.idempotency.command();
        const before = await fixture.sideEffects.read();
        const first = await fixture.adapter.execute(command);
        const restarted = await fixture.idempotency.restart();
        ensure(
          restarted !== fixture.adapter,
          "The restart probe must create a distinct adapter instance.",
        );
        const second = await restarted.execute(
          fixture.idempotency.retryCommand(),
        );
        const after = await fixture.sideEffects.read();
        ensure(
          first.status !== "failure" &&
            first.status !== "unsupported" &&
            stableValue(first) === stableValue(second),
          "Idempotent replay did not return the durable result.",
        );
        ensure(
          after - before === 1,
          "Idempotent replay dispatched more or fewer than one side effect.",
        );
      },
    },
    {
      name: "deadlines cancel real in-flight side effects",
      async run() {
        if (supportedSideEffects(fixture).length === 0) {
          return;
        }
        ensure(
          fixture.deadline !== undefined,
          "Side-effect certification requires a deadline cancellation probe.",
        );
        await resetFixture(fixture);
        const result = await fixture.adapter.execute(
          fixture.deadline.command(),
        );
        ensure(
          await fixture.deadline.wasCancelled(),
          "The in-flight side effect did not observe cancellation.",
        );
        ensure(
          result.status === "unknown" ||
            (result.status === "failure" &&
              result.error.code === "deadline_exceeded"),
          "The deadline did not produce an explicit ambiguous/expired result.",
        );
      },
    },
    {
      name: "send_test timeout is non-retryable across restart",
      async run() {
        if (!supportedOperations(fixture).includes("send_test")) {
          return;
        }
        ensure(
          fixture.sendTestTimeout !== undefined &&
            fixture.sideEffects !== undefined,
          "send_test certification requires timeout, restart, and side-effect probes.",
        );
        await resetFixture(fixture);
        const command = fixture.sendTestTimeout.command();
        const before = await fixture.sideEffects.read();
        const first = await fixture.adapter.execute(command);
        ensure(
          first.status === "unknown" && first.retryable === false,
          "A timed-out send_test must be unknown and non-retryable.",
        );
        const restarted = await fixture.sendTestTimeout.restart();
        ensure(
          restarted !== fixture.adapter,
          "The send_test restart probe must create a distinct adapter instance.",
        );
        const second = await restarted.execute(
          fixture.sendTestTimeout.retryCommand(),
        );
        const after = await fixture.sideEffects.read();
        ensure(
          second.status === "unknown" &&
            second.retryable === false &&
            stableValue(first) === stableValue(second),
          "Restart did not replay the durable send_test timeout result.",
        );
        ensure(
          after - before === 1,
          "send_test dispatched more than once across timeout and restart.",
        );
      },
    },
    {
      name: "cryptographic receivers reject forged and replayed inputs",
      async run() {
        ensure(
          fixture.security !== undefined,
          "Certification requires command, acknowledgement, and metadata ingest security probes.",
        );
        const command = await fixture.security.commandAuthentication();
        ensure(
          command.receiverVerified &&
            command.duplicateRejected &&
            command.conflictingReplayRejected &&
            command.concurrentConsumeSafe &&
            command.storedResultReplayed &&
            command.forgedRejected &&
            command.expiredRejected &&
            command.wrongScopeRejected,
          "Receiver-side command authentication probes did not all pass.",
        );
        const acknowledgement =
          await fixture.security.acknowledgementAuthentication();
        ensure(
          acknowledgement.signedVerified &&
            acknowledgement.forgedRejected &&
            acknowledgement.modifiedRejected &&
            acknowledgement.expiredRejected &&
            acknowledgement.replayedRejected &&
            acknowledgement.wrongKeyRejected &&
            acknowledgement.wrongScopeRejected &&
            acknowledgement.unsignedRejected,
          "Signed acknowledgement authentication probes did not all pass.",
        );
        const metadata = await fixture.security.metadataIngest();
        ensure(
          metadata.signedVerified &&
            metadata.forgedRejected &&
            metadata.wrongScopeRejected &&
            metadata.identityDerived,
          "The real metadata ingest security probes did not all pass.",
        );
      },
    },
    {
      name: "secret wrappers redact every inspection surface",
      async run() {
        for (const { secret, plaintext } of secretCases(fixture)) {
          for (const surface of [
            String(secret),
            JSON.stringify(secret),
            inspect(secret),
            JSON.stringify(redactSecrets({ secret, authorization: plaintext })),
          ]) {
            ensure(
              !surface.includes(plaintext) && surface.includes(REDACTED_SECRET),
              "A secret inspection surface leaked or failed to redact.",
            );
          }
        }
      },
    },
    {
      name: "metadata schema, dedupe, and reduction are identity scoped",
      async run() {
        const record = fixture.metadata ?? defaultMetadata();
        ensure(
          validateCanonicalMetadataRecord(record).ok,
          "The canonical metadata fixture is invalid.",
        );
        for (const forbidden of [
          { ...record, body: { payload: true } },
          { ...record, authorization: "secret" },
          { ...record, connectionId: "forged" },
          {
            ...record,
            eventVersion: {
              ...record.eventVersion,
              responseBody: "forbidden",
            },
          },
        ]) {
          ensure(
            !validateCanonicalMetadataRecord(forbidden).ok,
            "The closed metadata schema accepted forbidden data.",
          );
        }
        const first = reduceDeliveryAttempt(undefined, record);
        ensure(
          reduceDeliveryAttempt(first, record) === first,
          "Duplicate metadata changed reducer state.",
        );
        const delivered = deriveMetadata(record, {
          attempt: record.attempt,
          sequence: record.sequence,
          status: "delivered",
          responseStatusCode: 200,
          occurredAt: new Date(Date.parse(record.occurredAt) + 1).toISOString(),
        });
        const deliveredState = reduceDeliveryAttempt(first, delivered);
        ensure(
          deliveredState.current.status === "delivered",
          "A same-sequence terminal observation did not advance monotonically.",
        );
        ensure(
          reduceDeliveryAttempt(deliveredState, delivered) === deliveredState,
          "An exact terminal observation did not deduplicate.",
        );
        const oldAttempt = deriveMetadata(record, {
          attempt: record.attempt,
          sequence: Math.max(0, record.sequence - 1),
          status: "pending",
        });
        const reduced = reduceDeliveryAttempt(first, oldAttempt);
        ensure(
          reduced.current.attempt === record.attempt,
          "Out-of-order metadata regressed the current attempt.",
        );
        const otherConnection = deriveMetadata(
          record,
          {},
          { connectionId: "other-connection" },
        );
        let rejected = false;
        try {
          reduceDeliveryAttempt(first, otherConnection);
        } catch {
          rejected = true;
        }
        ensure(
          rejected,
          "The reducer combined metadata from different connections.",
        );
      },
    },
  ];
  return Object.freeze(cases.map((entry) => Object.freeze(entry)));
}

function safeFailureMessage(
  error: unknown,
  secrets: readonly SecretConformanceProbe[],
): string {
  let message =
    error instanceof Error ? error.message : "The conformance case failed.";
  for (const { plaintext } of secrets) {
    message = message.split(plaintext).join(REDACTED_SECRET);
  }
  return message;
}

async function executeCase(
  testCase: AdapterConformanceCase,
  fixture: AdapterConformanceFixture,
): Promise<ConformanceCaseResult> {
  const started = Date.now();
  try {
    await testCase.run();
    return Object.freeze({
      name: testCase.name,
      status: "passed",
      durationMilliseconds: Date.now() - started,
    });
  } catch (error: unknown) {
    return Object.freeze({
      name: testCase.name,
      status: "failed",
      message: safeFailureMessage(error, secretCases(fixture)),
      durationMilliseconds: Date.now() - started,
    });
  }
}

export async function runAdapterConformance(
  fixture: AdapterConformanceFixture,
): Promise<AdapterConformanceReport> {
  const results: ConformanceCaseResult[] = [];
  for (const testCase of createAdapterConformanceCases(fixture)) {
    results.push(await executeCase(testCase, fixture));
  }
  const failed = results.filter((entry) => entry.status === "failed").length;
  return Object.freeze({
    name: fixture.name ?? fixture.adapter.capabilityDocument.adapter.name,
    passed: failed === 0,
    failed,
    skipped: 0,
    succeeded: results.length - failed,
    results: Object.freeze(results),
  });
}

export function assertAdapterConformance(
  report: AdapterConformanceReport,
): void {
  if (!report.passed) {
    throw new AdapterConformanceError(
      report.results
        .filter((entry) => entry.status === "failed")
        .map((entry) => `${entry.name}: ${entry.message ?? "failed"}`)
        .join("; "),
    );
  }
}

export function registerAdapterConformanceTests(
  runner: ConformanceTestRunner,
  fixture: AdapterConformanceFixture,
): void {
  runner.describe(
    `${fixture.name ?? fixture.adapter.capabilityDocument.adapter.name} adapter conformance`,
    () => {
      for (const testCase of createAdapterConformanceCases(fixture)) {
        runner.test(testCase.name, async () => {
          const result = await executeCase(testCase, fixture);
          if (result.status === "failed") {
            throw new AdapterConformanceError(
              result.message ?? "The conformance case failed.",
            );
          }
        });
      }
    },
  );
}

export const defineAdapterConformanceTests = registerAdapterConformanceTests;
