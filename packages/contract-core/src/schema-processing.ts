// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  isJsonSchema,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from "@webhook-portal/canonical-model";

import {
  compareCodeUnits,
  joinPointer,
  sortJsonValue,
  stableStringify,
} from "./json-utils.js";
import { consumeLocalReference } from "./refs.js";
import {
  buildRootSchemaIndex,
  createDocumentSchemaIndex,
  type SchemaLocationIndex,
  type SchemaProcessingContext,
  type SchemaTarget,
} from "./schema-index.js";
import {
  SCHEMA_ARRAY_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_SINGLE_KEYWORDS,
} from "./schema-keywords.js";

export {
  countRegexConstraints,
  countUniqueItemsConstraints,
  stripRegexConstraintsForValidation,
  stripUniqueItemsForValidation,
} from "./schema-constraint-utils.js";
export { createDocumentSchemaIndex } from "./schema-index.js";
export type {
  SchemaIndexBuildContext,
  SchemaLocationIndex,
  SchemaProcessingContext,
  SchemaTarget,
} from "./schema-index.js";
export interface ProcessedSchema {
  readonly bytes: number;
  readonly nodes: number;
  readonly outputNodes: number;
  readonly regexConstraintsSkipped: number;
  readonly schema?: JsonSchema;
}

interface ResolveState {
  readonly context: SchemaProcessingContext;
  readonly documentSchemaIndex: SchemaLocationIndex;
  readonly rootSchema: JsonSchema;
  readonly rootSchemaIndex: SchemaLocationIndex;
  readonly rootSourcePointer: string;
  outputBytes: number;
  outputExceeded: boolean;
  outputNodes: number;
  nodes: number;
  regexConstraintsSkipped: number;
}

function addError(
  state: ResolveState,
  code: string,
  message: string,
  pointer: string,
): undefined {
  state.context.diagnostics.add({
    code,
    message,
    pointer,
    severity: "error",
    source: state.context.locations[pointer],
  });
  return undefined;
}

function pointerRef(pointer: string): string {
  return pointer === "" ? "#" : `#${pointer}`;
}

function consumeProcessingWork(state: ResolveState, pointer: string): boolean {
  if (state.context.workBudget.exhausted) return false;
  if (
    state.context.workBudget.used >=
    state.context.limits.maxValidationOperations
  ) {
    state.context.workBudget.exhausted = true;
    addError(
      state,
      "SCHEMA_VALIDATION_BUDGET_EXCEEDED",
      "Contract exhausted the shared schema processing budget",
      pointer,
    );
    return false;
  }
  state.context.workBudget.used += 1;
  return true;
}

function reserveSchemaOutput(
  state: ResolveState,
  pointer: string,
  nodes: number,
  bytes: number,
): boolean {
  if (state.outputExceeded) return false;
  const nextBytes = state.outputBytes + bytes;
  const nextNodes = state.outputNodes + nodes;
  if (
    nextBytes > state.context.limits.maxOutputBytes ||
    nextNodes > state.context.limits.maxOutputNodes
  ) {
    state.outputExceeded = true;
    state.context.diagnostics.add({
      code: "CANONICAL_OUTPUT_BUDGET_EXCEEDED",
      details: {
        actualBytes: nextBytes,
        actualNodes: nextNodes,
        maximumBytes: state.context.limits.maxOutputBytes,
        maximumNodes: state.context.limits.maxOutputNodes,
      },
      message: "Normalized schema exceeds the configured output budget",
      pointer,
      severity: "error",
      source: state.context.locations[pointer],
    });
    return false;
  }
  state.outputBytes = nextBytes;
  state.outputNodes = nextNodes;
  return true;
}

function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function reserveOutputProperty(
  state: ResolveState,
  pointer: string,
  key: string,
  index: number,
): boolean {
  return reserveSchemaOutput(
    state,
    pointer,
    0,
    jsonStringBytes(key) + 1 + (index === 0 ? 0 : 1),
  );
}

