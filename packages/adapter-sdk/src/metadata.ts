// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  assertWellFormedUnicode,
  compareUtf16CodeUnits,
  isWellFormedUnicode,
} from "./canonical.js";
import { checkCredentialScope, type ScopedCredential } from "./context.js";
import {
  isMappingVersion,
  isProviderNativeRef,
  type AdapterJsonValue,
  type MappingVersion,
  type ProviderNativeRef,
} from "./model.js";
import { revealSecret } from "./secret.js";

export const CANONICAL_METADATA_SCHEMA_VERSION = "2026-07-01" as const;
export const METADATA_INGEST_SCHEMA_VERSION = "2026-07-01" as const;
export const METADATA_INGEST_SIGNATURE_ALGORITHM = "hmac-sha256" as const;

export type DeliveryAttemptStatus =
  | "attempting"
  | "cancelled"
  | "delivered"
  | "exhausted"
  | "failed"
  | "pending"
  | "retry_scheduled"
  | "unknown";

export interface EventVersionProvenance {
  readonly eventType: string;
  readonly schemaChecksum: string;
  readonly version: string;
}

export interface MetadataDeliveryAttemptInput {
  readonly attempt: number;
  readonly deliveryId: string;
  readonly durationMilliseconds?: number;
  readonly endpointId: string;
  readonly errorCode?: string;
  readonly eventId: string;
  readonly eventVersion: EventVersionProvenance;
  readonly kind: "delivery_attempt";
  readonly mappingVersion: MappingVersion;
  readonly nextAttemptAt?: string;
  readonly occurredAt: string;
  readonly providerAttemptId?: string;
  readonly providerRef?: ProviderNativeRef;
  readonly responseStatusCode?: number;
  readonly retryable?: boolean;
  readonly schemaVersion: typeof CANONICAL_METADATA_SCHEMA_VERSION;
  readonly sequence: number;
  readonly sourceDedupeKey?: string;
  readonly status: DeliveryAttemptStatus;
  readonly subscriptionId?: string;
  readonly traceId?: string;
}

export interface MetadataIdentity {
  readonly adapterId: string;
  readonly connectionId: string;
  readonly environment: string;
  readonly tenantId: string;
}

export interface CanonicalDeliveryAttemptMetadata
  extends MetadataDeliveryAttemptInput, MetadataIdentity {
  readonly dedupeKey: string;
}

export type CanonicalMetadataRecord = CanonicalDeliveryAttemptMetadata;

export const METADATA_DELIVERY_INPUT_FIELDS = [
  "attempt",
  "deliveryId",
  "durationMilliseconds",
  "endpointId",
  "errorCode",
  "eventId",
  "eventVersion",
  "kind",
  "mappingVersion",
  "nextAttemptAt",
  "occurredAt",
  "providerAttemptId",
  "providerRef",
  "responseStatusCode",
  "retryable",
  "schemaVersion",
  "sequence",
  "sourceDedupeKey",
  "status",
  "subscriptionId",
  "traceId",
] as const;

export const CANONICAL_METADATA_FIELDS = [
  ...METADATA_DELIVERY_INPUT_FIELDS,
  "adapterId",
  "connectionId",
  "dedupeKey",
  "environment",
  "tenantId",
] as const;

export type CanonicalMetadataField = (typeof CANONICAL_METADATA_FIELDS)[number];

export interface MetadataValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type MetadataInputValidationResult =
  | {
      readonly ok: true;
      readonly value: MetadataDeliveryAttemptInput;
    }
  | {
      readonly issues: readonly MetadataValidationIssue[];
      readonly ok: false;
    };

export type MetadataValidationResult =
  | {
      readonly ok: true;
      readonly value: CanonicalMetadataRecord;
    }
  | {
      readonly issues: readonly MetadataValidationIssue[];
      readonly ok: false;
    };

