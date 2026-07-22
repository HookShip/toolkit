// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import { compareCodeUnits } from "./ordering.js";

/**
 * Single source of truth for RFC 8785-style canonical/deterministic JSON across
 * the toolkit. Every signature, checksum, and digest byte in the public cohort
 * is produced by this module so that reproducibility is guaranteed across
 * packages, Node.js versions, and locales.
 *
 * Exact edge semantics:
 *
 * - Key ordering: object keys are sorted ascending by UTF-16 code unit
 *   (locale-independent, matching {@link compareCodeUnits}).
 * - Strings/keys: rejected when they contain an unpaired UTF-16 surrogate;
 *   otherwise emitted via `JSON.stringify`, so escaping matches the ECMAScript
 *   well-formed `JSON.stringify` contract.
 * - Numbers: `-0` serializes to `0`; every other finite number uses
 *   `JSON.stringify`; `NaN` and `±Infinity` are rejected.
 * - `undefined`: rejected wherever it appears as a value (including array
 *   elements and object properties). Callers that intend to *drop* undefined
 *   object properties should use the lenient {@link stableJson} instead.
 * - Arrays: must be dense, standard-prototype arrays with only index data
 *   properties; sparse or exotic arrays are rejected.
 * - Objects: must expose enumerable data properties on `Object.prototype` (or a
 *   null prototype); accessors, symbol keys, proxies, buffers, and typed arrays
 *   are rejected. Prototype-polluting keys are rejected unless the caller opts
 *   in via {@link CanonicalJsonOptions.allowUnsafeKeys}.
 */

export type CanonicalJsonPrimitive = boolean | null | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };
export type CanonicalJsonInput =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonInput[]
  | { readonly [key: string]: CanonicalJsonInput | undefined };

/**
 * Stable identifiers for every canonical failure mode. Consumers map these onto
 * their own error taxonomies through {@link CanonicalJsonOptions.onError}.
 */
export type CanonicalJsonErrorKind =
  | "accessor-property"
  | "cyclic"
  | "custom-prototype"
  | "depth-limit"
  | "malformed-unicode"
  | "node-limit"
  | "non-finite-number"
  | "non-json-value"
  | "output-limit"
  | "prototype-key"
  | "sparse-array"
  | "symbol-key"
  | "unsafe-array"
  | "unsupported-object";

const DEFAULT_MESSAGES: Readonly<Record<CanonicalJsonErrorKind, string>> = {
  "accessor-property":
    "Canonical JSON objects must contain enumerable data properties.",
  cyclic: "Canonical JSON cannot contain cycles.",
  "custom-prototype": "Canonical JSON values must use a plain prototype.",
  "depth-limit": "Canonical JSON depth limit exceeded.",
  "malformed-unicode":
    "Canonical JSON contains an unpaired UTF-16 surrogate.",
  "node-limit": "Canonical JSON node limit exceeded.",
  "non-finite-number": "Canonical JSON cannot contain non-finite numbers.",
  "non-json-value": "Canonical JSON contains a non-JSON value.",
  "output-limit": "Canonical JSON output limit exceeded.",
  "prototype-key": "Canonical JSON cannot contain prototype-related keys.",
  "sparse-array": "Canonical JSON arrays cannot be sparse.",
  "symbol-key": "Canonical JSON cannot contain symbol keys.",
  "unsafe-array": "Canonical JSON arrays must be dense data arrays.",
  "unsupported-object": "Canonical JSON contains an unsupported object.",
};

export class CanonicalJsonError extends Error {
  readonly kind: CanonicalJsonErrorKind;
  readonly path: string;

  constructor(kind: CanonicalJsonErrorKind, path: string, message?: string) {
    super(message ?? DEFAULT_MESSAGES[kind]);
    this.name = "CanonicalJsonError";
    this.kind = kind;
    this.path = path;
  }
}

/**
 * Constructs the error thrown for a canonical failure. Returning a value (rather
 * than throwing) lets callers translate {@link CanonicalJsonErrorKind} into
 * their own domain errors without losing the default message or path.
 */
