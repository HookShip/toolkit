// SPDX-License-Identifier: Apache-2.0

import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { looksLikeCredentialValue } from "@webhook-portal/canonical-model/redaction";
import {
  canonicalize,
  type CanonicalContract,
  type ContractImportResult,
} from "@webhook-portal/contract-core";

import { stringOption } from "./arguments.js";
import {
  CONTRACT_LIMIT_BYTES,
  READ_TIMEOUT_MILLISECONDS,
  CliCommandError,
  commandOutput,
  resolveInputPath,
  resolveOutputPath,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import { atomicWriteFile, parseJsonOrYaml, readInputText } from "./io.js";
import { emitSuccess } from "./output.js";

export const STRUCTURED_LIMIT_BYTES = 1024 * 1024;

export const KEY_LIMIT_BYTES = 16 * 1024;

export type ArtifactFormat = "json" | "markdown";

export function requiredOption(
  values: Readonly<Record<string, boolean | string | undefined>>,
  name: string,
): string {
  const value = stringOption(values, name);
  if (value === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "OPTION_REQUIRED",
      `--${name} is required.`,
    );
  }
  return value;
}

export function enumOption<const Value extends string>(
  values: Readonly<Record<string, boolean | string | undefined>>,
  name: string,
  allowed: readonly Value[],
  fallback: Value,
): Value {
  const value = stringOption(values, name);
  if (value === undefined) {
    return fallback;
  }
  if (!allowed.includes(value as Value)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "INVALID_OPTION",
      `--${name} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as Value;
}

export function optionalInteger(
  values: Readonly<Record<string, boolean | string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = stringOption(values, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "INVALID_OPTION",
      `--${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function artifactFormat(
  values: Readonly<Record<string, boolean | string | undefined>>,
  fallback: ArtifactFormat,
): ArtifactFormat {
  return enumOption(values, "format", ["json", "markdown"], fallback);
}

export async function emitArtifact(
  dependencies: CliDependencies,
  options: {
    readonly content: string;
    readonly envelope: Readonly<Record<string, unknown>>;
    readonly humanSummary: readonly string[];
    readonly json: boolean;
    readonly outputPath?: string;
  },
): Promise<void> {
  if (options.outputPath !== undefined) {
    const destination = resolveOutputPath(dependencies.cwd, options.outputPath);
    await atomicWriteFile(destination, options.content);
    emitSuccess(
      commandOutput(dependencies, options.json),
      { ...options.envelope, output: destination },
      [...options.humanSummary, `Wrote ${destination}`],
    );
    return;
  }
  if (options.json) {
    emitSuccess(
      commandOutput(dependencies, true),
      options.envelope,
      options.humanSummary,
    );
    return;
  }
  dependencies.stdout.write(options.content);
  if (!options.content.endsWith("\n")) {
    dependencies.stdout.write("\n");
  }
}

export async function readStructuredInput(
  input: string,
  name: string,
  dependencies: CliDependencies,
): Promise<unknown> {
  const source = await readInputText(
    resolveInputPath(dependencies.cwd, input),
    {
      stdin: dependencies.stdin,
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
    },
    {
      maxBytes: STRUCTURED_LIMIT_BYTES,
      timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    },
  );
  return parseJsonOrYaml(source, name);
}

export function validContract(
  result: ContractImportResult,
  partialExitCode: CliExitCode,
): CanonicalContract {
  if (result.status === "partial") {
    throw new CliCommandError(
      partialExitCode,
      "CONTRACT_PARTIAL",
      "The contract contains unsupported or partial content.",
      result.diagnostics,
    );
  }
  if (result.status !== "valid" || result.contract === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "CONTRACT_INVALID",
      "The contract is invalid.",
      result.diagnostics,
    );
  }
  return result.contract;
}

export async function readExactContract(
  input: string,
  dependencies: CliDependencies,
  partialExitCode: CliExitCode = CLI_EXIT_CODES.partial,
): Promise<CanonicalContract> {
  const source = await readInputText(
    resolveInputPath(dependencies.cwd, input),
    {
      stdin: dependencies.stdin,
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
    },
    {
      maxBytes: CONTRACT_LIMIT_BYTES,
      timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    },
  );
  return validContract(
    canonicalize(source, {
      sourceUri:
        input === "-" ? "stdin:" : path.resolve(dependencies.cwd, input),
      limits: { maxInputBytes: CONTRACT_LIMIT_BYTES },
    }),
    partialExitCode,
  );
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_INPUT",
      `${label} must be a plain object.`,
    );
  }
  return value;
}

export function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "UNKNOWN_FIELD",
        `${label} contains an unsupported field.`,
      );
    }
  }
}

