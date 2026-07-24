// SPDX-License-Identifier: Apache-2.0

import process from "node:process";

import {
  booleanOption,
  integerOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import {
  CliCommandError,
  commandOutput,
  ensurePositionals,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import { emitSuccess } from "./output.js";

// `serve` and `migrate` are the only commands that need the reference-server
// runtime (Fastify/PG/MinIO). It is loaded lazily from the optional peer
// `@webhook-portal/reference-server-core` so a CLI-only install stays lean; the
// static type reference elsewhere is erased.
type ReferenceServerRuntime =
  typeof import("@webhook-portal/reference-server-core");

async function loadReferenceServerRuntime(): Promise<ReferenceServerRuntime> {
  try {
    return await import("@webhook-portal/reference-server-core");
  } catch (error) {
    throw new CliCommandError(
      CLI_EXIT_CODES.runtime,
      "REFERENCE_SERVER_RUNTIME_MISSING",
      "The reference server runtime is not installed. Add the optional " +
        "@webhook-portal/reference-server-core package to run serve/migrate.",
      error instanceof Error ? { cause: error.message } : undefined,
    );
  }
}

export async function migrateCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args);
  ensurePositionals(parsed.positionals, 0);
  const migrate =
    dependencies.migrateServer ??
    (await loadReferenceServerRuntime()).migrateReferenceServerFromEnv;
  const applied = await migrate(dependencies.environment);
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    { command: "migrate", applied },
    [
      applied.length === 0
        ? "Database schema is already current."
        : `Applied migration(s): ${applied.join(", ")}`,
    ],
  );
  return CLI_EXIT_CODES.success;
}

interface ReferenceServerHandle {
  readonly address: string;
  close(): Promise<void>;
}

async function waitForShutdown(
  running: ReferenceServerHandle,
  shutdownSignal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) {
        return;
      }
      closing = true;
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      shutdownSignal?.removeEventListener("abort", shutdown);
      void running.close().then(resolve, reject);
    };
    if (shutdownSignal?.aborted === true) {
      shutdown();
      return;
    }
    shutdownSignal?.addEventListener("abort", shutdown, { once: true });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export async function serveCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    host: { type: "string" },
    port: { type: "string" },
    "allow-local-network": { type: "boolean" },
    migrate: { type: "boolean" },
  });
  ensurePositionals(parsed.positionals, 0);
  const start =
    dependencies.startServer ??
    (await loadReferenceServerRuntime()).startReferenceServerFromEnv;
  const running = await start({
    environment: dependencies.environment,
    autoMigrate: booleanOption(parsed.values, "migrate"),
    configOverrides: {
      ...(() => {
        const host = stringOption(parsed.values, "host");
        return host === undefined ? {} : { host };
      })(),
      ...(stringOption(parsed.values, "port") === undefined
        ? {}
        : {
            port: integerOption(parsed.values, "port", 3210, 0, 65_535),
          }),
      ...(booleanOption(parsed.values, "allow-local-network")
        ? { allowLocalNetwork: true }
        : {}),
    },
  });
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    { command: "serve", address: running.address },
    [`Reference server listening at ${running.address}`],
  );
  await waitForShutdown(running, dependencies.shutdownSignal);
  return CLI_EXIT_CODES.success;
}
