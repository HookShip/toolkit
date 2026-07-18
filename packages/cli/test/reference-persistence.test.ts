// SPDX-License-Identifier: Apache-2.0

import type { HttpTransport } from "@webhook-portal/adapter-generic-http";
import { describe, expect, it } from "vitest";

import {
  AesGcmSecretCipher,
  DEFAULT_REFERENCE_SERVER_CONFIG,
  InMemoryPayloadStorage,
  InMemoryReferenceRepository,
  PayloadStorageIdentityError,
  ReferenceApiError,
  ReferenceService,
  ensurePayloadStorageIdentity,
  reconcileOrphanedPayloads,
  startPayloadMaintenance,
  sweepExpiredPayloads,
  type PayloadObjectPage,
  type PayloadReconciliationCursor,
  type PutPayloadInput,
  type ReferenceServerConfig,
} from "../src/reference-server/index.js";

function openApi(eventTypes: readonly string[]): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Orders", version: "1.0.0" },
    webhooks: Object.fromEntries(
      eventTypes.map((eventType) => [
        eventType,
        {
          post: {
            summary: eventType,
            "x-event-type": eventType,
            "x-event-version": "1",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id"],
                    properties: { id: { type: "string" } },
                  },
                  example: { id: `${eventType}-1` },
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

class FaultingPayloadStorage extends InMemoryPayloadStorage {
  failPut = false;
  failDelete = false;
  afterPut: ((input: PutPayloadInput) => Promise<void> | void) | undefined;

  override async put(input: PutPayloadInput): Promise<void> {
    if (this.failPut) {
      this.failPut = false;
      throw new Error("injected payload put failure");
    }
    await super.put(input);
    const afterPut = this.afterPut;
    this.afterPut = undefined;
    await afterPut?.(input);
  }

  override async delete(objectKey: string): Promise<void> {
    if (this.failDelete) {
      this.failDelete = false;
      throw new Error("injected payload delete failure");
    }
    await super.delete(objectKey);
  }
}

class TransientListPayloadStorage extends InMemoryPayloadStorage {
  readonly listCursors: Array<string | undefined> = [];
  #remainingFailures = 1;

  override async listObjects(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadObjectPage> {
    this.listCursors.push(cursor);
    if (this.#remainingFailures > 0) {
      this.#remainingFailures -= 1;
      const error = new Error("transient object listing failure") as Error & {
        code: string;
      };
      error.code = "TRANSIENT_LIST_FAILURE";
      throw error;
    }
    return super.listObjects(prefix, limit, cursor);
  }
}

class TrackingReferenceRepository extends InMemoryReferenceRepository {
  readonly referenceCursors: Array<string | undefined> = [];

  override async listPayloadReferencesPage(limit: number, cursor?: string) {
    this.referenceCursors.push(cursor);
    return super.listPayloadReferencesPage(limit, cursor);
  }
}

interface ServiceHarness {
  readonly repository: InMemoryReferenceRepository;
  readonly storage: FaultingPayloadStorage;
  readonly service: ReferenceService;
  readonly config: ReferenceServerConfig;
  readonly transportCalls: { value: number };
  fail(operation: string, occurrence?: number): void;
  advance(milliseconds: number): void;
}

function serviceHarness(
  options: {
    readonly payloadRetention?: boolean;
    readonly transport?: HttpTransport;
  } = {},
): ServiceHarness {
  let now = Date.parse("2026-07-16T08:00:00.000Z");
  let sequence = 0;
  const faults: Array<{ operation: string; remaining: number }> = [];
  const repository = new InMemoryReferenceRepository({
    faultInjector: (operation) => {
      const fault = faults.find(
        (candidate) => candidate.operation === operation,
      );
      if (fault === undefined) {
        return;
      }
      fault.remaining -= 1;
      if (fault.remaining === 0) {
        faults.splice(faults.indexOf(fault), 1);
        throw new Error(`injected ${operation} failure`);
      }
    },
  });
  const storage = new FaultingPayloadStorage();
  const transportCalls = { value: 0 };
  const transport: HttpTransport =
    options.transport ??
    (async () => {
      transportCalls.value += 1;
      return { status: 204 };
    });
  const config: ReferenceServerConfig = {
    ...DEFAULT_REFERENCE_SERVER_CONFIG,
    apiToken: "reference-api-token-for-tests",
    allowLocalNetwork: true,
    host: "127.0.0.1",
    port: 0,
    ingestCredential: {
      id: "persistence-ingest",
      secret: "persistence-ingest-secret",
    },
    payloadRetention: {
      enabled: options.payloadRetention ?? false,
      ttlSeconds: 3600,
    },
    sendTestTimeoutMilliseconds: 1000,
  };
  const service = new ReferenceService({
    repository,
    cipher: new AesGcmSecretCipher(Buffer.alloc(32, 11)),
    config,
    payloadStorage: storage,
    transport: async (request) => {
      if (options.transport !== undefined) {
        transportCalls.value += 1;
      }
      return transport(request);
    },
    clock: () => now,
    idFactory: () => `persistence-${++sequence}`,
  });
  return {
    repository,
    storage,
    service,
    config,
    transportCalls,
    fail: (operation, occurrence = 1) => {
      faults.push({ operation, remaining: occurrence });
    },
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

async function importAndPublish(
  harness: ServiceHarness,
  eventTypes: readonly string[],
  idempotencyKey: string,
) {
  const imported = await harness.service.importContract({
    source: openApi(eventTypes),
    sourceMediaType: "application/json",
    correlationId: `import-${idempotencyKey}`,
  });
  return harness.service.publishRelease(
    imported.id,
    `publish-${idempotencyKey}`,
    undefined,
    idempotencyKey,
  );
}

async function setupEndpoint(
  harness: ServiceHarness,
  options: { readonly createSecret?: boolean } = {},
): Promise<string> {
  const endpoint = await harness.service.createEndpoint({
    url: "http://127.0.0.1:9999/webhook",
    allowLocalNetwork: true,
    correlationId: "endpoint-create",
  });
  await harness.service.setSubscriptions(
    endpoint.id,
    ["order.created"],
    "subscription-set",
  );
  if (options.createSecret !== false) {
    await harness.service.createSecret(endpoint.id, "secret-create");
  }
  return endpoint.id;
}

async function payloadReferenceForDelivery(
  repository: InMemoryReferenceRepository,
  deliveryId: string,
) {
  return (await repository.listPayloadReferences(100)).find(
    (reference) => reference.deliveryId === deliveryId,
  );
}

async function payloadIntentForDelivery(
  repository: InMemoryReferenceRepository,
  deliveryId: string,
) {
  return (
    await repository.listPayloadUploadIntents("9999-12-31T23:59:59.999Z", 100)
  ).items.find((intent) => intent.deliveryId === deliveryId);
}

describe("reference persistence hardening", () => {
  it("serializes competing publications against the actual predecessor and recovers by idempotency key", async () => {
    const harness = serviceHarness();
    await importAndPublish(harness, ["order.created"], "publish-a");
    const importB = await harness.service.importContract({
      source: openApi(["order.created", "order.cancelled"]),
      sourceMediaType: "application/json",
      correlationId: "import-b",
    });
    const importC = await harness.service.importContract({
      source: openApi(["order.created", "order.shipped"]),
      sourceMediaType: "application/json",
      correlationId: "import-c",
    });

    const [publishedB, publishedC] = await Promise.allSettled([
      harness.service.publishRelease(
        importB.id,
        "publish-b",
        undefined,
        "publish-b",
      ),
      harness.service.publishRelease(
        importC.id,
        "publish-c",
        undefined,
        "publish-c",
      ),
    ]);

    expect(publishedB.status).toBe("fulfilled");
    expect(publishedC.status).toBe("rejected");
    expect(
      publishedC.status === "rejected" ? publishedC.reason : undefined,
    ).toMatchObject({ code: "PUBLISH_INCOMPATIBLE" });
    const releaseB =
      publishedB.status === "fulfilled" ? publishedB.value : undefined;
    expect(await harness.repository.listReleases()).toHaveLength(2);

    const recovered = await harness.service.publishRelease(
      importB.id,
      "publish-b-retry",
      undefined,
      "publish-b",
    );
    expect(recovered.id).toBe(releaseB?.id);
    expect(
      (await harness.repository.listOutbox(20)).filter(
        (event) => event.topic === "release.published",
      ),
    ).toHaveLength(2);
  });

  it("rolls publication, activation, audit, outbox, and idempotency back as one unit", async () => {
    const harness = serviceHarness();
    const imported = await harness.service.importContract({
      source: openApi(["order.created"]),
      sourceMediaType: "application/json",
      correlationId: "publish-rollback-import",
    });
    harness.fail("appendOutbox");

    await expect(
      harness.service.publishRelease(
        imported.id,
        "publish-rollback",
        undefined,
        "publish-rollback",
      ),
    ).rejects.toThrow("injected appendOutbox failure");
    expect(await harness.repository.listReleases()).toEqual([]);
    expect(
      await harness.repository.getPublishCommand("publish-rollback"),
    ).toBeUndefined();
    expect(
      (await harness.repository.listAudit(100)).some(
        (record) =>
          record.action === "release.publish" && record.result === "success",
      ),
    ).toBe(false);
    expect(
      (await harness.repository.listOutbox(100)).some(
        (record) => record.topic === "release.published",
      ),
    ).toBe(false);
  });

  it("recovers a publication after the commit succeeds but the response is lost", async () => {
    const harness = serviceHarness();
    const imported = await harness.service.importContract({
      source: openApi(["order.created"]),
      sourceMediaType: "application/json",
      correlationId: "publish-response-loss-import",
    });
    harness.fail("transactionCommitResponse");

    const committed = await harness.service.publishRelease(
      imported.id,
      "publish-response-loss",
      undefined,
      "publish-response-loss",
    );
    expect(await harness.repository.listReleases()).toHaveLength(1);
    expect(committed).toMatchObject({
      status: "active",
      importId: imported.id,
    });

    const replacementImport = await harness.service.importContract({
      source: openApi(["order.created"]),
      sourceMediaType: "application/json",
      correlationId: "publish-response-loss-new-import",
    });
    const recovered = await harness.service.publishRelease(
      replacementImport.id,
      "publish-response-loss-retry",
      undefined,
      "publish-response-loss",
    );
    expect(recovered.id).toBe(committed.id);
    await expect(
      harness.service.getPublishStatus("publish-response-loss"),
    ).resolves.toMatchObject({
      status: "completed",
      release: { id: committed.id },
    });
    await expect(
      harness.service.recoverPublishStatus("publish-response-loss"),
    ).resolves.toMatchObject({
      status: "completed",
      release: { id: committed.id },
    });
    expect(
      (await harness.repository.listOutbox(20)).filter(
        (event) => event.topic === "release.published",
      ),
    ).toHaveLength(1);
  });

  it("conflicts when a publish key is retried with different canonical content", async () => {
    const harness = serviceHarness();
    await importAndPublish(harness, ["order.created"], "publish-content-key");
    const different = await harness.service.importContract({
      source: openApi(["order.created", "order.cancelled"]),
      sourceMediaType: "application/json",
      correlationId: "publish-content-conflict-import",
    });

    await expect(
      harness.service.publishRelease(
        different.id,
        "publish-content-conflict",
        undefined,
        "publish-content-key",
      ),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      statusCode: 409,
    });
    expect(await harness.repository.listReleases()).toHaveLength(1);
  });

  it("replays competing imports of the same canonical contract and key", async () => {
    const harness = serviceHarness();
    const first = await harness.service.importContract({
      source: openApi(["order.created"]),
      sourceMediaType: "application/json",
      correlationId: "publish-race-first-import",
    });
    const second = await harness.service.importContract({
      source: openApi(["order.created"]),
      sourceMediaType: "application/json",
      correlationId: "publish-race-second-import",
    });

    const releases = await Promise.all([
      harness.service.publishRelease(
        first.id,
        "publish-race-first",
        "  approved  ",
        "publish-race-same-key",
      ),
      harness.service.publishRelease(
        second.id,
        "publish-race-second",
        "approved",
        "publish-race-same-key",
      ),
    ]);

    expect(releases[0]?.id).toBe(releases[1]?.id);
    expect(await harness.repository.listReleases()).toHaveLength(1);
    expect(
      (await harness.repository.getPublishCommand("publish-race-same-key"))
        ?.requestFingerprint,
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("returns an explicit unknown status handle when commit recovery is unavailable", async () => {
    const harness = serviceHarness();
    const imported = await harness.service.importContract({
      source: openApi(["order.created"]),
      sourceMediaType: "application/json",
      correlationId: "publish-unknown-import",
    });
    harness.fail("transactionCommitResponse");
    harness.fail("recoverPublishStatus");

    await expect(
      harness.service.publishRelease(
        imported.id,
        "publish-unknown",
        undefined,
        "publish-unknown",
      ),
    ).rejects.toMatchObject({
      code: "PUBLISH_OUTCOME_UNKNOWN",
      statusCode: 503,
      details: {
        idempotencyKey: "publish-unknown",
        publishStatus: "unknown",
        safeToRetry: false,
      },
    });
    await expect(
      harness.service.getPublishStatus("publish-unknown"),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("deletes endpoint-controlled data, payload objects, and prevents resurrection", async () => {
    const harness = serviceHarness({ payloadRetention: true });
    await importAndPublish(
      harness,
      ["order.created"],
      "endpoint-delete-release",
    );
    const endpointId = await setupEndpoint(harness);
    await harness.service.sendTest({
      endpointId,
      eventType: "order.created",
      idempotencyKey: "endpoint-delete-test",
      correlationId: "endpoint-delete-test",
    });
    expect(harness.storage.size).toBe(1);
    expect(
      JSON.stringify({
        audit: await harness.repository.listAudit(100),
        outbox: await harness.repository.listOutbox(100),
        timeline: await harness.repository.listTimeline({ limit: 100 }),
        command: await harness.repository.getTestCommandByIdempotency(
          endpointId,
          "endpoint-delete-test",
        ),
      }),
    ).not.toContain('{"id":"order.created-1"}');

    const deleted = await harness.service.updateEndpoint(endpointId, {
      state: "deleted",
      correlationId: "endpoint-delete",
    });

    expect(deleted).toMatchObject({
      id: endpointId,
      state: "deleted",
      tombstoneVersion: 1,
    });
    expect(JSON.stringify(deleted)).not.toContain("127.0.0.1");
    expect(harness.storage.size).toBe(0);
    expect(
      await harness.repository.getSubscription(endpointId),
    ).toBeUndefined();
    expect(await harness.repository.listSecretVersions(endpointId)).toEqual([]);
    expect(
      (await harness.repository.listTimeline({ limit: 20 })).items,
    ).toEqual([]);
    await expect(
      harness.service.updateEndpoint(endpointId, {
        state: "active",
        correlationId: "endpoint-resurrection",
      }),
    ).rejects.toMatchObject({
      code: "ENDPOINT_DELETED",
      statusCode: 410,
    });
    await expect(
      harness.service.updateEndpoint(endpointId, {
        state: "deleted",
        correlationId: "endpoint-delete-retry",
      }),
    ).resolves.toEqual(deleted);
  });

  it("commits endpoint revocation while exposing recoverable object cleanup failure", async () => {
    const harness = serviceHarness({ payloadRetention: true });
    await importAndPublish(
      harness,
      ["order.created"],
      "endpoint-cleanup-release",
    );
    const endpointId = await setupEndpoint(harness);
    await harness.service.sendTest({
      endpointId,
      eventType: "order.created",
      idempotencyKey: "endpoint-cleanup-test",
      correlationId: "endpoint-cleanup-test",
    });
    harness.storage.failDelete = true;

    await expect(
      harness.service.updateEndpoint(endpointId, {
        state: "deleted",
        correlationId: "endpoint-cleanup-delete",
      }),
    ).rejects.toMatchObject({
      code: "ENDPOINT_PAYLOAD_CLEANUP_PENDING",
      statusCode: 503,
      details: { endpointDeleted: true, pendingObjectCount: 1 },
    });
    expect(await harness.repository.getEndpoint(endpointId)).toMatchObject({
      state: "deleted",
    });
    expect(await harness.repository.listSecretVersions(endpointId)).toEqual([]);
    expect(harness.storage.size).toBe(1);
    expect(
      await harness.repository.listPayloadCleanupTasks(10, endpointId),
    ).toMatchObject([{ state: "failed", attempts: 1 }]);

    await expect(
      harness.service.updateEndpoint(endpointId, {
        state: "deleted",
        correlationId: "endpoint-cleanup-retry",
      }),
    ).resolves.toMatchObject({ state: "deleted" });
    expect(harness.storage.size).toBe(0);
    expect(
      await harness.repository.listPayloadCleanupTasks(10, endpointId),
    ).toEqual([]);
  });

  it("rolls endpoint deletion back completely when its audit write fails", async () => {
    const harness = serviceHarness();
    await importAndPublish(
      harness,
      ["order.created"],
      "endpoint-audit-release",
    );
    const endpointId = await setupEndpoint(harness);
    harness.fail("appendAudit");

    await expect(
      harness.service.updateEndpoint(endpointId, {
        state: "deleted",
        correlationId: "endpoint-audit-delete",
      }),
    ).rejects.toThrow("injected appendAudit failure");
    expect(await harness.repository.getEndpoint(endpointId)).toMatchObject({
      state: "active",
    });
    expect(await harness.repository.getSubscription(endpointId)).toBeDefined();
    expect(
      await harness.repository.listSecretVersions(endpointId),
    ).toHaveLength(1);
  });

  it("rolls back secret creation when audit persistence fails and reveals plaintext only after commit", async () => {
    const harness = serviceHarness();
    await importAndPublish(harness, ["order.created"], "secret-audit-release");
    const endpointId = await setupEndpoint(harness, { createSecret: false });
    harness.fail("appendAudit");

    await expect(
      harness.service.createSecret(endpointId, "secret-audit-failure"),
    ).rejects.toThrow("injected appendAudit failure");
    expect(await harness.repository.listSecretVersions(endpointId)).toEqual([]);
    expect(
      (await harness.repository.listOutbox(20)).some(
        (event) => event.topic === "secret.created",
      ),
    ).toBe(false);

    const created = await harness.service.createSecret(
      endpointId,
      "secret-audit-success",
    );
    expect(created.secret).toMatch(/^whsec_/u);
    expect(
      JSON.stringify(await harness.repository.listAudit(50)),
    ).not.toContain(created.secret);
  });

  it("serializes concurrent secret creation with one audit and one active version", async () => {
    const harness = serviceHarness();
    await importAndPublish(harness, ["order.created"], "secret-race-release");
    const endpointId = await setupEndpoint(harness, { createSecret: false });

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        harness.service.createSecret(endpointId, `secret-race-${index}`),
      ),
    );

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await harness.repository.listSecretVersions(endpointId)).filter(
        (secret) => secret.state === "active",
      ),
    ).toHaveLength(1);
    expect(
      (await harness.repository.listAudit(100)).filter(
        (record) => record.action === "secret.create",
      ),
    ).toHaveLength(1);
  });

  it("replays the original test result before checking later endpoint or release state", async () => {
    const harness = serviceHarness();
    await importAndPublish(harness, ["order.created"], "test-replay-a");
    const endpointId = await setupEndpoint(harness);
    const first = await harness.service.sendTest({
      endpointId,
      eventType: "order.created",
      idempotencyKey: "immutable-test-request",
      correlationId: "test-first",
    });
    await harness.service.updateEndpoint(endpointId, {
      state: "paused",
      correlationId: "endpoint-pause",
    });
    await importAndPublish(
      harness,
      ["order.created", "order.cancelled"],
      "test-replay-b",
    );

    const replayed = await harness.service.sendTest({
      endpointId,
      eventType: "order.created",
      idempotencyKey: "immutable-test-request",
      correlationId: "test-replay",
    });

    expect(replayed).toEqual(first);
    expect(first).toMatchObject({
      state: "acknowledged",
      evidenceState: "complete",
      result: { delivered: true, statusCode: 204 },
    });
    expect(harness.transportCalls.value).toBe(1);
  });

  it("does not compensate a payload when the final evidence commit succeeded but its response was lost", async () => {
    const harness = serviceHarness({ payloadRetention: true });
    await importAndPublish(
      harness,
      ["order.created"],
      "test-response-loss-release",
    );
    const endpointId = await setupEndpoint(harness);
    harness.fail("transactionCommitResponse", 4);

    const completed = await harness.service.sendTest({
      endpointId,
      eventType: "order.created",
      idempotencyKey: "test-response-loss",
      correlationId: "test-response-loss",
    });

    expect(completed).toMatchObject({
      state: "acknowledged",
      evidenceState: "complete",
    });
    expect(harness.transportCalls.value).toBe(1);
    expect(harness.storage.size).toBe(1);
    expect(
      (await harness.repository.listTimeline({ limit: 10 })).items,
    ).toHaveLength(1);
    expect(
      await payloadReferenceForDelivery(harness.repository, completed.id),
    ).toBeDefined();
  });

  it("returns a retryable status when cleanup begins before evidence attachment, then re-uploads safely", async () => {
    const harness = serviceHarness({ payloadRetention: true });
    await importAndPublish(
      harness,
      ["order.created"],
      "test-cleanup-race-release",
    );
    const endpointId = await setupEndpoint(harness);
    let deletingClaim:
      | {
          readonly objectKey: string;
          readonly claimId: string;
          readonly generation: number;
          readonly uploadIntentId?: string;
          readonly uploadGeneration?: string;
        }
      | undefined;
    harness.storage.afterPut = async ({ objectKey }) => {
      const intent =
        await harness.repository.getPayloadUploadIntentByObjectKey(objectKey);
      if (intent === undefined) {
        throw new Error("Expected a durable payload upload intent.");
      }
      const claimed = await harness.repository.claimPayloadCleanup({
        objectKey,
        claimId: "service-cleanup-race",
        reason: "stale_upload_intent",
        timestamp: "2026-07-16T08:00:00.000Z",
        leaseExpiresAt: "2026-07-16T08:01:00.000Z",
        uploadIntentId: intent.id,
        uploadGeneration: intent.uploadGeneration,
      });
      if (claimed.status !== "claimed") {
        throw new Error("Expected the payload cleanup claim.");
      }
      const deleting = await harness.repository.beginPayloadCleanupDeletion({
        objectKey,
        claimId: claimed.claim.claimId,
        generation: claimed.claim.generation,
        ...(claimed.claim.uploadIntentId === undefined
          ? {}
          : { uploadIntentId: claimed.claim.uploadIntentId }),
        ...(claimed.claim.uploadGeneration === undefined
          ? {}
          : { uploadGeneration: claimed.claim.uploadGeneration }),
        timestamp: "2026-07-16T08:00:00.000Z",
        leaseExpiresAt: "2026-07-16T08:01:00.000Z",
      });
      if (deleting.status !== "deleting") {
        throw new Error("Expected payload deletion ownership.");
      }
      deletingClaim = {
        objectKey,
        claimId: claimed.claim.claimId,
        generation: claimed.claim.generation,
        ...(claimed.claim.uploadIntentId === undefined
          ? {}
          : { uploadIntentId: claimed.claim.uploadIntentId }),
        ...(claimed.claim.uploadGeneration === undefined
          ? {}
          : { uploadGeneration: claimed.claim.uploadGeneration }),
      };
    };

    await expect(
      harness.service.sendTest({
        endpointId,
        eventType: "order.created",
        idempotencyKey: "test-cleanup-race",
        correlationId: "test-cleanup-race",
      }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_CLEANUP_IN_PROGRESS",
      statusCode: 409,
      details: { cleanupState: "deleting", retryable: true },
    });
    if (deletingClaim === undefined) {
      throw new Error("Expected a deleting payload claim.");
    }
    expect(
      await harness.repository.getPayloadReferenceByObjectKey(
        deletingClaim.objectKey,
      ),
    ).toBeUndefined();
    await harness.storage.delete(deletingClaim.objectKey);
    await expect(
      harness.repository.finalizePayloadCleanupDeletion({
        objectKey: deletingClaim.objectKey,
        claimId: deletingClaim.claimId,
        generation: deletingClaim.generation,
        timestamp: "2026-07-16T08:00:01.000Z",
        ...(deletingClaim.uploadIntentId === undefined
          ? {}
          : { uploadIntentId: deletingClaim.uploadIntentId }),
        ...(deletingClaim.uploadGeneration === undefined
          ? {}
          : { uploadGeneration: deletingClaim.uploadGeneration }),
      }),
    ).resolves.toBe(true);

    const recovered = await harness.service.sendTest({
      endpointId,
      eventType: "order.created",
      idempotencyKey: "test-cleanup-race",
      correlationId: "test-cleanup-race-retry",
    });
    expect(recovered).toMatchObject({
      state: "acknowledged",
      evidenceState: "complete",
    });
    expect(harness.transportCalls.value).toBe(1);
    const recoveredReference = await payloadReferenceForDelivery(
      harness.repository,
      recovered.id,
    );
    expect(recoveredReference).toBeDefined();
    expect(
      await harness.storage.exists(recoveredReference?.objectKey ?? "missing"),
    ).toBe(true);
  });

  it("never attaches evidence after claimed deletion finalizes and reports re-upload recovery", async () => {
    const harness = serviceHarness({ payloadRetention: true });
    await importAndPublish(
      harness,
      ["order.created"],
      "test-cleanup-finalized-release",
    );
    const endpointId = await setupEndpoint(harness);
    let deletedObjectKey: string | undefined;
    let deletedAttempt:
      | {
          readonly id: string;
          readonly generation: string;
          readonly createdAt: string;
        }
      | undefined;
    harness.storage.afterPut = async ({ objectKey }) => {
      deletedObjectKey = objectKey;
      const intent =
        await harness.repository.getPayloadUploadIntentByObjectKey(objectKey);
      if (intent === undefined) {
        throw new Error("Expected a durable payload upload intent.");
      }
      deletedAttempt = {
        id: intent.id,
        generation: intent.uploadGeneration,
        createdAt: intent.createdAt,
      };
      const claimed = await harness.repository.claimPayloadCleanup({
        objectKey,
        claimId: "service-cleanup-finalized",
        reason: "stale_upload_intent",
        timestamp: "2026-07-16T08:00:00.000Z",
        leaseExpiresAt: "2026-07-16T08:01:00.000Z",
        uploadIntentId: intent.id,
        uploadGeneration: intent.uploadGeneration,
      });
      if (claimed.status !== "claimed") {
        throw new Error("Expected the payload cleanup claim.");
      }
      const deleting = await harness.repository.beginPayloadCleanupDeletion({
        objectKey,
        claimId: claimed.claim.claimId,
        generation: claimed.claim.generation,
        timestamp: "2026-07-16T08:00:00.000Z",
        leaseExpiresAt: "2026-07-16T08:01:00.000Z",
        uploadIntentId: intent.id,
        uploadGeneration: intent.uploadGeneration,
      });
      if (deleting.status !== "deleting") {
        throw new Error("Expected payload deletion ownership.");
      }
      await harness.storage.delete(objectKey);
      const finalized = await harness.repository.finalizePayloadCleanupDeletion(
        {
          objectKey,
          claimId: claimed.claim.claimId,
          generation: claimed.claim.generation,
          timestamp: "2026-07-16T08:00:01.000Z",
          uploadIntentId: intent.id,
          uploadGeneration: intent.uploadGeneration,
        },
      );
      if (!finalized) {
        throw new Error("Expected payload deletion finalization.");
      }
    };

    await expect(
      harness.service.sendTest({
        endpointId,
        eventType: "order.created",
        idempotencyKey: "test-cleanup-finalized",
        correlationId: "test-cleanup-finalized",
      }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_REUPLOAD_REQUIRED",
      statusCode: 409,
      details: { cleanupState: "deleted", retryable: true },
    });
    expect(harness.storage.size).toBe(0);
    if (deletedObjectKey === undefined) {
      throw new Error("Expected a finalized payload object key.");
    }
    expect(
      await harness.repository.getPayloadReferenceByObjectKey(deletedObjectKey),
    ).toBeUndefined();

    harness.advance(1);
    const recovered = await harness.service.sendTest({
      endpointId,
      eventType: "order.created",
      idempotencyKey: "test-cleanup-finalized",
      correlationId: "test-cleanup-finalized-retry",
    });
    expect(recovered).toMatchObject({
      state: "acknowledged",
      evidenceState: "complete",
    });
    expect(harness.transportCalls.value).toBe(1);
    expect(harness.storage.size).toBe(1);
    const recoveredReference = await payloadReferenceForDelivery(
      harness.repository,
      recovered.id,
    );
    expect(recoveredReference).toBeDefined();
    if (deletedAttempt === undefined || recoveredReference === undefined) {
      throw new Error("Expected old and replacement payload attempts.");
    }
    expect(recoveredReference.objectKey).not.toBe(deletedObjectKey);
    expect(recoveredReference.uploadAttemptId).not.toBe(deletedAttempt.id);
    expect(recoveredReference.uploadGeneration).not.toBe(
      deletedAttempt.generation,
    );
    expect(recoveredReference.createdAt).not.toBe(deletedAttempt.createdAt);
  });

  const persistenceFaults = [
    {
      name: "request row",
      operation: "beginTestCommand",
      occurrence: 1,
      phase: "request",
    },
    {
      name: "request audit",
      operation: "appendAudit",
      occurrence: 1,
      phase: "request",
    },
    {
      name: "request outbox",
      operation: "appendOutbox",
      occurrence: 1,
      phase: "request",
    },
    {
      name: "dispatch state",
      operation: "markTestCommandDispatched",
      occurrence: 1,
      phase: "dispatch",
    },
    {
      name: "dispatch audit",
      operation: "appendAudit",
      occurrence: 2,
      phase: "dispatch",
    },
    {
      name: "dispatch outbox",
      operation: "appendOutbox",
      occurrence: 2,
      phase: "dispatch",
    },
    {
      name: "staged outcome",
      operation: "stageTestCommandResult",
      occurrence: 1,
      phase: "stage",
    },
    {
      name: "staged-outcome outbox",
      operation: "appendOutbox",
      occurrence: 3,
      phase: "stage",
    },
    {
      name: "timeline observation",
      operation: "ingestMetadata",
      occurrence: 1,
      phase: "evidence",
    },
    {
      name: "payload reference",
      operation: "createPayloadReference",
      occurrence: 1,
      phase: "evidence",
    },
    {
      name: "final command state",
      operation: "completeTestCommand",
      occurrence: 1,
      phase: "evidence",
    },
    {
      name: "final audit",
      operation: "appendAudit",
      occurrence: 3,
      phase: "evidence",
    },
    {
      name: "final outbox",
      operation: "appendOutbox",
      occurrence: 4,
      phase: "evidence",
    },
  ] as const;

  for (const fault of persistenceFaults) {
    it(`keeps send-test honest and recoverable when ${fault.name} persistence fails`, async () => {
      const harness = serviceHarness({ payloadRetention: true });
      await importAndPublish(
        harness,
        ["order.created"],
        `fault-release-${fault.operation}-${fault.occurrence}`,
      );
      const endpointId = await setupEndpoint(harness);
      harness.fail(fault.operation, fault.occurrence);

      await expect(
        harness.service.sendTest({
          endpointId,
          eventType: "order.created",
          idempotencyKey: `fault-${fault.operation}-${fault.occurrence}`,
          correlationId: `fault-${fault.operation}`,
        }),
      ).rejects.toThrow();

      const command = await harness.repository.getTestCommandByIdempotency(
        endpointId,
        `fault-${fault.operation}-${fault.occurrence}`,
      );
      expect(
        (await harness.repository.listTimeline({ limit: 20 })).items,
      ).toEqual([]);
      expect(
        (await harness.repository.listOutbox(100)).some(
          (event) =>
            event.topic === "test.completed" &&
            event.aggregateId === command?.id,
        ),
      ).toBe(false);
      expect(harness.storage.size).toBe(0);

      if (fault.phase === "request") {
        expect(command).toBeUndefined();
        expect(harness.transportCalls.value).toBe(0);
      } else if (fault.phase === "dispatch") {
        expect(command).toMatchObject({
          state: "requested",
          evidenceState: "pending",
        });
        expect(command?.pendingResult).toBeUndefined();
        expect(harness.transportCalls.value).toBe(0);
        harness.advance(2000);
      } else if (fault.phase === "stage") {
        expect(command).toMatchObject({
          state: "dispatched",
          evidenceState: "pending",
        });
        expect(command?.pendingResult).toBeUndefined();
        expect(harness.transportCalls.value).toBe(1);
        harness.advance(2000);
      } else {
        expect(command).toMatchObject({
          state: "dispatched",
          evidenceState: "pending",
          pendingResult: { state: "acknowledged", delivered: true },
        });
        expect(harness.transportCalls.value).toBe(1);
      }

      const recovered = await harness.service.sendTest({
        endpointId,
        eventType: "order.created",
        idempotencyKey: `fault-${fault.operation}-${fault.occurrence}`,
        correlationId: `fault-recovery-${fault.operation}`,
      });
      if (fault.phase === "request") {
        expect(recovered.state).toBe("acknowledged");
        expect(harness.transportCalls.value).toBe(1);
      } else if (fault.phase === "dispatch") {
        expect(recovered.state).toBe("rejected_before_dispatch");
        expect(harness.transportCalls.value).toBe(0);
      } else if (fault.phase === "stage") {
        expect(recovered.state).toBe("unknown");
        expect(harness.transportCalls.value).toBe(1);
      } else {
        expect(recovered.state).toBe("acknowledged");
        expect(harness.transportCalls.value).toBe(1);
      }
      expect(recovered.evidenceState).toBe("complete");
      expect(
        (await harness.repository.listTimeline({ limit: 20 })).items,
      ).toHaveLength(1);
    });
  }

  it("leaves a staged outcome recoverable when object upload fails without resending", async () => {
    const harness = serviceHarness({ payloadRetention: true });
    await importAndPublish(harness, ["order.created"], "payload-put-release");
    const endpointId = await setupEndpoint(harness);
    harness.storage.failPut = true;

    await expect(
      harness.service.sendTest({
        endpointId,
        eventType: "order.created",
        idempotencyKey: "payload-put-failure",
        correlationId: "payload-put-failure",
      }),
    ).rejects.toThrow("injected payload put failure");
    expect(harness.transportCalls.value).toBe(1);
    expect(harness.storage.size).toBe(0);

    const recovered = await harness.service.sendTest({
      endpointId,
      eventType: "order.created",
      idempotencyKey: "payload-put-failure",
      correlationId: "payload-put-recovery",
    });
    expect(recovered.state).toBe("acknowledged");
    expect(harness.transportCalls.value).toBe(1);
    expect(harness.storage.size).toBe(1);
  });

  it("surfaces failed payload compensation and reconciles the orphan without bytes entering evidence", async () => {
    const harness = serviceHarness({ payloadRetention: true });
    await importAndPublish(
      harness,
      ["order.created"],
      "payload-compensation-release",
    );
    const endpointId = await setupEndpoint(harness);
    harness.fail("createPayloadReference");
    harness.storage.failDelete = true;

    await expect(
      harness.service.sendTest({
        endpointId,
        eventType: "order.created",
        idempotencyKey: "payload-compensation",
        correlationId: "payload-compensation",
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(harness.storage.size).toBe(1);
    expect(
      await payloadIntentForDelivery(
        harness.repository,
        (
          await harness.repository.getTestCommandByIdempotency(
            endpointId,
            "payload-compensation",
          )
        )?.id ?? "",
      ),
    ).toMatchObject({ state: "orphaned", attempts: 1 });
    expect(
      (await harness.repository.listTimeline({ limit: 20 })).items,
    ).toEqual([]);

    const reconciliation = await reconcileOrphanedPayloads(
      harness.repository,
      harness.storage,
    );
    expect(reconciliation).toMatchObject({
      deletedOrphanObjects: 1,
      clearedUploadIntents: 1,
      failures: [],
    });
    expect(harness.storage.size).toBe(0);
  });

  it("deletes historical payloads after capture is disabled", async () => {
    const harness = serviceHarness({ payloadRetention: false });
    const endpoint = await harness.service.createEndpoint({
      url: "http://127.0.0.1:9999/webhook",
      allowLocalNetwork: true,
      correlationId: "historical-endpoint",
    });
    await harness.storage.put({
      objectKey: "payloads/local/historical",
      bytes: Buffer.from('{"historical":true}', "utf8"),
      contentType: "application/json",
      createdAt: "2026-07-16T07:00:00.000Z",
      expiresAt: "2026-07-17T07:00:00.000Z",
    });
    await harness.repository.createPayloadUploadIntent({
      id: "historical-reference",
      uploadAttemptId: "historical-reference",
      uploadGeneration: "historical-generation",
      objectKey: "payloads/local/historical",
      contentType: "application/json",
      size: 19,
      createdAt: "2026-07-16T07:00:00.000Z",
      expiresAt: "2026-07-17T07:00:00.000Z",
      endpointId: endpoint.id,
    });
    await harness.repository.createPayloadReference({
      id: "historical-reference",
      uploadAttemptId: "historical-reference",
      uploadGeneration: "historical-generation",
      objectKey: "payloads/local/historical",
      contentType: "application/json",
      size: 19,
      createdAt: "2026-07-16T07:00:00.000Z",
      expiresAt: "2026-07-17T07:00:00.000Z",
      endpointId: endpoint.id,
    });

    await expect(
      harness.service.updateEndpoint(endpoint.id, {
        state: "deleted",
        correlationId: "historical-delete",
      }),
    ).resolves.toMatchObject({ state: "deleted" });
    expect(harness.storage.size).toBe(0);
    expect(
      await harness.repository.getPayloadReference("historical-reference"),
    ).toBeUndefined();
  });

  it("reconciles durable upload intents in bounded pages after the grace period", async () => {
    const harness = serviceHarness({ payloadRetention: false });
    for (let index = 0; index < 3; index += 1) {
      const id = `orphan-intent-${index}`;
      const objectKey = `payloads/local/orphan-${index}`;
      await harness.repository.createPayloadUploadIntent({
        id,
        uploadAttemptId: id,
        uploadGeneration: `generation-${id}`,
        objectKey,
        contentType: "application/json",
        size: 2,
        createdAt: `2026-07-16T07:00:0${index}.000Z`,
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
      await harness.storage.put({
        objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: "application/json",
        createdAt: `2026-07-16T07:00:0${index}.000Z`,
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
    }

    let cursor: PayloadReconciliationCursor | undefined;
    let deleted = 0;
    do {
      const report = await reconcileOrphanedPayloads(
        harness.repository,
        harness.storage,
        {
          now: "2026-07-16T08:00:00.000Z",
          gracePeriodMilliseconds: 1000,
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      deleted += report.deletedOrphanObjects;
      cursor = report.nextCursor;
    } while (cursor !== undefined);

    expect(deleted).toBe(3);
    expect(harness.storage.size).toBe(0);
    expect(
      (
        await harness.repository.listPayloadUploadIntents(
          "2026-07-16T09:00:00.000Z",
          10,
        )
      ).items,
    ).toEqual([]);
  });

  it("creates and persists a namespace marker only for a first empty installation", async () => {
    const repository = new InMemoryReferenceRepository();
    const storage = new InMemoryPayloadStorage();
    storage.simulateMissingBucket();

    await expect(
      ensurePayloadStorageIdentity(repository, storage, {
        clock: () => Date.parse("2026-07-16T08:00:00.000Z"),
        namespaceId: "1111111111111111111111",
        storeId: "aaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).resolves.toBe("1111111111111111111111");
    await expect(
      repository.getPayloadStorageNamespace(),
    ).resolves.toMatchObject({
      namespace: "1111111111111111111111",
      storeId: "aaaaaaaaaaaaaaaaaaaaaa",
    });
    await expect(storage.inspectIdentity()).resolves.toMatchObject({
      bucketExists: true,
      namespace: "1111111111111111111111",
      storeId: "aaaaaaaaaaaaaaaaaaaaaa",
      versioning: "unversioned",
    });

    const concurrentRepository = new InMemoryReferenceRepository();
    const concurrentStorage = new InMemoryPayloadStorage();
    concurrentStorage.simulateMissingBucket();
    await expect(
      Promise.all([
        ensurePayloadStorageIdentity(concurrentRepository, concurrentStorage, {
          namespaceId: "3333333333333333333333",
          storeId: "bbbbbbbbbbbbbbbbbbbbbb",
        }),
        ensurePayloadStorageIdentity(concurrentRepository, concurrentStorage, {
          namespaceId: "3333333333333333333333",
          storeId: "bbbbbbbbbbbbbbbbbbbbbb",
        }),
      ]),
    ).resolves.toEqual(["3333333333333333333333", "3333333333333333333333"]);

    const crashRepository = new InMemoryReferenceRepository();
    await crashRepository.initializePayloadStorageNamespace(
      "4444444444444444444444",
      "cccccccccccccccccccccc",
      "2026-07-16T08:00:00.000Z",
    );
    const crashStorage = new InMemoryPayloadStorage();
    crashStorage.simulateMissingBucket();
    await expect(
      ensurePayloadStorageIdentity(crashRepository, crashStorage, {
        namespaceId: "4444444444444444444444",
        storeId: "cccccccccccccccccccccc",
      }),
    ).resolves.toBe("4444444444444444444444");
    await expect(
      crashRepository.getPayloadStorageNamespace(),
    ).resolves.toMatchObject({ status: "ready" });

    const sharedRepository = new InMemoryReferenceRepository();
    await ensurePayloadStorageIdentity(
      sharedRepository,
      new InMemoryPayloadStorage(),
      {
        namespaceId: "7777777777777777777777",
        storeId: "dddddddddddddddddddddd",
      },
    );
    await expect(
      ensurePayloadStorageIdentity(
        sharedRepository,
        new InMemoryPayloadStorage(),
        {
          namespaceId: "7777777777777777777777",
          storeId: "eeeeeeeeeeeeeeeeeeeeee",
        },
      ),
    ).rejects.toThrow("store ID does not match");
  });

  it("fails closed on missing or mismatched storage identity without deleting references", async () => {
    const reference = {
      id: "identity-reference",
      uploadAttemptId: "identity-reference",
      uploadGeneration: "identity-generation",
      objectKey: "payloads/local/identity-reference",
      contentType: "application/json",
      size: 2,
      createdAt: "2026-07-16T07:00:00.000Z",
      expiresAt: "2026-07-17T07:00:00.000Z",
    };
    const repository = new InMemoryReferenceRepository();
    await repository.createPayloadUploadIntent(reference);
    await repository.createPayloadReference(reference);
    const missingMarkerStorage = new InMemoryPayloadStorage();
    const maintenance = startPayloadMaintenance(
      repository,
      missingMarkerStorage,
      {
        intervalMilliseconds: 60_000,
        preflight: async () => {
          await ensurePayloadStorageIdentity(repository, missingMarkerStorage, {
            namespaceId: "1111111111111111111111",
            storeId: "aaaaaaaaaaaaaaaaaaaaaa",
          });
        },
        runOnStart: false,
      },
    );

    await expect(maintenance.runNow()).rejects.toMatchObject({
      code: "PAYLOAD_STORAGE_MARKER_MISSING",
    });
    expect(maintenance.status()).toMatchObject({ degraded: true });
    expect(await repository.getPayloadReference(reference.id)).toBeDefined();
    await maintenance.stop();

    const persisted = new InMemoryReferenceRepository();
    await persisted.initializePayloadStorageNamespace(
      "1111111111111111111111",
      "aaaaaaaaaaaaaaaaaaaaaa",
      "2026-07-16T08:00:00.000Z",
    );
    await persisted.markPayloadStorageNamespaceReady(
      "1111111111111111111111",
      "aaaaaaaaaaaaaaaaaaaaaa",
      "2026-07-16T08:00:00.000Z",
    );
    const missingBucket = new InMemoryPayloadStorage();
    missingBucket.simulateMissingBucket();
    await expect(
      ensurePayloadStorageIdentity(persisted, missingBucket, {
        namespaceId: "1111111111111111111111",
        storeId: "aaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_STORAGE_BUCKET_MISSING" });

    const wrongBucket = new InMemoryPayloadStorage();
    await wrongBucket.initializeIdentity(
      "2222222222222222222222",
      "dddddddddddddddddddddd",
    );
    await expect(
      ensurePayloadStorageIdentity(persisted, wrongBucket, {
        namespaceId: "1111111111111111111111",
        storeId: "aaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_STORAGE_NAMESPACE_MISMATCH" });

    const freshRepository = new InMemoryReferenceRepository();
    const foreignBucket = new InMemoryPayloadStorage();
    await foreignBucket.initializeIdentity(
      "5555555555555555555555",
      "eeeeeeeeeeeeeeeeeeeeee",
    );
    await expect(
      ensurePayloadStorageIdentity(freshRepository, foreignBucket, {
        namespaceId: "1111111111111111111111",
        storeId: "aaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_STORAGE_NAMESPACE_MISMATCH" });
    await expect(
      freshRepository.getPayloadStorageNamespace(),
    ).resolves.toMatchObject({
      namespace: "1111111111111111111111",
      status: "binding",
    });
  });

  it("rejects enabled and suspended bucket versioning before reconciliation", async () => {
    for (const versioning of ["enabled", "suspended"] as const) {
      const repository = new InMemoryReferenceRepository();
      const storage = new InMemoryPayloadStorage();
      storage.setVersioning(versioning);
      await expect(
        ensurePayloadStorageIdentity(repository, storage, {
          namespaceId: "1111111111111111111111",
          storeId: "aaaaaaaaaaaaaaaaaaaaaa",
        }),
      ).rejects.toBeInstanceOf(PayloadStorageIdentityError);
      await expect(
        repository.getPayloadStorageNamespace(),
      ).resolves.toMatchObject({
        namespace: "1111111111111111111111",
        status: "binding",
      });
    }
  });

  it("exposes startup and periodic payload maintenance state", async () => {
    const harness = serviceHarness({ payloadRetention: false });
    const maintenance = startPayloadMaintenance(
      harness.repository,
      harness.storage,
      {
        clock: () => Date.parse("2026-07-16T08:00:00.000Z"),
        intervalMilliseconds: 60_000,
        runOnStart: false,
      },
    );
    const report = await maintenance.runNow();
    expect(report.failureCount).toBe(0);
    expect(maintenance.status()).toMatchObject({
      running: false,
      lastReport: { startedAt: "2026-07-16T08:00:00.000Z" },
    });
    await maintenance.stop();
  });

  it("finishes independent paginated streams after a transient object-list failure and recovers after a clean cycle", async () => {
    const repository = new TrackingReferenceRepository();
    const storage = new TransientListPayloadStorage();
    for (const suffix of ["a", "b"]) {
      const objectKey = `payloads/local/cycle-${suffix}`;
      await storage.put({
        objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: "application/json",
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
      await repository.createPayloadUploadIntent({
        id: `cycle-ref-${suffix}`,
        uploadAttemptId: `cycle-ref-${suffix}`,
        uploadGeneration: `cycle-generation-${suffix}`,
        objectKey,
        contentType: "application/json",
        size: 2,
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
      await repository.createPayloadReference({
        id: `cycle-ref-${suffix}`,
        uploadAttemptId: `cycle-ref-${suffix}`,
        uploadGeneration: `cycle-generation-${suffix}`,
        objectKey,
        contentType: "application/json",
        size: 2,
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
    }
    const maintenance = startPayloadMaintenance(repository, storage, {
      batchSize: 1,
      clock: () => Date.parse("2026-07-16T08:00:00.000Z"),
      gracePeriodMilliseconds: 1000,
      intervalMilliseconds: 60_000,
      runOnStart: false,
    });

    const failedPage = await maintenance.runNow();
    expect(failedPage).toMatchObject({
      cycleCompleted: false,
      failureCount: 1,
      nextCursor: {
        cleanup: { exhausted: true },
        expiry: { exhausted: true },
        reconciliation: {
          exhausted: false,
          cursor: {
            objects: { exhausted: false },
            references: { exhausted: false, cursor: "cycle-ref-a" },
            uploadIntents: { exhausted: true },
          },
        },
      },
    });
    expect(maintenance.status()).toMatchObject({ degraded: true });

    await maintenance.runNow();
    const failedCycleCompleted = await maintenance.runNow();
    expect(failedCycleCompleted.cycleCompleted).toBe(true);
    expect(maintenance.status()).toMatchObject({
      degraded: true,
      lastFailureCount: 1,
    });

    await maintenance.runNow();
    const cleanCycleCompleted = await maintenance.runNow();
    expect(cleanCycleCompleted).toMatchObject({
      cycleCompleted: true,
      failureCount: 0,
    });
    expect(maintenance.status()).toMatchObject({ degraded: false });
    expect(maintenance.status().lastFailureCount).toBeUndefined();
    expect(storage.listCursors).toEqual([
      undefined,
      undefined,
      "payloads/local/cycle-a",
      undefined,
      "payloads/local/cycle-a",
    ]);
    expect(repository.referenceCursors).toEqual([
      undefined,
      "cycle-ref-a",
      undefined,
      "cycle-ref-a",
    ]);
    await maintenance.stop();
  });

  it("completes zero-item cycles and restarts every stream from its boundary", async () => {
    const repository = new TrackingReferenceRepository();
    const storage = new TransientListPayloadStorage();
    await expect(storage.listObjects("payloads/", 1)).rejects.toThrow(
      "transient object listing failure",
    );
    storage.listCursors.length = 0;
    const maintenance = startPayloadMaintenance(repository, storage, {
      batchSize: 1,
      clock: () => Date.parse("2026-07-16T08:00:00.000Z"),
      intervalMilliseconds: 60_000,
      runOnStart: false,
    });

    await expect(maintenance.runNow()).resolves.toMatchObject({
      cycleCompleted: true,
      failureCount: 0,
    });
    await expect(maintenance.runNow()).resolves.toMatchObject({
      cycleCompleted: true,
      failureCount: 0,
    });
    expect(storage.listCursors).toEqual([undefined, undefined]);
    expect(repository.referenceCursors).toEqual([undefined, undefined]);
    await maintenance.stop();
  });

  it("uses code-unit ordering for memory pagination across persistence streams", async () => {
    const repository = new InMemoryReferenceRepository();
    const storage = new InMemoryPayloadStorage();
    const values = ["B", "a", "é", "Ω", "😀"];
    const endpoint = await repository.createEndpoint({
      id: "pagination-endpoint",
      createdAt: "2026-07-16T08:00:00.000Z",
      url: "https://example.com/pagination",
      allowLocalNetwork: false,
    });
    for (const value of values) {
      await repository.createPayloadUploadIntent({
        id: value,
        uploadAttemptId: value,
        uploadGeneration: `intent-generation-${value}`,
        objectKey: `payloads/intents/${value}`,
        contentType: "application/json",
        size: 2,
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
      await repository.claimPayloadCleanup({
        objectKey: `claims/${value}`,
        claimId: `claim-${value}`,
        reason: "legacy_orphan",
        timestamp: "2026-07-16T07:00:00.000Z",
        leaseExpiresAt: "2026-07-16T07:00:01.000Z",
      });
      const taskAttemptId = `task-${value}`;
      const taskObjectKey = `payloads/tasks/${value}`;
      await repository.createPayloadUploadIntent({
        id: taskAttemptId,
        uploadAttemptId: taskAttemptId,
        uploadGeneration: `task-generation-${value}`,
        objectKey: taskObjectKey,
        contentType: "application/json",
        size: 2,
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
        endpointId: endpoint.id,
      });
      await repository.createPayloadReference({
        id: taskAttemptId,
        uploadAttemptId: taskAttemptId,
        uploadGeneration: `task-generation-${value}`,
        objectKey: taskObjectKey,
        contentType: "application/json",
        size: 2,
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
        endpointId: endpoint.id,
      });
      await storage.put({
        objectKey: `objects/${value}`,
        bytes: Buffer.from("{}", "utf8"),
        contentType: "application/json",
        createdAt: "2026-07-16T07:00:00.000Z",
        expiresAt: "2026-07-17T07:00:00.000Z",
      });
    }
    await repository.deleteEndpointData(
      endpoint.id,
      "2026-07-16T08:00:00.000Z",
    );

    const intentIds: string[] = [];
    let intentCursor: string | undefined;
    do {
      const page = await repository.listPayloadUploadIntents(
        "2026-07-16T08:00:00.000Z",
        1,
        intentCursor,
      );
      intentIds.push(...page.items.map((item) => item.id));
      intentCursor = page.nextCursor;
    } while (intentCursor !== undefined);
    expect(intentIds).toEqual(values);

    const claimKeys: string[] = [];
    let claimCursor: string | undefined;
    do {
      const page = await repository.listExpiredPayloadCleanupClaims(
        "2026-07-16T08:00:00.000Z",
        1,
        claimCursor,
      );
      claimKeys.push(...page.items.map((item) => item.objectKey));
      claimCursor = page.nextCursor;
    } while (claimCursor !== undefined);
    expect(claimKeys).toEqual(values.map((value) => `claims/${value}`));

    const taskIds: string[] = [];
    let taskCursor: string | undefined;
    while (true) {
      const page = await repository.listPayloadCleanupTasks(
        1,
        endpoint.id,
        taskCursor,
      );
      const task = page[0];
      if (task === undefined) {
        break;
      }
      taskIds.push(task.id);
      taskCursor = task.id;
    }
    expect(taskIds).toEqual(values.map((value) => `endpoint:task-${value}`));

    const objectKeys: string[] = [];
    let objectCursor: string | undefined;
    do {
      const page = await storage.listObjects("objects/", 1, objectCursor);
      objectKeys.push(...page.items.map((item) => item.objectKey));
      objectCursor = page.nextCursor;
    } while (objectCursor !== undefined);
    expect(objectKeys).toEqual(values.map((value) => `objects/${value}`));
  });

  it("exposes sweep failures and clears timeline retention only after reference deletion", async () => {
    const harness = serviceHarness({ payloadRetention: true });
    await importAndPublish(harness, ["order.created"], "sweep-release");
    const endpointId = await setupEndpoint(harness);
    const command = await harness.service.sendTest({
      endpointId,
      eventType: "order.created",
      idempotencyKey: "sweep-command",
      correlationId: "sweep-command",
    });
    harness.storage.failDelete = true;

    const failed = await sweepExpiredPayloads(
      harness.repository,
      harness.storage,
      "2026-07-16T10:00:00.000Z",
    );
    expect(failed).toMatchObject({
      scanned: 1,
      deleted: 0,
      failures: [{ operation: "delete_object" }],
    });
    expect(
      (
        await harness.repository.listTimeline({
          deliveryId: command.id,
          limit: 1,
        })
      ).items[0],
    ).toMatchObject({ payloadRetained: true });

    const succeeded = await sweepExpiredPayloads(
      harness.repository,
      harness.storage,
      "2026-07-16T10:00:00.000Z",
    );
    expect(succeeded).toMatchObject({
      scanned: 1,
      deleted: 1,
      failures: [],
    });
    expect(
      (
        await harness.repository.listTimeline({
          deliveryId: command.id,
          limit: 1,
        })
      ).items[0],
    ).toMatchObject({ payloadRetained: false });
  });

  it("supports an explicit object-store lifecycle safety net", async () => {
    const storage = new InMemoryPayloadStorage();
    await storage.configureLifecycle({
      prefix: "payloads/",
      expireAfterDays: 1,
      abortIncompleteMultipartAfterDays: 1,
    });

    expect(storage.lifecyclePolicy).toEqual({
      prefix: "payloads/",
      expireAfterDays: 1,
      abortIncompleteMultipartAfterDays: 1,
    });
  });

  it("uses explicit API errors for immutable deleted endpoints", () => {
    const error = new ReferenceApiError(410, "ENDPOINT_DELETED", "deleted");
    expect(error).toMatchObject({
      statusCode: 410,
      code: "ENDPOINT_DELETED",
    });
  });

  it("maps invalid repository cursors to a stable client error", async () => {
    const harness = serviceHarness();
    await expect(
      harness.service.listTimeline({
        limit: 20,
        cursor: "not+an+opaque+cursor",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CURSOR",
      statusCode: 400,
    });
  });
});
