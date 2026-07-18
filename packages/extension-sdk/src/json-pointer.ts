// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "./canonical.js";
import { DeclarativeRuntimeError } from "./errors.js";
import { DANGEROUS_PROPERTY_NAMES, expectString } from "./validation.js";

export interface PointerLookup {
  readonly found: boolean;
  readonly value?: JsonValue;
}

function decodeSegment(segment: string, path: string): string {
  let decoded = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character !== "~") {
      decoded += character;
      continue;
    }
    const escape = segment[index + 1];
    if (escape === "0") {
      decoded += "~";
    } else if (escape === "1") {
      decoded += "/";
    } else {
      throw new DeclarativeRuntimeError(
        "INVALID_POINTER",
        `${path} contains an invalid JSON Pointer escape.`,
        path,
      );
    }
    index += 1;
  }
  return decoded;
}

function encodeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function parseJsonPointer(
  value: string,
  path = "pointer",
  maximumDepth = 32,
): readonly string[] {
  const pointer = expectString(value, path, {
    allowEmpty: false,
    maximumLength: 2_048,
  });
  if (!pointer.startsWith("/")) {
    throw new DeclarativeRuntimeError(
      "INVALID_POINTER",
      `${path} must be a non-root RFC 6901 JSON Pointer.`,
      path,
    );
  }
  const segments = pointer.slice(1).split("/");
  if (segments.length > maximumDepth) {
    throw new DeclarativeRuntimeError(
      "POINTER_DEPTH_LIMIT",
      `${path} exceeds the pointer depth limit.`,
      path,
    );
  }
  return Object.freeze(
    segments.map((segment, index) => {
      const decoded = decodeSegment(segment, `${path}[${index}]`);
      if (
        decoded.length === 0 ||
        decoded.length > 256 ||
        DANGEROUS_PROPERTY_NAMES.has(decoded)
      ) {
        throw new DeclarativeRuntimeError(
          "DANGEROUS_POINTER",
          `${path} contains an empty, dangerous, or oversized segment.`,
          path,
        );
      }
      return decoded;
    }),
  );
}

export function normalizeJsonPointer(value: string, path = "pointer"): string {
  return `/${parseJsonPointer(value, path).map(encodeSegment).join("/")}`;
}

function arrayIndex(segment: string, length: number): number | undefined {
  if (segment === "0") {
    return 0;
  }
  if (segment.length === 0 || segment.startsWith("0")) {
    return undefined;
  }
  for (const character of segment) {
    const code = character.charCodeAt(0);
    if (code < 0x30 || code > 0x39) {
      return undefined;
    }
  }
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index < 0 || index > 100_000) {
    return undefined;
  }
  return index < length ? index : undefined;
}

function ownDataValue(
  object: object,
  key: string,
): { readonly found: boolean; readonly value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor)
  ) {
    return { found: false };
  }
  return { found: true, value: descriptor.value };
}

export function getJsonPointer(
  root: JsonValue,
  pointer: string,
): PointerLookup {
  const segments = parseJsonPointer(pointer);
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = arrayIndex(segment, current.length);
      if (index === undefined) {
        return { found: false };
      }
      const lookup = ownDataValue(current, String(index));
      if (!lookup.found) {
        return { found: false };
      }
      current = lookup.value;
      continue;
    }
    if (current === null || typeof current !== "object") {
      return { found: false };
    }
    const lookup = ownDataValue(current, segment);
    if (!lookup.found) {
      return { found: false };
    }
    current = lookup.value;
  }
  return { found: true, value: current as JsonValue };
}

function mutableContainer(
  candidate: JsonValue,
  path: string,
): JsonValue[] | Record<string, JsonValue> {
  if (Array.isArray(candidate)) {
    return candidate as JsonValue[];
  }
  if (candidate !== null && typeof candidate === "object") {
    return candidate as Record<string, JsonValue>;
  }
  throw new DeclarativeRuntimeError(
    "POINTER_TYPE_MISMATCH",
    `${path} traverses through a scalar value.`,
    path,
  );
}

export function setJsonPointer(
  root: JsonValue,
  pointer: string,
  value: JsonValue,
): void {
  const segments = parseJsonPointer(pointer);
  let current = mutableContainer(root, pointer);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    if (segment === undefined || nextSegment === undefined) {
      throw new DeclarativeRuntimeError(
        "INVALID_POINTER",
        "JSON Pointer is incomplete.",
        pointer,
      );
    }
    if (Array.isArray(current)) {
      const arrayPosition = arrayIndex(segment, current.length);
      if (arrayPosition === undefined) {
        throw new DeclarativeRuntimeError(
          "POINTER_ARRAY_INDEX",
          `${pointer} contains an invalid or absent array index.`,
          pointer,
        );
      }
      current = mutableContainer(current[arrayPosition] as JsonValue, pointer);
      continue;
    }
    const existing = ownDataValue(current, segment);
    if (!existing.found) {
      const created = Object.create(null) as Record<string, JsonValue>;
      current[segment] = created;
      current = created;
      continue;
    }
    current = mutableContainer(existing.value as JsonValue, pointer);
  }
  const leaf = segments.at(-1);
  if (leaf === undefined) {
    throw new DeclarativeRuntimeError(
      "INVALID_POINTER",
      "JSON Pointer must not target the document root.",
      pointer,
    );
  }
  if (Array.isArray(current)) {
    const index = arrayIndex(leaf, current.length);
    if (index === undefined) {
      throw new DeclarativeRuntimeError(
        "POINTER_ARRAY_INDEX",
        `${pointer} contains an invalid or absent array index.`,
        pointer,
      );
    }
    current[index] = value;
  } else {
    current[leaf] = value;
  }
}

export function deleteJsonPointer(root: JsonValue, pointer: string): boolean {
  const segments = parseJsonPointer(pointer);
  let current: JsonValue = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return false;
    }
    const lookup = getChild(current, segment);
    if (!lookup.found) {
      return false;
    }
    current = lookup.value as JsonValue;
  }
  const leaf = segments.at(-1);
  if (leaf === undefined || current === null || typeof current !== "object") {
    return false;
  }
  if (Array.isArray(current)) {
    const index = arrayIndex(leaf, current.length);
    if (index === undefined) {
      return false;
    }
    current.splice(index, 1);
    return true;
  }
  if (!Object.hasOwn(current, leaf)) {
    return false;
  }
  return delete (current as Record<string, JsonValue>)[leaf];
}

function getChild(root: JsonValue, segment: string): PointerLookup {
  if (Array.isArray(root)) {
    const index = arrayIndex(segment, root.length);
    return index === undefined
      ? { found: false }
      : { found: true, value: root[index] };
  }
  if (root === null || typeof root !== "object") {
    return { found: false };
  }
  return ownDataValue(root, segment) as PointerLookup;
}

export function pointerScopeAllows(
  scopes: readonly string[],
  pointer: string,
): boolean {
  const normalized = normalizeJsonPointer(pointer);
  return scopes.some((scope) => {
    if (scope === "*") {
      return true;
    }
    if (scope.endsWith("/**")) {
      const prefix = scope.slice(0, -3);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    return scope === normalized;
  });
}
