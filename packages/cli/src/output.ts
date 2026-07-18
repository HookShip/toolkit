// SPDX-License-Identifier: Apache-2.0

import type { Writable } from "node:stream";

import { redactDiagnostic, redactText, writeLine } from "./io.js";

export interface CommandOutput {
  readonly json: boolean;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export function emitSuccess(
  output: CommandOutput,
  value: unknown,
  humanLines: readonly string[],
): void {
  if (output.json) {
    writeLine(output.stdout, JSON.stringify(value));
    return;
  }
  for (const line of humanLines) {
    writeLine(output.stdout, line);
  }
}

export function emitFailure(
  output: CommandOutput,
  value: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  },
): void {
  if (output.json) {
    writeLine(
      output.stderr,
      JSON.stringify(
        redactDiagnostic({
          error: {
            code: value.code,
            message: redactText(value.message),
            ...(value.details === undefined ? {} : { details: value.details }),
          },
        }),
      ),
    );
    return;
  }
  writeLine(output.stderr, `${value.code}: ${redactText(value.message)}`);
}
