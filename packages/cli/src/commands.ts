// SPDX-License-Identifier: Apache-2.0

import { SigningError } from "@webhook-portal/signing";

import {
  diffCommand,
  fixtureCommand,
  importCommand,
  typesCommand,
  validateCommand,
} from "./contract-commands.js";
import {
  commandOutput,
  CliCommandError,
  type CliDependencies,
} from "./command-support.js";
import {
  ingestCommand,
  sendTestCommand,
  timelineCommand,
} from "./dispatch-commands.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import { InsecureAuthenticatedTransportError } from "./http-client.js";
import { safeErrorMessage, StdinSourceConflictError } from "./io.js";
import {
  compatibilityReportCommand,
  migrationAssessCommand,
  supportEvidenceCommand,
  supportEvidenceVerifyCommand,
} from "./learning-commands.js";
import { emitFailure, emitSuccess } from "./output.js";
import { publishCommand, publishStatusCommand } from "./publish-commands.js";
import { migrateCommand, serveCommand } from "./server-commands.js";
import { signCommand, verifyCommand } from "./signature-commands.js";

export { CliCommandError, type CliDependencies } from "./command-support.js";
export { migrateCommand, serveCommand };

export function helpCommand(
  json: boolean,
  dependencies: CliDependencies,
): CliExitCode {
  const commands = [
    "validate <contract|->",
    "import <contract|-> [--out file]",
    "publish <contract|-> [--server url] [--idempotency-key key]",
    "publish-status --idempotency-key key [--server url]",
    "diff <previous> <next>",
    "compatibility-report <previous> <next> [--format json|markdown]",
    "migration-assess <inventory> <contract> --target-capabilities file",
    "support-evidence <timeline> --case-id id --scope file",
    "support-evidence-verify <bundle> [--public-key-file file]",
    "fixture <contract> --event name [--out file]",
    "types <contract> --event name [--out file]",
    "sign [body|-] (secret from WEBHOOK_SECRET/env/file/stdin)",
    "verify [body|-] --headers file",
    "send-test [body|-] --url url [--allow-local-network]",
    "serve [--migrate]",
    "migrate",
    "ingest <metadata|-> [--server url] [--credential-id id] [--batch-id id]",
    "timeline [filters] [--server url]",
  ];
  emitSuccess(
    commandOutput(dependencies, json),
    {
      name: "webhook-portal",
      commands,
      exitCodes: CLI_EXIT_CODES,
    },
    [
      "Usage: webhook-portal <command> [options]",
      "",
      "Commands:",
      ...commands.map((command) => `  ${command}`),
      "",
      "Global: --json emits machine-readable output.",
      "Secrets are accepted from environment variables, permission-restricted files, or stdin; never as command arguments.",
    ],
  );
  return CLI_EXIT_CODES.success;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  switch (command) {
    case "validate":
      return validateCommand(args, dependencies);
    case "import":
      return importCommand(args, dependencies);
    case "publish":
      return publishCommand(args, dependencies);
    case "publish-status":
      return publishStatusCommand(args, dependencies);
    case "diff":
      return diffCommand(args, dependencies);
    case "compatibility-report":
      return compatibilityReportCommand(args, dependencies);
    case "migration-assess":
      return migrationAssessCommand(args, dependencies);
    case "support-evidence":
      return supportEvidenceCommand(args, dependencies);
    case "support-evidence-verify":
      return supportEvidenceVerifyCommand(args, dependencies);
    case "fixture":
      return fixtureCommand(args, dependencies);
    case "types":
      return typesCommand(args, dependencies);
    case "sign":
      return signCommand(args, dependencies);
    case "verify":
      return verifyCommand(args, dependencies);
    case "send-test":
      return sendTestCommand(args, dependencies);
    case "serve":
      return serveCommand(args, dependencies);
    case "migrate":
      return migrateCommand(args, dependencies);
    case "ingest":
      return ingestCommand(args, dependencies);
    case "timeline":
      return timelineCommand(args, dependencies);
    case "help":
      return helpCommand(args.includes("--json"), dependencies);
    default:
      throw new CliCommandError(
        CLI_EXIT_CODES.usage,
        "UNKNOWN_COMMAND",
        `Unknown command "${command}".`,
      );
  }
}

export function commandFailure(
  error: unknown,
  json: boolean,
  dependencies: CliDependencies,
): CliExitCode {
  if (error instanceof CliCommandError) {
    emitFailure(commandOutput(dependencies, json), {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return error.exitCode;
  }
  if (error instanceof SigningError) {
    emitFailure(commandOutput(dependencies, json), {
      code: error.code,
      message: "The signing or verification input was rejected.",
    });
    return CLI_EXIT_CODES.security;
  }
  if (error instanceof InsecureAuthenticatedTransportError) {
    emitFailure(commandOutput(dependencies, json), {
      code: "INSECURE_SERVER_TRANSPORT",
      message: error.message,
    });
    return CLI_EXIT_CODES.security;
  }
  const nodeCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  if (nodeCode?.startsWith("ERR_PARSE_ARGS_")) {
    emitFailure(commandOutput(dependencies, json), {
      code: "USAGE_ERROR",
      message: safeErrorMessage(error),
    });
    return CLI_EXIT_CODES.usage;
  }
  if (error instanceof StdinSourceConflictError) {
    emitFailure(commandOutput(dependencies, json), {
      code: "STDIN_CONFLICT",
      message: error.message,
      details: { sources: error.sources },
    });
    return CLI_EXIT_CODES.usage;
  }
  if (
    error instanceof RangeError ||
    error instanceof SyntaxError ||
    nodeCode === "ENOENT"
  ) {
    emitFailure(commandOutput(dependencies, json), {
      code: "INVALID_INPUT",
      message: safeErrorMessage(error),
    });
    return CLI_EXIT_CODES.invalid;
  }
  emitFailure(commandOutput(dependencies, json), {
    code: "COMMAND_FAILED",
    message: safeErrorMessage(error),
  });
  return CLI_EXIT_CODES.runtime;
}
