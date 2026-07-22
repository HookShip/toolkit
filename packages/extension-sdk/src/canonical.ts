// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";

import {
  canonicalJson as coreCanonicalJson,
  isWellFormedUnicode,
  sha256Digest as coreSha256Digest,
  type CanonicalJsonErrorKind,
  type CanonicalJsonInput,
} from "@webhook-portal/canonical-model";

import { ExtensionValidationError } from "./errors.js";
import { inspectArray, inspectRecord } from "./validation.js";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CanonicalJsonLimits {
  readonly maximumDepth?: number;
  readonly maximumNodes?: number;
  readonly maximumOutputBytes?: number;
}

const DEFAULT_CANONICAL_LIMITS = Object.freeze({
  maximumDepth: 64,
  maximumNodes: 100_000,
  maximumOutputBytes: 8 * 1024 * 1024,
});

/**
 * Maps shared canonical failure kinds onto this package's stable error codes so
 * the public {@link ExtensionValidationError} contract is preserved while the
 * serialization itself lives in `@webhook-portal/canonical-model`.
 */
const EXTENSION_CANONICAL_CODE: Readonly<
  Record<CanonicalJsonErrorKind, string>
> = {
  "accessor-property": "NON_JSON_VALUE",
  cyclic: "CYCLIC_JSON",
  "custom-prototype": "NON_JSON_VALUE",
  "depth-limit": "CANONICAL_DEPTH_LIMIT",
  "malformed-unicode": "MALFORMED_UNICODE",
  "node-limit": "CANONICAL_NODE_LIMIT",
  "non-finite-number": "NON_FINITE_NUMBER",
  "non-json-value": "NON_JSON_VALUE",
  "output-limit": "CANONICAL_OUTPUT_LIMIT",
  "prototype-key": "NON_JSON_VALUE",
  "sparse-array": "NON_JSON_VALUE",
  "symbol-key": "NON_JSON_VALUE",
  "unsafe-array": "NON_JSON_VALUE",
  "unsupported-object": "NON_JSON_VALUE",
};

export { isWellFormedUnicode };

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
    throw new ExtensionValidationError(
      "MALFORMED_UNICODE",
      `${label} contains an unpaired UTF-16 surrogate.`,
      label,
    );
  }
}

export function canonicalJson(
  value: JsonValue,
  limits: CanonicalJsonLimits = {},
): string {
  return coreCanonicalJson(value as CanonicalJsonInput, {
    limits: {
      maximumDepth:
        limits.maximumDepth ?? DEFAULT_CANONICAL_LIMITS.maximumDepth,
      maximumNodes:
        limits.maximumNodes ?? DEFAULT_CANONICAL_LIMITS.maximumNodes,
      maximumOutputBytes:
        limits.maximumOutputBytes ??
        DEFAULT_CANONICAL_LIMITS.maximumOutputBytes,
    },
    // Canonicalization treats prototype-polluting names as inert string keys;
    // object construction elsewhere is what must reject them.
    allowUnsafeKeys: true,
    onError: (kind, path, message) =>
      new ExtensionValidationError(
        EXTENSION_CANONICAL_CODE[kind],
        message,
        path,
      ),
  });
}

export function canonicalJsonBytes(
  value: JsonValue,
  limits: CanonicalJsonLimits = {},
): Uint8Array {
  return Buffer.from(canonicalJson(value, limits), "utf8");
}

export function parseCanonicalJson(
  text: string,
  limits: CanonicalJsonLimits = {},
): JsonValue {
  assertWellFormedUnicode(text, "Canonical JSON");
  const maximumOutputBytes =
    limits.maximumOutputBytes ?? DEFAULT_CANONICAL_LIMITS.maximumOutputBytes;
  if (Buffer.byteLength(text, "utf8") > maximumOutputBytes) {
    throw new ExtensionValidationError(
      "CANONICAL_INPUT_LIMIT",
      "Canonical JSON input limit exceeded.",
      "$",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExtensionValidationError(
      "MALFORMED_JSON",
      "Canonical JSON is malformed.",
      "$",
    );
  }
  const canonical = canonicalJson(parsed as JsonValue, limits);
  if (canonical !== text) {
    throw new ExtensionValidationError(
      "NON_CANONICAL_JSON",
      "JSON input is not in canonical form.",
      "$",
    );
  }
  return parsed as JsonValue;
}

export function sha256Digest(value: string | Uint8Array): string {
  return coreSha256Digest(value);
}

export function canonicalJsonDigest(
  value: JsonValue,
  limits: CanonicalJsonLimits = {},
): string {
  return sha256Digest(canonicalJsonBytes(value, limits));
}

export function isSha256Digest(value: string): boolean {
  if (!value.startsWith("sha256:") || value.length !== 71) {
    return false;
  }
  for (let index = 7; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const hexadecimal =
      (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66);
    if (!hexadecimal) {
      return false;
    }
  }
  return true;
}

export function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function cloneJson<T extends JsonValue>(value: T): T {
  const clone = (candidate: JsonValue): JsonValue => {
    if (Array.isArray(candidate)) {
      return inspectArray(candidate, "JSON array", 100_000).map((item) =>
        clone(item as JsonValue),
      );
    }
    if (candidate !== null && typeof candidate === "object") {
      const result = Object.create(null) as Record<string, JsonValue>;
      const record = inspectRecord(candidate, "JSON object", {
        maximumEntries: 100_000,
        rejectDangerousKeys: false,
      });
      for (const key of Object.keys(record).sort(compareUtf16CodeUnits)) {
        result[key] = clone(record[key] as JsonValue);
      }
      return result;
    }
    return candidate;
  };
  canonicalJson(value);
  return clone(value) as T;
}

export class SecretReference {
  readonly id: string;

  constructor(id: string) {
    if (id.length === 0 || id.length > 256 || !isWellFormedUnicode(id)) {
      throw new ExtensionValidationError(
        "INVALID_SECRET_REFERENCE",
        "Secret reference ID is invalid.",
        "id",
      );
    }
    this.id = id;
    Object.freeze(this);
  }

  toJSON(): { readonly id: string; readonly type: "secret-reference" } {
    return { type: "secret-reference", id: this.id };
  }

  toString(): string {
    return `SecretReference(${this.id})`;
  }
}
