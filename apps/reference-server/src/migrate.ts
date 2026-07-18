#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { migrateReferenceServerFromEnv } from "@webhook-portal/cli/reference-server";

try {
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