const inputFields = new Set<string>(METADATA_DELIVERY_INPUT_FIELDS);
const canonicalFields = new Set<string>(CANONICAL_METADATA_FIELDS);
const statuses = new Set<DeliveryAttemptStatus>([
  "attempting",
  "cancelled",
  "delivered",
  "exhausted",
  "failed",
  "pending",
  "retry_scheduled",
  "unknown",
]);
const mappingFields = new Set(["name", "schemaVersion", "version"]);
const providerFields = new Set([
  "accountId",
  "etag",
  "id",
  "provider",
  "region",
  "resourceType",
]);
const eventVersionFields = new Set(["eventType", "schemaChecksum", "version"]);
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const dateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) =>
      descriptor.enumerable === true &&
      "value" in descriptor &&
      descriptor.get === undefined &&
      descriptor.set === undefined,
  );
}

function onlyKeys(value: unknown, allowed: ReadonlySet<string>): boolean {
  return (
    isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function validString(value: unknown, maximum = 2_048): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    isWellFormedUnicode(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    isWellFormedUnicode(value) &&
    dateTimePattern.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function issue(
  issues: MetadataValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push(Object.freeze({ code, path, message }));
}

function validateInputObject(
  value: unknown,
  allowedFields: ReadonlySet<string>,
): {
  readonly issues: MetadataValidationIssue[];
  readonly value?: Readonly<Record<string, unknown>>;
} {
  const issues: MetadataValidationIssue[] = [];
  if (!isPlainObject(value)) {
    issue(
      issues,
      "metadata.invalid_type",
      "$",
      "Metadata must be a plain data object.",
    );
    return { issues };
  }
  for (const key of Object.keys(value)) {
    if (!isWellFormedUnicode(key)) {
      issue(
        issues,
        "metadata.malformed_unicode",
        "$",
        "Metadata contains an object key with an unpaired surrogate.",
      );
    } else if (!allowedFields.has(key)) {
      issue(
        issues,
        "metadata.field_not_allowed",
        `$.${key}`,
        `Metadata field "${key}" is not allowed.`,
      );
    }
  }
  return { issues, value };
}

function validateDeliveryFields(
  value: Readonly<Record<string, unknown>>,
  issues: MetadataValidationIssue[],
): void {
  if (value["kind"] !== "delivery_attempt") {
    issue(
      issues,
      "metadata.invalid_kind",
      "$.kind",
      "Metadata kind must be delivery_attempt.",
    );
  }
  if (value["schemaVersion"] !== CANONICAL_METADATA_SCHEMA_VERSION) {
    issue(
      issues,
      "metadata.invalid_schema_version",
      "$.schemaVersion",
      "The metadata schema version is unsupported.",
    );
  }
  for (const field of ["deliveryId", "endpointId", "eventId"] as const) {
    if (!validString(value[field])) {
      issue(
        issues,
        "metadata.invalid_string",
        `$.${field}`,
        `${field} must be a non-empty safe string.`,
      );
    }
  }
  for (const field of [
    "errorCode",
    "providerAttemptId",
    "sourceDedupeKey",
    "subscriptionId",
    "traceId",
  ] as const) {
    if (value[field] !== undefined && !validString(value[field])) {
      issue(
        issues,
        "metadata.invalid_string",
        `$.${field}`,
        `${field} must be a safe scalar string when present.`,
      );
    }
  }
  for (const field of ["attempt", "sequence"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      issue(
        issues,
        "metadata.invalid_integer",
        `$.${field}`,
        `${field} must be a non-negative safe integer.`,
      );
    }
  }
  if (
    typeof value["status"] !== "string" ||
    !statuses.has(value["status"] as DeliveryAttemptStatus)
  ) {
    issue(
      issues,
      "metadata.invalid_status",
      "$.status",
      "The delivery status is invalid.",
    );
  }
  if (!validDateTime(value["occurredAt"])) {
    issue(
      issues,
      "metadata.invalid_date",
      "$.occurredAt",
      "occurredAt must be an RFC 3339 date-time.",
    );
  }
  if (
    value["nextAttemptAt"] !== undefined &&
    !validDateTime(value["nextAttemptAt"])
  ) {
    issue(
      issues,
      "metadata.invalid_date",
      "$.nextAttemptAt",
      "nextAttemptAt must be an RFC 3339 date-time.",
    );
  }
  if (
    value["responseStatusCode"] !== undefined &&
    (!Number.isSafeInteger(value["responseStatusCode"]) ||
      (value["responseStatusCode"] as number) < 100 ||
      (value["responseStatusCode"] as number) > 599)
  ) {
    issue(
      issues,
      "metadata.invalid_status_code",
      "$.responseStatusCode",
      "responseStatusCode must be an HTTP status code.",
    );
  }
  if (
    value["durationMilliseconds"] !== undefined &&
    (typeof value["durationMilliseconds"] !== "number" ||
      !Number.isFinite(value["durationMilliseconds"]) ||
      value["durationMilliseconds"] < 0)
  ) {
    issue(
      issues,
      "metadata.invalid_duration",
      "$.durationMilliseconds",
      "durationMilliseconds must be finite and non-negative.",
    );
  }
  if (
    value["retryable"] !== undefined &&
    typeof value["retryable"] !== "boolean"
  ) {
    issue(
      issues,
      "metadata.invalid_boolean",
      "$.retryable",
      "retryable must be boolean.",
    );
  }
  if (
    !isMappingVersion(value["mappingVersion"]) ||
    !onlyKeys(value["mappingVersion"], mappingFields) ||
    !isPlainObject(value["mappingVersion"]) ||
    !validString(value["mappingVersion"]["schemaVersion"])
  ) {
    issue(
      issues,
      "metadata.invalid_mapping_version",
      "$.mappingVersion",
      "A closed adapter mapping name, version, and schemaVersion are required.",
    );
  }
  if (
    value["providerRef"] !== undefined &&
    (!isProviderNativeRef(value["providerRef"]) ||
      !onlyKeys(value["providerRef"], providerFields))
  ) {
    issue(
      issues,
      "metadata.invalid_provider_ref",
      "$.providerRef",
      "providerRef must use the closed provider reference schema.",
    );
  }
  if (
    !onlyKeys(value["eventVersion"], eventVersionFields) ||
    !isPlainObject(value["eventVersion"]) ||
    !validString(value["eventVersion"]["eventType"]) ||
    !validString(value["eventVersion"]["version"]) ||
    typeof value["eventVersion"]["schemaChecksum"] !== "string" ||
    !sha256Pattern.test(value["eventVersion"]["schemaChecksum"])
  ) {
    issue(
      issues,
      "metadata.invalid_event_version",
      "$.eventVersion",
      "Event type, version, and schema checksum provenance are required.",
    );
  }
}

export function validateMetadataDeliveryAttemptInput(
  value: unknown,
): MetadataInputValidationResult {
  const validation = validateInputObject(value, inputFields);
  if (validation.value !== undefined) {
    validateDeliveryFields(validation.value, validation.issues);
  }
  return validation.issues.length === 0
    ? Object.freeze({
        ok: true,
        value: validation.value as unknown as MetadataDeliveryAttemptInput,
      })
    : Object.freeze({
        ok: false,
        issues: Object.freeze(validation.issues),
      });
}

function validateIdentity(
  value: Readonly<Record<string, unknown>>,
  issues: MetadataValidationIssue[],
): void {
  for (const field of [
    "adapterId",
    "connectionId",
    "environment",
    "tenantId",
  ] as const) {
    if (!validString(value[field])) {
      issue(
        issues,
        "metadata.invalid_identity",
        `$.${field}`,
        `${field} must be a non-empty authenticated identity string.`,
      );
    }
  }
}

function stableJson(value: AdapterJsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${stableJson(item as AdapterJsonValue)}`,
      )
      .join(",")}}`;
  }
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
  }
  return JSON.stringify(value);
}

function jsonValue(value: unknown): AdapterJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (typeof value === "string") {
      assertWellFormedUnicode(value);
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonValue(entry));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => {
          assertWellFormedUnicode(key, "Metadata object key");
          if (unsafeKeys.has(key)) {
            throw new TypeError("Metadata contains an unsafe object key.");
          }
          return [key, jsonValue(entry)];
        }),
    );
  }
  throw new TypeError("Metadata must be JSON-compatible.");
}

