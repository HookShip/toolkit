// SPDX-License-Identifier: Apache-2.0

import process from "node:process";

import {
  commandFailure,
  helpCommand,
  runCommand,
  type CliDependencies,
} from "./commands.js";
import type { CliExitCode } from "./exit-codes.js";

export type RunCliDependencies = Partial<CliDependencies>;

function dependenciesWithDefaults(input: RunCliDependencies): CliDependencies {
  return {
    cwd: input.cwd ?? process.cwd(),
    environment: input.environment ?? process.env,
    stdin: input.stdin ?? process.stdin,
    stdout: input.stdout ?? process.stdout,
    stderr: input.stderr ?? process.stderr,
    ...(input.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: input.fetchImplementation }),
    ...(input.httpTransport === undefined
      ? {}
      : { httpTransport: input.httpTransport }),
    ...(input.idFactory === undefined ? {} : { idFactory: input.idFactory }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.startServer === undefined
      ? {}
      : { startServer: input.startServer }),
    ...(input.migrateServer === undefined
      ? {}
      : { migrateServer: input.migrateServer }),
  };
}

export async function runCli(
  argv: readonly string[],
  input: RunCliDependencies = {},
): Promise<CliExitCode> {
  const dependencies = dependenciesWithDefaults(input);
  const json = argv.includes("--json");
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return helpCommand(json, dependencies);
  }
  let command = argv[0]!;
  let args = argv.slice(1);
  if (command === "metadata") {
    command = args[0] ?? "";
    args = args.slice(1);
    if (command !== "ingest" && command !== "timeline") {
      command = "";
    }
  }
  if (args.includes("--help") || args.includes("-h")) {
    return helpCommand(json, dependencies);
  }
  try {
    return await runCommand(command, args, dependencies);
  } catch (error) {
    return commandFailure(error, json, dependencies);
  }
}
