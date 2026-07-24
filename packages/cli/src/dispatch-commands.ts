// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  createAuthenticatedMetadataIngestEnvelope,
  secretValue,
  validateMetadataDeliveryAttemptInput,
  type MetadataDeliveryAttemptInput,
  type ScopedCredential,
} from "@webhook-portal/adapter-sdk";
import {
  nodeHttpTransport,
  resolveSafeDestination,
} from "@webhook-portal/adapter-generic-http";
import { fixtures } from "@webhook-portal/contract-core";
import { WebhookSecret, signWebhook } from "@webhook-portal/signing";

import {
  booleanOption,
  integerOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import {
  apiTokenHeaders,
  commandSecret,
  GENERAL_LIMIT_BYTES,
  isObject,
  readContract,
  requireValidContract,
  SECRET_OPTIONS,
  selectEventVersion,
  serverError,
  SERVER_OPTIONS,
  TEST_BODY_LIMIT_BYTES,
} from "./command-helpers.js";
import {
  CliCommandError,
  commandOutput,
  ensurePositionals,
  READ_TIMEOUT_MILLISECONDS,
  resolveInputPath,
  streams,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import {
  HttpRequestOutcomeUnknownError,
  joinServerUrl,
  requestJson,
  type JsonHttpResponse,
} from "./http-client.js";
import {
  assertSingleStdinConsumer,
  parseJsonOrYaml,
  readInputBytes,
  readInputText,
} from "./io.js";
import { emitFailure, emitSuccess } from "./output.js";

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