function dedupeKeyFor(
  input: MetadataDeliveryAttemptInput,
  identity: MetadataIdentity,
): string {
  const material = jsonValue({
    adapterId: identity.adapterId,
    connectionId: identity.connectionId,
    tenantId: identity.tenantId,
    environment: identity.environment,
    deliveryId: input.deliveryId,
    endpointId: input.endpointId,
    eventId: input.eventId,
    eventType: input.eventVersion.eventType,
    eventVersion: input.eventVersion.version,
    eventSchemaChecksum: input.eventVersion.schemaChecksum,
    mappingName: input.mappingVersion.name,
    mappingVersion: input.mappingVersion.version,
    mappingSchemaVersion: input.mappingVersion.schemaVersion ?? "",
    attempt: input.attempt,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    status: input.status,
    responseStatusCode: input.responseStatusCode,
    durationMilliseconds: input.durationMilliseconds,
    errorCode: input.errorCode,
    retryable: input.retryable,
    nextAttemptAt: input.nextAttemptAt,
    sourceDedupeKey: input.sourceDedupeKey,
    providerAttemptId: input.providerAttemptId,
  });
  return `whp:delivery-attempt:v3:${createHash("sha256")
    .update(stableJson(material), "utf8")
    .digest("hex")}`;
}

export function createDedupeKey(
  namespace: string,
  parts: Readonly<Record<string, boolean | number | string>>,
): string {
  if (!validString(namespace, 128)) {
    throw new RangeError("A dedupe namespace must be a safe string.");
  }
  return `whp:${namespace}:v2:${createHash("sha256")
    .update(stableJson(jsonValue(parts)), "utf8")
    .digest("hex")}`;
}

