// SPDX-License-Identifier: Apache-2.0

/**
 * Locale-independent lexicographic ordering over UTF-16 code units.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Counts Unicode code points, matching JSON Schema string-length semantics.
 */
export function unicodeCodePointLength(value: string): number {
  let length = 0;
  const iterator = value[Symbol.iterator]();
  while (!iterator.next().done) {
    length += 1;
  }
  return length;
}
