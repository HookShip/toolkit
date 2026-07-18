// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  UNSAFE_OBJECT_KEYS,
  compareCodeUnits,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type Sha256Checksum,
} from "@webhook-portal/canonical-model";

export { compareCodeUnits } from "@webhook-portal/canonical-model";

import type { ContractLimits } from "./api-types.js";

const unsafeKeys = new Set<string>(UNSAFE_OBJECT_KEYS);

export interface InspectionFailure {
  readonly code: string;
  readonly message: string;
  readonly pointer: string;
}

export interface InspectionResult {
  readonly bytes: number;
  readonly failure?: InspectionFailure;
  readonly nodes: number;
}

export interface SnapshotResult extends InspectionResult {
  readonly value?: JsonValue;
}

/**
 * Creates a descriptor-based immutable JSON snapshot while enforcing limits.
 * User objects and proxies are never retained in the returned value.
 */
export function snapshotJsonValue(
  value: unknown,
  limits: ContractLimits,
): SnapshotResult {
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  let failure: InspectionFailure | undefined;

  const fail = (code: string, message: string, pointer: string): undefined => {
    failure ??= { code, message, pointer };
    return undefined;
  };

  const visit = (
    candidate: unknown,
    depth: number,
    pointer: string,
  ): JsonValue | undefined => {
    nodes += 1;
    bytes += 1;
    if (bytes > limits.maxInputBytes) {
      return fail(
        "INPUT_SIZE_LIMIT_EXCEEDED",
        `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
        pointer,
      );
    }
    if (nodes > limits.maxNodes) {
      return fail(
        "NODE_LIMIT_EXCEEDED",
        `Input exceeds the ${limits.maxNodes} node limit`,
        pointer,
      );
    }
    if (depth > limits.maxDepth) {
      return fail(
        "DEPTH_LIMIT_EXCEEDED",
        `Input exceeds the ${limits.maxDepth} level depth limit`,
        pointer,
      );
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number"
    ) {
      bytes += typeof candidate === "number" ? 24 : 5;
      return typeof candidate !== "number" || Number.isFinite(candidate)
        ? candidate
        : fail("NON_FINITE_NUMBER", "JSON numbers must be finite", pointer);
    }
    if (typeof candidate === "string") {
      const stringBytes = Buffer.byteLength(candidate, "utf8");
      bytes += stringBytes;
      if (stringBytes > limits.maxStringBytes) {
        return fail(
          "STRING_LIMIT_EXCEEDED",
          `String exceeds the ${limits.maxStringBytes} byte limit`,
          pointer,
        );
      }
      return bytes <= limits.maxInputBytes
        ? candidate
        : fail(
            "INPUT_SIZE_LIMIT_EXCEEDED",
            `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
            pointer,
          );
    }
    if (typeof candidate !== "object") {
      return fail(
        "NON_JSON_VALUE",
        "Input contains a value that is not JSON-serializable",
        pointer,
      );
    }
    if (ancestors.has(candidate)) {
      return fail("CYCLIC_INPUT", "Input contains an object cycle", pointer);
    }

    ancestors.add(candidate);
    let snapshot: JsonValue | undefined;
    if (Array.isArray(candidate)) {
      const descriptors = Object.getOwnPropertyDescriptors(
        candidate,
      ) as unknown as Record<PropertyKey, PropertyDescriptor>;
      const lengthDescriptor = descriptors["length"];
      const length =
        lengthDescriptor !== undefined && "value" in lengthDescriptor
          ? lengthDescriptor.value
          : undefined;
      const keys = Reflect.ownKeys(descriptors);
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        snapshot = fail(
          "NON_JSON_ARRAY_PROPERTY",
          "Array length is invalid",
          pointer,
        );
      } else if (
        keys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
        )
      ) {
        snapshot = fail(
          "NON_JSON_ARRAY_PROPERTY",
          "JSON arrays cannot contain named or symbol properties",
          pointer,
        );
      } else if (length > limits.maxNodes - nodes) {
        snapshot = fail(
          "NODE_LIMIT_EXCEEDED",
          `Input exceeds the ${limits.maxNodes} node limit`,
          pointer,
        );
      } else {
        const array: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          const itemPointer = joinPointer(pointer, index);
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            snapshot =
              descriptor === undefined
                ? fail(
                    "SPARSE_ARRAY",
                    "Sparse arrays are not portable JSON values",
                    itemPointer,
                  )
                : fail(
                    "ACCESSOR_PROPERTY_DENIED",
                    "Accessor and non-enumerable properties are not accepted",
                    itemPointer,
                  );
            break;
          }
          const item = visit(descriptor.value, depth + 1, itemPointer);
          if (item === undefined) {
            snapshot = undefined;
            break;
          }
          array.push(item);
        }
        if (failure === undefined) snapshot = Object.freeze(array);
      }
    } else if (isJsonObject(candidate)) {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) {
        snapshot = fail(
          "SYMBOL_PROPERTY_DENIED",
          "Symbol properties are not JSON-serializable",
          pointer,
        );
      } else if (keys.length > limits.maxPropertiesPerObject) {
        snapshot = fail(
          "PROPERTY_LIMIT_EXCEEDED",
          `Object exceeds the ${limits.maxPropertiesPerObject} property limit`,
          pointer,
        );
      } else {
        const object: Record<string, JsonValue> = {};
        for (const key of keys as string[]) {
          const descriptor = descriptors[key];
          const itemPointer = joinPointer(pointer, key);
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            snapshot = fail(
              "ACCESSOR_PROPERTY_DENIED",
              "Accessor and non-enumerable properties are not accepted",
              itemPointer,
            );
            break;
          }
          bytes += Buffer.byteLength(key, "utf8") + 3;
          if (bytes > limits.maxInputBytes) {
            snapshot = fail(
              "INPUT_SIZE_LIMIT_EXCEEDED",
              `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
              itemPointer,
            );
            break;
          }
          if (unsafeKeys.has(key)) {
            snapshot = fail(
              "UNSAFE_OBJECT_KEY",
              `Object key "${key}" is not permitted`,
              itemPointer,
            );
            break;
          }
          const item = visit(descriptor.value, depth + 1, itemPointer);
          if (item === undefined) {
            snapshot = undefined;
            break;
          }
          Object.defineProperty(object, key, {
            configurable: false,
            enumerable: true,
            value: item,
            writable: false,
          });
        }
        if (failure === undefined) snapshot = Object.freeze(object);
      }
    } else {
      snapshot = fail(
        "NON_PLAIN_OBJECT",
        "Only plain JSON objects are accepted",
        pointer,
      );
    }
    ancestors.delete(candidate);
    return snapshot;
  };

  const snapshot = visit(value, 0, "");
  return failure === undefined && snapshot !== undefined
    ? { bytes, nodes, value: snapshot }
    : { bytes, ...(failure === undefined ? {} : { failure }), nodes };
}

export function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function joinPointer(pointer: string, token: string | number): string {
  return `${pointer}/${escapePointerToken(String(token))}`;
}

export function inspectJsonValue(
  value: unknown,
  limits: ContractLimits,
): InspectionResult {
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  let failure: InspectionFailure | undefined;

  const fail = (code: string, message: string, pointer: string): false => {
    failure ??= { code, message, pointer };
    return false;
  };

  const visit = (
    candidate: unknown,
    depth: number,
    pointer: string,
  ): boolean => {
    nodes += 1;
    bytes += 1;
    if (bytes > limits.maxInputBytes) {
      return fail(
        "INPUT_SIZE_LIMIT_EXCEEDED",
        `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
        pointer,
      );
    }
    if (nodes > limits.maxNodes) {
      return fail(
        "NODE_LIMIT_EXCEEDED",
        `Input exceeds the ${limits.maxNodes} node limit`,
        pointer,
      );
    }
    if (depth > limits.maxDepth) {
      return fail(
        "DEPTH_LIMIT_EXCEEDED",
        `Input exceeds the ${limits.maxDepth} level depth limit`,
        pointer,
      );
    }

    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number"
    ) {
      bytes += typeof candidate === "number" ? 24 : 5;
      return (
        typeof candidate !== "number" ||
        Number.isFinite(candidate) ||
        fail("NON_FINITE_NUMBER", "JSON numbers must be finite", pointer)
      );
    }

    if (typeof candidate === "string") {
      const stringBytes = Buffer.byteLength(candidate, "utf8");
      bytes += stringBytes;
      return stringBytes > limits.maxStringBytes
        ? fail(
            "STRING_LIMIT_EXCEEDED",
            `String exceeds the ${limits.maxStringBytes} byte limit`,
            pointer,
          )
        : bytes <= limits.maxInputBytes ||
            fail(
              "INPUT_SIZE_LIMIT_EXCEEDED",
              `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
              pointer,
            );
    }

    if (typeof candidate !== "object") {
      return fail(
        "NON_JSON_VALUE",
        "Input contains a value that is not JSON-serializable",
        pointer,
      );
    }

    if (ancestors.has(candidate)) {
      return fail("CYCLIC_INPUT", "Input contains an object cycle", pointer);
    }

    ancestors.add(candidate);
    let valid = true;
    if (Array.isArray(candidate)) {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(descriptors);
      const invalidKey = keys.find(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
      );
      if (invalidKey !== undefined) {
        valid = fail(
          "NON_JSON_ARRAY_PROPERTY",
          "JSON arrays cannot contain named or symbol properties",
          pointer,
        );
      } else if (candidate.length > limits.maxNodes - nodes) {
        valid = fail(
          "NODE_LIMIT_EXCEEDED",
          `Input exceeds the ${limits.maxNodes} node limit`,
          pointer,
        );
      } else {
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = descriptors[String(index)];
          const itemPointer = joinPointer(pointer, index);
          if (descriptor === undefined) {
            valid = fail(
              "SPARSE_ARRAY",
              "Sparse arrays are not portable JSON values",
              itemPointer,
            );
            break;
          }
          if (!("value" in descriptor) || !descriptor.enumerable) {
            valid = fail(
              "ACCESSOR_PROPERTY_DENIED",
              "Accessor and non-enumerable properties are not accepted",
              itemPointer,
            );
            break;
          }
          if (!visit(descriptor.value, depth + 1, itemPointer)) {
            valid = false;
            break;
          }
        }
      }
    } else if (isJsonObject(candidate)) {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) {
        valid = fail(
          "SYMBOL_PROPERTY_DENIED",
          "Symbol properties are not JSON-serializable",
          pointer,
        );
      } else if (keys.length > limits.maxPropertiesPerObject) {
        valid = fail(
          "PROPERTY_LIMIT_EXCEEDED",
          `Object exceeds the ${limits.maxPropertiesPerObject} property limit`,
          pointer,
        );
      } else {
        for (const key of keys as string[]) {
          const descriptor = descriptors[key];
          const itemPointer = joinPointer(pointer, key);
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            valid = fail(
              "ACCESSOR_PROPERTY_DENIED",
              "Accessor and non-enumerable properties are not accepted",
              itemPointer,
            );
            break;
          }
          const item = descriptor.value;
          bytes += Buffer.byteLength(key, "utf8") + 3;
          if (bytes > limits.maxInputBytes) {
            valid = fail(
              "INPUT_SIZE_LIMIT_EXCEEDED",
              `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
              itemPointer,
            );
            break;
          }
          if (unsafeKeys.has(key)) {
            valid = fail(
              "UNSAFE_OBJECT_KEY",
              `Object key "${key}" is not permitted`,
              itemPointer,
            );
            break;
          }
          if (item === undefined || !visit(item, depth + 1, itemPointer)) {
            valid = false;
            break;
          }
        }
      }
    } else {
      valid = fail(
        "NON_PLAIN_OBJECT",
        "Only plain JSON objects are accepted",
        pointer,
      );
    }

    ancestors.delete(candidate);
    return valid;
  };

  visit(value, 0, "");
  return failure === undefined ? { bytes, nodes } : { bytes, failure, nodes };
}

export function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (isJsonObject(value)) {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const item = value[key];
      if (item !== undefined) {
        sorted[key] = sortJsonValue(item);
      }
    }
    return sorted;
  }

  return value;
}

export function stableStringify(value: JsonValue): string {
  return JSON.stringify(sortJsonValue(value));
}

export function sha256(value: string): Sha256Checksum {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

export function checksumJson(value: JsonValue): Sha256Checksum {
  return sha256(stableStringify(value));
}

export function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function collectExtensions(
  object: JsonObject,
  excluded: readonly string[] = [],
): JsonObject | undefined {
  const excludedKeys = new Set(excluded.map((key) => key.toLowerCase()));
  const extensions: Record<string, JsonValue> = {};
  for (const key of Object.keys(object).sort(compareCodeUnits)) {
    const value = object[key];
    if (
      key.toLowerCase().startsWith("x-") &&
      !excludedKeys.has(key.toLowerCase()) &&
      value !== undefined
    ) {
      extensions[key] = sortJsonValue(value);
    }
  }

  return Object.keys(extensions).length > 0 ? extensions : undefined;
}

export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return stableStringify(left) === stableStringify(right);
}
