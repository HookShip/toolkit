// SPDX-License-Identifier: Apache-2.0

import {
  MIGRATION_INVENTORY_FORMAT,
  MIGRATION_INVENTORY_FORMAT_VERSION,
  MIGRATION_INVENTORY_SCHEMA_ID,
  MIGRATION_INVENTORY_SCHEMA_VERSION,
  type ImportLimits,
  type InventoryDestination,
  type InventoryEndpoint,
  type InventoryImportResult,
  type MigrationInventory,
  type ProviderKind,
} from "./types.js";
import type { ValidationContext } from "./import-validation.js";
import {
  closedKeys,
  compareText,
  diagnostic,
  duplicates,
  inspectStructure,
  mergeLimits,
  parseDestination,
  parseEndpoint,
  providerKinds,
  requireRecord,
  safeString,
  optionalSafeString,
} from "./import-validation.js";
export { DEFAULT_IMPORT_LIMITS } from "./import-validation.js";

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
        "Provider kind must be custom-http, hookdeck, hookship-native, or svix.",
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

export function parseHookshipNativeInventoryExport(
  source: string | Uint8Array,
  limits?: Partial<ImportLimits>,
): InventoryImportResult {
  return parseInventoryExportJson(source, {
    expectedProvider: "hookship-native",
    ...(limits === undefined ? {} : { limits }),
  });
}
