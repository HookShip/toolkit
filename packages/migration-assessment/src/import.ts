// SPDX-License-Identifier: Apache-2.0

import {
  MIGRATION_INVENTORY_FORMAT,
  MIGRATION_INVENTORY_FORMAT_VERSION,
  MIGRATION_INVENTORY_SCHEMA_ID,
  MIGRATION_INVENTORY_SCHEMA_VERSION,
  type AssessmentDiagnostic,
  type EndpointState,
  type EventSubscription,
  type ImportLimits,
  type InventoryDestination,
  type InventoryEndpoint,
  type InventoryImportResult,
  type InventorySigningProfile,
  type MigrationInventory,
  type ObservabilityFeatures,
  type ProviderKind,
  type RateCapability,
  type RetentionFeatures,
  type RetryCapability,
} from "./types.js";

export const DEFAULT_IMPORT_LIMITS: ImportLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 24,
  maxDestinations: 1_000,
  maxEndpoints: 1_000,
  maxObjectProperties: 64,
  maxSubscriptions: 10_000,
  maxTotalValues: 50_000,
});

const credentialKeys = new Set([
  "apikey",
  "authorization",
  "authheader",
  "body",
  "credential",
  "credentials",
  "headers",
  "password",
  "payload",
  "privatekey",
  "secret",
  "signingsecret",
  "token",
  "webhooksecret",
]);
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const endpointStates = new Set<EndpointState>([
  "active",
  "disabled",
  "paused",
  "unknown",
]);
const providerKinds = new Set<ProviderKind>([
  "custom-http",
  "hookdeck",
  "svix",
]);
const backoffs = new Set([
  "exponential",
  "fixed",
  "provider-managed",
  "unknown",
]);

interface ValidationContext {
  readonly diagnostics: AssessmentDiagnostic[];
  readonly limits: ImportLimits;
}

function diagnostic(
  context: ValidationContext,
  code: string,
  message: string,
  pointer?: string,
): void {
  context.diagnostics.push({
    code,
    message,
    severity: "error",
    ...(pointer === undefined ? {} : { pointer }),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function normalizedKey(value: string): string {
  return value.replaceAll(/[-_.\s]/gu, "").toLowerCase();
}

function isCredentialKey(value: string): boolean {
  const normalized = normalizedKey(value);
  return (
    credentialKeys.has(normalized) ||
    /(apikey|authorization|credential|password|privatekey|secret|token)/u.test(
      normalized,
    )
  );
}

function looksLikeCredentialValue(value: string): boolean {
  return (
    /^(?:basic|bearer)\s+\S+/iu.test(value) ||
    /^-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /^(?:ghp_|sk_live_|sk_test_|whsec_|xox[baprs]-)/u.test(value) ||
    /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/u.test(value)
  );
}

function inspectStructure(
  value: unknown,
  context: ValidationContext,
  pointer = "",
  depth = 0,
  counter = { value: 0 },
): void {
  counter.value += 1;
  if (counter.value > context.limits.maxTotalValues) {
    if (
      !context.diagnostics.some(
        (item) => item.code === "IMPORT_VALUE_LIMIT_EXCEEDED",
      )
    ) {
      diagnostic(
        context,
        "IMPORT_VALUE_LIMIT_EXCEEDED",
        `Export exceeds ${context.limits.maxTotalValues} JSON values.`,
        pointer,
      );
    }
    return;
  }
  if (depth > context.limits.maxDepth) {
    diagnostic(
      context,
      "IMPORT_DEPTH_LIMIT_EXCEEDED",
      `Export exceeds maximum depth ${context.limits.maxDepth}.`,
      pointer,
    );
    return;
  }
  if (typeof value === "string" && looksLikeCredentialValue(value)) {
    diagnostic(
      context,
      "CREDENTIAL_VALUE_REJECTED",
      "A value resembling credential material is forbidden.",
      pointer,
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      inspectStructure(
        item,
        context,
        `${pointer}/${index}`,
        depth + 1,
        counter,
      );
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > context.limits.maxObjectProperties) {
    diagnostic(
      context,
      "IMPORT_PROPERTY_LIMIT_EXCEEDED",
      `Object exceeds ${context.limits.maxObjectProperties} properties.`,
      pointer,
    );
  }
  for (const [key, item] of entries) {
    const childPointer = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (unsafeKeys.has(key)) {
      diagnostic(
        context,
        "UNSAFE_OBJECT_KEY",
        `Unsafe object key "${key}" is not accepted.`,
        childPointer,
      );
    }
    if (isCredentialKey(key)) {
      diagnostic(
        context,
        "CREDENTIAL_FIELD_REJECTED",
        `Credential-, payload-, or authentication-shaped field "${key}" is forbidden.`,
        childPointer,
      );
    }
    inspectStructure(item, context, childPointer, depth + 1, counter);
  }
}

function requireRecord(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    diagnostic(context, "INVALID_TYPE", "Expected an object.", pointer);
    return undefined;
  }
  return value;
}

function closedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: ValidationContext,
  pointer: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      diagnostic(
        context,
        "UNKNOWN_FIELD",
        `Unknown field "${key}" is not accepted by the closed inventory schema.`,
        `${pointer}/${key}`,
      );
    }
  }
}

