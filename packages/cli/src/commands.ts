// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ParseArgsOptionsConfig } from "node:util";

import {
  createAuthenticatedMetadataIngestEnvelope,
  secretValue,
  validateMetadataDeliveryAttemptInput,
  type MetadataDeliveryAttemptInput,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";
import {
  nodeHttpTransport,
  type HttpTransport,
} from "@webhook-portal/adapter-generic-http";
import {
  canonicalize,
  diff,
  fixtures,
  types,
  type CanonicalContract,
  type CanonicalEventVersion,
  type ContractImportResult,
} from "@webhook-portal/contract-core";
import {
  SigningError,
  WebhookSecret,
  signWebhook,
  tryVerifyWebhook,
  type WebhookHeadersInput,
} from "@webhook-portal/signing";

import {
  booleanOption,
  integerOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import { resolveSafeDestination } from "./destination.js";
import { selectCanonicalEventVersion } from "./event-version.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import {
  HttpRequestOutcomeUnknownError,
  InsecureAuthenticatedTransportError,
  joinServerUrl,
  requestJson,
  type JsonHttpResponse,
} from "./http-client.js";
import {
  assertSingleStdinConsumer,
  atomicWriteFile,
  parseJsonOrYaml,
  readInputBytes,
  readInputText,
  safeErrorMessage,
  StdinSourceConflictError,
  type CliStreams,
} from "./io.js";
import {
  compatibilityReportCommand,
  migrationAssessCommand,
  supportEvidenceCommand,
  supportEvidenceVerifyCommand,
} from "./learning-commands.js";
import { emitFailure, emitSuccess } from "./output.js";
import {
  migrateReferenceServerFromEnv,
  startReferenceServerFromEnv,
  type RunningReferenceServer,
} from "./reference-server/runtime.js";
import { publishRequestFingerprint } from "./reference-server/service.js";
import { readSecret } from "./secrets.js";
import type { SecretSourceOptions } from "./secrets.js";

const CONTRACT_LIMIT_BYTES = 4 * 1024 * 1024;
const GENERAL_LIMIT_BYTES = 1024 * 1024;
const TEST_BODY_LIMIT_BYTES = 256 * 1024;
const READ_TIMEOUT_MILLISECONDS = 5000;

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

function streams(dependencies: CliDependencies): CliStreams {
  return {
    stdin: dependencies.stdin,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
  };
}

function resolveInputPath(cwd: string, value: string): string {
  return value === "-" ? value : path.resolve(cwd, value);
}

function resolveOutputPath(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

function ensurePositionals(
  positionals: readonly string[],
  minimum: number,
  maximum = minimum,
): void {
  if (positionals.length < minimum || positionals.length > maximum) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "USAGE_ERROR",
      `Expected ${minimum === maximum ? minimum : `${minimum}-${maximum}`} positional argument(s).`,
    );
  }
}

function optionSpec(extra: ParseArgsOptionsConfig): ParseArgsOptionsConfig {
  return extra;
}

function commandOutput(dependencies: CliDependencies, json: boolean) {
  return {
    json,
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
  };
}

function statusExit(result: ContractImportResult): CliExitCode {
  if (result.status === "invalid") {
    return CLI_EXIT_CODES.invalid;
  }
  if (result.status === "partial") {
    return CLI_EXIT_CODES.partial;
  }
  return CLI_EXIT_CODES.success;
}

