// SPDX-License-Identifier: Apache-2.0

import {
  validateHeaderName as validateNodeHeaderName,
  validateHeaderValue as validateNodeHeaderValue,
} from "node:http";

import {
  ADAPTER_OPERATIONS,
  DEFAULT_ADAPTER_MAPPING_VERSION,
  canonicalizeMetadataRecord,
  checkCredentialScope,
  computeAdapterCommandFingerprint,
  createAuthenticatedCommandEnvelope,
  createCapabilityDocument,
  createDeadlineSignal,
  degradedResult,
  failureResult,
  isSideEffectingOperation,
  isDeadlineError,
  isProviderNativeRef,
  hasSameSecretMaterial,
  isWellFormedUnicode,
  okResult,
  reduceDeliveryAttempt,
  revealSecret,
  unknownResult,
  unsupportedResult,
  validateIdempotencyKey,
  validateMetadataDeliveryAttemptInput,
  type Adapter,
  type AdapterCapabilityDeclaration,
  type AdapterCapabilityDocument,
  type AdapterCommand,
  type AdapterCommandResult,
  type AdapterIdentity,
  type AdapterOperation,
  type AdapterResultFor,
  type AuthenticatedCommandEnvelope,
  type CanonicalMetadataRecord,
  type DeliveryAttemptReduction,
  type MappingVersion,
  type ProviderNativeRef,
  type ResourceLocator,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";

import {
  verifyProviderAcknowledgement,
  type AcknowledgementReplayStore,
  type AuthenticatedProviderAcknowledgement,
} from "./acknowledgement.js";
import {
  DestinationResolutionError,
  UnsafeDestinationError,
  validateHttpDestination,
  validateHttpDestinationSyntax,
  type DestinationPolicy,
  type HostResolver,
} from "./destination.js";
import {
  DEFAULT_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS,
  MAX_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS,
  deriveIdempotencyHeaderValue,
  withIdempotencyStoreDeadline,
  type IdempotencyBeginResult,
  type IdempotencyStore,
} from "./idempotency.js";
import {
  HttpTransportInputError,
  nodeHttpTransport,
  type HttpMethod,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from "./transport.js";
import {
  WireEncodingError,
  encodeWireJson,
  parseBoundedJson,
  type WireLimits,
} from "./wire.js";

export interface GenericHttpRoute {
  readonly degradedReason?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly mappingVersion?: MappingVersion;
  readonly method: HttpMethod;
  readonly path: string;
  readonly status?: "degraded" | "supported";
  readonly successStatusCodes?: readonly number[];
}

export interface GenericHttpLimits {
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxMetadataRecords: number;
  readonly maxRequestBodyBytes: number;
  readonly maxRequestHeaderBytes: number;
  readonly maxRequestHeaders: number;
  readonly maxResponseBodyBytes: number;
  readonly maxResponseHeaderBytes: number;
  readonly maxResponseHeaders: number;
  readonly maxUrlLength: number;
}

export const DEFAULT_GENERIC_HTTP_LIMITS = Object.freeze({
  maxJsonDepth: 32,
  maxJsonNodes: 50_000,
  maxMetadataRecords: 1_000,
  maxRequestBodyBytes: 262_144,
  maxRequestHeaderBytes: 32_768,
  maxRequestHeaders: 64,
  maxResponseBodyBytes: 1_048_576,
  maxResponseHeaderBytes: 32_768,
  maxResponseHeaders: 128,
  maxUrlLength: 4_096,
}) satisfies GenericHttpLimits;

export interface GenericHttpAuthConfig {
  readonly headerName?: string;
  readonly prefix?: string;
}

export interface GenericHttpAdapterConfig {
  readonly acknowledgementMaximumLifetimeMilliseconds?: number;
  readonly acknowledgementReplayStore?: AcknowledgementReplayStore;
  readonly adapter: AdapterIdentity;
  readonly auth?: GenericHttpAuthConfig;
  readonly baseUrl: string;
  readonly capabilities?: Partial<
    Record<AdapterOperation, AdapterCapabilityDeclaration>
  >;
  readonly clock?: () => number;
  readonly connectionId: string;
  readonly destination?: DestinationPolicy;
  readonly envelopeMaximumLifetimeMilliseconds?: number;
  readonly generatedAt?: string;
  readonly idempotencyHeaderName?: string;
  readonly idempotencyRetentionMilliseconds?: number;
  readonly idempotencySafetyGraceMilliseconds?: number;
  readonly idempotencyStore?: IdempotencyStore;
  readonly limits?: Partial<GenericHttpLimits>;
  readonly resolver?: HostResolver;
  readonly responseCredential?: ScopedCredential;
  readonly routes: Partial<Record<AdapterOperation, GenericHttpRoute>>;
  readonly transport?: HttpTransport;
}

interface PreparedRequest {
  readonly body?: Uint8Array;
  readonly commandEnvelope: AuthenticatedCommandEnvelope;
  readonly headers: Readonly<Record<string, string>>;
  readonly request: Omit<HttpTransportRequest, "body" | "headers" | "signal">;
  readonly route: GenericHttpRoute;
}

const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const operationSet = new Set<string>(ADAPTER_OPERATIONS);
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

function validateLimits(
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

function validateIdentifier(name: string, value: string): void {
  if (
    value.length === 0 ||
    value.length > 512 ||
    !isWellFormedUnicode(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(`${name} must be a non-empty safe string.`);
  }
}

function validateHeader(name: string, value: string): void {
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

function validateRouteTemplate(path: string): void {
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

function validateRouteParameter(name: string, value: string): void {
  if (containsNormalizedDotSegment(value)) {
    throw new WireEncodingError(
      "route.dot_segment_parameter",
      `The route parameter ${name} normalizes to a dot segment.`,
    );
  }
}

function validateIdempotencyHeaderName(name: string): void {
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

function validateAuthenticationHeaderName(
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

function validateRoute(
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

function declarationStatus(
  declaration: AdapterCapabilityDeclaration,
): "degraded" | "supported" | "unsupported" {
  return typeof declaration === "string" ? declaration : declaration.status;
}

function wireLimits(limits: GenericHttpLimits, response = false): WireLimits {
  return {
    maxBodyBytes: response
      ? limits.maxResponseBodyBytes
      : limits.maxRequestBodyBytes,
    maxDepth: limits.maxJsonDepth,
    maxNodes: limits.maxJsonNodes,
  };
}

function locatorId(locator: ResourceLocator | undefined): string | undefined {
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

function commandProviderReferencesAreValid(
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

function expectedResourceId(command: AdapterCommand): string | undefined {
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

function renderRouteUrl(
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

function headerByteLength(name: string, value: string): number {
  return Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
}

function buildHeaders(
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

function validateMetadataCommand(command: AdapterCommand): void {
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

function responseHeaders(
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

function statusIsSuccessful(status: number, route: GenericHttpRoute): boolean {
  return (
    route.successStatusCodes?.includes(status) ??
    (status >= 200 && status <= 299)
  );
}

function retryableUnknown(operation: AdapterOperation): boolean {
  return operation !== "send_test";
}

function unknownForOperation(
  operation: AdapterOperation,
  reason: string,
): AdapterCommandResult {
  return unknownResult(reason, undefined, {
    retryable: retryableUnknown(operation),
    sideEffects: isSideEffectingOperation(operation) ? "possible" : "none",
  });
}

function failureForStatus(
  status: number,
  operation: AdapterOperation,
  sideEffecting: boolean,
): AdapterCommandResult {
  if (sideEffecting && (status === 408 || status === 504 || status >= 500)) {
    return unknownForOperation(
      operation,
      "The provider returned an ambiguous error after receiving the command.",
    );
  }
  const [code, retryable] =
    status === 401 || status === 403
      ? (["authentication_failed", false] as const)
      : status === 404
        ? (["not_found", false] as const)
        : status === 409
          ? (["conflict", false] as const)
          : status === 422
            ? (["invalid_request", false] as const)
            : status === 429
              ? (["rate_limited", true] as const)
              : status >= 500
                ? (["provider_unavailable", true] as const)
                : (["http_error", false] as const);
  return failureResult({
    code,
    message: `The provider returned HTTP ${status}.`,
    retryable,
  });
}

function canRetryWithoutSideEffects(result: AdapterCommandResult): boolean {
  if (result.sideEffects !== "none") {
    return false;
  }
  if (result.status === "failure") {
    return result.error.retryable;
  }
  if (result.status === "degraded" || result.status === "unknown") {
    return result.retryable;
  }
  return false;
}

function metadataResult(
  parsed: unknown,
  command: Extract<
    AdapterCommand,
    { readonly kind: "metadata.backfill" | "metadata.poll" }
  >,
  adapterId: string,
  maximumRecords: number,
): {
  readonly cursor?: string;
  readonly hasMore: boolean;
  readonly records: readonly CanonicalMetadataRecord[];
  readonly reductions: readonly DeliveryAttemptReduction[];
} {
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    if (parsed === undefined) {
      return { records: [], reductions: [], hasMore: false };
    }
    throw new WireEncodingError(
      "metadata.invalid_response",
      "The metadata response must be a closed object.",
    );
  }
  const object = parsed as Readonly<Record<string, unknown>>;
  const allowed = new Set(["cursor", "hasMore", "records"]);
  if (!Object.keys(object).every((key) => allowed.has(key))) {
    throw new WireEncodingError(
      "metadata.unrestricted_response",
      "The metadata response contains a non-allowlisted field.",
    );
  }
  if (
    !Array.isArray(object["records"]) ||
    object["records"].length > maximumRecords ||
    (object["cursor"] !== undefined && typeof object["cursor"] !== "string") ||
    (object["hasMore"] !== undefined && typeof object["hasMore"] !== "boolean")
  ) {
    throw new WireEncodingError(
      "metadata.invalid_response",
      "The metadata response fields are invalid.",
    );
  }
  const identity = {
    tenantId: command.context.tenant.id,
    environment: command.context.environment.id,
    connectionId: command.context.connection.id,
    adapterId,
  };
  const records: CanonicalMetadataRecord[] = [];
  const seen = new Set<string>();
  const reductions = new Map<string, DeliveryAttemptReduction>();
  for (const candidate of object["records"]) {
    const validation = validateMetadataDeliveryAttemptInput(candidate);
    if (!validation.ok) {
      throw new WireEncodingError(
        "metadata.invalid_record",
        validation.issues[0]?.message ?? "The metadata record is invalid.",
      );
    }
    const record = canonicalizeMetadataRecord(validation.value, identity);
    if (seen.has(record.dedupeKey)) {
      continue;
    }
    seen.add(record.dedupeKey);
    records.push(record);
    const key = `${record.tenantId}\u0000${record.environment}\u0000${record.connectionId}\u0000${record.adapterId}\u0000${record.deliveryId}`;
    reductions.set(key, reduceDeliveryAttempt(reductions.get(key), record));
  }
  return {
    records: Object.freeze(records),
    reductions: Object.freeze([...reductions.values()]),
    hasMore: (object["hasMore"] as boolean | undefined) ?? false,
    ...(object["cursor"] === undefined
      ? {}
      : { cursor: object["cursor"] as string }),
  };
}

function providerRef(
  acknowledgement: AuthenticatedProviderAcknowledgement,
  adapterId: string,
): ProviderNativeRef | undefined {
  return acknowledgement.result.kind !== "resource"
    ? undefined
    : Object.freeze({
        provider: adapterId,
        resourceType: acknowledgement.result.resource.type,
        id: acknowledgement.result.resource.id,
      });
}

function acknowledgementValue(
  command: AdapterCommand,
  acknowledgement: AuthenticatedProviderAcknowledgement,
  adapterId: string,
): unknown {
  const nativeRef = providerRef(acknowledgement, adapterId);
  const pending = acknowledgement.disposition === "pending";
  const mappingVersion = acknowledgement.mappingVersion;
  const resource =
    acknowledgement.result.kind === "resource"
      ? acknowledgement.result.resource
      : undefined;
  switch (command.kind) {
    case "endpoint.create":
    case "endpoint.pause":
    case "endpoint.read":
    case "endpoint.resume":
    case "endpoint.update":
      return {
        endpoint: {
          id:
            command.kind === "endpoint.create"
              ? command.input.endpoint.id
              : command.input.endpoint.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
        },
      };
    case "endpoint.delete":
      return {
        deleted: !pending,
        endpoint: {
          id: command.input.endpoint.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
        },
      };
    case "endpoint.verify":
      return {
        verified:
          pending || acknowledgement.result.kind !== "resource"
            ? false
            : (acknowledgement.result.verified ?? false),
        endpoint: {
          id: command.input.endpoint.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
        },
      };
    case "subscription.pause":
    case "subscription.read":
    case "subscription.replace":
    case "subscription.resume":
      return {
        subscription: {
          id:
            command.kind === "subscription.replace"
              ? (command.input.subscription?.id ?? command.input.definition.id)
              : command.input.subscription.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
        },
      };
    case "secret.create":
    case "secret.revoke":
    case "secret.rotate_with_overlap":
      return {
        secret: {
          id:
            command.kind === "secret.create"
              ? resource?.id
              : command.input.secret.id,
          state: resource?.state,
          mappingVersion,
          ...(nativeRef === undefined ? {} : { providerRef: nativeRef }),
          ...(command.kind === "secret.rotate_with_overlap"
            ? { overlapUntil: command.input.overlapUntil }
            : {}),
        },
      };
    case "send_test":
      return {
        accepted:
          acknowledgement.result.kind === "test_dispatch" &&
          acknowledgement.result.accepted,
        state: pending ? "pending" : "accepted",
        ...(acknowledgement.result.kind !== "test_dispatch" ||
        acknowledgement.result.deliveryId === undefined
          ? {}
          : { deliveryId: acknowledgement.result.deliveryId }),
      };
    case "request_replay":
      return {
        accepted:
          acknowledgement.result.kind === "replay" &&
          acknowledgement.result.accepted,
        state: pending ? "pending" : "accepted",
        ...(acknowledgement.result.kind !== "replay" ||
        acknowledgement.result.replayId === undefined
          ? {}
          : { replayId: acknowledgement.result.replayId }),
      };
    case "metadata.poll":
    case "metadata.backfill":
      throw new Error(
        "Metadata operations do not use control acknowledgements.",
      );
  }
}

async function awaitTransport(
  transport: HttpTransport,
  request: HttpTransportRequest,
): Promise<HttpTransportResponse> {
  const operation = transport(request);
  return new Promise<HttpTransportResponse>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        request.signal.removeEventListener("abort", abort);
        callback();
      }
    };
    const abort = (): void => {
      finish(() =>
        reject(
          request.signal.reason instanceof Error
            ? request.signal.reason
            : new DOMException("The operation was aborted.", "AbortError"),
        ),
      );
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return;
    }
    void operation.then(
      (response) => finish(() => resolve(response)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error("HTTP transport failed."),
          ),
        ),
    );
  });
}

function isLocalTransportInputError(error: unknown): boolean {
  if (error instanceof HttpTransportInputError) {
    return true;
  }
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return (
    code === "ERR_INVALID_CHAR" ||
    code === "ERR_HTTP_INVALID_HEADER_VALUE" ||
    code === "ERR_INVALID_HTTP_TOKEN"
  );
}

export class GenericHttpAdapter implements Adapter {
  readonly capabilityDocument: AdapterCapabilityDocument;
  readonly #auth: GenericHttpAuthConfig | undefined;
  readonly #acknowledgementMaximumLifetime: number;
  readonly #acknowledgementReplayStore: AcknowledgementReplayStore | undefined;
  readonly #baseUrl: URL;
  readonly #clock: () => number;
  readonly #connectionId: string;
  readonly #destination: DestinationPolicy;
  readonly #envelopeMaximumLifetime: number;
  readonly #idempotencyHeaderName: string;
  readonly #idempotencyRetention: number;
  readonly #idempotencySafetyGrace: number;
  readonly #idempotencyStore: IdempotencyStore | undefined;
  readonly #limits: GenericHttpLimits;
  readonly #routes: Readonly<
    Partial<Record<AdapterOperation, GenericHttpRoute>>
  >;
  readonly #responseCredential: ScopedCredential | undefined;
  readonly #transport: HttpTransport;

  constructor(config: GenericHttpAdapterConfig) {
    validateIdentifier("connectionId", config.connectionId);
    this.#connectionId = config.connectionId;
    this.#limits = validateLimits(config.limits);
    this.#clock = config.clock ?? Date.now;
    this.#destination = Object.freeze({
      ...config.destination,
      maxUrlLength: this.#limits.maxUrlLength,
      ...(config.resolver === undefined ? {} : { resolver: config.resolver }),
    });
    this.#baseUrl = validateHttpDestinationSyntax(
      config.baseUrl,
      this.#destination,
    );
    this.#transport = config.transport ?? nodeHttpTransport;
    this.#acknowledgementReplayStore = config.acknowledgementReplayStore;
    this.#responseCredential = config.responseCredential;
    this.#auth =
      config.auth === undefined ? undefined : Object.freeze({ ...config.auth });
    this.#idempotencyStore = config.idempotencyStore;
    this.#idempotencyHeaderName =
      config.idempotencyHeaderName ?? "Idempotency-Key";
    validateIdempotencyHeaderName(this.#idempotencyHeaderName);
    if (config.auth?.headerName !== undefined) {
      validateAuthenticationHeaderName(
        config.auth.headerName,
        this.#idempotencyHeaderName,
      );
    }
    this.#idempotencyRetention =
      config.idempotencyRetentionMilliseconds ??
      DEFAULT_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS;
    this.#idempotencySafetyGrace =
      config.idempotencySafetyGraceMilliseconds ?? 30_000;
    this.#envelopeMaximumLifetime =
      config.envelopeMaximumLifetimeMilliseconds ?? 300_000;
    this.#acknowledgementMaximumLifetime =
      config.acknowledgementMaximumLifetimeMilliseconds ?? 300_000;
    if (
      !Number.isSafeInteger(this.#idempotencyRetention) ||
      this.#idempotencyRetention <= 0 ||
      this.#idempotencyRetention >
        MAX_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS ||
      !Number.isSafeInteger(this.#idempotencySafetyGrace) ||
      this.#idempotencySafetyGrace <= 0 ||
      !Number.isSafeInteger(this.#envelopeMaximumLifetime) ||
      this.#envelopeMaximumLifetime <= 0 ||
      !Number.isSafeInteger(this.#acknowledgementMaximumLifetime) ||
      this.#acknowledgementMaximumLifetime <= 0
    ) {
      throw new RangeError("Adapter timing limits must be positive integers.");
    }

    const routes: Partial<Record<AdapterOperation, GenericHttpRoute>> = {};
    const declarations: Partial<
      Record<AdapterOperation, AdapterCapabilityDeclaration>
    > = {};
    for (const operation of Object.keys(config.routes)) {
      if (!operationSet.has(operation)) {
        throw new RangeError(
          `${operation} is not an outbound adapter operation; inbound metadata must use MetadataIngestVerifier.`,
        );
      }
    }
    for (const operation of ADAPTER_OPERATIONS) {
      const route = config.routes[operation];
      const declaration = config.capabilities?.[operation];
      if (route !== undefined) {
        validateRoute(operation, route, this.#limits);
        if (
          Object.keys(route.headers ?? {}).some(
            (name) =>
              name.toLowerCase() === this.#idempotencyHeaderName.toLowerCase(),
          )
        ) {
          throw new RangeError(
            "A route header collides with the idempotency header.",
          );
        }
        routes[operation] = Object.freeze({
          ...route,
          ...(route.headers === undefined
            ? {}
            : { headers: Object.freeze({ ...route.headers }) }),
          ...(route.successStatusCodes === undefined
            ? {}
            : {
                successStatusCodes: Object.freeze([
                  ...route.successStatusCodes,
                ]),
              }),
        });
      }
      if (
        declaration !== undefined &&
        declarationStatus(declaration) !== "unsupported" &&
        route === undefined
      ) {
        throw new RangeError(
          `${operation} cannot be advertised without a route.`,
        );
      }
      declarations[operation] =
        declaration ??
        (route === undefined ? "unsupported" : (route.status ?? "supported"));
    }
    this.#routes = Object.freeze(routes);
    this.capabilityDocument = createCapabilityDocument({
      adapter: config.adapter,
      capabilities: declarations,
      ...(config.generatedAt === undefined
        ? {}
        : { generatedAt: config.generatedAt }),
    });
    const hasSideEffects = this.capabilityDocument.operations.some(
      (capability) =>
        capability.status !== "unsupported" && capability.sideEffecting,
    );
    if (hasSideEffects && this.#idempotencyStore === undefined) {
      throw new RangeError(
        "A durable IdempotencyStore is required for side-effecting operations.",
      );
    }
    const hasControlResponses = this.capabilityDocument.operations.some(
      (capability) =>
        capability.status !== "unsupported" &&
        capability.operation !== "metadata.poll" &&
        capability.operation !== "metadata.backfill",
    );
    if (
      hasControlResponses &&
      (this.#responseCredential === undefined ||
        this.#responseCredential.role !== "response" ||
        this.#acknowledgementReplayStore === undefined)
    ) {
      throw new RangeError(
        "Control operations require a distinct response-role credential and durable acknowledgement replay store.",
      );
    }
  }

  get capabilities(): AdapterCapabilityDocument {
    return this.capabilityDocument;
  }

  async execute<TCommand extends AdapterCommand>(
    command: TCommand,
  ): Promise<AdapterResultFor<TCommand>> {
    if (!operationSet.has(command.kind)) {
      return failureResult({
        code: "operation_not_supported",
        message:
          "The operation is not part of the outbound adapter contract. Use metadata ingest verification for inbound metadata.",
        retryable: false,
      }) as AdapterResultFor<TCommand>;
    }
    if (command.context.connection.id !== this.#connectionId) {
      return failureResult({
        code: "connection_mismatch",
        message: "The command is not bound to this adapter connection.",
        retryable: false,
      }) as AdapterResultFor<TCommand>;
    }
    if (!validateIdempotencyKey(command.context.idempotency.key)) {
      return failureResult({
        code: "invalid_idempotency_key",
        message: "The idempotency key is invalid.",
        retryable: false,
      }) as AdapterResultFor<TCommand>;
    }
    const credential = command.context.credential;
    if (credential === undefined) {
      return failureResult({
        code: "authentication_required",
        message: "An authenticated scoped credential is required.",
        retryable: false,
      }) as AdapterResultFor<TCommand>;
    }
    if (
      !commandProviderReferencesAreValid(
        command,
        this.capabilityDocument.adapter.id,
      )
    ) {
      return failureResult({
        code: "provider_reference_mismatch",
        message:
          "A provider reference does not belong to this adapter or resource type.",
        retryable: false,
      }) as AdapterResultFor<TCommand>;
    }
    const sideEffecting = isSideEffectingOperation(command.kind);
    let localFingerprint: string | undefined;
    let localScopeReason: string | undefined;
    if (sideEffecting) {
      const localScope = checkCredentialScope(credential, {
        adapterId: this.capabilityDocument.adapter.id,
        connectionId: this.#connectionId,
        tenantId: command.context.tenant.id,
        environment: command.context.environment.id,
        purpose: command.kind,
        role: "command",
        host: this.#baseUrl.hostname,
        now: this.#clock(),
      });
      if (!localScope.ok) {
        localScopeReason = localScope.reason ?? "scope_mismatch";
      }
      try {
        localFingerprint = computeAdapterCommandFingerprint(command);
      } catch (error: unknown) {
        return failureResult({
          code: "invalid_command",
          message:
            error instanceof Error
              ? error.message
              : "The command fingerprint could not be computed.",
          retryable: false,
        }) as AdapterResultFor<TCommand>;
      }
      if (
        localScopeReason === undefined &&
        this.#idempotencyStore !== undefined
      ) {
        try {
          const existing = await withIdempotencyStoreDeadline(
            (signal) =>
              (this.#idempotencyStore as IdempotencyStore).lookup({
                connectionId: this.#connectionId,
                idempotencyKey: command.context.idempotency.key,
                commandFingerprint: localFingerprint as string,
                deadlineAt: command.context.deadline.at,
                signal,
              }),
            command.context.deadline.at,
            command.context.signal,
            this.#clock,
          );
          if (existing.status === "replay") {
            return existing.result as AdapterResultFor<TCommand>;
          }
          if (existing.status === "conflict") {
            return failureResult({
              code: "idempotency_conflict",
              message: `The key is already bound to ${existing.operation}.`,
              retryable: false,
            }) as AdapterResultFor<TCommand>;
          }
          if (existing.status === "in_progress") {
            return unknownForOperation(
              command.kind,
              "An identical command is already in progress.",
            ) as AdapterResultFor<TCommand>;
          }
        } catch (error: unknown) {
          return failureResult({
            code: isDeadlineError(error)
              ? "deadline_exceeded"
              : "idempotency_store_unavailable",
            message: isDeadlineError(error)
              ? "The command deadline expired during idempotency lookup."
              : "The durable idempotency store is unavailable; replay safety cannot be established.",
            retryable: true,
          }) as AdapterResultFor<TCommand>;
        }
      }
    }

    const capability = this.capabilityDocument.capabilities[command.kind];
    if (capability.status === "unsupported") {
      return unsupportedResult(
        command.kind,
        capability.reason ?? "The operation is not configured.",
      ) as AdapterResultFor<TCommand>;
    }
    if (localScopeReason !== undefined) {
      return failureResult({
        code: `auth.${localScopeReason}`,
        message: "The credential is outside its local command scope.",
        retryable: false,
      }) as AdapterResultFor<TCommand>;
    }
    const route = this.#routes[command.kind];
    if (route === undefined) {
      return failureResult({
        code: "adapter_misconfigured",
        message: "The advertised route is unavailable.",
        retryable: false,
      }) as AdapterResultFor<TCommand>;
    }
    if (
      command.kind !== "metadata.poll" &&
      command.kind !== "metadata.backfill" &&
      (this.#responseCredential?.id === credential.id ||
        (this.#responseCredential !== undefined &&
          hasSameSecretMaterial(
            this.#responseCredential.secret,
            credential.secret,
          )))
    ) {
      return failureResult({
        code: "response_credential_not_distinct",
        message:
          "The provider acknowledgement must use a distinct response-role credential.",
        retryable: false,
      }) as AdapterResultFor<TCommand>;
    }

    const deadline = createDeadlineSignal(
      command.context.deadline,
      command.context.signal,
      this.#clock,
    );
    let leaseToken: string | undefined;
    let leaseExpiresAt: number | undefined;
    let transportStarted = false;
    let prepared: PreparedRequest | undefined;
    try {
      if (deadline.signal.aborted) {
        return failureResult({
          code: deadline.didTimeout() ? "deadline_exceeded" : "cancelled",
          message: "The command expired before dispatch.",
          retryable: true,
        }) as AdapterResultFor<TCommand>;
      }
      validateMetadataCommand(command);
      prepared = await this.#prepare(
        command,
        route,
        credential,
        deadline.signal,
      );
      if (
        localFingerprint !== undefined &&
        prepared.commandEnvelope.commandFingerprint !== localFingerprint
      ) {
        throw new WireEncodingError(
          "command.fingerprint_mismatch",
          "The authenticated command envelope fingerprint changed during preparation.",
        );
      }
      if (deadline.signal.aborted) {
        return failureResult({
          code: deadline.didTimeout() ? "deadline_exceeded" : "cancelled",
          message: "The command expired before dispatch.",
          retryable: true,
        }) as AdapterResultFor<TCommand>;
      }

      if (capability.sideEffecting) {
        const store = this.#idempotencyStore as IdempotencyStore;
        let decision: IdempotencyBeginResult;
        try {
          leaseExpiresAt =
            command.context.deadline.at + this.#idempotencySafetyGrace;
          if (!Number.isSafeInteger(leaseExpiresAt)) {
            throw new RangeError("The idempotency lease expiry is invalid.");
          }
          decision = await withIdempotencyStoreDeadline(
            (signal) =>
              store.begin({
                commandDeadline: command.context.deadline.at,
                connectionId: this.#connectionId,
                idempotencyKey: command.context.idempotency.key,
                commandFingerprint: (prepared as PreparedRequest)
                  .commandEnvelope.commandFingerprint,
                operation: command.kind,
                leaseExpiresAt: leaseExpiresAt as number,
                resultExpiresAt: Math.max(
                  this.#clock() + this.#idempotencyRetention,
                  leaseExpiresAt as number,
                ),
                safetyGraceMilliseconds: this.#idempotencySafetyGrace,
                deadlineAt: command.context.deadline.at,
                signal,
              }),
            command.context.deadline.at,
            deadline.signal,
            this.#clock,
          );
        } catch (error: unknown) {
          return failureResult({
            code: isDeadlineError(error)
              ? "deadline_exceeded"
              : "idempotency_store_unavailable",
            message: isDeadlineError(error)
              ? "The command deadline expired during idempotency reservation."
              : "The durable idempotency store is unavailable; the command was not dispatched.",
            retryable: true,
          }) as AdapterResultFor<TCommand>;
        }
        if (decision.status === "replay") {
          return decision.result as AdapterResultFor<TCommand>;
        }
        if (decision.status === "conflict") {
          return failureResult({
            code: "idempotency_conflict",
            message: `The key is already bound to ${decision.operation}.`,
            retryable: false,
          }) as AdapterResultFor<TCommand>;
        }
        if (decision.status === "capacity") {
          return failureResult({
            code: "idempotency_store_capacity",
            message:
              "The idempotency store refused to evict protected records.",
            retryable: true,
          }) as AdapterResultFor<TCommand>;
        }
        if (decision.status === "in_progress") {
          return unknownForOperation(
            command.kind,
            "An identical command is already in progress.",
          ) as AdapterResultFor<TCommand>;
        }
        leaseToken = decision.leaseToken;
        if (deadline.signal.aborted) {
          const released = await this.#releaseIdempotency(
            command,
            prepared,
            leaseToken,
            leaseExpiresAt as number,
          );
          leaseToken = undefined;
          if (!released) {
            return failureResult({
              code: "idempotency_store_unavailable",
              message:
                "The expired command was not dispatched, but its reservation could not be released.",
              retryable: true,
            }) as AdapterResultFor<TCommand>;
          }
          return failureResult({
            code: "deadline_exceeded",
            message: "The command expired before provider dispatch.",
            retryable: true,
          }) as AdapterResultFor<TCommand>;
        }
      }

      transportStarted = true;
      const response = await awaitTransport(this.#transport, {
        ...prepared.request,
        headers: prepared.headers,
        signal: deadline.signal,
        ...(prepared.body === undefined ? {} : { body: prepared.body }),
      });
      let result: AdapterCommandResult;
      if (deadline.signal.aborted) {
        result = unknownForOperation(
          command.kind,
          "The provider outcome is unknown because the command deadline elapsed.",
        );
      } else {
        result = await this.#interpretResponse(
          command,
          route,
          prepared.commandEnvelope,
          response,
          capability.status,
          capability.sideEffecting,
          deadline.signal,
          command.context.deadline.at,
        );
      }
      if (leaseToken !== undefined) {
        if (canRetryWithoutSideEffects(result)) {
          const released = await this.#releaseIdempotency(
            command,
            prepared,
            leaseToken,
            leaseExpiresAt as number,
          );
          leaseToken = undefined;
          if (!released) {
            result = failureResult({
              code: "idempotency_store_unavailable",
              message:
                "The provider confirmed no side effects, but the durable idempotency reservation could not be released.",
              retryable: true,
            });
          }
        } else {
          result = await this.#completeIdempotency(
            command,
            prepared,
            result,
            leaseToken,
            leaseExpiresAt as number,
          );
        }
      }
      return result as AdapterResultFor<TCommand>;
    } catch (error: unknown) {
      let result: AdapterCommandResult;
      if (transportStarted && isLocalTransportInputError(error)) {
        transportStarted = false;
        result = failureResult({
          code: "headers.invalid_value",
          message:
            "The request headers were rejected locally before provider dispatch.",
          retryable: false,
        });
      } else if (transportStarted && capability.sideEffecting) {
        result = unknownForOperation(
          command.kind,
          deadline.didTimeout()
            ? "The provider outcome is unknown because the command deadline elapsed."
            : "The provider outcome is unknown because transport failed after dispatch.",
        );
      } else if (!transportStarted) {
        result = this.#preflightFailure(
          error,
          deadline.didTimeout(),
          command.context.signal?.aborted === true,
        );
      } else {
        const controlledCode =
          error instanceof WireEncodingError ||
          error instanceof UnsafeDestinationError
            ? error.code
            : undefined;
        result = failureResult({
          code:
            controlledCode ??
            (deadline.didTimeout() ? "deadline_exceeded" : "transport_error"),
          message:
            error instanceof Error
              ? error.message
              : "The provider read failed.",
          retryable: controlledCode === undefined,
        });
      }
      if (leaseToken !== undefined && prepared !== undefined) {
        if (transportStarted) {
          result = await this.#completeIdempotency(
            command,
            prepared,
            result,
            leaseToken,
            leaseExpiresAt as number,
          );
        } else {
          await this.#releaseIdempotency(
            command,
            prepared,
            leaseToken,
            leaseExpiresAt as number,
          );
        }
      }
      return result as AdapterResultFor<TCommand>;
    } finally {
      deadline.dispose();
    }
  }

  #preflightFailure(
    error: unknown,
    deadlineExpired = false,
    parentAborted = false,
  ): AdapterCommandResult {
    if (error instanceof DestinationResolutionError) {
      return failureResult({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    }
    if (deadlineExpired) {
      return failureResult({
        code: "deadline_exceeded",
        message: "The command deadline expired before dispatch.",
        retryable: true,
      });
    }
    if (
      parentAborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return failureResult({
        code: "cancelled",
        message: "The command was cancelled before dispatch.",
        retryable: true,
      });
    }
    const code =
      error instanceof UnsafeDestinationError ||
      error instanceof WireEncodingError
        ? error.code
        : "invalid_command";
    return failureResult({
      code,
      message:
        error instanceof Error
          ? error.message
          : "The command failed preflight validation.",
      retryable: false,
    });
  }

  async #prepare(
    command: AdapterCommand,
    route: GenericHttpRoute,
    credential: ScopedCredential,
    signal: AbortSignal,
  ): Promise<PreparedRequest> {
    const url = renderRouteUrl(this.#baseUrl, route, command);
    if (url.href.length > this.#limits.maxUrlLength) {
      throw new UnsafeDestinationError(
        "destination.url_too_long",
        "The rendered URL exceeds its limit.",
      );
    }
    const scope = checkCredentialScope(credential, {
      adapterId: this.capabilityDocument.adapter.id,
      connectionId: this.#connectionId,
      tenantId: command.context.tenant.id,
      environment: command.context.environment.id,
      purpose: command.kind,
      role: "command",
      host: url.hostname,
      now: this.#clock(),
    });
    if (!scope.ok) {
      throw new WireEncodingError(
        `auth.${scope.reason ?? "scope_mismatch"}`,
        "The credential is outside its authorized scope.",
      );
    }
    const envelope = createAuthenticatedCommandEnvelope(command, credential, {
      issuedAt: this.#clock(),
      maximumLifetimeMilliseconds: this.#envelopeMaximumLifetime,
    });
    const destination = await validateHttpDestination(
      url,
      this.#destination,
      signal,
    );
    const bodyless = route.method === "GET" || route.method === "HEAD";
    const body = bodyless
      ? undefined
      : encodeWireJson(envelope, {
          limits: wireLimits(this.#limits),
        });
    const headers = buildHeaders(
      route,
      credential,
      this.#auth,
      this.#idempotencyHeaderName,
      command.context.idempotency.key,
      envelope,
      bodyless,
      this.#limits,
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
        maxResponseBodyBytes: this.#limits.maxResponseBodyBytes,
        maxResponseHeaderBytes: this.#limits.maxResponseHeaderBytes,
      },
    };
  }

  async #completeIdempotency(
    command: AdapterCommand,
    prepared: PreparedRequest,
    result: AdapterCommandResult,
    leaseToken: string,
    leaseExpiresAt: number,
  ): Promise<AdapterCommandResult> {
    try {
      await withIdempotencyStoreDeadline(
        (signal) =>
          (this.#idempotencyStore as IdempotencyStore).complete({
            connectionId: this.#connectionId,
            idempotencyKey: command.context.idempotency.key,
            commandFingerprint: prepared.commandEnvelope.commandFingerprint,
            leaseToken,
            result,
            deadlineAt: leaseExpiresAt,
            signal,
          }),
        leaseExpiresAt,
        undefined,
        this.#clock,
      );
      return result;
    } catch {
      return unknownForOperation(
        command.kind,
        "The provider responded, but the durable idempotency result could not be persisted.",
      );
    }
  }

  async #releaseIdempotency(
    command: AdapterCommand,
    prepared: PreparedRequest,
    leaseToken: string,
    leaseExpiresAt: number,
  ): Promise<boolean> {
    try {
      await withIdempotencyStoreDeadline(
        (signal) =>
          (this.#idempotencyStore as IdempotencyStore).release({
            connectionId: this.#connectionId,
            idempotencyKey: command.context.idempotency.key,
            commandFingerprint: prepared.commandEnvelope.commandFingerprint,
            leaseToken,
            deadlineAt: leaseExpiresAt,
            signal,
          }),
        leaseExpiresAt,
        undefined,
        this.#clock,
      );
      return true;
    } catch {
      return false;
    }
  }

  async #interpretResponse(
    command: AdapterCommand,
    route: GenericHttpRoute,
    envelope: AuthenticatedCommandEnvelope,
    response: HttpTransportResponse,
    capabilityStatus: "degraded" | "supported",
    sideEffecting: boolean,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<AdapterCommandResult> {
    if (
      !Number.isSafeInteger(response.status) ||
      response.status < 100 ||
      response.status > 599
    ) {
      throw new WireEncodingError(
        "response.invalid_status",
        "The HTTP transport returned an invalid status code.",
      );
    }
    responseHeaders(response, this.#limits);
    if (!statusIsSuccessful(response.status, route)) {
      return failureForStatus(response.status, command.kind, sideEffecting);
    }
    const parsed = parseBoundedJson(
      response.body,
      wireLimits(this.#limits, true),
    );

    if (
      command.kind === "metadata.poll" ||
      command.kind === "metadata.backfill"
    ) {
      if (response.status === 202) {
        return degradedResult("The metadata query is pending.", {
          retryable: true,
          sideEffects: "none",
        }) as AdapterCommandResult;
      }
      const value = metadataResult(
        parsed,
        command,
        this.capabilityDocument.adapter.id,
        this.#limits.maxMetadataRecords,
      );
      return capabilityStatus === "degraded"
        ? (degradedResult(route.degradedReason ?? "The route is degraded.", {
            value,
            retryable: false,
            sideEffects: "none",
          }) as AdapterCommandResult)
        : (okResult(value, { sideEffects: "none" }) as AdapterCommandResult);
    }

    if (response.status === 204 || parsed === undefined) {
      return sideEffecting
        ? unknownForOperation(
            command.kind,
            "The provider returned an empty acknowledgement; no state was confirmed.",
          )
        : failureResult({
            code: "acknowledgement.missing",
            message: "The provider did not return a state acknowledgement.",
            retryable: true,
          });
    }
    const mappingVersion =
      route.mappingVersion ?? DEFAULT_ADAPTER_MAPPING_VERSION;
    const boundResourceId = expectedResourceId(command);
    const validation = await verifyProviderAcknowledgement(
      parsed,
      {
        adapterId: this.capabilityDocument.adapter.id,
        operation: command.kind,
        connectionId: this.#connectionId,
        tenantId: command.context.tenant.id,
        environment: command.context.environment.id,
        requestNonce: envelope.nonce,
        idempotencyKey: command.context.idempotency.key,
        commandFingerprint: envelope.commandFingerprint,
        mappingVersion,
        ...(boundResourceId === undefined
          ? {}
          : { expectedResourceId: boundResourceId }),
      },
      this.#responseCredential as ScopedCredential,
      this.#acknowledgementReplayStore as AcknowledgementReplayStore,
      {
        now: this.#clock(),
        maximumLifetimeMilliseconds: this.#acknowledgementMaximumLifetime,
        signal,
        deadlineAt,
      },
    );
    if (!validation.ok) {
      return sideEffecting
        ? unknownForOperation(command.kind, validation.message)
        : failureResult({
            code: validation.code,
            message: validation.message,
            retryable: false,
          });
    }
    const acknowledgement = validation.acknowledgement;
    if (
      (response.status === 202 && acknowledgement.disposition !== "pending") ||
      (response.status !== 202 &&
        acknowledgement.disposition === "pending" &&
        response.status === 204)
    ) {
      return sideEffecting
        ? unknownForOperation(
            command.kind,
            "The HTTP status contradicts the provider acknowledgement.",
          )
        : failureResult({
            code: "acknowledgement.status_contradiction",
            message:
              "The HTTP status contradicts the provider acknowledgement.",
            retryable: false,
          });
    }
    const value = acknowledgementValue(
      command,
      acknowledgement,
      this.capabilityDocument.adapter.id,
    );
    const acknowledgedProviderRef = providerRef(
      acknowledgement,
      this.capabilityDocument.adapter.id,
    );
    const resultMetadata = {
      mappingVersion,
      ...(acknowledgedProviderRef === undefined
        ? {}
        : { providerRef: acknowledgedProviderRef }),
      acknowledgement: {
        disposition: acknowledgement.disposition,
        commandFingerprint: acknowledgement.commandFingerprint,
      },
    };
    if (acknowledgement.disposition === "pending") {
      return degradedResult(
        "The provider accepted the command asynchronously.",
        {
          value,
          metadata: resultMetadata,
          retryable: false,
          sideEffects: sideEffecting ? "possible" : "none",
        },
      ) as AdapterCommandResult;
    }
    return capabilityStatus === "degraded"
      ? (degradedResult(route.degradedReason ?? "The route is degraded.", {
          value,
          metadata: resultMetadata,
          retryable: false,
          sideEffects: sideEffecting ? "confirmed" : "none",
        }) as AdapterCommandResult)
      : (okResult(value, {
          metadata: resultMetadata,
          sideEffects: sideEffecting ? "confirmed" : "none",
        }) as AdapterCommandResult);
  }
}

export function createGenericHttpAdapter(
  config: GenericHttpAdapterConfig,
): GenericHttpAdapter {
  return new GenericHttpAdapter(config);
}
