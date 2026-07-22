// SPDX-License-Identifier: Apache-2.0

import { stableJson } from "@webhook-portal/canonical-model";

/**
 * Lenient deterministic serialization used for human-readable assessment
 * rendering. Delegates to the shared canonical-model implementation so the
 * ordering and escaping stay byte-identical across the cohort.
 */
export function stableStringify(value: unknown, space?: number): string {
  return stableJson(value, space);
}
