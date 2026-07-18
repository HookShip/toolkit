// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  canonicalizeMetadataRecord,
  reduceDeliveryAttempt,
  type MetadataDeliveryAttemptInput,
} from "@webhook-portal/adapter-sdk";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  EXPECTED_REFERENCE_SCHEMA_VERSION,
  InMemoryPayloadStorage,
  MigrationStateError,
  PostgresReferenceRepository,
  REFERENCE_SERVER_MIGRATIONS,
  ensurePayloadStorageIdentity,
  metadataTimelineIdentityKey,
  migratePostgres,
  sweepExpiredPayloads,
} from "../src/reference-server/index.js";

const migrationTimestamp = "2026-07-16T08:00:00.000Z";

function legacyMetadataRecord(
  sequence: number,
  status: MetadataDeliveryAttemptInput["status"],
  deliveryId = "legacy-delivery",
) {
  return canonicalizeMetadataRecord(
    {
      attempt: 1,
      deliveryId,
      endpointId: "legacy-endpoint",
      eventId: "legacy-event",
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
        Date.parse(migrationTimestamp) + sequence * 1000,
      ).toISOString(),
      providerAttemptId: `${deliveryId}-provider-${sequence}`,
      schemaVersion: "2026-07-01",
      sequence,
      status,
    },
    {
      adapterId: "generic-http",
      connectionId: "migration",
      environment: "test",
      tenantId: "local",
    },
  );
}

it("keeps packaged migration checksums and infrastructure SQL aligned", async () => {
  const embedded = REFERENCE_SERVER_MIGRATIONS.find(
    (migration) => migration.version === EXPECTED_REFERENCE_SCHEMA_VERSION,
  );
  expect(embedded).toBeDefined();
  const infrastructure = (
    await readFile(
      new URL(
        "../../../infra/migrations/011_store_derived_bucket.sql",
        import.meta.url,
      ),
      "utf8",
    )
  ).trim();
  expect(infrastructure.startsWith("BEGIN;")).toBe(true);
  expect(infrastructure.endsWith("COMMIT;")).toBe(true);
  expect(infrastructure).toContain("webhook-portal-reference-migrations");
  expect(infrastructure).toContain(embedded?.sql.trim());
  expect(infrastructure).toContain(embedded?.checksum);
  expect(embedded?.sql).toContain("^[0-9a-f]{22}$");
  expect(embedded?.sql).toContain("store_id");
  for (const migration of REFERENCE_SERVER_MIGRATIONS) {
    expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(infrastructure).toContain(migration.checksum);
  }
});

it("destroys a migration client when rollback cannot be confirmed", async () => {
  const release = vi.fn();
  let queryCount = 0;
  const query = vi.fn(async (text: string) => {
    queryCount += 1;
    if (text === "ROLLBACK") {
      throw new Error("rollback connection failure");
    }
    if (queryCount === 2) {
      throw new Error("migration connection failure");
    }
    return { rows: [], rowCount: 0 };
  });
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
  } as unknown as Pool;

  await expect(migratePostgres(pool)).rejects.toBeInstanceOf(AggregateError);
  expect(release).toHaveBeenCalledWith(true);
});

const postgresUrl =
  process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];

