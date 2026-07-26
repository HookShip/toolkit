// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";

import { ReferenceApiError } from "../service.js";
import type { RouteContext } from "../route-context.js";
import {
  bodyObject,
  parameter,
  queryLimit,
  queryObject,
  queryPositiveInteger,
  stringField,
} from "../http/request-parsing.js";
import { publicPublishCommand } from "../http/public-view.js";
import { idempotencyKey } from "../http/server-security.js";
import {
  IDEMPOTENCY_HEADERS,
  OPENAPI_OBJECT,
  PUBLISH_COMPLETED_RESPONSE,
  PUBLISH_PENDING_RESPONSE,
  RELEASE_LIST_RESPONSE,
  pathParameters,
  schema,
} from "../http/route-schemas.js";

export function registerReleaseRoutes(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  registerImportContractRoute(app, deps);
  registerInspectImportRoute(app, deps);
  registerPublishReleaseRoute(app, deps);
  registerPublishStatusRoute(app, deps);
  registerListReleasesRoute(app, deps);
  registerInspectReleaseRoute(app, deps);
  registerEventsRoute(app, deps);
}

function registerImportContractRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options, service } = deps;
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
}

function registerInspectImportRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options } = deps;
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
}

function registerPublishReleaseRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options, service } = deps;
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
}

function registerPublishStatusRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { service } = deps;
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
}

function registerListReleasesRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options } = deps;
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
}

function registerInspectReleaseRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options } = deps;
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
}

function registerEventsRoute(app: FastifyInstance, deps: RouteContext): void {
  const { options } = deps;
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
}
