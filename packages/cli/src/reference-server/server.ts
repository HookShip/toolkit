// SPDX-License-Identifier: Apache-2.0

import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifySchema,
} from "fastify";
import swagger from "@fastify/swagger";

import type { SecretCipher } from "./crypto.js";
import {
  DisabledPayloadStorage,
  ensurePayloadStorageIdentity,
  startPayloadMaintenance,
  type PayloadMaintenanceController,
  type PayloadMaintenanceStatus,
  type PayloadStorage,
  type PayloadStorageCapabilities,
} from "./payload-storage.js";
import {
  ReferenceApiError,
  ReferenceService,
  type ReferenceServiceOptions,
} from "./service.js";
import { safeTokenEqual } from "./crypto.js";
import { EXPECTED_REFERENCE_SCHEMA_VERSION } from "./migrations.js";
import type {
  PayloadCleanupTask,
  PublishCommandRecord,
  ReferenceRepository,
  RepositoryReadiness,
  ReferenceServerConfig,
  TestCommandRecord,
} from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface BuildReferenceServerOptions {
  readonly repository: ReferenceRepository;
  readonly cipher: SecretCipher;
  readonly config: ReferenceServerConfig;
  readonly payloadStorage?: PayloadStorage;
  readonly transport?: ReferenceServiceOptions["transport"];
  readonly clock?: ReferenceServiceOptions["clock"];
  readonly idFactory?: ReferenceServiceOptions["idFactory"];
  readonly backgroundFailureReporter?: (failure: {
    readonly operation: "payload_maintenance";
    readonly failureCount: number;
    readonly errorCode?: string;
  }) => void;
}

export interface BuiltReferenceServer {
  readonly app: FastifyInstance;
  readonly payloadMaintenance?: PayloadMaintenanceController;
  readonly service: ReferenceService;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (!isObject(request.body)) {
    throw new ReferenceApiError(
      400,
      "INVALID_BODY",
      "A JSON object request body is required.",
    );
  }
  return request.body;
}

function stringField(
  object: Record<string, unknown>,
  name: string,
  options: { readonly required?: boolean; readonly maxLength?: number } = {},
): string | undefined {
  const value = object[name];
  if (value === undefined && options.required !== true) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > (options.maxLength ?? 4096)
  ) {
    throw new ReferenceApiError(
      400,
      "INVALID_FIELD",
      `Field "${name}" must be a non-empty string within its size limit.`,
    );
  }
  return value;
}

function booleanField(
  object: Record<string, unknown>,
  name: string,
  fallback = false,
): boolean {
  const value = object[name];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ReferenceApiError(
      400,
      "INVALID_FIELD",
      `Field "${name}" must be a boolean.`,
    );
  }
  return value;
}

function integerField(
  object: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = object[name];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ReferenceApiError(
      400,
      "INVALID_FIELD",
      `Field "${name}" must be an integer.`,
    );
  }
  return value;
}

function stringArrayField(
  object: Record<string, unknown>,
  name: string,
): readonly string[] {
  const value = object[name];
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some(
      (item) =>
        typeof item !== "string" || item.length === 0 || item.length > 256,
    )
  ) {
    throw new ReferenceApiError(
      400,
      "INVALID_FIELD",
      `Field "${name}" must be an array of bounded strings.`,
    );
  }
  return value;
}

function parameter(request: FastifyRequest, name: string): string {
  const params = request.params;
  if (!isObject(params) || typeof params[name] !== "string") {
    throw new ReferenceApiError(
      400,
      "INVALID_PARAMETER",
      `Path parameter "${name}" is required.`,
    );
  }
  return params[name];
}

function queryObject(request: FastifyRequest): Record<string, unknown> {
  return isObject(request.query) ? request.query : {};
}

function queryString(
  query: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = query[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function queryLimit(
  query: Record<string, unknown>,
  fallback: number,
  maximum: number,
): number {
  const candidate = query["limit"];
  const raw =
    typeof candidate === "number" ? candidate : queryString(query, "limit");
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ReferenceApiError(
      400,
      "INVALID_LIMIT",
      `The limit must be between 1 and ${maximum}.`,
    );
  }
  return value;
}

function queryPositiveInteger(
  query: Record<string, unknown>,
  name: string,
): number | undefined {
  const candidate = query[name];
  if (candidate === undefined) {
    return undefined;
  }
  const value = Number(candidate);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReferenceApiError(
      400,
      "INVALID_PARAMETER",
      `The ${name} parameter must be a positive integer.`,
    );
  }
  return value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function publicTestCommand(command: TestCommandRecord) {
  const evidenceStatus =
    command.evidenceState === "complete"
      ? command.result?.state === "unknown"
        ? "unknown"
        : "completed"
      : command.pendingResult !== undefined
        ? "pending"
        : command.state === "requested"
          ? "requested"
          : "pending";
  return {
    id: command.id,
    endpointId: command.endpointId,
    eventType: command.eventType,
    state: command.state,
    evidence: {
      status: evidenceStatus,
      state: command.evidenceState,
      ...(command.resultObservedAt === undefined
        ? {}
        : { observedAt: command.resultObservedAt }),
      ...(command.pendingResult === undefined
        ? {}
        : { observedResult: command.pendingResult }),
    },
    releaseId: command.context.releaseId,
    version: command.context.eventVersion,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    ...(command.dispatchedAt === undefined
      ? {}
      : { dispatchedAt: command.dispatchedAt }),
    ...(command.result === undefined ? {} : { result: command.result }),
  };
}

function publicPublishCommand(command: PublishCommandRecord) {
  return {
    id: command.id,
    importId: command.importId,
    requestFingerprint: command.requestFingerprint,
    state: command.state,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    ...(command.predecessorReleaseId === undefined
      ? {}
      : { predecessorReleaseId: command.predecessorReleaseId }),
    ...(command.releaseId === undefined
      ? {}
      : { releaseId: command.releaseId }),
  };
}

function publicCleanupTask(task: PayloadCleanupTask) {
  return {
    id: task.id,
    reason: task.reason,
    state: task.state,
    attempts: task.attempts,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: task.lastErrorCode }),
  };
}

interface PublicPayloadMaintenanceStatus {
  readonly enabled: boolean;
  readonly captureEnabled: boolean;
  readonly ready: boolean;
  readonly state: "degraded" | "disabled" | "ready" | "running" | "starting";
  readonly storageCapabilities: PayloadStorageCapabilities;
  readonly paginationPending: boolean;
  readonly lastRun?: {
    readonly startedAt: string;
    readonly completedAt: string;
    readonly failureCount: number;
    readonly expiredDeleted: number;
    readonly cleanupDeleted: number;
    readonly orphanObjectsDeleted: number;
    readonly danglingReferencesCleared: number;
    readonly uploadIntentsCleared: number;
  };
  readonly lastFailure?: {
    readonly at: string;
    readonly count: number;
    readonly errorCode?: string;
  };
}

