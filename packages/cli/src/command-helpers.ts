// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";

import {
  canonicalize,
  selectCanonicalEventVersion,
  type CanonicalContract,
  type CanonicalEventVersion,
  type ContractImportResult,
} from "@webhook-portal/contract-core";

import { booleanOption, stringOption } from "./arguments.js";
import {
  CliCommandError,
  CONTRACT_LIMIT_BYTES,
  READ_TIMEOUT_MILLISECONDS,
  commandOutput,
  resolveInputPath,
  resolveOutputPath,
  streams,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES } from "./exit-codes.js";
import type { JsonHttpResponse } from "./http-client.js";
import { atomicWriteFile, readInputText } from "./io.js";
import { emitSuccess } from "./output.js";
import { readSecret } from "./secrets.js";
import type { SecretSourceOptions } from "./secrets.js";

export const GENERAL_LIMIT_BYTES = 1024 * 1024;

export const TEST_BODY_LIMIT_BYTES = 256 * 1024;

export async function readContract(
  input: string,
  dependencies: CliDependencies,
): Promise<{ readonly source: string; readonly result: ContractImportResult }> {
  const source = await readInputText(
    resolveInputPath(dependencies.cwd, input),
    streams(dependencies),
    {
      maxBytes: CONTRACT_LIMIT_BYTES,
      timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    },
  );
  return {
    source,
    result: canonicalize(source, {
      sourceUri:
        input === "-" ? "stdin:" : path.resolve(dependencies.cwd, input),
      limits: { maxInputBytes: CONTRACT_LIMIT_BYTES },
    }),
  };
}

export function requireValidContract(
  result: ContractImportResult,
): CanonicalContract {
  if (result.status === "partial") {
    throw new CliCommandError(
      CLI_EXIT_CODES.partial,
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

export function selectEventVersion(
  contract: CanonicalContract,
  eventName: string,
  publicVersion?: string,
): CanonicalEventVersion {
  const selected = selectCanonicalEventVersion(
    contract,
    eventName,
    publicVersion,
  );
  if (selected.status === "version_required") {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "EVENT_VERSION_REQUIRED",
      "The event has multiple public versions; provide --version explicitly.",
      { availableVersions: selected.availableVersions },
    );
  }
  if (selected.status === "invalid_current_version") {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_CURRENT_EVENT_VERSION",
      "The contract marks an invalid or ambiguous current event version.",
      { availableVersions: selected.availableVersions },
    );
  }
  if (selected.status !== "found") {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "EVENT_NOT_FOUND",
      "The requested event/version is not present in the contract.",
      { availableVersions: selected.availableVersions },
    );
  }
  return selected.version;
}

export async function writeOrEmit(
  dependencies: CliDependencies,
  json: boolean,
  outputPath: string | undefined,
  content: string,
  value: unknown,
  humanLines: readonly string[],
): Promise<void> {
  if (outputPath !== undefined) {
    const destination = resolveOutputPath(dependencies.cwd, outputPath);
    await atomicWriteFile(destination, content);
    emitSuccess(
      commandOutput(dependencies, json),
      {
        ...((isObject(value) ? value : { value }) as object),
        output: destination,
      },
      [...humanLines, `Wrote ${destination}`],
    );
    return;
  }
  if (json) {
    emitSuccess(commandOutput(dependencies, true), value, []);
  } else {
    dependencies.stdout.write(content);
    if (!content.endsWith("\n")) {
      dependencies.stdout.write("\n");
    }
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serverError(response: JsonHttpResponse): CliCommandError {
  const error =
    isObject(response.body) && isObject(response.body["error"])
      ? response.body["error"]
      : undefined;
  const code =
    error !== undefined && typeof error["code"] === "string"
      ? error["code"]
      : "SERVER_REJECTED";
  const message =
    error !== undefined && typeof error["message"] === "string"
      ? error["message"]
      : `Reference server returned HTTP ${response.status}.`;
  const exitCode =
    code === "PUBLISH_INCOMPATIBLE"
      ? CLI_EXIT_CODES.incompatible
      : code === "INVALID_CURSOR"
        ? CLI_EXIT_CODES.invalid
        : response.status === 401 || response.status === 403
          ? CLI_EXIT_CODES.security
          : response.status === 422
            ? CLI_EXIT_CODES.invalid
            : CLI_EXIT_CODES.rejected;
  return new CliCommandError(exitCode, code, message, error?.["details"]);
}

export function secretSource(
  values: Readonly<Record<string, boolean | string | undefined>>,
  cwd: string,
): SecretSourceOptions {
  const environmentName = stringOption(values, "secret-env");
  const file = stringOption(values, "secret-file");
  return {
    ...(environmentName === undefined ? {} : { secretEnv: environmentName }),
    ...(file === undefined ? {} : { secretFile: path.resolve(cwd, file) }),
    ...(booleanOption(values, "secret-stdin") ? { secretStdin: true } : {}),
  };
}

export async function apiTokenHeaders(
  values: Readonly<Record<string, boolean | string | undefined>>,
  dependencies: CliDependencies,
): Promise<Readonly<Record<string, string>>> {
  const environmentName = stringOption(values, "api-token-env");
  const file = stringOption(values, "api-token-file");
  const defaultValue = dependencies.environment["REFERENCE_API_TOKEN"];
  const defaultFile = dependencies.environment["REFERENCE_API_TOKEN_FILE"];
  if (
    environmentName === undefined &&
    file === undefined &&
    defaultValue !== undefined &&
    defaultFile !== undefined
  ) {
    throw new RangeError(
      "Choose either REFERENCE_API_TOKEN or REFERENCE_API_TOKEN_FILE.",
    );
  }
  const token = await readSecret(
    {
      ...(environmentName === undefined ? {} : { secretEnv: environmentName }),
      ...((file ??
        (environmentName === undefined ? defaultFile : undefined)) === undefined
        ? {}
        : {
            secretFile: path.resolve(dependencies.cwd, file ?? defaultFile!),
          }),
    },
    {
      environment: dependencies.environment,
      stdin: dependencies.stdin,
      defaultEnvironmentName: "REFERENCE_API_TOKEN",
    },
  );
  return { authorization: `Bearer ${token}` };
}

export const SERVER_OPTIONS = {
  server: { type: "string" },
  "api-token-env": { type: "string" },
  "api-token-file": { type: "string" },
} satisfies ParseArgsOptionsConfig;

export const SECRET_OPTIONS = {
  "secret-env": { type: "string" },
  "secret-file": { type: "string" },
  "secret-stdin": { type: "boolean" },
} satisfies ParseArgsOptionsConfig;

export async function commandSecret(
  values: Readonly<Record<string, boolean | string | undefined>>,
  dependencies: CliDependencies,
  defaultEnvironmentName = "WEBHOOK_SECRET",
): Promise<string> {
  return readSecret(secretSource(values, dependencies.cwd), {
    environment: dependencies.environment,
    stdin: dependencies.stdin,
    defaultEnvironmentName,
  });
}