function safeString(
  value: unknown,
  context: ValidationContext,
  pointer: string,
  maxLength = 512,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    diagnostic(
      context,
      "INVALID_STRING",
      `Expected a non-empty safe string no longer than ${maxLength} characters.`,
      pointer,
    );
    return undefined;
  }
  return value;
}

function optionalSafeString(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): string | undefined {
  return value === undefined ? undefined : safeString(value, context, pointer);
}

function booleanValue(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): boolean {
  if (typeof value !== "boolean") {
    diagnostic(context, "INVALID_TYPE", "Expected a boolean.", pointer);
    return false;
  }
  return value;
}

function nonNegativeNumber(
  value: unknown,
  context: ValidationContext,
  pointer: string,
  integer = false,
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isInteger(value))
  ) {
    diagnostic(
      context,
      "INVALID_NUMBER",
      `Expected a finite non-negative ${integer ? "integer" : "number"}.`,
      pointer,
    );
    return undefined;
  }
  return value;
}

function stringArray(
  value: unknown,
  context: ValidationContext,
  pointer: string,
  maxItems: number,
): string[] {
  if (!Array.isArray(value)) {
    diagnostic(context, "INVALID_TYPE", "Expected an array.", pointer);
    return [];
  }
  if (value.length > maxItems) {
    diagnostic(
      context,
      "IMPORT_ITEM_LIMIT_EXCEEDED",
      `Array exceeds ${maxItems} items.`,
      pointer,
    );
  }
  const result: string[] = [];
  for (const [index, item] of value.slice(0, maxItems).entries()) {
    const parsed = safeString(item, context, `${pointer}/${index}`);
    if (parsed !== undefined) {
      result.push(parsed);
    }
  }
  if (new Set(result).size !== result.length) {
    diagnostic(
      context,
      "DUPLICATE_VALUE",
      "Array values must be unique.",
      pointer,
    );
  }
  return result;
}

function parseObservability(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): ObservabilityFeatures {
  const record = requireRecord(value, context, pointer) ?? {};
  closedKeys(
    record,
    ["attemptLogs", "auditLogs", "deliveryLogs", "metrics", "replay"],
    context,
    pointer,
  );
  return {
    attemptLogs: booleanValue(
      record["attemptLogs"],
      context,
      `${pointer}/attemptLogs`,
    ),
    auditLogs: booleanValue(
      record["auditLogs"],
      context,
      `${pointer}/auditLogs`,
    ),
    deliveryLogs: booleanValue(
      record["deliveryLogs"],
      context,
      `${pointer}/deliveryLogs`,
    ),
    metrics: booleanValue(record["metrics"], context, `${pointer}/metrics`),
    replay: booleanValue(record["replay"], context, `${pointer}/replay`),
  };
}

