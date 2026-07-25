// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

export interface SqlMigration {
  readonly version: string;
  readonly checksum: string;
  readonly sql: string;
  readonly run?: (
    client: PoolClient,
    context: MigrationExecutionContext,
  ) => Promise<void>;
}

export interface MigrationExecutionContext {
  readonly onTimelineTablesLocked?: () => Promise<void> | void;
}

export type MigratePostgresOptions = MigrationExecutionContext;

export function migration(
  version: string,
  sql: string,
  run?: (
    client: PoolClient,
    context: MigrationExecutionContext,
  ) => Promise<void>,
  runChecksum = "",
): SqlMigration {
  return Object.freeze({
    version,
    sql,
    checksum: createHash("sha256")
      .update(
        runChecksum.length === 0 ? sql.trim() : `${sql.trim()}\n${runChecksum}`,
      )
      .digest("hex"),
    ...(run === undefined ? {} : { run }),
  });
}
