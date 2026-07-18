// SPDX-License-Identifier: Apache-2.0

import { openapiV31 } from "@apidevtools/openapi-schemas";
import * as asyncApiSpecsModule from "@asyncapi/specs";

import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type SourceRange,
} from "@webhook-portal/canonical-model";

import type { ContractLimits } from "./api-types.js";
import { DiagnosticCollector } from "./diagnostics.js";
import { joinPointer } from "./json-utils.js";

interface ReferenceTarget {
  readonly document: JsonObject;
  readonly documentId: string;
  readonly pointer: string;
  readonly value: JsonValue;
}

export type ReferenceObjectKind =
  | "asyncapi-channel"
  | "asyncapi-message"
  | "asyncapi-operation"
  | "direct"
  | "openapi-example"
  | "openapi-operation"
  | "openapi-path-item"
  | "openapi-request-body";

export interface ReferenceBudget {
  count: number;
  exceeded: boolean;
  readonly seen: Set<string>;
}

export interface ReferenceContext {
  readonly diagnostics: DiagnosticCollector;
  readonly documentId: string;
  readonly limits: ContractLimits;
  readonly locations: Readonly<Record<string, SourceRange>>;
  readonly referenceBudget: ReferenceBudget;
  readonly root: JsonObject;
  readonly sourceFormat: "asyncapi" | "openapi";
  readonly specificationVersion: string;
}

export function consumeLocalReference(
  budget: ReferenceBudget,
  limits: ContractLimits,
  diagnostics: DiagnosticCollector,
  locations: Readonly<Record<string, SourceRange>>,
  key: string,
  pointer: string,
): boolean {
  if (budget.seen.has(key)) {
    return !budget.exceeded;
  }
  budget.seen.add(key);
  budget.count += 1;
  if (budget.count <= limits.maxReferences) {
    return true;
  }
  if (!budget.exceeded) {
    budget.exceeded = true;
    diagnostics.add({
      code: "REFERENCE_LIMIT_EXCEEDED",
      details: {
        actualReferences: budget.count,
        maximumReferences: limits.maxReferences,
      },
      message: `Contract exceeds the ${limits.maxReferences} local reference limit`,
      pointer,
      severity: "fatal",
      source: locations[pointer],
    });
  }
  return false;
}

interface OfficialReferenceCapabilities {
  readonly components: ReadonlySet<string>;
  readonly roots: ReadonlySet<string>;
}

function objectKeys(value: JsonValue | undefined): ReadonlySet<string> {
  return new Set(isJsonObject(value) ? Object.keys(value) : []);
}

function asyncApiCapabilities(
  version: "2.6.0" | "3.0.0",
): OfficialReferenceCapabilities {
  const specs = asyncApiSpecsModule.default as unknown as {
    readonly schemas: Readonly<Record<string, JsonObject>>;
  };
  const schema = specs.schemas[version];
  const definitions = isJsonObject(schema?.["definitions"])
    ? schema["definitions"]
    : {};
  const componentSchema = Object.values(definitions).find(
    (definition) =>
      isJsonObject(definition) &&
      typeof definition["$id"] === "string" &&
      definition["$id"].endsWith(`/${version}/components.json`),
  );
  return {
    components: objectKeys(
      isJsonObject(componentSchema) ? componentSchema["properties"] : undefined,
    ),
    roots: objectKeys(schema?.["properties"]),
  };
}

function openApiCapabilities(): OfficialReferenceCapabilities {
  const schema = openapiV31 as unknown as JsonObject;
  const definitions = isJsonObject(schema["$defs"]) ? schema["$defs"] : {};
  const components = isJsonObject(definitions["components"])
    ? definitions["components"]
    : undefined;
  return {
    components: objectKeys(components?.["properties"]),
    roots: objectKeys(schema["properties"]),
  };
}

const OFFICIAL_REFERENCE_CAPABILITIES = Object.freeze({
  asyncapi26: asyncApiCapabilities("2.6.0"),
  asyncapi30: asyncApiCapabilities("3.0.0"),
  openapi31: openApiCapabilities(),
});

function decodePointer(fragment: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return undefined;
  }

  if (decoded === "" || decoded === "#") {
    return "";
  }
  const withoutHash = decoded.startsWith("#") ? decoded.slice(1) : decoded;
  return withoutHash.startsWith("/") ? withoutHash : undefined;
}

function pointerTokens(pointer: string): string[] | undefined {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function resolveJsonPointer(
  document: JsonObject,
  pointer: string,
): JsonValue | undefined {
  const tokens = pointerTokens(pointer);
  if (tokens === undefined) {
    return undefined;
  }

  let value: JsonValue = document;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
        return undefined;
      }
      const next: JsonValue | undefined = value[Number(token)];
      if (next === undefined) {
        return undefined;
      }
      value = next;
    } else if (isJsonObject(value)) {
      if (!Object.hasOwn(value, token)) {
        return undefined;
      }
      const next: JsonValue | undefined = value[token];
      if (next === undefined) {
        return undefined;
      }
      value = next;
    } else {
      return undefined;
    }
  }
  return value;
}

