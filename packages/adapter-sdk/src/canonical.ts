// SPDX-License-Identifier: Apache-2.0

import { isWellFormedUnicode } from "@webhook-portal/canonical-model";

export { isWellFormedUnicode };

/**
 * Locale-independent lexicographic ordering using ECMAScript UTF-16 code
 * units. Use this for every signed, hashed, or fingerprinted canonical form.
 */
export function compareUtf16CodeUnits(left: string, right: string): number {
  assertWellFormedUnicode(left);
  assertWellFormedUnicode(right);
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function assertWellFormedUnicode(
  value: string,
  label = "Canonical string",
): void {
  if (!isWellFormedUnicode(value)) {
    throw new TypeError(`${label} contains an unpaired UTF-16 surrogate.`);
  }
}