async function readContract(
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

function requireValidContract(result: ContractImportResult): CanonicalContract {
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

function selectEventVersion(
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

async function writeOrEmit(
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverError(response: JsonHttpResponse): CliCommandError {
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

function normalizedOverrideReason(
  values: Readonly<Record<string, boolean | string | undefined>>,
): string | undefined {
  const value = stringOption(values, "override-reason")?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function publishCommandBody(response: JsonHttpResponse):
  | {
      readonly command?: Record<string, unknown>;
      readonly release?: Record<string, unknown>;
      readonly status: "completed" | "pending" | "unknown";
    }
  | undefined {
  if (!isObject(response.body)) {
    return undefined;
  }
  const command = isObject(response.body["command"])
    ? response.body["command"]
    : undefined;
  const release = isObject(response.body["release"])
    ? response.body["release"]
    : undefined;
  const explicitStatus = response.body["status"];
  const status =
    explicitStatus === "completed" ||
    explicitStatus === "pending" ||
    explicitStatus === "unknown"
      ? explicitStatus
      : release !== undefined
        ? "completed"
        : command?.["state"] === "completed"
          ? "completed"
          : command !== undefined
            ? "pending"
            : undefined;
  return status === undefined
    ? undefined
    : {
        status,
        ...(command === undefined ? {} : { command }),
        ...(release === undefined ? {} : { release }),
      };
}

async function requestPublishStatus(
  server: string,
  headers: Readonly<Record<string, string>>,
  idempotencyKey: string,
  dependencies: CliDependencies,
): Promise<JsonHttpResponse> {
  return requestJson(joinServerUrl(server, "/v1/releases/publish/status"), {
    headers: {
      ...headers,
      "idempotency-key": idempotencyKey,
    },
    ...(dependencies.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: dependencies.fetchImplementation }),
    timeoutMilliseconds: 10_000,
  });
}

function assertPublishFingerprint(
  command: Record<string, unknown> | undefined,
  expectedFingerprint: string,
): void {
  if (
    command !== undefined &&
    typeof command["requestFingerprint"] === "string" &&
    command["requestFingerprint"] !== expectedFingerprint
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.rejected,
      "IDEMPOTENCY_CONFLICT",
      "The publish idempotency key was already used for another request.",
    );
  }
}

function publishUnknownError(
  idempotencyKey: string,
  code = "PUBLISH_OUTCOME_UNKNOWN",
  message = "The publish outcome could not be confirmed after checking publish status.",
): CliCommandError {
  return new CliCommandError(CLI_EXIT_CODES.unknown, code, message, {
    idempotencyKey,
    statusPath: "/v1/releases/publish/status",
  });
}

function emitPublishedRelease(
  dependencies: CliDependencies,
  json: boolean,
  input: {
    readonly idempotencyKey: string;
    readonly importId?: string;
    readonly recovered: boolean;
    readonly release: Record<string, unknown>;
  },
): void {
  emitSuccess(
    commandOutput(dependencies, json),
    {
      command: "publish",
      ...(input.importId === undefined ? {} : { importId: input.importId }),
      idempotencyKey: input.idempotencyKey,
      recovered: input.recovered,
      release: input.release,
    },
    [
      input.recovered
        ? "Recovered an already committed release."
        : input.importId === undefined
          ? "Published contract."
          : `Published import ${input.importId}`,
      ...(typeof input.release["id"] === "string"
        ? [`Release: ${input.release["id"]}`]
        : []),
      ...(typeof input.release["checksum"] === "string"
        ? [`Checksum: ${input.release["checksum"]}`]
        : []),
      `Idempotency key: ${input.idempotencyKey}`,
    ],
  );
}

function secretSource(
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

async function apiTokenHeaders(
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

const SERVER_OPTIONS = {
  server: { type: "string" },
  "api-token-env": { type: "string" },
  "api-token-file": { type: "string" },
} satisfies ParseArgsOptionsConfig;

const SECRET_OPTIONS = {
  "secret-env": { type: "string" },
  "secret-file": { type: "string" },
  "secret-stdin": { type: "boolean" },
} satisfies ParseArgsOptionsConfig;

export async function validateCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args);
  ensurePositionals(parsed.positionals, 1);
  const { result } = await readContract(parsed.positionals[0]!, dependencies);
  const exitCode = statusExit(result);
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    {
      command: "validate",
      status: result.status,
      supported: result.parsed.supported,
      format: result.parsed.format,
      specificationVersion: result.parsed.specificationVersion,
      sourceChecksum: result.parsed.sourceChecksum,
      canonicalChecksum: result.contract?.checksum,
      diagnostics: result.diagnostics,
    },
    [
      `Contract status: ${result.status}`,
      `Supported: ${String(result.parsed.supported)}`,
      `Diagnostics: ${result.diagnostics.length}`,
      ...(result.contract === undefined
        ? []
        : [`Canonical checksum: ${result.contract.checksum.value}`]),
    ],
  );
  return exitCode;
}

export async function importCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(
    args,
    optionSpec({ out: { type: "string", short: "o" } }),
  );
  ensurePositionals(parsed.positionals, 1);
  const input = parsed.positionals[0]!;
  const { result } = await readContract(input, dependencies);
  const exitCode = statusExit(result);
  if (result.export === undefined) {
    emitSuccess(
      commandOutput(dependencies, booleanOption(parsed.values, "json")),
      {
        command: "import",
        status: result.status,
        diagnostics: result.diagnostics,
      },
      [
        `Import status: ${result.status}`,
        `Diagnostics: ${result.diagnostics.length}`,
      ],
    );
    return exitCode;
  }
  const outputPath =
    stringOption(parsed.values, "out") ??
    (input === "-" ? undefined : `${input}.canonical.json`);
  if (input === "-" && outputPath === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "OUTPUT_REQUIRED",
      "Importing from stdin requires --out.",
    );
  }
  await writeOrEmit(
    dependencies,
    booleanOption(parsed.values, "json"),
    outputPath,
    `${JSON.stringify(result.export, null, 2)}\n`,
    {
      command: "import",
      status: result.status,
      canonicalChecksum: result.contract?.checksum.value,
      diagnostics: result.diagnostics,
    },
    [`Import status: ${result.status}`],
  );
  return exitCode;
}

export async function publishCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    ...SERVER_OPTIONS,
    "idempotency-key": { type: "string" },
    "override-reason": { type: "string" },
  });
  ensurePositionals(parsed.positionals, 1);
  const input = parsed.positionals[0]!;
  const { source, result } = await readContract(input, dependencies);
  const contract = requireValidContract(result);
  const server =
    stringOption(parsed.values, "server") ?? "http://127.0.0.1:3210";
  const headers = await apiTokenHeaders(parsed.values, dependencies);
  const overrideReason = normalizedOverrideReason(parsed.values);
  const requestFingerprint = publishRequestFingerprint(
    contract.checksum.value,
    overrideReason,
  );
  const publishIdempotencyKey =
    stringOption(parsed.values, "idempotency-key") ??
    `publish_${requestFingerprint}`;
  const json = booleanOption(parsed.values, "json");

  const preflight = await requestPublishStatus(
    server,
    headers,
    publishIdempotencyKey,
    dependencies,
  );
  if (preflight.status !== 404) {
    if (preflight.status < 200 || preflight.status >= 300) {
      throw serverError(preflight);
    }
    const status = publishCommandBody(preflight);
    if (status === undefined) {
      throw new CliCommandError(
        CLI_EXIT_CODES.runtime,
        "INVALID_SERVER_RESPONSE",
        "Reference server did not return publish status.",
      );
    }
    assertPublishFingerprint(status.command, requestFingerprint);
    if (status.status === "completed" && status.release !== undefined) {
      emitPublishedRelease(dependencies, json, {
        idempotencyKey: publishIdempotencyKey,
        ...(typeof status.command?.["importId"] === "string"
          ? { importId: status.command["importId"] }
          : {}),
        recovered: true,
        release: status.release,
      });
      return CLI_EXIT_CODES.success;
    }
    throw publishUnknownError(
      publishIdempotencyKey,
      status.status === "pending" ? "PUBLISH_PENDING" : undefined,
      status.status === "pending"
        ? "The original publish request is still pending."
        : undefined,
    );
  }

  const imported = await requestJson(
    joinServerUrl(server, "/v1/contracts/import"),
    {
      method: "POST",
      headers,
      body: {
        source,
        mediaType:
          result.parsed.syntax === "json"
            ? "application/json"
            : "application/yaml",
        sourceUri:
          input === "-" ? "stdin:" : path.resolve(dependencies.cwd, input),
      },
      ...(dependencies.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: dependencies.fetchImplementation }),
      timeoutMilliseconds: 15_000,
    },
  );
  if (imported.status < 200 || imported.status >= 300) {
    throw serverError(imported);
  }
  const importId =
    isObject(imported.body) &&
    isObject(imported.body["import"]) &&
    typeof imported.body["import"]["id"] === "string"
      ? imported.body["import"]["id"]
      : undefined;
  if (importId === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.runtime,
      "INVALID_SERVER_RESPONSE",
      "Reference server did not return an import identifier.",
    );
  }
  let published: JsonHttpResponse;
  try {
    published = await requestJson(
      joinServerUrl(server, "/v1/releases/publish"),
      {
        method: "POST",
        headers: {
          ...headers,
          "idempotency-key": publishIdempotencyKey,
        },
        body: {
          importId,
          ...(overrideReason === undefined ? {} : { overrideReason }),
        },
        ...(dependencies.fetchImplementation === undefined
          ? {}
          : { fetchImplementation: dependencies.fetchImplementation }),
        timeoutMilliseconds: 15_000,
      },
    );
  } catch (error) {
    if (error instanceof HttpRequestOutcomeUnknownError) {
      try {
        const statusResponse = await requestPublishStatus(
          server,
          headers,
          publishIdempotencyKey,
          dependencies,
        );
        if (statusResponse.status >= 200 && statusResponse.status < 300) {
          const status = publishCommandBody(statusResponse);
          if (status !== undefined) {
            assertPublishFingerprint(status.command, requestFingerprint);
            if (status.status === "completed" && status.release !== undefined) {
              emitPublishedRelease(dependencies, json, {
                idempotencyKey: publishIdempotencyKey,
                importId:
                  typeof status.command?.["importId"] === "string"
                    ? status.command["importId"]
                    : importId,
                recovered: true,
                release: status.release,
              });
              return CLI_EXIT_CODES.success;
            }
          }
        } else if (statusResponse.status !== 404) {
          throw serverError(statusResponse);
        }
      } catch (statusError) {
        if (
          statusError instanceof CliCommandError &&
          statusError.code === "IDEMPOTENCY_CONFLICT"
        ) {
          throw statusError;
        }
      }
      throw publishUnknownError(publishIdempotencyKey);
    }
    throw error;
  }
  if (published.status < 200 || published.status >= 300) {
    throw serverError(published);
  }
  if (published.status === 202) {
    const status = publishCommandBody(published);
    throw publishUnknownError(
      publishIdempotencyKey,
      status?.status === "pending" ? "PUBLISH_PENDING" : undefined,
      status?.status === "pending"
        ? "The original publish request is still pending."
        : undefined,
    );
  }
  const release =
    isObject(published.body) && isObject(published.body["release"])
      ? published.body["release"]
      : undefined;
  if (release === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.runtime,
      "INVALID_SERVER_RESPONSE",
      "Reference server did not return a published release.",
    );
  }
  emitPublishedRelease(dependencies, json, {
    idempotencyKey: publishIdempotencyKey,
    importId,
    recovered: false,
    release,
  });
  return CLI_EXIT_CODES.success;
}