function publicPayloadMaintenanceStatus(
  controller: PayloadMaintenanceController | undefined,
  capabilities: PayloadStorageCapabilities,
  captureEnabled: boolean,
  cleanupRequiredWithoutStorage: boolean,
): PublicPayloadMaintenanceStatus {
  if (controller === undefined) {
    return {
      enabled: false,
      captureEnabled,
      ready: !cleanupRequiredWithoutStorage,
      state: cleanupRequiredWithoutStorage ? "degraded" : "disabled",
      storageCapabilities: capabilities,
      paginationPending: false,
    };
  }
  const status: PayloadMaintenanceStatus = controller.status();
  const lastReport = status.lastReport;
  const ready = !status.degraded && lastReport !== undefined;
  return {
    enabled: true,
    captureEnabled,
    ready,
    state: status.degraded
      ? "degraded"
      : status.running
        ? "running"
        : lastReport === undefined
          ? "starting"
          : "ready",
    storageCapabilities: capabilities,
    paginationPending: lastReport?.nextCursor !== undefined,
    ...(lastReport === undefined
      ? {}
      : {
          lastRun: {
            startedAt: lastReport.startedAt,
            completedAt: lastReport.completedAt,
            failureCount: lastReport.failureCount,
            expiredDeleted: lastReport.expiry.deleted,
            cleanupDeleted: lastReport.cleanup.deleted,
            orphanObjectsDeleted:
              lastReport.reconciliation.deletedOrphanObjects,
            danglingReferencesCleared:
              lastReport.reconciliation.clearedDanglingReferences,
            uploadIntentsCleared:
              lastReport.reconciliation.clearedUploadIntents,
          },
        }),
    ...(status.lastFailureAt === undefined ||
    status.lastFailureCount === undefined
      ? {}
      : {
          lastFailure: {
            at: status.lastFailureAt,
            count: status.lastFailureCount,
            ...(status.lastErrorCode === undefined
              ? {}
              : { errorCode: status.lastErrorCode }),
          },
        }),
  };
}

function publicSchemaReadiness(readiness: RepositoryReadiness) {
  return {
    expectedVersion: readiness.expectedSchemaVersion,
    currentVersion: readiness.currentSchemaVersion ?? null,
    missingVersions: readiness.missingSchemaVersions,
    unexpectedVersions: readiness.unexpectedSchemaVersions,
    checksumMismatchVersions: readiness.checksumMismatches.map(
      (entry) => entry.version,
    ),
  };
}

function payloadMaintenanceMetrics(
  status: PublicPayloadMaintenanceStatus,
): string {
  const lastRun = status.lastRun;
  const lastCompletedSeconds =
    lastRun === undefined ? 0 : Date.parse(lastRun.completedAt) / 1000;
  const lines = [
    "# HELP webhook_portal_payload_capture_enabled Whether new payload capture is enabled.",
    "# TYPE webhook_portal_payload_capture_enabled gauge",
    `webhook_portal_payload_capture_enabled ${status.captureEnabled ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_enabled Whether cleanup-capable object storage is configured.",
    "# TYPE webhook_portal_payload_maintenance_enabled gauge",
    `webhook_portal_payload_maintenance_enabled ${status.enabled ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_ready Whether the latest maintenance cycle is healthy.",
    "# TYPE webhook_portal_payload_maintenance_ready gauge",
    `webhook_portal_payload_maintenance_ready ${status.ready ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_degraded Whether maintenance has an uncleared failure.",
    "# TYPE webhook_portal_payload_maintenance_degraded gauge",
    `webhook_portal_payload_maintenance_degraded ${status.state === "degraded" ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_pagination_pending Whether another bounded page remains.",
    "# TYPE webhook_portal_payload_maintenance_pagination_pending gauge",
    `webhook_portal_payload_maintenance_pagination_pending ${status.paginationPending ? 1 : 0}`,
    "# HELP webhook_portal_payload_maintenance_last_completed_timestamp_seconds Last completed maintenance page.",
    "# TYPE webhook_portal_payload_maintenance_last_completed_timestamp_seconds gauge",
    `webhook_portal_payload_maintenance_last_completed_timestamp_seconds ${Number.isFinite(lastCompletedSeconds) ? lastCompletedSeconds : 0}`,
    "# HELP webhook_portal_payload_maintenance_last_failure_count Failure count retained from the latest unhealthy page.",
    "# TYPE webhook_portal_payload_maintenance_last_failure_count gauge",
    `webhook_portal_payload_maintenance_last_failure_count ${status.lastFailure?.count ?? 0}`,
    "# HELP webhook_portal_payload_maintenance_last_run_deleted_objects Objects deleted by the latest maintenance page.",
    "# TYPE webhook_portal_payload_maintenance_last_run_deleted_objects gauge",
    `webhook_portal_payload_maintenance_last_run_deleted_objects ${
      (lastRun?.expiredDeleted ?? 0) +
      (lastRun?.cleanupDeleted ?? 0) +
      (lastRun?.orphanObjectsDeleted ?? 0)
    }`,
  ];
  return `${lines.join("\n")}\n`;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ReferenceApiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header between 8 and 256 safe characters is required.",
    );
  }
  return value;
}

function verifyIngestAuthorization(request: FastifyRequest): void {
  const body = bodyObject(request);
  const authorization = request.headers.authorization;
  const credentialId = request.headers["x-webhook-ingest-credential"];
  const bodyCredentialId = body["credentialId"];
  const signature = body["signature"];
  const bodySignature =
    isObject(signature) && typeof signature["value"] === "string"
      ? signature["value"]
      : "";
  const headerSignature = authorization?.startsWith("Webhook-Ingest ")
    ? authorization.slice("Webhook-Ingest ".length)
    : "";
  if (
    typeof credentialId !== "string" ||
    typeof bodyCredentialId !== "string" ||
    !safeTokenEqual(credentialId, bodyCredentialId) ||
    !safeTokenEqual(headerSignature, bodySignature)
  ) {
    throw new ReferenceApiError(
      401,
      "INVALID_INGEST_AUTHORIZATION",
      "Valid metadata ingest authorization headers are required.",
    );
  }
}

async function deleteEndpointAndReport(
  service: ReferenceService,
  repository: ReferenceRepository,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const endpointId = parameter(request, "id");
  try {
    await service.updateEndpoint(endpointId, {
      state: "deleted",
      correlationId: request.id,
    });
  } catch (error) {
    if (
      !(error instanceof ReferenceApiError) ||
      error.code !== "ENDPOINT_PAYLOAD_CLEANUP_PENDING"
    ) {
      throw error;
    }
  }
  const endpoint = await repository.getEndpoint(endpointId);
  if (endpoint === undefined) {
    throw new ReferenceApiError(
      404,
      "ENDPOINT_NOT_FOUND",
      "The endpoint was not found.",
    );
  }
  const tasks = await repository.listPayloadCleanupTasks(10_000, endpointId);
  return reply.status(tasks.length === 0 ? 200 : 202).send({
    endpoint,
    cleanup: {
      state: tasks.length === 0 ? "completed" : "pending",
      tasks: tasks.map(publicCleanupTask),
    },
  });
}

