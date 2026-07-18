// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  isJsonSchema,
  type JsonObject,
  type JsonSchema,
  type JsonSchemaType,
  type JsonValue,
} from "@webhook-portal/canonical-model";

import type {
  TypeGenerationOptions,
  TypeGenerationResult,
} from "./api-types.js";
import { DiagnosticCollector } from "./diagnostics.js";
import { compareCodeUnits, escapePointerToken } from "./json-utils.js";
import { resolveJsonPointer } from "./refs.js";

const UNSUPPORTED_TYPE_KEYWORDS = [
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

const VALIDATION_ONLY_KEYWORDS = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxLength",
  "maxProperties",
  "maximum",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "uniqueItems",
]);

interface TypeContext {
  readonly diagnostics: DiagnosticCollector;
  readonly maxDepth: number;
  readonly root: JsonSchema;
  degraded: boolean;
}

function degrade(
  context: TypeContext,
  code: string,
  message: string,
  pointer: string,
): "unknown" {
  context.degraded = true;
  context.diagnostics.add({
    code,
    message,
    pointer,
    severity: "warning",
  });
  return "unknown";
}

function identifier(value: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(value) ? value : JSON.stringify(value);
}

function typeName(value: string | undefined): string {
  const raw = value?.trim() || "WebhookPayload";
  const normalized = raw
    .replace(/[^\p{L}\p{N}_$]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
  const candidate = normalized || "WebhookPayload";
  return /^[A-Za-z_$]/u.test(candidate) ? candidate : `Payload${candidate}`;
}

function literalType(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `readonly [${value.map((item) => literalType(item)).join(", ")}]`;
  }
  if (!isJsonObject(value)) {
    return "unknown";
  }

  const fields = Object.keys(value)
    .sort(compareCodeUnits)
    .flatMap((key) => {
      const item = value[key];
      return item === undefined
        ? []
        : [`readonly ${identifier(key)}: ${literalType(item)};`];
    });
  return fields.length === 0
    ? "Readonly<Record<string, unknown>>"
    : `{ ${fields.join(" ")} }`;
}

function complexConstType(
  value: JsonObject | readonly JsonValue[],
  pointer: string,
  context: TypeContext,
): string {
  degrade(
    context,
    "CONST_COMPLEX_VALUE_APPROXIMATED",
    "TypeScript cannot represent exact object or array const equality",
    `${pointer}/const`,
  );
  if (Array.isArray(value)) {
    return literalType(value);
  }
  if (!isJsonObject(value) || Object.keys(value).length === 0) {
    return "Readonly<Record<string, unknown>>";
  }
  return `${literalType(value)} & Readonly<Record<string, unknown>>`;
}

function declaredTypes(schema: JsonObject): readonly JsonSchemaType[] {
  if (typeof schema["type"] === "string") {
    return [schema["type"] as JsonSchemaType];
  }
  if (Array.isArray(schema["type"])) {
    return schema["type"].filter(
      (item): item is JsonSchemaType =>
        item === "array" ||
        item === "boolean" ||
        item === "integer" ||
        item === "null" ||
        item === "number" ||
        item === "object" ||
        item === "string",
    );
  }
  return [];
}

function unique(types: readonly string[]): string[] {
  return [...new Set(types)];
}

function parenthesize(type: string): string {
  return type.includes(" | ") || type.includes(" & ") ? `(${type})` : type;
}

function intersectWithSiblings(
  primary: string,
  schema: JsonObject,
  consumed: ReadonlySet<string>,
  pointer: string,
  context: TypeContext,
  depth: number,
  references: readonly string[],
): string {
  const siblings: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(schema)) {
    if (
      item !== undefined &&
      !consumed.has(key) &&
      !ANNOTATION_KEYWORDS.has(key)
    ) {
      siblings[key] = item;
    }
  }
  if (Object.keys(siblings).length === 0) {
    return primary;
  }
  const sibling = schemaType(siblings, pointer, context, depth + 1, references);
  return sibling === "unknown"
    ? primary
    : `${parenthesize(primary)} & ${parenthesize(sibling)}`;
}

function markValidationOnlyConstraints(
  schema: JsonObject,
  pointer: string,
  context: TypeContext,
): void {
  const omitted = Object.keys(schema)
    .filter((key) => VALIDATION_ONLY_KEYWORDS.has(key))
    .sort(compareCodeUnits);
  if (omitted.length > 0) {
    degrade(
      context,
      "TYPE_CONSTRAINTS_OMITTED",
      `TypeScript cannot express JSON Schema constraint(s): ${omitted.join(", ")}`,
      pointer,
    );
  }
}

