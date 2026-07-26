// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";

import { type DeliveryAttemptStatus } from "@webhook-portal/adapter-sdk";

import { ReferenceApiError } from "../service.js";
import type { RouteContext } from "../route-context.js";
import {
  queryLimit,
  queryObject,
  queryString,
} from "../http/request-parsing.js";
import { verifyIngestAuthorization } from "../http/server-security.js";
import {
  INGEST_HEADERS,
  OPENAPI_OBJECT,
  schema,
} from "../http/route-schemas.js";

export function registerMetadataRoutes(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  registerMetadataIngestRoute(app, deps);
  registerTimelineRoute(app, deps);
  registerAuditRoute(app, deps);
}

function registerMetadataIngestRoute(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { service } = deps;
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
}

function registerTimelineRoute(app: FastifyInstance, deps: RouteContext): void {
  const { service } = deps;
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
        DeliveryAttemptStatus | undefined;
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
}

function registerAuditRoute(app: FastifyInstance, deps: RouteContext): void {
  const { service } = deps;
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
}
