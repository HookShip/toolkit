// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  isJsonSchema,
  unicodeCodePointLength,
  type CanonicalContract,
  type CanonicalEventType,
  type CanonicalEventVersion,
  type CompatibilityChange,
  type CompatibilityChangeKind,
  type CompatibilityResult,
  type CompatibilityStatus,
  type JsonObject,
  type JsonSchema,
  type JsonSchemaType,
  type JsonValue,
} from "@webhook-portal/canonical-model";

import type { DiffOptions } from "./api-types.js";
import {
  compareCodeUnits,
  escapePointerToken,
  jsonEqual,
  sortJsonValue,
  stableStringify,
} from "./json-utils.js";

const DOCUMENTATION_KEYWORDS = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "example",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

const UNSUPPORTED_DIFF_KEYWORDS = new Set([
  "$dynamicRef",
  "$recursiveRef",
  "contains",
  "contentSchema",
  "dependentSchemas",
  "else",
  "if",
  "maxContains",
  "minContains",
  "not",
  "patternProperties",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const FULLY_COMPARED_SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "properties",
  "required",
  "type",
]);

interface DiffContext {
  readonly changes: CompatibilityChange[];
  readonly maximum: number;
  omittedStatus: CompatibilityStatus;
  truncated: boolean;
}

function addChange(
  context: DiffContext,
  change: {
    readonly code: string;
    readonly eventId?: string;
    readonly kind: CompatibilityChangeKind;
    readonly message: string;
    readonly next?: JsonValue;
    readonly pointer: string;
    readonly previous?: JsonValue;
    readonly status: CompatibilityStatus;
  },
): void {
  if (context.changes.length >= context.maximum) {
    context.truncated = true;
    if (
      compatibilityRank(change.status) >
      compatibilityRank(context.omittedStatus)
    ) {
      context.omittedStatus = change.status;
    }
    return;
  }
  context.changes.push(change);
}

function schemaTypeSet(schema: JsonSchema): Set<JsonSchemaType> | undefined {
  if (!isJsonObject(schema)) {
    return undefined;
  }

  const declared = schema["type"];
  if (typeof declared === "string") {
    return new Set([declared as JsonSchemaType]);
  }
  if (Array.isArray(declared)) {
    const types = declared.filter(
      (item): item is JsonSchemaType =>
        item === "array" ||
        item === "boolean" ||
        item === "integer" ||
        item === "null" ||
        item === "number" ||
        item === "object" ||
        item === "string",
    );
    if (types.length !== declared.length) {
      return undefined;
    }
    const result = new Set(types);
    if (result.has("number")) {
      result.delete("integer");
    }
    return result;
  }
  const union = Array.isArray(schema["oneOf"])
    ? schema["oneOf"]
    : Array.isArray(schema["anyOf"])
      ? schema["anyOf"]
      : undefined;
  if (union !== undefined) {
    const combined = new Set<JsonSchemaType>();
    for (const member of union) {
      const memberTypes = schemaTypeSet(member as JsonSchema);
      if (memberTypes === undefined) {
        return undefined;
      }
      memberTypes.forEach((type) => combined.add(type));
    }
    if (combined.has("number")) {
      combined.delete("integer");
    }
    return combined;
  }
  return undefined;
}

function isTypeSubset(
  left: ReadonlySet<JsonSchemaType>,
  right: ReadonlySet<JsonSchemaType>,
): boolean {
  return [...left].every(
    (item) => right.has(item) || (item === "integer" && right.has("number")),
  );
}

function hasCrossTypeConstraint(schema: JsonSchema): boolean {
  if (!isJsonObject(schema)) return true;
  return ["$ref", "allOf", "anyOf", "const", "enum", "if", "not", "oneOf"].some(
    (keyword) => schema[keyword] !== undefined,
  );
}

function jsonSet(values: readonly JsonValue[]): Map<string, JsonValue> {
  return new Map(values.map((value) => [stableStringify(value), value]));
}

function normalizeSetValuedKeywords(
  value: JsonValue,
  parentKey = "",
): JsonValue {
  if (Array.isArray(value)) {
    if (parentKey === "enum") {
      const normalized = value.map((item) => sortJsonValue(item));
      const entries = new Map(
        normalized.map((item) => [stableStringify(item), item]),
      );
      return [...entries.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([, item]) => item);
    }
    const normalized = value.map((item) =>
      normalizeSetValuedKeywords(item, ""),
    );
    if (parentKey === "required" || parentKey === "type") {
      return [
        ...new Set(
          normalized.filter((item): item is string => typeof item === "string"),
        ),
      ].sort(compareCodeUnits);
    }
    return normalized;
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const item = value[key];
    if (item !== undefined) {
      result[key] = normalizeSetValuedKeywords(item, key);
    }
  }
  return result;
}

function unsupportedKeyword(schema: JsonSchema): string | undefined {
  if (!isJsonObject(schema)) {
    return undefined;
  }
  const direct = Object.keys(schema)
    .sort(compareCodeUnits)
    .find((key) => UNSUPPORTED_DIFF_KEYWORDS.has(key));
  if (direct !== undefined) {
    return direct;
  }

  for (const keyword of [
    "$defs",
    "dependentSchemas",
    "patternProperties",
    "properties",
  ]) {
    const definitions = schema[keyword];
    if (isJsonObject(definitions)) {
      for (const child of Object.values(definitions)) {
        if (isJsonSchema(child)) {
          const nested = unsupportedKeyword(child);
          if (nested !== undefined) {
            return nested;
          }
        }
      }
    }
  }

  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const definitions = schema[keyword];
    if (Array.isArray(definitions)) {
      for (const child of definitions) {
        if (isJsonSchema(child)) {
          const nested = unsupportedKeyword(child);
          if (nested !== undefined) {
            return nested;
          }
        }
      }
    }
  }

  for (const keyword of [
    "additionalProperties",
    "contains",
    "contentSchema",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
  ]) {
    const child = schema[keyword];
    if (isJsonSchema(child)) {
      const nested = unsupportedKeyword(child);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

function unclassifiedChangedKeyword(
  previous: JsonObject,
  next: JsonObject,
): string | undefined {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].sort(compareCodeUnits).find((key) => {
    if (
      DOCUMENTATION_KEYWORDS.has(key) ||
      FULLY_COMPARED_SCHEMA_KEYWORDS.has(key)
    ) {
      return false;
    }
    return !jsonEqual(previous[key] ?? null, next[key] ?? null);
  });
}

function withoutDocumentation(schema: JsonSchema): JsonSchema {
  if (!isJsonObject(schema)) {
    return schema;
  }

  const semantic: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!DOCUMENTATION_KEYWORDS.has(key) && value !== undefined) {
      semantic[key] = value;
    }
  }
  return semantic;
}

