// SPDX-License-Identifier: Apache-2.0

import type { FastifySchema } from "fastify";

export type JsonSchema = Readonly<Record<string, unknown>>;

export const OPENAPI_OBJECT: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: true,
});

export const OPENAPI_ERROR: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: true,
      required: ["code", "message", "requestId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
        details: {},
      },
    },
  },
});

export const OPENAPI_CLEANUP_RETRY_CONFLICT: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["error"],
  description:
    "The endpoint is not deleted, or its deleted tombstone has no failed or pending cleanup to retry.",
  properties: {
    error: {
      type: "object",
      additionalProperties: true,
      required: ["code", "message", "requestId"],
      properties: {
        code: {
          type: "string",
          enum: ["ENDPOINT_CLEANUP_RETRY_INVALID_TRANSITION"],
        },
        message: { type: "string" },
        requestId: { type: "string" },
        details: {},
      },
    },
  },
});

export const COMMON_ERROR_RESPONSES = Object.freeze({
  400: OPENAPI_ERROR,
  401: OPENAPI_ERROR,
  403: OPENAPI_ERROR,
  404: OPENAPI_ERROR,
  409: OPENAPI_ERROR,
  410: OPENAPI_ERROR,
  413: OPENAPI_ERROR,
  415: OPENAPI_ERROR,
  422: OPENAPI_ERROR,
  500: OPENAPI_ERROR,
  503: OPENAPI_ERROR,
});

export function pathParameters(...names: readonly string[]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: [...names],
    properties: Object.fromEntries(
      names.map((name) => [name, { type: "string", maxLength: 256 }]),
    ),
  };
}

export const IDEMPOTENCY_HEADERS: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: true,
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": {
      type: "string",
      minLength: 8,
      maxLength: 256,
    },
  },
});

export const INGEST_HEADERS: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: true,
  required: ["authorization", "x-webhook-ingest-credential"],
  properties: {
    authorization: {
      type: "string",
      pattern: "^Webhook-Ingest [A-Za-z0-9_-]{16,}$",
    },
    "x-webhook-ingest-credential": {
      type: "string",
      minLength: 1,
      maxLength: 256,
    },
  },
});

export const RELEASE_EVENT_PREVIEW_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["id", "externalName", "externalNameTruncated", "versionCount"],
  properties: {
    id: { type: "string", maxLength: 64 },
    externalName: { type: "string", maxLength: 256 },
    externalNameTruncated: { type: "boolean" },
    versionCount: { type: "integer", minimum: 0 },
  },
});

export const RELEASE_METADATA_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "importId",
    "sequence",
    "checksum",
    "status",
    "createdAt",
    "compatibilityStatus",
    "changeCount",
    "eventSummary",
  ],
  properties: {
    id: { type: "string", maxLength: 256 },
    importId: { type: "string", maxLength: 256 },
    sequence: { type: "integer", minimum: 1 },
    checksum: { type: "string", pattern: "^[0-9a-f]{64}$" },
    status: { type: "string", enum: ["active", "superseded"] },
    createdAt: { type: "string", format: "date-time", maxLength: 64 },
    compatibilityStatus: {
      type: "string",
      enum: ["initial", "breaking", "compatible", "docs-only", "unknown"],
    },
    changeCount: { type: "integer", minimum: 0 },
    eventSummary: {
      type: "object",
      additionalProperties: false,
      required: ["eventTypeCount", "eventVersionCount", "preview", "truncated"],
      properties: {
        eventTypeCount: { type: "integer", minimum: 0 },
        eventVersionCount: { type: "integer", minimum: 0 },
        preview: {
          type: "array",
          maxItems: 20,
          items: RELEASE_EVENT_PREVIEW_SCHEMA,
        },
        truncated: { type: "boolean" },
      },
    },
  },
});

export const PUBLISH_COMMAND_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "importId",
    "requestFingerprint",
    "state",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", maxLength: 256 },
    importId: { type: "string", maxLength: 256 },
    requestFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    state: { type: "string", enum: ["completed", "requested"] },
    createdAt: { type: "string", format: "date-time", maxLength: 64 },
    updatedAt: { type: "string", format: "date-time", maxLength: 64 },
    predecessorReleaseId: { type: "string", maxLength: 256 },
    releaseId: { type: "string", maxLength: 256 },
  },
});

export const PUBLISH_COMPLETED_RESPONSE: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "idempotencyKey", "release"],
  properties: {
    status: { type: "string", enum: ["completed"] },
    idempotencyKey: { type: "string", maxLength: 256 },
    command: PUBLISH_COMMAND_SCHEMA,
    release: RELEASE_METADATA_SCHEMA,
  },
});

export const PUBLISH_PENDING_RESPONSE: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "idempotencyKey"],
  properties: {
    status: { type: "string", enum: ["pending", "unknown"] },
    idempotencyKey: { type: "string", maxLength: 256 },
    command: PUBLISH_COMMAND_SCHEMA,
    reason: { type: "string", enum: ["release_not_found"] },
  },
});

export const RELEASE_LIST_RESPONSE: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["releases"],
  properties: {
    releases: {
      type: "array",
      maxItems: 100,
      items: RELEASE_METADATA_SCHEMA,
    },
    nextBeforeSequence: { type: "integer", minimum: 1 },
  },
});

export interface OperationSchemaOptions {
  readonly body?: JsonSchema;
  readonly consumes?: readonly string[];
  readonly description?: string;
  readonly headers?: JsonSchema;
  readonly params?: JsonSchema;
  readonly public?: boolean;
  readonly querystring?: JsonSchema;
  readonly response?: Readonly<Record<number, JsonSchema>>;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
}

export function isOperationSchemaOptions(
  value: JsonSchema | OperationSchemaOptions,
): value is OperationSchemaOptions {
  const candidate = value as Readonly<Record<string, unknown>>;
  return [
    "body",
    "consumes",
    "description",
    "headers",
    "params",
    "public",
    "querystring",
    "response",
    "security",
  ].some((key) => key in candidate);
}

export function schema(
  summary: string,
  tags: readonly string[],
  bodyOrOptions?: JsonSchema | OperationSchemaOptions,
): FastifySchema {
  const options: OperationSchemaOptions =
    bodyOrOptions !== undefined && isOperationSchemaOptions(bodyOrOptions)
      ? bodyOrOptions
      : bodyOrOptions === undefined
        ? {}
        : { body: bodyOrOptions as JsonSchema };
  return {
    summary,
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    tags: [...tags],
    security:
      options.security ??
      (options.public === true ? [] : [{ apiToken: [] as string[] }]),
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.consumes === undefined
      ? {}
      : { consumes: [...options.consumes] }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.params === undefined ? {} : { params: options.params }),
    ...(options.querystring === undefined
      ? {}
      : { querystring: options.querystring }),
    response: {
      ...(options.public === true ? {} : COMMON_ERROR_RESPONSES),
      ...(options.response ?? { 200: OPENAPI_OBJECT }),
    },
  };
}
