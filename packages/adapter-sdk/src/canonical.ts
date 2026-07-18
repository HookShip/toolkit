// SPDX-License-Identifier: Apache-2.0

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

/**
 * RFC 8785 requires Unicode strings to be well-formed. This deterministic
 * code-unit scan rejects lone surrogates instead of allowing UTF-8 encoders to
 * silently substitute U+FFFD.
 */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function assertWellFormedUnicode(
  value: string,
  label = "Canonical string",
): void {
  if (!isWellFormedUnicode(value)) {
    throw new TypeError(`${label} contains an unpaired UTF-16 surrogate.`);
  }
}
