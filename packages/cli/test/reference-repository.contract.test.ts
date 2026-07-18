// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  DEFAULT_ADAPTER_MAPPING_VERSION,
  canonicalizeMetadataRecord,
  type MetadataDeliveryAttemptInput,
} from "@webhook-portal/adapter-sdk";
import { canonicalize } from "@webhook-portal/contract-core";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AesGcmSecretCipher,
  DEFAULT_REFERENCE_SERVER_CONFIG,
  EXPECTED_REFERENCE_SCHEMA_VERSION,
  InMemoryPayloadStorage,
  InMemoryReferenceRepository,
  PayloadCleanupConflictError,
  PostgresReferenceRepository,
  ReferenceService,
  RepositoryCommitUncertainError,
  migratePostgres,
  reconcileOrphanedPayloads,
  type CreatePayloadUploadIntentInput,
  type ContractImportRecord,
  type ReferenceRepository,
  type ReferenceServerConfig,
} from "../src/reference-server/index.js";

interface RepositoryHarness {
  readonly repository: ReferenceRepository;
  close(): Promise<void>;
}

type RepositoryFactory = () => Promise<RepositoryHarness>;

const timestamp = "2026-07-16T08:00:00.000Z";

class ControlledDeletePayloadStorage extends InMemoryPayloadStorage {
  readonly deleteStarted: Promise<void>;
  failDelete = false;
  #signalDeleteStarted!: () => void;
  #releaseDelete!: () => void;
  readonly #deleteMayFinish: Promise<void>;

  constructor() {
    super();
    this.deleteStarted = new Promise((resolve) => {
      this.#signalDeleteStarted = resolve;
    });
    this.#deleteMayFinish = new Promise((resolve) => {
      this.#releaseDelete = resolve;
    });
  }

  releaseDelete(): void {
    this.#releaseDelete();
  }

  override async delete(objectKey: string): Promise<void> {
    this.#signalDeleteStarted();
    await this.#deleteMayFinish;
    if (this.failDelete) {
      throw new Error("injected cleanup delete failure");
    }
    await super.delete(objectKey);
  }
}

class DeleteThenThrowPayloadStorage extends InMemoryPayloadStorage {
  override async delete(objectKey: string): Promise<void> {
    await super.delete(objectKey);
    throw new Error("delete acknowledgement lost");
  }
}

class UnknownDeletePayloadStorage extends InMemoryPayloadStorage {
  override async delete(): Promise<void> {
    throw new Error("delete outcome unknown");
  }

  override async exists(): Promise<boolean> {
    throw new Error("object inspection unavailable");
  }
}

function payloadReference(
  id: string,
  objectKey: string,
): CreatePayloadUploadIntentInput {
  return {
    id,
    uploadAttemptId: id,
    uploadGeneration: `generation-${id}`,
    objectKey,
    contentType: "application/json",
    size: 2,
    createdAt: timestamp,
    expiresAt: "2026-07-17T08:00:00.000Z",
  };
}

function metadataRecord(
  status: MetadataDeliveryAttemptInput["status"],
  sequence: number,
  providerAttemptId: string,
  deliveryId = "delivery-contract",
  endpointId = "endpoint-contract",
) {
  return canonicalizeMetadataRecord(
    {
      attempt: 1,
      deliveryId,
      endpointId,
      eventId: `event-${deliveryId}`,
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
      occurredAt: new Date(
        Date.parse(timestamp) + sequence * 1000,
      ).toISOString(),
      providerAttemptId,
      schemaVersion: "2026-07-01",
      sequence,
      status,
    },
    {
      adapterId: "generic-http",
      connectionId: "contract",
      environment: "test",
      tenantId: "local",
    },
  );
}

function contractImport(
  id: string,
  eventTypes: readonly string[],
  largeExample?: string,
): ContractImportRecord {
  const source = JSON.stringify({
    openapi: "3.1.0",
    info: { title: id, version: "1.0.0" },
    webhooks: Object.fromEntries(
      eventTypes.map((eventType) => [
        eventType,
        {
          post: {
            "x-event-type": eventType,
            "x-event-version": "1",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    ...(largeExample === undefined
                      ? {}
                      : {
                          properties: { blob: { type: "string" } },
                          required: ["blob"],
                        }),
                  },
                  example:
                    largeExample === undefined ? {} : { blob: largeExample },
                },
              },
            },
            responses: { "204": { description: "Accepted" } },
          },
        },
      ]),
    ),
  });
  const result = canonicalize(source, { formatHint: "json" });
  if (
    result.status !== "valid" ||
    result.contract === undefined ||
    result.export === undefined
  ) {
    throw new Error("Repository contract fixture is invalid.");
  }

  return {
    id,
    createdAt: timestamp,
    source,
    sourceMediaType: "application/json",
    status: result.status,
    diagnostics: result.diagnostics,
    contract: result.contract,
    canonicalExport: result.export,
  };
}

function largeContractImport(id: string): ContractImportRecord {
  const description = "x".repeat(405_000);
  const source = JSON.stringify({
    openapi: "3.1.0",
    info: { title: id, version: "1.0.0" },
    webhooks: Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `order.event.${index}`,
        {
          post: {
            description,
            "x-event-id": `order-event-${index}`,
            "x-event-type": `order.event.${index}`,
            "x-event-version": "1",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                  },
                },
              },
            },
            responses: { "204": { description: "Accepted" } },
          },
        },
      ]),
    ),
  });
  const result = canonicalize(source, {
    formatHint: "json",
    limits: { maxInputBytes: 4 * 1024 * 1024 },
  });
  if (
    result.status !== "valid" ||
    result.contract === undefined ||
    result.export === undefined
  ) {
    throw new Error("Large repository contract fixture is invalid.");
  }
  return {
    id,
    createdAt: timestamp,
    source,
    sourceMediaType: "application/json",
    status: result.status,
    diagnostics: result.diagnostics,
    contract: result.contract,
    canonicalExport: result.export,
  };
}

async function createEndpoint(repository: ReferenceRepository): Promise<void> {
  await repository.createEndpoint({
    id: "endpoint-contract",
    createdAt: timestamp,
    url: "https://example.com/webhook",
    allowLocalNetwork: false,
  });
}