async function retryEndpointCleanupAndReport(
  service: ReferenceService,
  repository: ReferenceRepository,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const endpointId = parameter(request, "id");
  const endpoint = await repository.getEndpoint(endpointId);
  if (endpoint === undefined) {
    throw new ReferenceApiError(
      404,
      "ENDPOINT_NOT_FOUND",
      "The endpoint was not found.",
    );
  }
  if (endpoint.state !== "deleted") {
    throw new ReferenceApiError(
      409,
      "ENDPOINT_CLEANUP_RETRY_INVALID_TRANSITION",
      "Payload cleanup can be retried only for a deleted endpoint.",
      { currentState: endpoint.state },
    );
  }
  const tasks = await repository.listPayloadCleanupTasks(10_000, endpointId);
  if (tasks.length === 0) {
    throw new ReferenceApiError(
      409,
      "ENDPOINT_CLEANUP_RETRY_INVALID_TRANSITION",
      "The deleted endpoint has no failed or pending payload cleanup to retry.",
      { currentState: endpoint.state, cleanupState: "completed" },
    );
  }
  return deleteEndpointAndReport(service, repository, request, reply);
}

function securityHeaders(reply: FastifyReply): void {
  void reply
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY")
    .header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
}

function isPublicUnauthenticatedPath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return (
    path === "/health/live" ||
    path === "/health/maintenance" ||
    path === "/health/ready" ||
    path === "/metrics" ||
    path === "/v1/ingest" ||
    path.startsWith("/v1/test-receiver/")
  );
}

function registerJsonParser(app: FastifyInstance): void {
  app.removeContentTypeParser("application/json");
  const parser = (
    request: FastifyRequest,
    body: Buffer,
    done: (error: Error | null, value?: unknown) => void,
  ): void => {
    request.rawBody = Buffer.from(body);
    if (body.byteLength === 0) {
      done(null, null);
      return;
    }
    try {
      done(null, JSON.parse(body.toString("utf8")) as unknown);
    } catch {
      const error = new SyntaxError(
        "Invalid JSON request body.",
      ) as SyntaxError & {
        statusCode: number;
      };
      error.statusCode = 400;
      done(error);
    }
  };
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, parser);
  app.addContentTypeParser(
    "application/webhook+json",
    { parseAs: "buffer" },
    parser,
  );
}

type JsonSchema = Readonly<Record<string, unknown>>;

const OPENAPI_OBJECT: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: true,
});

