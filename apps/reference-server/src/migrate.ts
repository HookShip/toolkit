#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

try {
  if (!process.env["DATABASE_URL"]?.trim()) {
    throw new RangeError("DATABASE_URL is required.");
  }
  const { migrateReferenceServerFromEnv } =
    await import("@webhook-portal/reference-server-core");
  const applied = await migrateReferenceServerFromEnv();
  process.stdout.write(
    applied.length === 0
      ? "Database schema is already current.\n"
      : `Applied migration(s): ${applied.join(", ")}\n`,
  );
} catch {
  process.stderr.write("Database migration failed.\n");
  process.exitCode = 1;
}
