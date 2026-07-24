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
import { compareCodeUnits, joinPointer } from "./json-utils.js";
import {
  SCHEMA_ARRAY_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_SINGLE_KEYWORDS,
} from "./schema-keywords.js";
import { type ReferenceBudget } from "./refs.js";

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

export function buildRootSchemaIndex(
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