export async function publishStatusCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    ...SERVER_OPTIONS,
    "idempotency-key": { type: "string" },
  });
  ensurePositionals(parsed.positionals, 0);
  const key = stringOption(parsed.values, "idempotency-key");
  if (key === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "IDEMPOTENCY_KEY_REQUIRED",
      "--idempotency-key is required.",
    );
  }
  const server =
    stringOption(parsed.values, "server") ?? "http://127.0.0.1:3210";
  const response = await requestPublishStatus(
    server,
    await apiTokenHeaders(parsed.values, dependencies),
    key,
    dependencies,
  );
  if (response.status < 200 || response.status >= 300) {
    throw serverError(response);
  }
  const status = publishCommandBody(response);
  if (status === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.runtime,
      "INVALID_SERVER_RESPONSE",
      "Reference server did not return publish status.",
    );
  }
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    { command: "publish-status", response: response.body },
    [
      `Publish state: ${status.status}`,
      ...(typeof status.release?.["id"] === "string"
        ? [`Release: ${status.release["id"]}`]
        : typeof status.command?.["releaseId"] === "string"
          ? [`Release: ${status.command["releaseId"]}`]
          : []),
    ],
  );
  return status.status === "completed"
    ? CLI_EXIT_CODES.success
    : CLI_EXIT_CODES.unknown;
}

