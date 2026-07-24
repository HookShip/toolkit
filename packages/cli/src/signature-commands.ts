// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { ParseArgsOptionsConfig } from "node:util";

import {
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
import {
  commandSecret,
  isObject,
  SECRET_OPTIONS,
  TEST_BODY_LIMIT_BYTES,
} from "./command-helpers.js";
import {
  CliCommandError,
  commandOutput,
  ensurePositionals,
  READ_TIMEOUT_MILLISECONDS,
  resolveInputPath,
  resolveOutputPath,
  streams,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import {
  assertSingleStdinConsumer,
  atomicWriteFile,
  parseJsonOrYaml,
  readInputBytes,
  readInputText,
} from "./io.js";
import { emitFailure, emitSuccess } from "./output.js";

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
