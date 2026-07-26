// SPDX-License-Identifier: Apache-2.0

import { isWellFormedUnicode } from "./canonical.js";
import { isMappingVersion, isProviderNativeRef } from "./model.js";
import {
  CANONICAL_METADATA_FIELDS,
  CANONICAL_METADATA_SCHEMA_VERSION,
  METADATA_DELIVERY_INPUT_FIELDS,
  type DeliveryAttemptStatus,
  type MetadataDeliveryAttemptInput,
  type MetadataInputValidationResult,
  type MetadataValidationIssue,
} from "./metadata-types.js";

const inputFields = new Set<string>(METADATA_DELIVERY_INPUT_FIELDS);
export const canonicalFields = new Set<string>(CANONICAL_METADATA_FIELDS);
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
export const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
export const sha256Pattern = /^[a-f0-9]{64}$/u;
const dateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export function isPlainObject(
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

export function onlyKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
): boolean {
  return (
    isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

export function validString(value: unknown, maximum = 2_048): value is string {
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

export function issue(
  issues: MetadataValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push(Object.freeze({ code, path, message }));
}

export function validateInputObject(
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

export function validateDeliveryFields(
  value: Readonly<Record<string, unknown>>,
  issues: MetadataValidationIssue[],
): void {
  validateDeliveryEnvelopeFields(value, issues);
  validateDeliveryStringFields(value, issues);
  validateDeliveryAttemptFields(value, issues);
  validateDeliveryTimingFields(value, issues);
  validateDeliveryHttpFields(value, issues);
  validateDeliveryProvenanceFields(value, issues);
}

function validateDeliveryEnvelopeFields(
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
}

function validateDeliveryStringFields(
  value: Readonly<Record<string, unknown>>,
  issues: MetadataValidationIssue[],
): void {
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
}

function validateDeliveryAttemptFields(
  value: Readonly<Record<string, unknown>>,
  issues: MetadataValidationIssue[],
): void {
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
}

function validateDeliveryTimingFields(
  value: Readonly<Record<string, unknown>>,
  issues: MetadataValidationIssue[],
): void {
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
}

function validateDeliveryHttpFields(
  value: Readonly<Record<string, unknown>>,
  issues: MetadataValidationIssue[],
): void {
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
}

function validateDeliveryProvenanceFields(
  value: Readonly<Record<string, unknown>>,
  issues: MetadataValidationIssue[],
): void {
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

export function validateIdentity(
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
