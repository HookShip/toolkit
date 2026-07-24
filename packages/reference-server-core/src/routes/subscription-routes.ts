// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";

import type { RouteContext } from "../route-context.js";
import {
  bodyObject,
  parameter,
  stringArrayField,
} from "../http/request-parsing.js";
import { pathParameters, schema } from "../http/route-schemas.js";

export function registerSubscriptionRoutes(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options, service } = deps;
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
}
