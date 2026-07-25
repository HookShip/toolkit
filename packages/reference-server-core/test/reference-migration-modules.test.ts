// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EXPECTED_REFERENCE_SCHEMA_VERSION,
  REFERENCE_SERVER_MIGRATIONS,
  expectedReferenceMigrationChecksums,
} from "../src/index.js";

/**
 * Directly exercises the per-migration modules and the registry that replaced
 * the single migrations.ts blob, locking their order, identity, and checksum
 * derivation independently of a live database.
 */
describe("reference migration registry", () => {
  it("exposes eleven ordered, uniquely-versioned migrations", () => {
    const versions = REFERENCE_SERVER_MIGRATIONS.map(
      (migration) => migration.version,
    );
    expect(versions).toEqual([
      "001_initial",
      "002_persistence_hardening",
      "003_reference_recovery",
      "004_payload_cleanup_claims",
      "005_payload_generations",
      "006_persistence_definitive",
      "007_payload_storage_identity",
      "008_namespace_binding_timeline_identity",
      "009_namespace_derived_bucket",
      "010_payload_store_identity",
      "011_store_derived_bucket",
    ]);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort()).toEqual(versions);
  });

  it("marks the final migration as the expected schema version", () => {
    expect(EXPECTED_REFERENCE_SCHEMA_VERSION).toBe(
      REFERENCE_SERVER_MIGRATIONS.at(-1)!.version,
    );
  });

  it("carries a non-empty SQL body and a 64-hex checksum per migration", () => {
    for (const migration of REFERENCE_SERVER_MIGRATIONS) {
      expect(migration.sql.trim().length).toBeGreaterThan(0);
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("derives the checksum deterministically from the trimmed SQL", () => {
    for (const migration of REFERENCE_SERVER_MIGRATIONS) {
      if (migration.run !== undefined) {
        // Migrations with a JS hook bind the hook checksum into their digest;
        // only their SQL-only siblings are recomputable from the SQL alone.
        continue;
      }
      const recomputed = createHash("sha256")
        .update(migration.sql.trim())
        .digest("hex");
      expect(recomputed).toBe(migration.checksum);
    }
  });

  it("maps every version to its checksum via the expected-checksum index", () => {
    const expected = expectedReferenceMigrationChecksums();
    expect(expected.size).toBe(REFERENCE_SERVER_MIGRATIONS.length);
    for (const migration of REFERENCE_SERVER_MIGRATIONS) {
      expect(expected.get(migration.version)).toBe(migration.checksum);
    }
  });
});
