// SPDX-License-Identifier: Apache-2.0

import {
  createAuthenticatedMetadataIngestEnvelope,
  secretValue,
  type MetadataDeliveryAttemptInput,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";
import {
  AesGcmSecretCipher,
  DEFAULT_REFERENCE_SERVER_CONFIG,
  EXPECTED_REFERENCE_SCHEMA_VERSION,
  InMemoryPayloadStorage,
  InMemoryReferenceRepository,
  REFERENCE_SERVER_MIGRATIONS,
  buildReferenceServer,
  type PayloadMaintenanceController,
  type PayloadObjectPage,
  type ReferenceServerConfig,
} from "@webhook-portal/cli/reference-server";
import { WebhookSecret, tryVerifyWebhook } from "@webhook-portal/signing";
import { afterEach, describe, expect, it } from "vitest";

const openApps: import("fastify").FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function openApi(
  propertyType: "number" | "string" = "string",
  specificationVersion = "3.1.0",
): string {
  return JSON.stringify({
    openapi: specificationVersion,
    info: { title: "Orders", version: "1.0.0" },
    webhooks: {
      "order.created": {
        post: {
          summary: "Order created",
          "x-event-type": "order.created",
          "x-event-version": "1",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id"],
                  properties: { id: { type: propertyType } },
                },
                example: { id: propertyType === "string" ? "ord_1" : 1 },
              },
            },
          },
          responses: { "204": { description: "Accepted" } },
        },
      },
    },
  });
}

function multiVersionOpenApi(): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Orders", version: "1.0.0" },
    webhooks: Object.fromEntries(
      ["1", "2", "10"].map((version) => [
        `order-created-${version}`,
        {
          post: {
            summary: `Order created ${version}`,
            "x-event-id": "order-created",
            "x-event-type": "order.created",
            "x-event-version": version,
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["version"],
                    properties: {
                      version: { type: "string", const: version },
                    },
                  },
                  example: { version },
                },
              },
            },
            responses: { "204": { description: "Accepted" } },
          },
        },
      ]),
    ),
  });
}

interface Harness {
  app: import("fastify").FastifyInstance;
  rawInject: import("fastify").FastifyInstance["inject"];
  readonly repository: InMemoryReferenceRepository;
  readonly cipher: AesGcmSecretCipher;
  readonly payloadStorage: InMemoryPayloadStorage;
  payloadMaintenance?: PayloadMaintenanceController;
  readonly config: ReferenceServerConfig;
  now: number;
}

async function harness(
  options: {
    readonly allowLocalNetwork?: boolean;
    readonly bodyLimit?: number;
    readonly payloadRetention?: boolean;
    readonly payloadMaintenanceBatchSize?: number;
    readonly payloadStorage?: InMemoryPayloadStorage;
    readonly repository?: InMemoryReferenceRepository;
    readonly transport?: Parameters<
      typeof buildReferenceServer
    >[0]["transport"];
  } = {},
): Promise<Harness> {
  let sequence = 0;
  const repository = options.repository ?? new InMemoryReferenceRepository();
  const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 7));
  const payloadStorage = options.payloadStorage ?? new InMemoryPayloadStorage();
  const result: Harness = {
    app: undefined as unknown as import("fastify").FastifyInstance,
    rawInject:
      undefined as unknown as import("fastify").FastifyInstance["inject"],
    repository,
    cipher,
    payloadStorage,
    now: Date.parse("2026-07-16T08:00:00.000Z"),
    config: {
      ...DEFAULT_REFERENCE_SERVER_CONFIG,
      apiToken: "reference-api-token-for-tests",
      host: "127.0.0.1",
      port: 0,
      allowLocalNetwork: options.allowLocalNetwork ?? true,
      requestBodyLimitBytes: options.bodyLimit ?? 1024 * 1024,
      contractBodyLimitBytes: 4 * 1024 * 1024,
      ingestCredential: {
        id: "local-ingest",
        secret: "local-ingest-secret-for-tests",
      },
      payloadRetention: {
        enabled: options.payloadRetention ?? false,
        ttlSeconds: 3600,
      },
      payloadMaintenance: {
        ...DEFAULT_REFERENCE_SERVER_CONFIG.payloadMaintenance,
        batchSize:
          options.payloadMaintenanceBatchSize ??
          DEFAULT_REFERENCE_SERVER_CONFIG.payloadMaintenance.batchSize,
      },
    },
  };
  const built = await buildReferenceServer({
    repository,
    cipher,
    config: result.config,
    payloadStorage,
    clock: () => result.now,
    idFactory: () => `id_${++sequence}`,
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
  });
  result.app = built.app;
  if (built.payloadMaintenance !== undefined) {
    result.payloadMaintenance = built.payloadMaintenance;
  }
  const rawInject = built.app.inject.bind(
    built.app,
  ) as import("fastify").FastifyInstance["inject"];
  result.rawInject = rawInject;
  built.app.inject = ((input: unknown) => {
    const request = input as {
      readonly headers?: Readonly<Record<string, string>>;
      readonly url: string;
    };
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    const independentlyAuthenticated =
      pathname === "/health/live" ||
      pathname === "/health/ready" ||
      pathname === "/v1/ingest" ||
      pathname.startsWith("/v1/test-receiver/");
    return rawInject({
      ...(input as Record<string, unknown>),
      ...(!independentlyAuthenticated
        ? {
            headers: {
              authorization: `Bearer ${result.config.apiToken}`,
              ...request.headers,
            },
          }
        : {}),
    } as never);
  }) as import("fastify").FastifyInstance["inject"];
  openApps.push(built.app);
  return result;
}

async function importContract(
  app: import("fastify").FastifyInstance,
  source = openApi(),
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/contracts/import",
    payload: { source, mediaType: "application/json" },
  });
  return { response, body: response.json() as Record<string, unknown> };
}

async function publish(
  app: import("fastify").FastifyInstance,
  source = openApi(),
  overrideReason?: string,
) {
  const imported = await importContract(app, source);
  const importBody = imported.body["import"] as Record<string, unknown>;
  const response = await app.inject({
    method: "POST",
    url: "/v1/releases/publish",
    headers: { "idempotency-key": `publish-${String(importBody["id"])}` },
    payload: {
      importId: importBody["id"],
      ...(overrideReason === undefined ? {} : { overrideReason }),
    },
  });
  return { response, body: response.json() as Record<string, unknown> };
}

