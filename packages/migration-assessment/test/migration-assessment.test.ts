// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import {
  ADAPTER_OPERATIONS,
  createCapabilityDocument,
  type AdapterCapabilityDeclaration,
} from "@webhook-portal/adapter-sdk";
import {
  CANONICAL_MODEL_VERSION,
  CANONICAL_SCHEMA_ID,
  type CanonicalContract,
} from "@webhook-portal/canonical-model";
import { describe, expect, it } from "vitest";

import {
  AssessmentInputError,
  assessMigration,
  parseCustomHttpInventoryExport,
  parseHookdeckInventoryExport,
  parseInventoryExportJson,
  parseSvixInventoryExport,
  renderAssessmentJson,
  renderAssessmentMarkdown,
  type MigrationInventory,
  type ProviderKind,
  type TargetPolicy,
} from "../src/index.js";

const checksum = { algorithm: "sha256", value: "a".repeat(64) } as const;

const contract: CanonicalContract = {
  $schema: CANONICAL_SCHEMA_ID,
  checksum,
  eventTypes: [
    {
      externalName: "order.created",
      id: "event-order-created",
      versions: [
        {
          examples: [],
          id: "event-order-created-v1",
          publicVersion: "1",
          schema: {
            checksum,
            dialect: "https://json-schema.org/draft/2020-12/schema",
            value: { type: "object" },
          },
          source: { pointer: "/webhooks/order.created" },
        },
      ],
    },
  ],
  id: "contract-test",
  modelVersion: CANONICAL_MODEL_VERSION,
  source: {
    format: "openapi",
    mediaType: "application/json",
    parser: { name: "test", version: "1" },
    sourceChecksum: checksum,
    specificationVersion: "3.1.0",
  },
};

function fixture(provider: ProviderKind): string {
  return readFileSync(
    new URL(`./fixtures/${provider}.inventory.json`, import.meta.url),
    "utf8",
  );
}

function capabilities(
  overrides: Partial<
    Record<(typeof ADAPTER_OPERATIONS)[number], AdapterCapabilityDeclaration>
  > = {},
) {
  return createCapabilityDocument({
    adapter: {
      id: "target-adapter",
      name: "Target adapter",
      version: "1.0.0",
    },
    capabilities: Object.fromEntries(
      ADAPTER_OPERATIONS.map((operation) => [
        operation,
        overrides[operation] ?? "supported",
      ]),
    ),
  });
}

