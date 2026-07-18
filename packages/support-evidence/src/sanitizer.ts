// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "./canonical.js";
import { EvidenceValidationError } from "./errors.js";
import {
  assertCanonicalTimestamp,
  assertInteger,
  assertSafeToken,
  assertSha256Hex,
  compareCodeUnits,
  createInspectionContext,
  deepFreeze,
  hasOwn,
  readArray,
  readRecord,
  required,
  timestampMilliseconds,
  type InspectionContext,
} from "./internal.js";
import {
  DEFAULT_EVIDENCE_LIMITS,
  EVIDENCE_PURPOSES,
  HARD_EVIDENCE_LIMITS,
  REDACTION_POLICY_VERSION,
  RETRY_CATEGORIES,
  SUPPORT_EVIDENCE_FORMAT,
  SUPPORT_EVIDENCE_FORMAT_VERSION,
  type ContractReference,
  type EvidenceLimitOverrides,
  type EvidenceLimits,
  type EvidencePurpose,
  type EvidenceRecord,
  type EvidenceSelection,
  type EvidenceSnapshot,
  type EvidenceSource,
  type HashedTenantIdentifier,
  type OpaqueTenantIdentifier,
  type RetryCategory,
  type SanitizedEvidenceInput,
  type Sha256Checksum,
  type TenantIdentifier,
  type TenantScope,
} from "./types.js";

const inputKeys = new Set([
  "supportCaseId",
  "tenantScope",
  "selection",
  "records",
  "contractReferences",
  "sources",
  "createdAt",
  "expiresAt",
]);
const snapshotKeys = new Set([
  ...inputKeys,
  "format",
  "formatVersion",
  "recordCount",
  "redactionPolicyVersion",
  "limits",
]);
const limitKeys = new Set([
  "maximumRecords",
  "maximumBytes",
  "maximumTimeRangeMs",
  "maximumBundleLifetimeMs",
]);
const tenantScopeKeys = new Set(["tenantId", "environmentId", "projectId"]);
const identifierKeys = new Set(["kind", "algorithm", "value"]);
const selectionKeys = new Set(["from", "to", "purpose"]);
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
const checksumKeys = new Set(["algorithm", "value"]);
const contractReferenceKeys = new Set(["contractId", "version", "checksum"]);
const sourceKeys = new Set(["sourceId", "checksum", "recordCount"]);

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

function validationError(code: string, message: string, path: string): never {
  throw new EvidenceValidationError(code, message, path);
}

function parseLimits(
  value: unknown,
  requireEveryField: boolean,
): EvidenceLimits {
  if (value === undefined) {
    if (requireEveryField) {
      validationError(
        "MISSING_FIELD",
        "Evidence limits are required.",
        "$.limits",
      );
    }
    return DEFAULT_EVIDENCE_LIMITS;
  }
  const context = createInspectionContext();
  return readRecord(value, "$.limits", limitKeys, context, (record) => {
    if (
      requireEveryField &&
      [...limitKeys].some((key) => !hasOwn(record, key))
    ) {
      validationError(
        "MISSING_FIELD",
        "Every evidence limit is required.",
        "$.limits",
      );
    }
    const limits: EvidenceLimits = {
      maximumRecords: hasOwn(record, "maximumRecords")
        ? assertInteger(
            record["maximumRecords"],
            "$.limits.maximumRecords",
            1,
            HARD_EVIDENCE_LIMITS.maximumRecords,
          )
        : DEFAULT_EVIDENCE_LIMITS.maximumRecords,
      maximumBytes: hasOwn(record, "maximumBytes")
        ? assertInteger(
            record["maximumBytes"],
            "$.limits.maximumBytes",
            256,
            HARD_EVIDENCE_LIMITS.maximumBytes,
          )
        : DEFAULT_EVIDENCE_LIMITS.maximumBytes,
      maximumTimeRangeMs: hasOwn(record, "maximumTimeRangeMs")
        ? assertInteger(
            record["maximumTimeRangeMs"],
            "$.limits.maximumTimeRangeMs",
            1,
            HARD_EVIDENCE_LIMITS.maximumTimeRangeMs,
          )
        : DEFAULT_EVIDENCE_LIMITS.maximumTimeRangeMs,
      maximumBundleLifetimeMs: hasOwn(record, "maximumBundleLifetimeMs")
        ? assertInteger(
            record["maximumBundleLifetimeMs"],
            "$.limits.maximumBundleLifetimeMs",
            1,
            HARD_EVIDENCE_LIMITS.maximumBundleLifetimeMs,
          )
        : DEFAULT_EVIDENCE_LIMITS.maximumBundleLifetimeMs,
    };
    return deepFreeze(limits);
  });
}