const OPENAPI_ERROR: JsonSchema = Object.freeze({
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

const OPENAPI_CLEANUP_RETRY_CONFLICT: JsonSchema = Object.freeze({
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

const COMMON_ERROR_RESPONSES = Object.freeze({
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

function pathParameters(...names: readonly string[]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: [...names],
    properties: Object.fromEntries(
      names.map((name) => [name, { type: "string", maxLength: 256 }]),
    ),
  };
}

const IDEMPOTENCY_HEADERS: JsonSchema = Object.freeze({
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

const INGEST_HEADERS: JsonSchema = Object.freeze({
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

const RELEASE_EVENT_PREVIEW_SCHEMA: JsonSchema = Object.freeze({
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

const RELEASE_METADATA_SCHEMA: JsonSchema = Object.freeze({
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

const PUBLISH_COMMAND_SCHEMA: JsonSchema = Object.freeze({
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

const PUBLISH_COMPLETED_RESPONSE: JsonSchema = Object.freeze({
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

const PUBLISH_PENDING_RESPONSE: JsonSchema = Object.freeze({
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

const RELEASE_LIST_RESPONSE: JsonSchema = Object.freeze({
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

interface OperationSchemaOptions {
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

function isOperationSchemaOptions(
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

function schema(
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

export async function buildReferenceServer(
  options: BuildReferenceServerOptions,
): Promise<BuiltReferenceServer> {
  const payloadStorage = options.payloadStorage ?? new DisabledPayloadStorage();
  let cleanupRequiredWithoutStorage = false;
  const refreshCleanupRequirement = async (): Promise<boolean> => {
    if (payloadStorage.capabilities.cleanup) {
      cleanupRequiredWithoutStorage = false;
      return false;
    }
    cleanupRequiredWithoutStorage =
      await options.repository.hasPayloadPersistenceState();
    return cleanupRequiredWithoutStorage;
  };
  if (!payloadStorage.capabilities.cleanup) {
    try {
      await refreshCleanupRequirement();
    } catch {
      cleanupRequiredWithoutStorage = true;
    }
  }
  const backgroundFailureReporter =
    options.backgroundFailureReporter ??
    ((failure: {
      readonly operation: "payload_maintenance";
      readonly failureCount: number;
      readonly errorCode?: string;
    }) => {
      process.stderr.write(
        `Reference background operation ${failure.operation} reported ${failure.failureCount} failure(s)${failure.errorCode === undefined ? "" : ` (${failure.errorCode})`}.\n`,
      );
    });
  const service = new ReferenceService({
    repository: options.repository,
    cipher: options.cipher,
    config: options.config,
    payloadStorage,
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.idFactory === undefined
      ? {}
      : { idFactory: options.idFactory }),
  });
  const app = fastify({
    bodyLimit: options.config.requestBodyLimitBytes,
    connectionTimeout: 15_000,
    ...(options.config.tls === undefined
      ? {}
      : {
          https: {
            cert: options.config.tls.certificate,
            key: options.config.tls.privateKey,
          },
        }),
    logger: false,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 256 },
    trustProxy: false,
  });
  const payloadMaintenance: PayloadMaintenanceController | undefined =
    payloadStorage.capabilities.cleanup
      ? startPayloadMaintenance(options.repository, payloadStorage, {
          batchSize: options.config.payloadMaintenance.batchSize,
          gracePeriodMilliseconds:
            options.config.payloadMaintenance.gracePeriodMilliseconds,
          intervalMilliseconds:
            options.config.payloadMaintenance.intervalMilliseconds,
          preflight: async () => {
            await ensurePayloadStorageIdentity(
              options.repository,
              payloadStorage,
              {
                namespaceId: options.config.payloadStorageNamespaceId,
                storeId: options.config.payloadStorageStoreId,
                ...(options.clock === undefined
                  ? {}
                  : { clock: options.clock }),
              },
            );
          },
          runOnStart: false,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          onReport: (report) => {
            if (report.failureCount > 0) {
              backgroundFailureReporter({
                operation: "payload_maintenance",
                failureCount: report.failureCount,
              });
            }
          },
          onError: (errorCode) => {
            backgroundFailureReporter({
              operation: "payload_maintenance",
              failureCount: 1,
              errorCode,
            });
          },
        })
      : undefined;
  const maintenanceStatus = (): PublicPayloadMaintenanceStatus =>
    publicPayloadMaintenanceStatus(
      payloadMaintenance,
      payloadStorage.capabilities,
      options.config.payloadRetention.enabled,
      cleanupRequiredWithoutStorage,
    );
  registerJsonParser(app);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Webhook Portal Reference API",
        version: "1.0.0",
        description:
          "Open single-team contract, endpoint, signed-test, and metadata timeline API.",
      },
      components: {
        securitySchemes: {
          apiToken: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "opaque API token",
            description:
              "Required for every control, documentation, and preview route, including loopback.",
          },
          metadataIngest: {
            type: "apiKey",
            in: "header",
            name: "Authorization",
            description:
              "Webhook-Ingest signature mirrored from the authenticated ingest envelope.",
          },
          webhookSignature: {
            type: "apiKey",
            in: "header",
            name: "webhook-signature",
            description: "Standard Webhooks signature over the exact raw body.",
          },
        },
      },
    },
  });

  app.addHook("onRequest", async (request) => {
    if (isPublicUnauthenticatedPath(request.url)) {
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!safeTokenEqual(options.config.apiToken, token)) {
      throw new ReferenceApiError(
        401,
        "UNAUTHORIZED",
        "A valid local API token is required.",
      );
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    securityHeaders(reply);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const bodyTooLarge =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FST_ERR_CTP_BODY_TOO_LARGE";
    const unsupportedMediaType =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE";
    const invalidRequest =
      typeof error === "object" &&
      error !== null &&
      (("validation" in error && Array.isArray(error.validation)) ||
        ("statusCode" in error && error.statusCode === 400));
    const apiError =
      error instanceof ReferenceApiError
        ? error
        : bodyTooLarge
          ? new ReferenceApiError(
              413,
              "BODY_TOO_LARGE",
              "The request body exceeded its configured limit.",
            )
          : unsupportedMediaType
            ? new ReferenceApiError(
                415,
                "UNSUPPORTED_MEDIA_TYPE",
                "The request content type is not supported.",
              )
            : invalidRequest
              ? new ReferenceApiError(
                  400,
                  "INVALID_REQUEST",
                  "The request did not match the API schema.",
                )
              : new ReferenceApiError(
                  500,
                  "INTERNAL_ERROR",
                  "The request could not be completed.",
                );
    if (apiError.statusCode === 401) {
      void reply.header(
        "www-authenticate",
        'Bearer realm="webhook-portal-reference"',
      );
    }
    return reply.status(apiError.statusCode).send({
      error: {
        code: apiError.code,
        message: apiError.message,
        requestId: request.id,
        ...(apiError.details === undefined
          ? {}
          : { details: apiError.details }),
      },
    });
  });
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "The requested API route was not found.",
        requestId: request.id,
      },
    });
  });

  app.get(
    "/health/live",
    {
      schema: schema("Liveness probe", ["health"], {
        public: true,
        response: { 200: OPENAPI_OBJECT },
      }),
    },
    async () => ({ status: "ok" }),
  );
  app.get(
    "/health/ready",
    {
      schema: schema("Readiness probe", ["health"], {
        public: true,
        response: { 200: OPENAPI_OBJECT, 503: OPENAPI_OBJECT },
      }),
    },
    async (_request, reply) => {
      let readiness: RepositoryReadiness;
      try {
        readiness = await options.repository.readiness();
      } catch {
        return reply.status(503).send({
          status: "not_ready",
          schema: {
            expectedVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
            currentVersion: null,
            missingVersions: [],
            unexpectedVersions: [],
            checksumMismatchVersions: [],
          },
          payloadMaintenance: maintenanceStatus(),
          reason: "repository_unavailable",
        });
      }
      const schema = publicSchemaReadiness(readiness);
      if (!readiness.ready) {
        return reply.status(503).send({
          status: "not_ready",
          schema,
          payloadMaintenance: maintenanceStatus(),
          reason: "migration_state",
        });
      }
      if (!payloadStorage.capabilities.cleanup) {
        try {
          await refreshCleanupRequirement();
        } catch {
          return reply.status(503).send({
            status: "not_ready",
            schema,
            payloadMaintenance: maintenanceStatus(),
            reason: "repository_unavailable",
          });
        }
        if (cleanupRequiredWithoutStorage) {
          return reply.status(503).send({
            status: "not_ready",
            schema,
            payloadMaintenance: maintenanceStatus(),
            reason: "payload_storage_required",
          });
        }
      }
      if (payloadStorage.capabilities.cleanup) {
        try {
          await payloadStorage.ping();
        } catch {
          return reply.status(503).send({
            status: "not_ready",
            schema,
            payloadMaintenance: maintenanceStatus(),
            reason: "payload_storage_unavailable",
          });
        }
      }
      const maintenance = maintenanceStatus();
      if (!maintenance.ready) {
        return reply.status(503).send({
          status: "not_ready",
          schema,
          payloadMaintenance: maintenance,
          reason: "payload_maintenance",
        });
      }
      return {
        status: "ready",
        schema,
        payloadMaintenance: maintenance,
      };
    },
  );
  app.get(
    "/health/maintenance",
    {
      schema: schema("Payload maintenance status", ["health"], {
        public: true,
        response: { 200: OPENAPI_OBJECT, 503: OPENAPI_OBJECT },
      }),
    },
    async (_request, reply) => {
      if (!payloadStorage.capabilities.cleanup) {
        try {
          await refreshCleanupRequirement();
        } catch {
          cleanupRequiredWithoutStorage = true;
        }
      }
      const maintenance = maintenanceStatus();
      return reply.status(maintenance.ready ? 200 : 503).send({
        status: maintenance.ready ? "ready" : "not_ready",
        maintenance,
      });
    },
  );
  app.get("/metrics", { schema: { hide: true } }, async (_request, reply) => {
    if (!payloadStorage.capabilities.cleanup) {
      try {
        await refreshCleanupRequirement();
      } catch {
        cleanupRequiredWithoutStorage = true;
      }
    }
    return reply
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(payloadMaintenanceMetrics(maintenanceStatus()));
  });

  app.get("/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );
  app.get("/docs", { schema: { hide: true } }, async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reference API documentation</title><style>
body{font:16px/1.55 system-ui,sans-serif;max-width:72rem;margin:auto;padding:2rem;color:#17202a}
a{color:#075985}code{background:#f1f5f9;padding:.15rem .3rem;border-radius:.2rem}
:focus-visible{outline:3px solid #0ea5e9;outline-offset:2px}
</style></head><body><main><h1>Webhook Portal Reference API</h1>
<p>This local single-team server exposes versioned contract releases, endpoint and secret lifecycle,
at-most-once signed tests, and an authenticated metadata timeline.</p>
<ul><li><a href="/preview">Local release preview</a></li>
<li><a href="/openapi.json">OpenAPI JSON</a></li>
<li><code>GET /health/ready</code></li>
<li><code>GET /health/maintenance</code></li>
<li><code>GET /metrics</code></li></ul>
</main></body></html>`);
  });

  const previewHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const query = queryObject(request);
    const importId = queryString(query, "importId");
    const releaseId = queryString(query, "releaseId");
    if (importId !== undefined && releaseId !== undefined) {
      throw new ReferenceApiError(
        400,
        "PREVIEW_SOURCE_CONFLICT",
        "Choose either importId or releaseId for preview.",
      );
    }
    const selectedRelease =
      releaseId === undefined
        ? importId === undefined
          ? await options.repository.getActiveRelease()
          : undefined
        : await options.repository.getRelease(releaseId);
    if (releaseId !== undefined && selectedRelease === undefined) {
      throw new ReferenceApiError(
        404,
        "RELEASE_NOT_FOUND",
        "The release preview candidate was not found.",
      );
    }
    const selectedImport =
      importId === undefined
        ? undefined
        : await options.repository.getContractImport(importId);
    if (importId !== undefined && selectedImport === undefined) {
      throw new ReferenceApiError(
        404,
        "IMPORT_NOT_FOUND",
        "The contract import preview candidate was not found.",
      );
    }
    if (selectedImport !== undefined && selectedImport.contract === undefined) {
      throw new ReferenceApiError(
        422,
        "IMPORT_NOT_PREVIEWABLE",
        "The contract import has no previewable canonical contract.",
        { importStatus: selectedImport.status },
      );
    }
    const contract = selectedImport?.contract ?? selectedRelease?.contract;
    const previewLabel =
      selectedImport !== undefined
        ? `Draft import ${selectedImport.id}`
        : selectedRelease !== undefined
          ? `${selectedRelease.active ? "Active" : "Candidate"} release ${selectedRelease.id}`
          : "No active release";
    const endpoints = await options.repository.listEndpoints();
    const timeline = await options.repository.listTimeline({ limit: 20 });
    const events =
      contract?.eventTypes
        .map(
          (
            event,
          ) => `<article><h2>${escapeHtml(event.title ?? event.externalName)}</h2>
<p><code>${escapeHtml(event.externalName)}</code></p>
${event.description === undefined ? "" : `<p>${escapeHtml(event.description)}</p>`}
<ul>${event.versions
            .map(
              (version) =>
                `<li>Version ${escapeHtml(version.publicVersion)} — ${version.examples.length} example(s)</li>`,
            )
            .join("")}</ul></article>`,
        )
        .join("") ?? "<p>No release has been published.</p>";
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Webhook Portal local preview</title><style>
body{font:16px/1.55 system-ui,sans-serif;max-width:72rem;margin:auto;padding:2rem;color:#17202a}
header{border-bottom:1px solid #cbd5e1;margin-bottom:2rem}.meta{color:#475569}
article,section{padding:1rem 0;border-bottom:1px solid #e2e8f0}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.5rem;border-bottom:1px solid #e2e8f0}a{color:#075985}
:focus-visible{outline:3px solid #0ea5e9;outline-offset:2px}
</style></head><body><a href="#content">Skip to content</a><header>
<h1>${escapeHtml(contract?.title ?? "Webhook Portal local preview")}</h1>
<p class="meta">Environment: ${escapeHtml(options.config.metadataIdentity.environment)} ·
${escapeHtml(previewLabel)}</p></header>
<main id="content"><section aria-labelledby="events"><h2 id="events">Event catalog</h2>${events}</section>
<section aria-labelledby="endpoints"><h2 id="endpoints">Endpoints</h2>
<p>${endpoints.length} configured endpoint(s). Secret values are never displayed here.</p></section>
<section aria-labelledby="timeline"><h2 id="timeline">Recent timeline</h2>
${
  timeline.items.length === 0
    ? "<p>No metadata yet. Payload not stored.</p>"
    : `<table><thead><tr><th>Event</th><th>Status</th><th>Occurred</th><th>Payload</th></tr></thead><tbody>${timeline.items
        .map(
          (entry) =>
            `<tr><td>${escapeHtml(entry.current.eventVersion.eventType)}</td><td>${escapeHtml(entry.current.status)}</td><td>${escapeHtml(entry.current.occurredAt)}</td><td>${entry.payloadRetained ? "retained locally with TTL" : "not stored"}</td></tr>`,
        )
        .join("")}</tbody></table>`
}</section>
<p><a href="/docs">API documentation</a></p></main></body></html>`);
  };
  app.get("/", { schema: { hide: true } }, previewHandler);
  app.get("/preview", { schema: { hide: true } }, previewHandler);

  app.post(
    "/v1/contracts/import",
    {
      bodyLimit: options.config.contractBodyLimitBytes,
      schema: schema("Import and validate a contract", ["contracts"], {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["source"],
          properties: {
            source: { type: "string" },
            mediaType: {
              type: "string",
              enum: ["application/json", "application/yaml"],
            },
            sourceUri: { type: "string", maxLength: 2048 },
          },
        },
        response: { 201: OPENAPI_OBJECT, 422: OPENAPI_OBJECT },
      }),
    },
    async (request, reply) => {
      const body = bodyObject(request);
      const source = stringField(body, "source", {
        required: true,
        maxLength: options.config.contractBodyLimitBytes,
      })!;
      const mediaType =
        stringField(body, "mediaType", { maxLength: 32 }) ??
        (source.trimStart().startsWith("{")
          ? "application/json"
          : "application/yaml");
      if (
        mediaType !== "application/json" &&
        mediaType !== "application/yaml"
      ) {
        throw new ReferenceApiError(
          400,
          "INVALID_MEDIA_TYPE",
          "Contract mediaType must be application/json or application/yaml.",
        );
      }
      const record = await service.importContract({
        source,
        sourceMediaType: mediaType,
        correlationId: request.id,
        ...(stringField(body, "sourceUri", { maxLength: 2048 }) === undefined
          ? {}
          : {
              sourceUri: stringField(body, "sourceUri", {
                maxLength: 2048,
              })!,
            }),
      });
      return reply.status(record.status === "valid" ? 201 : 422).send({
        import: {
          id: record.id,
          createdAt: record.createdAt,
          status: record.status,
          sourceChecksum: record.sourceChecksum,
          diagnostics: record.diagnostics,
          canonicalChecksum: record.contract?.checksum.value,
        },
      });
    },
  );

  app.get(
    "/v1/contracts/imports/:id",
    {
      schema: schema("Inspect a contract import", ["contracts"], {
        params: pathParameters("id"),
      }),
    },
    async (request) => {
      const record = await options.repository.getContractImport(
        parameter(request, "id"),
      );
      if (record === undefined) {
        throw new ReferenceApiError(
          404,
          "IMPORT_NOT_FOUND",
          "The contract import was not found.",
        );
      }
      return {
        import: {
          id: record.id,
          createdAt: record.createdAt,
          status: record.status,
          sourceChecksum: record.sourceChecksum,
          diagnostics: record.diagnostics,
          contract: record.contract,
        },
      };
    },
  );

  app.post(
    "/v1/releases/publish",
    {
      schema: schema("Publish an atomic contract release", ["releases"], {
        headers: IDEMPOTENCY_HEADERS,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["importId"],
          properties: {
            importId: { type: "string", maxLength: 256 },
            overrideReason: { type: "string", maxLength: 500 },
          },
        },
        response: {
          200: PUBLISH_COMPLETED_RESPONSE,
          201: PUBLISH_COMPLETED_RESPONSE,
          202: PUBLISH_PENDING_RESPONSE,
        },
      }),
    },
    async (request, reply) => {
      const body = bodyObject(request);
      const key = idempotencyKey(request);
      const existing = await options.repository.getPublishCommand(key);
      try {
        const release = await service.publishRelease(
          stringField(body, "importId", {
            required: true,
            maxLength: 256,
          })!,
          request.id,
          stringField(body, "overrideReason", { maxLength: 500 }),
          key,
        );
        return reply.status(existing === undefined ? 201 : 200).send({
          status: "completed",
          idempotencyKey: key,
          release,
        });
      } catch (error) {
        if (
          error instanceof ReferenceApiError &&
          (error.code === "PUBLISH_PENDING" ||
            error.code === "PUBLISH_NOT_COMMITTED" ||
            error.code === "PUBLISH_OUTCOME_UNKNOWN")
        ) {
          let status;
          try {
            status = await service.getPublishStatus(key);
          } catch {
            return reply.status(202).send({
              status: "unknown",
              idempotencyKey: key,
            });
          }
          if (status.status === "completed") {
            return reply.status(existing === undefined ? 201 : 200).send({
              status: "completed",
              idempotencyKey: key,
              command: publicPublishCommand(status.command),
              release: status.release,
            });
          }
          return reply.status(202).send({
            status: status.status === "pending" ? "pending" : "unknown",
            idempotencyKey: key,
            ...(status.status === "pending" || status.status === "inconsistent"
              ? { command: publicPublishCommand(status.command) }
              : {}),
          });
        }
        throw error;
      }
    },
  );

  app.get(
    "/v1/releases/publish/status",
    {
      schema: schema("Inspect publish idempotency status", ["releases"], {
        headers: IDEMPOTENCY_HEADERS,
        response: {
          200: PUBLISH_COMPLETED_RESPONSE,
          202: PUBLISH_PENDING_RESPONSE,
        },
      }),
    },
    async (request, reply) => {
      const key = idempotencyKey(request);
      const status = await service.recoverPublishStatus(key);
      if (status.status === "not_found") {
        throw new ReferenceApiError(
          404,
          "PUBLISH_COMMAND_NOT_FOUND",
          "The publish command was not found.",
        );
      }
      if (status.status === "conflict") {
        throw new ReferenceApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "The publish idempotency key was already used for another request.",
        );
      }
      if (status.status === "completed") {
        return {
          status: "completed",
          idempotencyKey: key,
          command: publicPublishCommand(status.command),
          release: status.release,
        };
      }
      if (status.status === "pending") {
        return reply.status(202).send({
          status: "pending",
          idempotencyKey: key,
          command: publicPublishCommand(status.command),
        });
      }
      return reply.status(202).send({
        status: "unknown",
        idempotencyKey: key,
        ...(status.status === "inconsistent"
          ? {
              command: publicPublishCommand(status.command),
              reason: status.reason,
            }
          : {}),
      });
    },
  );

  app.get(
    "/v1/releases",
    {
      schema: schema("List immutable release metadata", ["releases"], {
        description:
          "Returns bounded release metadata. Use the detail endpoint for canonical and original contract content.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            beforeSequence: { type: "integer", minimum: 1 },
          },
        },
        response: { 200: RELEASE_LIST_RESPONSE },
      }),
    },
    async (request) => {
      const query = queryObject(request);
      const limit = queryLimit(query, 25, 100);
      const beforeSequence = queryPositiveInteger(query, "beforeSequence");
      const page = await options.repository.listReleaseMetadataPage(
        limit,
        beforeSequence,
      );
      return {
        releases: page.items,
        ...(page.nextBeforeSequence === undefined
          ? {}
          : { nextBeforeSequence: page.nextBeforeSequence }),
      };
    },
  );
  app.get(
    "/v1/releases/:id",
    {
      schema: schema("Inspect full immutable release content", ["releases"], {
        description:
          "Returns the bounded-at-import canonical contract and original source for one explicit release.",
        params: pathParameters("id"),
      }),
    },
    async (request) => {
      const release = await options.repository.getRelease(
        parameter(request, "id"),
      );
      if (release === undefined) {
        throw new ReferenceApiError(
          404,
          "RELEASE_NOT_FOUND",
          "The release was not found.",
        );
      }
      return { release };
    },
  );
  app.get(
    "/v1/events",
    { schema: schema("List active event documentation", ["releases"]) },
    async () => {
      const release = await options.repository.getActiveRelease();
      return {
        releaseId: release?.id,
        events: release?.contract.eventTypes ?? [],
        changelog: release?.changelog,
      };
    },
  );

  app.post(
    "/v1/endpoints",
    {
      schema: schema("Create an endpoint", ["endpoints"], {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: { type: "string", maxLength: 4096 },
            description: { type: "string", maxLength: 1000 },
            allowLocalNetwork: { type: "boolean" },
          },
        },
        response: { 201: OPENAPI_OBJECT },
      }),
    },
    async (request, reply) => {
      const body = bodyObject(request);
      const endpoint = await service.createEndpoint({
        url: stringField(body, "url", {
          required: true,
          maxLength: 4096,
        })!,
        allowLocalNetwork: booleanField(body, "allowLocalNetwork"),
        correlationId: request.id,
        ...(stringField(body, "description", { maxLength: 1000 }) === undefined
          ? {}
          : {
              description: stringField(body, "description", {
                maxLength: 1000,
              })!,
            }),
      });
      return reply.status(201).send({ endpoint });
    },
  );
  app.get(
    "/v1/endpoints",
    { schema: schema("List endpoints", ["endpoints"]) },
    async () => ({ endpoints: await options.repository.listEndpoints() }),
  );
  app.get(
    "/v1/endpoints/:id",
    {
      schema: schema("Inspect an endpoint", ["endpoints"], {
        params: pathParameters("id"),
      }),
    },
    async (request) => {
      const endpoint = await options.repository.getEndpoint(
        parameter(request, "id"),
      );
      if (endpoint === undefined) {
        throw new ReferenceApiError(
          404,
          "ENDPOINT_NOT_FOUND",
          "The endpoint was not found.",
        );
      }
      if (endpoint.state === "deleted") {
        const tasks = await options.repository.listPayloadCleanupTasks(
          10_000,
          endpoint.id,
        );
        return {
          endpoint,
          cleanup: {
            state: tasks.length === 0 ? "completed" : "pending",
            tasks: tasks.map(publicCleanupTask),
          },
        };
      }
      return {
        endpoint,
        subscription: await options.repository.getSubscription(endpoint.id),
        secrets: await service.listSecretMetadata(endpoint.id),
      };
    },
  );
  app.patch(
    "/v1/endpoints/:id",
    {
      schema: schema("Update or pause an endpoint", ["endpoints"], {
        params: pathParameters("id"),
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", maxLength: 4096 },
            description: {
              anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }],
            },
            allowLocalNetwork: { type: "boolean" },
            state: { type: "string", enum: ["active", "paused"] },
          },
        },
      }),
    },
    async (request) => {
      const body = bodyObject(request);
      const state = stringField(body, "state", { maxLength: 32 });
      if (state !== undefined && state !== "active" && state !== "paused") {
        throw new ReferenceApiError(
          400,
          "INVALID_ENDPOINT_STATE",
          "Endpoint state must be active or paused.",
        );
      }
      const description =
        body["description"] === null
          ? null
          : stringField(body, "description", { maxLength: 1000 });
      const endpoint = await service.updateEndpoint(parameter(request, "id"), {
        correlationId: request.id,
        ...(stringField(body, "url", { maxLength: 4096 }) === undefined
          ? {}
          : { url: stringField(body, "url", { maxLength: 4096 })! }),
        ...(description === undefined ? {} : { description }),
        ...(body["allowLocalNetwork"] === undefined
          ? {}
          : {
              allowLocalNetwork: booleanField(body, "allowLocalNetwork"),
            }),
        ...(state === undefined ? {} : { state }),
      });
      return { endpoint };
    },
  );
  app.delete(
    "/v1/endpoints/:id",
    {
      schema: schema("Delete an endpoint idempotently", ["endpoints"], {
        params: pathParameters("id"),
        response: { 200: OPENAPI_OBJECT, 202: OPENAPI_OBJECT },
      }),
    },
    async (request, reply) =>
      deleteEndpointAndReport(service, options.repository, request, reply),
  );

  app.get(
    "/v1/endpoints/:id/cleanup",
    {
      schema: schema("Inspect endpoint cleanup state", ["endpoints"], {
        params: pathParameters("id"),
      }),
    },
    async (request) => {
      const endpointId = parameter(request, "id");
      const endpoint = await options.repository.getEndpoint(endpointId);
      if (endpoint === undefined) {
        throw new ReferenceApiError(
          404,
          "ENDPOINT_NOT_FOUND",
          "The endpoint was not found.",
        );
      }
      if (endpoint.state !== "deleted") {
        throw new ReferenceApiError(
          409,
          "ENDPOINT_NOT_DELETED",
          "Cleanup state is available only for deleted endpoints.",
        );
      }
      const tasks = await options.repository.listPayloadCleanupTasks(
        10_000,
        endpointId,
      );
      return {
        endpoint,
        cleanup: {
          state: tasks.length === 0 ? "completed" : "pending",
          tasks: tasks.map(publicCleanupTask),
        },
      };
    },
  );
  app.post(
    "/v1/endpoints/:id/cleanup/retry",
    {
      schema: schema("Retry endpoint payload cleanup", ["endpoints"], {
        description:
          "Retries failed or pending payload cleanup for an existing deleted endpoint tombstone. Active and paused endpoints are never deleted by this route.",
        params: pathParameters("id"),
        response: {
          200: OPENAPI_OBJECT,
          202: OPENAPI_OBJECT,
          409: OPENAPI_CLEANUP_RETRY_CONFLICT,
        },
      }),
    },
    async (request, reply) =>
      retryEndpointCleanupAndReport(
        service,
        options.repository,
        request,
        reply,
      ),
  );

  app.put(
    "/v1/endpoints/:id/subscriptions",
    {
      schema: schema("Replace endpoint subscriptions", ["subscriptions"], {
        params: pathParameters("id"),
        body: {
          type: "object",
          additionalProperties: false,
          required: ["eventTypes"],
          properties: {
            eventTypes: {
              type: "array",
              maxItems: 1000,
              items: { type: "string", maxLength: 256 },
            },
          },
        },
      }),
    },
    async (request) => {
      const subscription = await service.setSubscriptions(
        parameter(request, "id"),
        stringArrayField(bodyObject(request), "eventTypes"),
        request.id,
      );
      return { subscription };
    },
  );
  app.get(
    "/v1/endpoints/:id/subscriptions",
    {
      schema: schema("Inspect endpoint subscriptions", ["subscriptions"], {
        params: pathParameters("id"),
      }),
    },
    async (request) => ({
      subscription: await options.repository.getSubscription(
        parameter(request, "id"),
      ),
    }),
  );

  app.post(
    "/v1/endpoints/:id/secrets",
    {
      schema: schema("Create a one-time-reveal secret", ["secrets"], {
        params: pathParameters("id"),
        body: {
          type: "object",
          additionalProperties: false,
        },
        response: { 201: OPENAPI_OBJECT },
      }),
    },
    async (request, reply) => {
      const created = await service.createSecret(
        parameter(request, "id"),
        request.id,
      );
      return reply.status(201).send({
        secret: created.metadata,
        oneTimeSecret: created.secret,
      });
    },
  );
  app.get(
    "/v1/endpoints/:id/secrets",
    {
      schema: schema("List secret metadata without values", ["secrets"], {
        params: pathParameters("id"),
      }),
    },
    async (request) => ({
      secrets: await service.listSecretMetadata(parameter(request, "id")),
    }),
  );
  app.post(
    "/v1/endpoints/:id/secrets/rotate",
    {
      schema: schema("Rotate a secret with bounded overlap", ["secrets"], {
        params: pathParameters("id"),
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            overlapSeconds: {
              type: "integer",
              minimum: 3600,
              maximum: 604800,
            },
          },
        },
        response: { 201: OPENAPI_OBJECT },
      }),
    },
    async (request, reply) => {
      const created = await service.rotateSecret(
        parameter(request, "id"),
        integerField(bodyObject(request), "overlapSeconds", 86_400),
        request.id,
      );
      return reply.status(201).send({
        secret: created.metadata,
        oneTimeSecret: created.secret,
      });
    },
  );
  app.post(
    "/v1/endpoints/:endpointId/secrets/:secretId/revoke",
    {
      schema: schema("Revoke a secret", ["secrets"], {
        params: pathParameters("endpointId", "secretId"),
        body: {
          type: "object",
          additionalProperties: false,
        },
      }),
    },
    async (request) => {
      const metadata = await service.revokeSecret(
        parameter(request, "endpointId"),
        parameter(request, "secretId"),
        request.id,
      );
      return { secret: metadata };
    },
  );

  app.post(
    "/v1/endpoints/:id/send-test",
    {
      schema: schema("Send one at-most-once signed test", ["tests"], {
        params: pathParameters("id"),
        headers: IDEMPOTENCY_HEADERS,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["eventType"],
          properties: {
            eventType: { type: "string", maxLength: 256 },
            version: { type: "string", maxLength: 256 },
          },
        },
        response: {
          200: OPENAPI_OBJECT,
          202: OPENAPI_OBJECT,
          409: OPENAPI_OBJECT,
        },
      }),
    },
    async (request, reply) => {
      const body = bodyObject(request);
      const command = await service.sendTest({
        endpointId: parameter(request, "id"),
        eventType: stringField(body, "eventType", {
          required: true,
          maxLength: 256,
        })!,
        ...(stringField(body, "version", { maxLength: 256 }) === undefined
          ? {}
          : {
              eventVersion: stringField(body, "version", { maxLength: 256 })!,
            }),
        idempotencyKey: idempotencyKey(request),
        correlationId: request.id,
      });
      return reply
        .status(command.evidenceState === "complete" ? 200 : 202)
        .send({ command: publicTestCommand(command) });
    },
  );

  app.get(
    "/v1/endpoints/:id/send-test/status",
    {
      schema: schema("Inspect send-test idempotency status", ["tests"], {
        params: pathParameters("id"),
        headers: IDEMPOTENCY_HEADERS,
      }),
    },
    async (request) => {
      const command = await options.repository.getTestCommandByIdempotency(
        parameter(request, "id"),
        idempotencyKey(request),
      );
      if (command === undefined) {
        throw new ReferenceApiError(
          404,
          "TEST_COMMAND_NOT_FOUND",
          "The test command was not found.",
        );
      }
      return { command: publicTestCommand(command) };
    },
  );

  app.post(
    "/v1/ingest",
    {
      schema: schema("Authenticate and ingest metadata", ["metadata"], {
        headers: INGEST_HEADERS,
        security: [{ metadataIngest: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "schemaVersion",
            "batchId",
            "batchFingerprint",
            "adapterId",
            "connectionId",
            "environment",
            "tenantId",
            "credentialId",
            "expiresAt",
            "issuedAt",
            "kind",
            "records",
            "signature",
          ],
          properties: {
            schemaVersion: { type: "string" },
            batchId: { type: "string" },
            batchFingerprint: { type: "string" },
            adapterId: { type: "string" },
            connectionId: { type: "string" },
            environment: { type: "string" },
            tenantId: { type: "string" },
            credentialId: { type: "string" },
            expiresAt: { type: "number" },
            issuedAt: { type: "number" },
            kind: { type: "string", enum: ["metadata_ingest"] },
            records: {
              type: "array",
              minItems: 1,
              maxItems: 1000,
              items: OPENAPI_OBJECT,
            },
            signature: {
              type: "object",
              additionalProperties: false,
              required: ["algorithm", "value"],
              properties: {
                algorithm: { type: "string" },
                value: { type: "string" },
              },
            },
          },
        },
        response: { 202: OPENAPI_OBJECT },
      }),
    },
    async (request, reply) => {
      verifyIngestAuthorization(request);
      const summary = await service.ingestMetadataEnvelope(
        request.body,
        request.id,
      );
      return reply.status(202).send({ summary });
    },
  );
  app.get(
    "/v1/timeline",
    {
      schema: schema("Search the metadata timeline", ["metadata"], {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200 },
            cursor: { type: "string" },
            deliveryId: { type: "string" },
            endpointId: { type: "string" },
            eventId: { type: "string" },
            eventType: { type: "string" },
            status: {
              type: "string",
              enum: [
                "attempting",
                "cancelled",
                "delivered",
                "exhausted",
                "failed",
                "pending",
                "retry_scheduled",
                "unknown",
              ],
            },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
        },
      }),
    },
    async (request) => {
      const query = queryObject(request);
      const status = queryString(query, "status") as
        import("@webhook-portal/adapter-sdk").DeliveryAttemptStatus | undefined;
      const allowedStatuses = new Set([
        "attempting",
        "cancelled",
        "delivered",
        "exhausted",
        "failed",
        "pending",
        "retry_scheduled",
        "unknown",
      ]);
      if (status !== undefined && !allowedStatuses.has(status)) {
        throw new ReferenceApiError(
          400,
          "INVALID_STATUS",
          "The timeline status filter is invalid.",
        );
      }
      return service.listTimeline(
        {
          limit: queryLimit(query, 50, 200),
          ...(queryString(query, "cursor") === undefined
            ? {}
            : { cursor: queryString(query, "cursor")! }),
          ...(queryString(query, "deliveryId") === undefined
            ? {}
            : { deliveryId: queryString(query, "deliveryId")! }),
          ...(queryString(query, "endpointId") === undefined
            ? {}
            : { endpointId: queryString(query, "endpointId")! }),
          ...(queryString(query, "eventId") === undefined
            ? {}
            : { eventId: queryString(query, "eventId")! }),
          ...(queryString(query, "eventType") === undefined
            ? {}
            : { eventType: queryString(query, "eventType")! }),
          ...(status === undefined ? {} : { status }),
          ...(queryString(query, "from") === undefined
            ? {}
            : { from: queryString(query, "from")! }),
          ...(queryString(query, "to") === undefined
            ? {}
            : { to: queryString(query, "to")! }),
        },
        request.id,
      );
    },
  );
  app.get(
    "/v1/audit",
    {
      schema: schema("List append-only audit events", ["audit"], {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
        },
      }),
    },
    async (request) => ({
      audit: await service.listAudit(
        queryLimit(queryObject(request), 100, 500),
        request.id,
      ),
    }),
  );

  app.post(
    "/v1/test-receiver/:endpointId",
    {
      bodyLimit: options.config.sendTestBodyLimitBytes,
      schema: schema("Verify a local signed test receiver", ["tests"], {
        params: pathParameters("endpointId"),
        headers: {
          type: "object",
          additionalProperties: true,
          required: [
            "content-type",
            "webhook-id",
            "webhook-timestamp",
            "webhook-signature",
          ],
          properties: {
            "content-type": {
              type: "string",
              pattern: "^application/webhook\\+json(?:;.*)?$",
            },
            "webhook-id": { type: "string" },
            "webhook-timestamp": { type: "string" },
            "webhook-signature": { type: "string" },
          },
        },
        security: [{ webhookSignature: [] }],
        consumes: ["application/webhook+json"],
        body: {},
        response: { 204: { type: "null" } },
      }),
    },
    async (request, reply) => {
      const rawBody = request.rawBody;
      if (rawBody === undefined) {
        throw new ReferenceApiError(
          400,
          "RAW_BODY_UNAVAILABLE",
          "The signed raw request body is required.",
        );
      }
      const verification = await service.verifyEndpointWebhook(
        parameter(request, "endpointId"),
        rawBody,
        request.headers,
      );
      if (!verification.ok) {
        throw new ReferenceApiError(
          401,
          "INVALID_WEBHOOK_SIGNATURE",
          "The webhook signature is invalid.",
        );
      }
      return reply.status(204).send();
    },
  );

  app.addHook("onClose", async () => {
    await payloadMaintenance?.stop();
    await payloadStorage.close();
    await options.repository.close();
  });
  await payloadMaintenance?.runNow().catch(() => undefined);

  return {
    app,
    service,
    ...(payloadMaintenance === undefined ? {} : { payloadMaintenance }),
  };
}
