// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  isJsonSchema,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type SourceRange,
} from "@webhook-portal/canonical-model";

import type { ContractLimits } from "./api-types.js";
import { DiagnosticCollector } from "./diagnostics.js";
import {
  compareCodeUnits,
  joinPointer,
  sortJsonValue,
  stableStringify,
} from "./json-utils.js";
import { consumeLocalReference, type ReferenceBudget } from "./refs.js";
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
const SCHEMA_SINGLE_KEYWORDS = new Set([
  "additionalItems",
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
]);
export interface SchemaTarget {
  readonly key: string;
  readonly pointer: string;
  readonly value: JsonSchema;
}

export interface SchemaLocationIndex {
  readonly anchors: ReadonlyMap<string, SchemaTarget>;
  readonly locations: ReadonlyMap<string, SchemaTarget>;
}

export interface SchemaIndexBuildContext {
  readonly diagnostics: DiagnosticCollector;
  readonly limits: ContractLimits;
  readonly locations: Readonly<Record<string, SourceRange>>;
  readonly workBudget: { exhausted: boolean; used: number };
}

export interface SchemaProcessingContext {
  readonly defaultDialect: string;
  readonly diagnostics: DiagnosticCollector;
  readonly document: JsonObject;
  readonly documentSchemaIndex?: SchemaLocationIndex;
  readonly limits: ContractLimits;
  readonly locations: Readonly<Record<string, SourceRange>>;
  readonly referenceBudget: ReferenceBudget;
  readonly rootSchemaIndexes: WeakMap<JsonObject, SchemaLocationIndex>;
  readonly workBudget: { exhausted: boolean; used: number };
}

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

function documentSchemaRoots(
  document: JsonObject,
): readonly { readonly pointer: string; readonly schema: JsonSchema }[] {
  const roots: { pointer: string; schema: JsonSchema }[] = [];
  const addSchema = (value: JsonValue | undefined, pointer: string): void => {
    if (isJsonSchema(value)) {
      roots.push({ pointer, schema: value });
    }
  };
  const addMessage = (value: JsonValue | undefined, pointer: string): void => {
    if (!isJsonObject(value) || typeof value["$ref"] === "string") {
      return;
    }
    if (Array.isArray(value["oneOf"])) {
      value["oneOf"].forEach((message, index) => {
        addMessage(message, joinPointer(joinPointer(pointer, "oneOf"), index));
      });
    }
    addSchema(value["payload"], joinPointer(pointer, "payload"));
  };
  const addContent = (value: JsonValue | undefined, pointer: string): void => {
    if (!isJsonObject(value)) {
      return;
    }
    for (const mediaType of Object.keys(value).sort(compareCodeUnits)) {
      const media = value[mediaType];
      if (isJsonObject(media)) {
        addSchema(
          media["schema"],
          joinPointer(joinPointer(pointer, mediaType), "schema"),
        );
      }
    }
  };
  const addRequestBody = (
    value: JsonValue | undefined,
    pointer: string,
  ): void => {
    if (!isJsonObject(value) || typeof value["$ref"] === "string") {
      return;
    }
    addContent(value["content"], joinPointer(pointer, "content"));
  };

  const components = document["components"];
  if (isJsonObject(components)) {
    const schemas = components["schemas"];
    if (isJsonObject(schemas)) {
      for (const name of Object.keys(schemas).sort(compareCodeUnits)) {
        const schema = schemas[name];
        addSchema(schema, joinPointer("/components/schemas", name));
      }
    }
    const messages = components["messages"];
    if (isJsonObject(messages)) {
      for (const name of Object.keys(messages).sort(compareCodeUnits)) {
        const message = messages[name];
        addMessage(message, joinPointer("/components/messages", name));
      }
    }
    const requestBodies = components["requestBodies"];
    if (isJsonObject(requestBodies)) {
      for (const name of Object.keys(requestBodies).sort(compareCodeUnits)) {
        addRequestBody(
          requestBodies[name],
          joinPointer("/components/requestBodies", name),
        );
      }
    }
  }

  const webhooks = document["webhooks"];
  if (isJsonObject(webhooks)) {
    for (const name of Object.keys(webhooks).sort(compareCodeUnits)) {
      const path = webhooks[name];
      if (!isJsonObject(path) || typeof path["$ref"] === "string") continue;
      for (const method of [
        "delete",
        "get",
        "head",
        "options",
        "patch",
        "post",
        "put",
        "trace",
      ]) {
        const operation = path[method];
        if (isJsonObject(operation)) {
          addRequestBody(
            operation["requestBody"],
            joinPointer(
              joinPointer(joinPointer("/webhooks", name), method),
              "requestBody",
            ),
          );
        }
      }
    }
  }

  const channels = document["channels"];
  if (isJsonObject(channels)) {
    for (const name of Object.keys(channels).sort(compareCodeUnits)) {
      const channel = channels[name];
      if (!isJsonObject(channel) || typeof channel["$ref"] === "string") {
        continue;
      }
      for (const action of ["publish", "subscribe"]) {
        const operation = channel[action];
        if (isJsonObject(operation)) {
          addMessage(
            operation["message"],
            joinPointer(
              joinPointer(joinPointer("/channels", name), action),
              "message",
            ),
          );
        }
      }
      const messages = channel["messages"];
      if (isJsonObject(messages)) {
        for (const messageName of Object.keys(messages).sort(
          compareCodeUnits,
        )) {
          addMessage(
            messages[messageName],
            joinPointer(
              joinPointer(joinPointer("/channels", name), "messages"),
              messageName,
            ),
          );
        }
      }
    }
  }
  return roots;
}

