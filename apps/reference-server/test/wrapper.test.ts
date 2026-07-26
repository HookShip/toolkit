// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));

// Every environment variable through which the reference-server runtime — or
// the underlying `pg` driver — could obtain a database connection. A
// missing-configuration smoke test must clear ALL of them so an ambient value
// can never turn a fail-closed case into a live connection attempt. In the
// coverage harness (scripts/coverage-services.mjs) TEST_DATABASE_URL points at a
// running disposable Postgres, and a DATABASE_URL may also be present, so these
// tests would otherwise dial a real database and either succeed or block on the
// driver's connect timeout instead of failing closed.
const DATABASE_ENV_VARS = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "PGURL",
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSSLMODE",
  "PGSSLROOTCERT",
  "PGCONNECT_TIMEOUT",
] as const;

type EnvOverrides = Readonly<Record<string, string | undefined>>;

interface EntryResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly durationMs: number;
}

/**
 * Runs a built wrapper entry point as a fresh child process. The child starts
 * from the real process environment (so the test reflects the live coverage
 * environment, including any provisioned database variables) and then applies
 * `overrides`. An `undefined` override REMOVES that variable from the child,
 * letting a test omit configuration even when the ambient environment provides
 * it.
 */
function runEntry(
  entry: "index.js" | "migrate.js",
  overrides: EnvOverrides = {},
): EntryResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env["NODE_ENV"] = "test";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [`${distDir}/${entry}`], {
    encoding: "utf8",
    timeout: 20_000,
    env,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    durationMs: Date.now() - startedAt,
  };
}

/** Overrides that remove every supported database URL/configuration variable. */
function withoutDatabaseConfig(): Record<string, undefined> {
  return Object.fromEntries(DATABASE_ENV_VARS.map((name) => [name, undefined]));
}

// A missing-configuration case rejects synchronously before any I/O, so it must
// finish far below the driver's 5s connect timeout. A regression that dialed a
// database would either connect (exit 0) or block until the timeout (~5s); this
// budget catches the second mode, and the exit-code assertions catch the first.
const IMMEDIATE_FAILURE_BUDGET_MS = 4_000;

// A guaranteed non-routable address (TEST-NET-1, RFC 5737): a connection attempt
// blackholes until the driver's connect timeout, distinguishing "reached the
// connection path" from an instant missing-configuration rejection.
const UNROUTABLE_DATABASE_URL =
  "postgres://reference:reference@192.0.2.1:5432/reference";

// The standalone reference-server wrapper is two process entry points that
// delegate to @webhook-portal/reference-server-core and fail closed. These
// smoke tests exercise the fail-closed branch by running the built entries with
// every database variable removed. The happy path is covered by the core server
// suite and the Compose/live integration.
describe("reference-server wrapper", () => {
  it("fails closed immediately when the migrator has no database configured", () => {
    const { status, stderr, durationMs } = runEntry(
      "migrate.js",
      withoutDatabaseConfig(),
    );
    expect(status).toBe(1);
    expect(stderr).toContain("Database migration failed.");
    expect(durationMs).toBeLessThan(IMMEDIATE_FAILURE_BUDGET_MS);
  });

  it("fails closed immediately when the server cannot start without configuration", () => {
    const { status, stderr, durationMs } = runEntry(
      "index.js",
      withoutDatabaseConfig(),
    );
    expect(status).toBe(1);
    expect(stderr).toContain("Reference server failed to start.");
    expect(durationMs).toBeLessThan(IMMEDIATE_FAILURE_BUDGET_MS);
  });
});

describe("reference-server wrapper database-configuration isolation", () => {
  it("ignores an ambient TEST_DATABASE_URL for a missing-configuration migration", () => {
    // Reproduces the coverage environment: a reachable TEST_DATABASE_URL is
    // present, but the migrator reads DATABASE_URL, which is cleared. It must
    // fail immediately and never dial the ambient TEST_DATABASE_URL.
    const { status, stderr, durationMs } = runEntry("migrate.js", {
      ...withoutDatabaseConfig(),
      TEST_DATABASE_URL:
        "postgres://reference:reference@127.0.0.1:5433/reference",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("Database migration failed.");
    expect(durationMs).toBeLessThan(IMMEDIATE_FAILURE_BUDGET_MS);
  });

  it("reaches the connection path when DATABASE_URL is configured", () => {
    // A configured but unroutable database proves the migrator gets past
    // configuration validation and attempts a real connection: it blocks on
    // the driver's connect timeout rather than failing instantly, which is
    // the intended path for a configured (if unreachable) database.
    const { status, stderr, durationMs } = runEntry("migrate.js", {
      ...withoutDatabaseConfig(),
      DATABASE_URL: UNROUTABLE_DATABASE_URL,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("Database migration failed.");
    expect(durationMs).toBeGreaterThanOrEqual(IMMEDIATE_FAILURE_BUDGET_MS);
  }, 20_000);
});