describe.skipIf(postgresUrl === undefined)(
  "live PostgreSQL migration upgrades",
  () => {
    it("upgrades an existing install safely, is idempotent, and enforces readiness", async () => {
      const schema = `reference_migration_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
      });
      try {
        const initial = REFERENCE_SERVER_MIGRATIONS[0]!;
        await pool.query(initial.sql);
        await pool.query(
          `INSERT INTO reference_schema_migrations(version)
           VALUES ($1)
           ON CONFLICT DO NOTHING`,
          [initial.version],
        );
        const oldRepository = new PostgresReferenceRepository({ pool });
        await expect(oldRepository.readiness()).resolves.toMatchObject({
          ready: false,
          currentSchemaVersion: initial.version,
          expectedSchemaVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
          missingSchemaVersions: REFERENCE_SERVER_MIGRATIONS.slice(1).map(
            (migration) => migration.version,
          ),
          checksumMismatches: [{ version: initial.version }],
        });

        await pool.query(
          `INSERT INTO reference_contract_imports(id, created_at, record)
           VALUES ('import-old', '2026-07-16T08:00:00Z', '{}'::jsonb)`,
        );
        await pool.query(
          `INSERT INTO reference_releases(id, sequence, active, created_at, record)
           VALUES (
             'release-old',
             1,
             true,
             '2026-07-16T08:00:00Z',
             '{"id":"release-old","active":true}'::jsonb
           )`,
        );
        await pool.query(
          `INSERT INTO reference_endpoints(
             id, state, url, created_at, updated_at, record
           )
           VALUES
             (
               'endpoint-deleted',
               'deleted',
               'https://sensitive.example/hook',
               '2026-07-16T08:00:00Z',
               '2026-07-16T09:00:00Z',
               '{"id":"endpoint-deleted","state":"deleted","url":"https://sensitive.example/hook","allowLocalNetwork":false}'::jsonb
             ),
             (
               'endpoint-active',
               'active',
               'https://active.example/hook',
               '2026-07-16T08:00:00Z',
               '2026-07-16T08:00:00Z',
               '{"id":"endpoint-active","state":"active","url":"https://active.example/hook","allowLocalNetwork":false}'::jsonb
             )`,
        );
        await pool.query(
          `INSERT INTO reference_subscriptions(endpoint_id, updated_at, record)
           VALUES (
             'endpoint-deleted',
             '2026-07-16T08:00:00Z',
             '{"endpointId":"endpoint-deleted"}'::jsonb
           )`,
        );
        await pool.query(
          `INSERT INTO reference_secret_versions(
             id, endpoint_id, state, created_at, updated_at, record
           )
           VALUES
             (
               'secret-deleted',
               'endpoint-deleted',
               'active',
               '2026-07-16T08:00:00Z',
               '2026-07-16T08:00:00Z',
               '{"id":"secret-deleted","endpointId":"endpoint-deleted","state":"active","updatedAt":"2026-07-16T08:00:00.000Z"}'::jsonb
             ),
             (
               'secret-active-old',
               'endpoint-active',
               'active',
               '2026-07-16T08:00:00Z',
               '2026-07-16T08:00:00Z',
               '{"id":"secret-active-old","endpointId":"endpoint-active","state":"active","updatedAt":"2026-07-16T08:00:00.000Z"}'::jsonb
             ),
             (
               'secret-active-new',
               'endpoint-active',
               'active',
               '2026-07-16T09:00:00Z',
               '2026-07-16T09:00:00Z',
               '{"id":"secret-active-new","endpointId":"endpoint-active","state":"active","updatedAt":"2026-07-16T09:00:00.000Z"}'::jsonb
             )`,
        );
        await pool.query(
          `INSERT INTO reference_metadata_timeline(
             delivery_id, endpoint_id, event_id, event_type, status,
             occurred_at, last_ingested_at, record
           )
           VALUES (
             'delivery-deleted',
             'endpoint-deleted',
             'event-deleted',
             'order.created',
             'delivered',
             '2026-07-16T08:00:00Z',
             '2026-07-16T08:00:00Z',
             '{}'::jsonb
           )`,
        );
        await pool.query(
          `INSERT INTO reference_metadata_observations(
             dedupe_key, delivery_id, sequence, occurred_at,
             ingested_at, late, record
           )
           VALUES (
             'dedupe-deleted',
             'delivery-deleted',
             1,
             '2026-07-16T08:00:00Z',
             '2026-07-16T08:00:00Z',
             false,
             '{}'::jsonb
           )`,
        );
        await pool.query(
          `INSERT INTO reference_payload_references(
             id, object_key, expires_at, delivery_id, record
           )
           VALUES (
             'payload-deleted',
             'payloads/local/deleted',
             '2026-07-17T08:00:00Z',
             'delivery-deleted',
             '{"id":"payload-deleted","objectKey":"payloads/local/deleted","endpointId":"endpoint-deleted","deliveryId":"delivery-deleted"}'::jsonb
           )`,
        );

        await expect(migratePostgres(pool)).resolves.toEqual(
          REFERENCE_SERVER_MIGRATIONS.slice(1).map(
            (migration) => migration.version,
          ),
        );
        await expect(migratePostgres(pool)).resolves.toEqual([]);
        const infrastructureSql = await readFile(
          new URL(
            "../../../infra/migrations/011_store_derived_bucket.sql",
            import.meta.url,
          ),
          "utf8",
        );
        await expect(pool.query(infrastructureSql)).resolves.toBeDefined();
        await expect(pool.query(infrastructureSql)).resolves.toBeDefined();

        const repository = new PostgresReferenceRepository({ pool });
        await expect(repository.readiness()).resolves.toMatchObject({
          expectedSchemaVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
        });
        expect(await repository.getEndpoint("endpoint-deleted")).toMatchObject({
          state: "deleted",
          tombstoneVersion: 1,
        });
        expect(
          JSON.stringify(await repository.getEndpoint("endpoint-deleted")),
        ).not.toContain("sensitive.example");
        expect(
          await repository.getSubscription("endpoint-deleted"),
        ).toBeUndefined();
        expect(await repository.listSecretVersions("endpoint-deleted")).toEqual(
          [],
        );
        expect(
          await repository.listPayloadCleanupTasks(10, "endpoint-deleted"),
        ).toHaveLength(1);
        expect(
          (await repository.listSecretVersions("endpoint-active")).filter(
            (secret) => secret.state === "active",
          ),
        ).toHaveLength(1);
        await expect(
          pool.query(
            `UPDATE reference_endpoints
             SET state = 'active', url = 'https://resurrected.example'
             WHERE id = 'endpoint-deleted'`,
          ),
        ).rejects.toThrow("immutable");
        await expect(
          pool.query(
            `UPDATE reference_releases
             SET record = '{"mutated":true}'::jsonb
             WHERE id = 'release-old'`,
          ),
        ).rejects.toThrow("immutable");
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it("rejects legacy bucket identities until the pre-release storage state is reset", async () => {
      const schema = `reference_store_upgrade_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
      });
      const legacyNamespace = "11111111111111111111111111111111";
      const legacyStoreId = "22222222222222222222222222222222";
      const namespace = "1111111111111111111111";
      const storeId = "2222222222222222222222";
      try {
        for (const file of [
          "001_initial.sql",
          "002_persistence_hardening.sql",
          "003_reference_recovery.sql",
          "004_payload_cleanup_claims.sql",
          "005_payload_generations.sql",
          "006_persistence_definitive.sql",
          "007_payload_storage_identity.sql",
          "008_namespace_binding_timeline_identity.sql",
          "009_namespace_derived_bucket.sql",
          "010_payload_store_identity.sql",
        ]) {
          await pool.query(
            await readFile(
              new URL(`../../../infra/migrations/${file}`, import.meta.url),
              "utf8",
            ),
          );
        }
        await pool.query(
          `INSERT INTO reference_payload_storage_state(
             singleton, namespace, store_id, status, created_at, updated_at,
             record
           )
           VALUES (
             true,
             $1,
             $2,
             'ready',
             $3,
             $3,
             $4::jsonb
           )`,
          [
            legacyNamespace,
            legacyStoreId,
            migrationTimestamp,
            JSON.stringify({
              namespace: legacyNamespace,
              storeId: legacyStoreId,
              status: "ready",
              createdAt: migrationTimestamp,
              updatedAt: migrationTimestamp,
            }),
          ],
        );

        await expect(migratePostgres(pool)).rejects.toThrow(
          "pre-release reset before migration 011",
        );
        await expect(
          pool.query(
            `SELECT version
             FROM reference_schema_migrations
             WHERE version = '011_store_derived_bucket'`,
          ),
        ).resolves.toMatchObject({ rowCount: 0 });

        await pool.query("DELETE FROM reference_payload_storage_state");
        await expect(migratePostgres(pool)).resolves.toEqual([
          "011_store_derived_bucket",
        ]);
        const repository = new PostgresReferenceRepository({ pool });
        const storage = new InMemoryPayloadStorage();
        await expect(
          ensurePayloadStorageIdentity(repository, storage, {
            namespaceId: namespace,
            storeId,
            clock: () => Date.parse("2026-07-16T08:01:00.000Z"),
          }),
        ).resolves.toBe(namespace);
        await expect(
          repository.getPayloadStorageNamespace(),
        ).resolves.toMatchObject({ namespace, storeId, status: "ready" });
        await expect(
          repository.initializePayloadStorageNamespace(
            namespace,
            "3333333333333333333333",
            "2026-07-16T08:03:00.000Z",
          ),
        ).rejects.toThrow("store ID does not match");

        const infrastructureSql = await readFile(
          new URL(
            "../../../infra/migrations/011_store_derived_bucket.sql",
            import.meta.url,
          ),
          "utf8",
        );
        await expect(pool.query(infrastructureSql)).resolves.toBeDefined();
        await expect(pool.query(infrastructureSql)).resolves.toBeDefined();
        await expect(
          repository.getPayloadStorageNamespace(),
        ).resolves.toMatchObject({ namespace, storeId, status: "ready" });
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it("reports a future migration as non-ready and refuses a downgrade", async () => {
      const schema = `reference_future_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
      });
      try {
        await migratePostgres(pool);
        await pool.query(
          `INSERT INTO reference_schema_migrations(version, checksum)
           VALUES ('999_future', $1)`,
          ["f".repeat(64)],
        );
        const repository = new PostgresReferenceRepository({ pool });
        await expect(repository.readiness()).resolves.toMatchObject({
          ready: false,
          unexpectedSchemaVersions: ["999_future"],
        });
        await expect(migratePostgres(pool)).rejects.toMatchObject({
          code: "REFERENCE_MIGRATION_STATE_INVALID",
          problem: { unexpectedVersions: ["999_future"] },
        });
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it("reports checksum tampering and refuses to continue", async () => {
      const schema = `reference_tamper_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
      });
      try {
        await migratePostgres(pool);
        await pool.query(
          `UPDATE reference_schema_migrations
           SET checksum = $2
           WHERE version = $1`,
          [EXPECTED_REFERENCE_SCHEMA_VERSION, "0".repeat(64)],
        );
        const repository = new PostgresReferenceRepository({ pool });
        await expect(repository.readiness()).resolves.toMatchObject({
          ready: false,
          checksumMismatches: [
            {
              version: EXPECTED_REFERENCE_SCHEMA_VERSION,
              actualChecksum: "0".repeat(64),
            },
          ],
        });
        await expect(migratePostgres(pool)).rejects.toBeInstanceOf(
          MigrationStateError,
        );
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it("backfills legacy payload-reference ownership in columns and JSON before cleanup", async () => {
      const schema = `reference_payload_upgrade_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
      });
      const storage = new InMemoryPayloadStorage();
      try {
        for (const file of [
          "001_initial.sql",
          "002_persistence_hardening.sql",
          "003_reference_recovery.sql",
          "004_payload_cleanup_claims.sql",
        ]) {
          await pool.query(
            await readFile(
              new URL(`../../../infra/migrations/${file}`, import.meta.url),
              "utf8",
            ),
          );
        }
        const legacyRecord = {
          id: "legacy-payload-reference",
          objectKey: "payloads/local/legacy-reference",
          contentType: "application/json",
          size: 2,
          createdAt: "2026-07-16T07:00:00.000Z",
          expiresAt: "2026-07-16T08:00:00.000Z",
        };
        await pool.query(
          `INSERT INTO reference_payload_references(
             id, object_key, expires_at, delivery_id, endpoint_id, record
           )
           VALUES ($1, $2, $3, NULL, NULL, $4::jsonb)`,
          [
            legacyRecord.id,
            legacyRecord.objectKey,
            legacyRecord.expiresAt,
            JSON.stringify(legacyRecord),
          ],
        );
        await storage.put({
          objectKey: legacyRecord.objectKey,
          bytes: Buffer.from("{}", "utf8"),
          contentType: legacyRecord.contentType,
          createdAt: legacyRecord.createdAt,
          expiresAt: legacyRecord.expiresAt,
        });

        await expect(migratePostgres(pool)).resolves.toEqual(
          REFERENCE_SERVER_MIGRATIONS.slice(
            REFERENCE_SERVER_MIGRATIONS.findIndex(
              (migration) => migration.version === "005_payload_generations",
            ),
          ).map((migration) => migration.version),
        );
        const upgraded = await pool.query<{
          readonly upload_attempt_id: string;
          readonly upload_generation: string;
          readonly record: {
            readonly uploadAttemptId?: string;
            readonly uploadGeneration?: string;
          };
        }>(
          `SELECT upload_attempt_id, upload_generation, record
           FROM reference_payload_references
           WHERE id = $1`,
          [legacyRecord.id],
        );
        expect(upgraded.rows[0]).toMatchObject({
          upload_attempt_id: legacyRecord.id,
          upload_generation: `legacy:${legacyRecord.id}`,
          record: {
            uploadAttemptId: legacyRecord.id,
            uploadGeneration: `legacy:${legacyRecord.id}`,
          },
        });
        await pool.query(
          `UPDATE reference_payload_references
           SET record = jsonb_set(
             record,
             '{uploadGeneration}',
             to_jsonb('stale-generation'::text),
             true
           )
           WHERE id = $1`,
          [legacyRecord.id],
        );
        const synchronized = await pool.query<{
          readonly upload_generation: string;
          readonly record: { readonly uploadGeneration?: string };
        }>(
          `SELECT upload_generation, record
           FROM reference_payload_references
           WHERE id = $1`,
          [legacyRecord.id],
        );
        expect(synchronized.rows[0]).toMatchObject({
          upload_generation: `legacy:${legacyRecord.id}`,
          record: { uploadGeneration: `legacy:${legacyRecord.id}` },
        });

        const repository = new PostgresReferenceRepository({ pool });
        await expect(
          sweepExpiredPayloads(
            repository,
            storage,
            "2026-07-16T09:00:00.000Z",
            10,
          ),
        ).resolves.toMatchObject({
          scanned: 1,
          deleted: 1,
          failures: [],
        });
        expect(await storage.exists(legacyRecord.objectKey)).toBe(false);
        expect(
          await repository.getPayloadReference(legacyRecord.id),
        ).toBeUndefined();
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it("rebuilds timeline identities without deadlocking or losing a concurrent ingest", async () => {
      const schema = `reference_timeline_upgrade_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: postgresUrl! });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({
        connectionString: postgresUrl!,
        options: `-c search_path=${schema},public`,
      });
      try {
        for (const file of [
          "001_initial.sql",
          "002_persistence_hardening.sql",
          "003_reference_recovery.sql",
          "004_payload_cleanup_claims.sql",
          "005_payload_generations.sql",
          "006_persistence_definitive.sql",
          "007_payload_storage_identity.sql",
        ]) {
          await pool.query(
            await readFile(
              new URL(`../../../infra/migrations/${file}`, import.meta.url),
              "utf8",
            ),
          );
        }
        const first = legacyMetadataRecord(1, "attempting");
        const second = legacyMetadataRecord(2, "delivered");
        const exactIdentity = metadataTimelineIdentityKey(first);
        const firstReduction = reduceDeliveryAttempt(undefined, first);
        const secondReduction = reduceDeliveryAttempt(firstReduction, second);
        const firstEntry = {
          deliveryId: first.deliveryId,
          current: firstReduction.current,
          reduction: firstReduction,
          firstIngestedAt: migrationTimestamp,
          lastIngestedAt: migrationTimestamp,
          observationCount: 1,
          lateObservationCount: 0,
          payloadRetained: false,
        };
        const secondEntry = {
          deliveryId: second.deliveryId,
          current: secondReduction.current,
          reduction: secondReduction,
          firstIngestedAt: migrationTimestamp,
          lastIngestedAt: "2026-07-16T08:00:02.000Z",
          observationCount: 2,
          lateObservationCount: 0,
          payloadRetained: true,
        };
        for (const [record, identityKey, ingestedAt] of [
          [first, "legacy:legacy-delivery", migrationTimestamp],
          [second, exactIdentity, "2026-07-16T08:00:02.000Z"],
        ] as const) {
          await pool.query(
            `INSERT INTO reference_metadata_observations(
               dedupe_key, identity_key, delivery_id, sequence, occurred_at,
               ingested_at, late, record
             )
             VALUES ($1, $2, $3, $4, $5, $6, false, $7::jsonb)`,
            [
              record.dedupeKey,
              identityKey,
              record.deliveryId,
              record.sequence,
              record.occurredAt,
              ingestedAt,
              JSON.stringify(record),
            ],
          );
        }
        for (const [identityKey, entry] of [
          ["legacy:legacy-delivery", firstEntry],
          [exactIdentity, secondEntry],
        ] as const) {
          await pool.query(
            `INSERT INTO reference_metadata_timeline(
               identity_key, delivery_id, endpoint_id, event_id, event_type,
               status, occurred_at, last_ingested_at, record
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
              identityKey,
              entry.deliveryId,
              entry.current.endpointId,
              entry.current.eventId,
              entry.current.eventVersion.eventType,
              entry.current.status,
              entry.current.occurredAt,
              entry.lastIngestedAt,
              JSON.stringify(entry),
            ],
          );
        }

        let signalTimelineLocked!: () => void;
        const ingestTimelineLocked = new Promise<void>((resolve) => {
          signalTimelineLocked = resolve;
        });
        let resumeIngest!: () => void;
        const ingestMayResume = new Promise<void>((resolve) => {
          resumeIngest = resolve;
        });
        let ingestPaused = false;
        const repository = new PostgresReferenceRepository({
          pool,
          faultInjector: async (operation) => {
            if (operation === "ingestMetadataTimelineLocked" && !ingestPaused) {
              ingestPaused = true;
              signalTimelineLocked();
              await ingestMayResume;
            }
          },
        });
        const concurrentIngest = repository.ingestMetadata(
          [legacyMetadataRecord(3, "delivered")],
          "2026-07-16T08:00:03.000Z",
        );
        await ingestTimelineLocked;
        const migration = migratePostgres(pool);
        let migrationWaitingForTimeline = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiting = await pool.query<{ readonly waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM pg_locks AS locks
               JOIN pg_class AS relation ON relation.oid = locks.relation
               JOIN pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = $1
                 AND relation.relname = 'reference_metadata_timeline'
                 AND locks.mode = 'AccessExclusiveLock'
                 AND NOT locks.granted
             ) AS waiting`,
            [schema],
          );
          if (waiting.rows[0]?.waiting === true) {
            migrationWaitingForTimeline = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        resumeIngest();
        const [applied, ingestSummary] = await Promise.all([
          migration,
          concurrentIngest,
        ]);
        expect(migrationWaitingForTimeline).toBe(true);
        expect(applied).toEqual(
          REFERENCE_SERVER_MIGRATIONS.slice(
            REFERENCE_SERVER_MIGRATIONS.findIndex(
              (migration) =>
                migration.version === "008_namespace_binding_timeline_identity",
            ),
          ).map((migration) => migration.version),
        );
        expect(ingestSummary).toMatchObject({ accepted: 1 });
        const migrated = await pool.query<{
          readonly identity_key: string;
          readonly record: {
            readonly observationCount: number;
            readonly payloadRetained: boolean;
            readonly current: { readonly status: string };
          };
        }>(
          `SELECT identity_key, record
           FROM reference_metadata_timeline`,
        );
        expect(migrated.rows).toEqual([
          {
            identity_key: exactIdentity,
            record: expect.objectContaining({
              observationCount: 3,
              payloadRetained: true,
              current: expect.objectContaining({ status: "delivered" }),
            }),
          },
        ]);
        const observationIdentities = await pool.query<{
          readonly identity_key: string;
        }>(
          `SELECT DISTINCT identity_key
           FROM reference_metadata_observations`,
        );
        expect(observationIdentities.rows).toEqual([
          { identity_key: exactIdentity },
        ]);

        await repository.ingestMetadata(
          [legacyMetadataRecord(1, "attempting", "other-delivery")],
          "2026-07-16T08:00:04.000Z",
        );
        const firstPage = await repository.listTimeline({ limit: 1 });
        if (firstPage.nextCursor === undefined) {
          throw new Error("Expected a second migrated timeline page.");
        }
        const secondPage = await repository.listTimeline({
          limit: 1,
          cursor: firstPage.nextCursor,
        });
        expect(
          [...firstPage.items, ...secondPage.items].filter(
            (entry) => entry.deliveryId === "legacy-delivery",
          ),
        ).toMatchObject([
          {
            observationCount: 3,
            current: { status: "delivered", sequence: 3 },
          },
        ]);
        const count = await pool.query<{ readonly count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM reference_metadata_timeline
           WHERE identity_key = $1`,
          [exactIdentity],
        );
        expect(count.rows[0]?.count).toBe("1");
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });
  },
);
