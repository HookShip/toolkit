// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  CANONICAL_METADATA_SCHEMA_VERSION,
  DEFAULT_ADAPTER_MAPPING_VERSION,
  InMemoryCommandEnvelopeReplayStore,
  SecretValue,
  createAdapterContext,
  createAuthenticatedMetadataIngestEnvelope,
  isWellFormedUnicode,
  okResult,
  verifyAuthenticatedCommandEnvelopeWithReplay,
  type AdapterOperation,
  type AdapterCommand,
  type EndpointCreateCommand,
  type MetadataDeliveryAttemptInput,
  type MetadataPollCommand,
  type ScopedCredential,
  type SendTestCommand,
} from "@webhook-portal/adapter-sdk";

import {
  createAuthenticatedProviderAcknowledgement,
  deriveIdempotencyHeaderValue,
  GenericHttpAdapter,
  InMemoryAcknowledgementReplayStore,
  InMemoryIdempotencyStore,
  MAX_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS,
  isPublicIpAddress,
  MetadataIngestVerifier,
  UnsafeDestinationError,
  validateHttpDestination,
  validateHttpDestinationSyntax,
  verifyProviderAcknowledgement,
  withIdempotencyStoreDeadline,
  fingerprintWireValue,
  type GenericHttpAdapterConfig,
  type GenericHttpRoute,
  type HostResolver,
  type HttpTransport,
  type HttpTransportRequest,
  type IdempotencyStore,
  type ProviderAcknowledgement,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const loneHigh = JSON.parse('"\\ud800"') as string;
const loneLow = JSON.parse('"\\udc00"') as string;
const publicResolver: HostResolver = async () => [
  { address: "8.8.8.8", family: 4 },
];

function credential(
  operations: readonly (AdapterOperation | "metadata.ingest")[],
  options: { readonly hosts?: readonly string[] } = {
    hosts: ["api.example.com"],
  },
): ScopedCredential {
  return {
    id: "credential-1",
    kind: "bearer",
    role: operations.includes("metadata.ingest")
      ? "metadata_ingest"
      : "command",
    secret: new SecretValue("credential-secret-2d7"),
    scope: {
      adapterId: "customer-control",
      connectionId: "connection-1",
      tenantId: "tenant-1",
      environments: ["production"],
      operations,
      ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
      expiresAt: NOW + 600_000,
    },
  };
}

function responseCredential(
  overrides: Partial<ScopedCredential["scope"]> = {},
): ScopedCredential {
  return {
    id: "response-credential-1",
    kind: "header",
    role: "response",
    secret: new SecretValue("response-credential-secret-8f4"),
    scope: {
      adapterId: "customer-control",
      connectionId: "connection-1",
      tenantId: "tenant-1",
      environments: ["production"],
      operations: ["acknowledgement.verify"],
      expiresAt: NOW + 600_000,
      ...overrides,
    },
  };
}

function context(
  key: string,
  scopedCredential: ScopedCredential | undefined,
  options: {
    readonly connectionId?: string;
    readonly deadline?: number;
    readonly environment?: string;
    readonly tenantId?: string;
  } = {},
) {
  return createAdapterContext({
    tenant: { id: options.tenantId ?? "tenant-1" },
    environment: { id: options.environment ?? "production" },
    connection: { id: options.connectionId ?? "connection-1" },
    actor: { id: "actor-1", type: "service" },
    idempotency: { key },
    deadline: options.deadline ?? NOW + 30_000,
    ...(scopedCredential === undefined ? {} : { credential: scopedCredential }),
  });
}

function endpointCreate(
  key: string,
  scopedCredential: ScopedCredential | undefined,
  options: { readonly deadline?: number; readonly id?: string } = {},
): EndpointCreateCommand {
  return {
    kind: "endpoint.create",
    context: context(key, scopedCredential, {
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    }),
    input: {
      endpoint: {
        id: options.id ?? "endpoint-1",
        url: "https://receiver.example/webhooks",
      },
    },
  };
}

function sendTest(
  key: string,
  scopedCredential: ScopedCredential,
  deadline: number,
): SendTestCommand {
  return {
    kind: "send_test",
    context: context(key, scopedCredential, { deadline }),
    input: {
      endpoint: { id: "endpoint-1" },
      eventType: "invoice.paid",
      payload: { invoiceId: "invoice-1" },
    },
  };
}

function metadataInput(
  overrides: Partial<MetadataDeliveryAttemptInput> = {},
): MetadataDeliveryAttemptInput {
  return {
    kind: "delivery_attempt",
    schemaVersion: CANONICAL_METADATA_SCHEMA_VERSION,
    eventId: "event-1",
    deliveryId: "delivery-1",
    endpointId: "endpoint-1",
    eventVersion: {
      eventType: "invoice.paid",
      version: "2026-07-01",
      schemaChecksum: "a".repeat(64),
    },
    attempt: 1,
    sequence: 1,
    status: "attempting",
    occurredAt: "2026-07-01T00:00:00.000Z",
    mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
    ...overrides,
  };
}

function baseConfig(
  routes: Partial<Record<AdapterOperation, GenericHttpRoute>>,
  transport: HttpTransport,
  options: {
    readonly clock?: () => number;
    readonly idempotencyStore?: IdempotencyStore;
    readonly limits?: GenericHttpAdapterConfig["limits"];
  } = {},
): GenericHttpAdapterConfig {
  const clock = options.clock ?? (() => NOW);
  return {
    adapter: {
      id: "customer-control",
      name: "Customer control API",
      version: "1.0.0",
    },
    connectionId: "connection-1",
    baseUrl: "https://api.example.com/v1/",
    routes,
    transport,
    destination: {
      allowedHosts: ["api.example.com"],
      resolver: publicResolver,
    },
    responseCredential: responseCredential(),
    acknowledgementReplayStore: new InMemoryAcknowledgementReplayStore({
      clock,
    }),
    clock,
    ...(options.idempotencyStore === undefined
      ? {}
      : { idempotencyStore: options.idempotencyStore }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
}

function requestEnvelope(
  request: HttpTransportRequest,
): Record<string, unknown> {
  if (request.body !== undefined) {
    return JSON.parse(Buffer.from(request.body).toString("utf8")) as Record<
      string,
      unknown
    >;
  }
  const encoded = request.headers["x-webhook-command-envelope"];
  if (encoded === undefined) {
    throw new Error("Missing command envelope.");
  }
  return JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

function acknowledgement(
  request: HttpTransportRequest,
  operation: AdapterOperation,
  options: {
    readonly disposition?: "completed" | "pending";
    readonly now?: number;
    readonly resourceId?: string;
    readonly state?: string;
  } = {},
): ProviderAcknowledgement {
  const envelope = requestEnvelope(request);
  const issuedAt = options.now ?? NOW;
  const base = {
    operation,
    connectionId: "connection-1",
    tenantId: "tenant-1",
    environment: "production",
    idempotencyKey: envelope["idempotencyKey"] as string,
    commandFingerprint: envelope["commandFingerprint"] as string,
    requestNonce: envelope["nonce"] as string,
    disposition: options.disposition ?? "completed",
    mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
  };
  if (operation.startsWith("endpoint.")) {
    return createAuthenticatedProviderAcknowledgement(
      {
        ...base,
        result: {
          kind: "resource",
          resource: {
            type: "endpoint",
            id: options.resourceId ?? "endpoint-1",
            state:
              options.state ??
              (options.disposition === "pending" ? "pending" : "active"),
          },
          ...(operation === "endpoint.verify" ? { verified: true } : {}),
        },
      },
      responseCredential(),
      { issuedAt, expiresAt: issuedAt + 30_000 },
    );
  }
  if (operation === "send_test") {
    return createAuthenticatedProviderAcknowledgement(
      {
        ...base,
        result: {
          kind: "test_dispatch",
          accepted: true,
          ...(options.disposition === "pending"
            ? {}
            : { deliveryId: "delivery-provider-1" }),
        },
      },
      responseCredential(),
      { issuedAt, expiresAt: issuedAt + 30_000 },
    );
  }
  throw new Error(`Unsupported test acknowledgement ${operation}.`);
}

function withoutAcknowledgementSignature(
  value: ProviderAcknowledgement,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "signature"),
  );
}

describe("SSRF-safe destinations", () => {
  it.each([
    "http://api.example.com/",
    "ftp://api.example.com/",
    "https://user:pass@api.example.com/",
    "https://api.example.com/path#fragment",
    "https://localhost/",
    "https://metadata.google.internal/",
    "https://127.0.0.1/",
    "https://0x7f000001/",
    "https://2130706433/",
    "https://10.1.2.3/",
    "https://169.254.169.254/latest/meta-data",
    "https://168.63.129.16/",
    "https://192.168.1.2/",
    "https://[::1]/",
    "https://[fc00::1]/",
    "https://[fec0::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://api.example.com:8443/",
  ])("rejects malicious or non-public URL %s", (url) => {
    expect(() => validateHttpDestinationSyntax(url)).toThrow(
      UnsafeDestinationError,
    );
  });

  it("validates public literal IPs without DNS", async () => {
    const resolver = vi.fn<HostResolver>();
    const destination = await validateHttpDestination(
      "https://8.8.8.8/control",
      { resolver },
    );
    expect(destination.addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private DNS answers used for rebinding", async () => {
    await expect(
      validateHttpDestination("https://api.example.com/control", {
        resolver: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toMatchObject({
      code: "destination.non_public_address",
    });
  });

  it("always denies Azure WireServer even with permissive HTTP/host settings", async () => {
    expect(isPublicIpAddress("168.63.129.16")).toBe(false);
    expect(isPublicIpAddress("::ffff:168.63.129.16")).toBe(false);
    for (const url of ["http://168.63.129.16/", "https://168.63.129.16/"]) {
      expect(() =>
        validateHttpDestinationSyntax(url, {
          allowHttp: true,
          allowedHosts: ["168.63.129.16"],
          allowedPorts: [80, 443],
        }),
      ).toThrow(UnsafeDestinationError);
    }
    await expect(
      validateHttpDestination("http://wire.example/", {
        allowHttp: true,
        allowedHosts: ["wire.example"],
        allowedPorts: [80],
        resolver: async () => [{ address: "168.63.129.16", family: 4 }],
      }),
    ).rejects.toMatchObject({
      code: "destination.non_public_address",
    });
    expect(isPublicIpAddress("10.0.0.1")).toBe(false);
  });

  it("allows plaintext HTTP only for explicitly opted-in local/private addresses", async () => {
    expect(() =>
      validateHttpDestinationSyntax("http://8.8.8.8/", {
        allowLocalNetwork: true,
        allowedPorts: [80],
      }),
    ).toThrow(/require HTTPS/iu);
    await expect(
      validateHttpDestination("http://public.example/", {
        allowLocalNetwork: true,
        allowedHosts: ["public.example"],
        allowedPorts: [80],
        resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      }),
    ).rejects.toMatchObject({
      code: "destination.public_http_forbidden",
    });
    for (const address of ["127.0.0.1", "10.0.0.1"]) {
      await expect(
        validateHttpDestination(`http://${address}:8080/`, {
          allowLocalNetwork: true,
          allowedPorts: [8080],
        }),
      ).resolves.toMatchObject({
        addresses: [{ address, family: 4 }],
      });
      await expect(
        validateHttpDestination(`http://${address}:8080/`, {
          allowedPorts: [8080],
        }),
      ).rejects.toThrow();
    }
  });
});

describe("authenticated control envelope", () => {
  it("rejects HEAD routes while preserving GET reads", () => {
    for (const [operation, path] of [
      ["endpoint.read", "/v1/endpoints/{endpointId}"],
      ["subscription.read", "/v1/subscriptions/{subscriptionId}"],
      ["metadata.poll", "/v1/metadata"],
    ] as const) {
      expect(
        () =>
          new GenericHttpAdapter(
            baseConfig(
              {
                [operation]: { method: "HEAD", path },
              },
              async () => ({ status: 204 }),
            ),
          ),
      ).toThrow(/HEAD routes are unsupported/iu);
    }
    expect(
      () =>
        new GenericHttpAdapter(
          baseConfig(
            {
              "endpoint.read": {
                method: "GET",
                path: "/v1/endpoints/{endpointId}",
              },
            },
            async () => ({ status: 200 }),
          ),
        ),
    ).not.toThrow();
  });

  it("requires a durable idempotency store for side effects", () => {
    expect(
      () =>
        new GenericHttpAdapter(
          baseConfig(
            {
              "endpoint.create": { method: "POST", path: "endpoints" },
            },
            async () => ({ status: 201 }),
          ),
        ),
    ).toThrow(/durable IdempotencyStore/iu);
    expect(
      () =>
        new GenericHttpAdapter({
          ...baseConfig(
            {
              "endpoint.create": { method: "POST", path: "endpoints" },
            },
            async () => ({ status: 201 }),
            { idempotencyStore: new InMemoryIdempotencyStore() },
          ),
          idempotencyHeaderName: "Authorization",
        }),
    ).toThrow(/idempotency header name is reserved/iu);
    expect(
      () =>
        new GenericHttpAdapter({
          adapter: {
            id: "customer-control",
            name: "Customer control API",
            version: "1.0.0",
          },
          connectionId: "connection-1",
          baseUrl: "https://api.example.com/",
          routes: {
            "endpoint.create": {
              method: "POST",
              path: "endpoints",
            },
          },
          destination: {
            allowedHosts: ["api.example.com"],
            resolver: publicResolver,
          },
          idempotencyStore: new InMemoryIdempotencyStore(),
          responseCredential: responseCredential(),
          transport: async () => ({ status: 201 }),
        }),
    ).toThrow(/acknowledgement replay store/iu);
    expect(
      () =>
        new GenericHttpAdapter({
          ...baseConfig(
            {
              "endpoint.create": {
                method: "POST",
                path: "endpoints",
              },
            },
            async () => ({ status: 201 }),
            { idempotencyStore: new InMemoryIdempotencyStore() },
          ),
          idempotencyRetentionMilliseconds:
            MAX_IDEMPOTENCY_RESULT_RETENTION_MILLISECONDS + 1,
        }),
    ).toThrow(/timing limits/iu);
  });

  it("sends a verifiable full command envelope and accepts only a bound acknowledgement", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    const store = new InMemoryIdempotencyStore();
    let captured: HttpTransportRequest | undefined;
    const adapter = new GenericHttpAdapter({
      ...baseConfig(
        {
          "endpoint.create": { method: "POST", path: "endpoints" },
        },
        async (request) => {
          captured = request;
          return {
            status: 201,
            body: JSON.stringify(acknowledgement(request, "endpoint.create")),
          };
        },
        { idempotencyStore: store },
      ),
    });

    const result = await adapter.execute(
      endpointCreate("envelope-1", scopedCredential),
    );
    expect(result, JSON.stringify(result)).not.toMatchObject({
      status: "failure",
    });
    const envelope = requestEnvelope(captured as HttpTransportRequest);
    expect(
      await verifyAuthenticatedCommandEnvelopeWithReplay(
        envelope,
        scopedCredential,
        {
          adapterId: "customer-control",
          tenantId: "tenant-1",
          environment: "production",
          connectionId: "connection-1",
          operation: "endpoint.create",
          host: "api.example.com",
        },
        new InMemoryCommandEnvelopeReplayStore({
          clock: () => NOW,
        }),
        {
          now: NOW,
          storeDeadlineAt: NOW + 1_000,
          replayRetentionMilliseconds: 60_000,
        },
      ),
    ).toMatchObject({ ok: true, status: "accepted" });
    expect(envelope).toMatchObject({
      operation: "endpoint.create",
      command: {
        kind: "endpoint.create",
        input: {
          endpoint: {
            id: "endpoint-1",
            url: "https://receiver.example/webhooks",
          },
        },
      },
      tenantId: "tenant-1",
      environment: "production",
      connectionId: "connection-1",
      idempotencyKey: "envelope-1",
    });
    expect(result).toMatchObject({
      status: "ok",
      sideEffects: "confirmed",
      value: {
        endpoint: {
          state: "active" as const,
          providerRef: { id: "endpoint-1" },
        },
      },
    });
  });

  it("rejects missing and wrongly scoped credentials before side effects", async () => {
    let calls = 0;
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.create": { method: "POST", path: "endpoints" },
        },
        async () => {
          calls += 1;
          return { status: 201 };
        },
        { idempotencyStore: new InMemoryIdempotencyStore() },
      ),
    );
    const missing = await adapter.execute(
      endpointCreate("missing-auth", undefined),
    );
    const wrongConnectionCredential: ScopedCredential = {
      ...credential(["endpoint.create"]),
      scope: {
        ...credential(["endpoint.create"]).scope,
        connectionId: "other",
      },
    };
    const wrong = await adapter.execute(
      endpointCreate("wrong-auth", wrongConnectionCredential),
    );

    expect(missing).toMatchObject({
      status: "failure",
      error: { code: "authentication_required" },
    });
    expect(wrong).toMatchObject({
      status: "failure",
      error: { code: "auth.connection_scope_mismatch" },
    });
    expect(calls).toBe(0);
  });

  it("requires a distinct response-role acknowledgement key", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    let calls = 0;
    const invalidResponseCredentials = [
      {
        ...responseCredential(),
        id: scopedCredential.id,
      },
      {
        ...responseCredential(),
        id: "different-id-same-material",
        secret: new SecretValue("credential-secret-2d7"),
      },
    ];
    for (const [
      index,
      invalidResponseCredential,
    ] of invalidResponseCredentials.entries()) {
      const adapter = new GenericHttpAdapter({
        ...baseConfig(
          {
            "endpoint.create": { method: "POST", path: "endpoints" },
          },
          async () => {
            calls += 1;
            return { status: 201 };
          },
          { idempotencyStore: new InMemoryIdempotencyStore() },
        ),
        responseCredential: invalidResponseCredential,
      });
      const result = await adapter.execute(
        endpointCreate(`same-response-key-${index}`, scopedCredential),
      );
      expect(result).toMatchObject({
        status: "failure",
        error: { code: "response_credential_not_distinct" },
      });
    }
    expect(calls).toBe(0);
  });
});

describe("DNS resolution failure policy", () => {
  it.each([
    {
      resolverCode: "EAI_AGAIN",
      resultCode: "destination.dns_temporary",
      retryable: true,
    },
    {
      resolverCode: "ETIMEDOUT",
      resultCode: "destination.dns_temporary",
      retryable: true,
    },
    {
      resolverCode: "ENOTFOUND",
      resultCode: "destination.dns_not_found",
      retryable: false,
    },
    {
      resolverCode: "EAI_NONAME",
      resultCode: "destination.dns_not_found",
      retryable: false,
    },
    {
      resolverCode: "EINVAL",
      resultCode: "destination.dns_invalid",
      retryable: false,
    },
    {
      resolverCode: "EIO",
      resultCode: "destination.dns_failure",
      retryable: true,
    },
  ])(
    "maps resolver $resolverCode without durable reservation",
    async ({ resolverCode, resultCode, retryable }) => {
      let reservations = 0;
      let transports = 0;
      const store: IdempotencyStore = {
        async lookup() {
          return { status: "miss" };
        },
        async begin() {
          reservations += 1;
          return { status: "acquired", leaseToken: "dns-lease" };
        },
        async complete() {},
        async release() {},
      };
      const adapter = new GenericHttpAdapter({
        ...baseConfig(
          {
            "endpoint.create": {
              method: "POST",
              path: "/v1/endpoints/{endpointId}",
            },
          },
          async () => {
            transports += 1;
            return { status: 204 };
          },
          { idempotencyStore: store },
        ),
        destination: {
          allowedHosts: ["api.example.com"],
          resolver: async () => {
            const error = new Error(
              "resolver failure",
            ) as NodeJS.ErrnoException;
            error.code = resolverCode;
            throw error;
          },
        },
      });
      const result = await adapter.execute(
        endpointCreate(`dns-${resolverCode}`, credential(["endpoint.create"])),
      );
      expect(result).toMatchObject({
        status: "failure",
        error: { code: resultCode, retryable },
        sideEffects: "none",
      });
      expect(reservations).toBe(0);
      expect(transports).toBe(0);
    },
  );

  it("allows a safe retry after transient DNS failure without suppressing it", async () => {
    const store = new InMemoryIdempotencyStore();
    let resolutions = 0;
    let transports = 0;
    const adapter = new GenericHttpAdapter({
      ...baseConfig(
        {
          "endpoint.create": {
            method: "POST",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async (request) => {
          transports += 1;
          return {
            status: 201,
            body: JSON.stringify(acknowledgement(request, "endpoint.create")),
          };
        },
        { idempotencyStore: store },
      ),
      destination: {
        allowedHosts: ["api.example.com"],
        resolver: async () => {
          resolutions += 1;
          if (resolutions === 1) {
            const error = new Error(
              "temporary DNS failure",
            ) as NodeJS.ErrnoException;
            error.code = "EAI_AGAIN";
            throw error;
          }
          return [{ address: "8.8.8.8", family: 4 }];
        },
      },
    });
    const command = endpointCreate(
      "dns-safe-retry",
      credential(["endpoint.create"]),
    );
    expect(await adapter.execute(command)).toMatchObject({
      status: "failure",
      error: { code: "destination.dns_temporary", retryable: true },
    });
    expect(store.size).toBe(0);
    const succeeded = await adapter.execute(command);
    expect(succeeded.status).toBe("ok");
    expect(await adapter.execute(command)).toEqual(succeeded);
    expect(resolutions).toBe(2);
    expect(transports).toBe(1);
  });

  it("types a resolver stall as a pre-dispatch deadline failure", async () => {
    let reservations = 0;
    const store: IdempotencyStore = {
      async lookup() {
        return { status: "miss" };
      },
      async begin() {
        reservations += 1;
        return { status: "acquired", leaseToken: "unused" };
      },
      async complete() {},
      async release() {},
    };
    const adapter = new GenericHttpAdapter({
      ...baseConfig(
        {
          "endpoint.create": {
            method: "POST",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async () => ({ status: 204 }),
        { idempotencyStore: store, clock: Date.now },
      ),
      destination: {
        allowedHosts: ["api.example.com"],
        resolver: async () => new Promise(() => {}),
      },
    });
    const result = await adapter.execute(
      endpointCreate("dns-deadline", credential(["endpoint.create"]), {
        deadline: Date.now() + 20,
      }),
    );
    expect(result).toMatchObject({
      status: "failure",
      error: { code: "deadline_exceeded", retryable: true },
      sideEffects: "none",
    });
    expect(reservations).toBe(0);
  });
});

describe("route parameter structure", () => {
  it("rejects dot-segment traversal for destructive methods", async () => {
    const scopedCredential = credential([
      "endpoint.delete",
      "endpoint.update",
      "send_test",
    ]);
    let calls = 0;
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.delete": {
            method: "DELETE",
            path: "/v1/endpoints/{endpointId}",
          },
          "endpoint.update": {
            method: "PATCH",
            path: "/v1/endpoints/{endpointId}",
          },
          send_test: {
            method: "POST",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async () => {
          calls += 1;
          return { status: 204 };
        },
        { idempotencyStore: new InMemoryIdempotencyStore() },
      ),
    );
    const maliciousIds = [
      ".",
      "..",
      "%2e%2e",
      "%252e%252e",
      "．．",
      "tenant/../admin",
    ];
    for (const [index, id] of maliciousIds.entries()) {
      const commands: AdapterCommand[] = [
        {
          kind: "endpoint.delete",
          context: context(`delete-traversal-${index}`, scopedCredential),
          input: { endpoint: { id } },
        },
        {
          kind: "endpoint.update",
          context: context(`update-traversal-${index}`, scopedCredential),
          input: { endpoint: { id }, patch: { description: "updated" } },
        },
        {
          kind: "send_test",
          context: context(`test-traversal-${index}`, scopedCredential),
          input: { endpoint: { id }, eventType: "invoice.paid" },
        },
      ];
      for (const command of commands) {
        const result = await adapter.execute(command);
        expect(result).toMatchObject({
          status: "failure",
          error: { code: "route.dot_segment_parameter" },
        });
      }
    }
    expect(calls).toBe(0);
  });

  it("rejects traversal in multi-parameter routes", async () => {
    const scopedCredential = credential(["subscription.replace"]);
    let calls = 0;
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "subscription.replace": {
            method: "PUT",
            path: "/v1/connections/{connectionId}/subscriptions/{subscriptionId}",
          },
        },
        async () => {
          calls += 1;
          return { status: 204 };
        },
        { idempotencyStore: new InMemoryIdempotencyStore() },
      ),
    );
    const result = await adapter.execute({
      kind: "subscription.replace",
      context: context("multi-param-traversal", scopedCredential),
      input: {
        subscription: { id: "%252e%252e" },
        definition: {
          id: "%252e%252e",
          endpoint: { id: "endpoint-1" },
          eventTypes: ["invoice.paid"],
        },
      },
    });
    expect(result).toMatchObject({
      status: "failure",
      error: { code: "route.dot_segment_parameter" },
    });
    expect(calls).toBe(0);
  });

  it("preserves the intended exact route segment structure", async () => {
    const scopedCredential = credential(["endpoint.delete"]);
    let pathname = "";
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.delete": {
            method: "DELETE",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async (request) => {
          pathname = request.url.pathname;
          return {
            status: 200,
            body: JSON.stringify(
              acknowledgement(request, "endpoint.delete", {
                resourceId: "endpoint-safe",
                state: "deleted",
              }),
            ),
          };
        },
        { idempotencyStore: new InMemoryIdempotencyStore() },
      ),
    );
    const result = await adapter.execute({
      kind: "endpoint.delete",
      context: context("safe-delete", scopedCredential),
      input: { endpoint: { id: "endpoint-safe" } },
    });
    expect(result.status).toBe("ok");
    expect(pathname).toBe("/v1/endpoints/endpoint-safe");
  });

  it("rejects dot segments embedded in route literals", () => {
    expect(
      () =>
        new GenericHttpAdapter(
          baseConfig(
            {
              "endpoint.delete": {
                method: "DELETE",
                path: "/v1/../admin/{endpointId}",
              },
            },
            async () => ({ status: 204 }),
            { idempotencyStore: new InMemoryIdempotencyStore() },
          ),
        ),
    ).toThrow(/dot segments/iu);
  });
});

