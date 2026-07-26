// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  UNSAFE_OBJECT_KEYS,
  compareCodeUnits,
  isJsonObject,
  orderJsonKeys,
  stableJson,
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

interface SnapshotVisitState {
  readonly ancestors: Set<object>;
  bytes: number;
  failure?: InspectionFailure;
  nodes: number;
}

interface InspectionVisitState {
  readonly ancestors: Set<object>;
  bytes: number;
  failure?: InspectionFailure;
  nodes: number;
}

function failSnapshot(
  state: SnapshotVisitState,
  code: string,
  message: string,
  pointer: string,
): undefined {
  state.failure ??= { code, message, pointer };
  return undefined;
}

function failInspection(
  state: InspectionVisitState,
  code: string,
  message: string,
  pointer: string,
): false {
  state.failure ??= { code, message, pointer };
  return false;
}

function snapshotArrayValue(
  candidate: readonly unknown[],
  pointer: string,
  depth: number,
  limits: ContractLimits,
  state: SnapshotVisitState,
): JsonValue | undefined {
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
    return failSnapshot(
      state,
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
    return failSnapshot(
      state,
      "NON_JSON_ARRAY_PROPERTY",
      "JSON arrays cannot contain named or symbol properties",
      pointer,
    );
  } else if (length > limits.maxNodes - state.nodes) {
    return failSnapshot(
      state,
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
        return descriptor === undefined
          ? failSnapshot(
              state,
              "SPARSE_ARRAY",
              "Sparse arrays are not portable JSON values",
              itemPointer,
            )
          : failSnapshot(
              state,
              "ACCESSOR_PROPERTY_DENIED",
              "Accessor and non-enumerable properties are not accepted",
              itemPointer,
            );
      }
      const item = snapshotVisit(
        descriptor.value,
        depth + 1,
        itemPointer,
        limits,
        state,
      );
      if (item === undefined) {
        return undefined;
      }
      array.push(item);
    }
    if (state.failure === undefined) return Object.freeze(array);
  }
  return undefined;
}