function referenceTarget(
  reference: string,
  context: ReferenceContext,
): ReferenceTarget | undefined {
  if (!reference.startsWith("#")) {
    return undefined;
  }
  const pointer = decodePointer(reference);
  if (pointer === undefined) {
    return undefined;
  }
  const value = resolveJsonPointer(context.root, pointer);
  return value === undefined
    ? undefined
    : {
        document: context.root,
        documentId: context.documentId,
        pointer,
        value,
      };
}

function referenceCode(reference: string): string {
  if (reference.startsWith("#")) {
    return "REF_NOT_FOUND";
  }
  try {
    return new URL(reference).protocol === "https:"
      ? "REMOTE_REF_DENIED"
      : "EXTERNAL_REF_UNSUPPORTED";
  } catch {
    return "RELATIVE_REF_UNSUPPORTED";
  }
}

function addReferenceError(
  reference: string,
  pointer: string,
  context: ReferenceContext,
): void {
  const code = referenceCode(reference);
  context.diagnostics.add({
    code,
    details: { reference },
    message:
      code === "REMOTE_REF_DENIED"
        ? `Remote reference "${reference}" is not an allowlisted HTTPS document`
        : reference.startsWith("#")
          ? `Local reference "${reference}" does not resolve`
          : `External or relative reference "${reference}" is unsupported`,
    pointer,
    severity: "error",
    source: context.locations[pointer],
  });
}

function allowedReferenceTarget(
  kind: ReferenceObjectKind,
  pointer: string,
  context: ReferenceContext,
): boolean {
  const tokens = pointerTokens(pointer);
  if (tokens === undefined) {
    return false;
  }
  const [root, collection, , member] = tokens;
  switch (kind) {
    case "asyncapi-message":
      if (
        context.sourceFormat !== "asyncapi" ||
        (context.specificationVersion !== "2.6.0" &&
          context.specificationVersion !== "3.0.0")
      )
        return false;
      const messageCapabilities =
        context.specificationVersion === "2.6.0"
          ? OFFICIAL_REFERENCE_CAPABILITIES.asyncapi26
          : OFFICIAL_REFERENCE_CAPABILITIES.asyncapi30;
      return (
        (tokens.length === 3 &&
          root === "components" &&
          collection === "messages" &&
          messageCapabilities.components.has("messages")) ||
        (context.specificationVersion === "3.0.0" &&
          tokens.length === 4 &&
          root === "channels" &&
          tokens[2] === "messages" &&
          messageCapabilities.roots.has("channels")) ||
        (context.specificationVersion === "2.6.0" &&
          tokens.length === 4 &&
          root === "channels" &&
          (tokens[2] === "publish" || tokens[2] === "subscribe") &&
          member === "message" &&
          messageCapabilities.roots.has("channels"))
      );
    case "asyncapi-channel":
      if (
        context.sourceFormat !== "asyncapi" ||
        (context.specificationVersion !== "2.6.0" &&
          context.specificationVersion !== "3.0.0")
      )
        return false;
      const channelCapabilities =
        context.specificationVersion === "2.6.0"
          ? OFFICIAL_REFERENCE_CAPABILITIES.asyncapi26
          : OFFICIAL_REFERENCE_CAPABILITIES.asyncapi30;
      return context.specificationVersion === "2.6.0"
        ? tokens.length === 2 &&
            root === "channels" &&
            channelCapabilities.roots.has("channels")
        : (tokens.length === 2 &&
            root === "channels" &&
            channelCapabilities.roots.has("channels")) ||
            (tokens.length === 3 &&
              root === "components" &&
              collection === "channels" &&
              channelCapabilities.components.has("channels"));
    case "asyncapi-operation":
      if (
        context.sourceFormat !== "asyncapi" ||
        (context.specificationVersion !== "2.6.0" &&
          context.specificationVersion !== "3.0.0")
      )
        return false;
      const operationCapabilities =
        context.specificationVersion === "2.6.0"
          ? OFFICIAL_REFERENCE_CAPABILITIES.asyncapi26
          : OFFICIAL_REFERENCE_CAPABILITIES.asyncapi30;
      return context.specificationVersion === "3.0.0"
        ? (tokens.length === 2 &&
            root === "operations" &&
            operationCapabilities.roots.has("operations")) ||
            (tokens.length === 3 &&
              root === "components" &&
              collection === "operations" &&
              operationCapabilities.components.has("operations"))
        : context.specificationVersion === "2.6.0" &&
            tokens.length === 3 &&
            root === "channels" &&
            (tokens[2] === "publish" || tokens[2] === "subscribe") &&
            operationCapabilities.roots.has("channels");
    case "openapi-example":
      if (
        context.sourceFormat !== "openapi" ||
        !context.specificationVersion.startsWith("3.1.")
      )
        return false;
      return (
        tokens.length === 3 &&
        root === "components" &&
        collection === "examples" &&
        OFFICIAL_REFERENCE_CAPABILITIES.openapi31.components.has("examples")
      );
    case "openapi-path-item":
      if (
        context.sourceFormat !== "openapi" ||
        !context.specificationVersion.startsWith("3.1.")
      )
        return false;
      return (
        tokens.length === 3 &&
        root === "components" &&
        collection === "pathItems" &&
        OFFICIAL_REFERENCE_CAPABILITIES.openapi31.components.has("pathItems")
      );
    case "openapi-request-body":
      if (
        context.sourceFormat !== "openapi" ||
        !context.specificationVersion.startsWith("3.1.")
      )
        return false;
      return (
        tokens.length === 3 &&
        root === "components" &&
        collection === "requestBodies" &&
        OFFICIAL_REFERENCE_CAPABILITIES.openapi31.components.has(
          "requestBodies",
        )
      );
    case "direct":
    case "openapi-operation":
      return false;
  }
}

