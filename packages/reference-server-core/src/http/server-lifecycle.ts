// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";

import { safeTokenEqual } from "../crypto.js";
import { ReferenceApiError } from "../service.js";
import type { RouteContext } from "../route-context.js";
import {
  isPublicUnauthenticatedPath,
  securityHeaders,
} from "./server-security.js";

export function registerLifecycle(
  app: FastifyInstance,
  deps: RouteContext,
): void {
  const { options, payloadMaintenance, payloadStorage } = deps;
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

  app.addHook("onClose", async () => {
    await payloadMaintenance?.stop();
    await payloadStorage.close();
    await options.repository.close();
  });
}
