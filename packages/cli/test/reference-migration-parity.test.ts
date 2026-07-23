// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { REFERENCE_SERVER_MIGRATIONS } from "../src/reference-server/index.js";

/**
 * The reference schema is authored once in
 * `packages/cli/src/reference-server/migrations.ts` (the canonical source used
 * by the CLI/Postgres migrator) and mirrored into `infra/migrations/*.sql` for
 * the Compose/psql deployment path. These parity tests are the guardrail that
 * keeps the two representations from drifting: the standalone `.sql` wrapper is
 * hand-maintained boilerplate (advisory lock, migration-state guard, checksum
 * bookkeeping), but the DDL body, version, and recorded checksum must come from
 * the canonical source verbatim.
 */
const migrationsDir = fileURLToPath(
  new URL("../../../infra/migrations", import.meta.url),
);

// Checksums began being recorded with this migration; earlier files insert the
// version only.
const CHECKSUM_CUTOVER = "003_reference_recovery";

function readSql(version: string): string {
  return readFileSync(`${migrationsDir}/${version}.sql`, "utf8");
}

describe("reference migration DDL parity", () => {
  const cutoverIndex = REFERENCE_SERVER_MIGRATIONS.findIndex(
    (migration) => migration.version === CHECKSUM_CUTOVER,
  );

  it.each(REFERENCE_SERVER_MIGRATIONS.map((migration) => migration.version))(
    "mirrors the canonical DDL body for %s",
    (version) => {
      const migration = REFERENCE_SERVER_MIGRATIONS.find(
        (entry) => entry.version === version,
      );
      expect(migration).toBeDefined();
      const sql = readSql(version);
      const body = migration!.sql.trim();
      expect(body.length).toBeGreaterThan(0);
      expect(sql).toContain(body);
      expect(sql).toContain(version);
    },
  );

  it("mirrors the recorded checksum for checksum-tracked migrations", () => {
    REFERENCE_SERVER_MIGRATIONS.forEach((migration, index) => {
      if (index < cutoverIndex) {
        return;
      }
      const sql = readSql(migration.version);
      expect(sql, `${migration.version} must embed its checksum`).toContain(
        migration.checksum,
      );
    });
  });

  it("has a one-to-one mapping between the manifest and infra/migrations", () => {
    const diskVersions = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => file.replace(/\.sql$/u, ""))
      .sort();
    const manifestVersions = REFERENCE_SERVER_MIGRATIONS.map(
      (migration) => migration.version,
    ).sort();
    expect(diskVersions).toEqual(manifestVersions);
  });

  it("keeps the manifest ordered and the expected head last", () => {
    const versions = REFERENCE_SERVER_MIGRATIONS.map(
      (migration) => migration.version,
    );
    expect(versions).toEqual([...versions].sort());
    expect(versions.at(-1)).toBe(REFERENCE_SERVER_MIGRATIONS.at(-1)?.version);
  });
});