function objectType(
  schema: JsonObject,
  pointer: string,
  context: TypeContext,
  depth: number,
  references: readonly string[],
): string {
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
  const fields: string[] = [];
  const propertyNames = new Set([...Object.keys(properties), ...required]);
  let hasOptionalProperties = false;
  for (const name of [...propertyNames].sort(compareCodeUnits)) {
    const propertySchema = properties[name];
    const propertyPointer = `${pointer}/properties/${escapePointerToken(name)}`;
    const generated =
      propertySchema === undefined
        ? degrade(
            context,
            "UNDECLARED_REQUIRED_PROPERTY",
            `Required property "${name}" has no declared schema and degrades to unknown`,
            `${pointer}/required`,
          )
        : isJsonSchema(propertySchema)
          ? schemaType(
              propertySchema,
              propertyPointer,
              context,
              depth + 1,
              references,
            )
          : degrade(
              context,
              "PROPERTY_TYPE_UNSUPPORTED",
              `Property "${name}" is not a JSON Schema`,
              propertyPointer,
            );
    hasOptionalProperties ||= !required.has(name);
    fields.push(
      `readonly ${identifier(name)}${required.has(name) ? "" : "?"}: ${generated};`,
    );
  }
  if (hasOptionalProperties) {
    degrade(
      context,
      "OPTIONAL_PROPERTY_APPROXIMATED",
      "TypeScript optional properties may admit explicit undefined values",
      pointer,
    );
  }

  const object = fields.length === 0 ? "{}" : `{ ${fields.join(" ")} }`;
  const additional = schema["additionalProperties"];
  if (additional === undefined || additional === true) {
    degrade(
      context,
      "OPEN_OBJECT_VALUE_APPROXIMATED",
      "Open object values degrade to unknown because TypeScript has no native JSON-value primitive",
      `${pointer}/additionalProperties`,
    );
    return `${object} & Record<string, unknown>`;
  }
  if (isJsonSchema(additional)) {
    const valueType = schemaType(
      additional,
      `${pointer}/additionalProperties`,
      context,
      depth + 1,
      references,
    );
    if (fields.length === 0) {
      return `Record<string, ${valueType}>`;
    }
    degrade(
      context,
      "ADDITIONAL_PROPERTIES_TYPE_APPROXIMATED",
      "Typed additionalProperties with fixed properties cannot be represented exactly in TypeScript",
      `${pointer}/additionalProperties`,
    );
    return `${object} & Record<string, unknown>`;
  }
  degrade(
    context,
    "CLOSED_OBJECT_APPROXIMATED",
    "TypeScript structural object types cannot forbid all undeclared properties",
    `${pointer}/additionalProperties`,
  );
  return object;
}

