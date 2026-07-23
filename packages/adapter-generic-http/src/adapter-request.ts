// SPDX-License-Identifier: Apache-2.0

import {
  checkCredentialScope,
  createAuthenticatedCommandEnvelope,
  isProviderNativeRef,
  isWellFormedUnicode,
  revealSecret,
  type AdapterCapabilityDocument,
  type AdapterCommand,
  type AuthenticatedCommandEnvelope,
  type ResourceLocator,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";

import { deriveIdempotencyHeaderValue } from "./idempotency.js";

import {
  type GenericHttpAuthConfig,
  type GenericHttpLimits,
  type GenericHttpRoute,
  type PreparedRequest,
} from "./adapter-types.js";
import {
  UnsafeDestinationError,
  validateHttpDestination,
  type DestinationPolicy,
} from "./destination.js";
import { type HttpTransportResponse } from "./transport.js";
import { WireEncodingError, encodeWireJson } from "./wire.js";
import {
  headerNamePattern,
  validateAuthenticationHeaderName,
  validateHeader,
  validateRouteParameter,
  wireLimits,
} from "./adapter-validation.js";

export function locatorId(
  locator: ResourceLocator | undefined,
): string | undefined {
  return locator?.providerRef?.id ?? locator?.id;
}

function normalizeProviderIdentity(value: string): string | undefined {
  if (!isWellFormedUnicode(value)) {
    return undefined;
  }
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return normalized.length > 0 && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function providerReferenceMatches(
  value: unknown,
  adapterId: string,
  resourceType: "endpoint" | "secret" | "subscription",
): boolean {
  if (!isProviderNativeRef(value)) {
    return false;
  }
  const expectedProvider = normalizeProviderIdentity(adapterId);
  const actualProvider = normalizeProviderIdentity(value.provider);
  return (
    expectedProvider !== undefined &&
    actualProvider === expectedProvider &&
    value.resourceType === resourceType
  );
}

export function commandProviderReferencesAreValid(
  command: AdapterCommand,
  adapterId: string,
): boolean {
  const matches = (
    locator: ResourceLocator | undefined,
    resourceType: "endpoint" | "secret" | "subscription",
  ): boolean =>
    locator?.providerRef === undefined ||
    providerReferenceMatches(locator.providerRef, adapterId, resourceType);

  switch (command.kind) {
    case "endpoint.create": {
      const providerRef = (
        command.input.endpoint as unknown as {
          readonly providerRef?: unknown;
        }
      ).providerRef;
      return (
        providerRef === undefined ||
        providerReferenceMatches(providerRef, adapterId, "endpoint")
      );
    }
    case "endpoint.delete":
    case "endpoint.pause":
    case "endpoint.read":
    case "endpoint.resume":
    case "endpoint.update":
    case "endpoint.verify":
      return matches(command.input.endpoint, "endpoint");
    case "subscription.pause":
    case "subscription.read":
    case "subscription.resume":
      return matches(command.input.subscription, "subscription");
    case "subscription.replace":
      return (
        matches(command.input.subscription, "subscription") &&
        matches(command.input.definition.endpoint, "endpoint")
      );
    case "secret.create":
      return matches(command.input.endpoint, "endpoint");
    case "secret.revoke":
    case "secret.rotate_with_overlap":
      return matches(command.input.secret, "secret");
    case "send_test":
      return matches(command.input.endpoint, "endpoint");
    case "request_replay":
      return matches(command.input.endpoint, "endpoint");
    case "metadata.poll":
    case "metadata.backfill":
      return true;
  }
}

export function expectedResourceId(
  command: AdapterCommand,
): string | undefined {
  switch (command.kind) {
    case "endpoint.create":
      return command.input.endpoint.id;
    case "endpoint.delete":
    case "endpoint.pause":
    case "endpoint.read":
    case "endpoint.resume":
    case "endpoint.update":
    case "endpoint.verify":
      return locatorId(command.input.endpoint);
    case "subscription.pause":
    case "subscription.read":
    case "subscription.resume":
      return locatorId(command.input.subscription);
    case "subscription.replace":
      return (
        locatorId(command.input.subscription) ?? command.input.definition.id
      );
    case "secret.create":
      return undefined;
    case "secret.revoke":
    case "secret.rotate_with_overlap":
      return locatorId(command.input.secret);
    default:
      return undefined;
  }
}

function routeParameters(
  command: AdapterCommand,
): Readonly<Record<string, string>> {
  const shared = {
    tenantId: command.context.tenant.id,
    environmentId: command.context.environment.id,
    connectionId: command.context.connection.id,
  };
  switch (command.kind) {
    case "endpoint.create":
      return {
        ...shared,
        endpointId: command.input.endpoint.id ?? "",
      };
    case "endpoint.delete":
    case "endpoint.pause":
    case "endpoint.read":
    case "endpoint.resume":
    case "endpoint.update":
    case "endpoint.verify":
      return {
        ...shared,
        endpointId: locatorId(command.input.endpoint) ?? "",
      };
    case "subscription.pause":
    case "subscription.read":
    case "subscription.resume":
      return {
        ...shared,
        subscriptionId: locatorId(command.input.subscription) ?? "",
      };
    case "subscription.replace":
      return {
        ...shared,
        subscriptionId:
          locatorId(command.input.subscription) ??
          command.input.definition.id ??
          "",
        endpointId: locatorId(command.input.definition.endpoint) ?? "",
      };
    case "secret.create":
      return {
        ...shared,
        endpointId: locatorId(command.input.endpoint) ?? "",
      };
    case "secret.revoke":
    case "secret.rotate_with_overlap":
      return {
        ...shared,
        secretId: locatorId(command.input.secret) ?? "",
      };
    case "send_test":
      return {
        ...shared,
        endpointId: locatorId(command.input.endpoint) ?? "",
      };
    case "request_replay":
      return { ...shared, deliveryId: command.input.deliveryId };
    case "metadata.poll":
      return {
        ...shared,
        cursor: command.input.cursor ?? "",
        limit:
          command.input.limit === undefined ? "" : String(command.input.limit),
      };
    case "metadata.backfill":
      return {
        ...shared,
        cursor: command.input.cursor ?? "",
        from: command.input.from,
        to: command.input.to,
        limit:
          command.input.limit === undefined ? "" : String(command.input.limit),
      };
  }
}

export function renderRouteUrl(
  baseUrl: URL,
  route: GenericHttpRoute,
  command: AdapterCommand,
): URL {
  const parameters = routeParameters(command);
  const sentinels = new Map<string, string>();
  let parameterIndex = 0;
  const shapePath = route.path.replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/gu,
    (_match, name: string) => {
      const sentinel = `__webhook_portal_parameter_${parameterIndex++}__`;
      const value = parameters[name];
      if (value === undefined || value.length === 0) {
        throw new WireEncodingError(
          "route.missing_parameter",
          `The route parameter ${name} is unavailable.`,
        );
      }
      validateRouteParameter(name, value);
      sentinels.set(sentinel, encodeURIComponent(value));
      return sentinel;
    },
  );
  const path = route.path.replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/gu,
    (_match, name: string) => {
      const value = parameters[name];
      if (value === undefined || value.length === 0) {
        throw new WireEncodingError(
          "route.missing_parameter",
          `The route parameter ${name} is unavailable.`,
        );
      }
      validateRouteParameter(name, value);
      return encodeURIComponent(value);
    },
  );
  if (/[{}]/u.test(path)) {
    throw new WireEncodingError(
      "route.invalid_parameter",
      "The route contains an invalid parameter expression.",
    );
  }
  const url = new URL(path, baseUrl);
  const shapeUrl = new URL(shapePath, baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new UnsafeDestinationError(
      "destination.origin_changed",
      "A route must not change the configured origin.",
    );
  }
  const actualSegments = url.pathname.split("/");
  const shapeSegments = shapeUrl.pathname.split("/");
  if (
    actualSegments.length !== shapeSegments.length ||
    shapeSegments.some((segment, index) => {
      const expected = sentinels.get(segment) ?? segment;
      return actualSegments[index] !== expected;
    })
  ) {
    throw new WireEncodingError(
      "route.normalized_path_mismatch",
      "The normalized route path no longer matches its template structure.",
    );
  }
  if (command.kind === "metadata.poll") {
    if (command.input.cursor !== undefined && !url.searchParams.has("cursor")) {
      url.searchParams.set("cursor", command.input.cursor);
    }
    if (command.input.limit !== undefined && !url.searchParams.has("limit")) {
      url.searchParams.set("limit", String(command.input.limit));
    }
  } else if (command.kind === "metadata.backfill") {
    for (const [name, value] of [
      ["from", command.input.from],
      ["to", command.input.to],
      ["cursor", command.input.cursor],
      [
        "limit",
        command.input.limit === undefined
          ? undefined
          : String(command.input.limit),
      ],
    ] as const) {
      if (value !== undefined && !url.searchParams.has(name)) {
        url.searchParams.set(name, value);
      }
    }
  }
  return url;
}