function reserveRawJsonValue(
  value: JsonValue,
  pointer: string,
  state: ResolveState,
  depth = 0,
): boolean {
  if (depth > state.context.limits.maxDepth) {
    addError(
      state,
      "SCHEMA_VALIDATION_BUDGET_EXCEEDED",
      "Schema value exceeds the configured processing depth",
      pointer,
    );
    return false;
  }
  if (!consumeProcessingWork(state, pointer)) return false;
  if (value === null) {
    return reserveSchemaOutput(state, pointer, 1, 4);
  }
  if (typeof value === "boolean") {
    return reserveSchemaOutput(state, pointer, 1, value ? 4 : 5);
  }
  if (typeof value === "number") {
    return reserveSchemaOutput(
      state,
      pointer,
      1,
      Buffer.byteLength(JSON.stringify(value), "utf8"),
    );
  }
  if (typeof value === "string") {
    return reserveSchemaOutput(state, pointer, 1, jsonStringBytes(value));
  }
  if (Array.isArray(value)) {
    if (
      !reserveSchemaOutput(state, pointer, 1, 2 + Math.max(0, value.length - 1))
    ) {
      return false;
    }
    for (const [index, item] of value.entries()) {
      if (
        !reserveRawJsonValue(
          item,
          joinPointer(pointer, index),
          state,
          depth + 1,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, JsonValue] => entry[1] !== undefined,
  );
  if (!reserveSchemaOutput(state, pointer, 1, 2)) return false;
  for (const [index, [key, item]] of entries.entries()) {
    const childPointer = joinPointer(pointer, key);
    if (
      !reserveOutputProperty(state, childPointer, key, index) ||
      !reserveRawJsonValue(item, childPointer, state, depth + 1)
    ) {
      return false;
    }
  }
  return true;
}

function resolveLocalTarget(
  reference: string,
  state: ResolveState,
): SchemaTarget | undefined {
  if (!reference.startsWith("#")) {
    return undefined;
  }
  if (reference === "#") {
    return state.rootSchemaIndex.locations.get("");
  }
  if (reference.startsWith("#/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(reference.slice(1));
    } catch {
      return undefined;
    }
    const documentTarget = state.documentSchemaIndex.locations.get(decoded);
    if (documentTarget !== undefined) {
      return documentTarget;
    }
    return state.rootSchemaIndex.locations.get(decoded);
  }

  let identifier: string;
  try {
    identifier = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  return (
    state.rootSchemaIndex.anchors.get(identifier) ??
    state.documentSchemaIndex.anchors.get(identifier)
  );
}

function validateSchemaIdentifiers(
  schema: JsonObject,
  sourcePointer: string,
  state: ResolveState,
): boolean {
  const anchor = schema["$anchor"];
  if (
    anchor !== undefined &&
    (typeof anchor !== "string" || !/^[A-Za-z_][-A-Za-z0-9._]*$/u.test(anchor))
  ) {
    addError(
      state,
      "SCHEMA_ANCHOR_INVALID",
      "JSON Schema $anchor must use the plain-name syntax",
      joinPointer(sourcePointer, "$anchor"),
    );
    return false;
  }

  const identifier = schema["$id"];
  if (identifier === undefined) {
    return true;
  }
  if (
    typeof identifier !== "string" ||
    /\s/u.test(identifier) ||
    /%(?![0-9A-Fa-f]{2})/u.test(identifier)
  ) {
    addError(
      state,
      "SCHEMA_ID_INVALID",
      "JSON Schema $id must be a valid URI-reference",
      joinPointer(sourcePointer, "$id"),
    );
    return false;
  }
  const fragmentIndex = identifier.indexOf("#");
  if (fragmentIndex !== -1 && fragmentIndex < identifier.length - 1) {
    addError(
      state,
      "SCHEMA_ID_FRAGMENT_UNSUPPORTED",
      "Non-empty $id fragments are unsupported; use $anchor instead",
      joinPointer(sourcePointer, "$id"),
    );
    return false;
  }
  if (identifier === "" || identifier === "#") {
    return true;
  }
  try {
    new URL(identifier);
    addError(
      state,
      "SCHEMA_ID_BASE_UNSUPPORTED",
      "Absolute $id base-URI semantics are unsupported",
      joinPointer(sourcePointer, "$id"),
    );
  } catch {
    addError(
      state,
      "SCHEMA_ID_RELATIVE_UNSUPPORTED",
      "Relative $id base-URI semantics are unsupported",
      joinPointer(sourcePointer, "$id"),
    );
  }
  return false;
}

function canonicalizeSetArray(
  key: string,
  value: readonly JsonValue[],
): readonly JsonValue[] {
  if (key === "required" || key === "type") {
    return [
      ...new Set(
        value.filter((item): item is string => typeof item === "string"),
      ),
    ].sort(compareCodeUnits);
  }
  if (key === "enum") {
    const byValue = new Map(
      value.map((item) => [stableStringify(item), sortJsonValue(item)]),
    );
    return [...byValue.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, item]) => item);
  }
  return value.map((item) => sortJsonValue(item));
}

function resolveSchemaNode(
  schema: JsonSchema,
  sourcePointer: string,
  canonicalPointer: string,
  state: ResolveState,
  stack: ReadonlyMap<string, string>,
  depth: number,
  inheritedDialect: string,
): JsonSchema | undefined {
  if (depth > state.context.limits.maxDepth) {
    return addError(
      state,
      "SCHEMA_VALIDATION_BUDGET_EXCEEDED",
      "Schema exceeds the configured processing budget",
      sourcePointer,
    );
  }
  if (!consumeProcessingWork(state, sourcePointer)) return undefined;
  state.nodes += 1;
  if (typeof schema === "boolean") {
    return reserveSchemaOutput(state, sourcePointer, 1, schema ? 4 : 5)
      ? schema
      : undefined;
  }
  const dialect =
    typeof schema["$schema"] === "string"
      ? schema["$schema"]
      : inheritedDialect;
  const reference = schema["$ref"];
  const draft07 = dialect.includes("draft-07");
  if (
    (typeof reference !== "string" || !draft07) &&
    !validateSchemaIdentifiers(schema, sourcePointer, state)
  ) {
    return undefined;
  }
  if (typeof reference === "string") {
    return resolveReferenceNode(
      schema,
      sourcePointer,
      canonicalPointer,
      state,
      stack,
      depth,
      dialect,
      draft07,
      reference,
    );
  }
  return resolveObjectNode(
    schema,
    sourcePointer,
    canonicalPointer,
    state,
    stack,
    depth,
    dialect,
  );
}

function resolveReferenceNode(
  schema: JsonObject,
  sourcePointer: string,
  canonicalPointer: string,
  state: ResolveState,
  stack: ReadonlyMap<string, string>,
  depth: number,
  dialect: string,
  draft07: boolean,
  reference: string,
): JsonSchema | undefined {
  if (!reference.startsWith("#")) {
    return addError(
      state,
      reference.includes(":")
        ? "SCHEMA_EXTERNAL_REF_UNSUPPORTED"
        : "SCHEMA_RELATIVE_REF_UNSUPPORTED",
      `Only local schema references are supported; received "${reference}"`,
      joinPointer(sourcePointer, "$ref"),
    );
  }
  if (
    !consumeLocalReference(
      state.context.referenceBudget,
      state.context.limits,
      state.context.diagnostics,
      state.context.locations,
      `schema:${sourcePointer}:${reference}`,
      joinPointer(sourcePointer, "$ref"),
    )
  ) {
    return undefined;
  }
  const target = resolveLocalTarget(reference, state);
  if (target === undefined) {
    return addError(
      state,
      "SCHEMA_REF_NOT_FOUND",
      `Local schema reference "${reference}" does not resolve`,
      joinPointer(sourcePointer, "$ref"),
    );
  }
  const siblings = draft07
    ? []
    : Object.keys(schema).filter((key) => key !== "$ref");
  const existingPointer = stack.get(target.key);
  if (existingPointer !== undefined) {
    if (siblings.length === 0) {
      const result = { $ref: pointerRef(existingPointer) };
      return reserveRawJsonValue(result, sourcePointer, state)
        ? result
        : undefined;
    }
    const siblingObject: Record<string, JsonValue> = {};
    for (const key of Object.keys(schema).sort(compareCodeUnits)) {
      const item = schema[key];
      if (key !== "$ref" && item !== undefined) {
        siblingObject[key] = item;
      }
    }
    const siblingPointer = joinPointer(
      joinPointer(canonicalPointer, "allOf"),
      1,
    );
    const resolvedSiblings = resolveSchemaNode(
      siblingObject,
      sourcePointer,
      siblingPointer,
      state,
      stack,
      depth + 1,
      dialect,
    );
    if (resolvedSiblings === undefined) return undefined;
    const recursiveReference = { $ref: pointerRef(existingPointer) };
    if (
      !reserveRawJsonValue(recursiveReference, sourcePointer, state) ||
      !reserveSchemaOutput(state, sourcePointer, 2, 13)
    ) {
      return undefined;
    }
    return {
      allOf: [recursiveReference, resolvedSiblings],
    };
  }

  const targetCanonicalPointer =
    siblings.length === 0
      ? canonicalPointer
      : joinPointer(joinPointer(canonicalPointer, "allOf"), 0);
  const nextStack = new Map(stack);
  nextStack.set(target.key, targetCanonicalPointer);
  const resolvedTarget = resolveSchemaNode(
    target.value,
    target.pointer,
    targetCanonicalPointer,
    state,
    nextStack,
    depth + 1,
    dialect,
  );
  if (resolvedTarget === undefined) {
    return undefined;
  }
  if (siblings.length === 0) {
    return resolvedTarget;
  }

  const siblingObject: Record<string, JsonValue> = {};
  for (const key of Object.keys(schema).sort(compareCodeUnits)) {
    const item = schema[key];
    if (key !== "$ref" && item !== undefined) {
      siblingObject[key] = item;
    }
  }
  const resolvedSiblings = resolveSchemaNode(
    siblingObject,
    sourcePointer,
    joinPointer(joinPointer(canonicalPointer, "allOf"), 1),
    state,
    stack,
    depth + 1,
    dialect,
  );
  if (
    resolvedSiblings === undefined ||
    !reserveSchemaOutput(state, sourcePointer, 2, 13)
  ) {
    return undefined;
  }
  return { allOf: [resolvedTarget, resolvedSiblings] };
}
// prettier-ignore
function resolvePatternPropertiesNode(item: JsonObject, childSourcePointer: string, childCanonicalPointer: string, state: ResolveState, stack: ReadonlyMap<string, string>, depth: number, dialect: string): Record<string, JsonValue> | undefined {
  const patterns: Record<string, JsonValue> = {};
  if (!reserveSchemaOutput(state, childSourcePointer, 1, 2)) return undefined;
  let patternIndex = 0;
  for (const pattern of Object.keys(item).sort(compareCodeUnits)) {
    state.regexConstraintsSkipped += 1;
    const child = item[pattern];
    if (!isJsonSchema(child)) return addError(state, "SCHEMA_INVALID", "patternProperties entries must be JSON Schemas", joinPointer(childSourcePointer, pattern));
    if (!reserveOutputProperty(state, joinPointer(childSourcePointer, pattern), pattern, patternIndex)) return undefined;
    patternIndex += 1;
    const resolved = resolveSchemaNode(child, joinPointer(childSourcePointer, pattern), joinPointer(childCanonicalPointer, pattern), state, stack, depth + 1, dialect);
    if (resolved === undefined) return undefined;
    patterns[pattern] = resolved;
  }
  return patterns;
}

// prettier-ignore
function resolveSchemaMapNode(key: string, item: JsonObject, childSourcePointer: string, childCanonicalPointer: string, state: ResolveState, stack: ReadonlyMap<string, string>, depth: number, dialect: string): Record<string, JsonValue> | undefined {
  const map: Record<string, JsonValue> = {};
  if (!reserveSchemaOutput(state, childSourcePointer, 1, 2)) return undefined;
  let mapIndex = 0;
  for (const name of Object.keys(item).sort(compareCodeUnits)) {
    const child = item[name];
    if (!isJsonSchema(child)) return addError(state, "SCHEMA_INVALID", `${key} entries must be JSON Schemas`, joinPointer(childSourcePointer, name));
    if (!reserveOutputProperty(state, joinPointer(childSourcePointer, name), name, mapIndex)) return undefined;
    mapIndex += 1;
    const resolved = resolveSchemaNode(child, joinPointer(childSourcePointer, name), joinPointer(childCanonicalPointer, name), state, stack, depth + 1, dialect);
    if (resolved === undefined) return undefined;
    map[name] = resolved;
  }
  return map;
}

// prettier-ignore
function resolveSchemaArrayNode(key: string, item: readonly JsonValue[], childSourcePointer: string, childCanonicalPointer: string, state: ResolveState, stack: ReadonlyMap<string, string>, depth: number, dialect: string): JsonValue[] | undefined {
  const schemas: JsonValue[] = [];
  if (!reserveSchemaOutput(state, childSourcePointer, 1, 2 + Math.max(0, item.length - 1))) return undefined;
  for (const [index, child] of item.entries()) {
    if (!isJsonSchema(child)) return addError(state, "SCHEMA_INVALID", `${key} entries must be JSON Schemas`, joinPointer(childSourcePointer, index));
    const resolved = resolveSchemaNode(child, joinPointer(childSourcePointer, index), joinPointer(childCanonicalPointer, index), state, stack, depth + 1, dialect);
    if (resolved === undefined) return undefined;
    schemas.push(resolved);
  }
  return schemas;
}

function resolveObjectNode(
  schema: JsonObject,
  sourcePointer: string,
  canonicalPointer: string,
  state: ResolveState,
  stack: ReadonlyMap<string, string>,
  depth: number,
  dialect: string,
): JsonSchema | undefined {
  const result: Record<string, JsonValue> = {};
  if (!reserveSchemaOutput(state, sourcePointer, 1, 2)) {
    return undefined;
  }
  let propertyIndex = 0;
  for (const key of Object.keys(schema).sort(compareCodeUnits)) {
    const item = schema[key];
    if (item === undefined || key === "$ref") {
      continue;
    }
    const childSourcePointer = joinPointer(sourcePointer, key);
    const childCanonicalPointer = joinPointer(canonicalPointer, key);
    if (!reserveOutputProperty(state, childSourcePointer, key, propertyIndex)) {
      return undefined;
    }
    propertyIndex += 1;
    if (key === "pattern" && typeof item === "string") {
      state.regexConstraintsSkipped += 1;
      if (!reserveRawJsonValue(item, childSourcePointer, state)) {
        return undefined;
      }
      result[key] = item;
    } else if (key === "patternProperties" && isJsonObject(item)) {
      const patterns = resolvePatternPropertiesNode(
        item,
        childSourcePointer,
        childCanonicalPointer,
        state,
        stack,
        depth,
        dialect,
      );
      if (patterns === undefined) {
        return undefined;
      }
      result[key] = patterns;
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(item)) {
      const map = resolveSchemaMapNode(
        key,
        item,
        childSourcePointer,
        childCanonicalPointer,
        state,
        stack,
        depth,
        dialect,
      );
      if (map === undefined) {
        return undefined;
      }
      result[key] = map;
    } else if (
      (SCHEMA_ARRAY_KEYWORDS.has(key) || key === "items") &&
      Array.isArray(item)
    ) {
      const schemas = resolveSchemaArrayNode(
        key,
        item,
        childSourcePointer,
        childCanonicalPointer,
        state,
        stack,
        depth,
        dialect,
      );
      if (schemas === undefined) {
        return undefined;
      }
      result[key] = schemas;
    } else if (SCHEMA_SINGLE_KEYWORDS.has(key) && isJsonSchema(item)) {
      const resolved = resolveSchemaNode(
        item,
        childSourcePointer,
        childCanonicalPointer,
        state,
        stack,
        depth + 1,
        dialect,
      );
      if (resolved === undefined) {
        return undefined;
      }
      result[key] = resolved;
    } else if (
      (key === "enum" || key === "required" || key === "type") &&
      Array.isArray(item)
    ) {
      if (!reserveRawJsonValue(item, childSourcePointer, state)) {
        return undefined;
      }
      result[key] = canonicalizeSetArray(key, item);
    } else {
      if (!reserveRawJsonValue(item, childSourcePointer, state)) {
        return undefined;
      }
      result[key] = sortJsonValue(item);
    }
  }
  return result;
}

export function processJsonSchema(
  schema: JsonSchema,
  sourcePointer: string,
  context: SchemaProcessingContext,
): ProcessedSchema {
  const state: ResolveState = {
    context,
    documentSchemaIndex:
      context.documentSchemaIndex ??
      createDocumentSchemaIndex(context.document, context),
    nodes: 0,
    outputBytes: 0,
    outputExceeded: false,
    outputNodes: 0,
    regexConstraintsSkipped: 0,
    rootSchema: schema,
    rootSchemaIndex: buildRootSchemaIndex(schema, sourcePointer, context),
    rootSourcePointer: sourcePointer,
  };
  const stack = new Map<string, string>();
  stack.set(`schema:${sourcePointer}`, "");
  const resolved = resolveSchemaNode(
    schema,
    sourcePointer,
    "",
    state,
    stack,
    0,
    context.defaultDialect,
  );
  if (state.regexConstraintsSkipped > 0) {
    context.diagnostics.add({
      code: "REGEX_CONSTRAINTS_NOT_EVALUATED",
      details: { count: state.regexConstraintsSkipped },
      message:
        "pattern and patternProperties were preserved but not evaluated during bounded example validation",
      pointer: sourcePointer,
      severity: "warning",
      source: context.locations[sourcePointer],
    });
  }
  return {
    bytes: state.outputBytes,
    nodes: state.nodes,
    outputNodes: state.outputNodes,
    regexConstraintsSkipped: state.regexConstraintsSkipped,
    ...(resolved === undefined ? {} : { schema: resolved }),
  };
}

/**
 * Removes user-controlled regex assertions before AJV compilation. The
 * returned schema is intentionally broader and is used only for examples.
 */