export function canonicalizeMetadataRecord(
  input: unknown,
  identity: MetadataIdentity,
): CanonicalMetadataRecord {
  const validation = validateMetadataDeliveryAttemptInput(input);
  if (!validation.ok) {
    throw new TypeError(
      validation.issues
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; "),
    );
  }
  for (const [name, value] of Object.entries(identity)) {
    if (!validString(value)) {
      throw new RangeError(`Metadata identity ${name} is invalid.`);
    }
  }
  return Object.freeze({
    ...validation.value,
    ...identity,
    eventVersion: Object.freeze({ ...validation.value.eventVersion }),
    mappingVersion: Object.freeze({ ...validation.value.mappingVersion }),
    ...(validation.value.providerRef === undefined
      ? {}
      : { providerRef: Object.freeze({ ...validation.value.providerRef }) }),
    dedupeKey: dedupeKeyFor(validation.value, identity),
  });
}

export function validateCanonicalMetadataRecord(
  value: unknown,
): MetadataValidationResult {
  const validation = validateInputObject(value, canonicalFields);
  if (validation.value !== undefined) {
    validateDeliveryFields(validation.value, validation.issues);
    validateIdentity(validation.value, validation.issues);
    if (
      typeof validation.value["dedupeKey"] !== "string" ||
      !/^whp:delivery-attempt:v3:[a-f0-9]{64}$/u.test(
        validation.value["dedupeKey"],
      )
    ) {
      issue(
        validation.issues,
        "metadata.invalid_dedupe_key",
        "$.dedupeKey",
        "The canonical dedupe key is invalid.",
      );
    } else if (validation.issues.length === 0) {
      const record =
        validation.value as unknown as CanonicalDeliveryAttemptMetadata;
      if (dedupeKeyFor(record, record) !== validation.value["dedupeKey"]) {
        issue(
          validation.issues,
          "metadata.dedupe_identity_mismatch",
          "$.dedupeKey",
          "The dedupe key is not bound to the canonical identity.",
        );
      }
    }
  }
  return validation.issues.length === 0
    ? Object.freeze({
        ok: true,
        value: validation.value as unknown as CanonicalMetadataRecord,
      })
    : Object.freeze({
        ok: false,
        issues: Object.freeze(validation.issues),
      });
}