function parseRetry(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): RetryCapability {
  const record = requireRecord(value, context, pointer) ?? {};
  closedKeys(
    record,
    ["backoff", "maxAttempts", "maxDurationSeconds", "supported"],
    context,
    pointer,
  );
  const backoff = record["backoff"];
  if (backoff !== undefined && !backoffs.has(backoff as string)) {
    diagnostic(
      context,
      "INVALID_ENUM",
      "Unknown retry backoff.",
      `${pointer}/backoff`,
    );
  }
  const parsedBackoff =
    typeof backoff === "string" && backoffs.has(backoff)
      ? (backoff as NonNullable<RetryCapability["backoff"]>)
      : undefined;
  const maxAttempts =
    record["maxAttempts"] === undefined
      ? undefined
      : nonNegativeNumber(
          record["maxAttempts"],
          context,
          `${pointer}/maxAttempts`,
          true,
        );
  const maxDurationSeconds =
    record["maxDurationSeconds"] === undefined
      ? undefined
      : nonNegativeNumber(
          record["maxDurationSeconds"],
          context,
          `${pointer}/maxDurationSeconds`,
        );
  return {
    supported: booleanValue(
      record["supported"],
      context,
      `${pointer}/supported`,
    ),
    ...(parsedBackoff === undefined ? {} : { backoff: parsedBackoff }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
  };
}

function parseRate(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): RateCapability {
  const record = requireRecord(value, context, pointer) ?? {};
  closedKeys(
    record,
    ["burst", "requestsPerSecond", "supported"],
    context,
    pointer,
  );
  const burst =
    record["burst"] === undefined
      ? undefined
      : nonNegativeNumber(record["burst"], context, `${pointer}/burst`);
  const requestsPerSecond =
    record["requestsPerSecond"] === undefined
      ? undefined
      : nonNegativeNumber(
          record["requestsPerSecond"],
          context,
          `${pointer}/requestsPerSecond`,
        );
  return {
    supported: booleanValue(
      record["supported"],
      context,
      `${pointer}/supported`,
    ),
    ...(burst === undefined ? {} : { burst }),
    ...(requestsPerSecond === undefined ? {} : { requestsPerSecond }),
  };
}

function parseRetention(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): RetentionFeatures {
  const record = requireRecord(value, context, pointer) ?? {};
  closedKeys(
    record,
    ["attemptLogDays", "deliveryLogDays", "payloadRetentionDays"],
    context,
    pointer,
  );
  const result: {
    attemptLogDays?: number;
    deliveryLogDays?: number;
    payloadRetentionDays?: number;
  } = {};
  for (const key of [
    "attemptLogDays",
    "deliveryLogDays",
    "payloadRetentionDays",
  ] as const) {
    if (record[key] !== undefined) {
      const parsed = nonNegativeNumber(
        record[key],
        context,
        `${pointer}/${key}`,
      );
      if (parsed !== undefined) {
        result[key] = parsed;
      }
    }
  }
  return result;
}

function parseSigning(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): InventorySigningProfile | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, context, pointer);
  if (record === undefined) {
    return undefined;
  }
  closedKeys(
    record,
    ["algorithms", "headerNames", "profile", "rotationSupported"],
    context,
    pointer,
  );
  const profile = safeString(record["profile"], context, `${pointer}/profile`);
  if (profile === undefined) {
    return undefined;
  }
  return {
    algorithms: stringArray(
      record["algorithms"],
      context,
      `${pointer}/algorithms`,
      16,
    ),
    headerNames: stringArray(
      record["headerNames"],
      context,
      `${pointer}/headerNames`,
      32,
    ),
    profile,
    rotationSupported: booleanValue(
      record["rotationSupported"],
      context,
      `${pointer}/rotationSupported`,
    ),
  };
}

function parseSubscriptions(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): EventSubscription[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    diagnostic(context, "INVALID_TYPE", "Expected an array.", pointer);
    return [];
  }
  const endpointLimit = Math.min(500, context.limits.maxSubscriptions);
  if (value.length > endpointLimit) {
    diagnostic(
      context,
      "IMPORT_SUBSCRIPTION_LIMIT_EXCEEDED",
      `Endpoint exceeds ${endpointLimit} subscriptions.`,
      pointer,
    );
  }
  const subscriptions: EventSubscription[] = [];
  for (const [index, item] of value.slice(0, endpointLimit).entries()) {
    const itemPointer = `${pointer}/${index}`;
    const record = requireRecord(item, context, itemPointer);
    if (record === undefined) {
      continue;
    }
    closedKeys(record, ["event", "providerId"], context, itemPointer);
    const event = safeString(record["event"], context, `${itemPointer}/event`);
    const providerId = optionalSafeString(
      record["providerId"],
      context,
      `${itemPointer}/providerId`,
    );
    if (event !== undefined) {
      subscriptions.push({
        event,
        ...(providerId === undefined ? {} : { providerId }),
      });
    }
  }
  const identities = subscriptions.map(
    (item) => `${item.event}\u0000${item.providerId ?? ""}`,
  );
  if (new Set(identities).size !== identities.length) {
    diagnostic(
      context,
      "DUPLICATE_SUBSCRIPTION",
      "Duplicate event subscriptions are not accepted.",
      pointer,
    );
  }
  return subscriptions;
}