export async function diffCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    "max-changes": { type: "string" },
  });
  ensurePositionals(parsed.positionals, 2);
  assertSingleStdinConsumer(
    parsed.positionals.map((input, index) => ({
      name: `contract ${index + 1}`,
      usesStdin: input === "-",
    })),
  );
  const previous = requireValidContract(
    (await readContract(parsed.positionals[0]!, dependencies)).result,
  );
  const next = requireValidContract(
    (await readContract(parsed.positionals[1]!, dependencies)).result,
  );
  const result = diff(previous, next, {
    maxChanges: integerOption(parsed.values, "max-changes", 1000, 1, 10_000),
  });
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    { command: "diff", ...result },
    [
      `Compatibility: ${result.status}`,
      result.summary,
      `Changes: ${result.changes.length}`,
    ],
  );
  return result.status === "breaking" || result.status === "unknown"
    ? CLI_EXIT_CODES.incompatible
    : CLI_EXIT_CODES.success;
}

export async function fixtureCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    event: { type: "string" },
    version: { type: "string" },
    out: { type: "string", short: "o" },
    "include-optional": { type: "boolean" },
    "max-depth": { type: "string" },
    "max-array-items": { type: "string" },
  });
  ensurePositionals(parsed.positionals, 1);
  const eventName = stringOption(parsed.values, "event");
  if (eventName === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "EVENT_REQUIRED",
      "--event is required.",
    );
  }
  const contract = requireValidContract(
    (await readContract(parsed.positionals[0]!, dependencies)).result,
  );
  const version = selectEventVersion(
    contract,
    eventName,
    stringOption(parsed.values, "version"),
  );
  const generated = fixtures(version.schema.value, {
    includeOptionalProperties: booleanOption(parsed.values, "include-optional"),
    maxDepth: integerOption(parsed.values, "max-depth", 32, 1, 128),
    maxArrayItems: integerOption(parsed.values, "max-array-items", 3, 0, 100),
  });
  if (generated.value === undefined) {
    emitSuccess(
      commandOutput(dependencies, booleanOption(parsed.values, "json")),
      { command: "fixture", ...generated },
      [`Fixture status: ${generated.status}`],
    );
    return generated.status === "unsupported"
      ? CLI_EXIT_CODES.partial
      : CLI_EXIT_CODES.invalid;
  }
  await writeOrEmit(
    dependencies,
    booleanOption(parsed.values, "json"),
    stringOption(parsed.values, "out"),
    `${JSON.stringify(generated.value, null, 2)}\n`,
    { command: "fixture", ...generated },
    [`Fixture status: ${generated.status}`],
  );
  return generated.status === "generated"
    ? CLI_EXIT_CODES.success
    : CLI_EXIT_CODES.partial;
}