describe("provider reference ownership", () => {
  it("rejects a foreign DELETE endpoint reference before store or transport", async () => {
    let storeCalls = 0;
    let transportCalls = 0;
    const store: IdempotencyStore = {
      async lookup() {
        storeCalls += 1;
        return { status: "miss" };
      },
      async begin() {
        storeCalls += 1;
        return { status: "acquired", leaseToken: "unused" };
      },
      async complete() {
        storeCalls += 1;
      },
      async release() {
        storeCalls += 1;
      },
    };
    const scopedCredential = credential(["endpoint.delete"]);
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.delete": {
            method: "DELETE",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async () => {
          transportCalls += 1;
          return { status: 204 };
        },
        { idempotencyStore: store },
      ),
    );
    const result = await adapter.execute({
      kind: "endpoint.delete",
      context: context("foreign-provider-ref", scopedCredential),
      input: {
        endpoint: {
          providerRef: {
            provider: "other-adapter",
            resourceType: "secret",
            id: "foreign-id",
          },
        },
      },
    });
    expect(result).toMatchObject({
      status: "failure",
      error: { code: "provider_reference_mismatch" },
      sideEffects: "none",
    });
    expect(storeCalls).toBe(0);
    expect(transportCalls).toBe(0);
  });

  it("accepts normalized matching references and missing references where allowed", async () => {
    const scopedCredential = credential(["endpoint.delete"]);
    let expectedId = "";
    let transportCalls = 0;
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.delete": {
            method: "DELETE",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async (request) => {
          transportCalls += 1;
          return {
            status: 200,
            body: JSON.stringify(
              acknowledgement(request, "endpoint.delete", {
                resourceId: expectedId,
                state: "deleted",
              }),
            ),
          };
        },
        { idempotencyStore: new InMemoryIdempotencyStore() },
      ),
    );
    const commands: AdapterCommand[] = [
      {
        kind: "endpoint.delete",
        context: context("normalized-provider-ref", scopedCredential),
        input: {
          endpoint: {
            providerRef: {
              provider: "ＣＵＳＴＯＭＥＲ－ＣＯＮＴＲＯＬ",
              resourceType: "endpoint",
              id: "native-endpoint",
            },
          },
        },
      },
      {
        kind: "endpoint.delete",
        context: context("missing-provider-ref", scopedCredential),
        input: { endpoint: { id: "canonical-endpoint" } },
      },
    ];
    for (const command of commands) {
      expectedId =
        command.kind === "endpoint.delete"
          ? (command.input.endpoint.providerRef?.id ??
            command.input.endpoint.id ??
            "")
          : "";
      expect(await adapter.execute(command)).toMatchObject({
        status: "ok",
        value: {
          deleted: true,
          endpoint: {
            providerRef: {
              provider: "customer-control",
              resourceType: "endpoint",
              id: expectedId,
            },
          },
        },
      });
    }
    expect(transportCalls).toBe(2);
  });

  it("enforces operation-specific resource types across resource commands", async () => {
    const store: IdempotencyStore = {
      async lookup() {
        throw new Error("Provider validation must run first.");
      },
      async begin() {
        throw new Error("Provider validation must run first.");
      },
      async complete() {},
      async release() {},
    };
    const scopedCredential = credential([
      "subscription.pause",
      "secret.revoke",
      "send_test",
      "request_replay",
    ]);
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "subscription.pause": {
            method: "POST",
            path: "/subscriptions/{subscriptionId}/pause",
          },
          "secret.revoke": {
            method: "POST",
            path: "/secrets/{secretId}/revoke",
          },
          send_test: {
            method: "POST",
            path: "/endpoints/{endpointId}/test",
          },
          request_replay: {
            method: "POST",
            path: "/deliveries/{deliveryId}/replay",
          },
        },
        async () => {
          throw new Error("Provider validation must run first.");
        },
        { idempotencyStore: store },
      ),
    );
    const foreign = {
      provider: "customer-control",
      resourceType: "secret",
      id: "wrong-type",
    };
    const commands: AdapterCommand[] = [
      {
        kind: "subscription.pause",
        context: context("wrong-subscription-type", scopedCredential),
        input: { subscription: { providerRef: foreign } },
      },
      {
        kind: "secret.revoke",
        context: context("wrong-secret-provider", scopedCredential),
        input: {
          secret: {
            providerRef: { ...foreign, provider: "other-adapter" },
          },
        },
      },
      {
        kind: "send_test",
        context: context("wrong-test-type", scopedCredential),
        input: {
          endpoint: { providerRef: foreign },
          eventType: "invoice.paid",
        },
      },
      {
        kind: "request_replay",
        context: context("wrong-replay-endpoint", scopedCredential),
        input: {
          deliveryId: "delivery-1",
          endpoint: { providerRef: foreign },
        },
      },
    ];
    for (const command of commands) {
      expect(await adapter.execute(command)).toMatchObject({
        status: "failure",
        error: { code: "provider_reference_mismatch" },
      });
    }
  });
});