export function safeString(
  value: unknown,
  label: string,
  maximum = 1024,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_INPUT",
      `${label} must be a bounded safe string.`,
    );
  }
  return value;
}

export function looksLikeCredential(value: string): boolean {
  return looksLikeCredentialValue(value);
}

export function assertNoCredentialValues(
  input: unknown,
  maximumValues = 100_000,
): void {
  const stack: unknown[] = [input];
  let inspected = 0;
  while (stack.length > 0) {
    inspected += 1;
    if (inspected > maximumValues) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INPUT_LIMIT_EXCEEDED",
        "Structured input exceeds the inspection limit.",
      );
    }
    const value = stack.pop();
    if (typeof value === "string") {
      if (looksLikeCredential(value)) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "CREDENTIAL_VALUE_REJECTED",
          "Credential material is not accepted by this command.",
        );
      }
    } else if (Array.isArray(value)) {
      stack.push(...value);
    } else if (isPlainRecord(value)) {
      stack.push(...Object.values(value));
    }
  }
}

const SENSITIVE_TIMELINE_FIELD =
  /(?:address|authorization|body|card|cookie|credential|customer|cvv|email|header|iban|password|payload|payment|phone|pii|privatekey|query|secret|ssn|taxid|token|url|uri)/u;

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function assertMetadataOnlyInput(input: unknown): void {
  const stack: unknown[] = [input];
  let inspected = 0;
  while (stack.length > 0) {
    inspected += 1;
    if (inspected > 100_000) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INPUT_LIMIT_EXCEEDED",
        "Timeline exceeds the metadata inspection limit.",
      );
    }
    const value = stack.pop();
    if (typeof value === "string") {
      if (looksLikeCredential(value)) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "SENSITIVE_TIMELINE_REJECTED",
          "Timeline input contains forbidden sensitive material.",
        );
      }
      continue;
    }
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (!isPlainRecord(value)) {
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (
        normalized !== "payloadretained" &&
        SENSITIVE_TIMELINE_FIELD.test(normalized)
      ) {
        throw new CliCommandError(
          CLI_EXIT_CODES.invalid,
          "SENSITIVE_TIMELINE_REJECTED",
          "Timeline input contains a forbidden non-metadata field.",
        );
      }
      stack.push(item);
    }
  }
}

export function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TIMESTAMP",
      `${label} must be an ISO-8601 timestamp.`,
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TIMESTAMP",
      `${label} must be an ISO-8601 timestamp.`,
    );
  }
  return new Date(milliseconds).toISOString();
}

export function optionTimestamp(
  values: Readonly<Record<string, boolean | string | undefined>>,
  name: string,
): string | undefined {
  const value = stringOption(values, name);
  return value === undefined
    ? undefined
    : canonicalTimestamp(value, `--${name}`);
}

export async function readKeyFile(
  value: string,
  baseDirectory: string,
  kind: "private" | "public",
): Promise<KeyObject> {
  if (value === "-") {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "KEY_STDIN_FORBIDDEN",
      `${kind === "private" ? "Private" : "Public"} keys must be read from a file, not stdin.`,
    );
  }
  const resolved = path.resolve(baseDirectory, value);
  let metadata;
  try {
    metadata = await stat(resolved);
  } catch {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "KEY_FILE_INVALID",
      `${kind === "private" ? "Private" : "Public"} key file could not be read.`,
    );
  }
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > KEY_LIMIT_BYTES
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "KEY_FILE_INVALID",
      `${kind === "private" ? "Private" : "Public"} key path must be a bounded regular file.`,
    );
  }
  if (kind === "private" && (metadata.mode & 0o077) !== 0) {
    throw new CliCommandError(
      CLI_EXIT_CODES.security,
      "PRIVATE_KEY_PERMISSIONS",
      "Private key file permissions must not grant group or other access.",
    );
  }
  try {
    const source = await readFile(resolved);
    return kind === "private"
      ? createPrivateKey(source)
      : createPublicKey(source);
  } catch {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "KEY_FILE_INVALID",
      `${kind === "private" ? "Private" : "Public"} key file is invalid.`,
    );
  }
}

export function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TARGET_POLICY",
      `${label} must be a finite non-negative number.`,
    );
  }
  return value;
}

export function nonNegativeInteger(value: unknown, label: string): number {
  const number = nonNegativeNumber(value, label);
  if (!Number.isSafeInteger(number)) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TARGET_POLICY",
      `${label} must be an integer.`,
    );
  }
  return number;
}

export function optionalBoolean(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_TARGET_POLICY",
      `${label} must be a boolean.`,
    );
  }
  return value;
}
