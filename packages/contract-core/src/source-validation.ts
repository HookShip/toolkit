// SPDX-License-Identifier: Apache-2.0

import { openapiV31 } from "@apidevtools/openapi-schemas";
import * as asyncApiSpecsModule from "@asyncapi/specs";
import { Ajv } from "ajv";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";

import {
  JSON_SCHEMA_2020_12_DIALECT,
  JSON_SCHEMA_DRAFT_07_DIALECT,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type SourceRange,
} from "@webhook-portal/canonical-model";

import { DiagnosticCollector } from "./diagnostics.js";
import { compareCodeUnits, joinPointer } from "./json-utils.js";

let openApiValidator: ValidateFunction | undefined;
const asyncApiValidators = new Map<string, ValidateFunction>();
const SOURCE_VALIDATION_ERROR_LIMIT = 8;
const HTTP_METHODS = [
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
] as const;

function ajvCompatibleOpenApiSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => ajvCompatibleOpenApiSchema(item));
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || key === "$dynamicAnchor") {
      continue;
    }
    // AJV resolves the OAS "#meta" dynamic reference against its own
    // metaschema. Pinning it to the official OAS Schema Object definition
    // preserves the package schema's intended validation semantics.
    if (key === "$dynamicRef" && item === "#meta") {
      result["$ref"] = "#/$defs/schema";
    } else {
      result[key] = ajvCompatibleOpenApiSchema(item) as JsonValue;
    }
  }
  return result;
}

function getOpenApiValidator(): ValidateFunction {
  if (openApiValidator !== undefined) {
    return openApiValidator;
  }

  const ajv = new Ajv2020({
    allErrors: false,
    allowUnionTypes: true,
    logger: false,
    loopEnum: 100,
    loopRequired: 100,
    strict: false,
    validateFormats: false,
  });
  const addFormats = addFormatsModule.default as unknown as (
    instance: Ajv2020,
  ) => Ajv2020;
  addFormats(ajv);
  openApiValidator = ajv.compile(
    ajvCompatibleOpenApiSchema(openapiV31) as object,
  );
  return openApiValidator;
}

function location(
  locations: Readonly<Record<string, SourceRange>>,
  pointer: string,
): SourceRange | undefined {
  return locations[pointer];
}

function openApiErrorPointer(error: ErrorObject): string {
  if (
    error.keyword === "required" &&
    typeof error.params["missingProperty"] === "string"
  ) {
    return joinPointer(error.instancePath, error.params["missingProperty"]);
  }
  return error.instancePath;
}

function validateOpenApi(
  document: JsonObject,
  locations: Readonly<Record<string, SourceRange>>,
  diagnostics: DiagnosticCollector,
): void {
  const validate = getOpenApiValidator();
  if (!validate(document)) {
    for (const error of (validate.errors ?? []).slice(
      0,
      SOURCE_VALIDATION_ERROR_LIMIT,
    )) {
      const pointer = openApiErrorPointer(error);
      diagnostics.add({
        code: "OPENAPI_DOCUMENT_INVALID",
        details: {
          keyword: error.keyword,
          schemaPath: error.schemaPath,
        },
        message: `OpenAPI 3.1 document is invalid: ${error.message ?? error.keyword}`,
        pointer,
        severity: "error",
        source: location(locations, pointer),
      });
    }
    return;
  }

  const webhooks = document["webhooks"];
  if (!isJsonObject(webhooks) || Object.keys(webhooks).length === 0) {
    diagnostics.add({
      code: "OPENAPI_WEBHOOKS_MISSING",
      message: "OpenAPI documents must define at least one top-level webhook",
      pointer: "/webhooks",
      severity: "error",
      source: location(locations, "/webhooks"),
    });
    return;
  }

  for (const webhookName of Object.keys(webhooks).sort(compareCodeUnits)) {
    const pathPointer = joinPointer("/webhooks", webhookName);
    const pathItem = webhooks[webhookName];
    if (!isJsonObject(pathItem) || typeof pathItem["$ref"] === "string") {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isJsonObject(operation)) {
        continue;
      }
      if (!isJsonObject(operation["responses"])) {
        const pointer = joinPointer(
          joinPointer(pathPointer, method),
          "responses",
        );
        diagnostics.add({
          code: "OPENAPI_WEBHOOK_RESPONSES_MISSING",
          message: `Webhook operation "${webhookName}.${method}" requires a responses object`,
          pointer,
          severity: "error",
          source: location(locations, pointer),
        });
      }
    }
  }
}