async function setupEndpoint(
  app: import("fastify").FastifyInstance,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/v1/endpoints",
    payload: {
      url: "http://127.0.0.1:3210/v1/test-receiver/pending",
      allowLocalNetwork: true,
    },
  });
  expect(created.statusCode).toBe(201);
  const endpointId = (created.json() as { endpoint: { id: string } }).endpoint
    .id;
  const updated = await app.inject({
    method: "PATCH",
    url: `/v1/endpoints/${endpointId}`,
    payload: {
      url: `http://127.0.0.1:3210/v1/test-receiver/${endpointId}`,
      allowLocalNetwork: true,
    },
  });
  expect(updated.statusCode).toBe(200);
  const subscription = await app.inject({
    method: "PUT",
    url: `/v1/endpoints/${endpointId}/subscriptions`,
    payload: { eventTypes: ["order.created"] },
  });
  expect(subscription.statusCode).toBe(200);
  return endpointId;
}

function metadataCredential(config: ReferenceServerConfig): ScopedCredential {
  return {
    id: config.ingestCredential.id,
    kind: "bearer",
    role: "metadata_ingest",
    scope: {
      adapterId: config.metadataIdentity.adapterId,
      connectionId: config.metadataIdentity.connectionId,
      environments: [config.metadataIdentity.environment],
      operations: ["metadata.ingest"],
      tenantId: config.metadataIdentity.tenantId,
    },
    secret: secretValue(config.ingestCredential.secret),
  };
}

function ingestHeaders(envelope: {
  readonly credentialId: string;
  readonly signature: { readonly value: string };
}) {
  return {
    authorization: `Webhook-Ingest ${envelope.signature.value}`,
    "x-webhook-ingest-credential": envelope.credentialId,
  };
}

function metadataRecord(
  status: MetadataDeliveryAttemptInput["status"],
  sequence: number,
  occurredAt: string,
): MetadataDeliveryAttemptInput {
  return {
    attempt: 1,
    deliveryId: "delivery_1",
    endpointId: "endpoint_external",
    eventId: "event_1",
    eventVersion: {
      eventType: "order.created",
      schemaChecksum:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      version: "1",
    },
    kind: "delivery_attempt",
    mappingVersion: {
      name: "webhook-portal.canonical",
      version: "1.0.0",
      schemaVersion: "2026-07-01",
    },
    occurredAt,
    providerAttemptId: `provider_${sequence}`,
    schemaVersion: "2026-07-01",
    sequence,
    status,
  };
}

class StaleReferenceRepository extends InMemoryReferenceRepository {
  override async readiness() {
    return {
      ready: false,
      expectedSchemaVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
      appliedSchemaVersions: ["001_initial"],
      currentSchemaVersion: "001_initial",
      missingSchemaVersions: REFERENCE_SERVER_MIGRATIONS.slice(1).map(
        (migration) => migration.version,
      ),
      unexpectedSchemaVersions: [],
      checksumMismatches: [],
    };
  }
}

class FutureReferenceRepository extends InMemoryReferenceRepository {
  override async readiness() {
    return {
      ...(await super.readiness()),
      ready: false,
      unexpectedSchemaVersions: ["999_future"],
    };
  }
}

class ChecksumMismatchReferenceRepository extends InMemoryReferenceRepository {
  override async readiness() {
    return {
      ...(await super.readiness()),
      ready: false,
      checksumMismatches: [
        {
          version: EXPECTED_REFERENCE_SCHEMA_VERSION,
          expectedChecksum: "a".repeat(64),
          actualChecksum: "b".repeat(64),
        },
      ],
    };
  }
}

class UncertainPublishRepository extends InMemoryReferenceRepository {
  #statusFailures: number;

  constructor(statusFailures = 2) {
    let loseCommitAcknowledgement = true;
    super({
      faultInjector: (operation) => {
        if (
          operation === "transactionCommitResponse" &&
          loseCommitAcknowledgement
        ) {
          loseCommitAcknowledgement = false;
          throw new Error("simulated lost commit acknowledgement");
        }
      },
    });
    this.#statusFailures = statusFailures;
  }

  override async getPublishStatus(idempotencyKey: string) {
    if (this.#statusFailures > 0) {
      this.#statusFailures -= 1;
      throw new Error("simulated status outage");
    }
    return super.getPublishStatus(idempotencyKey);
  }

  override async recoverPublishStatus(idempotencyKey: string) {
    if (this.#statusFailures > 0) {
      this.#statusFailures -= 1;
      throw new Error("simulated recovery outage");
    }
    return super.recoverPublishStatus(idempotencyKey);
  }
}

class FailingDeletePayloadStorage extends InMemoryPayloadStorage {
  failDeletes = true;

  override async delete(objectKey: string): Promise<void> {
    if (this.failDeletes) {
      throw new Error("object storage unavailable");
    }
    await super.delete(objectKey);
  }
}

class FailingMaintenancePayloadStorage extends InMemoryPayloadStorage {
  override async listObjects(): Promise<never> {
    const error = new Error("sensitive object storage failure") as Error & {
      code: string;
    };
    error.code = "OBJECT_STORE_UNAVAILABLE";
    throw error;
  }
}

class RecoveringMaintenancePayloadStorage extends InMemoryPayloadStorage {
  #failNextList = true;