function defineRepositoryContract(
  label: string,
  factory: RepositoryFactory,
): void {
  describe(`${label} reference repository contract`, () => {
    let harness: RepositoryHarness;

    beforeEach(async () => {
      harness = await factory();
    });

    afterEach(async () => {
      await harness.close();
    });

    it("rolls back state, audit, and outbox together", async () => {
      await expect(
        harness.repository.transaction(async (repository) => {
          await repository.createEndpoint({
            id: "rollback-endpoint",
            createdAt: timestamp,
            url: "https://example.com/rollback",
            allowLocalNetwork: false,
          });
          await repository.appendAudit({
            id: "rollback-audit",
            createdAt: timestamp,
            action: "endpoint.create",
            resourceType: "endpoint",
            resourceId: "rollback-endpoint",
            result: "success",
            actorId: "test",
            correlationId: "rollback",
          });
          await repository.appendOutbox({
            id: "rollback-outbox",
            createdAt: timestamp,
            topic: "endpoint.created",
            aggregateType: "endpoint",
            aggregateId: "rollback-endpoint",
            correlationId: "rollback",
          });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      expect(
        await harness.repository.getEndpoint("rollback-endpoint"),
      ).toBeUndefined();
      expect(await harness.repository.listAudit(10)).toEqual([]);
      expect(await harness.repository.listOutbox(10)).toEqual([]);
    });

    it("serializes release activation so each publisher sees the committed predecessor", async () => {
      const firstImport = contractImport("import-first", ["order.created"]);
      const secondImport = contractImport("import-second", [
        "order.created",
        "order.cancelled",
      ]);
      await harness.repository.createContractImport(firstImport);
      await harness.repository.createContractImport(secondImport);
      const predecessors: Array<string | undefined> = [];
      let releaseFirst!: () => void;
      const firstMayPublish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstLocked!: () => void;
      const firstHasLock = new Promise<void>((resolve) => {
        firstLocked = resolve;
      });
      const first = harness.repository.transaction(async (repository) => {
        predecessors.push((await repository.lockReleaseState())?.id);
        firstLocked();
        await firstMayPublish;
        await repository.publishRelease({
          id: "release-first",
          importRecord: firstImport,
          changelog: {
            summary: "first",
            status: "initial",
            changes: [],
          },
          createdAt: timestamp,
        });
      });
      await firstHasLock;
      const second = harness.repository.transaction(async (repository) => {
        predecessors.push((await repository.lockReleaseState())?.id);
        await repository.publishRelease({
          id: "release-second",
          importRecord: secondImport,
          changelog: {
            summary: "second",
            status: "compatible",
            changes: [],
          },
          createdAt: "2026-07-16T08:00:01.000Z",
        });
      });
      releaseFirst();
      await Promise.all([first, second]);

      expect(predecessors).toEqual([undefined, "release-first"]);
      expect(await harness.repository.listReleases()).toMatchObject([
        { id: "release-second", sequence: 2, active: true },
        { id: "release-first", sequence: 1, active: false },
      ]);
    });

    it("paginates compact release metadata without returning full contracts", async () => {
      const firstImport = contractImport("metadata-import-first", [
        "order.created",
      ]);
      const secondImport = contractImport("metadata-import-second", [
        "order.created",
        "order.cancelled",
      ]);
      await harness.repository.createContractImport(firstImport);
      await harness.repository.createContractImport(secondImport);
      await harness.repository.publishRelease({
        id: "metadata-release-first",
        importRecord: firstImport,
        changelog: {
          summary: "first",
          status: "initial",
          changes: [],
        },
        createdAt: timestamp,
      });
      await harness.repository.publishRelease({
        id: "metadata-release-second",
        importRecord: secondImport,
        changelog: {
          summary: "second",
          status: "compatible",
          changes: [],
        },
        createdAt: "2026-07-16T08:00:01.000Z",
      });

      const firstPage = await harness.repository.listReleaseMetadataPage(1);
      expect(firstPage).toMatchObject({
        items: [
          {
            id: "metadata-release-second",
            sequence: 2,
            status: "active",
          },
        ],
        nextBeforeSequence: 2,
      });
      expect(JSON.stringify(firstPage)).not.toContain('"contract"');
      expect(JSON.stringify(firstPage)).not.toContain('"canonicalExport"');
      await expect(
        harness.repository.listReleaseMetadataPage(
          1,
          firstPage.nextBeforeSequence,
        ),
      ).resolves.toMatchObject({
        items: [
          {
            id: "metadata-release-first",
            sequence: 1,
            status: "superseded",
          },
        ],
      });
    });

    it("creates an immutable minimal tombstone and removes endpoint data", async () => {
      await createEndpoint(harness.repository);
      await harness.repository.setSubscription({
        id: "subscription-contract",
        endpointId: "endpoint-contract",
        eventTypes: ["order.created"],
        state: "active",
        timestamp,
      });
      await harness.repository.createSecretVersion({
        id: "secret-contract",
        endpointId: "endpoint-contract",
        encryptedValue: {
          algorithm: "aes-256-gcm",
          ciphertext: "ciphertext",
          iv: "iv",
          tag: "tag",
        },
        state: "active",
        timestamp,
      });
      await harness.repository.ingestMetadata(
        [metadataRecord("delivered", 1, "provider-delete")],
        timestamp,
      );
      await harness.repository.createPayloadUploadIntent({
        id: "payload-contract",
        uploadAttemptId: "payload-contract",
        uploadGeneration: "payload-contract-generation",
        objectKey: "payloads/local/delete-me",
        contentType: "application/json",
        size: 10,
        createdAt: timestamp,
        expiresAt: "2026-07-17T08:00:00.000Z",
        deliveryId: "delivery-contract",
      });
      await harness.repository.createPayloadReference({
        id: "payload-contract",
        uploadAttemptId: "payload-contract",
        uploadGeneration: "payload-contract-generation",
        objectKey: "payloads/local/delete-me",
        contentType: "application/json",
        size: 10,
        createdAt: timestamp,
        expiresAt: "2026-07-17T08:00:00.000Z",
        deliveryId: "delivery-contract",
      });
      await harness.repository.createPayloadUploadIntent({
        id: "payload-upload-contract",
        uploadAttemptId: "payload-upload-contract",
        uploadGeneration: "generation-payload-upload-contract",
        objectKey: "payloads/local/upload-in-progress",
        contentType: "application/json",
        size: 10,
        createdAt: timestamp,
        expiresAt: "2026-07-17T08:00:00.000Z",
        endpointId: "endpoint-contract",
        deliveryId: "delivery-upload-contract",
      });

      const deleted = await harness.repository.transaction(async (repository) =>
        repository.deleteEndpointData(
          "endpoint-contract",
          "2026-07-16T09:00:00.000Z",
        ),
      );

      expect(deleted).toMatchObject({
        newlyDeleted: true,
        endpoint: {
          id: "endpoint-contract",
          state: "deleted",
          tombstoneVersion: 1,
        },
        cleanupTasks: [
          {
            objectKey: "payloads/local/delete-me",
            reason: "endpoint_deleted",
          },
          {
            objectKey: "payloads/local/upload-in-progress",
            reason: "endpoint_deleted",
          },
        ],
      });
      expect(JSON.stringify(deleted?.endpoint)).not.toContain("example.com");
      expect(
        await harness.repository.getSubscription("endpoint-contract"),
      ).toBeUndefined();
      expect(
        await harness.repository.listSecretVersions("endpoint-contract"),
      ).toEqual([]);
      expect(
        await harness.repository.getPayloadReference("payload-contract"),
      ).toBeUndefined();
      expect(
        await harness.repository.getPayloadUploadIntent(
          "payload-upload-contract",
        ),
      ).toMatchObject({ state: "orphaned" });
      expect(
        (await harness.repository.listTimeline({ limit: 10 })).items,
      ).toEqual([]);

      const attemptedResurrection = await harness.repository.updateEndpoint(
        "endpoint-contract",
        {
          updatedAt: "2026-07-16T10:00:00.000Z",
          state: "active",
          url: "https://example.com/resurrected",
        },
      );
      expect(attemptedResurrection).toMatchObject({ state: "deleted" });
      expect(JSON.stringify(attemptedResurrection)).not.toContain(
        "resurrected",
      );
      await expect(
        harness.repository.ingestMetadata(
          [metadataRecord("delivered", 2, "provider-after-delete")],
          "2026-07-16T10:00:00.000Z",
        ),
      ).rejects.toThrow("deleted endpoint");
    });

    it("allows at most one active secret during a race", async () => {
      await createEndpoint(harness.repository);
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          harness.repository.transaction(async (repository) => {
            await repository.lockEndpoint("endpoint-contract");
            return repository.createSecretVersion({
              id: `secret-race-${index}`,
              endpointId: "endpoint-contract",
              encryptedValue: {
                algorithm: "aes-256-gcm",
                ciphertext: `ciphertext-${index}`,
                iv: "iv",
                tag: "tag",
              },
              state: "active",
              timestamp,
            });
          }),
        ),
      );

      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (
          await harness.repository.listSecretVersions("endpoint-contract")
        ).filter((secret) => secret.state === "active"),
      ).toHaveLength(1);
    });

    it("serializes concurrent first observations on full delivery identity", async () => {
      const attempting = metadataRecord("attempting", 1, "provider-first");
      const delivered = metadataRecord("delivered", 2, "provider-terminal");

      const summaries = await Promise.all([
        harness.repository.ingestMetadata([attempting], timestamp),
        harness.repository.ingestMetadata(
          [delivered],
          "2026-07-16T08:00:01.000Z",
        ),
      ]);
      const timeline = await harness.repository.listTimeline({ limit: 10 });

      expect(
        summaries.reduce((total, summary) => total + summary.accepted, 0),
      ).toBe(2);
      expect(timeline.items).toHaveLength(1);
      expect(timeline.items[0]).toMatchObject({
        current: { status: "delivered", sequence: 2 },
        observationCount: 2,
      });
    });

    it("deduplicates a concurrent first-observation storm", async () => {
      const record = metadataRecord("attempting", 1, "provider-duplicate");
      const summaries = await Promise.all(
        Array.from({ length: 20 }, () =>
          harness.repository.ingestMetadata([record], timestamp),
        ),
      );

      expect(
        summaries.reduce((total, summary) => total + summary.accepted, 0),
      ).toBe(1);
      expect(
        (await harness.repository.listTimeline({ limit: 10 })).items[0],
      ).toMatchObject({ observationCount: 1 });
    });

    it("uses shared opaque cursor validation without restarting invalid pages", async () => {
      await harness.repository.ingestMetadata(
        [
          metadataRecord(
            "delivered",
            1,
            "provider-cursor-a",
            "delivery-cursor-a",
          ),
          metadataRecord(
            "delivered",
            1,
            "provider-cursor-b",
            "delivery-cursor-b",
          ),
        ],
        timestamp,
      );
      const first = await harness.repository.listTimeline({ limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBeDefined();
      const cursor = first.nextCursor;
      if (cursor === undefined) {
        throw new Error("Expected a cursor for the second timeline page.");
      }
      const second = await harness.repository.listTimeline({
        limit: 1,
        cursor,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.deliveryId).not.toBe(first.items[0]?.deliveryId);

      for (const cursor of [
        "not+base64",
        Buffer.from("missing-separator", "utf8").toString("base64url"),
        "a".repeat(513),
      ]) {
        await expect(
          harness.repository.listTimeline({ limit: 1, cursor }),
        ).rejects.toMatchObject({
          code: "INVALID_CURSOR",
          name: "InvalidTimelineCursorError",
        });
      }
    });

    it("fences evidence attachment while reconciliation owns object deletion and supports deterministic re-upload", async () => {
      const storage = new ControlledDeletePayloadStorage();
      const reference = payloadReference(
        "payload-claim-race",
        "payloads/local/claim-race",
      );
      await harness.repository.createPayloadUploadIntent(reference);
      await storage.put({
        objectKey: reference.objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: reference.contentType,
        createdAt: reference.createdAt,
        expiresAt: reference.expiresAt,
      });

      const reconciliation = reconcileOrphanedPayloads(
        harness.repository,
        storage,
        {
          claimIdFactory: () => "cleanup-claim-race",
          cleanupLeaseMilliseconds: 60_000,
          gracePeriodMilliseconds: 1000,
          limit: 10,
          now: "2026-07-16T09:00:00.000Z",
        },
      );
      await storage.deleteStarted;
      await expect(
        harness.repository.createPayloadReference(reference),
      ).rejects.toBeInstanceOf(PayloadCleanupConflictError);

      storage.releaseDelete();
      await expect(reconciliation).resolves.toMatchObject({
        deletedOrphanObjects: 1,
        clearedUploadIntents: 1,
        failures: [],
      });
      await expect(
        harness.repository.getPayloadCleanupClaim(reference.objectKey),
      ).resolves.toMatchObject({ state: "deleted", generation: 1 });
      expect(await storage.exists(reference.objectKey)).toBe(false);
      expect(
        await harness.repository.getPayloadReference(reference.id),
      ).toBeUndefined();

      await expect(
        harness.repository.createPayloadUploadIntent(reference),
      ).rejects.toMatchObject({
        code: "PAYLOAD_CLEANUP_IN_PROGRESS",
        state: "deleted",
      });
      const replacement = payloadReference(
        "payload-claim-race-replacement",
        "payloads/local/claim-race-replacement",
      );
      await harness.repository.createPayloadUploadIntent(replacement);
      await storage.put({
        objectKey: replacement.objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: replacement.contentType,
        createdAt: replacement.createdAt,
        expiresAt: replacement.expiresAt,
      });
      await harness.repository.createPayloadReference(replacement);
      await harness.repository.completePayloadUploadIntent(
        replacement.id,
        replacement.uploadGeneration,
      );
      expect(
        await harness.repository.getPayloadReference(replacement.id),
      ).toEqual(replacement);
      expect(await storage.exists(replacement.objectKey)).toBe(true);
      expect(
        await harness.repository.getPayloadCleanupClaim(replacement.objectKey),
      ).toBeUndefined();
    });

    it("fences a delayed expired worker to its old object generation while newer evidence survives", async () => {
      const storage = new ControlledDeletePayloadStorage();
      const oldAttempt = payloadReference(
        "payload-expired-worker-old",
        "payloads/local/expired-worker-old",
      );
      await harness.repository.createPayloadUploadIntent(oldAttempt);
      await storage.put({
        objectKey: oldAttempt.objectKey,
        bytes: Buffer.from('{"generation":"old"}', "utf8"),
        contentType: oldAttempt.contentType,
        createdAt: oldAttempt.createdAt,
        expiresAt: oldAttempt.expiresAt,
      });
      const oldWorker = reconcileOrphanedPayloads(harness.repository, storage, {
        claimIdFactory: () => "expired-worker-one",
        cleanupLeaseMilliseconds: 1000,
        gracePeriodMilliseconds: 1000,
        limit: 10,
        now: "2026-07-16T09:00:00.000Z",
      });
      await storage.deleteStarted;

      const takeover = await harness.repository.claimPayloadCleanup({
        objectKey: oldAttempt.objectKey,
        claimId: "expired-worker-two",
        reason: "stale_upload_intent",
        timestamp: "2026-07-16T09:00:02.000Z",
        leaseExpiresAt: "2026-07-16T09:00:03.000Z",
        uploadIntentId: oldAttempt.id,
        uploadGeneration: oldAttempt.uploadGeneration,
      });
      expect(takeover).toMatchObject({
        status: "claimed",
        claim: { generation: 2, state: "deleting" },
      });
      if (takeover.status !== "claimed") {
        throw new Error("Expected the expired cleanup takeover.");
      }

      const replacement = payloadReference(
        "payload-expired-worker-new",
        "payloads/local/expired-worker-new",
      );
      await harness.repository.createPayloadUploadIntent(replacement);
      await storage.put({
        objectKey: replacement.objectKey,
        bytes: Buffer.from('{"generation":"new"}', "utf8"),
        contentType: replacement.contentType,
        createdAt: "2026-07-16T09:00:02.000Z",
        expiresAt: replacement.expiresAt,
      });
      await harness.repository.createPayloadReference(replacement);
      await harness.repository.completePayloadUploadIntent(
        replacement.id,
        replacement.uploadGeneration,
      );

      storage.releaseDelete();
      await expect(oldWorker).resolves.toMatchObject({
        failures: [{ operation: "finalize_cleanup_deletion" }],
      });
      expect(await storage.exists(replacement.objectKey)).toBe(true);
      expect(
        await harness.repository.getPayloadReference(replacement.id),
      ).toEqual(replacement);

      await harness.repository.beginPayloadCleanupDeletion({
        objectKey: oldAttempt.objectKey,
        claimId: takeover.claim.claimId,
        generation: takeover.claim.generation,
        timestamp: "2026-07-16T09:00:02.100Z",
        leaseExpiresAt: "2026-07-16T09:00:03.100Z",
        uploadIntentId: oldAttempt.id,
        uploadGeneration: oldAttempt.uploadGeneration,
      });
      await storage.delete(oldAttempt.objectKey);
      await expect(
        harness.repository.finalizePayloadCleanupDeletion({
          objectKey: oldAttempt.objectKey,
          claimId: takeover.claim.claimId,
          generation: takeover.claim.generation,
          timestamp: "2026-07-16T09:00:02.200Z",
          uploadIntentId: oldAttempt.id,
          uploadGeneration: oldAttempt.uploadGeneration,
        }),
      ).resolves.toBe(true);
      expect(await storage.exists(replacement.objectKey)).toBe(true);
    });

    it("retains a fenced deleting claim after an ambiguous failure and retries after lease expiry", async () => {
      const storage = new ControlledDeletePayloadStorage();
      storage.failDelete = true;
      const reference = payloadReference(
        "payload-claim-failure",
        "payloads/local/claim-failure",
      );
      await harness.repository.createPayloadUploadIntent(reference);
      await storage.put({
        objectKey: reference.objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: reference.contentType,
        createdAt: reference.createdAt,
        expiresAt: reference.expiresAt,
      });

      const reconciliation = reconcileOrphanedPayloads(
        harness.repository,
        storage,
        {
          claimIdFactory: () => "cleanup-claim-failure",
          cleanupLeaseMilliseconds: 60_000,
          gracePeriodMilliseconds: 1000,
          limit: 10,
          now: "2026-07-16T09:00:00.000Z",
        },
      );
      await storage.deleteStarted;
      storage.releaseDelete();
      await expect(reconciliation).resolves.toMatchObject({
        deletedOrphanObjects: 0,
        failures: [{ operation: "delete_object" }],
      });
      expect(
        await harness.repository.getPayloadCleanupClaim(reference.objectKey),
      ).toMatchObject({ state: "deleting", generation: 1 });
      await expect(
        harness.repository.createPayloadReference(reference),
      ).rejects.toBeInstanceOf(PayloadCleanupConflictError);

      storage.failDelete = false;
      await expect(
        reconcileOrphanedPayloads(harness.repository, storage, {
          claimIdFactory: () => "cleanup-claim-failure-retry",
          cleanupLeaseMilliseconds: 60_000,
          gracePeriodMilliseconds: 1000,
          limit: 10,
          now: "2026-07-16T09:02:00.000Z",
        }),
      ).resolves.toMatchObject({
        deletedOrphanObjects: 1,
        failures: [],
      });
      const replacement = payloadReference(
        "payload-claim-failure-replacement",
        "payloads/local/claim-failure-replacement",
      );
      await harness.repository.createPayloadUploadIntent(replacement);
      await storage.put({
        objectKey: replacement.objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: replacement.contentType,
        createdAt: replacement.createdAt,
        expiresAt: replacement.expiresAt,
      });
      await harness.repository.createPayloadReference(replacement);
      await harness.repository.completePayloadUploadIntent(
        replacement.id,
        replacement.uploadGeneration,
      );
      expect(await storage.exists(reference.objectKey)).toBe(false);
      expect(
        await harness.repository.getPayloadReference(replacement.id),
      ).toEqual(replacement);
    });

    it("finalizes deletion when verification proves the object is absent after an error", async () => {
      const storage = new DeleteThenThrowPayloadStorage();
      const reference = payloadReference(
        "payload-delete-absent",
        "payloads/local/delete-absent",
      );
      await harness.repository.createPayloadUploadIntent(reference);
      await storage.put({
        objectKey: reference.objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: reference.contentType,
        createdAt: reference.createdAt,
        expiresAt: reference.expiresAt,
      });

      await expect(
        reconcileOrphanedPayloads(harness.repository, storage, {
          claimIdFactory: () => "delete-absent-claim",
          cleanupLeaseMilliseconds: 60_000,
          gracePeriodMilliseconds: 1000,
          limit: 10,
          now: "2026-07-16T09:00:00.000Z",
        }),
      ).resolves.toMatchObject({
        deletedOrphanObjects: 1,
        failures: [{ operation: "delete_object" }],
      });
      await expect(
        harness.repository.getPayloadCleanupClaim(reference.objectKey),
      ).resolves.toMatchObject({ state: "deleted" });
      expect(await storage.exists(reference.objectKey)).toBe(false);
    });

    it("keeps deletion fenced when both delete and verification outcomes are unknown", async () => {
      const storage = new UnknownDeletePayloadStorage();
      const reference = payloadReference(
        "payload-delete-unknown",
        "payloads/local/delete-unknown",
      );
      await harness.repository.createPayloadUploadIntent(reference);
      await storage.put({
        objectKey: reference.objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: reference.contentType,
        createdAt: reference.createdAt,
        expiresAt: reference.expiresAt,
      });

      await expect(
        reconcileOrphanedPayloads(harness.repository, storage, {
          claimIdFactory: () => "delete-unknown-claim",
          cleanupLeaseMilliseconds: 60_000,
          gracePeriodMilliseconds: 1000,
          limit: 10,
          now: "2026-07-16T09:00:00.000Z",
        }),
      ).resolves.toMatchObject({
        deletedOrphanObjects: 0,
        failures: [
          { operation: "delete_object" },
          { operation: "inspect_object" },
        ],
      });
      await expect(
        harness.repository.getPayloadCleanupClaim(reference.objectKey),
      ).resolves.toMatchObject({ state: "deleting" });
      await expect(
        harness.repository.createPayloadReference(reference),
      ).rejects.toBeInstanceOf(PayloadCleanupConflictError);
    });

    it("atomically lets evidence cancel a claimed cleanup before deletion begins", async () => {
      const reference = payloadReference(
        "payload-claim-cancelled",
        "payloads/local/claim-cancelled",
      );
      await harness.repository.createPayloadUploadIntent(reference);
      const claimed = await harness.repository.claimPayloadCleanup({
        objectKey: reference.objectKey,
        claimId: "cleanup-claim-cancelled",
        reason: "stale_upload_intent",
        timestamp,
        leaseExpiresAt: "2026-07-16T08:01:00.000Z",
        uploadIntentId: reference.id,
        uploadGeneration: reference.uploadGeneration,
      });
      expect(claimed).toMatchObject({ status: "claimed" });
      if (claimed.status !== "claimed") {
        throw new Error("Expected a cleanup claim.");
      }

      await harness.repository.createPayloadReference(reference);
      await harness.repository.completePayloadUploadIntent(
        reference.id,
        reference.uploadGeneration,
      );
      expect(
        await harness.repository.getPayloadCleanupClaim(reference.objectKey),
      ).toBeUndefined();
      await expect(
        harness.repository.createPayloadUploadIntent({
          ...reference,
          id: "payload-already-referenced-reuse",
          uploadAttemptId: "payload-already-referenced-reuse",
          uploadGeneration: "replacement-generation",
        }),
      ).rejects.toThrow("referenced");
      await expect(
        harness.repository.beginPayloadCleanupDeletion({
          objectKey: reference.objectKey,
          claimId: claimed.claim.claimId,
          generation: claimed.claim.generation,
          timestamp: "2026-07-16T08:00:00.100Z",
          leaseExpiresAt: "2026-07-16T08:01:00.100Z",
          uploadIntentId: reference.id,
          uploadGeneration: reference.uploadGeneration,
        }),
      ).resolves.toMatchObject({ status: "referenced" });
      expect(
        await harness.repository.getPayloadReference(reference.id),
      ).toEqual(reference);
    });

    it("recovers an expired deleting lease with a higher generation and rejects stale ownership", async () => {
      const reference = payloadReference(
        "payload-lease-expiry",
        "payloads/local/lease-expiry",
      );
      await harness.repository.createPayloadUploadIntent(reference);
      const first = await harness.repository.claimPayloadCleanup({
        objectKey: reference.objectKey,
        claimId: "lease-owner-one",
        reason: "stale_upload_intent",
        timestamp: timestamp,
        leaseExpiresAt: "2026-07-16T08:00:01.000Z",
        uploadIntentId: reference.id,
        uploadGeneration: reference.uploadGeneration,
      });
      expect(first).toMatchObject({
        status: "claimed",
        claim: { generation: 1, state: "claimed" },
      });
      if (first.status !== "claimed") {
        throw new Error("Expected the first cleanup lease.");
      }
      await expect(
        harness.repository.beginPayloadCleanupDeletion({
          objectKey: reference.objectKey,
          claimId: first.claim.claimId,
          generation: first.claim.generation,
          timestamp,
          leaseExpiresAt: first.claim.leaseExpiresAt,
          uploadIntentId: reference.id,
          uploadGeneration: reference.uploadGeneration,
        }),
      ).resolves.toMatchObject({ status: "deleting" });
      await expect(
        harness.repository.claimPayloadCleanup({
          objectKey: reference.objectKey,
          claimId: "lease-owner-two",
          reason: "stale_upload_intent",
          timestamp: "2026-07-16T08:00:00.500Z",
          leaseExpiresAt: "2026-07-16T08:00:02.000Z",
          uploadIntentId: reference.id,
          uploadGeneration: reference.uploadGeneration,
        }),
      ).resolves.toMatchObject({ status: "busy" });

      const recovered = await harness.repository.claimPayloadCleanup({
        objectKey: reference.objectKey,
        claimId: "lease-owner-two",
        reason: "stale_upload_intent",
        timestamp: "2026-07-16T08:00:02.000Z",
        leaseExpiresAt: "2026-07-16T08:00:03.000Z",
        uploadIntentId: reference.id,
        uploadGeneration: reference.uploadGeneration,
      });
      expect(recovered).toMatchObject({
        status: "claimed",
        claim: { generation: 2, state: "deleting" },
      });
      if (recovered.status !== "claimed") {
        throw new Error("Expected the expired lease to be recovered.");
      }
      await expect(
        harness.repository.createPayloadReference(reference),
      ).rejects.toBeInstanceOf(PayloadCleanupConflictError);
      await expect(
        harness.repository.finalizePayloadCleanupDeletion({
          objectKey: reference.objectKey,
          claimId: first.claim.claimId,
          generation: first.claim.generation,
          timestamp: "2026-07-16T08:00:02.100Z",
          uploadIntentId: reference.id,
          uploadGeneration: reference.uploadGeneration,
        }),
      ).resolves.toBe(false);
      await expect(
        harness.repository.beginPayloadCleanupDeletion({
          objectKey: reference.objectKey,
          claimId: recovered.claim.claimId,
          generation: recovered.claim.generation,
          timestamp: "2026-07-16T08:00:02.100Z",
          leaseExpiresAt: "2026-07-16T08:00:03.100Z",
          uploadIntentId: reference.id,
          uploadGeneration: reference.uploadGeneration,
        }),
      ).resolves.toMatchObject({ status: "deleting" });
      await expect(
        harness.repository.finalizePayloadCleanupDeletion({
          objectKey: reference.objectKey,
          claimId: recovered.claim.claimId,
          generation: recovered.claim.generation,
          timestamp: "2026-07-16T08:00:02.200Z",
          uploadIntentId: reference.id,
          uploadGeneration: reference.uploadGeneration,
        }),
      ).resolves.toBe(true);
    });

    it("recovers an expired legacy claim after the object was deleted before finalization", async () => {
      const storage = new InMemoryPayloadStorage();
      const objectKey = "payloads/local/crashed-legacy-claim";
      await storage.put({
        objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: "application/json",
        createdAt: timestamp,
        expiresAt: "2026-07-17T08:00:00.000Z",
      });
      const claimed = await harness.repository.claimPayloadCleanup({
        objectKey,
        claimId: "crashed-legacy-owner",
        reason: "legacy_orphan",
        timestamp,
        leaseExpiresAt: "2026-07-16T08:00:01.000Z",
      });
      if (claimed.status !== "claimed") {
        throw new Error("Expected a legacy cleanup claim.");
      }
      await harness.repository.beginPayloadCleanupDeletion({
        objectKey,
        claimId: claimed.claim.claimId,
        generation: claimed.claim.generation,
        timestamp,
        leaseExpiresAt: claimed.claim.leaseExpiresAt,
      });
      await storage.delete(objectKey);

      await reconcileOrphanedPayloads(harness.repository, storage, {
        claimIdFactory: () => "legacy-recovery-before-expiry",
        cleanupLeaseMilliseconds: 1000,
        gracePeriodMilliseconds: 1000,
        limit: 10,
        now: "2026-07-16T08:00:00.500Z",
      });
      await expect(
        harness.repository.getPayloadCleanupClaim(objectKey),
      ).resolves.toMatchObject({ state: "deleting", generation: 1 });

      await expect(
        reconcileOrphanedPayloads(harness.repository, storage, {
          claimIdFactory: () => "legacy-recovery-after-expiry",
          cleanupLeaseMilliseconds: 1000,
          gracePeriodMilliseconds: 1000,
          limit: 10,
          now: "2026-07-16T08:00:02.000Z",
        }),
      ).resolves.toMatchObject({
        inspectedCleanupClaims: 1,
        deletedOrphanObjects: 1,
        failures: [],
      });
      await expect(
        harness.repository.getPayloadCleanupClaim(objectKey),
      ).resolves.toMatchObject({ state: "deleted", generation: 2 });
    });

    it("deletes bytes that reappear at an already deleted legacy key with a fresh cleanup generation", async () => {
      const storage = new InMemoryPayloadStorage();
      const objectKey = "payloads/local/delayed-put-old-key";
      const put = async (): Promise<void> =>
        storage.put({
          objectKey,
          bytes: Buffer.from('{"late":true}', "utf8"),
          contentType: "application/json",
          createdAt: timestamp,
          expiresAt: "2026-07-17T08:00:00.000Z",
        });
      await put();
      await expect(
        reconcileOrphanedPayloads(harness.repository, storage, {
          claimIdFactory: () => "delayed-put-generation-one",
          gracePeriodMilliseconds: 1000,
          limit: 10,
          now: "2026-07-16T09:00:00.000Z",
        }),
      ).resolves.toMatchObject({ deletedOrphanObjects: 1, failures: [] });
      await expect(
        harness.repository.getPayloadCleanupClaim(objectKey),
      ).resolves.toMatchObject({ state: "deleted", generation: 1 });

      await put();
      expect(await storage.exists(objectKey)).toBe(true);
      await expect(
        reconcileOrphanedPayloads(harness.repository, storage, {
          claimIdFactory: () => "delayed-put-generation-two",
          gracePeriodMilliseconds: 1000,
          limit: 10,
          now: "2026-07-16T10:00:00.000Z",
        }),
      ).resolves.toMatchObject({ deletedOrphanObjects: 1, failures: [] });
      expect(await storage.exists(objectKey)).toBe(false);
      await expect(
        harness.repository.getPayloadCleanupClaim(objectKey),
      ).resolves.toMatchObject({ state: "deleted", generation: 2 });
    });

    it("never claims or deletes an already referenced object", async () => {
      const storage = new InMemoryPayloadStorage();
      const reference = payloadReference(
        "payload-already-referenced",
        "payloads/local/already-referenced",
      );
      await storage.put({
        objectKey: reference.objectKey,
        bytes: Buffer.from("{}", "utf8"),
        contentType: reference.contentType,
        createdAt: reference.createdAt,
        expiresAt: reference.expiresAt,
      });
      await harness.repository.createPayloadUploadIntent(reference);
      await harness.repository.createPayloadReference(reference);
      await harness.repository.completePayloadUploadIntent(
        reference.id,
        reference.uploadGeneration,
      );

      await expect(
        reconcileOrphanedPayloads(harness.repository, storage, {
          claimIdFactory: () => "should-not-claim",
          gracePeriodMilliseconds: 1000,
          limit: 10,
          now: "2026-07-16T09:00:00.000Z",
        }),
      ).resolves.toMatchObject({
        deletedOrphanObjects: 0,
        failures: [],
      });
      expect(await storage.exists(reference.objectKey)).toBe(true);
      expect(
        await harness.repository.getPayloadCleanupClaim(reference.objectKey),
      ).toBeUndefined();
    });

    it("clears timeline retention state when a payload reference is deleted", async () => {
      await harness.repository.ingestMetadata(
        [metadataRecord("delivered", 1, "provider-payload")],
        timestamp,
      );
      await harness.repository.createPayloadUploadIntent({
        id: "payload-retention",
        uploadAttemptId: "payload-retention",
        uploadGeneration: "payload-retention-generation",
        objectKey: "payloads/local/retention",
        contentType: "application/json",
        size: 10,
        createdAt: timestamp,
        expiresAt: "2026-07-17T08:00:00.000Z",
        deliveryId: "delivery-contract",
      });
      await harness.repository.createPayloadReference({
        id: "payload-retention",
        uploadAttemptId: "payload-retention",
        uploadGeneration: "payload-retention-generation",
        objectKey: "payloads/local/retention",
        contentType: "application/json",
        size: 10,
        createdAt: timestamp,
        expiresAt: "2026-07-17T08:00:00.000Z",
        deliveryId: "delivery-contract",
      });
      expect(
        (await harness.repository.listTimeline({ limit: 10 })).items[0],
      ).toMatchObject({ payloadRetained: true });

      await expect(
        harness.repository.deletePayloadReference({
          id: "payload-retention",
          objectKey: "payloads/local/retention",
          uploadAttemptId: "payload-retention",
          uploadGeneration: "stale-generation",
        }),
      ).rejects.toThrow("generation ownership");
      expect(
        await harness.repository.getPayloadReference("payload-retention"),
      ).toBeDefined();

      await harness.repository.deletePayloadReference({
        id: "payload-retention",
        objectKey: "payloads/local/retention",
        uploadAttemptId: "payload-retention",
        uploadGeneration: "payload-retention-generation",
      });

      expect(
        (await harness.repository.listTimeline({ limit: 10 })).items[0],
      ).toMatchObject({ payloadRetained: false });
    });

    it("reports the expected migrated schema version as ready", async () => {
      await expect(harness.repository.readiness()).resolves.toMatchObject({
        ready: true,
        expectedSchemaVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
      });
    });

    it("persists one immutable payload namespace and store binding", async () => {
      await expect(
        harness.repository.hasPayloadPersistenceState(),
      ).resolves.toBe(false);
      await expect(
        harness.repository.initializePayloadStorageNamespace(
          "9999999999999999999999",
          "8888888888888888888888",
          timestamp,
        ),
      ).resolves.toMatchObject({
        namespace: "9999999999999999999999",
        storeId: "8888888888888888888888",
      });
      await expect(
        harness.repository.hasPayloadPersistenceState(),
      ).resolves.toBe(true);
      await expect(
        harness.repository.getPayloadStorageNamespace(),
      ).resolves.toMatchObject({
        namespace: "9999999999999999999999",
      });
      await expect(
        harness.repository.initializePayloadStorageNamespace(
          "aaaaaaaaaaaaaaaaaaaaaa",
          "8888888888888888888888",
          timestamp,
        ),
      ).rejects.toThrow("does not match");
      await expect(
        harness.repository.initializePayloadStorageNamespace(
          "9999999999999999999999",
          "7777777777777777777777",
          timestamp,
        ),
      ).rejects.toThrow("store ID does not match");
    });
  });
}

defineRepositoryContract("in-memory", async () => {
  const repository = new InMemoryReferenceRepository();
  return {
    repository,
    close: async () => repository.close(),
  };
});

it("destroys a PostgreSQL client when rollback cannot be confirmed", async () => {
  const release = vi.fn();
  const query = vi.fn(async (text: string) => {
    if (text === "ROLLBACK") {
      throw new Error("rollback connection failure");
    }
    return { rows: [], rowCount: 0 };
  });
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
  } as unknown as Pool;
  const repository = new PostgresReferenceRepository({ pool });

  await expect(
    repository.transaction(async () => {
      throw new Error("transaction failure");
    }),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(release).toHaveBeenCalledWith(true);
});

const postgresUrl =
  process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];

async function waitForPostgresLock(
  pool: Pool,
  applicationName: string,
): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{
      readonly wait_event: string | null;
      readonly wait_event_type: string | null;
    }>(
      `SELECT wait_event, wait_event_type
       FROM pg_stat_activity
       WHERE application_name = $1
         AND state = 'active'
       ORDER BY backend_start DESC
       LIMIT 1`,
      [applicationName],
    );
    const row = result.rows[0];
    if (row?.wait_event_type === "Lock" && row.wait_event !== null) {
      return row.wait_event;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `PostgreSQL session "${applicationName}" did not block on a lock.`,
  );
}

it("reports how to enable live PostgreSQL repository contracts", () => {
  if (postgresUrl === undefined) {
    process.stdout.write(
      "Live PostgreSQL persistence contracts and migration tests unavailable: set TEST_DATABASE_URL (or DATABASE_URL) in CI to run them.\n",
    );
  }
  expect(true).toBe(true);
});

describe.skipIf(postgresUrl === undefined)(
  "live PostgreSQL repository contracts",
  () => {
    defineRepositoryContract("PostgreSQL", async () => {
      const schema = `reference_contract_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl,
        options: `-c search_path=${schema},public`,
        max: 12,
      });
      await migratePostgres(pool);
      const repository = new PostgresReferenceRepository({ pool });
      return {
        repository,
        close: async () => {
          await repository.close();
          await pool.end();
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          await admin.end();
        },
      };
    });

    it("serializes reverse-order overlapping metadata batches without deadlock", async () => {
      const schema = `reference_batch_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
        max: 6,
      });
      const delayedRepository = (): PostgresReferenceRepository => {
        let delayed = false;
        return new PostgresReferenceRepository({
          pool,
          faultInjector: async (operation) => {
            if (operation === "ingestMetadataRecordProcessed" && !delayed) {
              delayed = true;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          },
        });
      };
      try {
        await migratePostgres(pool);
        const setupRepository = new PostgresReferenceRepository({ pool });
        for (const endpointId of ["endpoint-batch-a", "endpoint-batch-b"]) {
          await setupRepository.createEndpoint({
            id: endpointId,
            createdAt: timestamp,
            url: `https://example.com/${endpointId}`,
            allowLocalNetwork: false,
          });
        }
        const firstRepository = delayedRepository();
        const secondRepository = delayedRepository();
        const summaries = await Promise.all([
          firstRepository.ingestMetadata(
            [
              metadataRecord(
                "attempting",
                1,
                "provider-batch-a-1",
                "delivery-batch-a",
                "endpoint-batch-a",
              ),
              metadataRecord(
                "attempting",
                1,
                "provider-batch-b-1",
                "delivery-batch-b",
                "endpoint-batch-b",
              ),
            ],
            "2026-07-16T08:01:00.000Z",
          ),
          secondRepository.ingestMetadata(
            [
              metadataRecord(
                "delivered",
                2,
                "provider-batch-b-2",
                "delivery-batch-b",
                "endpoint-batch-b",
              ),
              metadataRecord(
                "delivered",
                2,
                "provider-batch-a-2",
                "delivery-batch-a",
                "endpoint-batch-a",
              ),
            ],
            "2026-07-16T08:02:00.000Z",
          ),
        ]);

        expect(
          summaries.reduce((total, summary) => total + summary.accepted, 0),
        ).toBe(4);
        const timeline = await setupRepository.listTimeline({ limit: 10 });
        expect(timeline.items).toHaveLength(2);
        expect(
          timeline.items.map((entry) => ({
            deliveryId: entry.deliveryId,
            status: entry.current.status,
            observationCount: entry.observationCount,
          })),
        ).toEqual(
          expect.arrayContaining([
            {
              deliveryId: "delivery-batch-a",
              status: "delivered",
              observationCount: 2,
            },
            {
              deliveryId: "delivery-batch-b",
              status: "delivered",
              observationCount: 2,
            },
          ]),
        );
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it("serializes send-test completion with metadata ingest without deadlock or lost evidence", async () => {
      const testId = randomUUID().replaceAll("-", "").slice(0, 12);
      const schema = `reference_test_ingest_${randomUUID().replaceAll("-", "")}`;
      const completionApplicationName = `reference-complete-${testId}`;
      const ingestApplicationName = `reference-ingest-${testId}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const options = [
        `-c search_path=${schema},public`,
        "-c deadlock_timeout=50ms",
        "-c statement_timeout=10000ms",
      ].join(" ");
      const completionPool = new Pool({
        application_name: completionApplicationName,
        connectionString: postgresUrl!,
        options,
        max: 4,
      });
      const ingestPool = new Pool({
        application_name: ingestApplicationName,
        connectionString: postgresUrl!,
        options,
        max: 2,
      });
      let signalCompletionPaused!: () => void;
      const completionPaused = new Promise<void>((resolve) => {
        signalCompletionPaused = resolve;
      });
      let resumeCompletion!: () => void;
      const completionMayResume = new Promise<void>((resolve) => {
        resumeCompletion = resolve;
      });
      let paused = false;
      const completionRepository = new PostgresReferenceRepository({
        pool: completionPool,
        faultInjector: async (operation) => {
          if (operation === "ingestMetadataBeforeLocks" && !paused) {
            paused = true;
            signalCompletionPaused();
            await completionMayResume;
          }
        },
      });
      const ingestRepository = new PostgresReferenceRepository({
        pool: ingestPool,
      });
      let sendTest: ReturnType<ReferenceService["sendTest"]> | undefined;
      let concurrentIngest:
        ReturnType<PostgresReferenceRepository["ingestMetadata"]> | undefined;
      try {
        await migratePostgres(completionPool);
        const imported = contractImport("lock-order-import", ["order.created"]);
        await completionRepository.createContractImport(imported);
        await completionRepository.publishRelease({
          id: "lock-order-release",
          importRecord: imported,
          changelog: {
            summary: "Initial release",
            status: "initial",
            changes: [],
          },
          createdAt: timestamp,
        });
        const endpointId = `endpoint-${testId}`;
        await completionRepository.createEndpoint({
          id: endpointId,
          createdAt: timestamp,
          url: "http://127.0.0.1:9999/webhook",
          allowLocalNetwork: true,
        });
        await completionRepository.setSubscription({
          id: `subscription-${testId}`,
          endpointId,
          eventTypes: ["order.created"],
          state: "active",
          timestamp,
        });

        let now = Date.parse(timestamp);
        let idSequence = 0;
        const config: ReferenceServerConfig = {
          ...DEFAULT_REFERENCE_SERVER_CONFIG,
          apiToken: "lock-order-api-token",
          allowLocalNetwork: true,
          ingestCredential: {
            id: "lock-order-ingest",
            secret: "lock-order-ingest-secret",
          },
          sendTestTimeoutMilliseconds: 1_000,
        };
        const service = new ReferenceService({
          repository: completionRepository,
          cipher: new AesGcmSecretCipher(Buffer.alloc(32, 19)),
          config,
          payloadStorage: new InMemoryPayloadStorage(),
          transport: async () => {
            now += 1_000;
            return { status: 204 };
          },
          clock: () => now,
          idFactory: () => `lock-order-${testId}-${++idSequence}`,
        });
        await service.createSecret(endpointId, "lock-order-secret");

        sendTest = service.sendTest({
          endpointId,
          eventType: "order.created",
          idempotencyKey: "lock-order-send-test",
          correlationId: "lock-order-send-test",
        });
        await Promise.race([
          completionPaused,
          sendTest.then(
            () => {
              throw new Error(
                "Send-test completed before the evidence interleave point.",
              );
            },
            (error: unknown) => {
              throw error;
            },
          ),
        ]);

        const staged = await ingestRepository.getTestCommandByIdempotency(
          endpointId,
          "lock-order-send-test",
        );
        if (
          staged?.pendingResult === undefined ||
          staged.resultObservedAt === undefined
        ) {
          throw new Error("Expected a durably staged send-test result.");
        }
        const concurrentRecord = canonicalizeMetadataRecord(
          {
            attempt: 2,
            deliveryId: staged.id,
            endpointId,
            eventId: staged.context.messageId,
            eventVersion: {
              eventType: staged.eventType,
              schemaChecksum: staged.context.schemaChecksum,
              version: staged.context.eventVersion,
            },
            kind: "delivery_attempt",
            mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
            occurredAt: new Date(
              Date.parse(staged.resultObservedAt) + 1_000,
            ).toISOString(),
            providerAttemptId: "normal-metadata-ingest",
            responseStatusCode: 202,
            schemaVersion: "2026-07-01",
            sequence: 2,
            status: "delivered",
          },
          config.metadataIdentity,
        );
        concurrentIngest = ingestRepository.ingestMetadata(
          [concurrentRecord],
          concurrentRecord.occurredAt,
        );
        const waitEvent = await waitForPostgresLock(
          admin,
          ingestApplicationName,
        );

        resumeCompletion();
        const [sendOutcome, ingestOutcome] = await Promise.allSettled([
          sendTest,
          concurrentIngest,
        ]);
        const rejectionCodes = [sendOutcome, ingestOutcome]
          .filter(
            (outcome): outcome is PromiseRejectedResult =>
              outcome.status === "rejected",
          )
          .map((outcome) =>
            typeof outcome.reason === "object" &&
            outcome.reason !== null &&
            "code" in outcome.reason
              ? outcome.reason.code
              : undefined,
          );
        expect(rejectionCodes).not.toContain("40P01");
        if (sendOutcome.status === "rejected") {
          throw sendOutcome.reason;
        }
        if (ingestOutcome.status === "rejected") {
          throw ingestOutcome.reason;
        }

        expect(waitEvent).toBe("advisory");
        expect(ingestOutcome.value).toEqual({
          accepted: 1,
          duplicates: 0,
          late: 0,
        });
        expect(sendOutcome.value).toMatchObject({
          id: staged.id,
          state: "acknowledged",
          evidenceState: "complete",
        });
        await expect(
          completionRepository.getTestCommand(staged.id),
        ).resolves.toMatchObject({
          state: "acknowledged",
          evidenceState: "complete",
        });
        const timeline = await ingestRepository.listTimeline({
          deliveryId: staged.id,
          endpointId,
          limit: 10,
        });
        expect(timeline.items).toHaveLength(1);
        expect(timeline.items[0]).toMatchObject({
          current: {
            providerAttemptId: "normal-metadata-ingest",
            sequence: 2,
            status: "delivered",
          },
          observationCount: 2,
        });
        expect(
          (await completionRepository.listAudit(100)).filter(
            (record) =>
              record.action === "test.send" && record.resourceId === staged.id,
          ),
        ).toHaveLength(1);
        expect(
          (await completionRepository.listOutbox(100)).filter(
            (record) =>
              record.topic === "test.completed" &&
              record.aggregateId === staged.id,
          ),
        ).toHaveLength(1);
      } finally {
        resumeCompletion();
        await Promise.allSettled(
          [sendTest, concurrentIngest].filter(
            (operation) => operation !== undefined,
          ),
        );
        await completionPool.end();
        await ingestPool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    }, 20_000);

    it("recovers a committed publish through a fresh connection after acknowledgement loss", async () => {
      const schema = `reference_commit_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
        max: 4,
      });
      let failCommitAcknowledgement = true;
      const repository = new PostgresReferenceRepository({
        pool,
        faultInjector: (operation) => {
          if (
            operation === "transactionCommitResponse" &&
            failCommitAcknowledgement
          ) {
            failCommitAcknowledgement = false;
            throw new Error("injected commit acknowledgement loss");
          }
        },
      });
      try {
        await migratePostgres(pool);
        const imported = contractImport("import-commit-loss", [
          "order.created",
        ]);
        await repository.createContractImport(imported);
        await expect(
          repository.transaction(async (transaction) => {
            await transaction.lockReleaseState();
            await transaction.createPublishCommand({
              id: "publish-command-commit-loss",
              idempotencyKey: "publish-commit-loss",
              requestFingerprint: "fingerprint-commit-loss",
              importId: imported.id,
              state: "requested",
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            const release = await transaction.publishRelease({
              id: "release-commit-loss",
              importRecord: imported,
              changelog: {
                summary: "initial",
                status: "initial",
                changes: [],
              },
              createdAt: timestamp,
            });
            await transaction.completePublishCommand(
              "publish-command-commit-loss",
              release.id,
              undefined,
              timestamp,
            );
          }),
        ).rejects.toBeInstanceOf(RepositoryCommitUncertainError);
        await expect(
          repository.recoverPublishStatus("publish-commit-loss"),
        ).resolves.toMatchObject({
          status: "completed",
          release: { id: "release-commit-loss" },
        });
      } finally {
        await repository.close();
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it("lists one compact summary without access to a multi-megabyte release record", async () => {
      const schema = `reference_summary_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
      });
      const repository = new PostgresReferenceRepository({ pool });
      let releaseTableRenamed = false;
      try {
        await migratePostgres(pool);
        const imported = largeContractImport("large-summary-import");
        await repository.createContractImport(imported);
        await repository.publishRelease({
          id: "large-summary-release",
          importRecord: imported,
          changelog: {
            summary: "initial",
            status: "initial",
            changes: [],
          },
          createdAt: timestamp,
        });
        const stored = await pool.query<{ readonly size: string }>(
          `SELECT octet_length(record::text)::text AS size
           FROM reference_releases
           WHERE id = 'large-summary-release'`,
        );
        expect(Number(stored.rows[0]?.size ?? "0")).toBeGreaterThan(
          1024 * 1024,
        );

        await pool.query(
          "ALTER TABLE reference_releases RENAME TO reference_releases_full_hidden",
        );
        releaseTableRenamed = true;
        const page = await repository.listReleaseMetadataPage(1);
        expect(page).toMatchObject({
          items: [{ id: "large-summary-release", status: "active" }],
        });
        expect(JSON.stringify(page).length).toBeLessThan(16 * 1024);
      } finally {
        if (releaseTableRenamed) {
          await pool.query(
            "ALTER TABLE reference_releases_full_hidden RENAME TO reference_releases",
          );
        }
        await repository.close();
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });
  },
);