export async function typesCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    event: { type: "string" },
    version: { type: "string" },
    out: { type: "string", short: "o" },
    name: { type: "string" },
    "max-depth": { type: "string" },
    "no-export": { type: "boolean" },
  });
  ensurePositionals(parsed.positionals, 1);
  const eventName = stringOption(parsed.values, "event");
  if (eventName === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "EVENT_REQUIRED",
      "--event is required.",
    );
  }
  const contract = requireValidContract(
    (await readContract(parsed.positionals[0]!, dependencies)).result,
  );
  const version = selectEventVersion(
    contract,
    eventName,
    stringOption(parsed.values, "version"),
  );
  const generated = types(version.schema.value, {
    typeName: stringOption(parsed.values, "name") ?? eventName,
    maxDepth: integerOption(parsed.values, "max-depth", 32, 1, 128),
    exportType: !booleanOption(parsed.values, "no-export"),
  });
  await writeOrEmit(
    dependencies,
    booleanOption(parsed.values, "json"),
    stringOption(parsed.values, "out"),
    generated.code,
    { command: "types", ...generated },
    [`Type generation status: ${generated.status}`],
  );
  return generated.status === "generated"
    ? CLI_EXIT_CODES.success
    : CLI_EXIT_CODES.partial;
}

function secretOptionsSpec(): ParseArgsOptionsConfig {
  return {
    ...SECRET_OPTIONS,
    "message-id": { type: "string" },
    timestamp: { type: "string" },
    out: { type: "string", short: "o" },
  };
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "INVALID_TIMESTAMP",
      "--timestamp must be a non-negative Unix-seconds integer.",
    );
  }
  return timestamp;
}

async function commandSecret(
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

export async function signCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, secretOptionsSpec());
  ensurePositionals(parsed.positionals, 0, 1);
  const bodyPath = parsed.positionals[0] ?? "-";
  assertSingleStdinConsumer([
    { name: "body", usesStdin: bodyPath === "-" },
    {
      name: "secret",
      usesStdin: booleanOption(parsed.values, "secret-stdin"),
    },
  ]);
  const body = await readInputBytes(
    resolveInputPath(dependencies.cwd, bodyPath),
    streams(dependencies),
    {
      maxBytes: TEST_BODY_LIMIT_BYTES,
      timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    },
  );
  const secret = WebhookSecret.fromEncoded(
    await commandSecret(parsed.values, dependencies),
  );
  const signed = signWebhook({
    messageId:
      stringOption(parsed.values, "message-id") ??
      `msg_${(dependencies.idFactory ?? randomUUID)().replaceAll("-", "")}`,
    body,
    secret,
    ...(parseTimestamp(stringOption(parsed.values, "timestamp")) === undefined
      ? {}
      : {
          timestamp: parseTimestamp(stringOption(parsed.values, "timestamp"))!,
        }),
  });
  const value = { command: "sign", ...signed };
  const outputPath = stringOption(parsed.values, "out");
  if (outputPath !== undefined) {
    await atomicWriteFile(
      resolveOutputPath(dependencies.cwd, outputPath),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    {
      ...value,
      ...(outputPath === undefined
        ? {}
        : { output: resolveOutputPath(dependencies.cwd, outputPath) }),
    },
    [
      `webhook-id: ${signed.headers["webhook-id"]}`,
      `webhook-timestamp: ${signed.headers["webhook-timestamp"]}`,
      `webhook-signature: ${signed.headers["webhook-signature"]}`,
      ...(outputPath === undefined
        ? []
        : [`Wrote ${resolveOutputPath(dependencies.cwd, outputPath)}`]),
    ],
  );
  return CLI_EXIT_CODES.success;
}

function headersFromOptions(
  values: Readonly<Record<string, boolean | string | undefined>>,
): WebhookHeadersInput | undefined {
  const id = stringOption(values, "webhook-id");
  const timestamp = stringOption(values, "webhook-timestamp");
  const signature = stringOption(values, "webhook-signature");
  if (id === undefined && timestamp === undefined && signature === undefined) {
    return undefined;
  }
  if (id === undefined || timestamp === undefined || signature === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "INCOMPLETE_HEADERS",
      "Provide webhook-id, webhook-timestamp, and webhook-signature together.",
    );
  }
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  };
}

