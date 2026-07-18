// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import { EvidenceValidationError } from "./errors.js";
import { assertWellFormedUnicode, compareCodeUnits } from "./internal.js";
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

interface EncodeOptions {
  readonly htmlSafe: boolean;
  readonly indentation: number;
  readonly limits: Required<CanonicalJsonOptions>;
}

const dangerousKeys = new Set(["__proto__", "constructor", "prototype"]);

function normalizedOptions(
  options: CanonicalJsonOptions,
): Required<CanonicalJsonOptions> {
  return {
    maximumDepth: options.maximumDepth ?? 32,
    maximumNodes: options.maximumNodes ?? 100_000,
    maximumOutputBytes:
      options.maximumOutputBytes ?? HARD_EVIDENCE_LIMITS.maximumBytes,
  };
}

function jsonString(value: string, htmlSafe: boolean): string {
  assertWellFormedUnicode(value, "$");
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
      case "\u2029":
        return "\\u2029";
      default:
        return character;
    }
  });
}

function encodeJson(value: unknown, options: EncodeOptions): string {
  const active = new Set<object>();
  let nodes = 0;

  const encode = (candidate: unknown, path: string, depth: number): string => {
    nodes += 1;
    if (nodes > options.limits.maximumNodes) {
      throw new EvidenceValidationError(
        "CANONICAL_NODE_LIMIT",
        "Canonical JSON node limit exceeded.",
        path,
      );
    }
    if (depth > options.limits.maximumDepth) {
      throw new EvidenceValidationError(
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
      return jsonString(candidate, options.htmlSafe);
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new EvidenceValidationError(
          "NON_FINITE_NUMBER",
          "Canonical JSON cannot contain non-finite numbers.",
          path,
        );
      }
      return Object.is(candidate, -0) ? "0" : JSON.stringify(candidate);
    }
    if (candidate === undefined || typeof candidate !== "object") {
      throw new EvidenceValidationError(
        "NON_JSON_VALUE",
        "Canonical JSON contains a non-JSON value.",
        path,
      );
    }
    if (
      utilTypes.isProxy(candidate) ||
      Buffer.isBuffer(candidate) ||
      candidate instanceof ArrayBuffer ||
      ArrayBuffer.isView(candidate)
    ) {
      throw new EvidenceValidationError(
        "NON_JSON_VALUE",
        "Canonical JSON contains an unsupported object.",
        path,
      );
    }
    if (active.has(candidate)) {
      throw new EvidenceValidationError(
        "CYCLIC_JSON",
        "Canonical JSON cannot contain cycles.",
        path,
      );
    }

    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new EvidenceValidationError(
            "CUSTOM_PROTOTYPE",
            "Canonical JSON arrays must use the standard prototype.",
            path,
          );
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        for (const key of Reflect.ownKeys(descriptors)) {
          if (typeof key !== "string") {
            throw new EvidenceValidationError(
              "SYMBOL_NOT_ALLOWED",
              "Canonical JSON cannot contain symbol keys.",
              path,
            );
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
            throw new EvidenceValidationError(
              "UNSAFE_ARRAY",
              "Canonical JSON arrays must be dense data arrays.",
              path,
            );
          }
        }
        const items: string[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor)) {
            throw new EvidenceValidationError(
              "SPARSE_ARRAY",
              "Canonical JSON arrays cannot be sparse.",
              path,
            );
          }
          items.push(encode(descriptor.value, `${path}[${index}]`, depth + 1));
        }
        if (items.length === 0) {
          return "[]";
        }
        if (options.indentation === 0) {
          return `[${items.join(",")}]`;
        }
        const childIndent = " ".repeat(options.indentation * (depth + 1));
        const currentIndent = " ".repeat(options.indentation * depth);
        return `[\n${childIndent}${items.join(
          `,\n${childIndent}`,
        )}\n${currentIndent}]`;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new EvidenceValidationError(
          "CUSTOM_PROTOTYPE",
          "Canonical JSON objects must use a plain prototype.",
          path,
        );
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys: string[] = [];
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") {
          throw new EvidenceValidationError(
            "SYMBOL_NOT_ALLOWED",
            "Canonical JSON cannot contain symbol keys.",
            path,
          );
        }
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new EvidenceValidationError(
            "ACCESSOR_NOT_ALLOWED",
            "Canonical JSON objects must contain enumerable data properties.",
            path,
          );
        }
        if (dangerousKeys.has(key)) {
          throw new EvidenceValidationError(
            "PROTOTYPE_KEY_NOT_ALLOWED",
            "Canonical JSON cannot contain prototype-related keys.",
            path,
          );
        }
        assertWellFormedUnicode(key, path);
        keys.push(key);
      }
      keys.sort(compareCodeUnits);
      if (keys.length === 0) {
        return "{}";
      }
      const entries = keys.map((key) => {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new EvidenceValidationError(
            "NON_JSON_VALUE",
            "Canonical JSON contains an invalid property.",
            path,
          );
        }
        const encodedKey = jsonString(key, options.htmlSafe);
        const separator = options.indentation === 0 ? ":" : ": ";
        return `${encodedKey}${separator}${encode(
          descriptor.value,
          `${path}.${key}`,
          depth + 1,
        )}`;
      });
      if (options.indentation === 0) {
        return `{${entries.join(",")}}`;
      }
      const childIndent = " ".repeat(options.indentation * (depth + 1));
      const currentIndent = " ".repeat(options.indentation * depth);
      return `{\n${childIndent}${entries.join(
        `,\n${childIndent}`,
      )}\n${currentIndent}}`;
    } finally {
      active.delete(candidate);
    }
  };

  const output = encode(value, "$", 0);
  if (Buffer.byteLength(output, "utf8") > options.limits.maximumOutputBytes) {
    throw new EvidenceValidationError(
      "CANONICAL_OUTPUT_LIMIT",
      "Canonical JSON output limit exceeded.",
      "$",
    );
  }
  return output;
}

export function canonicalJson(
  value: unknown,
  options: CanonicalJsonOptions = {},
): string {
  return encodeJson(value, {
    htmlSafe: false,
    indentation: 0,
    limits: normalizedOptions(options),
  });
}

export function stableJson(
  value: unknown,
  options: CanonicalJsonOptions = {},
): string {
  return encodeJson(value, {
    htmlSafe: true,
    indentation: 2,
    limits: normalizedOptions(options),
  });
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
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
