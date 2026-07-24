// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { safeTokenEqual } from "../crypto.js";
import { ReferenceApiError } from "../service.js";
import { bodyObject, isObject } from "./request-parsing.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function idempotencyKey(request: FastifyRequest): string {
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

export function verifyIngestAuthorization(request: FastifyRequest): void {
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

export function securityHeaders(reply: FastifyReply): void {
  void reply
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY")
    .header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
}

export function isPublicUnauthenticatedPath(url: string): boolean {
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

export function registerJsonParser(app: FastifyInstance): void {
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
