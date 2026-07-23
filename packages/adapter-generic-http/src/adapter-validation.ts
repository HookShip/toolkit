// SPDX-License-Identifier: Apache-2.0

import {
  validateHeaderName as validateNodeHeaderName,
  validateHeaderValue as validateNodeHeaderValue,
} from "node:http";

import {
  ADAPTER_OPERATIONS,
  isWellFormedUnicode,
  type AdapterCapabilityDeclaration,
  type AdapterOperation,
} from "@webhook-portal/adapter-sdk";

import {
  type GenericHttpLimits,
  type GenericHttpRoute,
  DEFAULT_GENERIC_HTTP_LIMITS,
} from "./adapter-types.js";
import { WireEncodingError, type WireLimits } from "./wire.js";

export const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
export const operationSet = new Set<string>(ADAPTER_OPERATIONS);
const forbiddenStaticHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "idempotency-key",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-webhook-command-envelope",
]);

export function validateLimits(
  input: Partial<GenericHttpLimits> | undefined,
): GenericHttpLimits {
  const limits = { ...DEFAULT_GENERIC_HTTP_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

export function validateIdentifier(name: string, value: string): void {
  if (
    value.length === 0 ||
    value.length > 512 ||
    !isWellFormedUnicode(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(`${name} must be a non-empty safe string.`);
  }
}

export function validateHeader(name: string, value: string): void {
  if (
    !headerNamePattern.test(name) ||
    !isWellFormedUnicode(name) ||
    !isWellFormedUnicode(value) ||
    value.length > 32_768 ||
    /[\r\n\u0000]/u.test(value)
  ) {
    throw new WireEncodingError(
      "headers.invalid_value",
      "An HTTP header name or value is invalid.",
    );
  }
  try {
    validateNodeHeaderName(name);
    validateNodeHeaderValue(name, value);
  } catch {
    throw new WireEncodingError(
      "headers.invalid_value",
      "An HTTP header contains characters unsupported by Node HTTP.",
    );
  }
}

function isSensitiveStaticHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    forbiddenStaticHeaders.has(normalized) ||
    normalized.includes("api-key") ||
    normalized.includes("apikey") ||
    normalized.includes("auth") ||
    normalized.includes("credential") ||
    normalized.includes("secret") ||
    normalized.includes("token")
  );
}

function containsNormalizedDotSegment(value: string): boolean {
  let candidate = value;
  for (let iteration = 0; iteration <= value.length; iteration += 1) {
    const normalized = candidate.normalize("NFKC").replaceAll("\\", "/");
    if (
      normalized
        .split("/")
        .some((segment) => segment === "." || segment === "..")
    ) {
      return true;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return false;
    }
    if (decoded === candidate) {
      return false;
    }
    candidate = decoded;
  }
  return true;
}

function routePathTemplate(path: string): string {
  const queryIndex = path.indexOf("?");
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}

export function validateRouteTemplate(path: string): void {
  const pathname = routePathTemplate(path);
  const query = path.slice(pathname.length);
  if (query.includes("{") || query.includes("}")) {
    throw new RangeError("Route parameters are only allowed as path segments.");
  }
  for (const segment of pathname.split("/")) {
    if (segment.includes("{") || segment.includes("}")) {
      if (!/^\{[A-Za-z][A-Za-z0-9_]*\}$/u.test(segment)) {
        throw new RangeError(
          "A route parameter must occupy one complete path segment.",
        );
      }
    } else if (segment.length > 0 && containsNormalizedDotSegment(segment)) {
      throw new RangeError("Route literals must not contain dot segments.");
    }
  }
}

export function validateRouteParameter(name: string, value: string): void {
  if (containsNormalizedDotSegment(value)) {
    throw new WireEncodingError(
      "route.dot_segment_parameter",
      `The route parameter ${name} normalizes to a dot segment.`,
    );
  }
}

export function validateIdempotencyHeaderName(name: string): void {
  validateHeader(name, "placeholder");
  const normalized = name.toLowerCase();
  if (
    normalized !== "idempotency-key" &&
    (isSensitiveStaticHeader(normalized) ||
      normalized === "accept" ||
      normalized === "content-type")
  ) {
    throw new RangeError("The idempotency header name is reserved.");
  }
}

export function validateAuthenticationHeaderName(
  name: string,
  idempotencyHeaderName: string,
): void {
  validateHeader(name, "placeholder");
  const normalized = name.toLowerCase();
  if (
    normalized === idempotencyHeaderName.toLowerCase() ||
    [
      "accept",
      "connection",
      "content-length",
      "content-type",
      "cookie",
      "host",
      "proxy-authorization",
      "proxy-connection",
      "set-cookie",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "x-webhook-command-envelope",
    ].includes(normalized)
  ) {
    throw new RangeError("The authentication header name is reserved.");
  }
}

export function validateRoute(
  operation: AdapterOperation,
  route: GenericHttpRoute,
  limits: GenericHttpLimits,
): void {
  if (
    route.path.length === 0 ||
    route.path.length > limits.maxUrlLength ||
    !isWellFormedUnicode(route.path) ||
    route.path.startsWith("//") ||
    route.path.includes("://") ||
    route.path.includes("\\") ||
    route.path.includes("#")
  ) {
    throw new RangeError(`The route for ${operation} has an unsafe path.`);
  }
  validateRouteTemplate(route.path);
  if (route.method === "HEAD") {
    throw new RangeError(
      "HEAD routes are unsupported because authenticated acknowledgements require JSON bodies.",
    );
  }
  if (
    route.method === "GET" &&
    operation !== "endpoint.read" &&
    operation !== "subscription.read" &&
    operation !== "metadata.poll" &&
    operation !== "metadata.backfill"
  ) {
    throw new RangeError(
      `${operation} cannot use a bodyless method because its authenticated envelope must be dispatched exactly once.`,
    );
  }
  for (const [name, value] of Object.entries(route.headers ?? {})) {
    validateHeader(name, value);
    if (isSensitiveStaticHeader(name)) {
      throw new RangeError(
        "Static routes must not contain authentication or reserved headers.",
      );
    }
  }
  for (const status of route.successStatusCodes ?? []) {
    if (!Number.isSafeInteger(status) || status < 200 || status > 299) {
      throw new RangeError("Success status codes must be in the 2xx range.");
    }
  }
}

export function declarationStatus(
  declaration: AdapterCapabilityDeclaration,
): "degraded" | "supported" | "unsupported" {
  return typeof declaration === "string" ? declaration : declaration.status;
}

export function wireLimits(
  limits: GenericHttpLimits,
  response = false,
): WireLimits {
  return {
    maxBodyBytes: response
      ? limits.maxResponseBodyBytes
      : limits.maxRequestBodyBytes,
    maxDepth: limits.maxJsonDepth,
    maxNodes: limits.maxJsonNodes,
  };
}
