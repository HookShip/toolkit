// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  unicodeCodePointLength,
  type JsonObject,
  type JsonSchema,
  type JsonSchemaType,
  type JsonValue,
} from "@webhook-portal/canonical-model";

import type { DiagnosticCollector } from "./diagnostics.js";
import { escapePointerToken } from "./json-utils.js";

export const UNSUPPORTED_FIXTURE_KEYWORDS = [
  "$dynamicRef",
  "$recursiveRef",
  "contains",
  "contentSchema",
  "dependentSchemas",
  "else",
  "if",
  "not",
  "patternProperties",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

export const ANNOTATION_KEYWORDS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

export interface FixtureContext {
  readonly budget: {
    bytes: number;
    nodes: number;
  };
  readonly diagnostics: DiagnosticCollector;
  readonly includeOptional: boolean;
  readonly maxArrayItems: number;
  readonly maxDepth: number;
  readonly maxOutputBytes: number;
  readonly maxOutputNodes: number;
  readonly maxStringLength: number;
  readonly root: JsonSchema;
  partial: boolean;
}

export const DEFAULT_FIXTURE_LIMITS = Object.freeze({
  maxOutputBytes: 512 * 1024,
  maxOutputNodes: 10_000,
  maxStringLength: 16_384,
});

export const HARD_FIXTURE_LIMITS = Object.freeze({
  maxOutputBytes: 8 * 1024 * 1024,
  maxOutputNodes: 100_000,
  maxStringLength: 1_000_000,
});

export function addUnsupported(
  context: FixtureContext,
  code: string,
  message: string,
  pointer: string,
): undefined {
  context.diagnostics.add({
    code,
    message,
    pointer,
    severity: "error",
  });
  return undefined;
}

export function reserveBudget(
  context: FixtureContext,
  pointer: string,
  nodes: number,
  bytes: number,
): boolean {
  if (
    context.budget.nodes + nodes > context.maxOutputNodes ||
    context.budget.bytes + bytes > context.maxOutputBytes
  ) {
    context.diagnostics.add({
      code: "FIXTURE_OUTPUT_BUDGET_EXCEEDED",
      details: {
        maximumBytes: context.maxOutputBytes,
        maximumNodes: context.maxOutputNodes,
      },
      message: "Generated fixture exceeds the configured output budget",
      pointer,
      severity: "error",
    });
    return false;
  }
  context.budget.nodes += nodes;
  context.budget.bytes += bytes;
  return true;
}

export function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || character === "\\") {
      bytes += 2;
    } else if (
      character === "\b" ||
      character === "\f" ||
      character === "\n" ||
      character === "\r" ||
      character === "\t"
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else {
      bytes += Buffer.byteLength(character, "utf8");
    }
  }
  return bytes;
}

export function reserveString(
  value: string,
  pointer: string,
  context: FixtureContext,
): boolean {
  const length = unicodeCodePointLength(value);
  if (length > context.maxStringLength) {
    context.diagnostics.add({
      code: "FIXTURE_STRING_LIMIT_EXCEEDED",
      details: {
        actualLength: length,
        maximumLength: context.maxStringLength,
      },
      message: "Fixture string exceeds the configured length limit",
      pointer,
      severity: "error",
    });
    return false;
  }
  return reserveBudget(context, pointer, 1, jsonStringBytes(value));
}

export function reserveExplicitValue(
  value: JsonValue,
  pointer: string,
  context: FixtureContext,
): boolean {
  if (typeof value === "string") {
    return reserveString(value, pointer, context);
  }
  if (value === null || typeof value === "boolean") {
    return reserveBudget(
      context,
      pointer,
      1,
      value === null ? 4 : value ? 4 : 5,
    );
  }
  if (typeof value === "number") {
    return reserveBudget(
      context,
      pointer,
      1,
      Buffer.byteLength(String(value), "utf8"),
    );
  }
  if (Array.isArray(value)) {
    if (!reserveBudget(context, pointer, 1, 2)) return false;
    return value.every(
      (item, index) =>
        (index === 0 || reserveBudget(context, pointer, 0, 1)) &&
        reserveExplicitValue(item, `${pointer}/${index}`, context),
    );
  }
  if (!reserveBudget(context, pointer, 1, 2)) return false;
  let propertyIndex = 0;
  for (const [key, item] of Object.entries(value)) {
    if (
      item === undefined ||
      !reserveBudget(
        context,
        pointer,
        0,
        jsonStringBytes(key) + 1 + (propertyIndex === 0 ? 0 : 1),
      ) ||
      !reserveExplicitValue(
        item,
        `${pointer}/properties/${escapePointerToken(key)}`,
        context,
      )
    ) {
      return false;
    }
    propertyIndex += 1;
  }
  return true;
}

export function explicitValue(schema: JsonObject): JsonValue | undefined {
  if (Array.isArray(schema["examples"]) && schema["examples"].length > 0) {
    return schema["examples"][0];
  }
  if (schema["example"] !== undefined) {
    return schema["example"];
  }
  if (schema["default"] !== undefined) {
    return schema["default"];
  }
  if (schema["const"] !== undefined) {
    return schema["const"];
  }
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) {
    return schema["enum"][0];
  }
  return undefined;
}

export function declaredTypes(schema: JsonObject): readonly JsonSchemaType[] {
  if (typeof schema["type"] === "string") {
    return [schema["type"] as JsonSchemaType];
  }
  if (Array.isArray(schema["type"])) {
    return schema["type"].filter(
      (type): type is JsonSchemaType =>
        type === "array" ||
        type === "boolean" ||
        type === "integer" ||
        type === "null" ||
        type === "number" ||
        type === "object" ||
        type === "string",
    );
  }
  if (isJsonObject(schema["properties"])) {
    return ["object"];
  }
  if (schema["items"] !== undefined || schema["prefixItems"] !== undefined) {
    return ["array"];
  }
  return [];
}

