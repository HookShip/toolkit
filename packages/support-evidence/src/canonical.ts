// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  canonicalJson as coreCanonicalJson,
  equalDigest as coreEqualDigest,
  type CanonicalJsonErrorKind,
  type CanonicalJsonInput,
  type CanonicalJsonOptions as CoreCanonicalJsonOptions,
} from "@webhook-portal/canonical-model";

import { EvidenceValidationError } from "./errors.js";
import { HARD_EVIDENCE_LIMITS, type Sha256Digest } from "./types.js";

export type CanonicalJsonPrimitive = boolean | null | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface CanonicalJsonOptions {
  readonly maximumDepth?: number;
  readonly maximumNodes?: number;
  readonly maximumOutputBytes?: number;
}

/**
 * Maps shared canonical failure kinds onto this package's fail-closed evidence
 * error codes so the public {@link EvidenceValidationError} contract is
 * preserved while the serializer itself lives in
 * `@webhook-portal/canonical-model`.
 */
const EVIDENCE_CANONICAL_CODE: Readonly<
  Record<CanonicalJsonErrorKind, string>
> = {
  "accessor-property": "ACCESSOR_NOT_ALLOWED",
  cyclic: "CYCLIC_JSON",
  "custom-prototype": "CUSTOM_PROTOTYPE",
  "depth-limit": "CANONICAL_DEPTH_LIMIT",
  "malformed-unicode": "MALFORMED_UNICODE",
  "node-limit": "CANONICAL_NODE_LIMIT",
  "non-finite-number": "NON_FINITE_NUMBER",
  "non-json-value": "NON_JSON_VALUE",
  "output-limit": "CANONICAL_OUTPUT_LIMIT",
  "prototype-key": "PROTOTYPE_KEY_NOT_ALLOWED",
  "sparse-array": "SPARSE_ARRAY",
  "symbol-key": "SYMBOL_NOT_ALLOWED",
  "unsafe-array": "UNSAFE_ARRAY",
  "unsupported-object": "NON_JSON_VALUE",
};

function coreOptions(
  options: CanonicalJsonOptions,
  extra: Pick<CoreCanonicalJsonOptions, "htmlSafe" | "indent">,
): CoreCanonicalJsonOptions {
  return {
    ...extra,
    limits: {
      maximumDepth: options.maximumDepth ?? 32,
      maximumNodes: options.maximumNodes ?? 100_000,
      maximumOutputBytes:
        options.maximumOutputBytes ?? HARD_EVIDENCE_LIMITS.maximumBytes,
    },
    onError: (kind, path, message) =>
      new EvidenceValidationError(EVIDENCE_CANONICAL_CODE[kind], message, path),
  };
}

export function canonicalJson(
  value: unknown,
  options: CanonicalJsonOptions = {},
): string {
  return coreCanonicalJson(
    value as CanonicalJsonInput,
    coreOptions(options, { htmlSafe: false, indent: 0 }),
  );
}

export function stableJson(
  value: unknown,
  options: CanonicalJsonOptions = {},
): string {
  return coreCanonicalJson(
    value as CanonicalJsonInput,
    coreOptions(options, { htmlSafe: true, indent: 2 }),
  );
}

export function canonicalSha256(
  value: unknown,
  options: CanonicalJsonOptions = {},
): Sha256Digest {
  const hexadecimal = createHash("sha256")
    .update(canonicalJson(value, options), "utf8")
    .digest("hex");
  return `sha256:${hexadecimal}`;
}

export function equalDigest(left: string, right: string): boolean {
  return coreEqualDigest(left, right);
}