export function resolveEvidenceLimits(
  overrides: EvidenceLimitOverrides = {},
): EvidenceLimits {
  return parseLimits(overrides, false);
}

function parseTenantIdentifier(
  value: unknown,
  path: string,
  context: InspectionContext,
): TenantIdentifier {
  return readRecord(value, path, identifierKeys, context, (record) => {
    const kind = required(record, "kind", path);
    if (kind === "opaque") {
      if (hasOwn(record, "algorithm")) {
        validationError(
          "UNKNOWN_FIELD",
          "Opaque identifiers cannot declare a hash algorithm.",
          path,
        );
      }
      const identifier: OpaqueTenantIdentifier = {
        kind,
        value: assertSafeToken(
          required(record, "value", path),
          `${path}.value`,
          128,
        ),
      };
      return identifier;
    }
    if (kind === "hashed") {
      if (required(record, "algorithm", path) !== "sha256") {
        validationError(
          "INVALID_HASH_ALGORITHM",
          "Only SHA-256 tenant identifiers are allowed.",
          `${path}.algorithm`,
        );
      }
      const identifier: HashedTenantIdentifier = {
        kind,
        algorithm: "sha256",
        value: assertSha256Hex(
          required(record, "value", path),
          `${path}.value`,
        ),
      };
      return identifier;
    }
    validationError(
      "INVALID_IDENTIFIER_KIND",
      "Tenant identifier kind is invalid.",
      `${path}.kind`,
    );
  });
}

function parseTenantScope(
  value: unknown,
  context: InspectionContext,
): TenantScope {
  return readRecord(
    value,
    "$.tenantScope",
    tenantScopeKeys,
    context,
    (record) => {
      const tenantScope: Mutable<TenantScope> = {
        tenantId: parseTenantIdentifier(
          required(record, "tenantId", "$.tenantScope"),
          "$.tenantScope.tenantId",
          context,
        ),
      };
      if (hasOwn(record, "environmentId")) {
        tenantScope.environmentId = parseTenantIdentifier(
          record["environmentId"],
          "$.tenantScope.environmentId",
          context,
        );
      }
      if (hasOwn(record, "projectId")) {
        tenantScope.projectId = parseTenantIdentifier(
          record["projectId"],
          "$.tenantScope.projectId",
          context,
        );
      }
      return tenantScope;
    },
  );
}

function parsePurpose(value: unknown): EvidencePurpose {
  if (
    typeof value !== "string" ||
    !EVIDENCE_PURPOSES.includes(value as EvidencePurpose)
  ) {
    validationError(
      "INVALID_PURPOSE",
      "Evidence purpose must be a supported neutral category.",
      "$.selection.purpose",
    );
  }
  return value as EvidencePurpose;
}

function parseSelection(
  value: unknown,
  limits: EvidenceLimits,
  context: InspectionContext,
): EvidenceSelection {
  return readRecord(value, "$.selection", selectionKeys, context, (record) => {
    const selection: EvidenceSelection = {
      from: assertCanonicalTimestamp(
        required(record, "from", "$.selection"),
        "$.selection.from",
      ),
      to: assertCanonicalTimestamp(
        required(record, "to", "$.selection"),
        "$.selection.to",
      ),
      purpose: parsePurpose(required(record, "purpose", "$.selection")),
    };
    const range =
      timestampMilliseconds(selection.to) -
      timestampMilliseconds(selection.from);
    if (range <= 0 || range > limits.maximumTimeRangeMs) {
      validationError(
        "TIME_RANGE_LIMIT",
        "Selected time range is outside the configured bounds.",
        "$.selection",
      );
    }
    return selection;
  });
}