function finiteValueSet(
  schema: JsonObject,
): Map<string, JsonValue> | undefined {
  let values = Array.isArray(schema["enum"])
    ? jsonSet(schema["enum"])
    : undefined;
  if (schema["const"] !== undefined) {
    const constKey = stableStringify(schema["const"]);
    if (values === undefined) {
      values = new Map([[constKey, schema["const"]]]);
    } else {
      values = values.has(constKey)
        ? new Map([[constKey, schema["const"]]])
        : new Map();
    }
  }
  return values;
}

type FiniteEvaluation = boolean | "unknown";

function matchesSchemaType(value: JsonValue, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return isJsonObject(value);
    default:
      return false;
  }
}

function evaluateFiniteValue(
  value: JsonValue,
  schema: JsonSchema,
  depth = 0,
): FiniteEvaluation {
  if (depth > 32) return "unknown";
  if (schema === true) return true;
  if (schema === false) return false;
  if (schema["$ref"] !== undefined) return "unknown";

  const type = schema["type"];
  if (typeof type === "string" && !matchesSchemaType(value, type)) return false;
  if (
    Array.isArray(type) &&
    !type.some(
      (candidate) =>
        typeof candidate === "string" && matchesSchemaType(value, candidate),
    )
  ) {
    return false;
  }
  if (schema["const"] !== undefined && !jsonEqual(value, schema["const"])) {
    return false;
  }
  if (
    Array.isArray(schema["enum"]) &&
    !schema["enum"].some((candidate) => jsonEqual(value, candidate))
  ) {
    return false;
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const results = branches.map((branch) =>
      isJsonSchema(branch)
        ? evaluateFiniteValue(value, branch, depth + 1)
        : "unknown",
    );
    if (results.includes("unknown")) return "unknown";
    const matches = results.filter((result) => result === true).length;
    if (
      (keyword === "allOf" && matches !== results.length) ||
      (keyword === "anyOf" && matches === 0) ||
      (keyword === "oneOf" && matches !== 1)
    ) {
      return false;
    }
  }

  if (typeof value === "number") {
    if (
      (typeof schema["minimum"] === "number" && value < schema["minimum"]) ||
      (typeof schema["exclusiveMinimum"] === "number" &&
        value <= schema["exclusiveMinimum"]) ||
      (typeof schema["maximum"] === "number" && value > schema["maximum"]) ||
      (typeof schema["exclusiveMaximum"] === "number" &&
        value >= schema["exclusiveMaximum"]) ||
      (typeof schema["multipleOf"] === "number" &&
        value / schema["multipleOf"] !==
          Math.trunc(value / schema["multipleOf"]))
    ) {
      return false;
    }
  }
  if (typeof value === "string") {
    const length = unicodeCodePointLength(value);
    if (
      (typeof schema["minLength"] === "number" &&
        length < schema["minLength"]) ||
      (typeof schema["maxLength"] === "number" && length > schema["maxLength"])
    ) {
      return false;
    }
    if (schema["pattern"] !== undefined || schema["format"] !== undefined) {
      return "unknown";
    }
  }
  if (Array.isArray(value)) {
    if (
      (typeof schema["minItems"] === "number" &&
        value.length < schema["minItems"]) ||
      (typeof schema["maxItems"] === "number" &&
        value.length > schema["maxItems"])
    ) {
      return false;
    }
    if (isJsonSchema(schema["items"])) {
      for (const item of value) {
        const result = evaluateFiniteValue(item, schema["items"], depth + 1);
        if (result !== true) return result;
      }
    }
  }
  if (isJsonObject(value)) {
    const properties = isJsonObject(schema["properties"])
      ? schema["properties"]
      : {};
    const required = Array.isArray(schema["required"])
      ? schema["required"].filter(
          (name): name is string => typeof name === "string",
        )
      : [];
    if (required.some((name) => !Object.hasOwn(value, name))) return false;
    for (const [name, propertySchema] of Object.entries(properties)) {
      const propertyValue = value[name];
      if (propertyValue !== undefined && isJsonSchema(propertySchema)) {
        const result = evaluateFiniteValue(
          propertyValue,
          propertySchema,
          depth + 1,
        );
        if (result !== true) return result;
      }
    }
    for (const [name, propertyValue] of Object.entries(value)) {
      if (propertyValue === undefined || Object.hasOwn(properties, name)) {
        continue;
      }
      if (schema["additionalProperties"] === false) return false;
      if (isJsonSchema(schema["additionalProperties"])) {
        const result = evaluateFiniteValue(
          propertyValue,
          schema["additionalProperties"],
          depth + 1,
        );
        if (result !== true) return result;
      }
    }
  }

  const evaluatedKeywords = new Set([
    "$comment",
    "$schema",
    "additionalProperties",
    "allOf",
    "anyOf",
    "const",
    "default",
    "deprecated",
    "description",
    "enum",
    "examples",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "items",
    "maxItems",
    "maxLength",
    "maximum",
    "minItems",
    "minLength",
    "minimum",
    "multipleOf",
    "oneOf",
    "properties",
    "readOnly",
    "required",
    "title",
    "type",
    "writeOnly",
  ]);
  if (
    Object.keys(schema).some(
      (keyword) => !evaluatedKeywords.has(keyword) && !keyword.startsWith("x-"),
    )
  ) {
    return "unknown";
  }
  return true;
}

