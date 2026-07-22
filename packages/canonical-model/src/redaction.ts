// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency-free credential/secret-shape detection and textual redaction
 * shared across the toolkit (exposed as the `@webhook-portal/canonical-model/
 * redaction` subpath, deliberately kept out of the main model barrel).
 *
 * Detection is the *union* of every prior per-package heuristic, so
 * consolidating here can only strengthen — never weaken — what is caught. The
 * bypass/malicious corpus in `test/redaction.test.ts` pins both directions:
 * every known secret shape must match, and safe near-misses must not.
 */

export const REDACTED = "[REDACTED]" as const;

/**
 * Value shapes that indicate a literal credential. Anchored at the start (or,
 * for JWTs, the whole string) to avoid matching prose that merely mentions a
 * scheme.
 */
const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /^(?:basic|bearer)\s+\S+/iu,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /^(?:AKIA[0-9A-Z]{12,}|gh[pousr]_|sk_(?:live|test)_|whsec_|xox[baprs]-)/u,
  /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/u,
];

/** True when a string value looks like a literal credential/secret. */
export function looksLikeCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Shared vocabulary of credential-bearing field-name fragments. */
export const CREDENTIAL_KEYWORD_PATTERN =
  /(apikey|authorization|credential|password|privatekey|secret|token)/u;

/**
 * True when a field/key name looks credential-bearing. Separators (`-`, `_`,
 * `.`, whitespace) are stripped before matching so `api-key`, `API_KEY`, and
 * `apiKey` are all recognized. Callers with context-specific structural keys
 * (for example request `body`/`headers`) compose this with their own set.
 */
export function isCredentialFieldName(name: string): boolean {
  const normalized = name.replaceAll(/[-_.\s]/gu, "").toLowerCase();
  return CREDENTIAL_KEYWORD_PATTERN.test(normalized);
}

/**
 * Patterns for redacting inline credentials from free-form text (log lines,
 * error messages). The global flag is required for `String.prototype.replace`
 * to replace every occurrence.
 */
const REDACTION_PATTERNS: readonly RegExp[] = [
  /whsec_[A-Za-z0-9+/=]{16,}/gu,
  /\b(?:authorization|api[-_]?key|secret|token|password)\s*[:=]\s*["']?[^,\s"']+/giu,
];

/** Replaces inline credential-shaped substrings in {@link value} with `[REDACTED]`. */
export function redactText(value: string): string {
  return REDACTION_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED),
    value,
  );
}
