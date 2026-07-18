// SPDX-License-Identifier: Apache-2.0

export const CLI_EXIT_CODES = Object.freeze({
  success: 0,
  runtime: 1,
  usage: 2,
  invalid: 3,
  partial: 4,
  incompatible: 5,
  security: 6,
  unknown: 7,
  rejected: 8,
});

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];