export function assertCanonicalMetadataRecord(
  value: unknown,
): asserts value is CanonicalMetadataRecord {
  const result = validateCanonicalMetadataRecord(value);
  if (!result.ok) {
    throw new TypeError(
      result.issues
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; "),
    );
  }
}

export function deliveryAttemptDedupeKey(
  record: CanonicalDeliveryAttemptMetadata,
): string {
  assertCanonicalMetadataRecord(record);
  return record.dedupeKey;
}

export const createDeliveryAttemptDedupeKey = deliveryAttemptDedupeKey;

export interface DeliveryAttemptReduction extends MetadataIdentity {
  readonly attempts: Readonly<Record<string, CanonicalDeliveryAttemptMetadata>>;
  readonly current: CanonicalDeliveryAttemptMetadata;
  readonly deliveryId: string;
  readonly highestAttempt: number;
  readonly seenDedupeKeys: readonly string[];
}

const terminalStatuses = new Set<DeliveryAttemptStatus>([
  "cancelled",
  "delivered",
  "exhausted",
]);
const statusRank: Readonly<Record<DeliveryAttemptStatus, number>> = {
  pending: 0,
  attempting: 1,
  unknown: 2,
  failed: 3,
  retry_scheduled: 4,
  cancelled: 5,
  exhausted: 5,
  delivered: 6,
};

function sameReductionIdentity(
  state: DeliveryAttemptReduction,
  incoming: CanonicalDeliveryAttemptMetadata,
): boolean {
  return (
    state.adapterId === incoming.adapterId &&
    state.connectionId === incoming.connectionId &&
    state.deliveryId === incoming.deliveryId &&
    state.environment === incoming.environment &&
    state.tenantId === incoming.tenantId &&
    state.current.endpointId === incoming.endpointId &&
    state.current.eventId === incoming.eventId &&
    state.current.eventVersion.eventType === incoming.eventVersion.eventType &&
    state.current.eventVersion.version === incoming.eventVersion.version &&
    state.current.eventVersion.schemaChecksum ===
      incoming.eventVersion.schemaChecksum &&
    state.current.mappingVersion.name === incoming.mappingVersion.name &&
    state.current.mappingVersion.version === incoming.mappingVersion.version &&
    state.current.mappingVersion.schemaVersion ===
      incoming.mappingVersion.schemaVersion
  );
}

function shouldReplaceAttempt(
  current: CanonicalDeliveryAttemptMetadata,
  incoming: CanonicalDeliveryAttemptMetadata,
): boolean {
  if (incoming.sequence < current.sequence) {
    return false;
  }
  if (incoming.sequence > current.sequence) {
    if (
      terminalStatuses.has(current.status) &&
      incoming.status !== current.status
    ) {
      return false;
    }
    return statusRank[incoming.status] >= statusRank[current.status];
  }
  if (statusRank[incoming.status] !== statusRank[current.status]) {
    return statusRank[incoming.status] > statusRank[current.status];
  }
  if (incoming.status !== current.status) {
    return false;
  }
  return Date.parse(incoming.occurredAt) > Date.parse(current.occurredAt);
}

