// SPDX-License-Identifier: Apache-2.0

import {
  JSON_SCHEMA_2020_12_DIALECT,
  JSON_SCHEMA_DRAFT_07_DIALECT,
  OPENAPI_3_1_BASE_DIALECT,
  isJsonObject,
  isJsonSchema,
  type CanonicalExample,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type SignatureProfile,
  type SourcePointer,
} from "@webhook-portal/canonical-model";

import type { ParsedContract } from "./api-types.js";
import { DiagnosticCollector } from "./diagnostics.js";
import { asString, inspectJsonValue, joinPointer } from "./json-utils.js";
import {
  resolveObjectValue,
  type ReferenceContext,
  type ReferenceObjectKind,
} from "./refs.js";
import {
  processJsonSchema,
  type SchemaLocationIndex,
} from "./schema-processing.js";
import { resolveAsyncApiSchemaDialect } from "./source-validation.js";

export const INTERPRETED_EVENT_EXTENSIONS = [
  "x-event-type",
  "x-event-id",
  "x-event-version",
  "x-signature-profile",
  "x-standard-webhooks",
  "x-version",
] as const;

export interface ExtractedEvent {
  readonly description?: string;
  readonly examples: readonly CanonicalExample[];
  readonly extensions?: JsonObject;
  readonly externalName: string;
  readonly publicVersion: string;
  readonly schema: JsonSchema;
  readonly schemaDialect: string;
  readonly schemaPointer: string;
  readonly signatureProfile?: SignatureProfile;
  readonly sourceIdentity: string;
  readonly sourcePointer: string;
  readonly title?: string;
  readonly deprecated: boolean;
}

export interface ExtractionContext {
  readonly diagnostics: DiagnosticCollector;
  readonly parsed: ParsedContract;
  readonly references: ReferenceContext;
  readonly schemaIndex: SchemaLocationIndex;
  readonly schemaRootIndexes: WeakMap<JsonObject, SchemaLocationIndex>;
  readonly outputBudget: { bytes: number; exhausted: boolean; nodes: number };
  readonly validationBudget: { exhausted: boolean; used: number };
  readonly validateExamples: boolean;
}

export interface ResolvedPayloadSchema {
  readonly bytes: number;
  readonly nodes: number;
  readonly schema: JsonSchema;
}

export function locationSource(
  parsed: ParsedContract,
  pointer: string,
): SourcePointer {
  const location = parsed.locations[pointer];
  return location === undefined ? { pointer } : { location, pointer };
}

export function addAt(
  context: ExtractionContext,
  diagnostic: {
    readonly code: string;
    readonly details?: JsonObject;
    readonly message: string;
    readonly pointer: string;
    readonly severity: "error" | "fatal" | "info" | "warning";
  },
): void {
  context.diagnostics.add({
    ...diagnostic,
    source: context.parsed.locations[diagnostic.pointer],
  });
}

export function addCanonicalOutputBudgetDiagnostic(
  context: ExtractionContext,
  pointer: string,
  actualBytes: number,
  actualNodes: number,
): void {
  if (context.outputBudget.exhausted) return;
  context.outputBudget.exhausted = true;
  addAt(context, {
    code: "CANONICAL_OUTPUT_BUDGET_EXCEEDED",
    details: {
      actualBytes,
      actualNodes,
      maximumBytes: context.references.limits.maxOutputBytes,
      maximumNodes: context.references.limits.maxOutputNodes,
    },
    message: "Canonical contract exceeds the configured output budget",
    pointer,
    severity: "error",
  });
}

export function reserveCanonicalOutput(
  value: JsonValue,
  pointer: string,
  context: ExtractionContext,
): boolean {
  if (context.outputBudget.exhausted) return false;
  const remainingBytes =
    context.references.limits.maxOutputBytes - context.outputBudget.bytes;
  const remainingNodes =
    context.references.limits.maxOutputNodes - context.outputBudget.nodes;
  if (remainingBytes <= 0 || remainingNodes <= 0) {
    addCanonicalOutputBudgetDiagnostic(
      context,
      pointer,
      context.outputBudget.bytes + 1,
      context.outputBudget.nodes + 1,
    );
    return false;
  }
  const inspection = inspectJsonValue(value, {
    ...context.references.limits,
    maxDepth: context.references.limits.maxDepth + 32,
    maxInputBytes: remainingBytes,
    maxNodes: remainingNodes,
  });
  if (inspection.failure !== undefined) {
    addCanonicalOutputBudgetDiagnostic(
      context,
      pointer,
      context.outputBudget.bytes + inspection.bytes,
      context.outputBudget.nodes + inspection.nodes,
    );
    return false;
  }
  context.outputBudget.bytes += inspection.bytes;
  context.outputBudget.nodes += inspection.nodes;
  return true;
}