function parseDestination(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): InventoryDestination | undefined {
  const record = requireRecord(value, context, pointer);
  if (record === undefined) {
    return undefined;
  }
  closedKeys(record, ["id", "kind", "providerId", "url"], context, pointer);
  const id = safeString(record["id"], context, `${pointer}/id`);
  const providerId = optionalSafeString(
    record["providerId"],
    context,
    `${pointer}/providerId`,
  );
  const rawUrl = safeString(record["url"], context, `${pointer}/url`, 2048);
  if (record["kind"] !== "http") {
    diagnostic(
      context,
      "INVALID_ENUM",
      'Destination kind must be "http".',
      `${pointer}/kind`,
    );
  }
  let url: URL | undefined;
  if (rawUrl !== undefined) {
    try {
      url = new URL(rawUrl);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        diagnostic(
          context,
          "UNSAFE_DESTINATION_URL",
          "Destination URL must use HTTP(S) and contain no userinfo, query, or fragment.",
          `${pointer}/url`,
        );
      }
    } catch {
      diagnostic(
        context,
        "INVALID_DESTINATION_URL",
        "Destination URL must be an absolute HTTP(S) URL.",
        `${pointer}/url`,
      );
    }
  }
  if (id === undefined || rawUrl === undefined || url === undefined) {
    return undefined;
  }
  return {
    id,
    kind: "http",
    url: rawUrl,
    ...(providerId === undefined ? {} : { providerId }),
  };
}

function parseEndpoint(
  value: unknown,
  context: ValidationContext,
  pointer: string,
): InventoryEndpoint | undefined {
  const record = requireRecord(value, context, pointer);
  if (record === undefined) {
    return undefined;
  }
  closedKeys(
    record,
    [
      "destinationIds",
      "id",
      "name",
      "observability",
      "providerId",
      "rate",
      "retention",
      "retry",
      "signing",
      "state",
      "subscriptions",
    ],
    context,
    pointer,
  );
  const id = safeString(record["id"], context, `${pointer}/id`);
  const providerId = safeString(
    record["providerId"],
    context,
    `${pointer}/providerId`,
  );
  const name = optionalSafeString(record["name"], context, `${pointer}/name`);
  const state = record["state"];
  if (!endpointStates.has(state as EndpointState)) {
    diagnostic(
      context,
      "INVALID_ENUM",
      "Unknown endpoint state.",
      `${pointer}/state`,
    );
  }
  if (
    id === undefined ||
    providerId === undefined ||
    !endpointStates.has(state as EndpointState)
  ) {
    return undefined;
  }
  const signing = parseSigning(
    record["signing"],
    context,
    `${pointer}/signing`,
  );
  const subscriptions = parseSubscriptions(
    record["subscriptions"],
    context,
    `${pointer}/subscriptions`,
  );
  return {
    destinationIds: stringArray(
      record["destinationIds"],
      context,
      `${pointer}/destinationIds`,
      100,
    ),
    id,
    observability: parseObservability(
      record["observability"],
      context,
      `${pointer}/observability`,
    ),
    providerId,
    rate: parseRate(record["rate"], context, `${pointer}/rate`),
    retention: parseRetention(
      record["retention"],
      context,
      `${pointer}/retention`,
    ),
    retry: parseRetry(record["retry"], context, `${pointer}/retry`),
    state: state as EndpointState,
    ...(name === undefined ? {} : { name }),
    ...(signing === undefined ? {} : { signing }),
    ...(subscriptions === undefined ? {} : { subscriptions }),
  };
}

function duplicates(
  values: readonly string[],
  code: string,
  label: string,
  context: ValidationContext,
  pointer: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      diagnostic(context, code, `Duplicate ${label} "${value}".`, pointer);
    }
    seen.add(value);
  }
}

function mergeLimits(overrides?: Partial<ImportLimits>): ImportLimits {
  return Object.freeze({ ...DEFAULT_IMPORT_LIMITS, ...overrides });
}