export async function verifyCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    ...SECRET_OPTIONS,
    headers: { type: "string" },
    "webhook-id": { type: "string" },
    "webhook-timestamp": { type: "string" },
    "webhook-signature": { type: "string" },
    tolerance: { type: "string" },
  });
  ensurePositionals(parsed.positionals, 0, 1);
  const bodyPath = parsed.positionals[0] ?? "-";
  const headerPath = stringOption(parsed.values, "headers");
  assertSingleStdinConsumer([
    { name: "body", usesStdin: bodyPath === "-" },
    { name: "headers", usesStdin: headerPath === "-" },
    {
      name: "secret",
      usesStdin: booleanOption(parsed.values, "secret-stdin"),
    },
  ]);
  const body = await readInputBytes(
    resolveInputPath(dependencies.cwd, bodyPath),
    streams(dependencies),
    {
      maxBytes: TEST_BODY_LIMIT_BYTES,
      timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    },
  );
  let headers = headersFromOptions(parsed.values);
  if (headerPath !== undefined) {
    if (headers !== undefined) {
      throw new CliCommandError(
        CLI_EXIT_CODES.usage,
        "HEADER_SOURCE_CONFLICT",
        "Use either --headers or individual webhook header options.",
      );
    }
    const parsedHeaders = parseJsonOrYaml(
      await readInputText(
        resolveInputPath(dependencies.cwd, headerPath),
        streams(dependencies),
        {
          maxBytes: 64 * 1024,
          timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
        },
      ),
      "headers",
    );
    if (!isObject(parsedHeaders)) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_HEADERS",
        "Headers input must be an object.",
      );
    }
    headers = Object.fromEntries(
      Object.entries(parsedHeaders).flatMap(([name, value]) =>
        typeof value === "string" ? [[name, value]] : [],
      ),
    );
  }
  if (headers === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "HEADERS_REQUIRED",
      "Webhook headers are required.",
    );
  }
  const result = tryVerifyWebhook({
    body,
    headers,
    secrets: WebhookSecret.fromEncoded(
      await commandSecret(parsed.values, dependencies),
    ),
    toleranceSeconds: integerOption(parsed.values, "tolerance", 300, 0, 86_400),
  });
  if (!result.ok) {
    emitFailure(
      commandOutput(dependencies, booleanOption(parsed.values, "json")),
      {
        code: result.error.code,
        message: "Webhook verification failed.",
      },
    );
    return CLI_EXIT_CODES.security;
  }
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    { command: "verify", ...result },
    [
      "Webhook signature is valid.",
      `Message ID: ${result.messageId}`,
      `Timestamp: ${result.timestamp}`,
    ],
  );
  return CLI_EXIT_CODES.success;
}

async function testBodyFromOptions(
  parsed: ReturnType<typeof parseCommandArguments>,
  dependencies: CliDependencies,
): Promise<Buffer> {
  const contractPath = stringOption(parsed.values, "contract");
  if (contractPath === undefined) {
    const bodyPath = parsed.positionals[0] ?? "-";
    return readInputBytes(
      resolveInputPath(dependencies.cwd, bodyPath),
      streams(dependencies),
      {
        maxBytes: TEST_BODY_LIMIT_BYTES,
        timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
      },
    );
  }
  if (parsed.positionals.length > 0) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "BODY_SOURCE_CONFLICT",
      "Use either a body path or --contract.",
    );
  }
  const eventName = stringOption(parsed.values, "event");
  if (eventName === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "EVENT_REQUIRED",
      "--event is required with --contract.",
    );
  }
  const contract = requireValidContract(
    (await readContract(contractPath, dependencies)).result,
  );
  const version = selectEventVersion(
    contract,
    eventName,
    stringOption(parsed.values, "version"),
  );
  const example = version.examples[0]?.value;
  const generated =
    example === undefined ? fixtures(version.schema.value) : undefined;
  if (
    example === undefined &&
    (generated?.status !== "generated" || generated.value === undefined)
  ) {
    throw new CliCommandError(
      CLI_EXIT_CODES.partial,
      "FIXTURE_NOT_EXACT",
      "The event cannot produce an exact canonical fixture.",
      generated?.diagnostics,
    );
  }
  return Buffer.from(JSON.stringify(example ?? generated!.value), "utf8");
}