function arrayType(
  schema: JsonObject,
  pointer: string,
  context: TypeContext,
  depth: number,
  references: readonly string[],
): string {
  const prefixItems = Array.isArray(schema["prefixItems"])
    ? (schema["prefixItems"] as readonly JsonSchema[])
    : [];
  if (prefixItems.length > 0) {
    const minimum =
      typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
    const maximum =
      typeof schema["maxItems"] === "number"
        ? schema["maxItems"]
        : Number.POSITIVE_INFINITY;
    if (minimum > maximum) {
      return "never";
    }
    if (maximum === 0) {
      return "readonly []";
    }
    const effectivePrefix = prefixItems.slice(
      0,
      Number.isFinite(maximum) ? maximum : prefixItems.length,
    );
    const members = effectivePrefix.map((item, index) => {
      const generated = schemaType(
        item,
        `${pointer}/prefixItems/${index}`,
        context,
        depth + 1,
        references,
      );
      return index < minimum ? generated : `${parenthesize(generated)}?`;
    });
    const trailing = schema["items"];
    if (trailing === false && minimum > prefixItems.length) {
      return "never";
    }
    if (trailing === false || maximum <= prefixItems.length) {
      return `readonly [${members.join(", ")}]`;
    }
    const rest =
      trailing === undefined || trailing === true
        ? degrade(
            context,
            "PREFIX_ITEMS_UNCONSTRAINED_TAIL",
            "Unconstrained trailing tuple items degrade to unknown",
            `${pointer}/items`,
          )
        : isJsonSchema(trailing)
          ? schemaType(
              trailing,
              `${pointer}/items`,
              context,
              depth + 1,
              references,
            )
          : degrade(
              context,
              "ARRAY_ITEMS_UNSUPPORTED",
              "Trailing items are not a JSON Schema",
              `${pointer}/items`,
            );
    if (minimum > prefixItems.length || Number.isFinite(maximum)) {
      degrade(
        context,
        "ARRAY_LENGTH_CONSTRAINT_APPROXIMATED",
        "Tuple minItems/maxItems constraints cannot be represented exactly",
        pointer,
      );
    }
    if (rest !== "never") {
      return `readonly [${members.join(", ")}, ...${parenthesize(rest)}[]]`;
    }
    return `readonly [${members.join(", ")}]`;
  }

  if (isJsonSchema(schema["items"])) {
    if (schema["minItems"] !== undefined || schema["maxItems"] !== undefined) {
      degrade(
        context,
        "ARRAY_LENGTH_CONSTRAINT_APPROXIMATED",
        "Array minItems/maxItems constraints cannot be represented exactly",
        pointer,
      );
    }
    const item = schemaType(
      schema["items"],
      `${pointer}/items`,
      context,
      depth + 1,
      references,
    );
    return `readonly ${parenthesize(item)}[]`;
  }
  return `readonly ${degrade(
    context,
    "ARRAY_ITEMS_UNSPECIFIED",
    "Array without an item schema degrades to unknown items",
    `${pointer}/items`,
  )}[]`;
}