export function stringFixture(
  schema: JsonObject,
  pointer: string,
  context: FixtureContext,
): string | undefined {
  const format = typeof schema["format"] === "string" ? schema["format"] : "";
  const formatted: Record<string, string> = {
    date: "2000-01-01",
    "date-time": "2000-01-01T00:00:00.000Z",
    duration: "PT1S",
    email: "user@example.com",
    hostname: "example.com",
    ipv4: "192.0.2.1",
    ipv6: "2001:db8::1",
    uri: "https://example.com/resource",
    "uri-reference": "/resource",
    uuid: "00000000-0000-4000-8000-000000000000",
  };
  let value = formatted[format] ?? "string";
  const minimum =
    typeof schema["minLength"] === "number" ? schema["minLength"] : 0;
  const maximum =
    typeof schema["maxLength"] === "number"
      ? schema["maxLength"]
      : Number.POSITIVE_INFINITY;
  if (minimum > maximum) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(minimum) ||
    minimum < 0 ||
    minimum > context.maxStringLength
  ) {
    return addUnsupported(
      context,
      "FIXTURE_STRING_LIMIT_EXCEEDED",
      `Schema minLength ${minimum} exceeds the configured ${context.maxStringLength} character limit`,
      `${pointer}/minLength`,
    );
  }
  const initialLength = unicodeCodePointLength(value);
  if (initialLength < minimum) {
    const repetition = minimum - initialLength;
    if (
      jsonStringBytes(value) + repetition >
      context.maxOutputBytes - context.budget.bytes
    ) {
      return addUnsupported(
        context,
        "FIXTURE_OUTPUT_BUDGET_EXCEEDED",
        "String repetition would exceed the fixture output budget",
        pointer,
      );
    }
    value += "x".repeat(repetition);
  }
  return unicodeCodePointLength(value) <= maximum ? value : undefined;
}

export function numberFixture(
  schema: JsonObject,
  integer: boolean,
): number | undefined {
  const exclusiveMinimum =
    typeof schema["exclusiveMinimum"] === "number"
      ? schema["exclusiveMinimum"]
      : undefined;
  const exclusiveMaximum =
    typeof schema["exclusiveMaximum"] === "number"
      ? schema["exclusiveMaximum"]
      : undefined;
  const minimum =
    exclusiveMinimum ??
    (typeof schema["minimum"] === "number"
      ? schema["minimum"]
      : Number.NEGATIVE_INFINITY);
  const maximum =
    exclusiveMaximum ??
    (typeof schema["maximum"] === "number"
      ? schema["maximum"]
      : Number.POSITIVE_INFINITY);
  const multiple =
    typeof schema["multipleOf"] === "number" && schema["multipleOf"] > 0
      ? schema["multipleOf"]
      : undefined;

  if (multiple !== undefined) {
    let minimumMultiplier = Number.isFinite(minimum)
      ? Math.ceil(minimum / multiple)
      : Number.NEGATIVE_INFINITY;
    let maximumMultiplier = Number.isFinite(maximum)
      ? Math.floor(maximum / multiple)
      : Number.POSITIVE_INFINITY;
    if (
      exclusiveMinimum !== undefined &&
      minimumMultiplier * multiple <= exclusiveMinimum
    ) {
      minimumMultiplier += 1;
    }
    if (
      exclusiveMaximum !== undefined &&
      maximumMultiplier * multiple >= exclusiveMaximum
    ) {
      maximumMultiplier -= 1;
    }
    let multiplier = Math.min(
      maximumMultiplier,
      Math.max(minimumMultiplier, 0),
    );
    if (!Number.isFinite(multiplier)) {
      multiplier = Number.isFinite(minimumMultiplier)
        ? minimumMultiplier
        : maximumMultiplier;
    }
    const candidate = multiplier * multiple;
    return Number.isFinite(candidate) &&
      (!integer || Number.isInteger(candidate)) &&
      candidate >= minimum &&
      candidate <= maximum &&
      candidate !== exclusiveMinimum &&
      candidate !== exclusiveMaximum
      ? candidate
      : undefined;
  }

  let value: number;
  if (
    0 >= minimum &&
    0 <= maximum &&
    0 !== exclusiveMinimum &&
    0 !== exclusiveMaximum
  ) {
    value = 0;
  } else if (integer) {
    const lower = Number.isFinite(minimum)
      ? Math.ceil(minimum) +
        (minimum === exclusiveMinimum && Number.isInteger(minimum) ? 1 : 0)
      : Number.NEGATIVE_INFINITY;
    const upper = Number.isFinite(maximum)
      ? Math.floor(maximum) -
        (maximum === exclusiveMaximum && Number.isInteger(maximum) ? 1 : 0)
      : Number.POSITIVE_INFINITY;
    value = Number.isFinite(lower) ? lower : upper;
  } else if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
    if (minimum > maximum) {
      return undefined;
    }
    value = minimum === maximum ? minimum : minimum + (maximum - minimum) / 2;
  } else if (Number.isFinite(minimum)) {
    value =
      minimum === exclusiveMinimum
        ? minimum + Math.max(1, Math.abs(minimum) * Number.EPSILON * 2)
        : minimum;
  } else {
    value =
      maximum === exclusiveMaximum
        ? maximum - Math.max(1, Math.abs(maximum) * Number.EPSILON * 2)
        : maximum;
  }
  return Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum &&
    value !== exclusiveMinimum &&
    value !== exclusiveMaximum
    ? value
    : undefined;
}