export async function sendTestCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    ...SECRET_OPTIONS,
    url: { type: "string" },
    contract: { type: "string" },
    event: { type: "string" },
    version: { type: "string" },
    "message-id": { type: "string" },
    deadline: { type: "string" },
    "allow-local-network": { type: "boolean" },
  });
  ensurePositionals(parsed.positionals, 0, 1);
  const contractPath = stringOption(parsed.values, "contract");
  if (contractPath !== undefined && parsed.positionals.length > 0) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "BODY_SOURCE_CONFLICT",
      "Use either a body path or --contract.",
    );
  }
  assertSingleStdinConsumer([
    {
      name: "body",
      usesStdin:
        contractPath === undefined && (parsed.positionals[0] ?? "-") === "-",
    },
    { name: "contract", usesStdin: contractPath === "-" },
    {
      name: "secret",
      usesStdin: booleanOption(parsed.values, "secret-stdin"),
    },
  ]);
  const url = stringOption(parsed.values, "url");
  if (url === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "URL_REQUIRED",
      "--url is required.",
    );
  }
  const body = await testBodyFromOptions(parsed, dependencies);
  if (body.byteLength > TEST_BODY_LIMIT_BYTES) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "TEST_BODY_TOO_LARGE",
      "Test body exceeds the 256 KiB limit.",
    );
  }
  const allowLocalNetwork = booleanOption(parsed.values, "allow-local-network");
  let destination;
  try {
    destination = await resolveSafeDestination(url, { allowLocalNetwork });
  } catch {
    throw new CliCommandError(
      CLI_EXIT_CODES.security,
      allowLocalNetwork
        ? "UNSAFE_DESTINATION"
        : "LOCAL_NETWORK_OPT_IN_REQUIRED",
      allowLocalNetwork
        ? "The destination failed URL or network safety validation."
        : "The destination is unsafe or requires --allow-local-network.",
    );
  }
  const messageId =
    stringOption(parsed.values, "message-id") ??
    `test_${(dependencies.idFactory ?? randomUUID)().replaceAll("-", "")}`;
  const signed = signWebhook({
    messageId,
    body,
    secret: WebhookSecret.fromEncoded(
      await commandSecret(parsed.values, dependencies),
    ),
  });
  const timeoutMilliseconds = integerOption(
    parsed.values,
    "deadline",
    10_000,
    100,
    30_000,
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Test deadline exceeded.")),
    timeoutMilliseconds,
  );
  timer.unref();
  try {
    const response = await (dependencies.httpTransport ?? nodeHttpTransport)({
      method: "POST",
      url: destination.url,
      resolvedAddresses: destination.addresses,
      signal: controller.signal,
      maxResponseBodyBytes: 64 * 1024,
      maxResponseHeaderBytes: 32 * 1024,
      headers: {
        ...signed.headers,
        "content-type": "application/webhook+json",
        "content-length": String(body.byteLength),
        "user-agent": "webhook-portal-cli/1",
        "webhook-test": "true",
      },
      body,
    });
    const delivered = response.status >= 200 && response.status < 300;
    emitSuccess(
      commandOutput(dependencies, booleanOption(parsed.values, "json")),
      {
        command: "send-test",
        state: delivered ? "delivered" : "failed",
        atMostOnce: true,
        attempts: 1,
        messageId,
        statusCode: response.status,
      },
      [
        `Test state: ${delivered ? "delivered" : "failed"}`,
        "Attempts: 1 (automatic retry disabled)",
        `HTTP status: ${response.status}`,
        `Message ID: ${messageId}`,
      ],
    );
    return delivered ? CLI_EXIT_CODES.success : CLI_EXIT_CODES.rejected;
  } catch {
    emitFailure(
      commandOutput(dependencies, booleanOption(parsed.values, "json")),
      {
        code: "DELIVERY_OUTCOME_UNKNOWN",
        message:
          "The at-most-once request was dispatched, but its final outcome is unknown. It was not retried.",
        details: { attempts: 1, messageId },
      },
    );
    return CLI_EXIT_CODES.unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function ingestCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    ...SERVER_OPTIONS,
    ...SECRET_OPTIONS,
    "credential-id": { type: "string" },
    "adapter-id": { type: "string" },
    "connection-id": { type: "string" },
    environment: { type: "string" },
    tenant: { type: "string" },
    "batch-id": { type: "string" },
  });
  ensurePositionals(parsed.positionals, 1);
  assertSingleStdinConsumer([
    { name: "metadata", usesStdin: parsed.positionals[0] === "-" },
    {
      name: "secret",
      usesStdin: booleanOption(parsed.values, "secret-stdin"),
    },
  ]);
  const raw = parseJsonOrYaml(
    await readInputText(
      resolveInputPath(dependencies.cwd, parsed.positionals[0]!),
      streams(dependencies),
      {
        maxBytes: GENERAL_LIMIT_BYTES,
        timeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
      },
    ),
    "metadata",
  );
  const candidates = Array.isArray(raw) ? raw : [raw];
  if (candidates.length === 0 || candidates.length > 1000) {
    throw new CliCommandError(
      CLI_EXIT_CODES.invalid,
      "INVALID_METADATA_BATCH",
      "Metadata batch must contain between 1 and 1000 records.",
    );
  }
  const records: MetadataDeliveryAttemptInput[] = [];
  for (const candidate of candidates) {
    const validated = validateMetadataDeliveryAttemptInput(candidate);
    if (!validated.ok) {
      throw new CliCommandError(
        CLI_EXIT_CODES.invalid,
        "INVALID_METADATA",
        "A metadata record failed the closed allowlist schema.",
        validated.issues,
      );
    }
    records.push(validated.value);
  }
  const identity = {
    adapterId: stringOption(parsed.values, "adapter-id") ?? "generic-http",
    connectionId: stringOption(parsed.values, "connection-id") ?? "local",
    environment: stringOption(parsed.values, "environment") ?? "development",
    tenantId: stringOption(parsed.values, "tenant") ?? "local",
  };
  const credentialId =
    stringOption(parsed.values, "credential-id") ??
    dependencies.environment["REFERENCE_INGEST_CREDENTIAL_ID"] ??
    "local-ingest";
  const credential: ScopedCredential = {
    id: credentialId,
    kind: "bearer",
    role: "metadata_ingest",
    scope: {
      adapterId: identity.adapterId,
      connectionId: identity.connectionId,
      environments: [identity.environment],
      operations: ["metadata.ingest"],
      tenantId: identity.tenantId,
    },
    secret: secretValue(
      await commandSecret(
        parsed.values,
        dependencies,
        "REFERENCE_INGEST_SECRET",
      ),
      { id: credentialId, purpose: "metadata.ingest" },
    ),
  };
  const envelope = createAuthenticatedMetadataIngestEnvelope(
    records,
    identity,
    stringOption(parsed.values, "batch-id") ??
      (dependencies.idFactory ?? randomUUID)(),
    credential,
  );
  const server =
    stringOption(parsed.values, "server") ?? "http://127.0.0.1:3210";
  let response: JsonHttpResponse;
  try {
    response = await requestJson(joinServerUrl(server, "/v1/ingest"), {
      method: "POST",
      headers: {
        authorization: `Webhook-Ingest ${envelope.signature.value}`,
        "x-webhook-ingest-credential": envelope.credentialId,
      },
      body: envelope,
      ...(dependencies.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: dependencies.fetchImplementation }),
      timeoutMilliseconds: 10_000,
    });
  } catch (error) {
    if (error instanceof HttpRequestOutcomeUnknownError) {
      throw new CliCommandError(
        CLI_EXIT_CODES.unknown,
        "METADATA_INGEST_OUTCOME_UNKNOWN",
        `The metadata ingest outcome could not be confirmed and may have committed. Reconcile batch ${envelope.batchId} before retrying.`,
        { batchId: envelope.batchId },
      );
    }
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    throw serverError(response);
  }
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    {
      command: "ingest",
      batchId: envelope.batchId,
      response: response.body,
    },
    [
      `Metadata batch accepted (${records.length} record(s)).`,
      `Batch ID: ${envelope.batchId}`,
    ],
  );
  return CLI_EXIT_CODES.success;
}