export function reduceDeliveryAttempt(
  state: DeliveryAttemptReduction | undefined,
  incoming: CanonicalDeliveryAttemptMetadata,
): DeliveryAttemptReduction {
  assertCanonicalMetadataRecord(incoming);
  if (state !== undefined && !sameReductionIdentity(state, incoming)) {
    throw new RangeError(
      "A reducer cannot combine different tenant, environment, connection, adapter, or delivery identities.",
    );
  }
  if (state?.seenDedupeKeys.includes(incoming.dedupeKey) === true) {
    return state;
  }

  const attempts = { ...(state?.attempts ?? {}) };
  const attemptKey = String(incoming.attempt);
  const existing = attempts[attemptKey];
  if (existing === undefined || shouldReplaceAttempt(existing, incoming)) {
    attempts[attemptKey] = incoming;
  }
  const highestAttempt = Math.max(
    state?.highestAttempt ?? -1,
    incoming.attempt,
  );
  const current = attempts[String(highestAttempt)];
  if (current === undefined) {
    throw new Error("The metadata reduction is internally inconsistent.");
  }
  return Object.freeze({
    tenantId: incoming.tenantId,
    environment: incoming.environment,
    connectionId: incoming.connectionId,
    adapterId: incoming.adapterId,
    deliveryId: incoming.deliveryId,
    highestAttempt,
    current,
    attempts: Object.freeze(attempts),
    seenDedupeKeys: Object.freeze([
      ...(state?.seenDedupeKeys ?? []),
      incoming.dedupeKey,
    ]),
  });
}

export const reduceDeliveryAttemptMetadata = reduceDeliveryAttempt;

export interface MetadataIngestEnvelopeContent extends MetadataIdentity {
  readonly batchFingerprint: string;
  readonly batchId: string;
  readonly credentialId: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly kind: "metadata_ingest";
  readonly records: readonly MetadataDeliveryAttemptInput[];
  readonly schemaVersion: typeof METADATA_INGEST_SCHEMA_VERSION;
}

export interface AuthenticatedMetadataIngestEnvelope extends MetadataIngestEnvelopeContent {
  readonly signature: {
    readonly algorithm: typeof METADATA_INGEST_SIGNATURE_ALGORITHM;
    readonly value: string;
  };
}

export interface MetadataIngestEnvelopeOptions {
  readonly expiresAt?: number;
  readonly issuedAt?: number;
  readonly maximumLifetimeMilliseconds?: number;
}

export type MetadataIngestVerificationResult =
  | {
      readonly envelope: AuthenticatedMetadataIngestEnvelope;
      readonly ok: true;
      readonly records: readonly CanonicalMetadataRecord[];
    }
  | {
      readonly code: string;
      readonly message: string;
      readonly ok: false;
    };

function metadataBatchFingerprint(
  content: Pick<
    MetadataIngestEnvelopeContent,
    | "adapterId"
    | "batchId"
    | "connectionId"
    | "environment"
    | "records"
    | "tenantId"
  >,
): string {
  return createHash("sha256")
    .update(
      stableJson(
        jsonValue({
          tenantId: content.tenantId,
          environment: content.environment,
          adapterId: content.adapterId,
          connectionId: content.connectionId,
          batchId: content.batchId,
          records: content.records,
        }),
      ),
      "utf8",
    )
    .digest("hex");
}

function metadataSigningContent(
  content: MetadataIngestEnvelopeContent,
): string {
  return stableJson(
    jsonValue({
      kind: content.kind,
      schemaVersion: content.schemaVersion,
      tenantId: content.tenantId,
      environment: content.environment,
      adapterId: content.adapterId,
      connectionId: content.connectionId,
      credentialId: content.credentialId,
      batchId: content.batchId,
      batchFingerprint: content.batchFingerprint,
      issuedAt: content.issuedAt,
      expiresAt: content.expiresAt,
      records: content.records,
    }),
  );
}

function metadataSignature(
  content: MetadataIngestEnvelopeContent,
  credential: ScopedCredential,
): string {
  return createHmac("sha256", revealSecret(credential.secret))
    .update(metadataSigningContent(content), "utf8")
    .digest("base64url");
}