function parsedInventory(
  provider: ProviderKind = "custom-http",
): MigrationInventory {
  const result = parseInventoryExportJson(fixture(provider), {
    expectedProvider: provider,
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
  if (result.inventory === undefined) {
    throw new Error("Expected fixture inventory.");
  }
  return result.inventory;
}

function assess(
  inventory: MigrationInventory,
  targetPolicy?: TargetPolicy,
  capabilityOverrides: Parameters<typeof capabilities>[0] = {},
) {
  return assessMigration({
    capabilities: capabilities(capabilityOverrides),
    contract,
    inventory,
    ...(targetPolicy === undefined ? {} : { targetPolicy }),
  });
}

describe("provider-neutral inventory imports", () => {
  it.each([
    ["custom-http", parseCustomHttpInventoryExport],
    ["svix", parseSvixInventoryExport],
    ["hookdeck", parseHookdeckInventoryExport],
  ] as const)("parses a closed %s export fixture", (provider, parser) => {
    const result = parser(fixture(provider));

    expect(result.ok).toBe(true);
    expect(result.inventory?.provider.kind).toBe(provider);
    expect(result.inventory?.endpoints).toHaveLength(1);
  });

  it("treats provider identifiers as opaque and only scopes duplicates by resource type", () => {
    const source = JSON.parse(fixture("custom-http")) as Record<
      string,
      unknown
    >;
    const endpoints = source["endpoints"] as Record<string, unknown>[];
    const destinations = source["destinations"] as Record<string, unknown>[];
    endpoints[0]!["providerId"] = "ep_svix_style";
    destinations[0]!["providerId"] = "ep_svix_style";

    const result = parseCustomHttpInventoryExport(JSON.stringify(source));

    expect(result.ok).toBe(true);
    expect(result.inventory?.endpoints[0]?.providerId).toBe("ep_svix_style");
  });

  it("rejects duplicate provider IDs within a resource type", () => {
    const source = JSON.parse(fixture("svix")) as Record<string, unknown>;
    const endpoints = source["endpoints"] as Record<string, unknown>[];
    endpoints.push({
      ...structuredClone(endpoints[0]),
      id: "second-endpoint",
    });

    const result = parseSvixInventoryExport(JSON.stringify(source));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "DUPLICATE_ENDPOINT_PROVIDER_ID",
    );
  });

  it.each(["secret", "apiKey", "authorization", "headers", "payload"])(
    "rejects credential-shaped field %s before import",
    (field) => {
      const source = JSON.parse(fixture("custom-http")) as Record<
        string,
        unknown
      >;
      source[field] = "must-not-be-accepted";

      const result = parseCustomHttpInventoryExport(JSON.stringify(source));

      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain(
        "CREDENTIAL_FIELD_REJECTED",
      );
      expect(JSON.stringify(result)).not.toContain("must-not-be-accepted");
    },
  );

  it("rejects credential-looking values without echoing them", () => {
    const source = JSON.parse(fixture("custom-http")) as Record<
      string,
      unknown
    >;
    const provider = source["provider"] as Record<string, unknown>;
    provider["accountId"] = "whsec_do-not-echo-this-value";

    const result = parseCustomHttpInventoryExport(JSON.stringify(source));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "CREDENTIAL_VALUE_REJECTED",
    );
    expect(JSON.stringify(result)).not.toContain("do-not-echo");
  });

  it("rejects unsafe destination URLs that could carry credentials", () => {
    const source = JSON.parse(fixture("hookdeck")) as Record<string, unknown>;
    const destinations = source["destinations"] as Record<string, unknown>[];
    destinations[0]!["url"] =
      "https://user:password@receiver.example/webhooks?token=value";

    const result = parseHookdeckInventoryExport(JSON.stringify(source));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "UNSAFE_DESTINATION_URL",
    );
    expect(JSON.stringify(result)).not.toContain("password");
    expect(JSON.stringify(result)).not.toContain("token=value");
  });

  it("fails closed on byte, endpoint, and depth limits", () => {
    const source = fixture("custom-http");
    expect(
      parseInventoryExportJson(source, { limits: { maxBytes: 10 } })
        .diagnostics[0]?.code,
    ).toBe("IMPORT_BYTE_LIMIT_EXCEEDED");

    const huge = JSON.parse(source) as Record<string, unknown>;
    const endpoints = huge["endpoints"] as unknown[];
    endpoints.push(structuredClone(endpoints[0]));
    expect(
      parseInventoryExportJson(JSON.stringify(huge), {
        limits: { maxEndpoints: 1 },
      }).diagnostics.map((item) => item.code),
    ).toContain("IMPORT_ENDPOINT_LIMIT_EXCEEDED");

    const deep = JSON.parse(source) as Record<string, unknown>;
    deep["unexpected"] = { level: { level: { level: true } } };
    expect(
      parseInventoryExportJson(JSON.stringify(deep), {
        limits: { maxDepth: 2 },
      }).diagnostics.map((item) => item.code),
    ).toContain("IMPORT_DEPTH_LIMIT_EXCEEDED");
  });
});

