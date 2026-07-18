// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

import {
  reduceDeliveryAttempt,
  type CanonicalMetadataRecord,
} from "@webhook-portal/adapter-sdk";
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";

import { decodeTimelineCursor, encodeTimelineCursor } from "./cursor.js";
import { metadataTimelineIdentityKey, referenceSha256 } from "./crypto.js";
import {
  EXPECTED_REFERENCE_SCHEMA_VERSION,
  REFERENCE_SERVER_MIGRATIONS,
} from "./migrations.js";
import { compareCodeUnits } from "./ordering.js";
import {
  PayloadCleanupConflictError,
  RepositoryCommitUncertainError,
} from "./repository-errors.js";
import { releaseMetadata } from "./release-metadata.js";
import type {
  AuditRecord,
  BeginPayloadCleanupDeletionInput,
  BeginPayloadCleanupDeletionResult,
  BeginTestCommandResult,
  ClaimPayloadCleanupInput,
  ClaimPayloadCleanupResult,
  ContractImportRecord,
  CreateEndpointInput,
  CreatePayloadReferenceInput,
  CreatePayloadUploadIntentInput,
  DeletePayloadReferenceInput,
  CreateSecretVersionInput,
  CreateTestCommandInput,
  EndpointDeletionResult,
  EndpointRecord,
  EndpointTombstone,
  FinalizePayloadCleanupDeletionInput,
  MetadataIngestSummary,
  OutboxRecord,
  PayloadCleanupTask,
  PayloadCleanupClaim,
  PayloadPage,
  PayloadReference,
  PayloadStorageNamespaceState,
  PayloadUploadIntent,
  PublishStatus,
  PublishCommandRecord,
  PublishReleaseInput,
  ReferenceRepository,
  ReferenceRepositoryTransaction,
  ReleasePayloadCleanupClaimInput,
  ReleaseRecord,
  ReleaseMetadata,
  ReleaseMetadataPage,
  RepositoryReadiness,
  RotateSecretInput,
  SecretVersionRecord,
  SetSubscriptionInput,
  SubscriptionRecord,
  TestCommandRecord,
  TestCommandResult,
  TimelineEntry,
  TimelineEvidenceLockInput,
  TimelineFilters,
  TimelinePage,
  UpdateEndpointInput,
} from "./types.js";

interface JsonRecordRow extends QueryResultRow {
  readonly record: unknown;
}

interface ReleaseStateRow extends QueryResultRow {
  readonly active_release_id: string | null;
  readonly next_sequence: string | number;
}

interface VersionRow extends QueryResultRow {
  readonly version: string;
  readonly checksum: string | null;
}

interface PostgresTransactionContext {
  readonly client: PoolClient;
  readonly timelineEvidenceLockKeys: Set<string>;
}

type Queryable = Pool | PoolClient;