export type CanonicalJsonErrorFactory = (
  kind: CanonicalJsonErrorKind,
  path: string,
  defaultMessage: string,
) => Error;

export interface CanonicalJsonLimits {
  readonly maximumDepth?: number;
  readonly maximumNodes?: number;
  readonly maximumOutputBytes?: number;
}

export interface CanonicalJsonOptions {
  readonly limits?: CanonicalJsonLimits;
  /** Spaces of indentation for a pretty variant. Defaults to `0` (compact). */
  readonly indent?: number;
  /** Escape `<`, `>`, `&`, and the JS line separators for HTML embedding. */
  readonly htmlSafe?: boolean;
  /** Permit prototype-polluting keys (`__proto__`, `constructor`, ...). */
  readonly allowUnsafeKeys?: boolean;
  readonly onError?: CanonicalJsonErrorFactory;
}

const DEFAULT_LIMITS = Object.freeze({
  maximumDepth: 64,
  maximumNodes: 100_000,
  maximumOutputBytes: 8 * 1024 * 1024,
});

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

function normalizedLimits(
  limits: CanonicalJsonLimits | undefined,
): Required<CanonicalJsonLimits> {
  return {
    maximumDepth: limits?.maximumDepth ?? DEFAULT_LIMITS.maximumDepth,
    maximumNodes: limits?.maximumNodes ?? DEFAULT_LIMITS.maximumNodes,
    maximumOutputBytes:
      limits?.maximumOutputBytes ?? DEFAULT_LIMITS.maximumOutputBytes,
  };
}

function encodeString(value: string, htmlSafe: boolean): string {
  const encoded = JSON.stringify(value);
  if (!htmlSafe) {
    return encoded;
  }
  return encoded.replace(/[<>&\u2028\u2029]/gu, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });
}

/**
 * Serializes {@link value} to canonical JSON. The strict edge semantics are
 * documented at the top of this module.
 */
