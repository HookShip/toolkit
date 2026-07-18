// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import type { HttpTransport } from "@webhook-portal/adapter-generic-http";

import {
  atomicWriteFile,
  CLI_EXIT_CODES,
  readBoundedStream,
  runCli,
} from "../src/index.js";
import { emitFailure, emitSuccess } from "../src/output.js";
import {
  AesGcmSecretCipher,
  DEFAULT_REFERENCE_SERVER_CONFIG,
  InMemoryReferenceRepository,
  buildReferenceServer,
  payloadStorageFromEnv,
  referenceServerConfigFromEnv,
} from "../src/reference-server/index.js";

class CaptureWriter extends Writable {
  #value = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#value += chunk.toString();
    callback();
  }

  override toString(): string {
    return this.#value;
  }
}

const scratchDirectories: string[] = [];

async function scratch(): Promise<string> {
  const directory = path.resolve(
    "packages/cli/test",
    `.scratch-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  scratchDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function openApi(version = "3.1.0"): string {
  return JSON.stringify({
    openapi: version,
    info: { title: "Orders", version: "1.0.0" },
    webhooks: {
      "order.created": {
        post: {
          "x-event-id": "order-created",
          "x-event-type": "order.created",
          "x-event-version": "1",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id"],
                  properties: { id: { type: "string" } },
                },
                example: { id: "ord_1" },
              },
            },
          },
          responses: { "204": { description: "Accepted" } },
        },
      },
    },
  });
}

function multiVersionOpenApi(): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Orders", version: "1.0.0" },
    webhooks: Object.fromEntries(
      ["1", "2", "10"].map((version) => [
        `order-created-${version}`,
        {
          post: {
            "x-event-id": "order-created",
            "x-event-type": "order.created",
            "x-event-version": version,
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["version"],
                    properties: {
                      version: { type: "string", const: version },
                    },
                  },
                  example: { version },
                },
              },
            },
            responses: { "204": { description: "Accepted" } },
          },
        },
      ]),
    ),
  });
}

function largeOpenApi(): string {
  const description = "x".repeat(405_000);
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Large orders", version: "1.0.0" },
    webhooks: Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `order.event.${index}`,
        {
          post: {
            description,
            "x-event-id": `order-event-${index}`,
            "x-event-type": `order.event.${index}`,
            "x-event-version": "1",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: { id: { type: "string" } },
                  },
                },
              },
            },
            responses: { "204": { description: "Accepted" } },
          },
        },
      ]),
    ),
  });
}

function metadataDeliveryAttempt(): Record<string, unknown> {
  return {
    attempt: 1,
    deliveryId: "delivery_embedded_1",
    endpointId: "endpoint_embedded_1",
    eventId: "event_embedded_1",
    eventVersion: {
      eventType: "order.created",
      schemaChecksum: "a".repeat(64),
      version: "1",
    },
    kind: "delivery_attempt",
    mappingVersion: {
      name: "webhook-portal.canonical",
      schemaVersion: "2026-07-01",
      version: "1.0.0",
    },
    occurredAt: "2026-07-16T00:00:00.000Z",
    schemaVersion: "2026-07-01",
    sequence: 1,
    status: "delivered",
  };
}

function systemError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

async function invoke(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly stdin?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly fetchImplementation?: typeof fetch;
    readonly httpTransport?: HttpTransport;
  } = {},
) {
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const exitCode = await runCli(argv, {
    cwd: options.cwd ?? process.cwd(),
    environment: options.environment ?? {},
    stdin: Readable.from([options.stdin ?? ""]),
    stdout,
    stderr,
    ...(options.httpTransport === undefined
      ? {}
      : { httpTransport: options.httpTransport }),
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
    idFactory: () => "00000000-0000-4000-8000-000000000001",
  });
  return {
    exitCode,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
  };
}

describe("CLI", () => {
  it("cancels an open input stream on timeout without destroying a shared stream", async () => {
    const stdin = new PassThrough();
    const sharedErrorListener = () => undefined;
    stdin.on("error", sharedErrorListener);

    await expect(
      readBoundedStream(stdin, {
        maxBytes: 1024,
        timeoutMilliseconds: 25,
      }),
    ).rejects.toThrow("Input read deadline exceeded.");

    expect(stdin.destroyed).toBe(false);
    expect(stdin.readableFlowing).toBe(false);
    for (const event of ["close", "data", "end"]) {
      expect(stdin.listenerCount(event)).toBe(0);
    }
    expect(stdin.listeners("error")).toEqual([sharedErrorListener]);

    const reused = readBoundedStream(stdin, {
      maxBytes: 1024,
      timeoutMilliseconds: 1000,
    });
    stdin.end("still usable");
    await expect(reused).resolves.toEqual(Buffer.from("still usable"));
    stdin.off("error", sharedErrorListener);
  });

  it("uses deterministic validation exit codes for valid, partial, and invalid contracts", async () => {
    const valid = await invoke(["validate", "-", "--json"], {
      stdin: openApi(),
    });
    const partial = await invoke(["validate", "-", "--json"], {
      stdin: openApi("3.0.3"),
    });
    const invalid = await invoke(["validate", "-", "--json"], {
      stdin: '{"openapi":',
    });

    expect(valid.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(valid.stdout)).toMatchObject({ status: "valid" });
    expect(partial.exitCode).toBe(CLI_EXIT_CODES.partial);
    expect(JSON.parse(partial.stdout)).toMatchObject({ status: "partial" });
    expect(invalid.exitCode).toBe(CLI_EXIT_CODES.invalid);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ status: "invalid" });
  });

  it("writes imported artifacts atomically without leaving temporary files", async () => {
    const directory = await scratch();
    await writeFile(path.join(directory, "contract.yaml"), openApi());
    const result = await invoke(
      ["import", "contract.yaml", "--out", "canonical.json", "--json"],
      { cwd: directory },
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
    const written = JSON.parse(
      await readFile(path.join(directory, "canonical.json"), "utf8"),
    );
    expect(written).toMatchObject({
      format: "webhook-portal.canonical-contract",
    });
    expect(await readdir(directory)).toEqual([
      "canonical.json",
      "contract.yaml",
    ]);
  });

  it.each(["EPERM", "EINVAL", "ENOTSUP"])(
    "keeps a renamed output on Windows when directory open reports %s",
    async (code) => {
      const directory = await scratch();
      const destination = path.join(directory, "output.json");

      await atomicWriteFile(destination, '{"ok":true}\n', 0o644, {
        platform: "win32",
        openDirectory: async () => {
          throw systemError(code);
        },
      });

      expect(await readFile(destination, "utf8")).toBe('{"ok":true}\n');
      expect(await readdir(directory)).toEqual(["output.json"]);
    },
  );

  it("tolerates unsupported Windows directory fsync after closing the handle", async () => {
    const directory = await scratch();
    const destination = path.join(directory, "output.json");
    let closed = false;

    await atomicWriteFile(destination, '{"ok":true}\n', 0o644, {
      platform: "win32",
      openDirectory: async () => ({
        close: async () => {
          closed = true;
        },
        sync: async () => {
          throw systemError("ENOTSUP");
        },
      }),
    });

    expect(closed).toBe(true);
    expect(await readFile(destination, "utf8")).toBe('{"ok":true}\n');
  });

  it("does not mask POSIX directory fsync failures or unrelated Windows errors", async () => {
    const directory = await scratch();
    const posixDestination = path.join(directory, "posix.json");
    const windowsDestination = path.join(directory, "windows.json");

    await expect(
      atomicWriteFile(posixDestination, "posix\n", 0o644, {
        platform: "linux",
        openDirectory: async () => {
          throw systemError("EPERM");
        },
      }),
    ).rejects.toMatchObject({ code: "EPERM" });
    await expect(
      atomicWriteFile(windowsDestination, "windows\n", 0o644, {
        platform: "win32",
        openDirectory: async () => {
          throw systemError("EIO");
        },
      }),
    ).rejects.toMatchObject({ code: "EIO" });

    expect(await readFile(posixDestination, "utf8")).toBe("posix\n");
    expect(await readFile(windowsDestination, "utf8")).toBe("windows\n");
  });

  it("redacts secret-looking values from errors", async () => {
    const secret = "whsec_QWxhZGRpbjpvcGVuIHNlc2FtZSBmb3IgdGVzdGluZw==";
    const result = await invoke([secret, "--json"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).toContain("[REDACTED]");
  });

  it("preserves successful JSON values without diagnostic redaction", () => {
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    emitSuccess(
      { json: true, stdout, stderr },
      {
        payload: { token: "ordinary-value" },
        text: "token=ordinary-value",
      },
      [],
    );

    expect(JSON.parse(stdout.toString())).toEqual({
      payload: { token: "ordinary-value" },
      text: "token=ordinary-value",
    });
  });

  it("redacts sensitive diagnostic keys while preserving safe JSON types", () => {
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    emitFailure(
      { json: true, stdout, stderr },
      {
        code: "TEST_FAILURE",
        message: "Request failed.",
        details: {
          attempts: 1,
          messageId: "message_1",
          token: "must-not-leak",
        },
      },
    );

    expect(JSON.parse(stderr.toString())).toEqual({
      error: {
        code: "TEST_FAILURE",
        message: "Request failed.",
        details: {
          attempts: 1,
          messageId: "message_1",
          token: "[REDACTED]",
        },
      },
    });
  });

  it("returns a deterministic usage exit for unknown options", async () => {
    const result = await invoke(
      ["validate", "-", "--not-an-option", "--json"],
      {
        stdin: openApi(),
      },
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(result.stderr).toContain("USAGE_ERROR");
  });

  it("rejects local destinations without explicit opt-in", async () => {
    const result = await invoke(
      ["send-test", "-", "--url", "http://127.0.0.1:9999", "--json"],
      {
        stdin: '{"id":"evt_1"}',
        environment: {
          WEBHOOK_SECRET: "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        },
      },
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.security);
    expect(result.stderr).toContain("LOCAL_NETWORK_OPT_IN_REQUIRED");
  });

  it("dispatches send-test at most once and reports an unknown timeout", async () => {
    let calls = 0;
    const result = await invoke(
      [
        "send-test",
        "-",
        "--url",
        "http://127.0.0.1:9999",
        "--allow-local-network",
        "--json",
      ],
      {
        stdin: '{"id":"evt_1"}',
        environment: {
          WEBHOOK_SECRET: "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        },
        httpTransport: async () => {
          calls += 1;
          throw new Error("network token=should-not-leak");
        },
      },
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.unknown);
    expect(calls).toBe(1);
    expect(result.stderr).toContain("DELIVERY_OUTCOME_UNKNOWN");
    expect(result.stderr).not.toContain("should-not-leak");
  });

  it("returns a security exit for invalid signatures", async () => {
    const result = await invoke(
      [
        "verify",
        "-",
        "--webhook-id",
        "msg_1",
        "--webhook-timestamp",
        String(Math.floor(Date.now() / 1000)),
        "--webhook-signature",
        "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "--json",
      ],
      {
        stdin: '{"ok":true}',
        environment: {
          WEBHOOK_SECRET: "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        },
      },
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.security);
    expect(result.stderr).toContain("signature_mismatch");
  });

  it("round-trips Standard Webhooks sign and verify commands", async () => {
    const directory = await scratch();
    const secret = "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    await writeFile(path.join(directory, "body.json"), '{"ok":true}\n');
    await writeFile(path.join(directory, "webhook.secret"), `${secret}\n`, {
      mode: 0o600,
    });
    await chmod(path.join(directory, "webhook.secret"), 0o600);
    const signed = await invoke(
      [
        "sign",
        "body.json",
        "--message-id",
        "msg_roundtrip",
        "--secret-file",
        "webhook.secret",
        "--json",
      ],
      {
        cwd: directory,
      },
    );
    const signedBody = JSON.parse(signed.stdout) as {
      headers: Record<string, string>;
    };
    await writeFile(
      path.join(directory, "headers.json"),
      JSON.stringify(signedBody.headers),
    );
    const verified = await invoke(
      [
        "verify",
        "body.json",
        "--headers",
        "headers.json",
        "--secret-file",
        "webhook.secret",
        "--json",
      ],
      {
        cwd: directory,
      },
    );

    expect(signed.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(verified.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      messageId: "msg_roundtrip",
    });
  });

  it("resolves embedded-run secret and API token files from the CLI cwd", async () => {
    const directory = await scratch();
    const webhookSecret = "whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    await Promise.all([
      writeFile(path.join(directory, "body.json"), '{"ok":true}\n'),
      writeFile(
        path.join(directory, "metadata.json"),
        JSON.stringify(metadataDeliveryAttempt()),
      ),
      writeFile(path.join(directory, "webhook.secret"), `${webhookSecret}\n`, {
        mode: 0o600,
      }),
      writeFile(
        path.join(directory, "ingest.secret"),
        "embedded-ingest-secret\n",
        { mode: 0o600 },
      ),
      writeFile(path.join(directory, "api.token"), "embedded-api-token\n", {
        mode: 0o600,
      }),
    ]);
    await Promise.all(
      ["webhook.secret", "ingest.secret", "api.token"].map((name) =>
        chmod(path.join(directory, name), 0o600),
      ),
    );
    expect(directory).not.toBe(process.cwd());

    const sent = await invoke(
      [
        "send-test",
        "body.json",
        "--url",
        "http://127.0.0.1:9999",
        "--allow-local-network",
        "--secret-file",
        "webhook.secret",
        "--json",
      ],
      {
        cwd: directory,
        httpTransport: async () => ({ status: 204 }),
      },
    );
    const ingested = await invoke(
      [
        "ingest",
        "metadata.json",
        "--secret-file",
        "ingest.secret",
        "--batch-id",
        "batch_embedded_1",
        "--json",
      ],
      {
        cwd: directory,
        fetchImplementation: async () =>
          new Response(JSON.stringify({ accepted: 1 }), {
            headers: { "content-type": "application/json" },
            status: 202,
          }),
      },
    );
    let authorization = "";
    const timeline = await invoke(
      ["timeline", "--api-token-file", "api.token", "--json"],
      {
        cwd: directory,
        fetchImplementation: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(JSON.stringify({ items: [] }), {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        },
      },
    );
    let environmentAuthorization = "";
    const timelineFromEnvironment = await invoke(["timeline", "--json"], {
      cwd: directory,
      environment: { REFERENCE_API_TOKEN_FILE: "api.token" },
      fetchImplementation: async (_input, init) => {
        environmentAuthorization =
          new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
    });

    expect(sent.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(ingested.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(timeline.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(timelineFromEnvironment.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(authorization).toBe("Bearer embedded-api-token");
    expect(environmentAuthorization).toBe("Bearer embedded-api-token");
  });

  it.each([
    ["JSON", true],
    ["human", false],
  ])(
    "reports metadata ingest network uncertainty with a reconcilable batch ID in %s output",
    async (_format, json) => {
      const batchId = "batch_uncertain_1";
      const result = await invoke(
        ["ingest", "-", "--batch-id", batchId, ...(json ? ["--json"] : [])],
        {
          stdin: JSON.stringify(metadataDeliveryAttempt()),
          environment: {
            REFERENCE_INGEST_SECRET: "metadata-ingest-secret-for-tests",
          },
          fetchImplementation: async () => {
            throw new Error("connection closed after possible commit");
          },
        },
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.unknown);
      expect(result.stderr).toContain("METADATA_INGEST_OUTCOME_UNKNOWN");
      expect(result.stderr).toContain(batchId);
      expect(result.stderr).toContain("may have committed");
      expect(result.stderr).not.toContain("COMMAND_FAILED");
      if (json) {
        expect(JSON.parse(result.stderr)).toMatchObject({
          error: {
            code: "METADATA_INGEST_OUTCOME_UNKNOWN",
            details: { batchId },
          },
        });
      }
    },
  );

  it("uses the setup ingest credential ID by default and permits a secret-safe override", async () => {
    const setupCredentialId = "ingest_setup_generated";
    const overrideCredentialId = "ingest_explicit_override";
    const secret = "metadata-ingest-secret-for-tests";
    const requests: Array<{
      readonly credentialHeader: string | null;
      readonly credentialId: unknown;
    }> = [];
    const fetchImplementation: typeof fetch = async (_input, init) => {
      requests.push({
        credentialHeader: new Headers(init?.headers).get(
          "x-webhook-ingest-credential",
        ),
        credentialId: (
          JSON.parse(String(init?.body)) as { credentialId?: unknown }
        ).credentialId,
      });
      return new Response(JSON.stringify({ accepted: 1 }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    };
    const environment = {
      REFERENCE_INGEST_CREDENTIAL_ID: setupCredentialId,
      REFERENCE_INGEST_SECRET: secret,
    };

    const fromEnvironment = await invoke(["ingest", "-"], {
      stdin: JSON.stringify(metadataDeliveryAttempt()),
      environment,
      fetchImplementation,
    });
    const overridden = await invoke(
      ["ingest", "-", "--credential-id", overrideCredentialId],
      {
        stdin: JSON.stringify(metadataDeliveryAttempt()),
        environment,
        fetchImplementation,
      },
    );

    expect(fromEnvironment.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(overridden.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(requests).toEqual([
      {
        credentialHeader: setupCredentialId,
        credentialId: setupCredentialId,
      },
      {
        credentialHeader: overrideCredentialId,
        credentialId: overrideCredentialId,
      },
    ]);
    for (const result of [fromEnvironment, overridden]) {
      expect(result.stdout).not.toContain(setupCredentialId);
      expect(result.stdout).not.toContain(overrideCredentialId);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(setupCredentialId);
      expect(result.stderr).not.toContain(overrideCredentialId);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it("requires an explicit event version instead of selecting lexicographically", async () => {
    const implicit = await invoke(
      ["fixture", "-", "--event", "order.created", "--json"],
      { stdin: multiVersionOpenApi() },
    );
    const explicit = await invoke(
      ["fixture", "-", "--event", "order.created", "--version", "10", "--json"],
      { stdin: multiVersionOpenApi() },
    );
    const markedContract = JSON.parse(multiVersionOpenApi()) as {
      webhooks: Record<string, { post: Record<string, unknown> }>;
    };
    for (const webhook of Object.values(markedContract.webhooks)) {
      webhook.post["x-current-version"] = "10";
    }
    const marked = await invoke(
      ["fixture", "-", "--event", "order.created", "--json"],
      { stdin: JSON.stringify(markedContract) },
    );

    expect(implicit.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(implicit.stderr).toContain("EVENT_VERSION_REQUIRED");
    expect(explicit.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(explicit.stdout)).toMatchObject({
      value: { version: "10" },
    });
    expect(marked.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(marked.stdout)).toMatchObject({
      value: { version: "10" },
    });
  });

  it.each([
    ["diff", ["diff", "-", "-", "--json"]],
    ["verify", ["verify", "-", "--headers", "-", "--secret-stdin", "--json"]],
    [
      "send-test",
      [
        "send-test",
        "--contract",
        "-",
        "--event",
        "order.created",
        "--url",
        "https://example.com/hook",
        "--secret-stdin",
        "--json",
      ],
    ],
  ])(
    "rejects multiple stdin consumers for %s before reading",
    async (_name, argv) => {
      const result = await invoke(argv, { stdin: openApi() });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
      expect(result.stderr).toContain("STDIN_CONFLICT");
    },
  );

  it("rejects authenticated remote HTTP before invoking fetch", async () => {
    let calls = 0;
    const token = "reference-api-token-that-must-not-leak";
    const result = await invoke(
      [
        "timeline",
        "--server",
        "http://example.com",
        "--api-token-env",
        "TEST_API_TOKEN",
        "--json",
      ],
      {
        environment: { TEST_API_TOKEN: token },
        fetchImplementation: async () => {
          calls += 1;
          return new Response("{}");
        },
      },
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.security);
    expect(calls).toBe(0);
    expect(result.stderr).toContain("INSECURE_SERVER_TRANSPORT");
    expect(result.stderr).not.toContain(token);
  });

  it("sends API authorization without displaying the token", async () => {
    const token = "reference-api-token-that-must-not-leak";
    let authorization = "";
    const result = await invoke(["timeline", "--json"], {
      environment: { REFERENCE_API_TOKEN: token },
      fetchImplementation: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
    });

    expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(authorization).toBe(`Bearer ${token}`);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
  });

  it("recovers a lost publish acknowledgement through status before returning", async () => {
    let calls = 0;
    const result = await invoke(
      ["publish", "-", "--idempotency-key", "publish-recovered-0001", "--json"],
      {
        stdin: openApi(),
        environment: { REFERENCE_API_TOKEN: "reference-api-token-for-tests" },
        fetchImplementation: async (input) => {
          calls += 1;
          const path = new URL(String(input)).pathname;
          if (calls === 1 && path.endsWith("/publish/status")) {
            return new Response(
              JSON.stringify({
                error: { code: "PUBLISH_COMMAND_NOT_FOUND" },
              }),
              {
                headers: { "content-type": "application/json" },
                status: 404,
              },
            );
          }
          if (path.endsWith("/contracts/import")) {
            return new Response(
              JSON.stringify({ import: { id: "import_1" } }),
              {
                headers: { "content-type": "application/json" },
                status: 201,
              },
            );
          }
          if (calls === 3 && path.endsWith("/releases/publish")) {
            throw new Error("connection closed after commit");
          }
          return new Response(
            JSON.stringify({
              status: "completed",
              command: {
                importId: "import_1",
                state: "completed",
              },
              release: { id: "release_1", checksum: "a".repeat(64) },
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          );
        },
      },
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(result.stdout)).toMatchObject({
      recovered: true,
      idempotencyKey: "publish-recovered-0001",
      release: { id: "release_1" },
    });
    expect(calls).toBe(4);
  });

  it("publishes and status-recovers a 3.5 MiB contract within the CLI response cap", async () => {
    const source = largeOpenApi();
    expect(Buffer.byteLength(source)).toBeGreaterThan(3.4 * 1024 * 1024);
    expect(Buffer.byteLength(source)).toBeLessThan(3.6 * 1024 * 1024);

    const built = await buildReferenceServer({
      repository: new InMemoryReferenceRepository(),
      cipher: new AesGcmSecretCipher(Buffer.alloc(32, 7)),
      config: {
        ...DEFAULT_REFERENCE_SERVER_CONFIG,
        apiToken: "reference-api-token-for-tests",
        allowLocalNetwork: true,
        contractBodyLimitBytes: 4 * 1024 * 1024,
        host: "127.0.0.1",
        ingestCredential: {
          id: "local-ingest",
          secret: "local-ingest-secret-for-tests",
        },
        port: 0,
      },
    });
    let lostPublishAcknowledgement = false;
    let publishResponseBytes = 0;
    let statusResponseBytes = 0;
    try {
      const result = await invoke(
        [
          "publish",
          "-",
          "--idempotency-key",
          "publish-large-contract-0001",
          "--json",
        ],
        {
          stdin: source,
          environment: {
            REFERENCE_API_TOKEN: "reference-api-token-for-tests",
          },
          fetchImplementation: async (input, init) => {
            const url = new URL(String(input));
            const method = init?.method === "POST" ? "POST" : "GET";
            const response = await built.app.inject({
              method,
              url: `${url.pathname}${url.search}`,
              headers: Object.fromEntries(new Headers(init?.headers)),
              ...(init?.body === undefined
                ? {}
                : { payload: String(init.body) }),
            });
            const responseBytes = Buffer.byteLength(response.body);
            if (
              init?.method === "POST" &&
              url.pathname === "/v1/releases/publish" &&
              !lostPublishAcknowledgement
            ) {
              lostPublishAcknowledgement = true;
              publishResponseBytes = responseBytes;
              throw new Error("connection closed after publish commit");
            }
            if (
              init?.method !== "POST" &&
              url.pathname === "/v1/releases/publish/status" &&
              response.statusCode === 200
            ) {
              statusResponseBytes = responseBytes;
            }
            return new Response(response.body, {
              headers: {
                "content-length": String(responseBytes),
                "content-type": String(
                  response.headers["content-type"] ??
                    "application/json; charset=utf-8",
                ),
              },
              status: response.statusCode,
            });
          },
        },
      );

      expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
      expect(JSON.parse(result.stdout)).toMatchObject({
        recovered: true,
        idempotencyKey: "publish-large-contract-0001",
        release: {
          status: "active",
          eventSummary: { eventTypeCount: 9, eventVersionCount: 9 },
        },
      });
      expect(publishResponseBytes).toBeGreaterThan(0);
      expect(statusResponseBytes).toBeGreaterThan(0);
      expect(publishResponseBytes).toBeLessThan(64 * 1024);
      expect(statusResponseBytes).toBeLessThan(64 * 1024);
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(64 * 1024);
    } finally {
      await built.app.close();
    }
  }, 30_000);

  it("maps an unresolved publish acknowledgement to exit 7 after status recovery", async () => {
    let calls = 0;
    const result = await invoke(
      ["publish", "-", "--idempotency-key", "publish-uncertain-0001", "--json"],
      {
        stdin: openApi(),
        environment: { REFERENCE_API_TOKEN: "reference-api-token-for-tests" },
        fetchImplementation: async (input) => {
          calls += 1;
          const path = new URL(String(input)).pathname;
          if (calls === 1 && path.endsWith("/publish/status")) {
            return new Response(
              JSON.stringify({
                error: { code: "PUBLISH_COMMAND_NOT_FOUND" },
              }),
              {
                headers: { "content-type": "application/json" },
                status: 404,
              },
            );
          }
          if (path.endsWith("/contracts/import")) {
            return new Response(
              JSON.stringify({ import: { id: "import_1" } }),
              {
                headers: { "content-type": "application/json" },
                status: 201,
              },
            );
          }
          if (calls === 3 && path.endsWith("/releases/publish")) {
            throw new Error("connection closed after commit");
          }
          return new Response(
            JSON.stringify({
              status: "unknown",
              idempotencyKey: "publish-uncertain-0001",
            }),
            {
              headers: { "content-type": "application/json" },
              status: 202,
            },
          );
        },
      },
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.unknown);
    expect(result.stderr).toContain("PUBLISH_OUTCOME_UNKNOWN");
    expect(result.stderr).toContain("publish-uncertain-0001");
    expect(calls).toBe(4);
  });

  it("derives stable publish keys from canonical content and override reason", async () => {
    const keys: string[] = [];
    const execute = async (source: string, overrideReason?: string) =>
      invoke(
        [
          "publish",
          "-",
          ...(overrideReason === undefined
            ? []
            : ["--override-reason", overrideReason]),
          "--json",
        ],
        {
          stdin: source,
          environment: {
            REFERENCE_API_TOKEN: "reference-api-token-for-tests",
          },
          fetchImplementation: async (input, init) => {
            const path = new URL(String(input)).pathname;
            const key = new Headers(init?.headers).get("idempotency-key");
            if (key !== null) {
              keys.push(key);
            }
            if (path.endsWith("/publish/status")) {
              return new Response(
                JSON.stringify({
                  error: { code: "PUBLISH_COMMAND_NOT_FOUND" },
                }),
                {
                  headers: { "content-type": "application/json" },
                  status: 404,
                },
              );
            }
            if (path.endsWith("/contracts/import")) {
              return new Response(
                JSON.stringify({ import: { id: `import_${keys.length}` } }),
                {
                  headers: { "content-type": "application/json" },
                  status: 201,
                },
              );
            }
            return new Response(
              JSON.stringify({
                release: { id: `release_${keys.length}` },
              }),
              {
                headers: { "content-type": "application/json" },
                status: 201,
              },
            );
          },
        },
      );

    expect((await execute(openApi())).exitCode).toBe(CLI_EXIT_CODES.success);
    expect((await execute(openApi())).exitCode).toBe(CLI_EXIT_CODES.success);
    expect((await execute(openApi(), " approved ")).exitCode).toBe(
      CLI_EXIT_CODES.success,
    );
    expect((await execute(openApi(), "approved")).exitCode).toBe(
      CLI_EXIT_CODES.success,
    );
    expect(keys).toHaveLength(8);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
    expect(keys[4]).toBe(keys[5]);
    expect(keys[6]).toBe(keys[7]);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[4]).toBe(keys[6]);
    expect(keys[0]).not.toBe(keys[4]);
    expect(keys[0]).toMatch(/^publish_[0-9a-f]{64}$/u);
  });

  it("maps INVALID_CURSOR responses to the invalid-input exit", async () => {
    const result = await invoke(["timeline", "--cursor", "bad", "--json"], {
      environment: { REFERENCE_API_TOKEN: "reference-api-token-for-tests" },
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "INVALID_CURSOR",
              message: "The timeline cursor is invalid.",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 400,
          },
        ),
    });

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalid);
    expect(result.stderr).toContain("INVALID_CURSOR");
  });

  it("requires secure generated server credentials and TLS for non-loopback", async () => {
    expect(() =>
      referenceServerConfigFromEnv({
        REFERENCE_INGEST_SECRET: "ingest-secret",
      }),
    ).toThrow("REFERENCE_API_TOKEN");
    expect(() =>
      referenceServerConfigFromEnv({
        REFERENCE_API_TOKEN: "api-token",
        REFERENCE_HOST: "0.0.0.0",
        REFERENCE_INGEST_SECRET: "ingest-secret",
        REFERENCE_PAYLOAD_NAMESPACE_ID: "8888888888888888888888",
        REFERENCE_PAYLOAD_STORE_ID: "9999999999999999999999",
      }),
    ).toThrow("REFERENCE_TLS_CERT_FILE");

    const directory = await scratch();
    const tokenFile = path.join(directory, "api-token");
    const certificateFile = path.join(directory, "server.crt");
    const privateKeyFile = path.join(directory, "server.key");
    await writeFile(tokenFile, "generated-api-token\n", { mode: 0o600 });
    await writeFile(certificateFile, "certificate", { mode: 0o644 });
    await writeFile(privateKeyFile, "private-key", { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    await chmod(privateKeyFile, 0o600);
    const config = referenceServerConfigFromEnv({
      REFERENCE_API_TOKEN_FILE: tokenFile,
      REFERENCE_HOST: "0.0.0.0",
      REFERENCE_INGEST_SECRET: "ingest-secret",
      REFERENCE_PAYLOAD_NAMESPACE_ID: "8888888888888888888888",
      REFERENCE_PAYLOAD_STORE_ID: "9999999999999999999999",
      REFERENCE_TLS_CERT_FILE: certificateFile,
      REFERENCE_TLS_KEY_FILE: privateKeyFile,
      REFERENCE_PAYLOAD_MAINTENANCE_BATCH_SIZE: "25",
      REFERENCE_PAYLOAD_MAINTENANCE_GRACE_SECONDS: "120",
      REFERENCE_PAYLOAD_MAINTENANCE_INTERVAL_SECONDS: "30",
    });

    expect(config.apiToken).toBe("generated-api-token");
    expect(config.tls?.certificate.toString()).toBe("certificate");
    expect(config.tls?.privateKey.toString()).toBe("private-key");
    expect(config.payloadMaintenance).toEqual({
      batchSize: 25,
      gracePeriodMilliseconds: 120_000,
      intervalMilliseconds: 30_000,
    });
    expect(config.payloadStorageNamespaceId).toBe("8888888888888888888888");
    expect(config.payloadStorageStoreId).toBe("9999999999999999999999");
    expect(() =>
      referenceServerConfigFromEnv({
        REFERENCE_API_TOKEN: "api-token",
        REFERENCE_INGEST_SECRET: "ingest-secret",
        REFERENCE_PAYLOAD_NAMESPACE_ID: "8888888888888888888888",
        REFERENCE_PAYLOAD_STORE_ID: "8888888888888888888888",
      }),
    ).toThrow("must be distinct");
    expect(() =>
      referenceServerConfigFromEnv({
        REFERENCE_API_TOKEN: "api-token",
        REFERENCE_INGEST_SECRET: "ingest-secret",
        REFERENCE_PAYLOAD_NAMESPACE_ID: "88888888888888888888888888888888",
        REFERENCE_PAYLOAD_STORE_ID: "9999999999999999999999",
      }),
    ).toThrow("22 lowercase hexadecimal");
    expect(() =>
      payloadStorageFromEnv(
        {
          MINIO_ENDPOINT: "minio",
          MINIO_ACCESS_KEY: "access-key",
          MINIO_SECRET_KEY: "secret-key",
          MINIO_PAYLOAD_BUCKET: "webhook-payloads-wrong",
        },
        config,
      ),
    ).toThrow("MINIO_PAYLOAD_BUCKET");
    expect(() =>
      payloadStorageFromEnv(
        {
          MINIO_ENDPOINT: "minio",
          MINIO_ACCESS_KEY: "access-key",
          MINIO_SECRET_KEY: "secret-key",
          MINIO_PAYLOAD_BUCKET: "webhook-payloads-8888888888888888888888",
        },
        config,
      ),
    ).toThrow("MINIO_PAYLOAD_BUCKET");
    expect(() =>
      payloadStorageFromEnv(
        {
          MINIO_ENDPOINT: "minio",
          MINIO_ACCESS_KEY: "access-key",
          MINIO_SECRET_KEY: "secret-key",
        },
        config,
      ),
    ).toThrow("MINIO_PAYLOAD_BUCKET");
    expect(() =>
      payloadStorageFromEnv(
        {
          MINIO_ENDPOINT: "minio",
          MINIO_ACCESS_KEY: "access-key",
          MINIO_SECRET_KEY: "secret-key",
          MINIO_PAYLOAD_BUCKET:
            "webhook-payloads-8888888888888888888888-9999999999999999999999",
        },
        config,
      ),
    ).not.toThrow();
  });

  it("documents exactly the commands the dispatcher implements (README/help/dispatch stay in sync)", async () => {
    // The command name (first whitespace-separated token) of every usage
    // line in `help`. This list is the source of truth for
    // `packages/cli/README.md` and the root `README.md`'s CLI workflows
    // section; keep both in sync with it.
    const implementedCommands = [
      "validate",
      "import",
      "publish",
      "publish-status",
      "diff",
      "fixture",
      "types",
      "sign",
      "verify",
      "send-test",
      "serve",
      "migrate",
      "ingest",
      "timeline",
    ];

    const help = await invoke(["--help", "--json"]);
    expect(help.exitCode).toBe(CLI_EXIT_CODES.success);
    const helpBody = JSON.parse(help.stdout) as { commands: readonly string[] };
    const advertisedCommands = helpBody.commands.map(
      (usage) => usage.split(/\s/u)[0]!,
    );
    expect(new Set(advertisedCommands)).toEqual(new Set(implementedCommands));
    expect(helpBody.commands).toContain(
      "ingest <metadata|-> [--server url] [--credential-id id] [--batch-id id]",
    );

    // An unrecognized command name must be rejected explicitly...
    const unknown = await invoke(["not-a-real-command", "--json"]);
    expect(unknown.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(JSON.parse(unknown.stderr)).toMatchObject({
      error: { code: "UNKNOWN_COMMAND" },
    });

    // ...while every documented command must be dispatched to a real
    // handler (never falling through to "unknown command") even when
    // called with no arguments and no configured environment/secrets.
    for (const command of implementedCommands) {
      const result = await invoke([command, "--json"]);
      const stderrBody =
        result.stderr.length > 0
          ? (JSON.parse(result.stderr) as { error?: { code?: string } })
          : undefined;
      expect(
        stderrBody?.error?.code,
        `"${command}" should not be reported as an unknown command`,
      ).not.toBe("UNKNOWN_COMMAND");
    }
  });
});
