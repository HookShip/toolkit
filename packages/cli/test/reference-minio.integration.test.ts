// SPDX-License-Identifier: Apache-2.0

import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { Client as MinioClient } from "minio";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  InMemoryReferenceRepository,
  MinioPayloadStorage,
  PAYLOAD_NAMESPACE_MARKER_KEY,
  PayloadStorageIdentityError,
  PostgresReferenceRepository,
  ensurePayloadStorageIdentity,
  migratePostgres,
  payloadBucketName,
} from "../src/reference-server/index.js";

function payloadId(...excluded: readonly string[]): string {
  let value: string;
  do {
    value = randomBytes(11).toString("hex");
  } while (excluded.includes(value));
  return value;
}

describe("MinIO payload identity validation", () => {
  it("derives an exact S3-safe bucket from both identity values", () => {
    const namespaceId = "1111111111111111111111";
    const firstStoreId = "2222222222222222222222";
    const secondStoreId = "3333333333333333333333";
    const firstBucket = payloadBucketName(namespaceId, firstStoreId);
    const secondBucket = payloadBucketName(namespaceId, secondStoreId);

    expect(firstBucket).toBe(
      "webhook-payloads-1111111111111111111111-2222222222222222222222",
    );
    expect(firstBucket).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u);
    expect(firstBucket).toHaveLength(62);
    expect(secondBucket).not.toBe(firstBucket);
  });

  for (const status of ["Enabled", "Suspended"] as const) {
    it(`rejects ${status.toLowerCase()} bucket versioning`, async () => {
      const client = {
        bucketExists: async () => true,
        getBucketVersioning: async () => ({ Status: status }),
        listObjectsV2: () => Readable.from([], { objectMode: true }),
        statObject: async () => {
          throw Object.assign(new Error("missing marker"), {
            code: "NoSuchKey",
          });
        },
      } as unknown as MinioClient;
      const storage = new MinioPayloadStorage({
        client,
        bucket: "versioned-bucket",
      });

      await expect(
        ensurePayloadStorageIdentity(
          new InMemoryReferenceRepository(),
          storage,
          {
            namespaceId: "6666666666666666666666",
            storeId: "7777777777777777777777",
          },
        ),
      ).rejects.toBeInstanceOf(PayloadStorageIdentityError);
    });
  }

  it("rejects a legacy namespace-only bucket before any object-store call", async () => {
    let calls = 0;
    const client = {
      bucketExists: async () => {
        calls += 1;
        return false;
      },
    } as unknown as MinioClient;
    const namespaceId = "1111111111111111111111";
    const storeId = "2222222222222222222222";
    const storage = new MinioPayloadStorage({
      client,
      bucket: `webhook-payloads-${namespaceId}`,
    });

    await expect(
      storage.initializeIdentity(namespaceId, storeId),
    ).rejects.toMatchObject({
      code: "PAYLOAD_STORAGE_BUCKET_NAME_MISMATCH",
    });
    expect(calls).toBe(0);
  });
});

const endpoint = process.env["TEST_MINIO_ENDPOINT"];
const port = Number(process.env["TEST_MINIO_PORT"] ?? "9000");
const accessKey = process.env["TEST_MINIO_ACCESS_KEY"];
const secretKey = process.env["TEST_MINIO_SECRET_KEY"];
const postgresUrl =
  process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const available =
  endpoint !== undefined &&
  accessKey !== undefined &&
  secretKey !== undefined &&
  Number.isSafeInteger(port) &&
  port > 0 &&
  port <= 65_535;

if (!available) {
  process.stderr.write(
    "Live MinIO persistence tests unavailable: set TEST_MINIO_ENDPOINT, TEST_MINIO_PORT, TEST_MINIO_ACCESS_KEY, and TEST_MINIO_SECRET_KEY.\n",
  );
}