function compareFiniteAcceptedValues(
  previous: JsonObject,
  next: JsonObject,
  pointer: string,
  eventId: string,
  context: DiffContext,
): boolean {
  if (previous["const"] === undefined && next["const"] === undefined) {
    return false;
  }
  const previousCandidates = finiteValueSet(previous);
  if (previousCandidates === undefined) return false;
  const acceptedPrevious = new Map<string, JsonValue>();
  for (const [key, value] of previousCandidates) {
    const accepted = evaluateFiniteValue(value, previous);
    if (accepted === "unknown") {
      addChange(context, {
        code: "FINITE_VALUE_INCLUSION_UNKNOWN",
        eventId,
        kind: "constraint-changed",
        message: "Finite-value constraint inclusion cannot be proven",
        pointer,
        status: "unknown",
      });
      return true;
    }
    if (accepted) acceptedPrevious.set(key, value);
  }

  for (const value of acceptedPrevious.values()) {
    const accepted = evaluateFiniteValue(value, next);
    if (accepted === "unknown") {
      addChange(context, {
        code: "FINITE_VALUE_INCLUSION_UNKNOWN",
        eventId,
        kind: "constraint-changed",
        message: "Finite-value constraint inclusion cannot be proven",
        pointer,
        status: "unknown",
      });
      return true;
    }
    if (!accepted) {
      addChange(context, {
        code: "FINITE_VALUE_EXCLUDED",
        eventId,
        kind: "constraint-changed",
        message: "A previously accepted const/enum value is now excluded",
        next: value,
        pointer,
        status: "breaking",
      });
      return true;
    }
  }

  const nextCandidates = finiteValueSet(next);
  if (nextCandidates === undefined) {
    addChange(context, {
      code: "ENUM_WIDENED",
      eventId,
      kind: "constraint-changed",
      message: "Finite const/enum constraints were removed",
      pointer,
      status: "compatible",
    });
  } else {
    let acceptedNextCount = 0;
    for (const value of nextCandidates.values()) {
      const accepted = evaluateFiniteValue(value, next);
      if (accepted === "unknown") return false;
      if (accepted) acceptedNextCount += 1;
    }
    if (acceptedNextCount > acceptedPrevious.size) {
      addChange(context, {
        code: "ENUM_WIDENED",
        eventId,
        kind: "constraint-changed",
        message: "Finite const/enum values were widened",
        pointer,
        status: "compatible",
      });
    }
  }
  return true;
}

function compareFiniteValues(
  previous: JsonObject,
  next: JsonObject,
  pointer: string,
  eventId: string,
  context: DiffContext,
): boolean {
  const previousSet = finiteValueSet(previous);
  const nextSet = finiteValueSet(next);
  if (previousSet === undefined && nextSet === undefined) {
    return false;
  }
  if (previousSet === undefined || nextSet === undefined) {
    addChange(context, {
      code: "ENUM_CONSTRAINT_CHANGED",
      eventId,
      kind: "constraint-changed",
      message: "Finite const/enum constraints were added or removed",
      pointer,
      status: nextSet === undefined ? "compatible" : "breaking",
      ...(nextSet === undefined ? {} : { next: [...nextSet.values()] }),
      ...(previousSet === undefined
        ? {}
        : { previous: [...previousSet.values()] }),
    });
    return true;
  }

  if (
    previousSet.size === nextSet.size &&
    [...previousSet.keys()].every((value) => nextSet.has(value))
  ) {
    return true;
  }

  const nextIsSubset = [...nextSet.keys()].every((value) =>
    previousSet.has(value),
  );
  const previousIsSubset = [...previousSet.keys()].every((value) =>
    nextSet.has(value),
  );
  addChange(context, {
    code: nextIsSubset
      ? "ENUM_NARROWED"
      : previousIsSubset
        ? "ENUM_WIDENED"
        : "ENUM_CHANGED",
    eventId,
    kind: "constraint-changed",
    message: nextIsSubset
      ? "Enumeration values were removed"
      : previousIsSubset
        ? "Enumeration values were added"
        : "Enumeration values changed incompatibly",
    next: [...nextSet.values()],
    pointer,
    previous: [...previousSet.values()],
    status: nextIsSubset
      ? "breaking"
      : previousIsSubset
        ? "compatible"
        : "breaking",
  });
  return true;
}