export function createAuthenticatedMetadataIngestEnvelope(
  records: readonly MetadataDeliveryAttemptInput[],
  identity: MetadataIdentity,
  batchId: string,
  credential: ScopedCredential,
  options: MetadataIngestEnvelopeOptions = {},
): AuthenticatedMetadataIngestEnvelope {
  if (records.length === 0 || records.length > 1_000 || !validString(batchId)) {
    throw new RangeError("The metadata ingest batch is invalid.");
  }
  for (const [name, value] of Object.entries(identity)) {
    if (!validString(value)) {
      throw new RangeError(`Metadata ingest identity ${name} is invalid.`);
    }
  }
  const validated = records.map((record) => {
    const result = validateMetadataDeliveryAttemptInput(record);
    if (!result.ok) {
      throw new TypeError(
        result.issues
          .map((entry) => `${entry.path}: ${entry.message}`)
          .join("; "),
      );
    }
    return result.value;
  });
  const issuedAt = options.issuedAt ?? Date.now();
  const maximumLifetime = options.maximumLifetimeMilliseconds ?? 300_000;
  const expiresAt = options.expiresAt ?? issuedAt + 60_000;
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > maximumLifetime
  ) {
    throw new RangeError("The metadata ingest lifetime is invalid.");
  }
  const fingerprintInput = {
    ...identity,
    batchId,
    records: validated,
  };
  const content: MetadataIngestEnvelopeContent = {
    kind: "metadata_ingest",
    schemaVersion: METADATA_INGEST_SCHEMA_VERSION,
    ...identity,
    credentialId: credential.id,
    batchId,
    batchFingerprint: metadataBatchFingerprint(fingerprintInput),
    issuedAt,
    expiresAt,
    records: Object.freeze(validated),
  };
  return Object.freeze({
    ...content,
    signature: Object.freeze({
      algorithm: METADATA_INGEST_SIGNATURE_ALGORITHM,
      value: metadataSignature(content, credential),
    }),
  });
}

function ingestFailure(
  code: string,
  message: string,
): MetadataIngestVerificationResult {
  return Object.freeze({ ok: false, code, message });
}