describe("deadline-bound external stores", () => {
  it("bounds hung lookup, begin, complete, and release calls", async () => {
    const successfulResult = okResult(
      {
        endpoint: {
          state: "active" as const,
          mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
        },
      },
      { sideEffects: "confirmed" },
    );
    for (const phase of ["lookup", "begin", "complete", "release"] as const) {
      let observedSignal: AbortSignal | undefined;
      const never = <T>(signal: AbortSignal): Promise<T> => {
        observedSignal = signal;
        return new Promise<T>(() => {});
      };
      const store: IdempotencyStore = {
        lookup(input) {
          return phase === "lookup"
            ? never(input.signal)
            : Promise.resolve({ status: "miss" });
        },
        begin(input) {
          return phase === "begin"
            ? never(input.signal)
            : Promise.resolve({
                status: "acquired",
                leaseToken: "lease-token",
              });
        },
        complete(input) {
          return phase === "complete" ? never(input.signal) : Promise.resolve();
        },
        release(input) {
          return phase === "release" ? never(input.signal) : Promise.resolve();
        },
      };
      const deadlineAt = Date.now() + 15;
      await expect(
        withIdempotencyStoreDeadline<unknown>((signal) => {
          if (phase === "lookup") {
            return store.lookup({
              connectionId: "connection-1",
              idempotencyKey: "hung-key",
              commandFingerprint: "a".repeat(64),
              deadlineAt,
              signal,
            });
          }
          if (phase === "begin") {
            return store.begin({
              commandDeadline: deadlineAt,
              connectionId: "connection-1",
              idempotencyKey: "hung-key",
              commandFingerprint: "a".repeat(64),
              operation: "endpoint.create",
              leaseExpiresAt: deadlineAt + 50,
              resultExpiresAt: deadlineAt + 100,
              safetyGraceMilliseconds: 50,
              deadlineAt,
              signal,
            });
          }
          if (phase === "complete") {
            return store.complete({
              connectionId: "connection-1",
              idempotencyKey: "hung-key",
              commandFingerprint: "a".repeat(64),
              leaseToken: "lease-token",
              result: successfulResult,
              deadlineAt,
              signal,
            });
          }
          return store.release({
            connectionId: "connection-1",
            idempotencyKey: "hung-key",
            commandFingerprint: "a".repeat(64),
            leaseToken: "lease-token",
            deadlineAt,
            signal,
          });
        }, deadlineAt),
      ).rejects.toBeInstanceOf(Error);
      expect(observedSignal?.aborted).toBe(true);
    }
  });

  it.each(["lookup", "begin"] as const)(
    "prevents dispatch when %s stalls through the command deadline",
    async (phase) => {
      let transports = 0;
      let observedSignal: AbortSignal | undefined;
      const store: IdempotencyStore = {
        lookup(input) {
          if (phase === "lookup") {
            observedSignal = input.signal;
            return new Promise(() => {});
          }
          return Promise.resolve({ status: "miss" });
        },
        begin(input) {
          if (phase === "begin") {
            observedSignal = input.signal;
            return new Promise(() => {});
          }
          return Promise.resolve({
            status: "acquired",
            leaseToken: "unused",
          });
        },
        async complete() {},
        async release() {},
      };
      const adapter = new GenericHttpAdapter(
        baseConfig(
          {
            "endpoint.create": {
              method: "POST",
              path: "/v1/endpoints/{endpointId}",
            },
          },
          async () => {
            transports += 1;
            return { status: 204 };
          },
          { idempotencyStore: store, clock: Date.now },
        ),
      );
      const result = await adapter.execute(
        endpointCreate(`hung-${phase}`, credential(["endpoint.create"]), {
          deadline: Date.now() + 500,
        }),
      );
      expect(result).toMatchObject({
        status: "failure",
        error: { code: "deadline_exceeded" },
      });
      expect(observedSignal?.aborted).toBe(true);
      expect(transports).toBe(0);
    },
  );

  it("blocks a competing dispatch while completion is stalled", async () => {
    let state: "empty" | "in_progress" = "empty";
    let transports = 0;
    let completionSignal: AbortSignal | undefined;
    let completeStarted: (() => void) | undefined;
    const completing = new Promise<void>((resolve) => {
      completeStarted = resolve;
    });
    const store: IdempotencyStore = {
      lookup() {
        return Promise.resolve(
          state === "in_progress"
            ? { status: "in_progress" }
            : { status: "miss" },
        );
      },
      begin() {
        state = "in_progress";
        return Promise.resolve({
          status: "acquired",
          leaseToken: "completion-lease",
        });
      },
      complete(input) {
        completionSignal = input.signal;
        completeStarted?.();
        return new Promise(() => {});
      },
      async release() {
        state = "empty";
      },
    };
    const adapter = new GenericHttpAdapter({
      ...baseConfig(
        {
          "endpoint.create": {
            method: "POST",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async (request) => {
          transports += 1;
          const current = Date.now();
          return {
            status: 201,
            body: JSON.stringify(
              acknowledgement(request, "endpoint.create", {
                now: current,
              }),
            ),
          };
        },
        { idempotencyStore: store, clock: Date.now },
      ),
      idempotencySafetyGraceMilliseconds: 20,
    });
    const scopedCredential = credential(["endpoint.create"]);
    const first = adapter.execute(
      endpointCreate("hung-complete", scopedCredential, {
        deadline: Date.now() + 500,
      }),
    );
    await completing;
    const competing = await adapter.execute(
      endpointCreate("hung-complete", scopedCredential, {
        deadline: Date.now() + 500,
      }),
    );
    expect(competing).toMatchObject({
      status: "unknown",
      sideEffects: "possible",
    });
    expect(await first).toMatchObject({
      status: "unknown",
      sideEffects: "possible",
    });
    expect(completionSignal?.aborted).toBe(true);
    expect(transports).toBe(1);
  });
});

describe("durable idempotency", () => {
  it("uses an ASCII header digest while preserving Unicode replay identity", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    let headerValue = "";
    let envelopeKey = "";
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.create": {
            method: "POST",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async (request) => {
          calls += 1;
          headerValue = request.headers["idempotency-key"] ?? "";
          envelopeKey = requestEnvelope(request)["idempotencyKey"] as string;
          return {
            status: 201,
            body: JSON.stringify(acknowledgement(request, "endpoint.create")),
          };
        },
        { idempotencyStore: store },
      ),
    );
    const command = endpointCreate("注文-1", scopedCredential);
    const first = await adapter.execute(command);
    const replay = await adapter.execute(command);

    expect(first.status).toBe("ok");
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    expect(envelopeKey).toBe("注文-1");
    expect(headerValue).toBe(deriveIdempotencyHeaderValue("注文-1"));
    expect(headerValue).toMatch(/^whp-idem-v1\.[A-Za-z0-9_-]{43}$/u);
    expect(headerValue).not.toContain("注文");
  });

  it("releases a retryable side-effect-free response for a safe retry", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    const backingStore = new InMemoryIdempotencyStore();
    let acquiredToken: string | undefined;
    let releaseDeadline: number | undefined;
    let releaseSignal: AbortSignal | undefined;
    let releaseToken: string | undefined;
    const store: IdempotencyStore = {
      lookup(input) {
        return backingStore.lookup(input);
      },
      async begin(input) {
        const result = await backingStore.begin(input);
        if (result.status === "acquired") {
          acquiredToken = result.leaseToken;
        }
        return result;
      },
      complete(input) {
        return backingStore.complete(input);
      },
      release(input) {
        releaseDeadline = input.deadlineAt;
        releaseSignal = input.signal;
        releaseToken = input.leaseToken;
        return backingStore.release(input);
      },
    };
    let calls = 0;
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.create": {
            method: "POST",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async (request) => {
          calls += 1;
          if (calls === 1) {
            return { status: 429 };
          }
          return {
            status: 201,
            body: JSON.stringify(acknowledgement(request, "endpoint.create")),
          };
        },
        { idempotencyStore: store },
      ),
    );
    const command = endpointCreate("rate-limit-retry", scopedCredential);

    const rateLimited = await adapter.execute(command);
    expect(rateLimited).toMatchObject({
      status: "failure",
      error: { code: "rate_limited", retryable: true },
      sideEffects: "none",
    });
    expect(backingStore.size).toBe(0);
    expect(releaseToken).toBe(acquiredToken);
    expect(releaseDeadline).toBe(command.context.deadline.at + 30_000);
    expect(releaseSignal?.aborted).toBe(false);

    const succeeded = await adapter.execute(command);
    expect(succeeded.status).toBe("ok");
    expect(await adapter.execute(command)).toEqual(succeeded);
    expect(calls).toBe(2);
    expect(backingStore.size).toBe(1);
  });

  it.each([
    {
      providerStatus: 422,
      resultStatus: "failure",
      sideEffects: "none",
      retryable: false,
    },
    {
      providerStatus: 500,
      resultStatus: "unknown",
      sideEffects: "possible",
      retryable: true,
    },
  ] as const)(
    "caches durable $providerStatus outcomes instead of redispatching",
    async ({ providerStatus, resultStatus, retryable, sideEffects }) => {
      const scopedCredential = credential(["endpoint.create"]);
      const store = new InMemoryIdempotencyStore();
      let calls = 0;
      const adapter = new GenericHttpAdapter(
        baseConfig(
          {
            "endpoint.create": {
              method: "POST",
              path: "/v1/endpoints/{endpointId}",
            },
          },
          async () => {
            calls += 1;
            return { status: providerStatus };
          },
          { idempotencyStore: store },
        ),
      );
      const command = endpointCreate(
        `durable-${providerStatus}`,
        scopedCredential,
      );

      const first = await adapter.execute(command);
      expect(first).toMatchObject({
        status: resultStatus,
        sideEffects,
        ...(resultStatus === "failure"
          ? { error: { retryable } }
          : { retryable }),
      });
      expect(await adapter.execute(command)).toEqual(first);
      expect(calls).toBe(1);
      expect(store.size).toBe(1);
    },
  );

  it("releases a lease for a local Node invalid-header error", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    let released = 0;
    let completed = 0;
    const store: IdempotencyStore = {
      async lookup() {
        return { status: "miss" };
      },
      async begin() {
        return { status: "acquired", leaseToken: "header-lease" };
      },
      async complete() {
        completed += 1;
      },
      async release() {
        released += 1;
      },
    };
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.create": {
            method: "POST",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async () => {
          const error = new Error("invalid header") as NodeJS.ErrnoException;
          error.code = "ERR_INVALID_CHAR";
          throw error;
        },
        { idempotencyStore: store },
      ),
    );
    const result = await adapter.execute(
      endpointCreate("header-error", scopedCredential),
    );
    expect(result).toMatchObject({
      status: "failure",
      error: { code: "headers.invalid_value", retryable: false },
      sideEffects: "none",
    });
    expect(released).toBe(1);
    expect(completed).toBe(0);
  });

  it("still validates destination DNS on the first execution", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    const adapter = new GenericHttpAdapter({
      ...baseConfig(
        { "endpoint.create": { method: "POST", path: "endpoints" } },
        async () => {
          calls += 1;
          return { status: 201 };
        },
        { idempotencyStore: store },
      ),
      destination: {
        allowedHosts: ["api.example.com"],
        resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      },
    });
    const result = await adapter.execute(
      endpointCreate("first-dns-validation", scopedCredential),
    );
    expect(result).toMatchObject({
      status: "failure",
      error: { code: "destination.non_public_address" },
    });
    expect(calls).toBe(0);
    expect(store.size).toBe(0);
  });

  it("evicts only after the protected retention boundary", async () => {
    let clock = 100;
    let token = 0;
    const store = new InMemoryIdempotencyStore({
      maxEntries: 1,
      clock: () => clock,
      tokenFactory: () => `lease-${++token}`,
    });
    const signal = new AbortController().signal;
    await expect(
      store.begin({
        commandDeadline: 200,
        connectionId: "connection-1",
        idempotencyKey: "too-short",
        commandFingerprint: "d".repeat(64),
        operation: "endpoint.create",
        leaseExpiresAt: 249,
        resultExpiresAt: 300,
        safetyGraceMilliseconds: 50,
        deadlineAt: 1_000,
        signal,
      }),
    ).rejects.toThrow(/deadline plus safety grace/iu);
    expect(
      await store.begin({
        commandDeadline: 150,
        connectionId: "connection-1",
        idempotencyKey: "protected",
        commandFingerprint: "a".repeat(64),
        operation: "endpoint.create",
        leaseExpiresAt: 200,
        resultExpiresAt: 300,
        safetyGraceMilliseconds: 50,
        deadlineAt: 1_000,
        signal,
      }),
    ).toEqual({ status: "acquired", leaseToken: "lease-1" });
    clock = 199;
    expect(store.purgeExpired()).toBe(0);
    expect(
      await store.begin({
        commandDeadline: 250,
        connectionId: "connection-1",
        idempotencyKey: "other",
        commandFingerprint: "b".repeat(64),
        operation: "endpoint.create",
        leaseExpiresAt: 300,
        resultExpiresAt: 400,
        safetyGraceMilliseconds: 50,
        deadlineAt: 1_000,
        signal,
      }),
    ).toEqual({ status: "capacity" });
    clock = 200;
    expect(store.purgeExpired()).toBe(1);
    expect(
      await store.begin({
        commandDeadline: 250,
        connectionId: "connection-1",
        idempotencyKey: "other",
        commandFingerprint: "b".repeat(64),
        operation: "endpoint.create",
        leaseExpiresAt: 300,
        resultExpiresAt: 400,
        safetyGraceMilliseconds: 50,
        deadlineAt: 1_000,
        signal,
      }),
    ).toEqual({ status: "acquired", leaseToken: "lease-2" });
  });

  it("rejects stale lease completion and competing ownership", async () => {
    let clock = 0;
    let token = 0;
    const store = new InMemoryIdempotencyStore({
      clock: () => clock,
      tokenFactory: () => `generation-${++token}`,
    });
    const reservation = {
      commandDeadline: 50,
      connectionId: "connection-1",
      idempotencyKey: "lease-key",
      commandFingerprint: "c".repeat(64),
      operation: "endpoint.create" as const,
      leaseExpiresAt: 100,
      resultExpiresAt: 200,
      safetyGraceMilliseconds: 50,
      deadlineAt: 1_000,
      signal: new AbortController().signal,
    };
    const first = await store.begin(reservation);
    expect(first).toEqual({
      status: "acquired",
      leaseToken: "generation-1",
    });
    expect(await store.begin(reservation)).toEqual({
      status: "in_progress",
    });

    clock = 100;
    expect(store.purgeExpired()).toBe(1);
    const second = await store.begin({
      ...reservation,
      commandDeadline: 250,
      leaseExpiresAt: 300,
      resultExpiresAt: 400,
    });
    expect(second).toEqual({
      status: "acquired",
      leaseToken: "generation-2",
    });
    const successfulResult = okResult(
      {
        endpoint: {
          state: "active" as const,
          mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
        },
      },
      { sideEffects: "confirmed" },
    );
    await expect(
      store.complete({
        connectionId: reservation.connectionId,
        idempotencyKey: reservation.idempotencyKey,
        commandFingerprint: reservation.commandFingerprint,
        leaseToken: "generation-1",
        result: successfulResult,
        deadlineAt: 1_000,
        signal: reservation.signal,
      }),
    ).rejects.toMatchObject({ code: "idempotency_lease_mismatch" });
    await expect(
      store.release({
        connectionId: reservation.connectionId,
        idempotencyKey: reservation.idempotencyKey,
        commandFingerprint: reservation.commandFingerprint,
        leaseToken: "generation-1",
        deadlineAt: 1_000,
        signal: reservation.signal,
      }),
    ).rejects.toMatchObject({ code: "idempotency_lease_mismatch" });
    await store.complete({
      connectionId: reservation.connectionId,
      idempotencyKey: reservation.idempotencyKey,
      commandFingerprint: reservation.commandFingerprint,
      leaseToken: "generation-2",
      result: successfulResult,
      deadlineAt: 1_000,
      signal: reservation.signal,
    });
    expect(
      await store.lookup({
        connectionId: reservation.connectionId,
        idempotencyKey: reservation.idempotencyKey,
        commandFingerprint: reservation.commandFingerprint,
        deadlineAt: 1_000,
        signal: reservation.signal,
      }),
    ).toMatchObject({ status: "replay" });
  });

  it("protects reservations beyond short retention through deadline grace", async () => {
    let clock = NOW;
    const store = new InMemoryIdempotencyStore({
      clock: () => clock,
    });
    const scopedCredential = credential(["endpoint.create"]);
    let calls = 0;
    const config = {
      ...baseConfig(
        { "endpoint.create": { method: "POST", path: "endpoints" } },
        async (request: HttpTransportRequest) => {
          calls += 1;
          return {
            status: 201,
            body: JSON.stringify(acknowledgement(request, "endpoint.create")),
          };
        },
        { idempotencyStore: store, clock: () => clock },
      ),
      idempotencyRetentionMilliseconds: 10,
      idempotencySafetyGraceMilliseconds: 50,
    };
    const adapter = new GenericHttpAdapter(config);
    const command = endpointCreate("deadline-protected", scopedCredential, {
      deadline: NOW + 1_000,
    });
    const first = await adapter.execute(command);

    clock = NOW + 20;
    expect(store.purgeExpired()).toBe(0);
    const restarted = new GenericHttpAdapter({
      ...config,
      destination: {
        allowedHosts: ["api.example.com"],
        resolver: async () => {
          throw new Error("Replay must happen before DNS.");
        },
      },
    });
    expect(await restarted.execute(command)).toEqual(first);
    expect(calls).toBe(1);

    clock = NOW + 1_050;
    expect(store.purgeExpired()).toBe(1);
  });

  it("refuses dispatch when the durable store is unavailable", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    let calls = 0;
    const adapter = new GenericHttpAdapter({
      ...baseConfig(
        { "endpoint.create": { method: "POST", path: "endpoints" } },
        async () => {
          calls += 1;
          return { status: 201 };
        },
      ),
      idempotencyStore: {
        async lookup() {
          throw new Error("store unavailable");
        },
        async begin() {
          throw new Error("store unavailable");
        },
        async complete() {},
        async release() {},
      },
    });
    const result = await adapter.execute(
      endpointCreate("store-unavailable", scopedCredential),
    );
    expect(result).toMatchObject({
      status: "failure",
      error: {
        code: "idempotency_store_unavailable",
        retryable: true,
      },
    });
    expect(calls).toBe(0);
  });

  it("replays across adapter restart and rejects cross-operation key reuse", async () => {
    const scopedCredential = credential(["endpoint.create", "send_test"]);
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    const transport: HttpTransport = async (request) => {
      calls += 1;
      return {
        status: 201,
        body: JSON.stringify(acknowledgement(request, "endpoint.create")),
      };
    };
    const routes = {
      "endpoint.create": { method: "POST", path: "endpoints" },
      send_test: { method: "POST", path: "tests" },
    } as const;
    const firstAdapter = new GenericHttpAdapter(
      baseConfig(routes, transport, { idempotencyStore: store }),
    );
    const command = endpointCreate("restart-key", scopedCredential);
    const first = await firstAdapter.execute(command);
    let replayDnsCalls = 0;
    const restarted = new GenericHttpAdapter({
      ...baseConfig(
        routes,
        async () => {
          calls += 1;
          throw new Error("A durable replay must not dispatch.");
        },
        { idempotencyStore: store },
      ),
      destination: {
        allowedHosts: ["api.example.com"],
        resolver: async () => {
          replayDnsCalls += 1;
          throw new Error("DNS changed after the completed command.");
        },
      },
    });
    const replay = await restarted.execute(
      endpointCreate("restart-key", scopedCredential),
    );
    const payloadConflict = await restarted.execute(
      endpointCreate("restart-key", scopedCredential, {
        id: "different-endpoint",
      }),
    );
    const conflict = await restarted.execute(
      sendTest("restart-key", scopedCredential, NOW + 30_000),
    );
    const routeUnavailable = new GenericHttpAdapter(
      baseConfig(
        {},
        async () => {
          calls += 1;
          throw new Error("A route-less replay must not dispatch.");
        },
        { idempotencyStore: store },
      ),
    );
    const routeReplay = await routeUnavailable.execute(
      endpointCreate("restart-key", scopedCredential),
    );

    expect(replay).toEqual(first);
    expect(routeReplay).toEqual(first);
    expect(payloadConflict).toMatchObject({
      status: "failure",
      error: { code: "idempotency_conflict" },
    });
    expect(conflict).toMatchObject({
      status: "failure",
      error: { code: "idempotency_conflict" },
    });
    expect(calls).toBe(1);
    expect(replayDnsCalls).toBe(0);
  });

  it("never silently evicts protected records at capacity", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    const store = new InMemoryIdempotencyStore({ maxEntries: 1 });
    let calls = 0;
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.create": { method: "POST", path: "endpoints" },
        },
        async (request) => {
          calls += 1;
          return {
            status: 201,
            body: JSON.stringify(
              acknowledgement(request, "endpoint.create", {
                resourceId: requestEnvelope(request)[
                  "idempotencyKey"
                ] as string,
              }),
            ),
          };
        },
        { idempotencyStore: store },
      ),
    );
    const first = endpointCreate("key-one", scopedCredential, {
      id: "key-one",
    });
    const firstResult = await adapter.execute(first);
    const capacity = await adapter.execute(
      endpointCreate("key-two", scopedCredential, { id: "key-two" }),
    );
    const replay = await adapter.execute(first);

    expect(capacity).toMatchObject({
      status: "failure",
      error: { code: "idempotency_store_capacity" },
    });
    expect(replay).toEqual(firstResult);
    expect(calls).toBe(1);
    expect(store.size).toBe(1);
  });
});

