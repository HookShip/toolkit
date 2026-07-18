// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";

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

export function compareUtf16CodeUnits(left: string, right: string): number {
  assertWellFormedUnicode(left);
  assertWellFormedUnicode(right);
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

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
    throw new ExtensionValidationError(
      "MALFORMED_UNICODE",
      `${label} contains an unpaired UTF-16 surrogate.`,
      label,
    );
  }
}

function normalizedLimits(limits: CanonicalJsonLimits) {
  return {
    maximumDepth: limits.maximumDepth ?? DEFAULT_CANONICAL_LIMITS.maximumDepth,
    maximumNodes: limits.maximumNodes ?? DEFAULT_CANONICAL_LIMITS.maximumNodes,
    maximumOutputBytes:
      limits.maximumOutputBytes ?? DEFAULT_CANONICAL_LIMITS.maximumOutputBytes,
  };
}

export function canonicalJson(
  value: JsonValue,
  limits: CanonicalJsonLimits = {},
): string {
  const bounded = normalizedLimits(limits);
  const active = new Set<object>();
  let nodes = 0;

  const encode = (candidate: unknown, path: string, depth: number): string => {
    nodes += 1;
    if (nodes > bounded.maximumNodes) {
      throw new ExtensionValidationError(
        "CANONICAL_NODE_LIMIT",
        "Canonical JSON node limit exceeded.",
        path,
      );
    }
    if (depth > bounded.maximumDepth) {
      throw new ExtensionValidationError(
        "CANONICAL_DEPTH_LIMIT",
        "Canonical JSON depth limit exceeded.",
        path,
      );
    }
    if (candidate === null || typeof candidate === "boolean") {
      return String(candidate);
    }
    if (typeof candidate === "string") {
      assertWellFormedUnicode(candidate, path);
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new ExtensionValidationError(
          "NON_FINITE_NUMBER",
          `${path} contains a non-finite number.`,
          path,
        );
      }
      if (Object.is(candidate, -0)) {
        return "0";
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== "object" || candidate === undefined) {
      throw new ExtensionValidationError(
        "NON_JSON_VALUE",
        `${path} is not a JSON value.`,
        path,
      );
    }
    if (active.has(candidate)) {
      throw new ExtensionValidationError(
        "CYCLIC_JSON",
        `${path} contains a cycle.`,
        path,
      );
    }
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const values = inspectArray(candidate, path, bounded.maximumNodes);
        return `[${values
          .map((item, index) => encode(item, `${path}[${index}]`, depth + 1))
          .join(",")}]`;
      }
      const record = inspectRecord(candidate, path, {
        maximumEntries: bounded.maximumNodes,
        rejectDangerousKeys: false,
      });
      const keys = Object.keys(record).sort(compareUtf16CodeUnits);
      return `{${keys
        .map((key) => {
          assertWellFormedUnicode(key, `${path} key`);
          return `${JSON.stringify(key)}:${encode(
            record[key],
            `${path}.${key}`,
            depth + 1,
          )}`;
        })
        .join(",")}}`;
    } finally {
      active.delete(candidate);
    }
  };

  const output = encode(value, "$", 0);
  if (Buffer.byteLength(output, "utf8") > bounded.maximumOutputBytes) {
    throw new ExtensionValidationError(
      "CANONICAL_OUTPUT_LIMIT",
      "Canonical JSON output limit exceeded.",
      "$",
    );
  }
  return output;
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
  const bounded = normalizedLimits(limits);
  if (Buffer.byteLength(text, "utf8") > bounded.maximumOutputBytes) {
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
  const canonical = canonicalJson(parsed as JsonValue, bounded);
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
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