export async function timelineCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    ...SERVER_OPTIONS,
    limit: { type: "string" },
    cursor: { type: "string" },
    "delivery-id": { type: "string" },
    "endpoint-id": { type: "string" },
    "event-id": { type: "string" },
    event: { type: "string" },
    status: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
  });
  ensurePositionals(parsed.positionals, 0);
  const query = new URLSearchParams();
  query.set("limit", String(integerOption(parsed.values, "limit", 50, 1, 200)));
  const mappings = [
    ["cursor", "cursor"],
    ["delivery-id", "deliveryId"],
    ["endpoint-id", "endpointId"],
    ["event-id", "eventId"],
    ["event", "eventType"],
    ["status", "status"],
    ["from", "from"],
    ["to", "to"],
  ] as const;
  for (const [option, parameterName] of mappings) {
    const value = stringOption(parsed.values, option);
    if (value !== undefined) {
      query.set(parameterName, value);
    }
  }
  const server =
    stringOption(parsed.values, "server") ?? "http://127.0.0.1:3210";
  const response = await requestJson(
    `${joinServerUrl(server, "/v1/timeline")}?${query.toString()}`,
    {
      headers: await apiTokenHeaders(parsed.values, dependencies),
      ...(dependencies.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: dependencies.fetchImplementation }),
      timeoutMilliseconds: 10_000,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw serverError(response);
  }
  const items =
    isObject(response.body) && Array.isArray(response.body["items"])
      ? response.body["items"]
      : [];
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    { command: "timeline", response: response.body },
    items.length === 0
      ? ["No timeline entries. Payload not stored."]
      : items.map((item) => {
          if (!isObject(item) || !isObject(item["current"])) {
            return "Timeline entry";
          }
          const current = item["current"];
          const eventVersion = isObject(current["eventVersion"])
            ? current["eventVersion"]
            : {};
          return `${String(eventVersion["eventType"] ?? "unknown")} ${String(current["status"] ?? "unknown")} ${String(current["occurredAt"] ?? "")} — ${item["payloadRetained"] === true ? "payload retained locally" : "payload not stored"}`;
        }),
  );
  return CLI_EXIT_CODES.success;
}

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
