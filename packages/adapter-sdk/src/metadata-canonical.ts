// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  canonicalJson,
  type CanonicalJsonInput,
} from "@webhook-portal/canonical-model";
import { assertWellFormedUnicode } from "./canonical.js";
import type { AdapterJsonValue } from "./model.js";
import {
  canonicalFields,
  isPlainObject,
  issue,
  unsafeKeys,
  validString,
  validateDeliveryFields,
  validateIdentity,
  validateInputObject,
  validateMetadataDeliveryAttemptInput,
} from "./metadata-validation.js";
import type {
  CanonicalDeliveryAttemptMetadata,
  CanonicalMetadataRecord,
  DeliveryAttemptStatus,
  MetadataDeliveryAttemptInput,
  MetadataIdentity,
  MetadataValidationResult,
} from "./metadata-types.js";

export function stableJson(value: AdapterJsonValue): string {
  return canonicalJson(value as CanonicalJsonInput, {
    onError: (_kind, _path, message) => new TypeError(message),
  });
}

export function jsonValue(value: unknown): AdapterJsonValue {
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
