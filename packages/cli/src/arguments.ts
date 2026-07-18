// SPDX-License-Identifier: Apache-2.0

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

export interface ParsedCommandArguments {
  readonly values: Readonly<Record<string, boolean | string | undefined>>;
  readonly positionals: readonly string[];
}

const GLOBAL_OPTIONS = Object.freeze({
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptionsConfig);

export function parseCommandArguments(
  args: readonly string[],
  options: ParseArgsOptionsConfig = {},
): ParsedCommandArguments {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { ...GLOBAL_OPTIONS, ...options },
  });
  return {
    values: parsed.values,
    positionals: parsed.positionals,
  };
}

export function stringOption(
  values: ParsedCommandArguments["values"],
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanOption(
  values: ParsedCommandArguments["values"],
  name: string,
): boolean {
  return values[name] === true;
}

export function integerOption(
  values: ParsedCommandArguments["values"],
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = stringOption(values, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `--${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}