interface MutableSchemaIndex {
  readonly anchors: Map<string, SchemaTarget>;
  readonly duplicateAnchors: Set<string>;
  readonly locations: Map<string, SchemaTarget>;
}

function chargeIndexNode(
  pointer: string,
  context: SchemaIndexBuildContext,
): boolean {
  if (context.workBudget.exhausted) return false;
  if (context.workBudget.used >= context.limits.maxValidationOperations) {
    context.workBudget.exhausted = true;
    context.diagnostics.add({
      code: "SCHEMA_VALIDATION_BUDGET_EXCEEDED",
      message: "Contract exhausted the shared schema indexing budget",
      pointer,
      severity: "error",
      source: context.locations[pointer],
    });
    return false;
  }
  context.workBudget.used += 1;
  return true;
}

function registerAnchor(
  schema: JsonObject,
  target: SchemaTarget,
  index: MutableSchemaIndex,
  context: SchemaIndexBuildContext,
): void {
  const anchor = schema["$anchor"];
  if (
    typeof anchor !== "string" ||
    !/^[A-Za-z_][-A-Za-z0-9._]*$/u.test(anchor)
  ) {
    return;
  }
  const existing = index.anchors.get(anchor);
  if (existing === undefined) {
    index.anchors.set(anchor, target);
    return;
  }
  const ordered = [existing, target].sort((left, right) =>
    compareCodeUnits(left.pointer, right.pointer),
  );
  index.anchors.set(anchor, ordered[0] as SchemaTarget);
  if (!index.duplicateAnchors.has(anchor)) {
    index.duplicateAnchors.add(anchor);
    context.diagnostics.add({
      code: "SCHEMA_ANCHOR_DUPLICATE",
      details: {
        anchor,
        locations: ordered.map(({ pointer }) => pointer),
      },
      message: `Duplicate JSON Schema $anchor "${anchor}"`,
      pointer: ordered[1]?.pointer ?? target.pointer,
      severity: "error",
      source: context.locations[ordered[1]?.pointer ?? target.pointer],
    });
  }
}

