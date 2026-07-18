#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runReferenceServerProcess } from "@webhook-portal/cli/reference-server";

try {
  await runReferenceServerProcess({
    autoMigrate:
      process.argv.includes("--migrate") ||
      process.env["REFERENCE_AUTO_MIGRATE"] === "true",
  });
} catch {
  process.stderr.write("Reference server failed to start.\n");
  process.exitCode = 1;
}
