// SPDX-License-Identifier: Apache-2.0

import process from "node:process";

import {
  booleanOption,
  integerOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import {
  commandOutput,
  ensurePositionals,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import { emitSuccess } from "./output.js";
import {
  migrateReferenceServerFromEnv,
  startReferenceServerFromEnv,
  type RunningReferenceServer,
} from "./reference-server/runtime.js";

export async function migrateCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args);
  ensurePositionals(parsed.positionals, 0);
  const applied = await (
    dependencies.migrateServer ?? migrateReferenceServerFromEnv
  )(dependencies.environment);
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

async function waitForShutdown(running: RunningReferenceServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) {
        return;
      }
      closing = true;
      void running.close().then(resolve, reject);
    };
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
  const running = await (
    dependencies.startServer ?? startReferenceServerFromEnv
  )({
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
  await waitForShutdown(running);
  return CLI_EXIT_CODES.success;
}