export function parseInventoryExportJson(
  source: string | Uint8Array,
  options: {
    readonly expectedProvider?: ProviderKind;
    readonly limits?: Partial<ImportLimits>;
  } = {},
): InventoryImportResult {
  const limits = mergeLimits(options.limits);
  const byteLength =
    typeof source === "string"
      ? Buffer.byteLength(source, "utf8")
      : source.byteLength;
  if (byteLength > limits.maxBytes) {
    return {
      diagnostics: [
        {
          code: "IMPORT_BYTE_LIMIT_EXCEEDED",
          message: `Export is ${byteLength} bytes; maximum is ${limits.maxBytes}.`,
          severity: "fatal",
        },
      ],
      ok: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof source === "string"
        ? source
        : new TextDecoder("utf-8", { fatal: true }).decode(source),
    ) as unknown;
  } catch {
    return {
      diagnostics: [
        {
          code: "INVALID_JSON",
          message: "Inventory export must be valid UTF-8 JSON.",
          severity: "fatal",
        },
      ],
      ok: false,
    };
  }

  const context: ValidationContext = { diagnostics: [], limits };
  inspectStructure(parsed, context);
  const root = requireRecord(parsed, context, "");
  if (root === undefined) {
    return { diagnostics: context.diagnostics, ok: false };
  }
  closedKeys(
    root,
    [
      "$schema",
      "destinations",
      "endpoints",
      "format",
      "formatVersion",
      "provider",
      "schemaVersion",
    ],
    context,
    "",
  );
  for (const [key, expected] of [
    ["$schema", MIGRATION_INVENTORY_SCHEMA_ID],
    ["format", MIGRATION_INVENTORY_FORMAT],
    ["formatVersion", MIGRATION_INVENTORY_FORMAT_VERSION],
    ["schemaVersion", MIGRATION_INVENTORY_SCHEMA_VERSION],
  ] as const) {
    if (root[key] !== expected) {
      diagnostic(
        context,
        "INVALID_FORMAT",
        `${key} must equal "${expected}".`,
        `/${key}`,
      );
    }
  }

  const providerRecord = requireRecord(root["provider"], context, "/provider");
  let provider: MigrationInventory["provider"] | undefined;
  if (providerRecord !== undefined) {
    closedKeys(
      providerRecord,
      ["accountId", "connectionId", "kind", "name"],
      context,
      "/provider",
    );
    const accountId = safeString(
      providerRecord["accountId"],
      context,
      "/provider/accountId",
    );
    const connectionId = optionalSafeString(
      providerRecord["connectionId"],
      context,
      "/provider/connectionId",
    );
    const name = optionalSafeString(
      providerRecord["name"],
      context,
      "/provider/name",
    );
    const kind = providerRecord["kind"];
    if (!providerKinds.has(kind as ProviderKind)) {
      diagnostic(
        context,
        "INVALID_PROVIDER",
        "Provider kind must be custom-http, hookdeck, or svix.",
        "/provider/kind",
      );
    } else if (
      options.expectedProvider !== undefined &&
      kind !== options.expectedProvider
    ) {
      diagnostic(
        context,
        "PROVIDER_MISMATCH",
        `Expected ${options.expectedProvider} export, received ${String(kind)}.`,
        "/provider/kind",
      );
    }
    if (accountId !== undefined && providerKinds.has(kind as ProviderKind)) {
      provider = {
        accountId,
        kind: kind as ProviderKind,
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(name === undefined ? {} : { name }),
      };
    }
  }

  const destinationValues = root["destinations"];
  const endpointValues = root["endpoints"];
  if (!Array.isArray(destinationValues)) {
    diagnostic(
      context,
      "INVALID_TYPE",
      "destinations must be an array.",
      "/destinations",
    );
  } else if (destinationValues.length > limits.maxDestinations) {
    diagnostic(
      context,
      "IMPORT_DESTINATION_LIMIT_EXCEEDED",
      `Inventory exceeds ${limits.maxDestinations} destinations.`,
      "/destinations",
    );
  }
  if (!Array.isArray(endpointValues)) {
    diagnostic(
      context,
      "INVALID_TYPE",
      "endpoints must be an array.",
      "/endpoints",
    );
  } else if (endpointValues.length > limits.maxEndpoints) {
    diagnostic(
      context,
      "IMPORT_ENDPOINT_LIMIT_EXCEEDED",
      `Inventory exceeds ${limits.maxEndpoints} endpoints.`,
      "/endpoints",
    );
  }

  const destinations = Array.isArray(destinationValues)
    ? destinationValues
        .slice(0, limits.maxDestinations)
        .map((value, index) =>
          parseDestination(value, context, `/destinations/${index}`),
        )
        .filter((value): value is InventoryDestination => value !== undefined)
    : [];
  const endpoints = Array.isArray(endpointValues)
    ? endpointValues
        .slice(0, limits.maxEndpoints)
        .map((value, index) =>
          parseEndpoint(value, context, `/endpoints/${index}`),
        )
        .filter((value): value is InventoryEndpoint => value !== undefined)
    : [];

  duplicates(
    destinations.map((item) => item.id),
    "DUPLICATE_DESTINATION_ID",
    "destination id",
    context,
    "/destinations",
  );
  duplicates(
    destinations
      .map((item) => item.providerId)
      .filter((value): value is string => value !== undefined),
    "DUPLICATE_DESTINATION_PROVIDER_ID",
    "destination provider id",
    context,
    "/destinations",
  );
  duplicates(
    endpoints.map((item) => item.id),
    "DUPLICATE_ENDPOINT_ID",
    "endpoint id",
    context,
    "/endpoints",
  );
  const subscriptionCount = endpoints.reduce(
    (total, endpoint) => total + (endpoint.subscriptions?.length ?? 0),
    0,
  );
  if (subscriptionCount > limits.maxSubscriptions) {
    diagnostic(
      context,
      "IMPORT_SUBSCRIPTION_LIMIT_EXCEEDED",
      `Inventory exceeds ${limits.maxSubscriptions} total subscriptions.`,
      "/endpoints",
    );
  }
  duplicates(
    endpoints.map((item) => item.providerId),
    "DUPLICATE_ENDPOINT_PROVIDER_ID",
    "endpoint provider id",
    context,
    "/endpoints",
  );
  const destinationIds = new Set(destinations.map((item) => item.id));
  for (const endpoint of endpoints) {
    for (const destinationId of endpoint.destinationIds) {
      if (!destinationIds.has(destinationId)) {
        diagnostic(
          context,
          "UNKNOWN_DESTINATION_REFERENCE",
          `Endpoint "${endpoint.id}" references unknown destination "${destinationId}".`,
          "/endpoints",
        );
      }
    }
  }

  if (
    provider === undefined ||
    context.diagnostics.some(
      (item) => item.severity === "error" || item.severity === "fatal",
    )
  ) {
    return {
      diagnostics: Object.freeze(
        [...context.diagnostics].sort((left, right) =>
          compareText(
            `${left.pointer ?? ""}\u0000${left.code}`,
            `${right.pointer ?? ""}\u0000${right.code}`,
          ),
        ),
      ),
      ok: false,
    };
  }
  return {
    diagnostics: Object.freeze([]),
    inventory: {
      $schema: MIGRATION_INVENTORY_SCHEMA_ID,
      destinations,
      endpoints,
      format: MIGRATION_INVENTORY_FORMAT,
      formatVersion: MIGRATION_INVENTORY_FORMAT_VERSION,
      provider,
      schemaVersion: MIGRATION_INVENTORY_SCHEMA_VERSION,
    },
    ok: true,
  };
}

export function parseCustomHttpInventoryExport(
  source: string | Uint8Array,
  limits?: Partial<ImportLimits>,
): InventoryImportResult {
  return parseInventoryExportJson(source, {
    expectedProvider: "custom-http",
    ...(limits === undefined ? {} : { limits }),
  });
}

export function parseSvixInventoryExport(
  source: string | Uint8Array,
  limits?: Partial<ImportLimits>,
): InventoryImportResult {
  return parseInventoryExportJson(source, {
    expectedProvider: "svix",
    ...(limits === undefined ? {} : { limits }),
  });
}

export function parseHookdeckInventoryExport(
  source: string | Uint8Array,
  limits?: Partial<ImportLimits>,
): InventoryImportResult {
  return parseInventoryExportJson(source, {
    expectedProvider: "hookdeck",
    ...(limits === undefined ? {} : { limits }),
  });
}
