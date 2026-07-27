#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

try {
  if (!process.env["DATABASE_URL"]?.trim()) {
    throw new RangeError("DATABASE_URL is required.");
  }
  const { runReferenceServerProcess } =
    await import("@webhook-portal/reference-server-core");
  await runReferenceServerProcess({
    autoMigrate:
      process.argv.includes("--migrate") ||
      process.env["REFERENCE_AUTO_MIGRATE"] === "true",
  });
} catch {
  process.stderr.write("Reference server failed to start.\n");
  process.exitCode = 1;
}
