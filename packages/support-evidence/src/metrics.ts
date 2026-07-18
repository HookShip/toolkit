// SPDX-License-Identifier: Apache-2.0

import { EvidenceValidationError } from "./errors.js";
import {
  assertCanonicalTimestamp,
  createInspectionContext,
  deepFreeze,
  hasOwn,
  readRecord,
  required,
  timestampMilliseconds,
} from "./internal.js";
import type { ResolutionDuration } from "./types.js";

const timestampKeys = new Set(["openedAt", "resolvedAt"]);

export interface CaseResolutionTimestamps {
  readonly openedAt: string;
  readonly resolvedAt?: string;
}

export function computeResolutionDuration(
  input: CaseResolutionTimestamps | unknown,
): ResolutionDuration {
  const context = createInspectionContext();
  return readRecord(input, "$", timestampKeys, context, (record) => {
    const openedAt = assertCanonicalTimestamp(
      required(record, "openedAt", "$"),
      "$.openedAt",
    );
    if (!hasOwn(record, "resolvedAt")) {
      return deepFreeze({
        status: "unavailable",
        reason: "resolved-at-not-supplied",
        openedAt,
      });
    }
    const resolvedAt = assertCanonicalTimestamp(
      record["resolvedAt"],
      "$.resolvedAt",
    );
    const durationMs =
      timestampMilliseconds(resolvedAt) - timestampMilliseconds(openedAt);
    if (durationMs < 0) {
      throw new EvidenceValidationError(
        "INVALID_CASE_TIMESTAMPS",
        "Resolution time cannot precede opening time.",
        "$.resolvedAt",
      );
    }
    return deepFreeze({
      status: "available",
      openedAt,
      resolvedAt,
      durationMs,
    });
  });
}