export interface NonBlankStringResult {
  readonly present: boolean;
  readonly valid: boolean;
  readonly value?: string;
}

export function addExtractedEvent(
  events: ExtractedEvent[],
  event: ExtractedEvent,
  context: ExtractionContext,
): void {
  if (
    reserveCanonicalOutput(
      event as unknown as JsonValue,
      event.sourcePointer,
      context,
    )
  ) {
    events.push(event);
  }
}

export function readNonBlankString(
  object: JsonObject,
  key: string,
  pointer: string,
  context: ExtractionContext,
  code = "CANONICAL_EXTENSION_VALUE_INVALID",
): NonBlankStringResult {
  if (!Object.hasOwn(object, key)) {
    return { present: false, valid: true };
  }
  const value = object[key];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.trim() !== value
  ) {
    addAt(context, {
      code,
      details: { field: key },
      message: `"${key}" must be a non-empty string without surrounding whitespace`,
      pointer: joinPointer(pointer, key),
      severity: "error",
    });
    return { present: true, valid: false };
  }
  return { present: true, valid: true, value };
}

export function selectedString(
  primary: NonBlankStringResult,
  secondary: NonBlankStringResult,
  fallback: string,
): string | undefined {
  if (!primary.valid || !secondary.valid) return undefined;
  return primary.present
    ? primary.value
    : secondary.present
      ? secondary.value
      : fallback.trim() === "" || fallback.trim() !== fallback
        ? undefined
        : fallback;
}

export function resolveObject(
  value: JsonValue | undefined,
  pointer: string,
  context: ExtractionContext,
  kind: ReferenceObjectKind,
): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    addAt(context, {
      code: "EXPECTED_OBJECT",
      message: "Expected an object",
      pointer,
      severity: "error",
    });
    return undefined;
  }
  const resolved = resolveObjectValue(value, pointer, context.references, kind);
  if (resolved === undefined) {
    return undefined;
  }
  return resolved;
}

export function resolveSchema(
  value: JsonValue | undefined,
  pointer: string,
  context: ExtractionContext,
  defaultDialect: string,
): ResolvedPayloadSchema | undefined {
  if (context.validationBudget.exhausted || context.outputBudget.exhausted) {
    return undefined;
  }
  if (value === undefined) {
    addAt(context, {
      code: "PAYLOAD_SCHEMA_MISSING",
      message: "Webhook message is missing a payload JSON Schema",
      pointer,
      severity: "error",
    });
    return undefined;
  }

  if (!isJsonSchema(value)) {
    addAt(context, {
      code: "PAYLOAD_SCHEMA_INVALID",
      message: "Payload schema must be a JSON Schema object or boolean",
      pointer,
      severity: "error",
    });
    return undefined;
  }
  const processed = processJsonSchema(value, pointer, {
    defaultDialect,
    diagnostics: context.diagnostics,
    document: context.parsed.document ?? context.references.root,
    documentSchemaIndex: context.schemaIndex,
    limits: context.references.limits,
    locations: context.parsed.locations,
    referenceBudget: context.references.referenceBudget,
    rootSchemaIndexes: context.schemaRootIndexes,
    workBudget: context.validationBudget,
  });
  return processed.schema === undefined
    ? undefined
    : {
        bytes: processed.bytes,
        nodes: processed.outputNodes,
        schema: processed.schema,
      };
}

export function schemaDialect(
  schema: JsonSchema,
  document: JsonObject,
  format: "asyncapi" | "openapi",
  declaredDialect?: string,
): string {
  if (isJsonObject(schema) && typeof schema["$schema"] === "string") {
    return schema["$schema"];
  }

  const documentDeclared =
    asString(document["jsonSchemaDialect"]) ??
    asString(document["defaultSchemaFormat"]);
  const normalizedDocumentDeclared =
    format === "asyncapi" && documentDeclared !== undefined
      ? resolveAsyncApiSchemaDialect(
          documentDeclared,
          document["asyncapi"] === "2.6.0" ? "2.6.0" : "3.0.0",
        )
      : documentDeclared;
  const declared = declaredDialect ?? normalizedDocumentDeclared;
  if (declared?.includes("draft-07") === true) {
    return "http://json-schema.org/draft-07/schema#";
  }
  return (
    declared ??
    (format === "openapi"
      ? OPENAPI_3_1_BASE_DIALECT
      : document["asyncapi"] === "2.6.0"
        ? JSON_SCHEMA_DRAFT_07_DIALECT
        : JSON_SCHEMA_2020_12_DIALECT)
  );
}
