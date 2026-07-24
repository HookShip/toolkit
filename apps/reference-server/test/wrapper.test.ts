// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));

// The standalone reference-server wrapper is two process entry points that
// delegate to @webhook-portal/reference-server-core and fail closed. These
// smoke tests exercise the fail-closed branch by running the built entries with
// an environment that has no database configured. The happy path is covered by
// the core server suite and the Compose/live integration.
function runEntry(entry: "index.js" | "migrate.js"): {
  status: number | null;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [`${distDir}/${entry}`], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: process.env["PATH"] ?? "",
      NODE_ENV: "test",
    },
  });
  return { status: result.status, stderr: result.stderr };
}

describe("reference-server wrapper", () => {
  it("fails closed when the migrator has no database configured", () => {
    const { status, stderr } = runEntry("migrate.js");
    expect(status).toBe(1);
    expect(stderr).toContain("Database migration failed.");
  });

  it("fails closed when the server cannot start without configuration", () => {
    const { status, stderr } = runEntry("index.js");
    expect(status).toBe(1);
    expect(stderr).toContain("Reference server failed to start.");
  });
});