function parseChecksum(
  value: unknown,
  path: string,
  context: InspectionContext,
): Sha256Checksum {
  return readRecord(value, path, checksumKeys, context, (record) => {
    if (required(record, "algorithm", path) !== "sha256") {
      validationError(
        "INVALID_CHECKSUM_ALGORITHM",
        "Only SHA-256 checksums are allowed.",
        `${path}.algorithm`,
      );
    }
    return {
      algorithm: "sha256",
      value: assertSha256Hex(required(record, "value", path), `${path}.value`),
    };
  });
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

function parseRecords(
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

function parseContractReferences(
  value: unknown,
  context: InspectionContext,
): ContractReference[] {
  return readArray(value, "$.contractReferences", 100, context, (values) => {
    if (values.length === 0) {
      validationError(
        "EMPTY_CONTRACT_REFERENCES",
        "At least one contract reference is required.",
        "$.contractReferences",
      );
    }
    return values.map((entry, index) => {
      const path = `$.contractReferences[${index}]`;
      return readRecord(
        entry,
        path,
        contractReferenceKeys,
        context,
        (record): ContractReference => ({
          contractId: assertSafeToken(
            required(record, "contractId", path),
            `${path}.contractId`,
            128,
          ),
          version: assertSafeToken(
            required(record, "version", path),
            `${path}.version`,
            64,
          ),
          checksum: parseChecksum(
            required(record, "checksum", path),
            `${path}.checksum`,
            context,
          ),
        }),
      );
    });
  });
}

function parseSources(
  value: unknown,
  limits: EvidenceLimits,
  context: InspectionContext,
): EvidenceSource[] {
  return readArray(value, "$.sources", 100, context, (values) => {
    if (values.length === 0) {
      validationError(
        "EMPTY_SOURCES",
        "At least one source reference is required.",
        "$.sources",
      );
    }
    return values.map((entry, index) => {
      const path = `$.sources[${index}]`;
      return readRecord(
        entry,
        path,
        sourceKeys,
        context,
        (record): EvidenceSource => ({
          sourceId: assertSafeToken(
            required(record, "sourceId", path),
            `${path}.sourceId`,
            128,
          ),
          checksum: parseChecksum(
            required(record, "checksum", path),
            `${path}.checksum`,
            context,
          ),
          recordCount: assertInteger(
            required(record, "recordCount", path),
            `${path}.recordCount`,
            1,
            limits.maximumRecords,
          ),
        }),
      );
    });
  });
}

function recordComparator(left: EvidenceRecord, right: EvidenceRecord): number {
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

function assertNoCanonicalDuplicates(
  values: readonly unknown[],
  path: string,
): void {
  let previous: string | undefined;
  for (const value of values) {
    const current = canonicalJson(value);
    if (current === previous) {
      validationError(
        "DUPLICATE_EVIDENCE",
        "Duplicate evidence entries are not allowed.",
        path,
      );
    }
    previous = current;
  }
}

export function sanitizeEvidenceInput(
  input: unknown,
  limitOverrides: EvidenceLimitOverrides = {},
): SanitizedEvidenceInput {
  const limits = resolveEvidenceLimits(limitOverrides);
  const context = createInspectionContext();
  return readRecord(input, "$", inputKeys, context, (record) => {
    const selection = parseSelection(
      required(record, "selection", "$"),
      limits,
      context,
    );
    const records = parseRecords(
      required(record, "records", "$"),
      limits,
      context,
    ).sort(recordComparator);
    const contractReferences = parseContractReferences(
      required(record, "contractReferences", "$"),
      context,
    ).sort((left, right) =>
      compareCodeUnits(canonicalJson(left), canonicalJson(right)),
    );
    const sources = parseSources(
      required(record, "sources", "$"),
      limits,
      context,
    ).sort((left, right) => compareCodeUnits(left.sourceId, right.sourceId));
    const createdAt = assertCanonicalTimestamp(
      required(record, "createdAt", "$"),
      "$.createdAt",
    );
    const expiresAt = assertCanonicalTimestamp(
      required(record, "expiresAt", "$"),
      "$.expiresAt",
    );

    const createdMilliseconds = timestampMilliseconds(createdAt);
    const expiresMilliseconds = timestampMilliseconds(expiresAt);
    const lifetime = expiresMilliseconds - createdMilliseconds;
    if (lifetime <= 0 || lifetime > limits.maximumBundleLifetimeMs) {
      validationError(
        "BUNDLE_LIFETIME_LIMIT",
        "Bundle lifetime is outside the configured bounds.",
        "$.expiresAt",
      );
    }
    if (createdMilliseconds < timestampMilliseconds(selection.to)) {
      validationError(
        "INVALID_CREATION_TIME",
        "Bundle creation time cannot precede the selected range.",
        "$.createdAt",
      );
    }

    const rangeStart = timestampMilliseconds(selection.from);
    const rangeEnd = timestampMilliseconds(selection.to);
    const actualSourceCounts = new Map<string, number>();
    for (const evidenceRecord of records) {
      const occurrence = timestampMilliseconds(evidenceRecord.occurredAt);
      const ingestion = timestampMilliseconds(evidenceRecord.ingestedAt);
      if (occurrence < rangeStart || occurrence > rangeEnd) {
        validationError(
          "RECORD_OUTSIDE_RANGE",
          "Evidence occurrence is outside the selected range.",
          "$.records",
        );
      }
      if (ingestion > createdMilliseconds) {
        validationError(
          "FUTURE_INGESTION_TIME",
          "Evidence ingestion cannot be after bundle creation.",
          "$.records",
        );
      }
      actualSourceCounts.set(
        evidenceRecord.sourceId,
        (actualSourceCounts.get(evidenceRecord.sourceId) ?? 0) + 1,
      );
    }

    const sourceIds = new Set<string>();
    for (const source of sources) {
      if (sourceIds.has(source.sourceId)) {
        validationError(
          "DUPLICATE_SOURCE",
          "Source identifiers must be unique.",
          "$.sources",
        );
      }
      sourceIds.add(source.sourceId);
      if (
        source.recordCount !== (actualSourceCounts.get(source.sourceId) ?? 0)
      ) {
        validationError(
          "SOURCE_COUNT_MISMATCH",
          "Source record count does not match selected evidence.",
          "$.sources",
        );
      }
    }
    for (const sourceId of actualSourceCounts.keys()) {
      if (!sourceIds.has(sourceId)) {
        validationError(
          "UNKNOWN_SOURCE",
          "Evidence record references an undeclared source.",
          "$.records",
        );
      }
    }

    assertNoCanonicalDuplicates(records, "$.records");
    assertNoCanonicalDuplicates(contractReferences, "$.contractReferences");

    const sanitized: SanitizedEvidenceInput = {
      supportCaseId: assertSafeToken(
        required(record, "supportCaseId", "$"),
        "$.supportCaseId",
        128,
      ),
      tenantScope: parseTenantScope(
        required(record, "tenantScope", "$"),
        context,
      ),
      selection,
      records,
      contractReferences,
      sources,
      createdAt,
      expiresAt,
      limits,
    };
    return deepFreeze(sanitized);
  });
}

export function createEvidenceSnapshot(
  sanitized: SanitizedEvidenceInput,
): EvidenceSnapshot {
  const snapshot: EvidenceSnapshot = {
    format: SUPPORT_EVIDENCE_FORMAT,
    formatVersion: SUPPORT_EVIDENCE_FORMAT_VERSION,
    supportCaseId: sanitized.supportCaseId,
    tenantScope: sanitized.tenantScope,
    selection: sanitized.selection,
    records: sanitized.records,
    recordCount: sanitized.records.length,
    contractReferences: sanitized.contractReferences,
    sources: sanitized.sources,
    redactionPolicyVersion: REDACTION_POLICY_VERSION,
    createdAt: sanitized.createdAt,
    expiresAt: sanitized.expiresAt,
    limits: sanitized.limits,
  };
  canonicalJson(snapshot, {
    maximumOutputBytes: sanitized.limits.maximumBytes,
  });
  return deepFreeze(snapshot);
}

export function validateEvidenceSnapshot(input: unknown): EvidenceSnapshot {
  const context = createInspectionContext();
  return readRecord(input, "$.snapshot", snapshotKeys, context, (record) => {
    if (
      required(record, "format", "$.snapshot") !== SUPPORT_EVIDENCE_FORMAT ||
      required(record, "formatVersion", "$.snapshot") !==
        SUPPORT_EVIDENCE_FORMAT_VERSION ||
      required(record, "redactionPolicyVersion", "$.snapshot") !==
        REDACTION_POLICY_VERSION
    ) {
      validationError(
        "UNSUPPORTED_SNAPSHOT",
        "Evidence snapshot format or policy version is unsupported.",
        "$.snapshot",
      );
    }
    const limits = parseLimits(required(record, "limits", "$.snapshot"), true);
    const rawInput = {
      supportCaseId: required(record, "supportCaseId", "$.snapshot"),
      tenantScope: required(record, "tenantScope", "$.snapshot"),
      selection: required(record, "selection", "$.snapshot"),
      records: required(record, "records", "$.snapshot"),
      contractReferences: required(record, "contractReferences", "$.snapshot"),
      sources: required(record, "sources", "$.snapshot"),
      createdAt: required(record, "createdAt", "$.snapshot"),
      expiresAt: required(record, "expiresAt", "$.snapshot"),
    };
    const expected = createEvidenceSnapshot(
      sanitizeEvidenceInput(rawInput, limits),
    );
    if (
      required(record, "recordCount", "$.snapshot") !== expected.recordCount ||
      canonicalJson(input) !== canonicalJson(expected)
    ) {
      validationError(
        "NON_CANONICAL_SNAPSHOT",
        "Evidence snapshot is not in canonical package form.",
        "$.snapshot",
      );
    }
    return expected;
  });
}