export function verifyAuthenticatedMetadataIngestEnvelope(
  value: unknown,
  credential: ScopedCredential,
  expected: MetadataIdentity,
  options: {
    readonly maximumClockSkewMilliseconds?: number;
    readonly maximumLifetimeMilliseconds?: number;
    readonly now?: number;
  } = {},
): MetadataIngestVerificationResult {
  if (
    !isPlainObject(value) ||
    !onlyKeys(
      value,
      new Set([
        "adapterId",
        "batchFingerprint",
        "batchId",
        "connectionId",
        "credentialId",
        "environment",
        "expiresAt",
        "issuedAt",
        "kind",
        "records",
        "schemaVersion",
        "signature",
        "tenantId",
      ]),
    ) ||
    value["kind"] !== "metadata_ingest" ||
    value["schemaVersion"] !== METADATA_INGEST_SCHEMA_VERSION ||
    !validString(value["tenantId"]) ||
    !validString(value["environment"]) ||
    !validString(value["adapterId"]) ||
    !validString(value["connectionId"]) ||
    !validString(value["credentialId"]) ||
    !validString(value["batchId"]) ||
    typeof value["batchFingerprint"] !== "string" ||
    !sha256Pattern.test(value["batchFingerprint"]) ||
    !Number.isSafeInteger(value["issuedAt"]) ||
    !Number.isSafeInteger(value["expiresAt"]) ||
    !Array.isArray(value["records"]) ||
    value["records"].length === 0 ||
    value["records"].length > 1_000 ||
    !isPlainObject(value["signature"]) ||
    !onlyKeys(value["signature"], new Set(["algorithm", "value"])) ||
    value["signature"]["algorithm"] !== METADATA_INGEST_SIGNATURE_ALGORITHM ||
    typeof value["signature"]["value"] !== "string"
  ) {
    return ingestFailure(
      "metadata_ingest.invalid",
      "The metadata ingest envelope is invalid.",
    );
  }
  const recordResults = value["records"].map((record) =>
    validateMetadataDeliveryAttemptInput(record),
  );
  if (recordResults.some((result) => !result.ok)) {
    return ingestFailure(
      "metadata_ingest.invalid_record",
      "The metadata ingest envelope contains an invalid record.",
    );
  }
  const records = recordResults.map((result) => {
    if (!result.ok) {
      throw new Error("Unreachable invalid metadata result.");
    }
    return result.value;
  });
  const content: MetadataIngestEnvelopeContent = {
    kind: "metadata_ingest",
    schemaVersion: METADATA_INGEST_SCHEMA_VERSION,
    tenantId: value["tenantId"],
    environment: value["environment"],
    adapterId: value["adapterId"],
    connectionId: value["connectionId"],
    credentialId: value["credentialId"],
    batchId: value["batchId"],
    batchFingerprint: value["batchFingerprint"],
    issuedAt: value["issuedAt"] as number,
    expiresAt: value["expiresAt"] as number,
    records,
  };
  const fingerprint = metadataBatchFingerprint(content);
  if (fingerprint !== content.batchFingerprint) {
    return ingestFailure(
      "metadata_ingest.fingerprint_mismatch",
      "The metadata batch fingerprint is invalid.",
    );
  }
  if (content.credentialId !== credential.id) {
    return ingestFailure(
      "metadata_ingest.credential_mismatch",
      "The metadata credential is not accepted.",
    );
  }
  const expectedSignature = Buffer.from(
    metadataSignature(content, credential),
    "base64url",
  );
  const actualSignature = Buffer.from(
    value["signature"]["value"] as string,
    "base64url",
  );
  if (
    expectedSignature.byteLength !== actualSignature.byteLength ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return ingestFailure(
      "metadata_ingest.signature_invalid",
      "The metadata ingest signature is invalid.",
    );
  }
  const now = options.now ?? Date.now();
  const skew = options.maximumClockSkewMilliseconds ?? 30_000;
  const maximumLifetime = options.maximumLifetimeMilliseconds ?? 300_000;
  if (
    content.issuedAt > now + skew ||
    content.expiresAt <= now ||
    content.expiresAt <= content.issuedAt ||
    content.expiresAt - content.issuedAt > maximumLifetime
  ) {
    return ingestFailure(
      "metadata_ingest.expired",
      "The metadata ingest envelope is expired.",
    );
  }
  for (const field of [
    "tenantId",
    "environment",
    "adapterId",
    "connectionId",
  ] as const) {
    if (content[field] !== expected[field]) {
      const code =
        field === "adapterId"
          ? "adapter"
          : field === "connectionId"
            ? "connection"
            : field;
      return ingestFailure(
        `metadata_ingest.wrong_${code}`,
        `The metadata ingest ${field} is invalid.`,
      );
    }
  }
  const scope = checkCredentialScope(credential, {
    adapterId: expected.adapterId,
    connectionId: expected.connectionId,
    environment: expected.environment,
    purpose: "metadata.ingest",
    role: "metadata_ingest",
    tenantId: expected.tenantId,
    now,
  });
  if (!scope.ok) {
    return ingestFailure(
      `metadata_ingest.${scope.reason ?? "credential_scope_mismatch"}`,
      "The metadata credential is outside its authorized scope.",
    );
  }
  const canonical = records.map((record) =>
    canonicalizeMetadataRecord(record, expected),
  );
  return Object.freeze({
    ok: true,
    envelope: Object.freeze({
      ...content,
      records: Object.freeze(records),
      signature: Object.freeze({
        algorithm: METADATA_INGEST_SIGNATURE_ALGORITHM,
        value: value["signature"]["value"] as string,
      }),
    }),
    records: Object.freeze(canonical),
  });
}