export function canonicalJson(
  value: CanonicalJsonInput,
  options: CanonicalJsonOptions = {},
): string {
  const limits = normalizedLimits(options.limits);
  const indent = options.indent ?? 0;
  const htmlSafe = options.htmlSafe ?? false;
  const allowUnsafeKeys = options.allowUnsafeKeys ?? false;
  const raise = (kind: CanonicalJsonErrorKind, path: string): Error => {
    const message = DEFAULT_MESSAGES[kind];
    return options.onError
      ? options.onError(kind, path, message)
      : new CanonicalJsonError(kind, path, message);
  };

  const active = new Set<object>();
  let nodes = 0;

  const encode = (candidate: unknown, path: string, depth: number): string => {
    nodes += 1;
    if (nodes > limits.maximumNodes) {
      throw raise("node-limit", path);
    }
    if (depth > limits.maximumDepth) {
      throw raise("depth-limit", path);
    }

    if (candidate === null || typeof candidate === "boolean") {
      return String(candidate);
    }
    if (typeof candidate === "string") {
      if (!isWellFormedUnicode(candidate)) {
        throw raise("malformed-unicode", path);
      }
      return encodeString(candidate, htmlSafe);
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw raise("non-finite-number", path);
      }
      return Object.is(candidate, -0) ? "0" : JSON.stringify(candidate);
    }
    if (candidate === undefined || typeof candidate !== "object") {
      throw raise("non-json-value", path);
    }
    if (
      utilTypes.isProxy(candidate) ||
      Buffer.isBuffer(candidate) ||
      candidate instanceof ArrayBuffer ||
      ArrayBuffer.isView(candidate)
    ) {
      throw raise("unsupported-object", path);
    }
    if (active.has(candidate)) {
      throw raise("cyclic", path);
    }

    active.add(candidate);
    try {
      return Array.isArray(candidate)
        ? encodeArray(candidate, path, depth)
        : encodeObject(candidate, path, depth);
    } finally {
      active.delete(candidate);
    }
  };

  const encodeArray = (
    candidate: readonly unknown[],
    path: string,
    depth: number,
  ): string => {
    if (Object.getPrototypeOf(candidate) !== Array.prototype) {
      throw raise("custom-prototype", path);
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw raise("symbol-key", path);
      }
      if (key === "length") {
        continue;
      }
      const descriptor = descriptors[key];
      if (
        !/^(?:0|[1-9]\d*)$/u.test(key) ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw raise("unsafe-array", path);
      }
    }
    const items: string[] = [];
    for (let index = 0; index < candidate.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) {
        throw raise("sparse-array", path);
      }
      items.push(encode(descriptor.value, `${path}[${index}]`, depth + 1));
    }
    if (items.length === 0) {
      return "[]";
    }
    if (indent === 0) {
      return `[${items.join(",")}]`;
    }
    const childIndent = " ".repeat(indent * (depth + 1));
    const closeIndent = " ".repeat(indent * depth);
    return `[\n${childIndent}${items.join(
      `,\n${childIndent}`,
    )}\n${closeIndent}]`;
  };

  const encodeObject = (
    candidate: object,
    path: string,
    depth: number,
  ): string => {
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw raise("custom-prototype", path);
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw raise("symbol-key", path);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw raise("accessor-property", `${path}.${key}`);
      }
      if (!allowUnsafeKeys && DANGEROUS_KEYS.has(key)) {
        throw raise("prototype-key", `${path}.${key}`);
      }
      if (!isWellFormedUnicode(key)) {
        throw raise("malformed-unicode", `${path}.${key}`);
      }
      keys.push(key);
    }
    keys.sort(compareCodeUnits);
    if (keys.length === 0) {
      return "{}";
    }
    const separator = indent === 0 ? ":" : ": ";
    const entries = keys.map((key) => {
      const encodedKey = encodeString(key, htmlSafe);
      const encodedValue = encode(
        (descriptors[key] as PropertyDescriptor).value,
        `${path}.${key}`,
        depth + 1,
      );
      return `${encodedKey}${separator}${encodedValue}`;
    });
    if (indent === 0) {
      return `{${entries.join(",")}}`;
    }
    const childIndent = " ".repeat(indent * (depth + 1));
    const closeIndent = " ".repeat(indent * depth);
    return `{\n${childIndent}${entries.join(
      `,\n${childIndent}`,
    )}\n${closeIndent}}`;
  };

  const output = encode(value, "$", 0);
  if (Buffer.byteLength(output, "utf8") > limits.maximumOutputBytes) {
    throw raise("output-limit", "$");
  }
  return output;
}

export function canonicalJsonBytes(
  value: CanonicalJsonInput,
  options: CanonicalJsonOptions = {},
): Uint8Array {
  return Buffer.from(canonicalJson(value, options), "utf8");
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Returns a `sha256:<hex>` prefixed digest of arbitrary bytes. */
export function sha256Digest(input: string | Uint8Array): string {
  return `sha256:${sha256Hex(input)}`;
}

/** Returns the `sha256:<hex>` digest of the canonical encoding of {@link value}. */
export function canonicalJsonDigest(
  value: CanonicalJsonInput,
  options: CanonicalJsonOptions = {},
): string {
  return sha256Digest(canonicalJsonBytes(value, options));
}

/** Constant-time equality for two `sha256:<hex>` (or arbitrary) digest strings. */
export function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

/**
 * Returns a structurally-cloned copy of {@link value} with object keys ordered
 * by UTF-16 code unit and `undefined` object properties dropped. This is the
 * lenient companion to {@link canonicalJson}: it mirrors the historical
 * `JSON.stringify(sortedRecursively)` behavior used for reproducible checksums
 * and never throws on `undefined` object properties or non-finite numbers.
 */
export function orderJsonKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => orderJsonKeys(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareCodeUnits)) {
      const item = source[key];
      if (item !== undefined) {
        result[key] = orderJsonKeys(item);
      }
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * Lenient deterministic serialization equivalent to
 * `JSON.stringify(orderedRecursively, null, indent)`. Retains historical
 * checksum bytes for consumers that predate strict {@link canonicalJson}: drops
 * `undefined` object properties and coerces non-finite numbers to `null`.
 */
export function stableJson(value: unknown, indent?: number): string {
  return JSON.stringify(orderJsonKeys(value), null, indent);
}
