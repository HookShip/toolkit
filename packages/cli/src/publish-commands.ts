// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { publishRequestFingerprint } from "@webhook-portal/contract-core";

import {
  booleanOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import {
  CliCommandError,
  commandOutput,
  ensurePositionals,
  type CliDependencies,
} from "./command-support.js";
import {
  apiTokenHeaders,
  isObject,
  readContract,
  requireValidContract,
  serverError,
  SERVER_OPTIONS,
} from "./command-helpers.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import {
  HttpRequestOutcomeUnknownError,
  joinServerUrl,
  requestJson,
  type JsonHttpResponse,
} from "./http-client.js";
import { emitSuccess } from "./output.js";

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
