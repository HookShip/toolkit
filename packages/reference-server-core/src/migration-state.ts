// SPDX-License-Identifier: Apache-2.0

import type { Pool, PoolClient } from "pg";

import { REFERENCE_SERVER_MIGRATIONS } from "./migrations/index.js";
import type {
  MigrationExecutionContext,
  MigratePostgresOptions,
  SqlMigration,
} from "./migrations/migration.js";

export const REFERENCE_CHECKSUM_MIGRATION_VERSION = "003_reference_recovery";

interface MigrationRow {
  readonly version: string;
  readonly checksum: string | null;
}

export interface MigrationStateProblem {
  readonly missingVersions: readonly string[];
  readonly unexpectedVersions: readonly string[];
  readonly checksumMismatches: readonly {
    readonly version: string;
    readonly expectedChecksum?: string;
    readonly actualChecksum?: string;
  }[];
}

export class MigrationStateError extends Error {
  readonly code = "REFERENCE_MIGRATION_STATE_INVALID";
  readonly problem: MigrationStateProblem;

  constructor(problem: MigrationStateProblem) {
    super("The reference database migration state is not safe to modify.");
    this.name = "MigrationStateError";
    this.problem = problem;
  }
}

export function expectedReferenceMigrationChecksums(): ReadonlyMap<
  string,
  string
> {
  return new Map(
    REFERENCE_SERVER_MIGRATIONS.map((entry) => [entry.version, entry.checksum]),
  );
}

async function prepareMigrationTable(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS reference_schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
  );
  await client.query(
    `ALTER TABLE reference_schema_migrations
     ADD COLUMN IF NOT EXISTS checksum text`,
  );
  const expected = expectedReferenceMigrationChecksums();
  const existing = await client.query<MigrationRow>(
    "SELECT version, checksum FROM reference_schema_migrations",
  );
  const checksumMigrationApplied = existing.rows.some(
    (row) => row.version === REFERENCE_CHECKSUM_MIGRATION_VERSION,
  );
  for (const row of existing.rows) {
    const expectedChecksum = expected.get(row.version);
    if (
      checksumMigrationApplied ||
      row.checksum !== null ||
      expectedChecksum === undefined
    ) {
      continue;
    }
    await client.query(
      `UPDATE reference_schema_migrations
       SET checksum = $2
       WHERE version = $1 AND checksum IS NULL`,
      [row.version, expectedChecksum],
    );
  }
}

async function assertSafeMigrationState(client: PoolClient): Promise<void> {
  const expected = expectedReferenceMigrationChecksums();
  const result = await client.query<MigrationRow>(
    "SELECT version, checksum FROM reference_schema_migrations ORDER BY version",
  );
  const unexpectedVersions: string[] = [];
  const checksumMismatches: MigrationStateProblem["checksumMismatches"][number][] =
    [];
  const appliedVersions = new Set(result.rows.map((row) => row.version));
  const firstMissingIndex = REFERENCE_SERVER_MIGRATIONS.findIndex(
    (entry) => !appliedVersions.has(entry.version),
  );
  const missingVersions =
    firstMissingIndex < 0 ||
    !REFERENCE_SERVER_MIGRATIONS.slice(firstMissingIndex + 1).some((entry) =>
      appliedVersions.has(entry.version),
    )
      ? []
      : REFERENCE_SERVER_MIGRATIONS.slice(firstMissingIndex)
          .filter((entry) => !appliedVersions.has(entry.version))
          .map((entry) => entry.version);
  for (const row of result.rows) {
    const expectedChecksum = expected.get(row.version);
    if (expectedChecksum === undefined) {
      unexpectedVersions.push(row.version);
      continue;
    }
    if (row.checksum !== expectedChecksum) {
      checksumMismatches.push({
        version: row.version,
        expectedChecksum,
        ...(row.checksum === null ? {} : { actualChecksum: row.checksum }),
      });
    }
  }
  if (
    missingVersions.length > 0 ||
    unexpectedVersions.length > 0 ||
    checksumMismatches.length > 0
  ) {
    throw new MigrationStateError({
      missingVersions,
      unexpectedVersions,
      checksumMismatches,
    });
  }
}

async function applyMigration(
  client: PoolClient,
  entry: SqlMigration,
  context: MigrationExecutionContext,
): Promise<boolean> {
  const existing = await client.query<MigrationRow>(
    `SELECT version, checksum
     FROM reference_schema_migrations
     WHERE version = $1`,
    [entry.version],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    if (row.checksum !== entry.checksum) {
      throw new MigrationStateError({
        missingVersions: [],
        unexpectedVersions: [],
        checksumMismatches: [
          {
            version: entry.version,
            expectedChecksum: entry.checksum,
            ...(row.checksum === null ? {} : { actualChecksum: row.checksum }),
          },
        ],
      });
    }
    return false;
  }
  await client.query(entry.sql);
  await entry.run?.(client, context);
  await client.query(
    `INSERT INTO reference_schema_migrations(version, checksum)
     VALUES ($1, $2)`,
    [entry.version, entry.checksum],
  );
  return true;
}

export async function migratePostgres(
  pool: Pool,
  options: MigratePostgresOptions = {},
): Promise<readonly string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('webhook-portal-reference-migrations', 0))",
    );
    await prepareMigrationTable(client);
    await assertSafeMigrationState(client);
    for (const entry of REFERENCE_SERVER_MIGRATIONS) {
      if (await applyMigration(client, entry, options)) {
        applied.push(entry.version);
      }
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      destroyClient = true;
      throw new AggregateError(
        [error, rollbackError],
        "Reference migration failed and rollback could not be confirmed.",
      );
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
