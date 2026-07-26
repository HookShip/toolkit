// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ReferenceApiError, type ReferenceService } from "../service.js";
import type { RouteContext } from "../route-context.js";
import type { ReferenceRepository } from "../types.js";
import {
  bodyObject,
  booleanField,
  parameter,
  stringField,
} from "../http/request-parsing.js";
import { publicCleanupTask } from "../http/public-view.js";
import {
  OPENAPI_CLEANUP_RETRY_CONFLICT,
  OPENAPI_OBJECT,
  pathParameters,
  schema,
} from "../http/route-schemas.js";

export function registerEndpointRoutes(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  registerCreateEndpointRoute(app, deps);
  registerListEndpointRoute(app, deps);
  registerGetEndpointRoute(app, deps);
  registerUpdateEndpointRoute(app, deps);
  registerDeleteEndpointRoute(app, deps);
  registerEndpointCleanupRoutes(app, deps);
}

function registerCreateEndpointRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { service } = deps;
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
}

function registerListEndpointRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options } = deps;
  app.get(
    "/v1/endpoints",
    { schema: schema("List endpoints", ["endpoints"]) },
    async () => ({ endpoints: await options.repository.listEndpoints() }),
  );
}

function registerGetEndpointRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options, service } = deps;
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
}

function registerUpdateEndpointRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { service } = deps;
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
}

function registerDeleteEndpointRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options, service } = deps;
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
}

function registerEndpointCleanupRoutes(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options, service } = deps;
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