describe("provider acknowledgements", () => {
  it("keeps read outcomes side-effect free across result states", async () => {
    const scopedCredential = credential(["endpoint.read"]);
    const command = {
      kind: "endpoint.read" as const,
      context: context("read-side-effects", scopedCredential),
      input: { endpoint: { id: "endpoint-1" } },
    };
    const completed = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.read": {
            method: "GET",
            path: "/v1/endpoints/{endpointId}",
            status: "degraded",
            degradedReason: "provider lag",
          },
        },
        async (request) => ({
          status: 200,
          body: JSON.stringify(
            acknowledgement(request, "endpoint.read", {
              resourceId: "endpoint-1",
              state: "active",
            }),
          ),
        }),
      ),
    );
    const degraded = await completed.execute(command);
    expect(degraded).toMatchObject({
      status: "degraded",
      sideEffects: "none",
    });

    const pending = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.read": {
            method: "GET",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async (request) => ({
          status: 202,
          body: JSON.stringify(
            acknowledgement(request, "endpoint.read", {
              disposition: "pending",
              resourceId: "endpoint-1",
              state: "pending",
            }),
          ),
        }),
      ),
    );
    expect(
      await pending.execute({
        ...command,
        context: context("read-pending", scopedCredential),
      }),
    ).toMatchObject({
      status: "degraded",
      sideEffects: "none",
    });

    const failed = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.read": {
            method: "GET",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async () => ({ status: 404 }),
      ),
    );
    expect(
      await failed.execute({
        ...command,
        context: context("read-failure", scopedCredential),
      }),
    ).toMatchObject({
      status: "failure",
      sideEffects: "none",
    });

    const timedOut = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.read": {
            method: "GET",
            path: "/v1/endpoints/{endpointId}",
          },
        },
        async (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          }),
        { clock: Date.now },
      ),
    );
    expect(
      await timedOut.execute({
        ...command,
        context: context("read-timeout", scopedCredential, {
          deadline: Date.now() + 20,
        }),
      }),
    ).toMatchObject({
      status: "failure",
      sideEffects: "none",
      error: { code: "deadline_exceeded" },
    });
  });

  it("bounds a stalled acknowledgement replay-store consume", async () => {
    const current = Date.now();
    const responseKey = responseCredential();
    const binding = {
      adapterId: "customer-control",
      operation: "endpoint.create" as const,
      connectionId: "connection-1",
      tenantId: "tenant-1",
      environment: "production",
      requestNonce: "hung-consume-request",
      idempotencyKey: "hung-consume-key",
      commandFingerprint: "f".repeat(64),
      mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
      expectedResourceId: "endpoint-1",
    };
    const acknowledgement = createAuthenticatedProviderAcknowledgement(
      {
        operation: binding.operation,
        connectionId: binding.connectionId,
        tenantId: binding.tenantId,
        environment: binding.environment,
        requestNonce: binding.requestNonce,
        idempotencyKey: binding.idempotencyKey,
        commandFingerprint: binding.commandFingerprint,
        mappingVersion: binding.mappingVersion,
        disposition: "completed",
        result: {
          kind: "resource",
          resource: {
            type: "endpoint",
            id: "endpoint-1",
            state: "active",
          },
        },
      },
      responseKey,
      {
        issuedAt: current,
        expiresAt: current + 1_000,
        nonce: "hung-consume-response",
      },
    );
    let observedSignal: AbortSignal | undefined;
    const result = await verifyProviderAcknowledgement(
      acknowledgement,
      binding,
      responseKey,
      {
        consume(input) {
          observedSignal = input.signal;
          return new Promise(() => {});
        },
      },
      {
        now: current,
        deadlineAt: Date.now() + 500,
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "acknowledgement.replay_store_unavailable",
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it.each([
    { name: "mapping", version: "1" },
    { name: "mapping", version: "1", schemaVersion: "2026-07-01" },
    { name: "映射-😀", version: "β" },
  ])("round-trips canonical mapping version %#", async (mappingVersion) => {
    const responseKey = responseCredential();
    const binding = {
      adapterId: "customer-control",
      operation: "endpoint.create" as const,
      connectionId: "connection-1",
      tenantId: "tenant-1",
      environment: "production",
      requestNonce: `mapping-request-${mappingVersion.name}`,
      idempotencyKey: `mapping-key-${mappingVersion.version}`,
      commandFingerprint: "e".repeat(64),
      mappingVersion,
      expectedResourceId: "endpoint-1",
    };
    const acknowledgement = createAuthenticatedProviderAcknowledgement(
      {
        operation: binding.operation,
        connectionId: binding.connectionId,
        tenantId: binding.tenantId,
        environment: binding.environment,
        requestNonce: binding.requestNonce,
        idempotencyKey: binding.idempotencyKey,
        commandFingerprint: binding.commandFingerprint,
        mappingVersion,
        disposition: "completed",
        result: {
          kind: "resource",
          resource: {
            type: "endpoint",
            id: "endpoint-1",
            state: "active",
          },
        },
      },
      responseKey,
      {
        issuedAt: NOW,
        expiresAt: NOW + 30_000,
        nonce: `mapping-response-${mappingVersion.version}`,
      },
    );
    expect(
      await verifyProviderAcknowledgement(
        acknowledgement,
        binding,
        responseKey,
        new InMemoryAcknowledgementReplayStore({
          clock: () => NOW,
        }),
        { now: NOW },
      ),
    ).toMatchObject({
      ok: true,
      acknowledgement: {
        mappingVersion,
      },
    });
    expect(Object.hasOwn(acknowledgement.mappingVersion, "schemaVersion")).toBe(
      mappingVersion.schemaVersion !== undefined,
    );
  });

  it("authenticates, scopes, expires, and replay-protects closed acknowledgements", async () => {
    const responseKey = responseCredential();
    const binding = {
      adapterId: "customer-control",
      operation: "secret.rotate_with_overlap" as const,
      connectionId: "connection-1",
      tenantId: "tenant-1",
      environment: "production",
      requestNonce: "request-nonce-1",
      idempotencyKey: "rotate-key",
      commandFingerprint: "a".repeat(64),
      mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
      expectedResourceId: "secret-1",
    };
    const valid = createAuthenticatedProviderAcknowledgement(
      {
        operation: binding.operation,
        connectionId: binding.connectionId,
        tenantId: binding.tenantId,
        environment: binding.environment,
        requestNonce: binding.requestNonce,
        idempotencyKey: binding.idempotencyKey,
        commandFingerprint: binding.commandFingerprint,
        mappingVersion: binding.mappingVersion,
        disposition: "completed",
        result: {
          kind: "resource",
          resource: {
            type: "secret",
            id: "secret-1",
            state: "overlapping",
          },
        },
      },
      responseKey,
      {
        issuedAt: NOW,
        expiresAt: NOW + 30_000,
        nonce: "response-nonce-1",
      },
    );
    const replayStore = new InMemoryAcknowledgementReplayStore({
      clock: () => NOW,
    });
    expect(
      await verifyProviderAcknowledgement(
        valid,
        binding,
        responseKey,
        replayStore,
        { now: NOW },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await verifyProviderAcknowledgement(
        valid,
        binding,
        responseKey,
        replayStore,
        { now: NOW },
      ),
    ).toMatchObject({
      ok: false,
      code: "acknowledgement.replayed",
    });
    expect(
      await verifyProviderAcknowledgement(
        {
          ...valid,
          signature: { ...valid.signature, value: "A".repeat(43) },
        },
        binding,
        responseKey,
        new InMemoryAcknowledgementReplayStore(),
        { now: NOW },
      ),
    ).toMatchObject({
      ok: false,
      code: "acknowledgement.signature_invalid",
    });
    expect(
      await verifyProviderAcknowledgement(
        valid,
        binding,
        responseKey,
        new InMemoryAcknowledgementReplayStore(),
        { now: NOW + 31_000 },
      ),
    ).toMatchObject({
      ok: false,
      code: "acknowledgement.expired",
    });
    expect(
      await verifyProviderAcknowledgement(
        valid,
        binding,
        { ...responseKey, id: "wrong-key" },
        new InMemoryAcknowledgementReplayStore(),
        { now: NOW },
      ),
    ).toMatchObject({
      ok: false,
      code: "acknowledgement.wrong_key",
    });
    expect(
      await verifyProviderAcknowledgement(
        valid,
        binding,
        responseCredential({ tenantId: "other-tenant" }),
        new InMemoryAcknowledgementReplayStore(),
        { now: NOW },
      ),
    ).toMatchObject({
      ok: false,
      code: "acknowledgement.tenant_scope_mismatch",
    });
    const unsigned = withoutAcknowledgementSignature(valid);
    expect(
      await verifyProviderAcknowledgement(
        unsigned,
        binding,
        responseKey,
        new InMemoryAcknowledgementReplayStore(),
        { now: NOW },
      ),
    ).toMatchObject({
      ok: false,
      code: "acknowledgement.invalid_or_unbound",
    });
    expect(
      await verifyProviderAcknowledgement(
        valid,
        { ...binding, idempotencyKey: "wrong-key" },
        responseKey,
        new InMemoryAcknowledgementReplayStore(),
        { now: NOW },
      ),
    ).toMatchObject({
      ok: false,
      code: "acknowledgement.invalid_or_unbound",
    });
  });

  it("maps 202 only to pending and never fabricates confirmed state", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.create": { method: "POST", path: "endpoints" },
        },
        async (request) => ({
          status: 202,
          body: JSON.stringify(
            acknowledgement(request, "endpoint.create", {
              disposition: "pending",
              state: "pending",
            }),
          ),
        }),
        { idempotencyStore: new InMemoryIdempotencyStore() },
      ),
    );

    const result = await adapter.execute(
      endpointCreate("pending", scopedCredential),
    );
    expect(result).toMatchObject({
      status: "degraded",
      sideEffects: "possible",
      value: { endpoint: { state: "pending" } },
      metadata: { acknowledgement: { disposition: "pending" } },
    });
  });

  it("rejects unsigned and forged provider responses before state mapping", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    for (const variant of ["unsigned", "forged"] as const) {
      const adapter = new GenericHttpAdapter(
        baseConfig(
          {
            "endpoint.create": { method: "POST", path: "endpoints" },
          },
          async (request) => {
            const signed = acknowledgement(request, "endpoint.create");
            if (variant === "unsigned") {
              return {
                status: 201,
                body: JSON.stringify(withoutAcknowledgementSignature(signed)),
              };
            }
            return {
              status: 201,
              body: JSON.stringify({
                ...signed,
                signature: {
                  ...signed.signature,
                  value: "A".repeat(43),
                },
              }),
            };
          },
          { idempotencyStore: new InMemoryIdempotencyStore() },
        ),
      );
      const result = await adapter.execute(
        endpointCreate(`bad-ack-${variant}`, scopedCredential),
      );
      expect(result.status).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain('"state":"active"');
    }
  });

  it.each([
    { status: 204, body: undefined },
    { status: 200, body: "" },
  ])("returns unknown for empty success $status", async ({ status, body }) => {
    const scopedCredential = credential(["endpoint.create"]);
    const adapter = new GenericHttpAdapter(
      baseConfig(
        {
          "endpoint.create": { method: "POST", path: "endpoints" },
        },
        async () => ({ status, ...(body === undefined ? {} : { body }) }),
        { idempotencyStore: new InMemoryIdempotencyStore() },
      ),
    );
    const result = await adapter.execute(
      endpointCreate(`empty-${status}`, scopedCredential),
    );
    expect(result).toMatchObject({
      status: "unknown",
      sideEffects: "possible",
    });
  });

  it("rejects contradictory resource IDs and states without fabricating output", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    for (const options of [
      { resourceId: "other-endpoint", state: "active" },
      { resourceId: "endpoint-1", state: "deleted" },
    ]) {
      const adapter = new GenericHttpAdapter(
        baseConfig(
          {
            "endpoint.create": { method: "POST", path: "endpoints" },
          },
          async (request) => ({
            status: 201,
            body: JSON.stringify(
              acknowledgement(request, "endpoint.create", options),
            ),
          }),
          { idempotencyStore: new InMemoryIdempotencyStore() },
        ),
      );
      const result = await adapter.execute(
        endpointCreate(`contradiction-${options.state}`, scopedCredential),
      );
      expect(result.status).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("other-endpoint");
    }
  });
});

