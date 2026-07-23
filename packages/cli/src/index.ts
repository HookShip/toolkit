// SPDX-License-Identifier: Apache-2.0

// Curated public API for `@webhook-portal/cli`. The programmatic entry point is
// `runCli`; the command dispatcher and error/exit contracts are exposed for
// embedding callers. Low-level helpers (argument parsing, IO, HTTP, output,
// secrets, redaction) and individual command implementations are intentionally
// NOT re-exported — import them from their module directly within the package.
// The reference-server surface is published separately via
// `@webhook-portal/cli/reference-server`.

export {
  CliCommandError,
  commandFailure,
  helpCommand,
  runCommand,
  type CliDependencies,
} from "./commands.js";
export { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
export { runCli, type RunCliDependencies } from "./run.js";
