// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { EvidenceValidationError } from "./errors.js";

const dangerousKeys = new Set(["__proto__", "constructor", "prototype"]);
const forbiddenKeyTerms = [
  "address",
  "authorization",
  "bank",
  "body",
  "card",
  "cookie",
  "credential",
  "customer",
  "cvv",
  "email",
  "header",
  "iban",
  "name",
  "password",
  "payload",
  "payment",
  "phone",
  "pii",
  "query",
  "raw",
  "secret",
  "ssn",
  "taxid",
  "token",
  "url",
  "uri",
] as const;

const canonicalTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const safeTokenPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:+-]*[A-Za-z0-9])?$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const emailPattern =
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/iu;
const secretPrefixPattern =
  /^(?:AKIA[0-9A-Z]{12,}|bearer(?:\s|:)|basic(?:\s|:)|gh[pousr]_|sk_(?:live|test)_|xox[baprs]-|-----BEGIN)/iu;
const jwtPattern =
  /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/u;

export interface InspectionContext {
  readonly ancestors: Set<object>;
}

export function createInspectionContext(): InspectionContext {
  return { ancestors: new Set<object>() };
}

function fail(code: string, message: string, path: string): never {
  throw new EvidenceValidationError(code, message, path);
}

function isBinary(value: object): boolean {
  return (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function enterContainer(
  value: object,
  path: string,
  context: InspectionContext,
): void {
  if (utilTypes.isProxy(value)) {
    fail("PROXY_NOT_ALLOWED", "Proxy values are not allowed.", path);
  }
  if (isBinary(value)) {
    fail("BINARY_NOT_ALLOWED", "Binary values are not allowed.", path);
  }
  if (context.ancestors.has(value)) {
    fail("CYCLIC_INPUT", "Cyclic input is not allowed.", path);
  }
  context.ancestors.add(value);
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isForbiddenKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return forbiddenKeyTerms.some((term) => normalized.includes(term));
}

export function readRecord<T>(
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string>,
  context: InspectionContext,
  read: (record: Readonly<Record<string, unknown>>) => T,
): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_TYPE", "A plain object is required.", path);
  }

  enterContainer(value, path, context);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(
        "PROTOTYPE_NOT_ALLOWED",
        "Custom object prototypes are not allowed.",
        path,
      );
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        fail("SYMBOL_NOT_ALLOWED", "Symbol keys are not allowed.", path);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        fail(
          "ACCESSOR_NOT_ALLOWED",
          "Accessors and hidden properties are not allowed.",
          path,
        );
      }
      if (dangerousKeys.has(key)) {
        fail(
          "PROTOTYPE_KEY_NOT_ALLOWED",
          "Prototype-related keys are not allowed.",
          path,
        );
      }
      if (!allowedKeys.has(key)) {
        if (isForbiddenKey(key)) {
          fail(
            "FORBIDDEN_FIELD",
            "Input contains a forbidden data field.",
            path,
          );
        }
        fail("UNKNOWN_FIELD", "Input contains an unknown field.", path);
      }
      result[key] = descriptor.value;
    }
    return read(result);
  } finally {
    context.ancestors.delete(value);
  }
}

export function readArray<T>(
  value: unknown,
  path: string,
  maximumLength: number,
  context: InspectionContext,
  read: (values: readonly unknown[]) => T,
): T {
  if (!Array.isArray(value)) {
    if (value !== null && typeof value === "object" && isBinary(value)) {
      fail("BINARY_NOT_ALLOWED", "Binary values are not allowed.", path);
    }
    fail("INVALID_TYPE", "An array is required.", path);
  }

  enterContainer(value, path, context);
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail(
        "PROTOTYPE_NOT_ALLOWED",
        "Custom array prototypes are not allowed.",
        path,
      );
    }
    if (value.length > maximumLength) {
      fail("ARRAY_LIMIT", "Array length exceeds the configured limit.", path);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        fail("SYMBOL_NOT_ALLOWED", "Symbol keys are not allowed.", path);
      }
      if (key === "length") {
        continue;
      }
      if (!/^(?:0|[1-9]\d*)$/u.test(key)) {
        fail("UNKNOWN_FIELD", "Array properties are not allowed.", path);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        fail(
          "ACCESSOR_NOT_ALLOWED",
          "Array accessors and hidden entries are not allowed.",
          path,
        );
      }
    }

    const values: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        fail("SPARSE_ARRAY", "Sparse arrays are not allowed.", path);
      }
      values.push(descriptor.value);
    }
    return read(values);
  } finally {
    context.ancestors.delete(value);
  }
}

export function hasOwn(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return Object.hasOwn(record, key);
}

export function required(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): unknown {
  if (!hasOwn(record, key)) {
    fail("MISSING_FIELD", "A required field is missing.", `${path}.${key}`);
  }
  return record[key];
}

export function assertWellFormedUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        fail(
          "MALFORMED_UNICODE",
          "Strings must contain well-formed Unicode.",
          path,
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(
        "MALFORMED_UNICODE",
        "Strings must contain well-formed Unicode.",
        path,
      );
    }
  }
}

function containsPaymentCard(value: string): boolean {
  const digits = value.replace(/[\s-]/gu, "");
  if (!/^\d{13,19}$/u.test(digits)) {
    return false;
  }
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function assertNoSensitiveText(value: string, path: string): void {
  if (
    emailPattern.test(value) ||
    secretPrefixPattern.test(value) ||
    jwtPattern.test(value) ||
    containsPaymentCard(value)
  ) {
    fail(
      "SENSITIVE_VALUE_NOT_ALLOWED",
      "Sensitive-looking plaintext is not allowed.",
      path,
    );
  }
}

export function assertSafeToken(
  value: unknown,
  path: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") {
    if (value !== null && typeof value === "object" && isBinary(value)) {
      fail("BINARY_NOT_ALLOWED", "Binary values are not allowed.", path);
    }
    fail("INVALID_TYPE", "A string is required.", path);
  }
  assertWellFormedUnicode(value, path);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > maximumBytes) {
    fail("STRING_LIMIT", "String length is outside the allowed bounds.", path);
  }
  if (!safeTokenPattern.test(value)) {
    fail(
      "INVALID_OPAQUE_IDENTIFIER",
      "Only bounded opaque identifier characters are allowed.",
      path,
    );
  }
  assertNoSensitiveText(value, path);
  return value;
}

export function assertCanonicalTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !canonicalTimestampPattern.test(value)) {
    fail(
      "INVALID_TIMESTAMP",
      "A canonical UTC timestamp with milliseconds is required.",
      path,
    );
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail("INVALID_TIMESTAMP", "Timestamp value is invalid.", path);
  }
  return value;
}

export function timestampMilliseconds(value: string): number {
  return Date.parse(value);
}

export function assertSha256Hex(value: unknown, path: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("INVALID_CHECKSUM", "A lowercase SHA-256 checksum is required.", path);
  }
  return value;
}

export function assertInteger(
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
    fail(
      "INVALID_INTEGER",
      "Integer value is outside the allowed bounds.",
      path,
    );
  }
  return value;
}

export function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