function snapshotObjectValue(
  candidate: object,
  pointer: string,
  depth: number,
  limits: ContractLimits,
  state: SnapshotVisitState,
): JsonValue | undefined {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return failSnapshot(
      state,
      "SYMBOL_PROPERTY_DENIED",
      "Symbol properties are not JSON-serializable",
      pointer,
    );
  } else if (keys.length > limits.maxPropertiesPerObject) {
    return failSnapshot(
      state,
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
        return failSnapshot(
          state,
          "ACCESSOR_PROPERTY_DENIED",
          "Accessor and non-enumerable properties are not accepted",
          itemPointer,
        );
      }
      state.bytes += Buffer.byteLength(key, "utf8") + 3;
      if (state.bytes > limits.maxInputBytes) {
        return failSnapshot(
          state,
          "INPUT_SIZE_LIMIT_EXCEEDED",
          `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
          itemPointer,
        );
      }
      if (unsafeKeys.has(key)) {
        return failSnapshot(
          state,
          "UNSAFE_OBJECT_KEY",
          `Object key "${key}" is not permitted`,
          itemPointer,
        );
      }
      const item = snapshotVisit(
        descriptor.value,
        depth + 1,
        itemPointer,
        limits,
        state,
      );
      if (item === undefined) {
        return undefined;
      }
      Object.defineProperty(object, key, {
        configurable: false,
        enumerable: true,
        value: item,
        writable: false,
      });
    }
    if (state.failure === undefined) return Object.freeze(object);
  }
  return undefined;
}

function snapshotVisit(
  candidate: unknown,
  depth: number,
  pointer: string,
  limits: ContractLimits,
  state: SnapshotVisitState,
): JsonValue | undefined {
  state.nodes += 1;
  state.bytes += 1;
  if (state.bytes > limits.maxInputBytes) {
    return failSnapshot(
      state,
      "INPUT_SIZE_LIMIT_EXCEEDED",
      `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
      pointer,
    );
  }
  if (state.nodes > limits.maxNodes) {
    return failSnapshot(
      state,
      "NODE_LIMIT_EXCEEDED",
      `Input exceeds the ${limits.maxNodes} node limit`,
      pointer,
    );
  }
  if (depth > limits.maxDepth) {
    return failSnapshot(
      state,
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
    state.bytes += typeof candidate === "number" ? 24 : 5;
    return typeof candidate !== "number" || Number.isFinite(candidate)
      ? candidate
      : failSnapshot(
          state,
          "NON_FINITE_NUMBER",
          "JSON numbers must be finite",
          pointer,
        );
  }
  if (typeof candidate === "string") {
    const stringBytes = Buffer.byteLength(candidate, "utf8");
    state.bytes += stringBytes;
    if (stringBytes > limits.maxStringBytes) {
      return failSnapshot(
        state,
        "STRING_LIMIT_EXCEEDED",
        `String exceeds the ${limits.maxStringBytes} byte limit`,
        pointer,
      );
    }
    return state.bytes <= limits.maxInputBytes
      ? candidate
      : failSnapshot(
          state,
          "INPUT_SIZE_LIMIT_EXCEEDED",
          `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
          pointer,
        );
  }
  if (typeof candidate !== "object") {
    return failSnapshot(
      state,
      "NON_JSON_VALUE",
      "Input contains a value that is not JSON-serializable",
      pointer,
    );
  }
  if (state.ancestors.has(candidate)) {
    return failSnapshot(
      state,
      "CYCLIC_INPUT",
      "Input contains an object cycle",
      pointer,
    );
  }

  state.ancestors.add(candidate);
  const snapshot = Array.isArray(candidate)
    ? snapshotArrayValue(candidate, pointer, depth, limits, state)
    : isJsonObject(candidate)
      ? snapshotObjectValue(candidate, pointer, depth, limits, state)
      : failSnapshot(
          state,
          "NON_PLAIN_OBJECT",
          "Only plain JSON objects are accepted",
          pointer,
        );
  state.ancestors.delete(candidate);
  return snapshot;
}

/**
 * Creates a descriptor-based immutable JSON snapshot while enforcing limits.
 * User objects and proxies are never retained in the returned value.
 */
export function snapshotJsonValue(
  value: unknown,
  limits: ContractLimits,
): SnapshotResult {
  const state: SnapshotVisitState = {
    ancestors: new Set<object>(),
    bytes: 0,
    nodes: 0,
  };
  const snapshot = snapshotVisit(value, 0, "", limits, state);
  return state.failure === undefined && snapshot !== undefined
    ? { bytes: state.bytes, nodes: state.nodes, value: snapshot }
    : {
        bytes: state.bytes,
        ...(state.failure === undefined ? {} : { failure: state.failure }),
        nodes: state.nodes,
      };
}

export function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function joinPointer(pointer: string, token: string | number): string {
  return `${pointer}/${escapePointerToken(String(token))}`;
}

function inspectArrayValue(
  candidate: readonly unknown[],
  pointer: string,
  depth: number,
  limits: ContractLimits,
  state: InspectionVisitState,
): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  const invalidKey = keys.find(
    (key) =>
      key !== "length" &&
      (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
  );
  if (invalidKey !== undefined) {
    return failInspection(
      state,
      "NON_JSON_ARRAY_PROPERTY",
      "JSON arrays cannot contain named or symbol properties",
      pointer,
    );
  } else if (candidate.length > limits.maxNodes - state.nodes) {
    return failInspection(
      state,
      "NODE_LIMIT_EXCEEDED",
      `Input exceeds the ${limits.maxNodes} node limit`,
      pointer,
    );
  } else {
    for (let index = 0; index < candidate.length; index += 1) {
      const descriptor = descriptors[String(index)];
      const itemPointer = joinPointer(pointer, index);
      if (descriptor === undefined) {
        return failInspection(
          state,
          "SPARSE_ARRAY",
          "Sparse arrays are not portable JSON values",
          itemPointer,
        );
      }
      if (!("value" in descriptor) || !descriptor.enumerable) {
        return failInspection(
          state,
          "ACCESSOR_PROPERTY_DENIED",
          "Accessor and non-enumerable properties are not accepted",
          itemPointer,
        );
      }
      if (
        !inspectVisit(descriptor.value, depth + 1, itemPointer, limits, state)
      ) {
        return false;
      }
    }
  }
  return true;
}

function inspectObjectValue(
  candidate: object,
  pointer: string,
  depth: number,
  limits: ContractLimits,
  state: InspectionVisitState,
): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return failInspection(
      state,
      "SYMBOL_PROPERTY_DENIED",
      "Symbol properties are not JSON-serializable",
      pointer,
    );
  } else if (keys.length > limits.maxPropertiesPerObject) {
    return failInspection(
      state,
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
        return failInspection(
          state,
          "ACCESSOR_PROPERTY_DENIED",
          "Accessor and non-enumerable properties are not accepted",
          itemPointer,
        );
      }
      const item = descriptor.value;
      state.bytes += Buffer.byteLength(key, "utf8") + 3;
      if (state.bytes > limits.maxInputBytes) {
        return failInspection(
          state,
          "INPUT_SIZE_LIMIT_EXCEEDED",
          `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
          itemPointer,
        );
      }
      if (unsafeKeys.has(key)) {
        return failInspection(
          state,
          "UNSAFE_OBJECT_KEY",
          `Object key "${key}" is not permitted`,
          itemPointer,
        );
      }
      if (
        item === undefined ||
        !inspectVisit(item, depth + 1, itemPointer, limits, state)
      ) {
        return false;
      }
    }
  }
  return true;
}

