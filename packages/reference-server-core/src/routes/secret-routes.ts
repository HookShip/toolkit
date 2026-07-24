// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";

import type { RouteContext } from "../route-context.js";
import {
  bodyObject,
  integerField,
  parameter,
} from "../http/request-parsing.js";
import {
  OPENAPI_OBJECT,
  pathParameters,
  schema,
} from "../http/route-schemas.js";

export function registerSecretRoutes(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { service } = deps;
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
}