describe("migration assessment", () => {
  it("makes missing subscriptions visible as a blocker", () => {
    const inventory = structuredClone(parsedInventory());
    const endpoint = inventory.endpoints[0];
    if (endpoint === undefined) {
      throw new Error("Expected endpoint.");
    }
    delete (endpoint as { subscriptions?: unknown }).subscriptions;

    const result = assess(inventory);

    expect(result.counts.subscriptions).toBe(0);
    expect(result.unmappedOrAmbiguous.map((item) => item.code)).toContain(
      "SUBSCRIPTIONS_UNKNOWN",
    );
    expect(result.readiness.blocked).toBe(true);
  });

  it("reports unsupported target capabilities without implying migration", () => {
    const result = assess(parsedInventory("svix"), undefined, {
      "endpoint.create": "unsupported",
      "subscription.replace": "unsupported",
    });

    expect(result.blockers.map((item) => item.sourceId)).toEqual(
      expect.arrayContaining(["endpoint.create", "subscription.replace"]),
    );
    expect(result.readiness.statement).toContain(
      "never performs or guarantees",
    );
    expect(result.readiness.blocked).toBe(true);
  });

  it("reports target policy and operational parity gaps", () => {
    const result = assess(parsedInventory("hookdeck"), {
      allowedSigningAlgorithms: ["ed25519"],
      endpointLimit: 0,
      minimumRetention: { deliveryLogDays: 1 },
      observability: { deliveryLogs: false },
      requireHttps: true,
      rate: { maxRequestsPerSecond: 1, supported: false },
      retry: { supported: false },
      subscriptionLimitPerEndpoint: 0,
    });

    expect(result.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "SIGNING_ALGORITHM_UNSUPPORTED",
        "TARGET_ENDPOINT_LIMIT_EXCEEDED",
        "TARGET_SUBSCRIPTION_LIMIT_EXCEEDED",
      ]),
    );
    expect(result.retentionObservabilityGaps.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "OBSERVABILITY_PARITY_GAP",
        "RETENTION_PARITY_GAP",
        "RATE_PARITY_GAP",
        "RETRY_PARITY_GAP",
      ]),
    );
  });

  it("normalizes URL schemes when enforcing HTTPS policy", () => {
    const source = parsedInventory("custom-http");
    const inventory = {
      ...source,
      destinations: source.destinations.map((destination, index) =>
        index === 0
          ? {
              ...destination,
              url: destination.url.replace(/^https:/u, "HTTP:"),
            }
          : destination,
      ),
    };

    const result = assess(inventory, { requireHttps: true });

    expect(result.blockers.map((item) => item.code)).toContain(
      "HTTPS_REQUIRED",
    );
    expect(result.readiness.blocked).toBe(true);
  });

  it("reports a shorter target retry-duration window", () => {
    const source = parsedInventory("custom-http");
    const inventory = {
      ...source,
      endpoints: source.endpoints.map((endpoint, index) =>
        index === 0
          ? {
              ...endpoint,
              retry: {
                ...endpoint.retry,
                maxDurationSeconds: 3_600,
                supported: true,
              },
            }
          : endpoint,
      ),
    };

    const result = assess(inventory, {
      retry: {
        maxDurationSeconds: 60,
        supported: true,
      },
    });

    expect(
      result.retentionObservabilityGaps.map((item) => item.code),
    ).toContain("RETRY_DURATION_LIMIT_GAP");
  });

  it("is deterministic across repeated scoring and rendering", () => {
    const inventory = parsedInventory();
    const first = assess(inventory);
    const second = assess(structuredClone(inventory));

    expect(second).toEqual(first);
    expect(renderAssessmentJson(second)).toBe(renderAssessmentJson(first));
    expect(renderAssessmentMarkdown(second)).toBe(
      renderAssessmentMarkdown(first),
    );
    expect(
      first.readiness.components.reduce((sum, item) => sum + item.weight, 0),
    ).toBe(100);
  });

  it("surfaces rollback prerequisites as blockers", () => {
    const result = assess(
      parsedInventory(),
      { requireRollbackExport: true },
      {
        "endpoint.delete": "unsupported",
        "endpoint.pause": "unsupported",
        "secret.rotate_with_overlap": "unsupported",
      },
    );

    expect(
      result.rollbackPrerequisites.filter((item) => item.status === "unmet"),
    ).toHaveLength(3);
    expect(result.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "ROLLBACK_TARGET_CONFIGURATION_EXPORT",
        "ROLLBACK_TARGET_DELIVERY_REVERSIBLE",
        "ROLLBACK_SIGNING_OVERLAP",
      ]),
    );
  });

  it("bounds output and escapes Markdown-controlled inventory identifiers", () => {
    const inventory = structuredClone(parsedInventory());
    const endpoint = inventory.endpoints[0];
    if (endpoint === undefined) {
      throw new Error("Expected endpoint.");
    }
    (endpoint as { id: string }).id = "<script>|*endpoint*";
    const result = assess(inventory);

    expect(renderAssessmentMarkdown(result)).not.toContain("<script>");
    expect(() => renderAssessmentJson(result, { maxBytes: 10 })).toThrow(
      RangeError,
    );
    expect(() => renderAssessmentMarkdown(result, { maxBytes: 10 })).toThrow(
      RangeError,
    );
  });

  it("rejects unvalidated direct inventory objects", () => {
    const inventory = structuredClone(
      parsedInventory(),
    ) as MigrationInventory & {
      token?: string;
    };
    inventory.token = "forbidden";

    expect(() => assess(inventory)).toThrow(AssessmentInputError);
  });
});
