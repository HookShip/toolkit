// SPDX-License-Identifier: Apache-2.0

import { ExtensionValidationError } from "./errors.js";

export const DANGEROUS_PROPERTY_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export type ClosedObject = Readonly<Record<string, unknown>>;

export function inspectClosedObject(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): ClosedObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionValidationError(
      "INVALID_TYPE",
      `${path} must be a plain object.`,
      path,
    );
  }
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new ExtensionValidationError(
      "UNSAFE_OBJECT",
      `${path} could not be inspected safely.`,
      path,
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExtensionValidationError(
      "INVALID_PROTOTYPE",
      `${path} must have Object.prototype or a null prototype.`,
      path,
    );
  }

  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new ExtensionValidationError(
        "UNKNOWN_FIELD",
        `${path} must not contain symbol fields.`,
        path,
      );
    }
    if (!allowed.has(key)) {
      throw new ExtensionValidationError(
        "UNKNOWN_FIELD",
        `${path} contains unknown field ${JSON.stringify(key)}.`,
        `${path}.${key}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new ExtensionValidationError(
        "UNSAFE_PROPERTY",
        `${path}.${key} must be an enumerable data property.`,
        `${path}.${key}`,
      );
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(result, key)) {
      throw new ExtensionValidationError(
        "MISSING_FIELD",
        `${path} is missing required field ${key}.`,
        `${path}.${key}`,
      );
    }
  }
  return result;
}

export function inspectRecord(
  value: unknown,
  path: string,
  options: {
    readonly maximumEntries?: number;
    readonly rejectDangerousKeys?: boolean;
  } = {},
): ClosedObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionValidationError(
      "INVALID_TYPE",
      `${path} must be a plain object.`,
      path,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExtensionValidationError(
      "INVALID_PROTOTYPE",
      `${path} must have Object.prototype or a null prototype.`,
      path,
    );
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > (options.maximumEntries ?? 256)) {
    throw new ExtensionValidationError(
      "LIMIT_EXCEEDED",
      `${path} has too many fields.`,
      path,
    );
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new ExtensionValidationError(
        "UNKNOWN_FIELD",
        `${path} must not contain symbol fields.`,
        path,
      );
    }
    if (
      options.rejectDangerousKeys !== false &&
      DANGEROUS_PROPERTY_NAMES.has(key)
    ) {
      throw new ExtensionValidationError(
        "DANGEROUS_FIELD",
        `${path} contains a dangerous field name.`,
        `${path}.${key}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new ExtensionValidationError(
        "UNSAFE_PROPERTY",
        `${path}.${key} must be an enumerable data property.`,
        `${path}.${key}`,
      );
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function inspectArray(
  value: unknown,
  path: string,
  maximumLength = 256,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ExtensionValidationError(
      "INVALID_TYPE",
      `${path} must be an array.`,
      path,
    );
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ExtensionValidationError(
      "INVALID_PROTOTYPE",
      `${path} must be a plain array.`,
      path,
    );
  }
  if (value.length > maximumLength) {
    throw new ExtensionValidationError(
      "LIMIT_EXCEEDED",
      `${path} exceeds ${maximumLength} entries.`,
      path,
    );
  }
  const expectedKeys = new Set(
    Array.from({ length: value.length }, (_unused, index) => String(index)),
  );
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string" || !expectedKeys.has(key)) {
      throw new ExtensionValidationError(
        "UNKNOWN_FIELD",
        `${path} contains a non-index array property.`,
        path,
      );
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new ExtensionValidationError(
        "UNSAFE_PROPERTY",
        `${path}[${index}] must be an enumerable data property.`,
        `${path}[${index}]`,
      );
    }
    result.push(descriptor.value);
  }
  return result;
}

export function expectString(
  value: unknown,
  path: string,
  options: {
    readonly allowEmpty?: boolean;
    readonly maximumLength?: number;
    readonly minimumLength?: number;
  } = {},
): string {
  if (typeof value !== "string") {
    throw new ExtensionValidationError(
      "INVALID_TYPE",
      `${path} must be a string.`,
      path,
    );
  }
  const minimumLength = options.minimumLength ?? (options.allowEmpty ? 0 : 1);
  const maximumLength = options.maximumLength ?? 2_048;
  if (value.length < minimumLength || value.length > maximumLength) {
    throw new ExtensionValidationError(
      "INVALID_LENGTH",
      `${path} length must be between ${minimumLength} and ${maximumLength}.`,
      path,
    );
  }
  return value;
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ExtensionValidationError(
      "INVALID_TYPE",
      `${path} must be a boolean.`,
      path,
    );
  }
  return value;
}

export function expectInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ExtensionValidationError(
      "INVALID_INTEGER",
      `${path} must be an integer between ${minimum} and ${maximum}.`,
      path,
    );
  }
  return value;
}

export function expectEnum<const T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ExtensionValidationError(
      "INVALID_ENUM",
      `${path} must be one of: ${allowed.join(", ")}.`,
      path,
    );
  }
  return value as T;
}

export function expectIdentifier(
  value: unknown,
  path: string,
  maximumLength = 128,
): string {
  const candidate = expectString(value, path, { maximumLength });
  if (!isSafeIdentifier(candidate)) {
    throw new ExtensionValidationError(
      "INVALID_IDENTIFIER",
      `${path} is not a safe identifier.`,
      path,
    );
  }
  return candidate;
}

export function isSafeIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 128) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f ||
      code === 0x3a ||
      code === 0x2f;
    if (!valid) {
      return false;
    }
  }
  return !DANGEROUS_PROPERTY_NAMES.has(value);
}

export function expectIsoTimestamp(value: unknown, path: string): string {
  const candidate = expectString(value, path, { maximumLength: 64 });
  const milliseconds = Date.parse(candidate);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== candidate
  ) {
    throw new ExtensionValidationError(
      "INVALID_TIMESTAMP",
      `${path} must be a canonical UTC ISO-8601 timestamp.`,
      path,
    );
  }
  return candidate;
}

export function expectStringArray(
  value: unknown,
  path: string,
  options: {
    readonly maximumItems?: number;
    readonly maximumLength?: number;
    readonly validate?: (candidate: string, path: string) => string;
  } = {},
): readonly string[] {
  const values = inspectArray(value, path, options.maximumItems ?? 256);
  return values.map((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const string = expectString(candidate, itemPath, {
      maximumLength: options.maximumLength ?? 2_048,
    });
    return options.validate?.(string, itemPath) ?? string;
  });
}

export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}