function addTargetKindError(
  kind: ReferenceObjectKind,
  reference: string,
  pointer: string,
  context: ReferenceContext,
): void {
  context.diagnostics.add({
    code: "REF_TARGET_KIND_MISMATCH",
    details: { kind, reference },
    message: `Reference "${reference}" does not target a valid ${kind} location`,
    pointer,
    severity: "error",
    source: context.locations[pointer],
  });
}

function addExternalTypedReferenceError(
  kind: ReferenceObjectKind,
  reference: string,
  pointer: string,
  context: ReferenceContext,
): void {
  context.diagnostics.add({
    code: "TYPED_EXTERNAL_REF_UNSUPPORTED",
    details: { kind, reference },
    message:
      "External and relative typed Reference Objects are unsupported until the complete remote document is pinned and validated",
    pointer,
    severity: "error",
    source: context.locations[pointer],
  });
}

/**
 * Resolves a Reference Object at a known OpenAPI/AsyncAPI reference position.
 * Child values are deliberately left opaque for their domain-specific parser.
 */
export function resolveObjectValue(
  value: JsonValue,
  pointer: string,
  context: ReferenceContext,
  kind: ReferenceObjectKind,
  stack: readonly string[] = [],
): JsonObject | undefined {
  if (stack.length > context.limits.maxDepth) {
    context.diagnostics.add({
      code: "RESOLUTION_DEPTH_EXCEEDED",
      message: `Reference resolution exceeds ${context.limits.maxDepth} levels`,
      pointer,
      severity: "error",
      source: context.locations[pointer],
    });
    return undefined;
  }
  if (!isJsonObject(value)) {
    return undefined;
  }

  const reference = value["$ref"];
  if (typeof reference !== "string") {
    return value;
  }
  if (!reference.startsWith("#")) {
    addExternalTypedReferenceError(
      kind,
      reference,
      joinPointer(pointer, "$ref"),
      context,
    );
    return undefined;
  }
  const referencePointer = joinPointer(pointer, "$ref");
  if (
    !consumeLocalReference(
      context.referenceBudget,
      context.limits,
      context.diagnostics,
      context.locations,
      `typed:${kind}:${pointer}:${reference}`,
      referencePointer,
    )
  ) {
    return undefined;
  }
  const target = referenceTarget(reference, context);
  if (target === undefined) {
    addReferenceError(reference, joinPointer(pointer, "$ref"), context);
    return undefined;
  }
  if (!allowedReferenceTarget(kind, target.pointer, context)) {
    addTargetKindError(kind, reference, joinPointer(pointer, "$ref"), context);
    return undefined;
  }
  const targetKey = `${target.documentId}#${target.pointer}`;
  if (stack.includes(targetKey)) {
    context.diagnostics.add({
      code: "REF_CYCLE",
      details: { reference },
      message: `Reference Object cycle detected at "${reference}"`,
      pointer: joinPointer(pointer, "$ref"),
      severity: "error",
      source: context.locations[joinPointer(pointer, "$ref")],
    });
    return undefined;
  }

  const targetContext =
    target.document === context.root
      ? context
      : {
          ...context,
          documentId: target.documentId,
          locations: {},
          root: target.document,
        };
  const resolvedTarget = resolveObjectValue(
    target.value,
    target.pointer,
    targetContext,
    kind,
    [...stack, targetKey],
  );
  if (resolvedTarget === undefined) {
    context.diagnostics.add({
      code: "REF_TARGET_NOT_OBJECT",
      details: { reference },
      message: `Reference "${reference}" must resolve to an object here`,
      pointer: joinPointer(pointer, "$ref"),
      severity: "error",
      source: context.locations[joinPointer(pointer, "$ref")],
    });
    return undefined;
  }

  const merged: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(resolvedTarget)) {
    if (item !== undefined) {
      merged[key] = item;
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (key !== "$ref" && item !== undefined) {
      merged[key] = item;
    }
  }
  return merged;
}
