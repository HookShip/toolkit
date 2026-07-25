// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "./canonical.js";
import { EvidenceValidationError } from "./errors.js";
import {
  assertCanonicalTimestamp,
  assertInteger,
  assertSafeToken,
  compareCodeUnits,
  hasOwn,
  readArray,
  readRecord,
  required,
  timestampMilliseconds,
  type InspectionContext,
} from "./internal.js";
import {
  RETRY_CATEGORIES,
  type EvidenceLimits,
  type EvidenceRecord,
  type RetryCategory,
} from "./types.js";

const recordKeys = new Set([
  "recordType",
  "sourceId",
  "occurredAt",
  "ingestedAt",
  "eventType",
  "eventVersion",
  "providerEventRef",
  "providerAttemptRef",
  "endpointId",
  "status",
  "responseCode",
  "latencyMs",
  "retryCategory",
  "traceId",
  "correlationId",
]);

export type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export function validationError(
  code: string,
  message: string,
  path: string,
): never {
  throw new EvidenceValidationError(code, message, path);
}

function optionalToken(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  maximumBytes: number,
): string | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  return assertSafeToken(record[key], `${path}.${key}`, maximumBytes);
}

function parseRetryCategory(value: unknown, path: string): RetryCategory {
  if (
    typeof value !== "string" ||
    !RETRY_CATEGORIES.includes(value as RetryCategory)
  ) {
    validationError(
      "INVALID_RETRY_CATEGORY",
      "Retry category is invalid.",
      path,
    );
  }
  return value as RetryCategory;
}

function parseRecord(
  value: unknown,
  index: number,
  context: InspectionContext,
): EvidenceRecord {
  const path = `$.records[${index}]`;
  return readRecord(value, path, recordKeys, context, (record) => {
    const recordType = required(record, "recordType", path);
    if (recordType !== "event" && recordType !== "attempt") {
      validationError(
        "INVALID_RECORD_TYPE",
        "Evidence record type is invalid.",
        `${path}.recordType`,
      );
    }
    const result: Mutable<EvidenceRecord> = {
      recordType,
      sourceId: assertSafeToken(
        required(record, "sourceId", path),
        `${path}.sourceId`,
        128,
      ),
      occurredAt: assertCanonicalTimestamp(
        required(record, "occurredAt", path),
        `${path}.occurredAt`,
      ),
      ingestedAt: assertCanonicalTimestamp(
        required(record, "ingestedAt", path),
        `${path}.ingestedAt`,
      ),
    };
    if (
      timestampMilliseconds(result.ingestedAt) <
      timestampMilliseconds(result.occurredAt)
    ) {
      validationError(
        "INVALID_INGESTION_TIME",
        "Ingestion time cannot precede occurrence time.",
        `${path}.ingestedAt`,
      );
    }

    const eventType = optionalToken(record, "eventType", path, 128);
    const eventVersion = optionalToken(record, "eventVersion", path, 64);
    if (
      recordType === "event" &&
      (eventType === undefined || eventVersion === undefined)
    ) {
      validationError(
        "MISSING_EVENT_REFERENCE",
        "Event records require event type and version.",
        path,
      );
    }
    if ((eventType === undefined) !== (eventVersion === undefined)) {
      validationError(
        "INCOMPLETE_EVENT_REFERENCE",
        "Event type and version must be supplied together.",
        path,
      );
    }
    if (eventType !== undefined && eventVersion !== undefined) {
      result.eventType = eventType;
      result.eventVersion = eventVersion;
    }

    const providerEventRef = optionalToken(
      record,
      "providerEventRef",
      path,
      256,
    );
    if (providerEventRef !== undefined) {
      result.providerEventRef = providerEventRef;
    }
    const providerAttemptRef = optionalToken(
      record,
      "providerAttemptRef",
      path,
      256,
    );
    if (providerAttemptRef !== undefined) {
      result.providerAttemptRef = providerAttemptRef;
    }
    const endpointId = optionalToken(record, "endpointId", path, 128);
    if (endpointId !== undefined) {
      result.endpointId = endpointId;
    }
    const status = optionalToken(record, "status", path, 64);
    if (status !== undefined) {
      result.status = status;
    }
    const traceId = optionalToken(record, "traceId", path, 128);
    if (traceId !== undefined) {
      result.traceId = traceId;
    }
    const correlationId = optionalToken(record, "correlationId", path, 128);
    if (correlationId !== undefined) {
      result.correlationId = correlationId;
    }

    if (recordType === "event") {
      for (const attemptOnlyField of [
        "providerAttemptRef",
        "responseCode",
        "latencyMs",
        "retryCategory",
      ]) {
        if (hasOwn(record, attemptOnlyField)) {
          validationError(
            "INVALID_EVENT_FIELD",
            "Event records cannot contain attempt-only metadata.",
            path,
          );
        }
      }
    } else {
      if (providerAttemptRef === undefined || status === undefined) {
        validationError(
          "MISSING_ATTEMPT_METADATA",
          "Attempt records require provider attempt reference and status.",
          path,
        );
      }
      if (hasOwn(record, "responseCode")) {
        result.responseCode = assertInteger(
          record["responseCode"],
          `${path}.responseCode`,
          100,
          599,
        );
      }
      if (hasOwn(record, "latencyMs")) {
        result.latencyMs = assertInteger(
          record["latencyMs"],
          `${path}.latencyMs`,
          0,
          24 * 60 * 60 * 1_000,
        );
      }
      if (hasOwn(record, "retryCategory")) {
        result.retryCategory = parseRetryCategory(
          record["retryCategory"],
          `${path}.retryCategory`,
        );
      }
    }
    return result;
  });
}

export function parseRecords(
  value: unknown,
  limits: EvidenceLimits,
  context: InspectionContext,
): EvidenceRecord[] {
  return readArray(
    value,
    "$.records",
    limits.maximumRecords,
    context,
    (values) => {
      if (values.length === 0) {
        validationError(
          "EMPTY_EVIDENCE",
          "At least one evidence record is required.",
          "$.records",
        );
      }
      return values.map((entry, index) => parseRecord(entry, index, context));
    },
  );
}

export function recordComparator(
  left: EvidenceRecord,
  right: EvidenceRecord,
): number {
  for (const [leftValue, rightValue] of [
    [left.occurredAt, right.occurredAt],
    [left.ingestedAt, right.ingestedAt],
    [left.recordType, right.recordType],
    [left.sourceId, right.sourceId],
  ] as const) {
    const comparison = compareCodeUnits(leftValue, rightValue);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return compareCodeUnits(canonicalJson(left), canonicalJson(right));
}