describe.skipIf(!available)("live MinIO payload storage", () => {
  const namespaceId = payloadId();
  const storeId = payloadId(namespaceId);
  const bucket = payloadBucketName(namespaceId, storeId);
  const client = new MinioClient({
    endPoint: endpoint ?? "127.0.0.1",
    port,
    useSSL: process.env["TEST_MINIO_USE_SSL"] === "true",
    accessKey: accessKey ?? "integration-skipped",
    secretKey: secretKey ?? "integration-skipped-secret",
  });
  const storage = new MinioPayloadStorage({
    client,
    bucket,
    lifecyclePolicy: {
      prefix: "payloads/",
      expireAfterDays: 1,
      abortIncompleteMultipartAfterDays: 1,
    },
  });

  afterAll(async () => {
    const keys = await storage.listObjectKeys("payloads/", 1000);
    await Promise.all(keys.map((key) => storage.delete(key)));
    if (await storage.exists(PAYLOAD_NAMESPACE_MARKER_KEY)) {
      await storage.delete(PAYLOAD_NAMESPACE_MARKER_KEY);
    }
    if (await client.bucketExists(bucket)) {
      await client.removeBucket(bucket);
    }
    await storage.close();
  });

  it("creates the bucket, stores bytes, and deletes the object", async () => {
    const objectKey = "payloads/integration/event.json";
    const repository = new InMemoryReferenceRepository();
    const replicaStorage = new MinioPayloadStorage({
      client,
      bucket,
      lifecyclePolicy: {
        prefix: "payloads/",
        expireAfterDays: 1,
        abortIncompleteMultipartAfterDays: 1,
      },
    });
    await Promise.all([
      ensurePayloadStorageIdentity(repository, storage, {
        namespaceId,
        storeId,
      }),
      ensurePayloadStorageIdentity(repository, replicaStorage, {
        namespaceId,
        storeId,
      }),
    ]);
    await storage.ping();
    await expect(storage.inspectIdentity()).resolves.toMatchObject({
      namespace: namespaceId,
      storeId,
      versioning: "unversioned",
    });
    await expect(replicaStorage.inspectIdentity()).resolves.toMatchObject({
      namespace: namespaceId,
      storeId,
      versioning: "unversioned",
    });
    await storage.put({
      objectKey,
      bytes: Buffer.from('{"ok":true}', "utf8"),
      contentType: "application/json",
      createdAt: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-17T00:00:00.000Z",
    });

    expect(await storage.exists(objectKey)).toBe(true);
    expect(await storage.listObjectKeys("payloads/", 10)).toEqual([objectKey]);
    await storage.delete(objectKey);
    expect(await storage.exists(objectKey)).toBe(false);
  });

  it.skipIf(postgresUrl === undefined)(
    "converges concurrent first-boot replicas on one derived bucket and database binding",
    async () => {
      const concurrentNamespace = payloadId();
      const concurrentStoreId = payloadId(concurrentNamespace);
      const concurrentBucket = payloadBucketName(
        concurrentNamespace,
        concurrentStoreId,
      );
      const firstStorage = new MinioPayloadStorage({
        client,
        bucket: concurrentBucket,
      });
      const secondStorage = new MinioPayloadStorage({
        client,
        bucket: concurrentBucket,
      });
      const schema = `payload_namespace_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
        max: 4,
      });
      try {
        await migratePostgres(pool);
        const firstRepository = new PostgresReferenceRepository({ pool });
        const secondRepository = new PostgresReferenceRepository({ pool });
        await expect(
          Promise.all([
            ensurePayloadStorageIdentity(firstRepository, firstStorage, {
              namespaceId: concurrentNamespace,
              storeId: concurrentStoreId,
            }),
            ensurePayloadStorageIdentity(secondRepository, secondStorage, {
              namespaceId: concurrentNamespace,
              storeId: concurrentStoreId,
            }),
          ]),
        ).resolves.toEqual([concurrentNamespace, concurrentNamespace]);
        await expect(
          firstRepository.getPayloadStorageNamespace(),
        ).resolves.toMatchObject({
          namespace: concurrentNamespace,
          storeId: concurrentStoreId,
          status: "ready",
        });
        await expect(secondStorage.inspectIdentity()).resolves.toMatchObject({
          namespace: concurrentNamespace,
          storeId: concurrentStoreId,
        });
        await expect(
          ensurePayloadStorageIdentity(
            secondRepository,
            new MinioPayloadStorage({
              client,
              bucket: concurrentBucket,
            }),
            {
              namespaceId: concurrentNamespace,
              storeId: payloadId(concurrentNamespace, concurrentStoreId),
            },
          ),
        ).rejects.toThrow("store ID does not match");
      } finally {
        if (await client.bucketExists(concurrentBucket)) {
          await firstStorage.initializeIdentity(
            concurrentNamespace,
            concurrentStoreId,
          );
          if (await firstStorage.exists(PAYLOAD_NAMESPACE_MARKER_KEY)) {
            await firstStorage.delete(PAYLOAD_NAMESPACE_MARKER_KEY);
          }
          await client.removeBucket(concurrentBucket);
        }
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    },
  );

  it("isolates concurrent first boots with one namespace and different physical stores", async () => {
    const sharedNamespace = payloadId();
    const firstStoreId = payloadId(sharedNamespace);
    const secondStoreId = payloadId(sharedNamespace, firstStoreId);
    const firstBucket = payloadBucketName(sharedNamespace, firstStoreId);
    const secondBucket = payloadBucketName(sharedNamespace, secondStoreId);
    const firstStorage = new MinioPayloadStorage({
      client,
      bucket: firstBucket,
    });
    const secondStorage = new MinioPayloadStorage({
      client,
      bucket: secondBucket,
    });

    try {
      expect(firstBucket).not.toBe(secondBucket);
      await expect(
        Promise.all([
          ensurePayloadStorageIdentity(
            new InMemoryReferenceRepository(),
            firstStorage,
            {
              namespaceId: sharedNamespace,
              storeId: firstStoreId,
            },
          ),
          ensurePayloadStorageIdentity(
            new InMemoryReferenceRepository(),
            secondStorage,
            {
              namespaceId: sharedNamespace,
              storeId: secondStoreId,
            },
          ),
        ]),
      ).resolves.toEqual([sharedNamespace, sharedNamespace]);
      await expect(firstStorage.inspectIdentity()).resolves.toMatchObject({
        namespace: sharedNamespace,
        storeId: firstStoreId,
      });
      await expect(secondStorage.inspectIdentity()).resolves.toMatchObject({
        namespace: sharedNamespace,
        storeId: secondStoreId,
      });
    } finally {
      for (const [bucketName, storage] of [
        [firstBucket, firstStorage],
        [secondBucket, secondStorage],
      ] as const) {
        if (await client.bucketExists(bucketName)) {
          if (await storage.exists(PAYLOAD_NAMESPACE_MARKER_KEY)) {
            await storage.delete(PAYLOAD_NAMESPACE_MARKER_KEY);
          }
          await client.removeBucket(bucketName);
        }
        await storage.close();
      }
    }
  });
});