function indexSchemaTree(
  schema: JsonSchema,
  indexPointer: string,
  sourcePointer: string,
  namespace: "document" | "schema",
  index: MutableSchemaIndex,
  visited: Set<object>,
  context: SchemaIndexBuildContext,
): void {
  if (!chargeIndexNode(sourcePointer, context)) return;
  const target: SchemaTarget = {
    key: `${namespace}:${sourcePointer}`,
    pointer: sourcePointer,
    value: schema,
  };
  index.locations.set(indexPointer, target);
  if (typeof schema === "boolean" || visited.has(schema)) {
    return;
  }
  visited.add(schema);
  registerAnchor(schema, target, index, context);
  for (const key of SCHEMA_MAP_KEYWORDS) {
    const map = schema[key];
    if (isJsonObject(map)) {
      for (const name of Object.keys(map).sort(compareCodeUnits)) {
        const child = map[name];
        if (isJsonSchema(child)) {
          indexSchemaTree(
            child,
            joinPointer(joinPointer(indexPointer, key), name),
            joinPointer(joinPointer(sourcePointer, key), name),
            namespace,
            index,
            visited,
            context,
          );
        }
      }
    }
  }
  for (const key of [...SCHEMA_ARRAY_KEYWORDS, "items"]) {
    const values = schema[key];
    if (Array.isArray(values)) {
      values.forEach((child, childIndex) => {
        if (isJsonSchema(child)) {
          indexSchemaTree(
            child,
            joinPointer(joinPointer(indexPointer, key), childIndex),
            joinPointer(joinPointer(sourcePointer, key), childIndex),
            namespace,
            index,
            visited,
            context,
          );
        }
      });
    }
  }
  for (const key of SCHEMA_SINGLE_KEYWORDS) {
    const child = schema[key];
    if (isJsonSchema(child)) {
      indexSchemaTree(
        child,
        joinPointer(indexPointer, key),
        joinPointer(sourcePointer, key),
        namespace,
        index,
        visited,
        context,
      );
    }
  }
}

export function createDocumentSchemaIndex(
  document: JsonObject,
  context: SchemaIndexBuildContext,
): SchemaLocationIndex {
  const index: MutableSchemaIndex = {
    anchors: new Map(),
    duplicateAnchors: new Set(),
    locations: new Map(),
  };
  for (const root of [...documentSchemaRoots(document)].sort((left, right) =>
    compareCodeUnits(left.pointer, right.pointer),
  )) {
    if (context.workBudget.exhausted) break;
    indexSchemaTree(
      root.schema,
      root.pointer,
      root.pointer,
      "document",
      index,
      new Set(),
      context,
    );
  }
  return { anchors: index.anchors, locations: index.locations };
}