function getAsyncApiValidator(version: "2.6.0" | "3.0.0"): ValidateFunction {
  const cached = asyncApiValidators.get(version);
  if (cached !== undefined) {
    return cached;
  }
  const specs = asyncApiSpecsModule.default as unknown as {
    readonly schemasWithoutId: Readonly<Record<string, object>>;
  };
  const schema = specs.schemasWithoutId[version];
  if (schema === undefined) {
    throw new Error(`Pinned AsyncAPI schema ${version} is unavailable`);
  }
  const ajv = new Ajv({
    allErrors: false,
    logger: false,
    loopEnum: 100,
    loopRequired: 100,
    strict: false,
    validateFormats: false,
  });
  const validate = ajv.compile(schema);
  asyncApiValidators.set(version, validate);
  return validate;
}

function asyncApiErrorPointer(error: ErrorObject): string {
  if (
    error.keyword === "required" &&
    typeof error.params["missingProperty"] === "string"
  ) {
    return joinPointer(error.instancePath, error.params["missingProperty"]);
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params["additionalProperty"] === "string"
  ) {
    return joinPointer(error.instancePath, error.params["additionalProperty"]);
  }
  return error.instancePath;
}

function validateAsyncApi(
  document: JsonObject,
  version: string,
  locations: Readonly<Record<string, SourceRange>>,
  diagnostics: DiagnosticCollector,
): void {
  if (version !== "2.6.0" && version !== "3.0.0") {
    return;
  }
  const validate = getAsyncApiValidator(version);
  if (!validate(document)) {
    for (const error of (validate.errors ?? []).slice(
      0,
      SOURCE_VALIDATION_ERROR_LIMIT,
    )) {
      const pointer = asyncApiErrorPointer(error);
      diagnostics.add({
        code: "ASYNCAPI_DOCUMENT_INVALID",
        details: {
          keyword: error.keyword,
          schemaPath: error.schemaPath,
        },
        message: `AsyncAPI ${version} document is invalid: ${error.message ?? error.keyword}`,
        pointer,
        severity: "error",
        source: location(locations, pointer),
      });
    }
  }
}

export function validateSourceDocument(
  document: JsonObject,
  format: "asyncapi" | "openapi",
  version: string,
  locations: Readonly<Record<string, SourceRange>>,
  diagnostics: DiagnosticCollector,
): void {
  if (format === "openapi") {
    validateOpenApi(document, locations, diagnostics);
  } else {
    validateAsyncApi(document, version, locations, diagnostics);
  }
}

export function resolveAsyncApiSchemaDialect(
  value: JsonValue | undefined,
  version: "2.6.0" | "3.0.0",
): string | undefined {
  if (value === undefined) {
    return version === "2.6.0"
      ? JSON_SCHEMA_DRAFT_07_DIALECT
      : JSON_SCHEMA_2020_12_DIALECT;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase().replaceAll(/\s+/gu, "");
  if (
    normalized === "http://json-schema.org/draft-07/schema#" ||
    normalized === "https://json-schema.org/draft-07/schema" ||
    normalized.includes("version=draft-07")
  ) {
    return JSON_SCHEMA_DRAFT_07_DIALECT;
  }
  if (
    normalized === "https://json-schema.org/draft/2020-12/schema" ||
    normalized.includes("version=draft-2020-12") ||
    normalized.includes("version=2020-12")
  ) {
    return JSON_SCHEMA_2020_12_DIALECT;
  }
  if (
    normalized === `application/vnd.aai.asyncapi;version=${version}` ||
    normalized === `application/vnd.aai.asyncapi+json;version=${version}`
  ) {
    return version === "2.6.0"
      ? JSON_SCHEMA_DRAFT_07_DIALECT
      : JSON_SCHEMA_2020_12_DIALECT;
  }
  if (
    normalized === "application/schema+json" ||
    normalized === "application/json"
  ) {
    return version === "2.6.0"
      ? JSON_SCHEMA_DRAFT_07_DIALECT
      : JSON_SCHEMA_2020_12_DIALECT;
  }
  return undefined;
}
