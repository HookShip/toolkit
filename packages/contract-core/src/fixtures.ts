// SPDX-License-Identifier: Apache-2.0

import { Ajv } from "ajv";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";

import {
  isJsonObject,
  isJsonSchema,
  isJsonValue,
  unicodeCodePointLength,
  type JsonObject,
  type JsonSchema,
  type JsonSchemaType,
  type JsonValue,
} from "@webhook-portal/canonical-model";

import type {
  FixtureGenerationOptions,
  FixtureGenerationResult,
} from "./api-types.js";
import { DiagnosticCollector } from "./diagnostics.js";
import {
  compareCodeUnits,
  escapePointerToken,
  jsonEqual,
  sortJsonValue,
} from "./json-utils.js";
import { resolveJsonPointer } from "./refs.js";
import {
  countRegexConstraints,
  stripRegexConstraintsForValidation,
} from "./schema-processing.js";

const UNSUPPORTED_FIXTURE_KEYWORDS = [
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

const ANNOTATION_KEYWORDS = new Set([
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

interface FixtureContext {
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

function addUnsupported(
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

function reserveBudget(
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

function jsonStringBytes(value: string): number {
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

function reserveString(
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

function reserveExplicitValue(
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

function explicitValue(schema: JsonObject): JsonValue | undefined {
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

function declaredTypes(schema: JsonObject): readonly JsonSchemaType[] {
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

function stringFixture(
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

function numberFixture(
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

function mergeAllOf(
  schemas: readonly JsonSchema[],
  pointer: string,
  context: FixtureContext,
  depth: number,
  references: readonly string[],
): JsonValue | undefined {
  let merged: JsonValue | undefined;
  for (const [index, schema] of schemas.entries()) {
    const value = generateValue(
      schema,
      `${pointer}/allOf/${index}`,
      context,
      depth + 1,
      references,
    );
    if (value === undefined) {
      return undefined;
    }
    if (merged === undefined) {
      merged = value;
    } else if (isJsonObject(merged) && isJsonObject(value)) {
      const object: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(merged)) {
        if (item !== undefined) {
          object[key] = item;
        }
      }
      for (const [key, item] of Object.entries(value)) {
        if (
          item !== undefined &&
          object[key] !== undefined &&
          !jsonEqual(object[key], item)
        ) {
          return addUnsupported(
            context,
            "ALLOF_FIXTURE_CONFLICT",
            `allOf branches generate conflicting values for "${key}"`,
            `${pointer}/allOf/${index}/${escapePointerToken(key)}`,
          );
        }
        if (item !== undefined) {
          object[key] = item;
        }
      }
      merged = object;
    } else if (!jsonEqual(merged, value)) {
      return addUnsupported(
        context,
        "ALLOF_FIXTURE_CONFLICT",
        "allOf branches do not produce mergeable fixtures",
        pointer,
      );
    }
  }
  return merged;
}

function generateValue(
  schema: JsonSchema,
  pointer: string,
  context: FixtureContext,
  depth: number,
  references: readonly string[],
): JsonValue | undefined {
  if (depth > context.maxDepth) {
    return addUnsupported(
      context,
      "FIXTURE_DEPTH_EXCEEDED",
      `Fixture generation exceeds ${context.maxDepth} levels`,
      pointer,
    );
  }
  if (schema === false) {
    return addUnsupported(
      context,
      "FALSE_SCHEMA_UNINHABITED",
      "A false JSON Schema has no valid fixture",
      pointer,
    );
  }
  if (schema === true) {
    context.partial = true;
    context.diagnostics.add({
      code: "UNCONSTRAINED_SCHEMA_FIXTURE",
      message: "Unconstrained schema uses null as a deterministic fixture",
      pointer,
      severity: "warning",
    });
    return reserveBudget(context, pointer, 1, 4) ? null : undefined;
  }

  const explicit = explicitValue(schema);
  if (explicit !== undefined) {
    if (!isJsonValue(explicit)) {
      return addUnsupported(
        context,
        "NON_JSON_EXPLICIT_VALUE",
        "Schema example/default/const is not JSON-serializable",
        pointer,
      );
    }
    return reserveExplicitValue(explicit, pointer, context)
      ? sortJsonValue(explicit)
      : undefined;
  }

  for (const keyword of UNSUPPORTED_FIXTURE_KEYWORDS) {
    if (schema[keyword] !== undefined) {
      return addUnsupported(
        context,
        "UNSUPPORTED_FIXTURE_KEYWORD",
        `Fixture generation does not support "${keyword}"`,
        `${pointer}/${escapePointerToken(keyword)}`,
      );
    }
  }
  if (schema["pattern"] !== undefined) {
    return addUnsupported(
      context,
      "PATTERN_FIXTURE_UNSUPPORTED",
      "A string pattern requires an explicit example or default",
      `${pointer}/pattern`,
    );
  }

  if (typeof schema["$ref"] === "string") {
    const reference = schema["$ref"];
    if (!reference.startsWith("#") || !isJsonObject(context.root)) {
      return addUnsupported(
        context,
        "FIXTURE_REF_UNSUPPORTED",
        "Fixture generation only resolves local JSON Pointer references",
        `${pointer}/$ref`,
      );
    }
    if (references.includes(reference)) {
      return addUnsupported(
        context,
        "FIXTURE_REF_CYCLE",
        `Recursive reference "${reference}" exceeds deterministic fixture support`,
        `${pointer}/$ref`,
      );
    }
    const fragment = reference.slice(1);
    let decoded: string;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      return addUnsupported(
        context,
        "FIXTURE_REF_INVALID",
        `Invalid reference "${reference}"`,
        `${pointer}/$ref`,
      );
    }
    const target = resolveJsonPointer(context.root, decoded);
    if (!isJsonSchema(target)) {
      return addUnsupported(
        context,
        "FIXTURE_REF_NOT_FOUND",
        `Reference "${reference}" does not resolve to a JSON Schema`,
        `${pointer}/$ref`,
      );
    }
    const nextReferences = [...references, reference];
    const dialect =
      typeof schema["$schema"] === "string"
        ? schema["$schema"]
        : isJsonObject(context.root) &&
            typeof context.root["$schema"] === "string"
          ? context.root["$schema"]
          : "";
    if (dialect.includes("draft-07")) {
      return generateValue(target, decoded, context, depth + 1, nextReferences);
    }
    const siblings: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(schema)) {
      if (
        key !== "$ref" &&
        !ANNOTATION_KEYWORDS.has(key) &&
        item !== undefined
      ) {
        siblings[key] = item;
      }
    }
    return Object.keys(siblings).length === 0
      ? generateValue(target, decoded, context, depth + 1, nextReferences)
      : mergeAllOf([target, siblings], pointer, context, depth, nextReferences);
  }

  if (Array.isArray(schema["allOf"])) {
    return mergeAllOf(
      schema["allOf"] as readonly JsonSchema[],
      pointer,
      context,
      depth,
      references,
    );
  }

  const union = Array.isArray(schema["oneOf"])
    ? schema["oneOf"]
    : Array.isArray(schema["anyOf"])
      ? schema["anyOf"]
      : undefined;
  if (union !== undefined) {
    for (const [index, member] of union.entries()) {
      const isolated: FixtureContext = {
        ...context,
        budget: { ...context.budget },
        diagnostics: new DiagnosticCollector(25),
      };
      const value = generateValue(
        member as JsonSchema,
        `${pointer}/${Array.isArray(schema["oneOf"]) ? "oneOf" : "anyOf"}/${index}`,
        isolated,
        depth + 1,
        references,
      );
      if (value !== undefined) {
        if (Array.isArray(schema["oneOf"])) {
          let matches = 0;
          let fullyValidated = true;
          for (const candidate of union) {
            const validate = validator(candidate as JsonSchema);
            if (validate === undefined) {
              fullyValidated = false;
              break;
            }
            if (validate(value)) {
              matches += 1;
            }
          }
          if (!fullyValidated || matches !== 1) {
            continue;
          }
        }
        context.budget.bytes = isolated.budget.bytes;
        context.budget.nodes = isolated.budget.nodes;
        context.partial = isolated.partial;
        context.diagnostics.addAll(isolated.diagnostics.toArray());
        return value;
      }
    }
    return addUnsupported(
      context,
      "UNION_FIXTURE_UNSUPPORTED",
      "No union branch produced a deterministic fixture",
      pointer,
    );
  }

  const types = declaredTypes(schema);
  const selected = types.find((type) => type !== "null") ?? types[0];
  switch (selected) {
    case "null":
      return reserveBudget(context, pointer, 1, 4) ? null : undefined;
    case "boolean":
      return reserveBudget(context, pointer, 1, 5) ? false : undefined;
    case "integer": {
      const value = numberFixture(schema, true);
      return value === undefined
        ? addUnsupported(
            context,
            "INTEGER_FIXTURE_UNSATISFIABLE",
            "Integer bounds do not admit a deterministic fixture",
            pointer,
          )
        : reserveBudget(
              context,
              pointer,
              1,
              Buffer.byteLength(String(value), "utf8"),
            )
          ? value
          : undefined;
    }
    case "number": {
      const value = numberFixture(schema, false);
      return value === undefined
        ? addUnsupported(
            context,
            "NUMBER_FIXTURE_UNSATISFIABLE",
            "Number bounds do not admit a deterministic fixture",
            pointer,
          )
        : reserveBudget(
              context,
              pointer,
              1,
              Buffer.byteLength(String(value), "utf8"),
            )
          ? value
          : undefined;
    }
    case "string": {
      const value = stringFixture(schema, pointer, context);
      return value === undefined
        ? addUnsupported(
            context,
            "STRING_FIXTURE_UNSATISFIABLE",
            "String bounds do not admit a deterministic fixture",
            pointer,
          )
        : reserveString(value, pointer, context)
          ? value
          : undefined;
    }
    case "array": {
      const prefixItems = Array.isArray(schema["prefixItems"])
        ? (schema["prefixItems"] as readonly JsonSchema[])
        : [];
      const minimum =
        typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
      const maximum =
        typeof schema["maxItems"] === "number"
          ? schema["maxItems"]
          : Number.POSITIVE_INFINITY;
      if (minimum > maximum) {
        return addUnsupported(
          context,
          "ARRAY_FIXTURE_UNSATISFIABLE",
          "Array minItems exceeds maxItems",
          pointer,
        );
      }
      const hasItemSchema =
        prefixItems.length > 0 || schema["items"] !== undefined;
      const desired = Math.max(minimum, hasItemSchema && maximum > 0 ? 1 : 0);
      if (desired > context.maxArrayItems) {
        return addUnsupported(
          context,
          "FIXTURE_ARRAY_LIMIT_EXCEEDED",
          `Fixture requires ${desired} items; maximum is ${context.maxArrayItems}`,
          pointer,
        );
      }
      if (desired > maximum) {
        return addUnsupported(
          context,
          "ARRAY_FIXTURE_UNSATISFIABLE",
          `Fixture requires ${desired} items but maxItems is ${maximum}`,
          pointer,
        );
      }

      if (!reserveBudget(context, pointer, 1, 2)) {
        return undefined;
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < desired; index += 1) {
        if (index > 0 && !reserveBudget(context, pointer, 0, 1)) {
          return undefined;
        }
        const itemSchema =
          prefixItems[index] ??
          (isJsonSchema(schema["items"]) ? schema["items"] : undefined);
        if (itemSchema === undefined) {
          return addUnsupported(
            context,
            "ARRAY_ITEM_SCHEMA_MISSING",
            "Array requires items without an item schema",
            `${pointer}/items`,
          );
        }
        const value = generateValue(
          itemSchema,
          `${pointer}/items/${index}`,
          context,
          depth + 1,
          references,
        );
        if (value === undefined) {
          return undefined;
        }
        result.push(value);
      }
      return result;
    }
    case "object": {
      const properties = isJsonObject(schema["properties"])
        ? schema["properties"]
        : {};
      const required = new Set(
        Array.isArray(schema["required"])
          ? schema["required"].filter(
              (item): item is string => typeof item === "string",
            )
          : [],
      );
      const result: Record<string, JsonValue> = {};
      if (!reserveBudget(context, pointer, 1, 2)) {
        return undefined;
      }
      let propertyIndex = 0;
      for (const name of Object.keys(properties).sort(compareCodeUnits)) {
        if (!required.has(name) && !context.includeOptional) {
          continue;
        }
        if (
          !reserveBudget(
            context,
            pointer,
            0,
            jsonStringBytes(name) + 1 + (propertyIndex === 0 ? 0 : 1),
          )
        ) {
          return undefined;
        }
        const propertySchema = properties[name];
        if (!isJsonSchema(propertySchema)) {
          return addUnsupported(
            context,
            "PROPERTY_SCHEMA_INVALID",
            `Property "${name}" is not a JSON Schema`,
            `${pointer}/properties/${escapePointerToken(name)}`,
          );
        }
        const value = generateValue(
          propertySchema,
          `${pointer}/properties/${escapePointerToken(name)}`,
          context,
          depth + 1,
          references,
        );
        if (value === undefined) {
          return undefined;
        }
        result[name] = value;
        propertyIndex += 1;
      }
      return result;
    }
    default:
      return addUnsupported(
        context,
        "FIXTURE_TYPE_UNSUPPORTED",
        "Schema needs a supported type, union, example, default, const, or enum",
        pointer,
      );
  }
}

function validator(schema: JsonSchema): ValidateFunction | undefined {
  try {
    const dialect =
      isJsonObject(schema) && typeof schema["$schema"] === "string"
        ? schema["$schema"]
        : "";
    const options = {
      allErrors: true,
      allowUnionTypes: true,
      logger: false,
      strict: false,
    } as const;
    const ajv = dialect.includes("draft-07")
      ? new Ajv(options)
      : new Ajv2020(options);
    const addFormats = addFormatsModule.default as unknown as (
      instance: Ajv | Ajv2020,
    ) => Ajv | Ajv2020;
    addFormats(ajv);
    const validationSchema =
      dialect.includes("spec.openapis.org/oas/3.1/dialect") &&
      isJsonObject(schema)
        ? Object.fromEntries(
            Object.entries(schema).filter(([key]) => key !== "$schema"),
          )
        : schema;
    return ajv.compile(
      stripRegexConstraintsForValidation(validationSchema as JsonSchema),
    );
  } catch {
    return undefined;
  }
}

/**
 * Generates one deterministic fixture. Explicit examples, defaults, const,
 * and enum values take precedence over synthesized values.
 */
export function generateFixture(
  schema: JsonSchema,
  options: FixtureGenerationOptions = {},
): FixtureGenerationResult {
  const maxDepth = options.maxDepth ?? 16;
  const maxArrayItems = options.maxArrayItems ?? 20;
  const maxStringLength =
    options.maxStringLength ?? DEFAULT_FIXTURE_LIMITS.maxStringLength;
  const maxOutputBytes =
    options.maxOutputBytes ?? DEFAULT_FIXTURE_LIMITS.maxOutputBytes;
  const maxOutputNodes =
    options.maxOutputNodes ?? DEFAULT_FIXTURE_LIMITS.maxOutputNodes;
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new RangeError("maxDepth must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxArrayItems) || maxArrayItems <= 0) {
    throw new RangeError("maxArrayItems must be a positive safe integer");
  }
  for (const [name, value, hardMaximum] of [
    ["maxStringLength", maxStringLength, HARD_FIXTURE_LIMITS.maxStringLength],
    ["maxOutputBytes", maxOutputBytes, HARD_FIXTURE_LIMITS.maxOutputBytes],
    ["maxOutputNodes", maxOutputNodes, HARD_FIXTURE_LIMITS.maxOutputNodes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > hardMaximum) {
      throw new RangeError(
        `${name} must be a positive safe integer no greater than ${hardMaximum}`,
      );
    }
  }

  const context: FixtureContext = {
    budget: { bytes: 0, nodes: 0 },
    diagnostics: new DiagnosticCollector(100),
    includeOptional: options.includeOptionalProperties ?? true,
    maxArrayItems,
    maxDepth,
    maxOutputBytes,
    maxOutputNodes,
    maxStringLength,
    partial: false,
    root: schema,
  };
  const regexConstraints = countRegexConstraints(schema);
  if (regexConstraints > 0) {
    context.partial = true;
    context.diagnostics.add({
      code: "REGEX_CONSTRAINTS_NOT_EVALUATED",
      details: { count: regexConstraints },
      message:
        "Regex constraints were preserved but not evaluated while validating the fixture",
      severity: "warning",
    });
  }
  const value = generateValue(schema, "", context, 0, []);
  if (value !== undefined) {
    const validate = validator(schema);
    if (validate === undefined) {
      context.diagnostics.add({
        code: "FIXTURE_SCHEMA_COMPILE_FAILED",
        message: "Generated fixture could not be validated against the schema",
        severity: "error",
      });
    } else if (!validate(value)) {
      context.diagnostics.add({
        code: "GENERATED_FIXTURE_INVALID",
        message: `Generated fixture failed validation: ${validate.errors?.[0]?.message ?? "unknown validation error"}`,
        pointer: validate.errors?.[0]?.instancePath ?? "",
        severity: "error",
      });
    } else {
      const sortedValue = sortJsonValue(value);
      const serialized = JSON.stringify(sortedValue);
      const serializedBytes = Buffer.byteLength(serialized, "utf8");
      if (serializedBytes > maxOutputBytes) {
        context.diagnostics.add({
          code: "FIXTURE_OUTPUT_BUDGET_EXCEEDED",
          details: {
            actualBytes: serializedBytes,
            maximumBytes: maxOutputBytes,
          },
          message:
            "Serialized fixture exceeds the configured UTF-8 output budget",
          severity: "error",
        });
        return {
          diagnostics: context.diagnostics.toArray(),
          status: "unsupported",
        };
      }
      return {
        diagnostics: context.diagnostics.toArray(),
        status: context.partial ? "partial" : "generated",
        value: sortedValue,
      };
    }
  }

  return {
    diagnostics: context.diagnostics.toArray(),
    status: "unsupported",
  };
}
