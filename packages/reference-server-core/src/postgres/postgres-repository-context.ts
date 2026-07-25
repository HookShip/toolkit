// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";

import { metadataTimelineIdentityKey } from "../crypto.js";
import {
  EXPECTED_REFERENCE_SCHEMA_VERSION,
  REFERENCE_SERVER_MIGRATIONS,
} from "../migrations.js";
import { RepositoryCommitUncertainError } from "../repository-errors.js";
import type {
  ReferenceRepository,
  ReferenceRepositoryTransaction,
  ReleaseRecord,
  RepositoryReadiness,
  TimelineEvidenceLockInput,
} from "../types.js";

export interface JsonRecordRow extends QueryResultRow {
  readonly record: unknown;
}

export interface ReleaseStateRow extends QueryResultRow {
  readonly active_release_id: string | null;
  readonly next_sequence: string | number;
}

interface VersionRow extends QueryResultRow {
  readonly version: string;
  readonly checksum: string | null;
}

export interface PostgresTransactionContext {
  readonly client: PoolClient;
  readonly timelineEvidenceLockKeys: Set<string>;
}

export type Queryable = Pool | PoolClient;

export function asRecord<T>(value: unknown): T {
  return value as T;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validatePayloadStorageBinding(
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

export function timelineEvidenceLockKeys(
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

export function materializeRelease(
  record: ReleaseRecord,
  activeReleaseId: string | null | undefined,
): ReleaseRecord {
  return { ...record, active: record.id === activeReleaseId };
}

export async function selectRecord<T>(
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

export class PostgresRepositoryContext {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #transactions = new AsyncLocalStorage<PostgresTransactionContext>();
  readonly #faultInjector:
    ((operation: string) => Promise<void> | void) | undefined;
  #repository: ReferenceRepository | undefined;

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

  attach(repository: ReferenceRepository): void {
    this.#repository = repository;
  }

  get repository(): ReferenceRepository {
    if (this.#repository === undefined) {
      throw new Error("Repository context is not attached.");
    }
    return this.#repository;
  }

  client(): Queryable {
    return this.#transactions.getStore()?.client ?? this.#pool;
  }

  currentTransaction(): PostgresTransactionContext | undefined {
    return this.#transactions.getStore();
  }

  async lockPayloadObject(objectKey: string): Promise<void> {
    await this.client().query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('webhook-portal-payload:' || $1::text, 0)
       )`,
      [objectKey],
    );
  }

  async fault(operation: string): Promise<void> {
    await this.#faultInjector?.(operation);
  }

  async transaction<T>(
    repository: ReferenceRepositoryTransaction,
    callback: (transaction: ReferenceRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.#transactions.getStore() !== undefined) {
      return callback(repository);
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
        () => callback(repository),
      );
      commitStarted = true;
      await client.query("COMMIT");
      commitCompleted = true;
      await this.fault("transactionCommitResponse");
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
}