describe("operation-aware timeout policy", () => {
  it("never redispatches an unknown send_test across timeout and restart", async () => {
    const scopedCredential = credential(["send_test"]);
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    let observedAbort = false;
    const first = new GenericHttpAdapter(
      baseConfig(
        { send_test: { method: "POST", path: "tests" } },
        async (request) => {
          calls += 1;
          return new Promise((_resolve, reject) => {
            let observed = false;
            const abort = (): void => {
              if (observed) return;
              observed = true;
              observedAbort = true;
              reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", abort, { once: true });
            if (request.signal.aborted) {
              abort();
            }
          });
        },
        { idempotencyStore: store, clock: Date.now },
      ),
    );
    const result = await first.execute(
      sendTest("send-timeout", scopedCredential, Date.now() + 500),
    );
    const restarted = new GenericHttpAdapter(
      baseConfig(
        { send_test: { method: "POST", path: "tests" } },
        async () => {
          calls += 1;
          return { status: 201 };
        },
        { idempotencyStore: store, clock: Date.now },
      ),
    );
    const replay = await restarted.execute(
      sendTest("send-timeout", scopedCredential, Date.now() + 30_000),
    );

    expect(observedAbort).toBe(true);
    expect(result).toMatchObject({
      status: "unknown",
      retryable: false,
    });
    expect(replay).toEqual(result);
    expect(calls).toBe(1);
  });
});

describe("metadata ingestion and polling", () => {
  it("cannot configure or execute metadata.push against the control base URL", async () => {
    expect(
      () =>
        new GenericHttpAdapter({
          ...baseConfig({}, async () => ({ status: 202 })),
          routes: {
            "metadata.push": { method: "POST", path: "metadata" },
          } as unknown as GenericHttpAdapterConfig["routes"],
        }),
    ).toThrow(/inbound metadata/iu);

    let calls = 0;
    const adapter = new GenericHttpAdapter(
      baseConfig(
        { "metadata.poll": { method: "GET", path: "metadata" } },
        async () => {
          calls += 1;
          return { status: 200, body: JSON.stringify({ records: [] }) };
        },
      ),
    );
    const result = await adapter.execute({
      kind: "metadata.push",
      context: context(
        "forbidden-metadata-push",
        credential(["metadata.poll"]),
      ),
      input: { records: [metadataInput()] },
    } as never);
    expect(result).toMatchObject({
      status: "failure",
      error: { code: "operation_not_supported" },
    });
    expect(calls).toBe(0);
  });

  it("verifies inbound metadata without a control base URL", () => {
    const scopedCredential = credential(["metadata.ingest"], {});
    const identity = {
      tenantId: "tenant-1",
      environment: "production",
      adapterId: "customer-control",
      connectionId: "connection-1",
    };
    const envelope = createAuthenticatedMetadataIngestEnvelope(
      [metadataInput()],
      identity,
      "batch-1",
      scopedCredential,
      { issuedAt: NOW, expiresAt: NOW + 30_000 },
    );
    const verifier = new MetadataIngestVerifier({
      identity,
      credential: scopedCredential,
      clock: () => NOW,
    });

    expect(verifier.verify(envelope)).toMatchObject({
      ok: true,
      records: [
        {
          tenantId: "tenant-1",
          environment: "production",
          connectionId: "connection-1",
          adapterId: "customer-control",
        },
      ],
    });
  });

  it("derives poll identity, deduplicates, and reduces out-of-order records", async () => {
    const scopedCredential = credential(["metadata.poll"]);
    const attemptTwo = metadataInput({
      attempt: 2,
      sequence: 4,
      status: "attempting",
    });
    const oldAttempt = metadataInput({
      attempt: 1,
      sequence: 99,
      status: "delivered",
    });
    const adapter = new GenericHttpAdapter(
      baseConfig(
        { "metadata.poll": { method: "GET", path: "metadata" } },
        async () => ({
          status: 200,
          body: JSON.stringify({
            records: [attemptTwo, attemptTwo, oldAttempt],
            cursor: "next",
            hasMore: true,
          }),
        }),
      ),
    );
    const command: MetadataPollCommand = {
      kind: "metadata.poll",
      context: context("metadata-poll", scopedCredential),
      input: { cursor: "start", limit: 50 },
    };
    const result = await adapter.execute(command);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("Expected metadata poll success.");
    }
    expect(result.value.records).toHaveLength(2);
    expect(result.value.records[0]).toMatchObject({
      tenantId: "tenant-1",
      environment: "production",
      connectionId: "connection-1",
      adapterId: "customer-control",
    });
    expect(result.value.reductions[0]?.current).toMatchObject({
      attempt: 2,
      sequence: 4,
    });
  });

  it("rejects caller identity and unrestricted metadata response content", async () => {
    const scopedCredential = credential(["metadata.poll"]);
    for (const record of [
      { ...metadataInput(), tenantId: "forged" },
      {
        ...metadataInput(),
        eventVersion: {
          ...metadataInput().eventVersion,
          responseBody: "forbidden",
        },
      },
    ]) {
      const adapter = new GenericHttpAdapter(
        baseConfig(
          { "metadata.poll": { method: "GET", path: "metadata" } },
          async () => ({
            status: 200,
            body: JSON.stringify({ records: [record] }),
          }),
        ),
      );
      const result = await adapter.execute({
        kind: "metadata.poll",
        context: context("metadata-invalid", scopedCredential),
        input: {},
      });
      expect(result).toMatchObject({
        status: "failure",
        error: { code: "metadata.invalid_record" },
      });
    }

    const unrestricted = new GenericHttpAdapter(
      baseConfig(
        { "metadata.poll": { method: "GET", path: "metadata" } },
        async () => ({
          status: 200,
          body: JSON.stringify({ records: [], payload: "forbidden" }),
        }),
      ),
    );
    const result = await unrestricted.execute({
      kind: "metadata.poll",
      context: context("metadata-extra", scopedCredential),
      input: {},
    });
    expect(result).toMatchObject({
      status: "failure",
      error: { code: "metadata.unrestricted_response" },
    });
  });
});