function compareTypes(
  previous: JsonSchema,
  next: JsonSchema,
  pointer: string,
  eventId: string,
  context: DiffContext,
): void {
  const previousTypes = schemaTypeSet(previous);
  const nextTypes = schemaTypeSet(next);
  if (previousTypes === undefined && nextTypes === undefined) {
    return;
  }
  if (previousTypes === undefined || nextTypes === undefined) {
    if (
      previousTypes === undefined &&
      nextTypes !== undefined &&
      !hasCrossTypeConstraint(previous)
    ) {
      const allJsonTypes = new Set<JsonSchemaType>([
        "array",
        "boolean",
        "null",
        "number",
        "object",
        "string",
      ]);
      if (!isTypeSubset(allJsonTypes, nextTypes)) {
        addChange(context, {
          code: "TYPE_CONSTRAINT_ADDED",
          eventId,
          kind: "type-changed",
          message:
            "An explicit type constraint excludes instances previously accepted by type-specific applicators",
          pointer,
          status: "breaking",
        });
        return;
      }
    }
    addChange(context, {
      code: "TYPE_CLASSIFICATION_UNKNOWN",
      eventId,
      kind: "type-changed",
      message: "Schema type change cannot be classified safely",
      pointer,
      status: "unknown",
    });
    return;
  }
  if (
    previousTypes.size === nextTypes.size &&
    isTypeSubset(previousTypes, nextTypes) &&
    isTypeSubset(nextTypes, previousTypes)
  ) {
    return;
  }

  const nextIsSubset = isTypeSubset(nextTypes, previousTypes);
  const previousIsSubset = isTypeSubset(previousTypes, nextTypes);
  addChange(context, {
    code: nextIsSubset
      ? "TYPE_NARROWED"
      : previousIsSubset
        ? "TYPE_WIDENED"
        : "TYPE_CHANGED",
    eventId,
    kind: "type-changed",
    message: nextIsSubset
      ? "Accepted JSON types were narrowed"
      : previousIsSubset
        ? "Accepted JSON types were widened"
        : "JSON type changed incompatibly",
    next: [...nextTypes].sort(compareCodeUnits),
    pointer,
    previous: [...previousTypes].sort(compareCodeUnits),
    status: nextIsSubset
      ? "breaking"
      : previousIsSubset
        ? "compatible"
        : "breaking",
  });
}

interface NumericBound {
  readonly inclusive: boolean;
  readonly keyword: string;
  readonly value: number;
}

function lowerBound(schema: JsonObject): NumericBound | undefined {
  const inclusive =
    typeof schema["minimum"] === "number"
      ? {
          inclusive: true,
          keyword: "minimum",
          value: schema["minimum"],
        }
      : undefined;
  const exclusive =
    typeof schema["exclusiveMinimum"] === "number"
      ? {
          inclusive: false,
          keyword: "exclusiveMinimum",
          value: schema["exclusiveMinimum"],
        }
      : undefined;
  if (inclusive === undefined) return exclusive;
  if (exclusive === undefined) return inclusive;
  return exclusive.value >= inclusive.value ? exclusive : inclusive;
}

function upperBound(schema: JsonObject): NumericBound | undefined {
  const inclusive =
    typeof schema["maximum"] === "number"
      ? {
          inclusive: true,
          keyword: "maximum",
          value: schema["maximum"],
        }
      : undefined;
  const exclusive =
    typeof schema["exclusiveMaximum"] === "number"
      ? {
          inclusive: false,
          keyword: "exclusiveMaximum",
          value: schema["exclusiveMaximum"],
        }
      : undefined;
  if (inclusive === undefined) return exclusive;
  if (exclusive === undefined) return inclusive;
  return exclusive.value <= inclusive.value ? exclusive : inclusive;
}

function compareNumericBound(
  previous: NumericBound | undefined,
  next: NumericBound | undefined,
  direction: "lower" | "upper",
  pointer: string,
  eventId: string,
  context: DiffContext,
): void {
  if (
    previous?.value === next?.value &&
    previous?.inclusive === next?.inclusive
  ) {
    return;
  }
  let narrowed: boolean;
  if (previous === undefined) {
    narrowed = true;
  } else if (next === undefined) {
    narrowed = false;
  } else if (previous.value === next.value) {
    narrowed = previous.inclusive && !next.inclusive;
  } else {
    narrowed =
      direction === "lower"
        ? next.value > previous.value
        : next.value < previous.value;
  }
  addChange(context, {
    code: `${direction === "lower" ? "MINIMUM" : "MAXIMUM"}_${narrowed ? "NARROWED" : "WIDENED"}`,
    eventId,
    kind: "constraint-changed",
    message: `${direction === "lower" ? "Lower" : "Upper"} numeric bound became ${narrowed ? "more" : "less"} restrictive`,
    pointer: `${pointer}/${next?.keyword ?? previous?.keyword ?? ""}`,
    status: narrowed ? "breaking" : "compatible",
    ...(next === undefined
      ? {}
      : { next: { inclusive: next.inclusive, value: next.value } }),
    ...(previous === undefined
      ? {}
      : {
          previous: {
            inclusive: previous.inclusive,
            value: previous.value,
          },
        }),
  });
}

function compareBounds(
  previous: JsonObject,
  next: JsonObject,
  pointer: string,
  eventId: string,
  context: DiffContext,
): void {
  compareNumericBound(
    lowerBound(previous),
    lowerBound(next),
    "lower",
    pointer,
    eventId,
    context,
  );
  compareNumericBound(
    upperBound(previous),
    upperBound(next),
    "upper",
    pointer,
    eventId,
    context,
  );
  const constraints = [
    {
      direction: "minimum",
      next:
        typeof next["minLength"] === "number" ? next["minLength"] : undefined,
      previous:
        typeof previous["minLength"] === "number"
          ? previous["minLength"]
          : undefined,
    },
    {
      direction: "maximum",
      next:
        typeof next["maxLength"] === "number" ? next["maxLength"] : undefined,
      previous:
        typeof previous["maxLength"] === "number"
          ? previous["maxLength"]
          : undefined,
    },
    {
      direction: "minimum",
      next: typeof next["minItems"] === "number" ? next["minItems"] : undefined,
      previous:
        typeof previous["minItems"] === "number"
          ? previous["minItems"]
          : undefined,
    },
    {
      direction: "maximum",
      next: typeof next["maxItems"] === "number" ? next["maxItems"] : undefined,
      previous:
        typeof previous["maxItems"] === "number"
          ? previous["maxItems"]
          : undefined,
    },
  ] as const;

  for (const constraint of constraints) {
    if (constraint.previous === constraint.next) {
      continue;
    }
    const narrowed =
      constraint.next !== undefined &&
      (constraint.previous === undefined ||
        (constraint.direction === "minimum"
          ? constraint.next > constraint.previous
          : constraint.next < constraint.previous));
    addChange(context, {
      code: narrowed ? "CONSTRAINT_NARROWED" : "CONSTRAINT_WIDENED",
      eventId,
      kind: "constraint-changed",
      message: narrowed
        ? "Schema constraint became more restrictive"
        : "Schema constraint became less restrictive",
      pointer,
      status: narrowed ? "breaking" : "compatible",
      ...(constraint.next === undefined ? {} : { next: constraint.next }),
      ...(constraint.previous === undefined
        ? {}
        : { previous: constraint.previous }),
    });
  }
}