interface GenericHttpPrepareContext {
  readonly auth: GenericHttpAuthConfig | undefined;
  readonly baseUrl: URL;
  readonly capabilityDocument: AdapterCapabilityDocument;
  readonly clock: () => number;
  readonly connectionId: string;
  readonly destination: DestinationPolicy;
  readonly envelopeMaximumLifetime: number;
  readonly idempotencyHeaderName: string;
  readonly limits: GenericHttpLimits;
}

function authenticationHeader(
  credential: ScopedCredential,
  config: GenericHttpAuthConfig | undefined,
  idempotencyHeaderName: string,
): readonly [string, string] {
  const name =
    config?.headerName ??
    credential.headerName ??
    (credential.kind === "header" ? "X-API-Key" : "Authorization");
  const prefix =
    config?.prefix ??
    credential.prefix ??
    (credential.kind === "bearer"
      ? "Bearer "
      : credential.kind === "basic"
        ? "Basic "
        : "");
  const value = `${prefix}${revealSecret(credential.secret)}`;
  validateAuthenticationHeaderName(name, idempotencyHeaderName);
  validateHeader(name, value);
  return [name, value] as const;
}

export function headerByteLength(name: string, value: string): number {
  return Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
}

export function buildHeaders(
  route: GenericHttpRoute,
  credential: ScopedCredential,
  auth: GenericHttpAuthConfig | undefined,
  idempotencyHeaderName: string,
  idempotencyKey: string,
  envelope: AuthenticatedCommandEnvelope,
  bodyless: boolean,
  limits: GenericHttpLimits,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(route.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  headers["accept"] ??= "application/json";
  const normalizedIdempotencyHeader = idempotencyHeaderName.toLowerCase();
  if (headers[normalizedIdempotencyHeader] !== undefined) {
    throw new WireEncodingError(
      "headers.reserved_collision",
      "A static header collides with the idempotency header.",
    );
  }
  headers[normalizedIdempotencyHeader] =
    deriveIdempotencyHeaderValue(idempotencyKey);
  const [authName, authValue] = authenticationHeader(
    credential,
    auth,
    idempotencyHeaderName,
  );
  const normalizedAuthName = authName.toLowerCase();
  if (headers[normalizedAuthName] !== undefined) {
    throw new WireEncodingError(
      "headers.reserved_collision",
      "A static header collides with the authentication header.",
    );
  }
  headers[normalizedAuthName] = authValue;
  if (bodyless) {
    const encoded = Buffer.from(JSON.stringify(envelope), "utf8").toString(
      "base64url",
    );
    headers["x-webhook-command-envelope"] = encoded;
  } else {
    headers["content-type"] = "application/json";
  }
  const entries = Object.entries(headers);
  for (const [name, value] of entries) {
    validateHeader(name, value);
  }
  const bytes = entries.reduce(
    (total, [name, value]) => total + headerByteLength(name, value),
    0,
  );
  if (
    entries.length > limits.maxRequestHeaders ||
    bytes > limits.maxRequestHeaderBytes
  ) {
    throw new WireEncodingError(
      "headers.limit_exceeded",
      "The request headers exceed their configured limits.",
    );
  }
  return Object.freeze(headers);
}

export function validateMetadataCommand(command: AdapterCommand): void {
  if (command.kind === "metadata.poll") {
    if (
      command.input.cursor !== undefined &&
      (command.input.cursor.length === 0 || command.input.cursor.length > 2_048)
    ) {
      throw new WireEncodingError(
        "metadata.invalid_cursor",
        "The metadata cursor is invalid.",
      );
    }
    if (
      command.input.limit !== undefined &&
      (!Number.isSafeInteger(command.input.limit) || command.input.limit <= 0)
    ) {
      throw new WireEncodingError(
        "metadata.invalid_limit",
        "The metadata limit is invalid.",
      );
    }
  } else if (command.kind === "metadata.backfill") {
    const from = Date.parse(command.input.from);
    const to = Date.parse(command.input.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      throw new WireEncodingError(
        "metadata.invalid_range",
        "The metadata backfill range is invalid.",
      );
    }
  }
}

export async function prepareGenericHttpRequest(
  context: GenericHttpPrepareContext,
  command: AdapterCommand,
  route: GenericHttpRoute,
  credential: ScopedCredential,
  signal: AbortSignal,
): Promise<PreparedRequest> {
  const url = renderRouteUrl(context.baseUrl, route, command);
  if (url.href.length > context.limits.maxUrlLength) {
    throw new UnsafeDestinationError(
      "destination.url_too_long",
      "The rendered URL exceeds its limit.",
    );
  }
  const scope = checkCredentialScope(credential, {
    adapterId: context.capabilityDocument.adapter.id,
    connectionId: context.connectionId,
    tenantId: command.context.tenant.id,
    environment: command.context.environment.id,
    purpose: command.kind,
    role: "command",
    host: url.hostname,
    now: context.clock(),
  });
  if (!scope.ok) {
    throw new WireEncodingError(
      `auth.${scope.reason ?? "scope_mismatch"}`,
      "The credential is outside its authorized scope.",
    );
  }
  const envelope = createAuthenticatedCommandEnvelope(command, credential, {
    issuedAt: context.clock(),
    maximumLifetimeMilliseconds: context.envelopeMaximumLifetime,
  });
  const destination = await validateHttpDestination(
    url,
    context.destination,
    signal,
  );
  const bodyless = route.method === "GET" || route.method === "HEAD";
  const body = bodyless
    ? undefined
    : encodeWireJson(envelope, {
        limits: wireLimits(context.limits),
      });
  const headers = buildHeaders(
    route,
    credential,
    context.auth,
    context.idempotencyHeaderName,
    command.context.idempotency.key,
    envelope,
    bodyless,
    context.limits,
  );
  return {
    route,
    commandEnvelope: envelope,
    headers,
    ...(body === undefined ? {} : { body }),
    request: {
      url: destination.url,
      method: route.method,
      resolvedAddresses: destination.addresses,
      maxResponseBodyBytes: context.limits.maxResponseBodyBytes,
      maxResponseHeaderBytes: context.limits.maxResponseHeaderBytes,
    },
  };
}

export function responseHeaders(
  response: HttpTransportResponse,
  limits: GenericHttpLimits,
): Readonly<Record<string, readonly string[] | string>> {
  const headers = response.headers ?? {};
  let count = 0;
  let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (!headerNamePattern.test(name)) {
      throw new WireEncodingError(
        "headers.invalid_response",
        "The provider returned an invalid header name.",
      );
    }
    const values = typeof value === "string" ? [value] : value;
    count += values.length;
    for (const item of values) {
      if (!isWellFormedUnicode(item) || /[\r\n\u0000]/u.test(item)) {
        throw new WireEncodingError(
          "headers.invalid_response",
          "The provider returned an invalid header value.",
        );
      }
      bytes += headerByteLength(name, item);
    }
  }
  if (
    count > limits.maxResponseHeaders ||
    bytes > limits.maxResponseHeaderBytes
  ) {
    throw new WireEncodingError(
      "headers.response_limit_exceeded",
      "The response headers exceed their configured limits.",
    );
  }
  return headers;
}