function schemaType(
  schema: JsonSchema,
  pointer: string,
  context: TypeContext,
  depth: number,
  references: readonly string[],
): string {
  if (depth > context.maxDepth) {
    return degrade(
      context,
      "TYPE_DEPTH_EXCEEDED",
      `Type generation exceeds ${context.maxDepth} levels`,
      pointer,
    );
  }
  if (schema === false) {
    return "never";
  }
  if (schema === true) {
    return degrade(
      context,
      "UNCONSTRAINED_SCHEMA_TYPE",
      "Unconstrained schema degrades to unknown",
      pointer,
    );
  }

  for (const keyword of UNSUPPORTED_TYPE_KEYWORDS) {
    if (schema[keyword] !== undefined) {
      return degrade(
        context,
        "UNSUPPORTED_TYPE_KEYWORD",
        `Type generation does not support "${keyword}"`,
        `${pointer}/${escapePointerToken(keyword)}`,
      );
    }
  }

  if (typeof schema["$ref"] === "string") {
    const reference = schema["$ref"];
    if (!reference.startsWith("#") || !isJsonObject(context.root)) {
      return degrade(
        context,
        "TYPE_REF_UNSUPPORTED",
        "Type generation only resolves local JSON Pointer references",
        `${pointer}/$ref`,
      );
    }
    if (references.includes(reference)) {
      return degrade(
        context,
        "TYPE_REF_CYCLE",
        `Recursive reference "${reference}" degrades to unknown`,
        `${pointer}/$ref`,
      );
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(reference.slice(1));
    } catch {
      return degrade(
        context,
        "TYPE_REF_INVALID",
        `Invalid reference "${reference}"`,
        `${pointer}/$ref`,
      );
    }
    const target = resolveJsonPointer(context.root, decoded);
    if (!isJsonSchema(target)) {
      return degrade(
        context,
        "TYPE_REF_NOT_FOUND",
        `Reference "${reference}" does not resolve to a JSON Schema`,
        `${pointer}/$ref`,
      );
    }
    const nextReferences = [...references, reference];
    const resolved = schemaType(
      target,
      decoded,
      context,
      depth + 1,
      nextReferences,
    );
    const dialect =
      typeof schema["$schema"] === "string"
        ? schema["$schema"]
        : isJsonObject(context.root) &&
            typeof context.root["$schema"] === "string"
          ? context.root["$schema"]
          : "";
    if (dialect.includes("draft-07")) {
      return resolved;
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
    if (Object.keys(siblings).length === 0) {
      return resolved;
    }
    const siblingType = schemaType(
      siblings,
      pointer,
      context,
      depth + 1,
      nextReferences,
    );
    return `${parenthesize(resolved)} & ${parenthesize(siblingType)}`;
  }

  if (schema["const"] !== undefined) {
    const constType =
      Array.isArray(schema["const"]) || isJsonObject(schema["const"])
        ? complexConstType(
            schema["const"] as JsonObject | readonly JsonValue[],
            pointer,
            context,
          )
        : literalType(schema["const"]);
    return intersectWithSiblings(
      constType,
      schema,
      new Set(["const"]),
      pointer,
      context,
      depth,
      references,
    );
  }
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) {
    if (
      schema["enum"].some(
        (value) => Array.isArray(value) || isJsonObject(value),
      )
    ) {
      degrade(
        context,
        "ENUM_COMPLEX_VALUE_APPROXIMATED",
        "TypeScript cannot represent exact equality for object or array enum members",
        `${pointer}/enum`,
      );
    }
    return intersectWithSiblings(
      unique(schema["enum"].map((value) => literalType(value))).join(" | "),
      schema,
      new Set(["enum"]),
      pointer,
      context,
      depth,
      references,
    );
  }

  if (Array.isArray(schema["allOf"])) {
    if (schema["allOf"].length === 0) {
      return degrade(
        context,
        "EMPTY_ALLOF",
        "Empty allOf degrades to unknown",
        `${pointer}/allOf`,
      );
    }
    const primary = unique(
      (schema["allOf"] as readonly JsonSchema[]).map((member, index) =>
        schemaType(
          member,
          `${pointer}/allOf/${index}`,
          context,
          depth + 1,
          references,
        ),
      ),
    )
      .map(parenthesize)
      .join(" & ");
    return intersectWithSiblings(
      primary,
      schema,
      new Set(["allOf"]),
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
    if (union.length === 0) {
      return degrade(
        context,
        "EMPTY_UNION",
        "Empty union degrades to unknown",
        pointer,
      );
    }
    const keyword = Array.isArray(schema["oneOf"]) ? "oneOf" : "anyOf";
    if (keyword === "oneOf") {
      degrade(
        context,
        "ONEOF_EXCLUSIVITY_NOT_EXPRESSIBLE",
        "TypeScript unions cannot enforce JSON Schema oneOf exclusivity",
        `${pointer}/oneOf`,
      );
    }
    const primary = unique(
      (union as readonly JsonSchema[]).map((member, index) =>
        schemaType(
          member,
          `${pointer}/${keyword}/${index}`,
          context,
          depth + 1,
          references,
        ),
      ),
    )
      .map(parenthesize)
      .join(" | ");
    return intersectWithSiblings(
      primary,
      schema,
      new Set([keyword]),
      pointer,
      context,
      depth,
      references,
    );
  }

  markValidationOnlyConstraints(schema, pointer, context);
  const generated = declaredTypes(schema).map((type) => {
    switch (type) {
      case "array":
        return arrayType(schema, pointer, context, depth, references);
      case "boolean":
        return "boolean";
      case "integer":
        degrade(
          context,
          "INTEGER_TYPE_APPROXIMATED",
          "TypeScript number cannot enforce integer-only values",
          pointer,
        );
        return "number";
      case "number":
        return "number";
      case "null":
        return "null";
      case "object":
        return objectType(schema, pointer, context, depth, references);
      case "string":
        return "string";
    }
  });
  if (generated.length === 0) {
    return degrade(
      context,
      "SCHEMA_TYPE_UNSPECIFIED",
      "Schema without a supported type degrades to unknown",
      pointer,
    );
  }
  return unique(generated).map(parenthesize).join(" | ");
}

/**
 * Generates a strict TypeScript alias. Unsupported constructs become
 * `unknown` with diagnostics; generated output never contains unsafe `any`.
 */
export function generateTypeScript(
  schema: JsonSchema,
  options: TypeGenerationOptions = {},
): TypeGenerationResult {
  const maxDepth = options.maxDepth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new RangeError("maxDepth must be a positive safe integer");
  }

  const name = typeName(options.typeName);
  const context: TypeContext = {
    degraded: false,
    diagnostics: new DiagnosticCollector(100),
    maxDepth,
    root: schema,
  };
  const generated = schemaType(schema, "", context, 0, []);
  const prefix = options.exportType === false ? "" : "export ";
  return {
    code: `${prefix}type ${name} = ${generated};\n`,
    diagnostics: context.diagnostics.toArray(),
    status: context.degraded ? "partial" : "generated",
    typeName: name,
  };
}
