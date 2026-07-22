// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ParseArgsOptionsConfig } from "node:util";

import type { HttpTransport } from "@webhook-portal/adapter-generic-http";

import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import type { CliStreams } from "./io.js";
import type {
  migrateReferenceServerFromEnv,
  startReferenceServerFromEnv,
} from "./reference-server/runtime.js";

/** Shared byte/time budgets applied when a command reads a contract source. */
export const CONTRACT_LIMIT_BYTES = 4 * 1024 * 1024;
export const READ_TIMEOUT_MILLISECONDS = 5000;

/**
 * Process-level collaborators injected into every command. Kept here so the
 * per-family command modules and the shared helpers agree on one definition
 * without importing each other.
 */
export interface CliDependencies {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly fetchImplementation?: typeof fetch;
  readonly httpTransport?: HttpTransport;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly startServer?: typeof startReferenceServerFromEnv;
  readonly migrateServer?: typeof migrateReferenceServerFromEnv;
}

/** Structural view of the streams a command reads from and writes to. */
export type CommandStreamsSource = Pick<
  CliDependencies,
  "stdin" | "stdout" | "stderr"
>;

export class CliCommandError extends Error {
  readonly exitCode: CliExitCode;
  readonly code: string;
  readonly details: unknown;

  constructor(
    exitCode: CliExitCode,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "CliCommandError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

export function streams(source: CommandStreamsSource): CliStreams {
  return {
    stdin: source.stdin,
    stdout: source.stdout,
    stderr: source.stderr,
  };
}

/** Resolves a command input path, leaving the `-` stdin sentinel untouched. */
export function resolveInputPath(cwd: string, value: string): string {
  return value === "-" ? value : path.resolve(cwd, value);
}

export function resolveOutputPath(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

/**
 * Enforces an inclusive positional-argument count. A single `minimum` requires
 * exactly that many; a `maximum` allows a range.
 */
export function ensurePositionals(
  positionals: readonly string[],
  minimum: number,
  maximum = minimum,
): void {
  if (positionals.length < minimum || positionals.length > maximum) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "USAGE_ERROR",
      `Expected ${
        minimum === maximum ? minimum : `${minimum}-${maximum}`
      } positional argument(s).`,
    );
  }
}

export function optionSpec(
  extra: ParseArgsOptionsConfig,
): ParseArgsOptionsConfig {
  return extra;
}

/** Standard `{ json, stdout, stderr }` sink passed to the output emitters. */
export function commandOutput(
  source: Pick<CommandStreamsSource, "stdout" | "stderr">,
  json: boolean,
): { readonly json: boolean; readonly stdout: Writable; readonly stderr: Writable } {
  return {
    json,
    stdout: source.stdout,
    stderr: source.stderr,
  };
}