  override async listObjects(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadObjectPage> {
    if (this.#failNextList) {
      this.#failNextList = false;
      const error = new Error("transient object listing failure") as Error & {
        code: string;
      };
      error.code = "TRANSIENT_LIST_FAILURE";
      throw error;
    }
    return super.listObjects(prefix, limit, cursor);
  }
}

describe("reference server", () => {
  it("preserves invalid and partial import status without replacing the active release", async () => {
    const test = await harness();
    const baseline = await publish(test.app);
    expect(baseline.response.statusCode).toBe(201);
    const baselineId = (baseline.body["release"] as Record<string, unknown>)[
      "id"
    ];

    const invalid = await importContract(test.app, '{"openapi":');
    const partial = await importContract(test.app, openApi("string", "3.0.3"));
    const releases = await test.app.inject({
      method: "GET",
      url: "/v1/releases",
    });

    expect(invalid.response.statusCode).toBe(422);
    expect((invalid.body["import"] as Record<string, unknown>)["status"]).toBe(
      "invalid",
    );
    expect(partial.response.statusCode).toBe(422);
    expect((partial.body["import"] as Record<string, unknown>)["status"]).toBe(
      "partial",
    );
    const releaseList = releases.json() as {
      releases: readonly { id: string; status: string }[];
    };
    expect(releaseList.releases).toHaveLength(1);
    expect(releaseList.releases[0]).toMatchObject({
      id: baselineId,
      status: "active",
    });
    expect(JSON.stringify(releaseList)).not.toContain("canonicalExport");
  });

  it("paginates compact release metadata and reserves full content for detail", async () => {
    const test = await harness();
    const first = await publish(test.app);
    const firstId = (first.body["release"] as { id: string }).id;
    const second = await publish(
      test.app,
      multiVersionOpenApi(),
      "Approved for pagination coverage.",
    );
    const secondId = (second.body["release"] as { id: string }).id;

    const firstPage = await test.app.inject({
      method: "GET",
      url: "/v1/releases?limit=1",
    });
    const firstPageBody = firstPage.json() as {
      nextBeforeSequence: number;
      releases: readonly Record<string, unknown>[];
    };
    expect(firstPageBody.releases).toHaveLength(1);
    expect(firstPageBody.releases[0]).toMatchObject({
      id: secondId,
      status: "active",
      eventSummary: { eventTypeCount: 1, eventVersionCount: 3 },
    });
    expect(JSON.stringify(firstPageBody)).not.toContain("canonicalExport");
    expect(JSON.stringify(firstPageBody)).not.toContain('"contract"');

    const secondPage = await test.app.inject({
      method: "GET",
      url: `/v1/releases?limit=1&beforeSequence=${firstPageBody.nextBeforeSequence}`,
    });
    expect(secondPage.json()).toMatchObject({
      releases: [{ id: firstId, status: "superseded" }],
    });

    const detail = await test.app.inject({
      method: "GET",
      url: `/v1/releases/${firstId}`,
    });
    expect(detail.json()).toMatchObject({
      release: {
        id: firstId,
        contract: { eventTypes: expect.any(Array) },
        canonicalExport: { original: { kind: "text" } },
      },
    });
  });

  it("blocks incompatible publication unless an audited reason is supplied", async () => {
    const test = await harness();
    expect((await publish(test.app)).response.statusCode).toBe(201);

    const imported = await importContract(test.app, openApi("number"));
    const importId = (imported.body["import"] as Record<string, unknown>)["id"];
    const blocked = await test.app.inject({
      method: "POST",
      url: "/v1/releases/publish",
      headers: { "idempotency-key": "publish-incompatible-blocked" },
      payload: { importId },
    });
    const overridden = await test.app.inject({
      method: "POST",
      url: "/v1/releases/publish",
      headers: { "idempotency-key": "publish-incompatible-overridden" },
      payload: {
        importId,
        overrideReason: "Consumer migration approved for the local demo.",
      },
    });

    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "PUBLISH_INCOMPATIBLE" },
    });
    expect(overridden.statusCode).toBe(201);
    const audit = await test.app.inject({ method: "GET", url: "/v1/audit" });
    expect(JSON.stringify(audit.json())).toContain("release.publish");
    expect(JSON.stringify(audit.json())).not.toContain("oneTimeSecret");
  });

  it("deduplicates metadata and applies monotonic out-of-order reduction", async () => {
    const test = await harness();
    const credential = metadataCredential(test.config);
    const delivered = createAuthenticatedMetadataIngestEnvelope(
      [metadataRecord("delivered", 2, "2026-07-16T08:00:02.000Z")],
      test.config.metadataIdentity,
      "batch_delivered",
      credential,
      { issuedAt: test.now },
    );
    const startedLate = createAuthenticatedMetadataIngestEnvelope(
      [metadataRecord("attempting", 1, "2026-07-16T08:00:01.000Z")],
      test.config.metadataIdentity,
      "batch_late",
      credential,
      { issuedAt: test.now },
    );

    const accepted = await test.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: ingestHeaders(delivered),
      payload: delivered,
    });
    expect(accepted.statusCode).toBe(202);
    const duplicate = await test.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: ingestHeaders(delivered),
      payload: delivered,
    });
    const late = await test.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: ingestHeaders(startedLate),
      payload: startedLate,
    });
    const timeline = await test.app.inject({
      method: "GET",
      url: "/v1/timeline",
    });

    expect(duplicate.json()).toMatchObject({
      summary: { accepted: 0, duplicates: 1 },
    });
    expect(late.json()).toMatchObject({
      summary: { accepted: 1, late: 1 },
    });
    expect(timeline.json()).toMatchObject({
      items: [
        {
          current: { status: "delivered", sequence: 2 },
          observationCount: 2,
          lateObservationCount: 1,
          payloadRetained: false,
        },
      ],
    });
  });

  it("rejects invalid metadata signatures and forbidden body fields", async () => {
    const test = await harness();
    const credential = metadataCredential(test.config);
    const envelope = createAuthenticatedMetadataIngestEnvelope(
      [metadataRecord("delivered", 1, "2026-07-16T08:00:00.000Z")],
      test.config.metadataIdentity,
      "batch_invalid_signature",
      credential,
      { issuedAt: test.now },
    );
    const invalidSignature = {
      ...envelope,
      signature: { ...envelope.signature, value: "A".repeat(43) },
    };
    const signatureResponse = await test.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: ingestHeaders(invalidSignature),
      payload: invalidSignature,
    });
    const forbiddenRecord = {
      ...metadataRecord("delivered", 1, "2026-07-16T08:00:00.000Z"),
      body: { secret: "must-not-store" },
    };
    expect(() =>
      createAuthenticatedMetadataIngestEnvelope(
        [forbiddenRecord as MetadataDeliveryAttemptInput],
        test.config.metadataIdentity,
        "batch_forbidden",
        credential,
        { issuedAt: test.now },
      ),
    ).toThrow();

    expect(signatureResponse.statusCode).toBe(401);
    expect(signatureResponse.json()).toMatchObject({
      error: { code: "INVALID_METADATA_SIGNATURE" },
    });
    expect(
      JSON.stringify(await test.repository.listTimeline({ limit: 20 })),
    ).not.toContain("must-not-store");
  });

  it("signs the exact raw test body, reveals secrets once, and replays idempotently", async () => {
    let transportCalls = 0;
    let revealedSecret = "";
    let exactBody = "";
    const test = await harness({
      transport: async (request) => {
        transportCalls += 1;
        exactBody = Buffer.from(request.body ?? []).toString("utf8");
        const verified = tryVerifyWebhook({
          body: request.body ?? new Uint8Array(),
          headers: request.headers,
          secrets: WebhookSecret.fromEncoded(revealedSecret),
          clock: () => test.now,
        });
        expect(verified.ok).toBe(true);
        return { status: 204 };
      },
    });
    expect((await publish(test.app)).response.statusCode).toBe(201);
    const endpointId = await setupEndpoint(test.app);
    const createdSecret = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/secrets`,
      payload: {},
    });
    revealedSecret = (createdSecret.json() as { oneTimeSecret: string })
      .oneTimeSecret;
    const listed = await test.app.inject({
      method: "GET",
      url: `/v1/endpoints/${endpointId}/secrets`,
    });
    expect(JSON.stringify(listed.json())).not.toContain(revealedSecret);
    expect(JSON.stringify(listed.json())).not.toContain("encryptedValue");

    const first = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/send-test`,
      headers: { "idempotency-key": "test-command-0001" },
      payload: { eventType: "order.created" },
    });
    const repeated = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/send-test`,
      headers: { "idempotency-key": "test-command-0001" },
      payload: { eventType: "order.created" },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      command: {
        state: "acknowledged",
        result: { delivered: true, statusCode: 204 },
      },
    });
    expect(repeated.json()).toEqual(first.json());
    expect(transportCalls).toBe(1);
    expect(exactBody).toBe('{"id":"ord_1"}');
  });

  it("reports timeout as unknown without retrying", async () => {
    let transportCalls = 0;
    const test = await harness({
      transport: async () => {
        transportCalls += 1;
        throw new Error("timeout after dispatch");
      },
    });
    await publish(test.app);
    const endpointId = await setupEndpoint(test.app);
    await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/secrets`,
      payload: {},
    });

    const first = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/send-test`,
      headers: { "idempotency-key": "unknown-command-0001" },
      payload: { eventType: "order.created" },
    });
    const replay = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/send-test`,
      headers: { "idempotency-key": "unknown-command-0001" },
      payload: { eventType: "order.created" },
    });

    expect(first.json()).toMatchObject({
      command: {
        state: "unknown",
        evidence: { status: "unknown", state: "complete" },
        result: { errorCategory: "network" },
      },
    });
    expect(replay.json()).toEqual(first.json());
    expect(transportCalls).toBe(1);
  });

  it("reports requested and pending test evidence without dispatching on status lookup", async () => {
    let transportCalls = 0;
    const test = await harness({
      transport: async () => {
        transportCalls += 1;
        return { status: 204 };
      },
    });
    const context = {
      endpointUrl: "https://example.com/hook",
      allowLocalNetwork: false,
      releaseId: "release_immutable",
      schemaChecksum:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      eventVersion: "1",
      bodySha256:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      messageId: "message_1",
    };
    await test.repository.beginTestCommand({
      id: "command_requested",
      endpointId: "endpoint_status",
      eventType: "order.created",
      idempotencyKey: "status-requested-0001",
      requestFingerprint: "fingerprint-requested",
      context,
      timestamp: "2026-07-16T08:00:00.000Z",
    });
    await test.repository.beginTestCommand({
      id: "command_pending",
      endpointId: "endpoint_status",
      eventType: "order.created",
      idempotencyKey: "status-pending-0001",
      requestFingerprint: "fingerprint-pending",
      context,
      timestamp: "2026-07-16T08:00:00.000Z",
    });
    await test.repository.markTestCommandDispatched(
      "command_pending",
      "2026-07-16T08:00:01.000Z",
    );

    const requested = await test.app.inject({
      method: "GET",
      url: "/v1/endpoints/endpoint_status/send-test/status",
      headers: { "idempotency-key": "status-requested-0001" },
    });
    const pending = await test.app.inject({
      method: "GET",
      url: "/v1/endpoints/endpoint_status/send-test/status",
      headers: { "idempotency-key": "status-pending-0001" },
    });

    expect(requested.json()).toMatchObject({
      command: {
        state: "requested",
        evidence: { status: "requested", state: "pending" },
      },
    });
    expect(pending.json()).toMatchObject({
      command: {
        state: "dispatched",
        evidence: { status: "pending", state: "pending" },
      },
    });
    expect(transportCalls).toBe(0);
  });

  it("blocks tests after revoked or expired secret versions", async () => {
    const test = await harness({
      transport: async () => ({ status: 204 }),
    });
    await publish(test.app);
    const endpointId = await setupEndpoint(test.app);
    const initial = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/secrets`,
      payload: {},
    });
    const initialId = (initial.json() as { secret: { id: string } }).secret.id;
    const rotated = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/secrets/rotate`,
      payload: { overlapSeconds: 3600 },
    });
    const replacementId = (rotated.json() as { secret: { id: string } }).secret
      .id;
    await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/secrets/${replacementId}/revoke`,
      payload: {},
    });
    test.now += 2 * 60 * 60 * 1000;
    const secrets = await test.app.inject({
      method: "GET",
      url: `/v1/endpoints/${endpointId}/secrets`,
    });
    const blocked = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/send-test`,
      headers: { "idempotency-key": "blocked-command-0001" },
      payload: { eventType: "order.created" },
    });

    expect(secrets.json()).toMatchObject({
      secrets: expect.arrayContaining([
        expect.objectContaining({ id: initialId, state: "expired" }),
        expect.objectContaining({ id: replacementId, state: "revoked" }),
      ]),
    });
    expect(blocked.json()).toMatchObject({
      command: {
        state: "rejected_before_dispatch",
        result: { errorCategory: "secret_unavailable" },
      },
    });
  });

  it("enforces local-network opt-in and the server-level SSRF policy", async () => {
    const disabled = await harness({ allowLocalNetwork: false });
    const implicit = await disabled.app.inject({
      method: "POST",
      url: "/v1/endpoints",
      payload: { url: "http://127.0.0.1:3210/hook" },
    });
    const explicit = await disabled.app.inject({
      method: "POST",
      url: "/v1/endpoints",
      payload: {
        url: "http://127.0.0.1:3210/hook",
        allowLocalNetwork: true,
      },
    });

    expect(implicit.statusCode).toBe(422);
    expect(explicit.statusCode).toBe(403);
    expect(explicit.json()).toMatchObject({
      error: { code: "LOCAL_NETWORK_DISABLED" },
    });

    const enabled = await harness({ allowLocalNetwork: true });
    const metadataService = await enabled.app.inject({
      method: "POST",
      url: "/v1/endpoints",
      payload: {
        url: "http://169.254.169.254/latest/meta-data",
        allowLocalNetwork: true,
      },
    });
    const embeddedCredentials = await enabled.app.inject({
      method: "POST",
      url: "/v1/endpoints",
      payload: {
        url: "https://user:password@example.com/hook",
        allowLocalNetwork: true,
      },
    });
    expect(metadataService.statusCode).toBe(422);
    expect(embeddedCredentials.statusCode).toBe(422);
  });

  it("enforces request body limits with explicit errors", async () => {
    const test = await harness({ bodyLimit: 256 });
    const response = await test.app.inject({
      method: "POST",
      url: "/v1/endpoints",
      headers: { "content-type": "application/json" },
      payload: {
        url: "https://example.com/hook",
        description: "x".repeat(1024),
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: "BODY_TOO_LARGE" },
    });

    const malformed = await test.app.inject({
      method: "POST",
      url: "/v1/endpoints",
      headers: { "content-type": "application/json" },
      payload: '{"url":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("retains test payloads only in explicit object storage and exposes no bytes in timeline", async () => {
    const test = await harness({
      payloadRetention: true,
      transport: async () => ({ status: 204 }),
    });
    await publish(test.app);
    const endpointId = await setupEndpoint(test.app);
    await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/secrets`,
      payload: {},
    });
    await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/send-test`,
      headers: { "idempotency-key": "retained-command-0001" },
      payload: { eventType: "order.created" },
    });
    const timeline = await test.app.inject({
      method: "GET",
      url: "/v1/timeline",
    });

    expect(test.payloadStorage.size).toBe(1);
    expect(timeline.json()).toMatchObject({
      items: [{ payloadRetained: true }],
    });
    expect(JSON.stringify(timeline.json())).not.toContain('{"id":"ord_1"}');
  });

  it("requires bearer authentication on loopback control and documentation routes", async () => {
    const test = await harness();
    const unauthorized = await test.rawInject({
      method: "GET",
      url: "/v1/endpoints",
    });
    const openApi = await test.rawInject({
      method: "GET",
      url: "/openapi.json",
    });
    const health = await test.rawInject({
      method: "GET",
      url: "/health/live",
    });
    const authorized = await test.app.inject({
      method: "GET",
      url: "/v1/endpoints",
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(openApi.statusCode).toBe(401);
    expect(health.statusCode).toBe(200);
    expect(authorized.statusCode).toBe(200);
  });

  it("reports stale migration readiness with safe expected/current versions", async () => {
    const test = await harness({
      repository: new StaleReferenceRepository(),
    });
    const response = await test.rawInject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      reason: "migration_state",
      schema: {
        expectedVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
        currentVersion: "001_initial",
        missingVersions: REFERENCE_SERVER_MIGRATIONS.slice(1).map(
          (migration) => migration.version,
        ),
        unexpectedVersions: [],
        checksumMismatchVersions: [],
      },
    });
  });

  it.each([
    [
      "future",
      new FutureReferenceRepository(),
      {
        missingVersions: [],
        unexpectedVersions: ["999_future"],
        checksumMismatchVersions: [],
      },
    ],
    [
      "checksum-mismatched",
      new ChecksumMismatchReferenceRepository(),
      {
        missingVersions: [],
        unexpectedVersions: [],
        checksumMismatchVersions: [EXPECTED_REFERENCE_SCHEMA_VERSION],
      },
    ],
  ])(
    "reports %s migration readiness without exposing checksums",
    async (_name, repository, expected) => {
      const test = await harness({ repository });
      const response = await test.rawInject({
        method: "GET",
        url: "/health/ready",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "not_ready",
        reason: "migration_state",
        schema: {
          expectedVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
          currentVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
          ...expected,
        },
      });
      expect(response.body).not.toContain("aaaaaaaa");
      expect(response.body).not.toContain("bbbbbbbb");
    },
  );

  it("runs safe payload reconciliation with capture disabled and exposes health metrics", async () => {
    const repository = new InMemoryReferenceRepository();
    const payloadStorage = new InMemoryPayloadStorage();
    await repository.initializePayloadStorageNamespace(
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageNamespaceId,
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageStoreId,
      "2026-07-16T07:00:00.000Z",
    );
    await payloadStorage.initializeIdentity(
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageNamespaceId,
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageStoreId,
    );
    await repository.markPayloadStorageNamespaceReady(
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageNamespaceId,
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageStoreId,
      "2026-07-16T07:00:00.000Z",
    );
    await repository.createPayloadUploadIntent({
      id: "startup-orphan-intent",
      uploadAttemptId: "startup-orphan-intent",
      uploadGeneration: "generation-startup-orphan-intent",
      objectKey: "payloads/local/startup-orphan",
      contentType: "application/json",
      size: 2,
      createdAt: "2026-07-16T07:00:00.000Z",
      expiresAt: "2026-07-17T07:00:00.000Z",
    });
    await payloadStorage.put({
      objectKey: "payloads/local/startup-orphan",
      bytes: Buffer.from("{}", "utf8"),
      contentType: "application/json",
      createdAt: "2026-07-16T07:00:00.000Z",
      expiresAt: "2026-07-17T07:00:00.000Z",
    });

    const test = await harness({
      repository,
      payloadStorage,
      payloadRetention: false,
    });
    expect(payloadStorage.size).toBe(0);
    expect(
      await repository.getPayloadUploadIntent("startup-orphan-intent"),
    ).toBeUndefined();

    const health = await test.rawInject({
      method: "GET",
      url: "/health/maintenance",
    });
    const readiness = await test.rawInject({
      method: "GET",
      url: "/health/ready",
    });
    const metrics = await test.rawInject({
      method: "GET",
      url: "/metrics",
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ready",
      maintenance: {
        captureEnabled: false,
        enabled: true,
        ready: true,
        lastRun: {
          orphanObjectsDeleted: 1,
          uploadIntentsCleared: 1,
        },
      },
    });
    expect(readiness.statusCode).toBe(200);
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("webhook_portal_payload_capture_enabled 0");
    expect(metrics.body).toContain(
      "webhook_portal_payload_maintenance_enabled 1",
    );
  });

  it("preserves the metadata-only default without object storage", async () => {
    const repository = new InMemoryReferenceRepository();
    const config: ReferenceServerConfig = {
      ...DEFAULT_REFERENCE_SERVER_CONFIG,
      apiToken: "metadata-only-api-token",
      host: "127.0.0.1",
      port: 0,
      ingestCredential: {
        id: "metadata-only-ingest",
        secret: "metadata-only-ingest-secret",
      },
    };
    const built = await buildReferenceServer({
      repository,
      cipher: new AesGcmSecretCipher(Buffer.alloc(32, 9)),
      config,
    });
    openApps.push(built.app);

    const readiness = await built.app.inject({
      method: "GET",
      url: "/health/ready",
    });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
      status: "ready",
      payloadMaintenance: {
        captureEnabled: false,
        enabled: false,
        ready: true,
        state: "disabled",
      },
    });
  });

  it("requires cleanup storage when durable payload state already exists", async () => {
    const repository = new InMemoryReferenceRepository();
    await repository.initializePayloadStorageNamespace(
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageNamespaceId,
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageStoreId,
      "2026-07-16T07:00:00.000Z",
    );
    await repository.createPayloadUploadIntent({
      id: "disabled-cleanup-intent",
      uploadAttemptId: "disabled-cleanup-intent",
      uploadGeneration: "generation-disabled-cleanup-intent",
      objectKey: "payloads/local/disabled-cleanup",
      contentType: "application/json",
      size: 2,
      createdAt: "2026-07-16T07:00:00.000Z",
      expiresAt: "2026-07-17T07:00:00.000Z",
    });
    const config: ReferenceServerConfig = {
      ...DEFAULT_REFERENCE_SERVER_CONFIG,
      apiToken: "cleanup-required-api-token",
      host: "127.0.0.1",
      port: 0,
      ingestCredential: {
        id: "cleanup-required-ingest",
        secret: "cleanup-required-ingest-secret",
      },
    };
    const built = await buildReferenceServer({
      repository,
      cipher: new AesGcmSecretCipher(Buffer.alloc(32, 9)),
      config,
    });
    openApps.push(built.app);

    const readiness = await built.app.inject({
      method: "GET",
      url: "/health/ready",
    });
    const maintenance = await built.app.inject({
      method: "GET",
      url: "/health/maintenance",
    });

    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      status: "not_ready",
      reason: "payload_storage_required",
      payloadMaintenance: {
        captureEnabled: false,
        enabled: false,
        ready: false,
        state: "degraded",
      },
    });
    expect(maintenance.statusCode).toBe(503);
  });

  it("surfaces payload maintenance failures through readiness and safe metrics", async () => {
    const test = await harness({
      payloadRetention: false,
      payloadStorage: new FailingMaintenancePayloadStorage(),
    });
    const readiness = await test.rawInject({
      method: "GET",
      url: "/health/ready",
    });
    const maintenance = await test.rawInject({
      method: "GET",
      url: "/health/maintenance",
    });
    const metrics = await test.rawInject({
      method: "GET",
      url: "/metrics",
    });

    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      status: "not_ready",
      reason: "payload_maintenance",
      payloadMaintenance: {
        state: "degraded",
        lastFailure: { count: 1 },
      },
    });
    expect(maintenance.statusCode).toBe(503);
    expect(metrics.body).toContain(
      "webhook_portal_payload_maintenance_degraded 1",
    );
    expect(readiness.body).not.toContain("sensitive object storage failure");
  });

  it("reports unsupported bucket versioning without running reconciliation", async () => {
    const payloadStorage = new InMemoryPayloadStorage();
    payloadStorage.setVersioning("enabled");
    const test = await harness({
      payloadRetention: false,
      payloadStorage,
    });

    const readiness = await test.rawInject({
      method: "GET",
      url: "/health/ready",
    });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      status: "not_ready",
      reason: "payload_storage_unavailable",
      payloadMaintenance: {
        state: "degraded",
        lastFailure: {
          errorCode: "PAYLOAD_STORAGE_VERSIONING_UNSUPPORTED",
        },
      },
    });
  });

  it("recovers readiness after independent object and reference pages complete a clean cycle", async () => {
    const repository = new InMemoryReferenceRepository();
    const payloadStorage = new RecoveringMaintenancePayloadStorage();
    await repository.initializePayloadStorageNamespace(
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageNamespaceId,
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageStoreId,
      "2026-07-16T07:00:00.000Z",
    );
    await payloadStorage.initializeIdentity(
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageNamespaceId,
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageStoreId,
    );
    await repository.markPayloadStorageNamespaceReady(
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageNamespaceId,
      DEFAULT_REFERENCE_SERVER_CONFIG.payloadStorageStoreId,
      "2026-07-16T07:00:00.000Z",
    );
    for (const suffix of ["a", "b"]) {
      const objectKey = `payloads/local/readiness-${suffix}`;
      await payloadStorage.put({
        objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: "application/json",
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
      await repository.createPayloadUploadIntent({
        id: `readiness-ref-${suffix}`,
        uploadAttemptId: `readiness-ref-${suffix}`,
        uploadGeneration: `readiness-generation-${suffix}`,
        objectKey,
        contentType: "application/json",
        size: 2,
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
      await repository.createPayloadReference({
        id: `readiness-ref-${suffix}`,
        uploadAttemptId: `readiness-ref-${suffix}`,
        uploadGeneration: `readiness-generation-${suffix}`,
        objectKey,
        contentType: "application/json",
        size: 2,
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
    }
    const test = await harness({
      payloadMaintenanceBatchSize: 1,
      payloadRetention: false,
      payloadStorage,
      repository,
    });
    const maintenance = test.payloadMaintenance;
    if (maintenance === undefined) {
      throw new Error("Expected payload maintenance to be enabled.");
    }

    await expect(
      test.rawInject({ method: "GET", url: "/health/ready" }),
    ).resolves.toMatchObject({ statusCode: 503 });

    await maintenance.runNow();
    await maintenance.runNow();
    expect(maintenance.status()).toMatchObject({ degraded: true });
    await expect(
      test.rawInject({ method: "GET", url: "/health/ready" }),
    ).resolves.toMatchObject({ statusCode: 503 });

    await maintenance.runNow();
    await maintenance.runNow();
    expect(maintenance.status()).toMatchObject({
      degraded: false,
      lastReport: { cycleCompleted: true },
    });
    const recovered = await test.rawInject({
      method: "GET",
      url: "/health/ready",
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      status: "ready",
      payloadMaintenance: {
        ready: true,
        state: "ready",
        paginationPending: false,
      },
    });
  });

  it("exposes publish idempotency status without creating another release", async () => {
    const test = await harness();
    const imported = await importContract(test.app);
    const importId = (imported.body["import"] as Record<string, unknown>)["id"];
    const key = "publish-status-command-0001";
    const first = await test.app.inject({
      method: "POST",
      url: "/v1/releases/publish",
      headers: { "idempotency-key": key },
      payload: { importId },
    });
    const status = await test.app.inject({
      method: "GET",
      url: "/v1/releases/publish/status",
      headers: { "idempotency-key": key },
    });
    const repeated = await test.app.inject({
      method: "POST",
      url: "/v1/releases/publish",
      headers: { "idempotency-key": key },
      payload: { importId },
    });

    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { release: { id: string } };
    expect(firstBody).toMatchObject({
      status: "completed",
      idempotencyKey: key,
      release: {
        checksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
        status: "active",
        createdAt: expect.any(String),
        eventSummary: { eventTypeCount: 1, eventVersionCount: 1 },
      },
    });
    expect(JSON.stringify(firstBody)).not.toContain("canonicalExport");
    expect(JSON.stringify(firstBody)).not.toContain('"contract"');
    expect(JSON.stringify(firstBody)).not.toContain('"original"');
    expect(status.json()).toMatchObject({
      command: { state: "completed", importId },
      release: {
        id: firstBody.release.id,
      },
    });
    expect(JSON.stringify(status.json())).not.toContain("canonicalExport");
    expect(JSON.stringify(status.json())).not.toContain('"contract"');
    expect(JSON.stringify(status.json())).not.toContain('"original"');
    expect(repeated.statusCode).toBe(200);
    expect(await test.repository.listReleases()).toHaveLength(1);
  });

  it("returns recoverable HTTP publish uncertainty and later reconciles by key", async () => {
    const test = await harness({
      repository: new UncertainPublishRepository(),
    });
    const imported = await importContract(test.app);
    const importId = (imported.body["import"] as Record<string, unknown>)["id"];
    const key = "publish-http-lost-ack-0001";
    const uncertain = await test.app.inject({
      method: "POST",
      url: "/v1/releases/publish",
      headers: { "idempotency-key": key },
      payload: { importId },
    });
    expect(uncertain.statusCode).toBe(202);
    expect(uncertain.json()).toEqual({
      status: "unknown",
      idempotencyKey: key,
    });

    const status = await test.app.inject({
      method: "GET",
      url: "/v1/releases/publish/status",
      headers: { "idempotency-key": key },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: "completed",
      idempotencyKey: key,
      command: {
        importId,
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        state: "completed",
      },
      release: { importId },
    });

    const repeatedImport = await importContract(test.app);
    const repeatedImportId = (
      repeatedImport.body["import"] as Record<string, unknown>
    )["id"];
    const replay = await test.app.inject({
      method: "POST",
      url: "/v1/releases/publish",
      headers: { "idempotency-key": key },
      payload: { importId: repeatedImportId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      release: {
        id: (status.json() as { release: { id: string } }).release.id,
      },
    });

    const different = await importContract(test.app, openApi("number"));
    const conflict = await test.app.inject({
      method: "POST",
      url: "/v1/releases/publish",
      headers: { "idempotency-key": key },
      payload: {
        importId: (different.body["import"] as Record<string, unknown>)["id"],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
    expect(await test.repository.listReleases()).toHaveLength(1);
  });

  it("returns compact completed metadata when route reconciliation observes the commit", async () => {
    const test = await harness({
      repository: new UncertainPublishRepository(1),
    });
    const imported = await importContract(test.app);
    const importId = (imported.body["import"] as Record<string, unknown>)["id"];
    const key = "publish-http-route-reconciled-0001";
    const response = await test.app.inject({
      method: "POST",
      url: "/v1/releases/publish",
      headers: { "idempotency-key": key },
      payload: { importId },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "completed",
      idempotencyKey: key,
      command: { importId, state: "completed" },
      release: {
        importId,
        status: "active",
        eventSummary: { eventTypeCount: 1 },
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("canonicalExport");
    expect(JSON.stringify(response.json())).not.toContain('"original"');
  });

  it("exposes deletion cleanup failure and idempotent retry without resurrection", async () => {
    const payloadStorage = new FailingDeletePayloadStorage();
    const test = await harness({
      payloadRetention: true,
      payloadStorage,
      transport: async () => ({ status: 204 }),
    });
    await publish(test.app);
    const endpointId = await setupEndpoint(test.app);
    await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/secrets`,
      payload: {},
    });
    await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/send-test`,
      headers: { "idempotency-key": "delete-cleanup-test-0001" },
      payload: { eventType: "order.created" },
    });

    const deleted = await test.app.inject({
      method: "DELETE",
      url: `/v1/endpoints/${endpointId}`,
    });
    const resurrect = await test.app.inject({
      method: "PATCH",
      url: `/v1/endpoints/${endpointId}`,
      payload: { state: "active" },
    });
    expect(deleted.statusCode).toBe(202);
    expect(deleted.json()).toMatchObject({
      endpoint: { id: endpointId, state: "deleted", tombstoneVersion: 1 },
      cleanup: {
        state: "pending",
        tasks: [expect.objectContaining({ state: "failed", attempts: 1 })],
      },
    });
    expect(JSON.stringify(deleted.json())).not.toContain("test-receiver");
    expect(resurrect.statusCode).toBe(410);

    const stillFailing = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/cleanup/retry`,
    });
    expect(stillFailing.statusCode).toBe(202);
    expect(stillFailing.json()).toMatchObject({
      endpoint: { id: endpointId, state: "deleted", tombstoneVersion: 1 },
      cleanup: {
        state: "pending",
        tasks: [expect.objectContaining({ state: "failed", attempts: 2 })],
      },
    });

    payloadStorage.failDeletes = false;
    const retried = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/cleanup/retry`,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      cleanup: { state: "completed", tasks: [] },
    });
    expect(payloadStorage.size).toBe(0);

    const completed = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/cleanup/retry`,
    });
    expect(completed.statusCode).toBe(409);
    expect(completed.json()).toMatchObject({
      error: {
        code: "ENDPOINT_CLEANUP_RETRY_INVALID_TRANSITION",
        details: { currentState: "deleted", cleanupState: "completed" },
      },
    });
  });

  it.each(["active", "paused"] as const)(
    "rejects cleanup retry for a %s endpoint without deleting it",
    async (state) => {
      const test = await harness();
      const created = await test.app.inject({
        method: "POST",
        url: "/v1/endpoints",
        payload: {
          url: "http://127.0.0.1:3210/v1/test-receiver/retry-guard",
          allowLocalNetwork: true,
        },
      });
      expect(created.statusCode).toBe(201);
      const endpointId = (created.json() as { endpoint: { id: string } })
        .endpoint.id;
      if (state === "paused") {
        const paused = await test.app.inject({
          method: "PATCH",
          url: `/v1/endpoints/${endpointId}`,
          payload: { state },
        });
        expect(paused.statusCode).toBe(200);
      }

      const retried = await test.app.inject({
        method: "POST",
        url: `/v1/endpoints/${endpointId}/cleanup/retry`,
      });

      expect(retried.statusCode).toBe(409);
      expect(retried.json()).toMatchObject({
        error: {
          code: "ENDPOINT_CLEANUP_RETRY_INVALID_TRANSITION",
          details: { currentState: state },
        },
      });
      expect(await test.repository.getEndpoint(endpointId)).toMatchObject({
        id: endpointId,
        state,
      });
      expect(
        await test.repository.listPayloadCleanupTasks(10_000, endpointId),
      ).toEqual([]);
    },
  );

  it("previews a valid draft import without activating a release", async () => {
    const test = await harness();
    const imported = await importContract(test.app);
    const importId = (imported.body["import"] as Record<string, unknown>)["id"];
    const preview = await test.app.inject({
      method: "GET",
      url: `/preview?importId=${String(importId)}`,
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain(`Draft import ${String(importId)}`);
    expect(preview.body).toContain("Order created");
    expect(await test.repository.listReleases()).toEqual([]);
  });

  it("requires an API version for events 1, 2, and 10 and never picks lexicographically", async () => {
    let deliveredBody = "";
    let transportCalls = 0;
    const test = await harness({
      transport: async (request) => {
        transportCalls += 1;
        deliveredBody = Buffer.from(request.body ?? []).toString("utf8");
        return { status: 204 };
      },
    });
    await publish(test.app, multiVersionOpenApi());
    const endpointId = await setupEndpoint(test.app);
    await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/secrets`,
      payload: {},
    });
    const implicit = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/send-test`,
      headers: { "idempotency-key": "multi-version-implicit" },
      payload: { eventType: "order.created" },
    });
    const explicit = await test.app.inject({
      method: "POST",
      url: `/v1/endpoints/${endpointId}/send-test`,
      headers: { "idempotency-key": "multi-version-explicit" },
      payload: { eventType: "order.created", version: "10" },
    });
    const status = await test.app.inject({
      method: "GET",
      url: `/v1/endpoints/${endpointId}/send-test/status`,
      headers: { "idempotency-key": "multi-version-explicit" },
    });

    expect(implicit.statusCode).toBe(400);
    expect(implicit.json()).toMatchObject({
      error: {
        code: "EVENT_VERSION_REQUIRED",
        details: { availableVersions: ["1", "10", "2"] },
      },
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toMatchObject({
      command: {
        version: "10",
        evidence: { status: "completed", state: "complete" },
      },
    });
    expect(status.json()).toEqual(explicit.json());
    expect(deliveredBody).toBe('{"version":"10"}');
    expect(transportCalls).toBe(1);
  });

  it("returns clean unsupported-media and not-found errors", async () => {
    const test = await harness();
    const unsupported = await test.app.inject({
      method: "POST",
      url: "/v1/endpoints",
      headers: { "content-type": "application/xml" },
      payload: "not-json",
    });
    const missing = await test.app.inject({
      method: "GET",
      url: "/v1/no-such-route",
    });

    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(JSON.stringify(unsupported.json())).not.toContain("Fastify");
  });

  it("maps the shared invalid cursor error to stable HTTP 400", async () => {
    const test = await harness();
    const response = await test.app.inject({
      method: "GET",
      url: "/v1/timeline?cursor=not%2Ban%2Bopaque%2Bcursor",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_CURSOR" },
    });
  });

  it("keeps generated OpenAPI in contract with every documented route", async () => {
    const test = await harness();
    const response = await test.app.inject({
      method: "GET",
      url: "/openapi.json",
    });
    const document = response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const expected = [
      "GET /health/live",
      "GET /health/maintenance",
      "GET /health/ready",
      "POST /v1/contracts/import",
      "GET /v1/contracts/imports/{id}",
      "POST /v1/releases/publish",
      "GET /v1/releases/publish/status",
      "GET /v1/releases",
      "GET /v1/releases/{id}",
      "GET /v1/events",
      "POST /v1/endpoints",
      "GET /v1/endpoints",
      "GET /v1/endpoints/{id}",
      "PATCH /v1/endpoints/{id}",
      "DELETE /v1/endpoints/{id}",
      "GET /v1/endpoints/{id}/cleanup",
      "POST /v1/endpoints/{id}/cleanup/retry",
      "PUT /v1/endpoints/{id}/subscriptions",
      "GET /v1/endpoints/{id}/subscriptions",
      "POST /v1/endpoints/{id}/secrets",
      "GET /v1/endpoints/{id}/secrets",
      "POST /v1/endpoints/{id}/secrets/rotate",
      "POST /v1/endpoints/{endpointId}/secrets/{secretId}/revoke",
      "POST /v1/endpoints/{id}/send-test",
      "GET /v1/endpoints/{id}/send-test/status",
      "POST /v1/ingest",
      "GET /v1/timeline",
      "GET /v1/audit",
      "POST /v1/test-receiver/{endpointId}",
    ].sort();
    const documented = Object.entries(document.paths)
      .flatMap(([route, operations]) =>
        Object.keys(operations).map(
          (method) => `${method.toUpperCase()} ${route}`,
        ),
      )
      .sort();

    expect(documented).toEqual(expected);
    for (const entry of documented) {
      const separator = entry.indexOf(" ");
      const method = entry.slice(0, separator);
      const url = entry.slice(separator + 1).replace(/\{([^}]+)\}/gu, ":$1");
      expect(test.app.hasRoute({ method, url })).toBe(true);
    }
    const publishOperation = document.paths["/v1/releases/publish"]?.["post"];
    const publishStatusOperation =
      document.paths["/v1/releases/publish/status"]?.["get"];
    const releaseListOperation = document.paths["/v1/releases"]?.["get"];
    const ingestOperation = document.paths["/v1/ingest"]?.["post"];
    const receiverOperation =
      document.paths["/v1/test-receiver/{endpointId}"]?.["post"];
    const timelineOperation = document.paths["/v1/timeline"]?.["get"];
    const cleanupRetryOperation =
      document.paths["/v1/endpoints/{id}/cleanup/retry"]?.["post"];
    expect(JSON.stringify(publishOperation)).toContain("idempotency-key");
    expect(JSON.stringify(publishOperation)).toContain("apiToken");
    expect(JSON.stringify(publishOperation)).toContain("eventSummary");
    expect(JSON.stringify(publishOperation)).not.toContain("canonicalExport");
    expect(JSON.stringify(publishStatusOperation)).toContain("eventSummary");
    expect(JSON.stringify(publishStatusOperation)).not.toContain(
      "canonicalExport",
    );
    expect(JSON.stringify(releaseListOperation)).toContain("beforeSequence");
    expect(JSON.stringify(releaseListOperation)).toContain("eventSummary");
    expect(JSON.stringify(ingestOperation)).toContain(
      "x-webhook-ingest-credential",
    );
    expect(JSON.stringify(receiverOperation)).toContain("webhookSignature");
    expect(JSON.stringify(receiverOperation)).toContain('"204"');
    expect(JSON.stringify(timelineOperation)).toContain("deliveryId");
    expect(JSON.stringify(timelineOperation)).toContain("date-time");
    expect(JSON.stringify(cleanupRetryOperation)).toContain(
      "Active and paused endpoints are never deleted",
    );
    expect(JSON.stringify(cleanupRetryOperation)).toContain(
      "ENDPOINT_CLEANUP_RETRY_INVALID_TRANSITION",
    );
    expect(
      Object.keys(
        (cleanupRetryOperation?.["responses"] as Record<string, unknown>) ?? {},
      ),
    ).toEqual(expect.arrayContaining(["200", "202", "404", "409", "503"]));
  });

  it("rejects invalid receiver signatures and closes dependencies gracefully", async () => {
    const test = await harness();
    const invalid = await test.app.inject({
      method: "POST",
      url: "/v1/test-receiver/missing",
      headers: {
        "content-type": "application/webhook+json",
        "webhook-id": "msg_1",
        "webhook-timestamp": String(Math.floor(test.now / 1000)),
        "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      payload: '{"ok":true}',
    });
    expect(invalid.statusCode).toBe(401);

    openApps.splice(openApps.indexOf(test.app), 1);
    await test.app.close();
    expect(test.repository.closed).toBe(true);
  });
});