function inspectVisit(
  candidate: unknown,
  depth: number,
  pointer: string,
  limits: ContractLimits,
  state: InspectionVisitState,
): boolean {
  state.nodes += 1;
  state.bytes += 1;
  if (state.bytes > limits.maxInputBytes) {
    return failInspection(
      state,
      "INPUT_SIZE_LIMIT_EXCEEDED",
      `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
      pointer,
    );
  }
  if (state.nodes > limits.maxNodes) {
    return failInspection(
      state,
      "NODE_LIMIT_EXCEEDED",
      `Input exceeds the ${limits.maxNodes} node limit`,
      pointer,
    );
  }
  if (depth > limits.maxDepth) {
    return failInspection(
      state,
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
    state.bytes += typeof candidate === "number" ? 24 : 5;
    return (
      typeof candidate !== "number" ||
      Number.isFinite(candidate) ||
      failInspection(
        state,
        "NON_FINITE_NUMBER",
        "JSON numbers must be finite",
        pointer,
      )
    );
  }

  if (typeof candidate === "string") {
    const stringBytes = Buffer.byteLength(candidate, "utf8");
    state.bytes += stringBytes;
    return stringBytes > limits.maxStringBytes
      ? failInspection(
          state,
          "STRING_LIMIT_EXCEEDED",
          `String exceeds the ${limits.maxStringBytes} byte limit`,
          pointer,
        )
      : state.bytes <= limits.maxInputBytes ||
          failInspection(
            state,
            "INPUT_SIZE_LIMIT_EXCEEDED",
            `Expanded input exceeds the ${limits.maxInputBytes} byte limit`,
            pointer,
          );
  }

  if (typeof candidate !== "object") {
    return failInspection(
      state,
      "NON_JSON_VALUE",
      "Input contains a value that is not JSON-serializable",
      pointer,
    );
  }

  if (state.ancestors.has(candidate)) {
    return failInspection(
      state,
      "CYCLIC_INPUT",
      "Input contains an object cycle",
      pointer,
    );
  }

  state.ancestors.add(candidate);
  const valid = Array.isArray(candidate)
    ? inspectArrayValue(candidate, pointer, depth, limits, state)
    : isJsonObject(candidate)
      ? inspectObjectValue(candidate, pointer, depth, limits, state)
      : failInspection(
          state,
          "NON_PLAIN_OBJECT",
          "Only plain JSON objects are accepted",
          pointer,
        );

  state.ancestors.delete(candidate);
  return valid;
}

export function inspectJsonValue(
  value: unknown,
  limits: ContractLimits,
): InspectionResult {
  const state: InspectionVisitState = {
    ancestors: new Set<object>(),
    bytes: 0,
    nodes: 0,
  };
  inspectVisit(value, 0, "", limits, state);
  return state.failure === undefined
    ? { bytes: state.bytes, nodes: state.nodes }
    : { bytes: state.bytes, failure: state.failure, nodes: state.nodes };
}

export function sortJsonValue(value: JsonValue): JsonValue {
  return orderJsonKeys(value);
}

export function stableStringify(value: JsonValue): string {
  return stableJson(value);
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