describe("bounded transport", () => {
  it("bounds request and response content", async () => {
    const scopedCredential = credential(["endpoint.create"]);
    let calls = 0;
    const oversizedRequest = new GenericHttpAdapter(
      baseConfig(
        { "endpoint.create": { method: "POST", path: "endpoints" } },
        async () => {
          calls += 1;
          return { status: 201 };
        },
        {
          idempotencyStore: new InMemoryIdempotencyStore(),
          limits: { maxRequestBodyBytes: 64 },
        },
      ),
    );
    const requestResult = await oversizedRequest.execute(
      endpointCreate("large-envelope", scopedCredential),
    );
    expect(requestResult).toMatchObject({
      status: "failure",
      error: { code: "wire.body_too_large" },
    });
    expect(calls).toBe(0);

    const oversizedResponse = new GenericHttpAdapter(
      baseConfig(
        { "metadata.poll": { method: "GET", path: "metadata" } },
        async () => ({
          status: 200,
          body: JSON.stringify({ records: [], raw: "x".repeat(512) }),
        }),
        { limits: { maxResponseBodyBytes: 64 } },
      ),
    );
    const responseResult = await oversizedResponse.execute({
      kind: "metadata.poll",
      context: context("large-response", credential(["metadata.poll"])),
      input: {},
    });
    expect(responseResult).toMatchObject({
      status: "failure",
      error: { code: "wire.response_too_large" },
    });
  });

  describe("malformed Unicode rejection", () => {
    it("rejects wire values and keys while accepting supplementary-plane Unicode", () => {
      const limits = {
        maxBodyBytes: 10_000,
        maxDepth: 16,
        maxNodes: 1_000,
      };
      expect(() => fingerprintWireValue({ value: loneHigh }, limits)).toThrow(
        /unpaired/iu,
      );
      expect(() =>
        fingerprintWireValue({ [loneLow]: "value" }, limits),
      ).toThrow(/unpaired/iu);
      expect(isWellFormedUnicode("valid-😀-🛰️")).toBe(true);
      expect(() =>
        fingerprintWireValue({ "emoji-😀": "satellite-🛰️" }, limits),
      ).not.toThrow();
    });

    it("rejects malformed commands before durable replay-store access", async () => {
      const scopedCredential = credential(["endpoint.create"]);
      let lookups = 0;
      let transports = 0;
      const adapter = new GenericHttpAdapter({
        ...baseConfig(
          { "endpoint.create": { method: "POST", path: "endpoints" } },
          async () => {
            transports += 1;
            return { status: 201 };
          },
        ),
        idempotencyStore: {
          async lookup() {
            lookups += 1;
            return { status: "miss" };
          },
          async begin() {
            return { status: "acquired", leaseToken: "unused-lease" };
          },
          async complete() {},
          async release() {},
        },
      });
      const result = await adapter.execute({
        ...endpointCreate("malformed-command", scopedCredential),
        input: {
          endpoint: {
            id: "endpoint-1",
            url: "https://receiver.example/webhooks",
            description: loneHigh,
          },
        },
      });
      expect(result).toMatchObject({
        status: "failure",
        error: { code: "invalid_command" },
      });
      expect(lookups).toBe(0);
      expect(transports).toBe(0);
    });

    it("rejects malformed acknowledgements before signing or replay consumption", async () => {
      const responseKey = responseCredential();
      const binding = {
        adapterId: "customer-control",
        operation: "endpoint.create" as const,
        connectionId: "connection-1",
        tenantId: "tenant-1",
        environment: "production",
        requestNonce: "request-unicode",
        idempotencyKey: "unicode-ack",
        commandFingerprint: "a".repeat(64),
        mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
        expectedResourceId: "endpoint-1",
      };
      expect(() =>
        createAuthenticatedProviderAcknowledgement(
          {
            operation: binding.operation,
            connectionId: binding.connectionId,
            tenantId: binding.tenantId,
            environment: binding.environment,
            requestNonce: binding.requestNonce,
            idempotencyKey: binding.idempotencyKey,
            commandFingerprint: binding.commandFingerprint,
            disposition: "completed",
            mappingVersion: binding.mappingVersion,
            result: {
              kind: "resource",
              resource: {
                type: "endpoint",
                id: loneHigh,
                state: "active",
              },
            },
          },
          responseKey,
          { issuedAt: NOW, expiresAt: NOW + 30_000 },
        ),
      ).toThrow();

      const valid = createAuthenticatedProviderAcknowledgement(
        {
          operation: binding.operation,
          connectionId: binding.connectionId,
          tenantId: binding.tenantId,
          environment: binding.environment,
          requestNonce: binding.requestNonce,
          idempotencyKey: binding.idempotencyKey,
          commandFingerprint: binding.commandFingerprint,
          disposition: "completed",
          mappingVersion: binding.mappingVersion,
          result: {
            kind: "resource",
            resource: {
              type: "endpoint",
              id: "endpoint-1",
              state: "active",
            },
          },
        },
        responseKey,
        {
          issuedAt: NOW,
          expiresAt: NOW + 30_000,
          nonce: "unicode-response",
        },
      );
      let replayAccesses = 0;
      const verification = await verifyProviderAcknowledgement(
        {
          ...valid,
          result: {
            kind: "resource",
            resource: {
              type: "endpoint",
              id: "endpoint-1",
              state: loneLow,
            },
          },
        },
        binding,
        responseKey,
        {
          async consume() {
            replayAccesses += 1;
            return true;
          },
        },
        { now: NOW },
      );
      expect(verification).toMatchObject({
        ok: false,
        code: "acknowledgement.invalid_or_unbound",
      });
      expect(replayAccesses).toBe(0);
    });
  });
});