function compareObjects(
  previous: JsonObject,
  next: JsonObject,
  pointer: string,
  eventId: string,
  context: DiffContext,
): void {
  const previousProperties = isJsonObject(previous["properties"])
    ? previous["properties"]
    : {};
  const nextProperties = isJsonObject(next["properties"])
    ? next["properties"]
    : {};
  const previousRequired = new Set(
    Array.isArray(previous["required"])
      ? previous["required"].filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const nextRequired = new Set(
    Array.isArray(next["required"])
      ? next["required"].filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );

  const propertyNames = new Set([
    ...Object.keys(previousProperties),
    ...Object.keys(nextProperties),
    ...previousRequired,
    ...nextRequired,
  ]);
  for (const name of [...propertyNames].sort(compareCodeUnits)) {
    const propertyPointer = `${pointer}/properties/${escapePointerToken(name)}`;
    const before = previousProperties[name];
    const after = nextProperties[name];
    if (previousRequired.has(name) !== nextRequired.has(name)) {
      addChange(context, {
        code: nextRequired.has(name)
          ? "PROPERTY_BECAME_REQUIRED"
          : "PROPERTY_BECAME_OPTIONAL",
        eventId,
        kind: "required-changed",
        message: `Property "${name}" became ${nextRequired.has(name) ? "required" : "optional"}`,
        next: nextRequired.has(name),
        pointer: `${pointer}/required`,
        previous: previousRequired.has(name),
        status: nextRequired.has(name) ? "breaking" : "compatible",
      });
    }
    if (before === undefined && after !== undefined) {
      const required = nextRequired.has(name);
      const unsupported = unsupportedKeyword(after as JsonSchema);
      const previousAdditional = previous["additionalProperties"];
      const optionalStatus: CompatibilityStatus =
        previousAdditional === false
          ? "compatible"
          : previousAdditional === undefined || previousAdditional === true
            ? after === true
              ? "compatible"
              : "breaking"
            : jsonEqual(previousAdditional, after)
              ? "compatible"
              : "unknown";
      addChange(context, {
        code:
          unsupported === undefined
            ? required
              ? "REQUIRED_PROPERTY_ADDED"
              : optionalStatus === "breaking"
                ? "OPTIONAL_PROPERTY_CONFLICT"
                : optionalStatus === "unknown"
                  ? "OPTIONAL_PROPERTY_INCLUSION_UNKNOWN"
                  : "OPTIONAL_PROPERTY_ADDED"
            : "PROPERTY_SCHEMA_UNSUPPORTED",
        eventId,
        kind: "property-added",
        message:
          unsupported === undefined
            ? `${required ? "Required" : "Optional"} property "${name}" was added`
            : `Property "${name}" uses unsupported schema keyword "${unsupported}"`,
        next: after,
        pointer: propertyPointer,
        status:
          unsupported === undefined
            ? required
              ? "breaking"
              : optionalStatus
            : "unknown",
      });
      continue;
    }
    if (before !== undefined && after === undefined) {
      const nextAdditional = next["additionalProperties"];
      const status: CompatibilityStatus =
        nextAdditional === undefined || nextAdditional === true
          ? "compatible"
          : nextAdditional === false
            ? "breaking"
            : jsonEqual(before, nextAdditional)
              ? "compatible"
              : "unknown";
      addChange(context, {
        code:
          status === "compatible"
            ? previousRequired.has(name)
              ? "REQUIRED_PROPERTY_REMOVED"
              : "PROPERTY_CONSTRAINT_REMOVED"
            : status === "breaking"
              ? "PROPERTY_REMOVED"
              : "PROPERTY_REMOVAL_INCLUSION_UNKNOWN",
        eventId,
        kind: "property-removed",
        message: `Property "${name}" was removed`,
        pointer: propertyPointer,
        previous: before,
        status,
      });
      continue;
    }
    if (before !== undefined && after !== undefined) {
      compareSchema(
        before as JsonSchema,
        after as JsonSchema,
        propertyPointer,
        eventId,
        context,
      );
    }
  }

  const beforeAdditional = previous["additionalProperties"];
  const afterAdditional = next["additionalProperties"];
  const beforePolicy =
    beforeAdditional === undefined || beforeAdditional === true
      ? "open"
      : beforeAdditional === false
        ? "closed"
        : "schema";
  const afterPolicy =
    afterAdditional === undefined || afterAdditional === true
      ? "open"
      : afterAdditional === false
        ? "closed"
        : "schema";
  if (beforePolicy === afterPolicy) {
    if (
      beforePolicy === "schema" &&
      isJsonSchema(beforeAdditional) &&
      isJsonSchema(afterAdditional)
    ) {
      compareSchema(
        beforeAdditional,
        afterAdditional,
        `${pointer}/additionalProperties`,
        eventId,
        context,
      );
    }
  } else if (
    beforePolicy === "closed" &&
    (afterPolicy === "open" || afterPolicy === "schema")
  ) {
    addChange(context, {
      code: "ADDITIONAL_PROPERTIES_ALLOWED",
      eventId,
      kind: "constraint-changed",
      message: "Additional object properties became allowed",
      pointer: `${pointer}/additionalProperties`,
      status: "compatible",
    });
  } else if (
    (beforePolicy === "open" || beforePolicy === "schema") &&
    afterPolicy === "closed"
  ) {
    addChange(context, {
      code: "ADDITIONAL_PROPERTIES_FORBIDDEN",
      eventId,
      kind: "constraint-changed",
      message: "Additional object properties became forbidden",
      pointer: `${pointer}/additionalProperties`,
      status: "breaking",
    });
  } else if (beforePolicy === "open" && afterPolicy === "schema") {
    addChange(context, {
      code: "ADDITIONAL_PROPERTIES_RESTRICTED",
      eventId,
      kind: "constraint-changed",
      message: "Additional properties became schema-constrained",
      pointer: `${pointer}/additionalProperties`,
      status: "breaking",
    });
  } else if (beforePolicy === "schema" && afterPolicy === "open") {
    addChange(context, {
      code: "ADDITIONAL_PROPERTIES_WIDENED",
      eventId,
      kind: "constraint-changed",
      message: "Schema-constrained additional properties became unrestricted",
      pointer: `${pointer}/additionalProperties`,
      status: "compatible",
    });
  }
}

function compareArrays(
  previous: JsonObject,
  next: JsonObject,
  pointer: string,
  eventId: string,
  context: DiffContext,
): void {
  if (isJsonSchema(previous["items"]) && isJsonSchema(next["items"])) {
    compareSchema(
      previous["items"],
      next["items"],
      `${pointer}/items`,
      eventId,
      context,
    );
  } else if (!jsonEqual(previous["items"] ?? null, next["items"] ?? null)) {
    addChange(context, {
      code: "ARRAY_ITEMS_CHANGED",
      eventId,
      kind: "schema-changed",
      message: "Array item schema changed in an unsupported way",
      pointer: `${pointer}/items`,
      status: "unknown",
    });
  }
}

function compareSchema(
  previous: JsonSchema,
  next: JsonSchema,
  pointer: string,
  eventId: string,
  context: DiffContext,
): void {
  const initialChangeCount = context.changes.length;
  if (jsonEqual(previous, next)) {
    return;
  }
  if (
    jsonEqual(
      normalizeSetValuedKeywords(previous),
      normalizeSetValuedKeywords(next),
    )
  ) {
    return;
  }
  if (jsonEqual(withoutDocumentation(previous), withoutDocumentation(next))) {
    addChange(context, {
      code: "SCHEMA_DOCUMENTATION_CHANGED",
      eventId,
      kind: "documentation-changed",
      message: "Schema documentation or examples changed",
      pointer,
      status: "docs-only",
    });
    return;
  }

  if (typeof previous === "boolean" || typeof next === "boolean") {
    addChange(context, {
      code:
        previous === true && next === false
          ? "SCHEMA_NARROWED"
          : previous === false && next === true
            ? "SCHEMA_WIDENED"
            : "BOOLEAN_SCHEMA_CHANGED",
      eventId,
      kind: "schema-changed",
      message: "Boolean JSON Schema changed",
      next,
      pointer,
      previous,
      status: previous === false && next === true ? "compatible" : "breaking",
    });
    return;
  }

  const unsupported = unsupportedKeyword(previous) ?? unsupportedKeyword(next);
  if (unsupported !== undefined) {
    addChange(context, {
      code: "UNSUPPORTED_SCHEMA_DIFF",
      eventId,
      kind: "schema-changed",
      message: `Cannot safely classify schema keyword "${unsupported}"`,
      pointer: `${pointer}/${escapePointerToken(unsupported)}`,
      status: "unknown",
    });
    return;
  }

  if (compareFiniteAcceptedValues(previous, next, pointer, eventId, context)) {
    return;
  }

  const enumHandled = compareFiniteValues(
    previous,
    next,
    pointer,
    eventId,
    context,
  );
  compareTypes(previous, next, pointer, eventId, context);
  compareBounds(previous, next, pointer, eventId, context);

  const previousTypes = schemaTypeSet(previous);
  const nextTypes = schemaTypeSet(next);
  const hasObjectApplicators = [
    "additionalProperties",
    "properties",
    "required",
  ].some(
    (keyword) => previous[keyword] !== undefined || next[keyword] !== undefined,
  );
  if (
    hasObjectApplicators &&
    (previousTypes === undefined || previousTypes.has("object")) &&
    (nextTypes === undefined || nextTypes.has("object"))
  ) {
    compareObjects(previous, next, pointer, eventId, context);
  }
  const hasArrayApplicators = ["items", "prefixItems"].some(
    (keyword) => previous[keyword] !== undefined || next[keyword] !== undefined,
  );
  if (
    hasArrayApplicators &&
    (previousTypes === undefined || previousTypes.has("array")) &&
    (nextTypes === undefined || nextTypes.has("array"))
  ) {
    compareArrays(previous, next, pointer, eventId, context);
  }

  const previousUnion = previous["oneOf"] ?? previous["anyOf"];
  const nextUnion = next["oneOf"] ?? next["anyOf"];
  if (
    !enumHandled &&
    (previousUnion !== undefined || nextUnion !== undefined) &&
    !jsonEqual(previousUnion ?? null, nextUnion ?? null) &&
    (previousTypes === undefined || nextTypes === undefined)
  ) {
    addChange(context, {
      code: "UNION_CHANGE_UNKNOWN",
      eventId,
      kind: "schema-changed",
      message: "Complex union change cannot be classified safely",
      pointer,
      status: "unknown",
    });
  }

  const unclassified = unclassifiedChangedKeyword(previous, next);
  if (unclassified !== undefined) {
    addChange(context, {
      code: "UNCLASSIFIED_SCHEMA_KEYWORD_CHANGED",
      eventId,
      kind: "schema-changed",
      message: `Schema keyword "${unclassified}" changed and cannot be classified safely`,
      pointer: `${pointer}/${escapePointerToken(unclassified)}`,
      status: "unknown",
    });
  } else if (context.changes.length === initialChangeCount && !enumHandled) {
    addChange(context, {
      code: "SCHEMA_CHANGE_UNKNOWN",
      eventId,
      kind: "schema-changed",
      message: "Schema changed in a way that cannot be classified safely",
      pointer,
      status: "unknown",
    });
  }
}

function docsChanged(
  previous: CanonicalEventType | CanonicalEventVersion,
  next: CanonicalEventType | CanonicalEventVersion,
): boolean {
  return (
    previous.title !== next.title ||
    previous.description !== next.description ||
    ("examples" in previous &&
      "examples" in next &&
      !jsonEqual(
        previous.examples as unknown as JsonValue,
        next.examples as unknown as JsonValue,
      )) ||
    ("deprecation" in previous &&
      "deprecation" in next &&
      !jsonEqual(
        (previous.deprecation ?? null) as unknown as JsonValue,
        (next.deprecation ?? null) as unknown as JsonValue,
      ))
  );
}

function compareVersion(
  previous: CanonicalEventVersion,
  next: CanonicalEventVersion,
  event: CanonicalEventType,
  pointer: string,
  context: DiffContext,
  compareIdentity: boolean,
): void {
  if (previous.schema.dialect !== next.schema.dialect) {
    addChange(context, {
      code: "SCHEMA_DIALECT_CHANGED",
      eventId: event.id,
      kind: "schema-changed",
      message: `Schema dialect changed from "${previous.schema.dialect}" to "${next.schema.dialect}"`,
      next: next.schema.dialect,
      pointer: `${pointer}/schema/dialect`,
      previous: previous.schema.dialect,
      status: "unknown",
    });
  }
  compareSchema(
    previous.schema.value,
    next.schema.value,
    `${pointer}/schema/value`,
    event.id,
    context,
  );
  if (compareIdentity && previous.id !== next.id) {
    addChange(context, {
      code: "EVENT_VERSION_ID_CHANGED",
      eventId: event.id,
      kind: "schema-changed",
      message: `Stable version ID changed for "${event.externalName}"`,
      pointer: `${pointer}/id`,
      status: "unknown",
    });
  }
  if (
    !jsonEqual(
      (previous.extensions ?? null) as JsonValue,
      (next.extensions ?? null) as JsonValue,
    )
  ) {
    addChange(context, {
      code: "EVENT_VERSION_EXTENSIONS_CHANGED",
      eventId: event.id,
      kind: "schema-changed",
      message: `Source-standard extensions changed for "${event.externalName}"`,
      pointer: `${pointer}/extensions`,
      status: "unknown",
    });
  }
  if (
    !jsonEqual(
      (previous.signatureProfile ?? null) as unknown as JsonValue,
      (next.signatureProfile ?? null) as unknown as JsonValue,
    )
  ) {
    addChange(context, {
      code: "SIGNATURE_PROFILE_CHANGED",
      eventId: event.id,
      kind: "signature-changed",
      message: `Signature profile changed for "${event.externalName}"`,
      pointer: `${pointer}/signatureProfile`,
      status: "breaking",
    });
  }
  if (docsChanged(previous, next)) {
    addChange(context, {
      code: "EVENT_VERSION_DOCUMENTATION_CHANGED",
      eventId: event.id,
      kind: "documentation-changed",
      message: `Documentation changed for "${event.externalName}"`,
      pointer,
      status: "docs-only",
    });
  }
}

function compatibilityRank(status: CompatibilityStatus): number {
  switch (status) {
    case "breaking":
      return 3;
    case "unknown":
      return 2;
    case "compatible":
      return 1;
    case "docs-only":
      return 0;
  }
}

function resultStatus(
  changes: readonly CompatibilityChange[],
): CompatibilityStatus {
  if (changes.some(({ status }) => status === "breaking")) {
    return "breaking";
  }
  if (changes.some(({ status }) => status === "unknown")) {
    return "unknown";
  }
  if (changes.some(({ status }) => status === "compatible")) {
    return "compatible";
  }
  return "docs-only";
}

export function diffContracts(
  previous: CanonicalContract,
  next: CanonicalContract,
  options: DiffOptions = {},
): CompatibilityResult {
  const maximum = options.maxChanges ?? 1_000;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError("maxChanges must be a positive safe integer");
  }

  const context: DiffContext = {
    changes: [],
    maximum,
    omittedStatus: "docs-only",
    truncated: false,
  };
  const previousEvents = new Map(
    previous.eventTypes.map((event) => [event.externalName, event]),
  );
  const nextEvents = new Map(
    next.eventTypes.map((event) => [event.externalName, event]),
  );
  const eventNames = new Set([...previousEvents.keys(), ...nextEvents.keys()]);

  for (const name of [...eventNames].sort(compareCodeUnits)) {
    const before = previousEvents.get(name);
    const after = nextEvents.get(name);
    const pointer = `/eventTypes/${escapePointerToken(name)}`;
    if (before === undefined && after !== undefined) {
      const unsupported = after.versions
        .map((version) => unsupportedKeyword(version.schema.value))
        .find((keyword) => keyword !== undefined);
      addChange(context, {
        code:
          unsupported === undefined
            ? "EVENT_ADDED"
            : "EVENT_SCHEMA_UNSUPPORTED",
        eventId: after.id,
        kind: "event-added",
        message:
          unsupported === undefined
            ? `Event "${name}" was added`
            : `Event "${name}" uses unsupported schema keyword "${unsupported}"`,
        pointer,
        status: unsupported === undefined ? "compatible" : "unknown",
      });
      continue;
    }
    if (before !== undefined && after === undefined) {
      addChange(context, {
        code: "EVENT_REMOVED",
        eventId: before.id,
        kind: "event-removed",
        message: `Event "${name}" was removed`,
        pointer,
        status: "breaking",
      });
      continue;
    }
    if (before === undefined || after === undefined) {
      continue;
    }

    if (docsChanged(before, after)) {
      addChange(context, {
        code: "EVENT_DOCUMENTATION_CHANGED",
        eventId: after.id,
        kind: "documentation-changed",
        message: `Documentation changed for event "${name}"`,
        pointer,
        status: "docs-only",
      });
    }
    if (before.id !== after.id) {
      addChange(context, {
        code: "EVENT_ID_CHANGED",
        eventId: after.id,
        kind: "schema-changed",
        message: `Stable event ID changed for "${name}"`,
        pointer: `${pointer}/id`,
        status: "unknown",
      });
    }
    if (
      !jsonEqual(
        (before.extensions ?? null) as JsonValue,
        (after.extensions ?? null) as JsonValue,
      )
    ) {
      addChange(context, {
        code: "EVENT_EXTENSIONS_CHANGED",
        eventId: after.id,
        kind: "schema-changed",
        message: `Source-standard extensions changed for event "${name}"`,
        pointer: `${pointer}/extensions`,
        status: "unknown",
      });
    }

    const previousVersions = new Map(
      before.versions.map((version) => [version.publicVersion, version]),
    );
    const nextVersions = new Map(
      after.versions.map((version) => [version.publicVersion, version]),
    );
    const added = after.versions.filter(
      (version) => !previousVersions.has(version.publicVersion),
    );
    const removed = before.versions.filter(
      (version) => !nextVersions.has(version.publicVersion),
    );

    for (const version of removed) {
      if (added.length > 0) continue;
      addChange(context, {
        code: "EVENT_VERSION_REMOVED",
        eventId: before.id,
        kind: "version-removed",
        message: `Event "${name}" version "${version.publicVersion}" was removed`,
        pointer: `${pointer}/versions/${escapePointerToken(version.publicVersion)}`,
        status: "breaking",
      });
    }

    for (const version of added) {
      addChange(context, {
        code: "EVENT_VERSION_ADDED",
        eventId: after.id,
        kind: "version-added",
        message: `Event "${name}" version "${version.publicVersion}" was added`,
        pointer: `${pointer}/versions/${escapePointerToken(version.publicVersion)}`,
        status: "compatible",
      });
    }

    for (const [versionName, beforeVersion] of previousVersions) {
      const afterVersion = nextVersions.get(versionName);
      if (afterVersion !== undefined) {
        compareVersion(
          beforeVersion,
          afterVersion,
          after,
          `${pointer}/versions/${escapePointerToken(versionName)}`,
          context,
          true,
        );
      }
    }

    if (added.length > 0) {
      if (before.versions.length === 1 && added.length === 1) {
        compareVersion(
          before.versions[0] as CanonicalEventVersion,
          added[0] as CanonicalEventVersion,
          after,
          `${pointer}/versions/${escapePointerToken(added[0]?.publicVersion ?? "")}`,
          context,
          false,
        );
      } else {
        addChange(context, {
          code: "VERSION_COMPARISON_AMBIGUOUS",
          eventId: after.id,
          kind: "schema-changed",
          message:
            "Cannot select a prior/current public version without explicit current-version metadata",
          next: added.map(({ publicVersion }) => publicVersion),
          pointer: `${pointer}/versions`,
          previous: before.versions.map(({ publicVersion }) => publicVersion),
          status: "unknown",
        });
      }
    }
  }

  if (
    !jsonEqual(
      (previous.signatureProfile ?? null) as unknown as JsonValue,
      (next.signatureProfile ?? null) as unknown as JsonValue,
    )
  ) {
    addChange(context, {
      code: "CONTRACT_SIGNATURE_PROFILE_CHANGED",
      kind: "signature-changed",
      message: "Contract signature profile changed",
      pointer: "/signatureProfile",
      status: "breaking",
    });
  }

  if (previous.title !== next.title || previous.version !== next.version) {
    addChange(context, {
      code: "CONTRACT_DOCUMENTATION_CHANGED",
      kind: "documentation-changed",
      message: "Contract title or display version changed",
      pointer: "",
      status: "docs-only",
    });
  }
  if (
    previous.source.format !== next.source.format ||
    previous.source.specificationVersion !== next.source.specificationVersion
  ) {
    addChange(context, {
      code: "SOURCE_SPECIFICATION_CHANGED",
      kind: "schema-changed",
      message: "Source specification format or version changed",
      pointer: "/source",
      status: "unknown",
    });
  }
  if (
    !jsonEqual(
      (previous.extensions ?? null) as JsonValue,
      (next.extensions ?? null) as JsonValue,
    )
  ) {
    addChange(context, {
      code: "CONTRACT_EXTENSIONS_CHANGED",
      kind: "schema-changed",
      message: "Contract source-standard extensions changed",
      pointer: "/extensions",
      status: "unknown",
    });
  }

  if (context.truncated) {
    const replaced = context.changes.at(-1);
    const status =
      replaced !== undefined &&
      compatibilityRank(replaced.status) >
        compatibilityRank(context.omittedStatus)
        ? replaced.status
        : context.omittedStatus;
    const truncated: CompatibilityChange = {
      code: "DIFF_TRUNCATED",
      kind: "schema-changed",
      message: `Diff exceeded the ${maximum} change limit`,
      pointer: "",
      status,
    };
    context.changes[context.changes.length - 1] = truncated;
  }

  const status = resultStatus(context.changes);
  const counts = context.changes.reduce(
    (result, change) => {
      result[change.status] += 1;
      return result;
    },
    { breaking: 0, compatible: 0, "docs-only": 0, unknown: 0 },
  );
  return {
    changes: context.changes,
    nextChecksum: next.checksum,
    previousChecksum: previous.checksum,
    status,
    summary:
      context.changes.length === 0
        ? "No semantic changes"
        : `${counts.breaking} breaking, ${counts.compatible} compatible, ${counts["docs-only"]} documentation-only, ${counts.unknown} unknown change(s)`,
  };
}