function asRecord<T>(value: unknown): T {
  return value as T;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePayloadStorageBinding(
  namespace: string,
  storeId: string,
): void {
  if (!/^[0-9a-f]{22}$/u.test(namespace)) {
    throw new RangeError("Payload storage namespace ID is invalid.");
  }
  if (!/^[0-9a-f]{22}$/u.test(storeId)) {
    throw new RangeError("Payload storage store ID is invalid.");
  }
  if (namespace === storeId) {
    throw new RangeError(
      "Payload storage namespace and store IDs must be distinct.",
    );
  }
}

function timelineEvidenceLockKeys(
  input: TimelineEvidenceLockInput,
): Set<string> {
  const lockKeys = new Set<string>();
  for (const endpointId of input.endpointIds ?? []) {
    lockKeys.add(`webhook-portal-metadata:endpoint:${endpointId}`);
  }
  for (const record of input.records ?? []) {
    lockKeys.add(`webhook-portal-metadata:endpoint:${record.endpointId}`);
    lockKeys.add(
      `webhook-portal-metadata:delivery:${metadataTimelineIdentityKey(record)}`,
    );
  }
  for (const commandId of input.commandIds ?? []) {
    lockKeys.add(`webhook-portal-metadata:command:${commandId}`);
  }
  return lockKeys;
}

function materializeRelease(
  record: ReleaseRecord,
  activeReleaseId: string | null | undefined,
): ReleaseRecord {
  return { ...record, active: record.id === activeReleaseId };
}

async function selectRecord<T>(
  client: Queryable,
  text: string,
  values: readonly unknown[],
): Promise<T | undefined> {
  const result = await client.query<JsonRecordRow>(text, [...values]);
  const row = result.rows[0];
  return row === undefined ? undefined : asRecord<T>(row.record);
}

export interface PostgresReferenceRepositoryOptions {
  readonly pool?: Pool;
  readonly connectionString?: string;
  readonly poolConfig?: Omit<PoolConfig, "connectionString">;
  readonly faultInjector?: (operation: string) => Promise<void> | void;
}

export class PostgresReferenceRepository implements ReferenceRepository {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #transactions = new AsyncLocalStorage<PostgresTransactionContext>();
  readonly #faultInjector:
    ((operation: string) => Promise<void> | void) | undefined;

  constructor(options: PostgresReferenceRepositoryOptions) {
    if (options.pool !== undefined) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      if (options.connectionString === undefined) {
        throw new RangeError("A PostgreSQL connection string is required.");
      }
      this.#pool = new Pool({
        ...options.poolConfig,
        connectionString: options.connectionString,
      });
      this.#ownsPool = true;
    }
    this.#faultInjector = options.faultInjector;
  }

  get pool(): Pool {
    return this.#pool;
  }

  #client(): Queryable {
    return this.#transactions.getStore()?.client ?? this.#pool;
  }

  async #lockPayloadObject(objectKey: string): Promise<void> {
    await this.#client().query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('webhook-portal-payload:' || $1::text, 0)
       )`,
      [objectKey],
    );
  }

  async #fault(operation: string): Promise<void> {
    await this.#faultInjector?.(operation);
  }

  async transaction<T>(
    callback: (transaction: ReferenceRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.#transactions.getStore() !== undefined) {
      return callback(this);
    }
    const client = await this.#pool.connect();
    let commitStarted = false;
    let commitCompleted = false;
    let destroyClient = false;
    try {
      await client.query("BEGIN");
      const result = await this.#transactions.run(
        {
          client,
          timelineEvidenceLockKeys: new Set(),
        },
        () => callback(this),
      );
      commitStarted = true;
      await client.query("COMMIT");
      commitCompleted = true;
      await this.#fault("transactionCommitResponse");
      return result;
    } catch (error) {
      if (commitStarted) {
        throw new RepositoryCommitUncertainError(error);
      }
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        destroyClient = true;
        throw new AggregateError(
          [error, rollbackError],
          "Reference transaction failed and rollback could not be confirmed.",
        );
      }
      throw error;
    } finally {
      client.release(destroyClient || (commitStarted && !commitCompleted));
    }
  }

  async readiness(): Promise<RepositoryReadiness> {
    const expectedVersions = REFERENCE_SERVER_MIGRATIONS.map(
      (migration) => migration.version,
    );
    let appliedRows: readonly VersionRow[];
    try {
      const result = await this.#pool.query<VersionRow>(
        `SELECT version, checksum
         FROM reference_schema_migrations`,
      );
      appliedRows = result.rows;
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;
      if (code === "42703") {
        const legacy = await this.#pool.query<{ readonly version: string }>(
          "SELECT version FROM reference_schema_migrations",
        );
        appliedRows = legacy.rows.map((row) => ({
          version: row.version,
          checksum: null,
        }));
      } else if (code === "42P01") {
        appliedRows = [];
      } else {
        throw error;
      }
    }
    const expectedChecksums = new Map(
      REFERENCE_SERVER_MIGRATIONS.map((migration) => [
        migration.version,
        migration.checksum,
      ]),
    );
    const applied = new Set(appliedRows.map((row) => row.version));
    const missing = expectedVersions.filter((version) => !applied.has(version));
    const unexpected = appliedRows
      .map((row) => row.version)
      .filter((version) => !expectedChecksums.has(version))
      .sort();
    const checksumMismatches = appliedRows
      .filter((row) => {
        const expected = expectedChecksums.get(row.version);
        return expected !== undefined && row.checksum !== expected;
      })
      .map((row) => ({
        version: row.version,
        expectedChecksum: expectedChecksums.get(row.version)!,
        ...(row.checksum === null ? {} : { actualChecksum: row.checksum }),
      }));
    const currentSchemaVersion = [...expectedVersions]
      .reverse()
      .find((version) => applied.has(version));
    return {
      ready:
        missing.length === 0 &&
        unexpected.length === 0 &&
        checksumMismatches.length === 0 &&
        applied.has(EXPECTED_REFERENCE_SCHEMA_VERSION),
      expectedSchemaVersion: EXPECTED_REFERENCE_SCHEMA_VERSION,
      appliedSchemaVersions: expectedVersions.filter((version) =>
        applied.has(version),
      ),
      ...(currentSchemaVersion === undefined ? {} : { currentSchemaVersion }),
      missingSchemaVersions: missing,
      unexpectedSchemaVersions: unexpected,
      checksumMismatches,
    };
  }

  async ping(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    if (this.#ownsPool) {
      await this.#pool.end();
    }
  }

  async createContractImport(record: ContractImportRecord): Promise<void> {
    await this.#client().query(
      `INSERT INTO reference_contract_imports(id, created_at, record)
       VALUES ($1, $2, $3::jsonb)`,
      [record.id, record.createdAt, JSON.stringify(record)],
    );
  }

  async getContractImport(
    id: string,
  ): Promise<ContractImportRecord | undefined> {
    return selectRecord<ContractImportRecord>(
      this.#client(),
      "SELECT record FROM reference_contract_imports WHERE id = $1",
      [id],
    );
  }

  async lockReleaseState(): Promise<ReleaseRecord | undefined> {
    const result = await this.#client().query<ReleaseStateRow>(
      `SELECT active_release_id, next_sequence
       FROM reference_release_state
       WHERE singleton = true
       FOR UPDATE`,
    );
    const state = result.rows[0];
    if (state === undefined) {
      throw new Error("Reference release state is not initialized.");
    }
    if (state.active_release_id === null) {
      return undefined;
    }
    const record = await selectRecord<ReleaseRecord>(
      this.#client(),
      "SELECT record FROM reference_releases WHERE id = $1",
      [state.active_release_id],
    );
    if (record === undefined) {
      throw new Error("The active release pointer is inconsistent.");
    }
    return materializeRelease(record, state.active_release_id);
  }

  async publishRelease(input: PublishReleaseInput): Promise<ReleaseRecord> {
    return this.transaction(async () => {
      const contract = input.importRecord.contract;
      const canonicalExport = input.importRecord.canonicalExport;
      if (contract === undefined || canonicalExport === undefined) {
        throw new Error(
          "Cannot publish an import without a canonical contract.",
        );
      }
      const stateResult = await this.#client().query<ReleaseStateRow>(
        `SELECT active_release_id, next_sequence
         FROM reference_release_state
         WHERE singleton = true
         FOR UPDATE`,
      );
      const state = stateResult.rows[0];
      if (state === undefined) {
        throw new Error("Reference release state is not initialized.");
      }
      const sequence = Number(state.next_sequence);
      const stored: ReleaseRecord = {
        id: input.id,
        importId: input.importRecord.id,
        sequence,
        createdAt: input.createdAt,
        active: false,
        checksum: contract.checksum.value,
        contract,
        canonicalExport,
        changelog: input.changelog,
        ...(input.compatibility === undefined
          ? {}
          : { compatibility: input.compatibility }),
        ...(input.overrideReason === undefined
          ? {}
          : { overrideReason: input.overrideReason }),
      };
      await this.#client().query(
        `INSERT INTO reference_releases(
           id, sequence, active, created_at, record
         )
         VALUES ($1, $2, false, $3, $4::jsonb)`,
        [stored.id, sequence, stored.createdAt, JSON.stringify(stored)],
      );
      if (state.active_release_id !== null) {
        await this.#client().query(
          `UPDATE reference_release_summaries
           SET status = 'superseded',
               record = jsonb_set(
                 record,
                 '{status}',
                 to_jsonb('superseded'::text),
                 true
               )
           WHERE release_id = $1`,
          [state.active_release_id],
        );
      }
      const active = materializeRelease(stored, stored.id);
      const metadata = releaseMetadata(active);
      await this.#client().query(
        `INSERT INTO reference_release_summaries(
           release_id, sequence, status, record
         )
         VALUES ($1, $2, 'active', $3::jsonb)`,
        [stored.id, sequence, JSON.stringify(metadata)],
      );
      await this.#client().query(
        `UPDATE reference_release_state
         SET active_release_id = $1, next_sequence = $2
         WHERE singleton = true`,
        [stored.id, sequence + 1],
      );
      return active;
    });
  }

  async getActiveRelease(): Promise<ReleaseRecord | undefined> {
    const state = await this.#client().query<ReleaseStateRow>(
      `SELECT active_release_id, next_sequence
       FROM reference_release_state
       WHERE singleton = true`,
    );
    const activeReleaseId = state.rows[0]?.active_release_id;
    if (activeReleaseId === undefined || activeReleaseId === null) {
      return undefined;
    }
    const record = await selectRecord<ReleaseRecord>(
      this.#client(),
      "SELECT record FROM reference_releases WHERE id = $1",
      [activeReleaseId],
    );
    return record === undefined
      ? undefined
      : materializeRelease(record, activeReleaseId);
  }

  async getRelease(id: string): Promise<ReleaseRecord | undefined> {
    const result = await this.#client().query<JsonRecordRow & ReleaseStateRow>(
      `SELECT release.record, state.active_release_id, state.next_sequence
       FROM reference_releases AS release
       CROSS JOIN reference_release_state AS state
       WHERE state.singleton = true AND release.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : materializeRelease(
          asRecord<ReleaseRecord>(row.record),
          row.active_release_id,
        );
  }

  async listReleases(): Promise<readonly ReleaseRecord[]> {
    const result = await this.#client().query<JsonRecordRow & ReleaseStateRow>(
      `SELECT release.record, state.active_release_id, state.next_sequence
       FROM reference_releases AS release
       CROSS JOIN reference_release_state AS state
       WHERE state.singleton = true
       ORDER BY release.sequence DESC`,
    );
    return result.rows.map((row) =>
      materializeRelease(
        asRecord<ReleaseRecord>(row.record),
        row.active_release_id,
      ),
    );
  }

  async listReleaseMetadataPage(
    limit: number,
    beforeSequence?: number,
  ): Promise<ReleaseMetadataPage> {
    const result = await this.#client().query<
      JsonRecordRow & { readonly sequence: string | number }
    >(
      `SELECT sequence, record
       FROM reference_release_summaries
       WHERE ($2::bigint IS NULL OR sequence < $2)
       ORDER BY sequence DESC
       LIMIT $1`,
      [limit + 1, beforeSequence ?? null],
    );
    const rows = result.rows.slice(0, limit);
    const items = rows.map((row) => asRecord<ReleaseMetadata>(row.record));
    const last = items.at(-1);
    return {
      items,
      ...(result.rows.length > limit && last !== undefined
        ? { nextBeforeSequence: last.sequence }
        : {}),
    };
  }

  async createPublishCommand(record: PublishCommandRecord): Promise<void> {
    await this.#client().query(
      `INSERT INTO reference_publish_commands(
         id, idempotency_key, request_fingerprint, import_id, state,
         release_id, created_at, updated_at, record
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8::jsonb)`,
      [
        record.id,
        record.idempotencyKey,
        record.requestFingerprint,
        record.importId,
        record.state,
        record.releaseId ?? null,
        record.createdAt,
        JSON.stringify(record),
      ],
    );
  }

  async getPublishCommand(
    idempotencyKey: string,
  ): Promise<PublishCommandRecord | undefined> {
    return selectRecord<PublishCommandRecord>(
      this.#client(),
      `SELECT record
       FROM reference_publish_commands
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
  }

  async #publishStatus(
    client: Queryable,
    idempotencyKey: string,
  ): Promise<PublishStatus> {
    const command = await selectRecord<PublishCommandRecord>(
      client,
      `SELECT record
       FROM reference_publish_commands
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (command === undefined) {
      return { status: "not_found", idempotencyKey };
    }
    if (command.state !== "completed" || command.releaseId === undefined) {
      return { status: "pending", idempotencyKey, command };
    }
    const result = await client.query<JsonRecordRow & ReleaseStateRow>(
      `SELECT release.record, state.active_release_id, state.next_sequence
       FROM reference_releases AS release
       CROSS JOIN reference_release_state AS state
       WHERE state.singleton = true AND release.id = $1`,
      [command.releaseId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return {
        status: "inconsistent",
        idempotencyKey,
        command,
        reason: "release_not_found",
      };
    }
    return {
      status: "completed",
      idempotencyKey,
      command,
      release: materializeRelease(
        asRecord<ReleaseRecord>(row.record),
        row.active_release_id,
      ),
    };
  }

  async getPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    return this.#publishStatus(this.#client(), idempotencyKey);
  }

  async recoverPublishStatus(idempotencyKey: string): Promise<PublishStatus> {
    const client = await this.#pool.connect();
    try {
      return await this.#publishStatus(client, idempotencyKey);
    } finally {
      client.release();
    }
  }

  async completePublishCommand(
    id: string,
    releaseId: string,
    predecessorReleaseId: string | undefined,
    timestamp: string,
  ): Promise<PublishCommandRecord> {
    const current = await selectRecord<PublishCommandRecord>(
      this.#client(),
      `SELECT record
       FROM reference_publish_commands
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    if (current === undefined) {
      throw new Error(`Publish command "${id}" was not found.`);
    }
    if (current.state === "completed") {
      if (current.releaseId !== releaseId) {
        throw new Error("A completed publish command cannot be changed.");
      }
      return current;
    }
    const next: PublishCommandRecord = {
      ...current,
      state: "completed",
      releaseId,
      updatedAt: timestamp,
      ...(predecessorReleaseId === undefined ? {} : { predecessorReleaseId }),
    };
    await this.#client().query(
      `UPDATE reference_publish_commands
       SET state = 'completed',
           release_id = $2,
           updated_at = $3,
           record = $4::jsonb
       WHERE id = $1`,
      [id, releaseId, timestamp, JSON.stringify(next)],
    );
    return next;
  }

  async createEndpoint(input: CreateEndpointInput): Promise<EndpointRecord> {
    const endpoint: EndpointRecord = {
      id: input.id,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      url: input.url,
      allowLocalNetwork: input.allowLocalNetwork,
      state: "active",
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
    };
    await this.#client().query(
      `INSERT INTO reference_endpoints(
         id, state, url, created_at, updated_at, record
       )
       VALUES ($1, $2, $3, $4, $4, $5::jsonb)`,
      [
        endpoint.id,
        endpoint.state,
        endpoint.url,
        endpoint.createdAt,
        JSON.stringify(endpoint),
      ],
    );
    return endpoint;
  }

  async getEndpoint(id: string): Promise<EndpointRecord | undefined> {
    return selectRecord<EndpointRecord>(
      this.#client(),
      "SELECT record FROM reference_endpoints WHERE id = $1",
      [id],
    );
  }

  async lockEndpoint(id: string): Promise<EndpointRecord | undefined> {
    return selectRecord<EndpointRecord>(
      this.#client(),
      "SELECT record FROM reference_endpoints WHERE id = $1 FOR UPDATE",
      [id],
    );
  }

  async listEndpoints(): Promise<readonly EndpointRecord[]> {
    const result = await this.#client().query<JsonRecordRow>(
      "SELECT record FROM reference_endpoints ORDER BY created_at, id",
    );
    return result.rows.map((row) => asRecord<EndpointRecord>(row.record));
  }

  async updateEndpoint(
    id: string,
    input: UpdateEndpointInput,
  ): Promise<EndpointRecord | undefined> {
    return this.transaction(async () => {
      const current = await this.lockEndpoint(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.state === "deleted") {
        return current;
      }
      if (input.state === "deleted") {
        throw new Error("Use deleteEndpointData to tombstone an endpoint.");
      }
      const next: EndpointRecord = {
        ...current,
        updatedAt: input.updatedAt,
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.allowLocalNetwork === undefined
          ? {}
          : { allowLocalNetwork: input.allowLocalNetwork }),
        ...(input.state === undefined ? {} : { state: input.state }),
      };
      const normalized =
        input.description === null
          ? Object.fromEntries(
              Object.entries(next).filter(([key]) => key !== "description"),
            )
          : input.description === undefined
            ? next
            : { ...next, description: input.description };
      const record = asRecord<EndpointRecord>(normalized);
      if (record.state === "deleted") {
        throw new Error("Endpoint updates cannot create tombstones.");
      }
      await this.#client().query(
        `UPDATE reference_endpoints
         SET state = $2,
             url = $3,
             updated_at = $4,
             record = $5::jsonb
         WHERE id = $1`,
        [
          id,
          record.state,
          record.url,
          record.updatedAt,
          JSON.stringify(record),
        ],
      );
      return record;
    });
  }

  async deleteEndpointData(
    id: string,
    timestamp: string,
  ): Promise<EndpointDeletionResult | undefined> {
    return this.transaction(async () => {
      await this.acquireTimelineEvidenceLocks({ endpointIds: [id] });
      const current = await this.lockEndpoint(id);
      if (current === undefined) {
        return undefined;
      }
      if (current.state === "deleted") {
        return {
          endpoint: current,
          cleanupTasks: await this.listPayloadCleanupTasks(10_000, id),
          newlyDeleted: false,
        };
      }

      const references = await this.#client().query<JsonRecordRow>(
        `SELECT payload.record
         FROM reference_payload_references AS payload
         WHERE payload.endpoint_id = $1
            OR (
              payload.endpoint_id IS NULL
              AND payload.delivery_id IN (
                SELECT delivery_id
                FROM reference_metadata_timeline
                WHERE endpoint_id = $1
              )
            )
         FOR UPDATE`,
        [id],
      );
      for (const row of references.rows) {
        const reference = asRecord<PayloadReference>(row.record);
        const task: PayloadCleanupTask = {
          id: `endpoint:${reference.id}`,
          objectKey: reference.objectKey,
          reason: "endpoint_deleted",
          state: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          endpointId: id,
        };
        await this.#client().query(
          `INSERT INTO reference_payload_cleanup_tasks(
             id, object_key, endpoint_id, state, reason,
             created_at, updated_at, attempts, record
           )
           VALUES ($1, $2, $3, 'pending', 'endpoint_deleted',
                   $4, $4, 0, $5::jsonb)
           ON CONFLICT(id) DO NOTHING`,
          [task.id, task.objectKey, id, timestamp, JSON.stringify(task)],
        );
        const deletedReference = await this.#client().query(
          `DELETE FROM reference_payload_references
           WHERE id = $1
             AND object_key = $2
             AND upload_attempt_id IS NOT DISTINCT FROM $3
             AND upload_generation IS NOT DISTINCT FROM $4`,
          [
            reference.id,
            reference.objectKey,
            reference.uploadAttemptId ?? null,
            reference.uploadGeneration ?? null,
          ],
        );
        if (deletedReference.rowCount !== 1) {
          throw new Error(
            "Payload reference generation changed during endpoint deletion.",
          );
        }
      }
      const intents = await this.#client().query<JsonRecordRow>(
        `SELECT record
         FROM reference_payload_upload_intents
         WHERE endpoint_id = $1
         FOR UPDATE`,
        [id],
      );
      for (const row of intents.rows) {
        const intent = asRecord<PayloadUploadIntent>(row.record);
        const task: PayloadCleanupTask = {
          id: `endpoint:${intent.id}`,
          objectKey: intent.objectKey,
          reason: "endpoint_deleted",
          state: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          endpointId: id,
        };
        await this.#client().query(
          `INSERT INTO reference_payload_cleanup_tasks(
             id, object_key, endpoint_id, state, reason,
             created_at, updated_at, attempts, record
           )
           VALUES ($1, $2, $3, 'pending', 'endpoint_deleted',
                   $4, $4, 0, $5::jsonb)
           ON CONFLICT(id) DO NOTHING`,
          [task.id, task.objectKey, id, timestamp, JSON.stringify(task)],
        );
        const orphaned: PayloadUploadIntent = {
          ...intent,
          state: "orphaned",
          updatedAt: timestamp,
        };
        await this.#client().query(
          `UPDATE reference_payload_upload_intents
           SET state = 'orphaned', updated_at = $2, record = $3::jsonb
           WHERE id = $1`,
          [intent.id, timestamp, JSON.stringify(orphaned)],
        );
      }

      await this.#client().query(
        `DELETE FROM reference_metadata_observations AS observation
         USING reference_metadata_timeline AS timeline
         WHERE observation.identity_key = timeline.identity_key
           AND timeline.endpoint_id = $1`,
        [id],
      );
      await this.#client().query(
        "DELETE FROM reference_metadata_timeline WHERE endpoint_id = $1",
        [id],
      );
      await this.#client().query(
        "DELETE FROM reference_subscriptions WHERE endpoint_id = $1",
        [id],
      );
      await this.#client().query(
        "DELETE FROM reference_secret_versions WHERE endpoint_id = $1",
        [id],
      );
      await this.#client().query(
        "DELETE FROM reference_test_commands WHERE endpoint_id = $1",
        [id],
      );

      const tombstone: EndpointTombstone = {
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: timestamp,
        deletedAt: timestamp,
        state: "deleted",
        tombstoneVersion: 1,
      };
      await this.#client().query(
        `UPDATE reference_endpoints
         SET state = 'deleted',
             url = NULL,
             deleted_at = $2,
             updated_at = $2,
             record = $3::jsonb
         WHERE id = $1`,
        [id, timestamp, JSON.stringify(tombstone)],
      );
      return {
        endpoint: tombstone,
        cleanupTasks: await this.listPayloadCleanupTasks(10_000, id),
        newlyDeleted: true,
      };
    });
  }

  async setSubscription(
    input: SetSubscriptionInput,
  ): Promise<SubscriptionRecord> {
    return this.transaction(async () => {
      const endpoint = await this.lockEndpoint(input.endpointId);
      if (endpoint === undefined || endpoint.state === "deleted") {
        throw new Error("Cannot subscribe a missing or deleted endpoint.");
      }
      const current = await this.getSubscription(input.endpointId);
      const record: SubscriptionRecord = {
        id: current?.id ?? input.id,
        endpointId: input.endpointId,
        eventTypes: [...input.eventTypes],
        state: input.state,
        createdAt: current?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
      };
      await this.#client().query(
        `INSERT INTO reference_subscriptions(endpoint_id, updated_at, record)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT(endpoint_id) DO UPDATE
         SET updated_at = EXCLUDED.updated_at, record = EXCLUDED.record`,
        [input.endpointId, input.timestamp, JSON.stringify(record)],
      );
      return record;
    });
  }

  async getSubscription(
    endpointId: string,
  ): Promise<SubscriptionRecord | undefined> {
    return selectRecord<SubscriptionRecord>(
      this.#client(),
      "SELECT record FROM reference_subscriptions WHERE endpoint_id = $1",
      [endpointId],
    );
  }

  async createSecretVersion(
    input: CreateSecretVersionInput,
  ): Promise<SecretVersionRecord> {
    const record: SecretVersionRecord = {
      ...input,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    };
    await this.#client().query(
      `INSERT INTO reference_secret_versions(
         id, endpoint_id, state, created_at, updated_at, record
       )
       VALUES ($1, $2, $3, $4, $4, $5::jsonb)`,
      [
        record.id,
        record.endpointId,
        record.state,
        record.createdAt,
        JSON.stringify(record),
      ],
    );
    return record;
  }

  async rotateSecret(input: RotateSecretInput): Promise<SecretVersionRecord> {
    return this.transaction(async () => {
      await this.lockEndpoint(input.endpointId);
      const active = await this.#client().query<JsonRecordRow>(
        `SELECT record
         FROM reference_secret_versions
         WHERE endpoint_id = $1 AND state = 'active'
         FOR UPDATE`,
        [input.endpointId],
      );
      if (active.rows.length !== 1) {
        throw new Error("Secret rotation requires exactly one active secret.");
      }
      const secret = asRecord<SecretVersionRecord>(active.rows[0]!.record);
      const overlapping: SecretVersionRecord = {
        ...secret,
        state: "overlapping",
        expiresAt: input.overlapUntil,
        updatedAt: input.timestamp,
      };
      await this.#client().query(
        `UPDATE reference_secret_versions
         SET state = 'overlapping',
             updated_at = $2,
             record = $3::jsonb
         WHERE id = $1`,
        [secret.id, input.timestamp, JSON.stringify(overlapping)],
      );
      return this.createSecretVersion(input.replacement);
    });
  }

  async revokeSecret(
    endpointId: string,
    secretId: string,
    timestamp: string,
  ): Promise<SecretVersionRecord | undefined> {
    return this.transaction(async () => {
      const current = await selectRecord<SecretVersionRecord>(
        this.#client(),
        `SELECT record
         FROM reference_secret_versions
         WHERE id = $1 AND endpoint_id = $2
         FOR UPDATE`,
        [secretId, endpointId],
      );
      if (current === undefined || current.state === "revoked") {
        return current;
      }
      const next: SecretVersionRecord = {
        ...current,
        state: "revoked",
        updatedAt: timestamp,
      };
      await this.#client().query(
        `UPDATE reference_secret_versions
         SET state = 'revoked', updated_at = $2, record = $3::jsonb
         WHERE id = $1`,
        [secretId, timestamp, JSON.stringify(next)],
      );
      return next;
    });
  }

  async getSecretVersion(
    endpointId: string,
    secretId: string,
  ): Promise<SecretVersionRecord | undefined> {
    return selectRecord<SecretVersionRecord>(
      this.#client(),
      `SELECT record
       FROM reference_secret_versions
       WHERE endpoint_id = $1 AND id = $2`,
      [endpointId, secretId],
    );
  }

  async listSecretVersions(
    endpointId: string,
  ): Promise<readonly SecretVersionRecord[]> {
    const result = await this.#client().query<JsonRecordRow>(
      `SELECT record
       FROM reference_secret_versions
       WHERE endpoint_id = $1
       ORDER BY created_at DESC, id DESC`,
      [endpointId],
    );
    return result.rows.map((row) => asRecord<SecretVersionRecord>(row.record));
  }

  async beginTestCommand(
    input: CreateTestCommandInput,
  ): Promise<BeginTestCommandResult> {
    const command: TestCommandRecord = {
      id: input.id,
      endpointId: input.endpointId,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      state: "requested",
      evidenceState: "pending",
      context: input.context,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    };
    const inserted = await this.#client().query<JsonRecordRow>(
      `INSERT INTO reference_test_commands(
         id, endpoint_id, idempotency_key, request_fingerprint, state,
         created_at, updated_at, record
       )
       VALUES ($1, $2, $3, $4, 'requested', $5, $5, $6::jsonb)
       ON CONFLICT(endpoint_id, idempotency_key) DO NOTHING
       RETURNING record`,
      [
        command.id,
        command.endpointId,
        command.idempotencyKey,
        command.requestFingerprint,
        command.createdAt,
        JSON.stringify(command),
      ],
    );
    if (inserted.rowCount !== 0) {
      return { status: "created", command };
    }
    const existing = await this.getTestCommandByIdempotency(
      input.endpointId,
      input.idempotencyKey,
    );
    if (existing === undefined) {
      throw new Error("Unable to resolve idempotent command.");
    }
    return {
      status:
        existing.requestFingerprint === input.requestFingerprint
          ? "existing"
          : "conflict",
      command: existing,
    };
  }

  async getTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return selectRecord<TestCommandRecord>(
      this.#client(),
      "SELECT record FROM reference_test_commands WHERE id = $1",
      [id],
    );
  }

  async getTestCommandByIdempotency(
    endpointId: string,
    idempotencyKey: string,
  ): Promise<TestCommandRecord | undefined> {
    return selectRecord<TestCommandRecord>(
      this.#client(),
      `SELECT record
       FROM reference_test_commands
       WHERE endpoint_id = $1 AND idempotency_key = $2`,
      [endpointId, idempotencyKey],
    );
  }

  async lockTestCommand(id: string): Promise<TestCommandRecord | undefined> {
    return selectRecord<TestCommandRecord>(
      this.#client(),
      "SELECT record FROM reference_test_commands WHERE id = $1 FOR UPDATE",
      [id],
    );
  }

  async markTestCommandDispatched(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.transaction(async () => {
      const current = await this.lockTestCommand(id);
      if (current === undefined) {
        return undefined;
      }
      if (
        current.state !== "requested" ||
        current.pendingResult !== undefined
      ) {
        return current;
      }
      const next: TestCommandRecord = {
        ...current,
        state: "dispatched",
        dispatchedAt: timestamp,
        updatedAt: timestamp,
      };
      await this.#client().query(
        `UPDATE reference_test_commands
         SET state = 'dispatched', updated_at = $2, record = $3::jsonb
         WHERE id = $1`,
        [id, timestamp, JSON.stringify(next)],
      );
      return next;
    });
  }

  async stageTestCommandResult(
    id: string,
    timestamp: string,
    result: TestCommandResult,
  ): Promise<TestCommandRecord | undefined> {
    return this.transaction(async () => {
      await this.acquireTimelineEvidenceLocks({ commandIds: [id] });
      const current = await this.lockTestCommand(id);
      if (current === undefined || current.evidenceState === "complete") {
        return current;
      }
      if (
        current.pendingResult !== undefined &&
        !sameJson(current.pendingResult, result)
      ) {
        throw new Error("A staged test result cannot be overwritten.");
      }
      const next: TestCommandRecord = {
        ...current,
        evidenceState: "pending",
        pendingResult: current.pendingResult ?? result,
        resultObservedAt: current.resultObservedAt ?? timestamp,
        updatedAt: timestamp,
      };
      await this.#client().query(
        `UPDATE reference_test_commands
         SET updated_at = $2, record = $3::jsonb
         WHERE id = $1`,
        [id, timestamp, JSON.stringify(next)],
      );
      return next;
    });
  }

  async completeTestCommand(
    id: string,
    timestamp: string,
  ): Promise<TestCommandRecord | undefined> {
    return this.transaction(async () => {
      await this.acquireTimelineEvidenceLocks({ commandIds: [id] });
      const current = await this.lockTestCommand(id);
      if (current === undefined || current.evidenceState === "complete") {
        return current;
      }
      if (current.pendingResult === undefined) {
        throw new Error(
          "A test command cannot complete without a staged result.",
        );
      }
      const { pendingResult, ...withoutPending } = current;
      const next: TestCommandRecord = {
        ...withoutPending,
        state: pendingResult.state,
        evidenceState: "complete",
        result: pendingResult,
        updatedAt: timestamp,
      };
      await this.#client().query(
        `UPDATE reference_test_commands
         SET state = $2, updated_at = $3, record = $4::jsonb
         WHERE id = $1`,
        [id, next.state, timestamp, JSON.stringify(next)],
      );
      return next;
    });
  }

  async acquireTimelineEvidenceLocks(
    input: TimelineEvidenceLockInput,
  ): Promise<void> {
    const transaction = this.#transactions.getStore();
    if (transaction === undefined) {
      throw new Error(
        "Timeline/evidence advisory locks require an active transaction.",
      );
    }
    const requiredLockKeys = timelineEvidenceLockKeys(input);
    if (transaction.timelineEvidenceLockKeys.size > 0) {
      const missingLockKeys = [...requiredLockKeys].filter(
        (lockKey) => !transaction.timelineEvidenceLockKeys.has(lockKey),
      );
      if (missingLockKeys.length > 0) {
        throw new Error(
          "Timeline/evidence advisory locks must be acquired together before repository reads or writes.",
        );
      }
      return;
    }
    const sortedLockKeys = [...requiredLockKeys].sort(compareCodeUnits);
    for (const lockKey of sortedLockKeys) {
      await transaction.client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );
      transaction.timelineEvidenceLockKeys.add(lockKey);
    }
  }

  async ingestMetadata(
    records: readonly CanonicalMetadataRecord[],
    ingestedAt: string,
  ): Promise<MetadataIngestSummary> {
    return this.transaction(async () => {
      await this.#fault("ingestMetadataBeforeLocks");
      const prepared = records.map((record) => ({
        record,
        identityKey: metadataTimelineIdentityKey(record),
      }));
      await this.acquireTimelineEvidenceLocks({ records });

      let accepted = 0;
      let duplicates = 0;
      let late = 0;
      for (const { identityKey, record } of prepared) {
        const endpoint = await this.lockEndpoint(record.endpointId);
        if (endpoint?.state === "deleted") {
          throw new Error(
            "Metadata cannot be ingested for a deleted endpoint.",
          );
        }
        const current = await selectRecord<TimelineEntry>(
          this.#client(),
          `SELECT record
           FROM reference_metadata_timeline
           WHERE identity_key = $1
           FOR UPDATE`,
          [identityKey],
        );
        await this.#fault("ingestMetadataTimelineLocked");
        const isLate =
          current !== undefined &&
          (record.sequence < current.current.sequence ||
            record.occurredAt < current.current.occurredAt);
        const inserted = await this.#client().query(
          `INSERT INTO reference_metadata_observations(
             dedupe_key, identity_key, delivery_id, sequence,
             occurred_at, ingested_at, late, record
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT(dedupe_key) DO NOTHING`,
          [
            record.dedupeKey,
            identityKey,
            record.deliveryId,
            record.sequence,
            record.occurredAt,
            ingestedAt,
            isLate,
            JSON.stringify(record),
          ],
        );
        if (inserted.rowCount === 0) {
          duplicates += 1;
          continue;
        }
        const reduction = reduceDeliveryAttempt(current?.reduction, record);
        const entry: TimelineEntry = {
          deliveryId: record.deliveryId,
          current: reduction.current,
          reduction,
          firstIngestedAt: current?.firstIngestedAt ?? ingestedAt,
          lastIngestedAt: ingestedAt,
          observationCount: (current?.observationCount ?? 0) + 1,
          lateObservationCount:
            (current?.lateObservationCount ?? 0) + (isLate ? 1 : 0),
          payloadRetained: current?.payloadRetained ?? false,
        };
        await this.#client().query(
          `INSERT INTO reference_metadata_timeline(
             identity_key, delivery_id, endpoint_id, event_id, event_type,
             status, occurred_at, last_ingested_at, record
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           ON CONFLICT(identity_key) DO UPDATE SET
             delivery_id = EXCLUDED.delivery_id,
             endpoint_id = EXCLUDED.endpoint_id,
             event_id = EXCLUDED.event_id,
             event_type = EXCLUDED.event_type,
             status = EXCLUDED.status,
             occurred_at = EXCLUDED.occurred_at,
             last_ingested_at = EXCLUDED.last_ingested_at,
             record = EXCLUDED.record`,
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
        accepted += 1;
        late += isLate ? 1 : 0;
        await this.#fault("ingestMetadataRecordProcessed");
      }
      return { accepted, duplicates, late };
    });
  }

  async listTimeline(filters: TimelineFilters): Promise<TimelinePage> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(sql.replace("?", `$${values.length}`));
    };
    if (filters.deliveryId !== undefined) {
      add("delivery_id = ?", filters.deliveryId);
    }
    if (filters.endpointId !== undefined) {
      add("endpoint_id = ?", filters.endpointId);
    }
    if (filters.eventId !== undefined) {
      add("event_id = ?", filters.eventId);
    }
    if (filters.eventType !== undefined) {
      add("event_type = ?", filters.eventType);
    }
    if (filters.status !== undefined) {
      add("status = ?", filters.status);
    }
    if (filters.from !== undefined) {
      add("occurred_at >= ?", filters.from);
    }
    if (filters.to !== undefined) {
      add("occurred_at <= ?", filters.to);
    }
    if (filters.cursor !== undefined) {
      const cursor = decodeTimelineCursor(filters.cursor);
      values.push(cursor.lastIngestedAt, cursor.identityKey);
      conditions.push(
        `(last_ingested_at, identity_key) < ($${values.length - 1}, $${values.length})`,
      );
    }
    values.push(filters.limit + 1);
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const result = await this.#client().query<JsonRecordRow>(
      `SELECT record
       FROM reference_metadata_timeline
       ${where}
       ORDER BY last_ingested_at DESC, identity_key DESC
       LIMIT $${values.length}`,
      values,
    );
    const records = result.rows.map((row) =>
      asRecord<TimelineEntry>(row.record),
    );
    const hasMore = records.length > filters.limit;
    const items = records.slice(0, filters.limit);
    return {
      items,
      ...(hasMore && items.length > 0
        ? { nextCursor: encodeTimelineCursor(items[items.length - 1]!) }
        : {}),
    };
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    await this.#client().query(
      `INSERT INTO reference_audit_events(
         id, created_at, action, resource_type, resource_id, result, record
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        record.id,
        record.createdAt,
        record.action,
        record.resourceType,
        record.resourceId ?? null,
        record.result,
        JSON.stringify(record),
      ],
    );
  }

  async listAudit(limit: number): Promise<readonly AuditRecord[]> {
    const result = await this.#client().query<JsonRecordRow>(
      `SELECT record
       FROM reference_audit_events
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => asRecord<AuditRecord>(row.record));
  }

  async appendOutbox(record: OutboxRecord): Promise<void> {
    await this.#client().query(
      `INSERT INTO reference_outbox_events(
         id, created_at, topic, aggregate_type, aggregate_id,
         correlation_id, record
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        record.id,
        record.createdAt,
        record.topic,
        record.aggregateType,
        record.aggregateId ?? null,
        record.correlationId,
        JSON.stringify(record),
      ],
    );
  }

  async listOutbox(limit: number): Promise<readonly OutboxRecord[]> {
    const result = await this.#client().query<JsonRecordRow>(
      `SELECT record
       FROM reference_outbox_events
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => asRecord<OutboxRecord>(row.record));
  }

  async createPayloadReference(
    input: CreatePayloadReferenceInput,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.#lockPayloadObject(input.objectKey);
      const cleanupClaim = await selectRecord<PayloadCleanupClaim>(
        this.#client(),
        `SELECT record
         FROM reference_payload_cleanup_claims
         WHERE object_key = $1
         FOR UPDATE`,
        [input.objectKey],
      );
      if (
        cleanupClaim?.state === "deleting" ||
        cleanupClaim?.state === "deleted"
      ) {
        throw new PayloadCleanupConflictError(
          input.objectKey,
          cleanupClaim.state,
        );
      }
      const uploadIntent = await this.getPayloadUploadIntentByObjectKey(
        input.objectKey,
      );
      const hasUploadOwnership =
        input.uploadAttemptId !== undefined ||
        input.uploadGeneration !== undefined;
      if (
        hasUploadOwnership &&
        (input.uploadAttemptId === undefined ||
          input.uploadGeneration === undefined ||
          uploadIntent?.id !== input.uploadAttemptId ||
          uploadIntent.uploadAttemptId !== input.uploadAttemptId ||
          uploadIntent.uploadGeneration !== input.uploadGeneration)
      ) {
        throw new Error("Payload upload ownership does not match its intent.");
      }
      if (!hasUploadOwnership && uploadIntent !== undefined) {
        throw new Error("Payload upload ownership is required.");
      }
      if (cleanupClaim?.state === "claimed") {
        if (
          cleanupClaim.uploadIntentId !== input.uploadAttemptId ||
          cleanupClaim.uploadGeneration !== input.uploadGeneration
        ) {
          throw new Error(
            "Payload cleanup ownership does not match the upload.",
          );
        }
        await this.#client().query(
          "DELETE FROM reference_payload_cleanup_claims WHERE object_key = $1",
          [input.objectKey],
        );
      }
      const inserted = await this.#client().query(
        `INSERT INTO reference_payload_references(
           id, object_key, upload_attempt_id, upload_generation,
           expires_at, delivery_id, endpoint_id, record
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT(id) DO NOTHING`,
        [
          input.id,
          input.objectKey,
          input.uploadAttemptId ?? null,
          input.uploadGeneration ?? null,
          input.expiresAt,
          input.deliveryId ?? null,
          input.endpointId ?? null,
          JSON.stringify(input),
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await this.getPayloadReference(input.id);
        if (existing === undefined || !sameJson(existing, input)) {
          throw new Error("A payload reference cannot be overwritten.");
        }
      }
      if (uploadIntent !== undefined) {
        await this.#client().query(
          `DELETE FROM reference_payload_upload_intents
           WHERE id = $1
             AND object_key = $2
             AND upload_generation = $3`,
          [
            uploadIntent.id,
            uploadIntent.objectKey,
            uploadIntent.uploadGeneration,
          ],
        );
      }
      if (input.deliveryId !== undefined) {
        const timelines = await this.#client().query<
          JsonRecordRow & { readonly identity_key: string }
        >(
          `SELECT identity_key, record
           FROM reference_metadata_timeline
           WHERE delivery_id = $1
             AND ($2::text IS NULL OR endpoint_id = $2)
           FOR UPDATE`,
          [input.deliveryId, input.endpointId ?? null],
        );
        for (const row of timelines.rows) {
          const current = asRecord<TimelineEntry>(row.record);
          if (current.payloadRetained) {
            continue;
          }
          await this.#client().query(
            `UPDATE reference_metadata_timeline
             SET record = $2::jsonb
             WHERE identity_key = $1`,
            [
              row.identity_key,
              JSON.stringify({ ...current, payloadRetained: true }),
            ],
          );
        }
      }
    });
  }

  async getPayloadReference(id: string): Promise<PayloadReference | undefined> {
    return selectRecord<PayloadReference>(
      this.#client(),
      "SELECT record FROM reference_payload_references WHERE id = $1",
      [id],
    );
  }

  async getPayloadReferenceByObjectKey(
    objectKey: string,
  ): Promise<PayloadReference | undefined> {
    return selectRecord<PayloadReference>(
      this.#client(),
      `SELECT record
       FROM reference_payload_references
       WHERE object_key = $1`,
      [objectKey],
    );
  }

  async listPayloadReferences(
    limit: number,
  ): Promise<readonly PayloadReference[]> {
    return (await this.listPayloadReferencesPage(limit)).items;
  }

  async listPayloadReferencesPage(
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>> {
    const result = await this.#client().query<
      JsonRecordRow & { readonly id: string }
    >(
      `SELECT id, record
       FROM reference_payload_references
       WHERE ($2::text IS NULL OR id > $2)
       ORDER BY id
       LIMIT $1`,
      [limit + 1, cursor ?? null],
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => asRecord<PayloadReference>(row.record)),
      ...(result.rows.length > limit && rows.length > 0
        ? { nextCursor: rows[rows.length - 1]!.id }
        : {}),
    };
  }

  async listExpiredPayloadReferences(
    now: string,
    limit: number,
  ): Promise<readonly PayloadReference[]> {
    return (await this.listExpiredPayloadReferencesPage(now, limit)).items;
  }

  async listExpiredPayloadReferencesPage(
    now: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadReference>> {
    const result = await this.#client().query<
      JsonRecordRow & { readonly id: string }
    >(
      `SELECT id, record
       FROM reference_payload_references
       WHERE expires_at <= $1
         AND ($3::text IS NULL OR id > $3)
       ORDER BY id
       LIMIT $2`,
      [now, limit + 1, cursor ?? null],
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => asRecord<PayloadReference>(row.record)),
      ...(result.rows.length > limit && rows.length > 0
        ? { nextCursor: rows[rows.length - 1]!.id }
        : {}),
    };
  }

  async deletePayloadReference(
    input: DeletePayloadReferenceInput,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.#lockPayloadObject(input.objectKey);
      const reference = await selectRecord<PayloadReference>(
        this.#client(),
        `SELECT record
         FROM reference_payload_references
         WHERE id = $1
         FOR UPDATE`,
        [input.id],
      );
      if (reference === undefined) {
        return;
      }
      if (
        reference.objectKey !== input.objectKey ||
        reference.uploadAttemptId !== input.uploadAttemptId ||
        reference.uploadGeneration !== input.uploadGeneration
      ) {
        throw new Error("Payload reference generation ownership was lost.");
      }
      const deleted = await this.#client().query(
        `DELETE FROM reference_payload_references
         WHERE id = $1
           AND object_key = $2
           AND upload_attempt_id IS NOT DISTINCT FROM $3
           AND upload_generation IS NOT DISTINCT FROM $4`,
        [
          input.id,
          input.objectKey,
          input.uploadAttemptId ?? null,
          input.uploadGeneration ?? null,
        ],
      );
      if (deleted.rowCount !== 1) {
        throw new Error("Payload reference generation ownership was lost.");
      }
      if (reference.deliveryId !== undefined) {
        const timelines = await this.#client().query<
          JsonRecordRow & { readonly identity_key: string }
        >(
          `SELECT identity_key, record
           FROM reference_metadata_timeline
           WHERE delivery_id = $1
             AND ($2::text IS NULL OR endpoint_id = $2)
           FOR UPDATE`,
          [reference.deliveryId, reference.endpointId ?? null],
        );
        for (const row of timelines.rows) {
          const current = asRecord<TimelineEntry>(row.record);
          const remaining = await this.#client().query<{
            readonly count: string;
          }>(
            `SELECT COUNT(*)::text AS count
             FROM reference_payload_references
             WHERE delivery_id = $1
               AND (endpoint_id IS NULL OR endpoint_id = $2)`,
            [reference.deliveryId, current.current.endpointId],
          );
          const retained = Number(remaining.rows[0]?.count ?? "0") > 0;
          await this.#client().query(
            `UPDATE reference_metadata_timeline
             SET record = $2::jsonb
             WHERE identity_key = $1`,
            [
              row.identity_key,
              JSON.stringify({ ...current, payloadRetained: retained }),
            ],
          );
        }
      }
    });
  }

  async createPayloadUploadIntent(
    input: CreatePayloadUploadIntentInput,
  ): Promise<PayloadUploadIntent> {
    return this.transaction(async () => {
      if (
        input.id !== input.uploadAttemptId ||
        input.uploadGeneration.length === 0
      ) {
        throw new Error("Payload upload attempt ownership is invalid.");
      }
      await this.#lockPayloadObject(input.objectKey);
      if (
        (await this.getPayloadReferenceByObjectKey(input.objectKey)) !==
        undefined
      ) {
        throw new Error(
          "A referenced payload object key cannot start another upload.",
        );
      }
      const cleanupClaim = await selectRecord<PayloadCleanupClaim>(
        this.#client(),
        `SELECT record
         FROM reference_payload_cleanup_claims
         WHERE object_key = $1
         FOR UPDATE`,
        [input.objectKey],
      );
      if (cleanupClaim?.state === "claimed") {
        await this.#client().query(
          "DELETE FROM reference_payload_cleanup_claims WHERE object_key = $1",
          [input.objectKey],
        );
      } else if (cleanupClaim?.state === "deleting") {
        throw new PayloadCleanupConflictError(input.objectKey, "deleting");
      } else if (cleanupClaim?.state === "deleted") {
        throw new PayloadCleanupConflictError(input.objectKey, "deleted");
      }
      const intent: PayloadUploadIntent = {
        ...input,
        state: "pending",
        updatedAt: input.createdAt,
        attempts: 0,
      };
      const inserted = await this.#client().query(
        `INSERT INTO reference_payload_upload_intents(
           id, object_key, upload_generation, endpoint_id, delivery_id, state,
           created_at, updated_at, attempts, record
         )
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6, 0, $7::jsonb)
         ON CONFLICT(id) DO NOTHING`,
        [
          intent.id,
          intent.objectKey,
          intent.uploadGeneration,
          intent.endpointId ?? null,
          intent.deliveryId ?? null,
          intent.createdAt,
          JSON.stringify(intent),
        ],
      );
      if (inserted.rowCount !== 0) {
        return intent;
      }
      const existing = await this.getPayloadUploadIntent(input.id);
      if (existing === undefined) {
        throw new Error("A payload upload intent could not be created.");
      }
      const comparable: CreatePayloadUploadIntentInput = {
        id: existing.id,
        uploadAttemptId: existing.uploadAttemptId,
        uploadGeneration: existing.uploadGeneration,
        objectKey: existing.objectKey,
        contentType: existing.contentType,
        size: existing.size,
        createdAt: existing.createdAt,
        expiresAt: existing.expiresAt,
        ...(existing.endpointId === undefined
          ? {}
          : { endpointId: existing.endpointId }),
        ...(existing.deliveryId === undefined
          ? {}
          : { deliveryId: existing.deliveryId }),
      };
      if (!sameJson(comparable, input)) {
        throw new Error("A payload upload intent cannot be overwritten.");
      }
      return existing;
    });
  }

  async getPayloadUploadIntent(
    id: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return selectRecord<PayloadUploadIntent>(
      this.#client(),
      "SELECT record FROM reference_payload_upload_intents WHERE id = $1",
      [id],
    );
  }

  async getPayloadUploadIntentByObjectKey(
    objectKey: string,
  ): Promise<PayloadUploadIntent | undefined> {
    return selectRecord<PayloadUploadIntent>(
      this.#client(),
      `SELECT record
       FROM reference_payload_upload_intents
       WHERE object_key = $1`,
      [objectKey],
    );
  }

  async listPayloadUploadIntents(
    olderThan: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadUploadIntent>> {
    const result = await this.#client().query<
      JsonRecordRow & { readonly id: string }
    >(
      `SELECT id, record
       FROM reference_payload_upload_intents
       WHERE created_at <= $1
         AND ($3::text IS NULL OR id > $3)
       ORDER BY id
       LIMIT $2`,
      [olderThan, limit + 1, cursor ?? null],
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => asRecord<PayloadUploadIntent>(row.record)),
      ...(result.rows.length > limit && rows.length > 0
        ? { nextCursor: rows[rows.length - 1]!.id }
        : {}),
    };
  }

  async markPayloadUploadIntentOrphaned(
    id: string,
    uploadGeneration: string,
    timestamp: string,
    errorCode: string,
  ): Promise<void> {
    const current = await selectRecord<PayloadUploadIntent>(
      this.#client(),
      `SELECT record
       FROM reference_payload_upload_intents
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    if (current === undefined) {
      return;
    }
    if (current.uploadGeneration !== uploadGeneration) {
      throw new Error("Payload upload generation ownership was lost.");
    }
    const next: PayloadUploadIntent = {
      ...current,
      state: "orphaned",
      attempts: current.attempts + 1,
      updatedAt: timestamp,
      lastErrorCode: referenceSha256(errorCode).slice(0, 16),
    };
    await this.#client().query(
      `UPDATE reference_payload_upload_intents
       SET state = 'orphaned',
           attempts = $2,
           last_error_code = $3,
           updated_at = $4,
           record = $5::jsonb
       WHERE id = $1 AND upload_generation = $6`,
      [
        id,
        next.attempts,
        next.lastErrorCode,
        timestamp,
        JSON.stringify(next),
        uploadGeneration,
      ],
    );
  }

  async completePayloadUploadIntent(
    id: string,
    uploadGeneration: string,
  ): Promise<void> {
    const deleted = await this.#client().query(
      `DELETE FROM reference_payload_upload_intents
       WHERE id = $1 AND upload_generation = $2`,
      [id, uploadGeneration],
    );
    if (
      deleted.rowCount === 0 &&
      (await this.getPayloadUploadIntent(id)) !== undefined
    ) {
      throw new Error("Payload upload generation ownership was lost.");
    }
  }

  async claimPayloadCleanup(
    input: ClaimPayloadCleanupInput,
  ): Promise<ClaimPayloadCleanupResult> {
    return this.transaction(async () => {
      await this.#lockPayloadObject(input.objectKey);
      const current = await selectRecord<PayloadCleanupClaim>(
        this.#client(),
        `SELECT record
         FROM reference_payload_cleanup_claims
         WHERE object_key = $1
         FOR UPDATE`,
        [input.objectKey],
      );
      const reference = await this.getPayloadReferenceByObjectKey(
        input.objectKey,
      );
      if (reference !== undefined) {
        if (current !== undefined && current.state !== "deleted") {
          await this.#client().query(
            "DELETE FROM reference_payload_cleanup_claims WHERE object_key = $1",
            [input.objectKey],
          );
        }
        return { status: "referenced" };
      }
      if (input.uploadIntentId !== undefined) {
        const intent = await this.getPayloadUploadIntent(input.uploadIntentId);
        if (
          input.uploadGeneration === undefined ||
          ((intent === undefined ||
            intent.objectKey !== input.objectKey ||
            intent.uploadGeneration !== input.uploadGeneration) &&
            !(
              current?.uploadIntentId === input.uploadIntentId &&
              current.uploadGeneration === input.uploadGeneration &&
              current.objectKey === input.objectKey
            ))
        ) {
          return { status: "intent_missing" };
        }
      } else if (input.uploadGeneration !== undefined) {
        return { status: "intent_missing" };
      } else if (
        (await this.getPayloadUploadIntentByObjectKey(input.objectKey)) !==
        undefined
      ) {
        return { status: "intent_present" };
      }
      if (current?.state === "deleted" && input.reason !== "legacy_orphan") {
        return { status: "deleted", claim: current };
      }
      if (current !== undefined && current.leaseExpiresAt > input.timestamp) {
        return current.state === "claimed" && current.claimId === input.claimId
          ? { status: "claimed", claim: current }
          : { status: "busy", claim: current };
      }
      const claim: PayloadCleanupClaim = {
        objectKey: input.objectKey,
        claimId: input.claimId,
        generation: (current?.generation ?? 0) + 1,
        state: current?.state === "deleting" ? "deleting" : "claimed",
        reason: input.reason,
        createdAt: current?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
        leaseExpiresAt: input.leaseExpiresAt,
        ...(input.uploadIntentId === undefined
          ? {}
          : { uploadIntentId: input.uploadIntentId }),
        ...(input.uploadGeneration === undefined
          ? {}
          : { uploadGeneration: input.uploadGeneration }),
      };
      await this.#client().query(
        `INSERT INTO reference_payload_cleanup_claims(
           object_key, claim_id, generation, state, reason, upload_intent_id,
           upload_generation,
           created_at, updated_at, lease_expires_at, last_error_code, record
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11::jsonb
         )
         ON CONFLICT(object_key) DO UPDATE SET
           claim_id = EXCLUDED.claim_id,
           generation = EXCLUDED.generation,
           state = EXCLUDED.state,
           reason = EXCLUDED.reason,
           upload_intent_id = EXCLUDED.upload_intent_id,
           upload_generation = EXCLUDED.upload_generation,
           updated_at = EXCLUDED.updated_at,
           lease_expires_at = EXCLUDED.lease_expires_at,
           last_error_code = NULL,
           record = EXCLUDED.record`,
        [
          claim.objectKey,
          claim.claimId,
          claim.generation,
          claim.state,
          claim.reason,
          claim.uploadIntentId ?? null,
          claim.uploadGeneration ?? null,
          claim.createdAt,
          claim.updatedAt,
          claim.leaseExpiresAt,
          JSON.stringify(claim),
        ],
      );
      return { status: "claimed", claim };
    });
  }

  async beginPayloadCleanupDeletion(
    input: BeginPayloadCleanupDeletionInput,
  ): Promise<BeginPayloadCleanupDeletionResult> {
    return this.transaction(async () => {
      await this.#lockPayloadObject(input.objectKey);
      const reference = await this.getPayloadReferenceByObjectKey(
        input.objectKey,
      );
      if (reference !== undefined) {
        await this.#client().query(
          `DELETE FROM reference_payload_cleanup_claims
           WHERE object_key = $1 AND claim_id = $2 AND generation = $3`,
          [input.objectKey, input.claimId, input.generation],
        );
        return { status: "referenced" };
      }
      const current = await selectRecord<PayloadCleanupClaim>(
        this.#client(),
        `SELECT record
         FROM reference_payload_cleanup_claims
         WHERE object_key = $1
         FOR UPDATE`,
        [input.objectKey],
      );
      if (
        current === undefined ||
        current.claimId !== input.claimId ||
        current.generation !== input.generation ||
        current.uploadIntentId !== input.uploadIntentId ||
        current.uploadGeneration !== input.uploadGeneration
      ) {
        return { status: "lost" };
      }
      if (current.state === "deleted") {
        return { status: "deleted" };
      }
      if (current.state !== "claimed" && current.state !== "deleting") {
        return { status: "lost" };
      }
      const deleting: PayloadCleanupClaim = {
        ...current,
        state: "deleting",
        updatedAt: input.timestamp,
        leaseExpiresAt: input.leaseExpiresAt,
      };
      await this.#client().query(
        `UPDATE reference_payload_cleanup_claims
         SET state = 'deleting',
             updated_at = $4,
             lease_expires_at = $5,
             record = $6::jsonb
         WHERE object_key = $1 AND claim_id = $2 AND generation = $3`,
        [
          input.objectKey,
          input.claimId,
          input.generation,
          input.timestamp,
          input.leaseExpiresAt,
          JSON.stringify(deleting),
        ],
      );
      return { status: "deleting", claim: deleting };
    });
  }

  async finalizePayloadCleanupDeletion(
    input: FinalizePayloadCleanupDeletionInput,
  ): Promise<boolean> {
    return this.transaction(async () => {
      await this.#lockPayloadObject(input.objectKey);
      const current = await selectRecord<PayloadCleanupClaim>(
        this.#client(),
        `SELECT record
         FROM reference_payload_cleanup_claims
         WHERE object_key = $1
         FOR UPDATE`,
        [input.objectKey],
      );
      if (
        current === undefined ||
        current.state !== "deleting" ||
        current.claimId !== input.claimId ||
        current.generation !== input.generation ||
        current.uploadIntentId !== input.uploadIntentId ||
        current.uploadGeneration !== input.uploadGeneration
      ) {
        return false;
      }
      const deleted: PayloadCleanupClaim = {
        ...current,
        state: "deleted",
        updatedAt: input.timestamp,
      };
      await this.#client().query(
        `UPDATE reference_payload_cleanup_claims
         SET state = 'deleted', updated_at = $4, record = $5::jsonb
         WHERE object_key = $1 AND claim_id = $2 AND generation = $3`,
        [
          input.objectKey,
          input.claimId,
          input.generation,
          input.timestamp,
          JSON.stringify(deleted),
        ],
      );
      if (current.uploadIntentId !== undefined) {
        await this.#client().query(
          `DELETE FROM reference_payload_upload_intents
           WHERE id = $1
             AND object_key = $2
             AND upload_generation = $3`,
          [
            current.uploadIntentId,
            input.objectKey,
            current.uploadGeneration ?? null,
          ],
        );
      }
      return true;
    });
  }

  async releasePayloadCleanupClaim(
    input: ReleasePayloadCleanupClaimInput,
  ): Promise<boolean> {
    void input.timestamp;
    void input.errorCode;
    return this.transaction(async () => {
      await this.#lockPayloadObject(input.objectKey);
      const deleted = await this.#client().query(
        `DELETE FROM reference_payload_cleanup_claims
         WHERE object_key = $1
           AND claim_id = $2
           AND generation = $3
           AND upload_intent_id IS NOT DISTINCT FROM $4
           AND upload_generation IS NOT DISTINCT FROM $5
           AND state <> 'deleted'`,
        [
          input.objectKey,
          input.claimId,
          input.generation,
          input.uploadIntentId ?? null,
          input.uploadGeneration ?? null,
        ],
      );
      return deleted.rowCount !== 0;
    });
  }

  async getPayloadCleanupClaim(
    objectKey: string,
  ): Promise<PayloadCleanupClaim | undefined> {
    return selectRecord<PayloadCleanupClaim>(
      this.#client(),
      `SELECT record
       FROM reference_payload_cleanup_claims
       WHERE object_key = $1`,
      [objectKey],
    );
  }

  async listExpiredPayloadCleanupClaims(
    now: string,
    limit: number,
    cursor?: string,
  ): Promise<PayloadPage<PayloadCleanupClaim>> {
    const result = await this.#client().query<
      JsonRecordRow & { readonly object_key: string }
    >(
      `SELECT object_key, record
       FROM reference_payload_cleanup_claims
       WHERE state <> 'deleted'
         AND lease_expires_at <= $1
         AND ($3::text IS NULL OR object_key > $3)
       ORDER BY object_key
       LIMIT $2`,
      [now, limit + 1, cursor ?? null],
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => asRecord<PayloadCleanupClaim>(row.record)),
      ...(result.rows.length > limit && rows.length > 0
        ? { nextCursor: rows[rows.length - 1]!.object_key }
        : {}),
    };
  }

  async getPayloadStorageNamespace(): Promise<
    PayloadStorageNamespaceState | undefined
  > {
    return selectRecord<PayloadStorageNamespaceState>(
      this.#client(),
      `SELECT record
       FROM reference_payload_storage_state
       WHERE singleton = true`,
      [],
    );
  }

  async initializePayloadStorageNamespace(
    namespace: string,
    storeId: string,
    timestamp: string,
  ): Promise<PayloadStorageNamespaceState> {
    validatePayloadStorageBinding(namespace, storeId);
    return this.transaction(async () => {
      await this.#client().query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('webhook-portal-payload-storage-namespace', 0)
         )`,
      );
      const current = await selectRecord<PayloadStorageNamespaceState>(
        this.#client(),
        `SELECT record
         FROM reference_payload_storage_state
         WHERE singleton = true
         FOR UPDATE`,
        [],
      );
      if (current !== undefined) {
        if (current.namespace !== namespace) {
          throw new Error("Payload storage namespace does not match.");
        }
        if (current.storeId !== undefined && current.storeId !== storeId) {
          throw new Error("Payload storage store ID does not match.");
        }
        if (current.storeId === undefined) {
          const claimed: PayloadStorageNamespaceState = {
            ...current,
            storeId,
            status: current.status === "ready" ? "upgrading" : current.status,
            updatedAt: timestamp,
          };
          await this.#client().query(
            `UPDATE reference_payload_storage_state
             SET store_id = $2,
                 status = $3,
                 updated_at = $4,
                 record = $5::jsonb
             WHERE singleton = true
               AND namespace = $1
               AND store_id IS NULL`,
            [
              namespace,
              storeId,
              claimed.status,
              timestamp,
              JSON.stringify(claimed),
            ],
          );
          return claimed;
        }
        return current;
      }
      const created: PayloadStorageNamespaceState = {
        namespace,
        storeId,
        status: "binding",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.#client().query(
        `INSERT INTO reference_payload_storage_state(
           singleton, namespace, store_id, status, created_at, updated_at, record
         )
         VALUES (true, $1, $2, 'binding', $3, $3, $4::jsonb)`,
        [namespace, storeId, timestamp, JSON.stringify(created)],
      );
      return created;
    });
  }

  async markPayloadStorageNamespaceReady(
    namespace: string,
    storeId: string,
    timestamp: string,
  ): Promise<PayloadStorageNamespaceState> {
    validatePayloadStorageBinding(namespace, storeId);
    return this.transaction(async () => {
      await this.#client().query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('webhook-portal-payload-storage-namespace', 0)
         )`,
      );
      const current = await this.getPayloadStorageNamespace();
      if (
        current === undefined ||
        current.namespace !== namespace ||
        current.storeId !== storeId
      ) {
        throw new Error("Payload storage binding does not match.");
      }
      const ready: PayloadStorageNamespaceState = {
        ...current,
        status: "ready",
        updatedAt: timestamp,
      };
      await this.#client().query(
        `UPDATE reference_payload_storage_state
         SET status = 'ready', updated_at = $2, record = $3::jsonb
         WHERE singleton = true
           AND namespace = $1
           AND store_id = $4`,
        [namespace, timestamp, JSON.stringify(ready), storeId],
      );
      return ready;
    });
  }

  async hasPayloadDataState(): Promise<boolean> {
    const result = await this.#client().query<{ readonly present: boolean }>(
      `SELECT (
         EXISTS (SELECT 1 FROM reference_payload_references)
         OR EXISTS (SELECT 1 FROM reference_payload_upload_intents)
         OR EXISTS (SELECT 1 FROM reference_payload_cleanup_claims)
         OR EXISTS (SELECT 1 FROM reference_payload_cleanup_tasks)
       ) AS present`,
    );
    return result.rows[0]?.present ?? false;
  }

  async hasPayloadPersistenceState(): Promise<boolean> {
    const result = await this.#client().query<{ readonly present: boolean }>(
      `SELECT (
         EXISTS (SELECT 1 FROM reference_payload_storage_state)
         OR EXISTS (SELECT 1 FROM reference_payload_references)
         OR EXISTS (SELECT 1 FROM reference_payload_upload_intents)
         OR EXISTS (SELECT 1 FROM reference_payload_cleanup_claims)
         OR EXISTS (SELECT 1 FROM reference_payload_cleanup_tasks)
       ) AS present`,
    );
    return result.rows[0]?.present ?? false;
  }

  async listPayloadCleanupTasks(
    limit: number,
    endpointId?: string,
    cursor?: string,
  ): Promise<readonly PayloadCleanupTask[]> {
    const result = await this.#client().query<JsonRecordRow>(
      `SELECT record
       FROM reference_payload_cleanup_tasks
       WHERE ($2::text IS NULL OR endpoint_id = $2)
         AND ($3::text IS NULL OR id > $3)
       ORDER BY id
       LIMIT $1`,
      [limit, endpointId ?? null, cursor ?? null],
    );
    return result.rows.map((row) => asRecord<PayloadCleanupTask>(row.record));
  }

  async markPayloadCleanupFailed(
    id: string,
    timestamp: string,
    errorCode: string,
  ): Promise<void> {
    const current = await selectRecord<PayloadCleanupTask>(
      this.#client(),
      `SELECT record
       FROM reference_payload_cleanup_tasks
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    if (current === undefined) {
      return;
    }
    const next: PayloadCleanupTask = {
      ...current,
      state: "failed",
      attempts: current.attempts + 1,
      updatedAt: timestamp,
      lastErrorCode: referenceSha256(errorCode).slice(0, 16),
    };
    await this.#client().query(
      `UPDATE reference_payload_cleanup_tasks
       SET state = 'failed',
           attempts = $2,
           last_error_code = $3,
           updated_at = $4,
           record = $5::jsonb
       WHERE id = $1`,
      [id, next.attempts, next.lastErrorCode, timestamp, JSON.stringify(next)],
    );
  }

  async completePayloadCleanup(id: string): Promise<void> {
    await this.#client().query(
      "DELETE FROM reference_payload_cleanup_tasks WHERE id = $1",
      [id],
    );
  }
}
