// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import * as cli from "../src/index.js";
import * as referenceServer from "../src/reference-server/index.js";

/**
 * Locks the curated public export surface of both entry points. Adding an
 * `export *` barrel or leaking an internal helper will fail here, and dropping
 * an intended export is likewise caught — the surface changes only on purpose.
 */
describe("@webhook-portal/cli public surface", () => {
  it("exports exactly the curated command runtime", () => {
    expect(Object.keys(cli).sort()).toEqual([
      "CLI_EXIT_CODES",
      "CliCommandError",
      "commandFailure",
      "helpCommand",
      "runCli",
      "runCommand",
    ]);
  });

  it("does not leak low-level CLI plumbing", () => {
    for (const internal of [
      "atomicWriteFile",
      "readInputText",
      "redactText",
      "booleanOption",
      "parseCommandArguments",
      "emitSuccess",
      "requestJson",
      "readSecret",
      "validateCommand",
      "sendTestCommand",
    ]) {
      expect(cli).not.toHaveProperty(internal);
    }
  });
});

describe("@webhook-portal/cli/reference-server public surface", () => {
  it("exposes the reference server building blocks consumers depend on", () => {
    for (const name of [
      "AesGcmSecretCipher",
      "DEFAULT_REFERENCE_SERVER_CONFIG",
      "InMemoryReferenceRepository",
      "PostgresReferenceRepository",
      "ReferenceService",
      "ReferenceApiError",
      "RepositoryCommitUncertainError",
      "PayloadCleanupConflictError",
      "REFERENCE_SERVER_MIGRATIONS",
      "buildReferenceServer",
      "migrateReferenceServerFromEnv",
      "payloadStorageFromEnv",
      "referenceServerConfigFromEnv",
      "runReferenceServerProcess",
      "startReferenceServerFromEnv",
    ]) {
      expect(referenceServer).toHaveProperty(name);
    }
  });

  it("does not leak generic reference-server internals", () => {
    for (const internal of [
      "compareCodeUnits",
      "compareNumbers",
      "safeTokenEqual",
      "referenceSha256",
      "isLoopbackHost",
    ]) {
      expect(referenceServer).not.toHaveProperty(internal);
    }
  });
});