function buildRootSchemaIndex(
  schema: JsonSchema,
  sourcePointer: string,
  context: SchemaProcessingContext,
): SchemaLocationIndex {
  if (isJsonObject(schema)) {
    const cached = context.rootSchemaIndexes.get(schema);
    if (cached !== undefined) return cached;
  }
  const index: MutableSchemaIndex = {
    anchors: new Map(),
    duplicateAnchors: new Set(),
    locations: new Map(),
  };
  indexSchemaTree(
    schema,
    "",
    sourcePointer,
    "schema",
    index,
    new Set(),
    context,
  );
  const result = { anchors: index.anchors, locations: index.locations };
  if (isJsonObject(schema)) {
    context.rootSchemaIndexes.set(schema, result);
  }
  return result;
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
      const patterns: Record<string, JsonValue> = {};
      if (!reserveSchemaOutput(state, childSourcePointer, 1, 2)) {
        return undefined;
      }
      let patternIndex = 0;
      for (const pattern of Object.keys(item).sort(compareCodeUnits)) {
        state.regexConstraintsSkipped += 1;
        const child = item[pattern];
        if (!isJsonSchema(child)) {
          return addError(
            state,
            "SCHEMA_INVALID",
            "patternProperties entries must be JSON Schemas",
            joinPointer(childSourcePointer, pattern),
          );
        }
        if (
          !reserveOutputProperty(
            state,
            joinPointer(childSourcePointer, pattern),
            pattern,
            patternIndex,
          )
        ) {
          return undefined;
        }
        patternIndex += 1;
        const resolved = resolveSchemaNode(
          child,
          joinPointer(childSourcePointer, pattern),
          joinPointer(childCanonicalPointer, pattern),
          state,
          stack,
          depth + 1,
          dialect,
        );
        if (resolved === undefined) {
          return undefined;
        }
        patterns[pattern] = resolved;
      }
      result[key] = patterns;
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(item)) {
      const map: Record<string, JsonValue> = {};
      if (!reserveSchemaOutput(state, childSourcePointer, 1, 2)) {
        return undefined;
      }
      let mapIndex = 0;
      for (const name of Object.keys(item).sort(compareCodeUnits)) {
        const child = item[name];
        if (!isJsonSchema(child)) {
          return addError(
            state,
            "SCHEMA_INVALID",
            `${key} entries must be JSON Schemas`,
            joinPointer(childSourcePointer, name),
          );
        }
        if (
          !reserveOutputProperty(
            state,
            joinPointer(childSourcePointer, name),
            name,
            mapIndex,
          )
        ) {
          return undefined;
        }
        mapIndex += 1;
        const resolved = resolveSchemaNode(
          child,
          joinPointer(childSourcePointer, name),
          joinPointer(childCanonicalPointer, name),
          state,
          stack,
          depth + 1,
          dialect,
        );
        if (resolved === undefined) {
          return undefined;
        }
        map[name] = resolved;
      }
      result[key] = map;
    } else if (
      (SCHEMA_ARRAY_KEYWORDS.has(key) || key === "items") &&
      Array.isArray(item)
    ) {
      const schemas: JsonValue[] = [];
      if (
        !reserveSchemaOutput(
          state,
          childSourcePointer,
          1,
          2 + Math.max(0, item.length - 1),
        )
      ) {
        return undefined;
      }
      for (const [index, child] of item.entries()) {
        if (!isJsonSchema(child)) {
          return addError(
            state,
            "SCHEMA_INVALID",
            `${key} entries must be JSON Schemas`,
            joinPointer(childSourcePointer, index),
          );
        }
        const resolved = resolveSchemaNode(
          child,
          joinPointer(childSourcePointer, index),
          joinPointer(childCanonicalPointer, index),
          state,
          stack,
          depth + 1,
          dialect,
        );
        if (resolved === undefined) {
          return undefined;
        }
        schemas.push(resolved);
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
export function stripRegexConstraintsForValidation(
  schema: JsonSchema,
): JsonSchema {
  if (typeof schema === "boolean") {
    return schema;
  }
  const result: Record<string, JsonValue> = {};
  let removedPatternProperties = false;
  for (const key of Object.keys(schema).sort(compareCodeUnits)) {
    const item = schema[key];
    if (item === undefined || key === "pattern") {
      continue;
    }
    if (key === "patternProperties") {
      removedPatternProperties = true;
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(item)) {
      const map: Record<string, JsonValue> = {};
      for (const name of Object.keys(item).sort(compareCodeUnits)) {
        const child = item[name];
        if (isJsonSchema(child)) {
          map[name] = stripRegexConstraintsForValidation(child);
        }
      }
      result[key] = map;
    } else if (
      (SCHEMA_ARRAY_KEYWORDS.has(key) || key === "items") &&
      Array.isArray(item)
    ) {
      result[key] = item.map((child) =>
        isJsonSchema(child)
          ? stripRegexConstraintsForValidation(child)
          : sortJsonValue(child),
      );
    } else if (SCHEMA_SINGLE_KEYWORDS.has(key) && isJsonSchema(item)) {
      result[key] = stripRegexConstraintsForValidation(item);
    } else {
      result[key] = sortJsonValue(item);
    }
  }
  if (removedPatternProperties) {
    result["additionalProperties"] = true;
    result["unevaluatedProperties"] = true;
  }
  return result;
}

/**
 * Removes uniqueItems before validating examples when its quadratic worst case
 * would exceed the synchronous validation budget.
 */
export function stripUniqueItemsForValidation(schema: JsonSchema): JsonSchema {
  if (typeof schema === "boolean") {
    return schema;
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(schema).sort(compareCodeUnits)) {
    const item = schema[key];
    if (item === undefined || (key === "uniqueItems" && item === true)) {
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(item)) {
      const map: Record<string, JsonValue> = {};
      for (const name of Object.keys(item).sort(compareCodeUnits)) {
        const child = item[name];
        if (isJsonSchema(child)) {
          map[name] = stripUniqueItemsForValidation(child);
        }
      }
      result[key] = map;
    } else if (
      (SCHEMA_ARRAY_KEYWORDS.has(key) || key === "items") &&
      Array.isArray(item)
    ) {
      result[key] = item.map((child) =>
        isJsonSchema(child)
          ? stripUniqueItemsForValidation(child)
          : sortJsonValue(child),
      );
    } else if (SCHEMA_SINGLE_KEYWORDS.has(key) && isJsonSchema(item)) {
      result[key] = stripUniqueItemsForValidation(item);
    } else {
      result[key] = sortJsonValue(item);
    }
  }
  return result;
}

export function countRegexConstraints(schema: JsonSchema): number {
  if (typeof schema === "boolean") {
    return 0;
  }
  let count = typeof schema["pattern"] === "string" ? 1 : 0;
  const patternProperties = schema["patternProperties"];
  if (isJsonObject(patternProperties)) {
    count += Object.keys(patternProperties).length;
    for (const child of Object.values(patternProperties)) {
      if (isJsonSchema(child)) {
        count += countRegexConstraints(child);
      }
    }
  }
  for (const key of SCHEMA_MAP_KEYWORDS) {
    if (key === "patternProperties") {
      continue;
    }
    const map = schema[key];
    if (isJsonObject(map)) {
      for (const child of Object.values(map)) {
        if (isJsonSchema(child)) {
          count += countRegexConstraints(child);
        }
      }
    }
  }
  for (const key of [...SCHEMA_ARRAY_KEYWORDS, "items"]) {
    const values = schema[key];
    if (Array.isArray(values)) {
      for (const child of values) {
        if (isJsonSchema(child)) {
          count += countRegexConstraints(child);
        }
      }
    }
  }
  for (const key of SCHEMA_SINGLE_KEYWORDS) {
    const child = schema[key];
    if (isJsonSchema(child)) {
      count += countRegexConstraints(child);
    }
  }
  return count;
}

export function countUniqueItemsConstraints(schema: JsonSchema): number {
  if (typeof schema === "boolean") {
    return 0;
  }
  let count = schema["uniqueItems"] === true ? 1 : 0;
  for (const key of SCHEMA_MAP_KEYWORDS) {
    const map = schema[key];
    if (isJsonObject(map)) {
      for (const child of Object.values(map)) {
        if (isJsonSchema(child)) {
          count += countUniqueItemsConstraints(child);
        }
      }
    }
  }
  for (const key of [...SCHEMA_ARRAY_KEYWORDS, "items"]) {
    const values = schema[key];
    if (Array.isArray(values)) {
      for (const child of values) {
        if (isJsonSchema(child)) {
          count += countUniqueItemsConstraints(child);
        }
      }
    }
  }
  for (const key of SCHEMA_SINGLE_KEYWORDS) {
    const child = schema[key];
    if (isJsonSchema(child)) {
      count += countUniqueItemsConstraints(child);
    }
  }
  return count;
}
