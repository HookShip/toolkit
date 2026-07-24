// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";

import { ReferenceApiError } from "../service.js";
import type { RouteContext } from "../route-context.js";
import { bodyObject, parameter, stringField } from "../http/request-parsing.js";
import { publicTestCommand } from "../http/public-view.js";
import { idempotencyKey } from "../http/server-security.js";
import {
  IDEMPOTENCY_HEADERS,
  OPENAPI_OBJECT,
  pathParameters,
  schema,
} from "../http/route-schemas.js";

export function registerTestCommandRoutes(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options, service } = deps;
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
}

export function registerTestReceiverRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options, service } = deps;
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
}
