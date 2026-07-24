// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { CLI_EXIT_CODES, runCli, type CliDependencies } from "../src/index.js";

class Capture extends Writable {
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

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratchDir(): Promise<string> {
  const dir = path.resolve("test", `.fail-scratch-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  scratch.push(dir);
  return dir;
}

async function invoke(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly stdin?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new Capture();
  const stderr = new Capture();
  const exitCode = await runCli(argv, {
    cwd: options.cwd ?? process.cwd(),
    environment: {},
    stdin: Readable.from([options.stdin ?? ""]),
    stdout,
    stderr,
  });
  return { exitCode, stdout: stdout.toString(), stderr: stderr.toString() };
}

describe("CLI dispatch and usage errors", () => {
  it("prints help for no command and for --help", async () => {
    expect((await invoke([])).exitCode).toBe(CLI_EXIT_CODES.success);
    const help = await invoke(["--help"]);
    expect(help.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(help.stdout).toContain("Usage: webhook-portal");
    expect((await invoke(["sign", "--help"])).exitCode).toBe(
      CLI_EXIT_CODES.success,
    );
    const jsonHelp = await invoke(["help", "--json"]);
    expect(jsonHelp.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(jsonHelp.stdout)).toMatchObject({
      name: "webhook-portal",
    });
  });

  it("rejects an unknown command", async () => {
    const result = await invoke(["not-a-command", "--json"]);
    expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "UNKNOWN_COMMAND" },
    });
  });

  it.each([
    ["validate", []],
    ["diff", ["only-one"]],
    ["compatibility-report", ["only-one"]],
    ["fixture", []],
    ["types", []],
    ["support-evidence-verify", []],
    ["ingest", []],
    ["timeline", ["extra", "positional"]],
  ] as const)(
    "rejects wrong positional counts for %s",
    async (command, rest) => {
      const result = await invoke([command, ...rest, "--json"]);
      expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: "USAGE_ERROR" },
      });
    },
  );

  it("rejects an unreadable contract path", async () => {
    const dir = await scratchDir();
    const result = await invoke(
      ["validate", path.join(dir, "missing.yaml"), "--json"],
      { cwd: dir },
    );
    expect(result.exitCode).not.toBe(CLI_EXIT_CODES.success);
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  });

  it("requires flags for flag-driven commands", async () => {
    const dir = await scratchDir();
    const contractPath = path.join(dir, "c.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        webhooks: {
          "order.created": {
            post: {
              "x-event-type": "order.created",
              "x-event-version": "1",
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { id: {} } },
                    example: { id: "1" },
                  },
                },
              },
              responses: { "204": { description: "ok" } },
            },
          },
        },
      }),
    );
    // fixture/types without --event; publish-status without --idempotency-key;
    // send-test without --url; verify without --headers.
    for (const argv of [
      ["fixture", contractPath],
      ["types", contractPath],
      ["publish-status"],
      ["verify", "-"],
      ["send-test", "-"],
    ] as const) {
      const result = await invoke([...argv, "--json"], {
        cwd: dir,
        stdin: "{}",
      });
      expect(result.exitCode).not.toBe(CLI_EXIT_CODES.success);
    }
  });
});

describe("serve and migrate commands", () => {
  async function runWith(
    argv: readonly string[],
    deps: Partial<
      Pick<CliDependencies, "migrateServer" | "startServer" | "shutdownSignal">
    >,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout = new Capture();
    const stderr = new Capture();
    const exitCode = await runCli(argv, {
      cwd: process.cwd(),
      environment: {},
      stdin: Readable.from([""]),
      stdout,
      stderr,
      ...(deps.migrateServer === undefined
        ? {}
        : { migrateServer: deps.migrateServer }),
      ...(deps.startServer === undefined
        ? {}
        : { startServer: deps.startServer }),
      ...(deps.shutdownSignal === undefined
        ? {}
        : { shutdownSignal: deps.shutdownSignal }),
    });
    return { exitCode, stdout: stdout.toString(), stderr: stderr.toString() };
  }

  it("runs migrate with an injected migrator", async () => {
    const result = await runWith(["migrate", "--json"], {
      migrateServer: async () => ["003_reference_recovery"],
    });
    expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "migrate",
      applied: ["003_reference_recovery"],
    });
  });

  it("reports an already-current schema", async () => {
    const result = await runWith(["migrate"], {
      migrateServer: async () => [],
    });
    expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(result.stdout).toContain("already current");
  });

  it("rejects unexpected positionals for migrate", async () => {
    const result = await runWith(["migrate", "extra", "--json"], {
      migrateServer: async () => [],
    });
    expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
  });

  it("lazily loads the runtime and fails closed without configuration", async () => {
    const result = await runWith(["migrate"], {});
    expect(result.exitCode).not.toBe(CLI_EXIT_CODES.success);
  });

  it("serves until a shutdown signal triggers a graceful close", async () => {
    let closed = false;
    const shutdown = new AbortController();
    const promise = runWith(["serve", "--json"], {
      shutdownSignal: shutdown.signal,
      startServer: (async () => ({
        address: "http://127.0.0.1:65535",
        close: async () => {
          closed = true;
        },
      })) as NonNullable<CliDependencies["startServer"]>,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    shutdown.abort();
    const result = await promise;
    expect(result.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(closed).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "serve" });
  });
});

describe("secret sources and numeric options", () => {
  const whsec = "whsec_QWxhZGRpbjpvcGVuIHNlc2FtZSBmb3IgdGVzdGluZw==";

  it("rejects a group- or other-readable secret file", async () => {
    const dir = await scratchDir();
    const body = path.join(dir, "body.json");
    await writeFile(body, "{}");
    const secret = path.join(dir, "secret");
    await writeFile(secret, whsec);
    await chmod(secret, 0o644);
    const result = await invoke(
      ["sign", body, "--secret-file", secret, "--json"],
      { cwd: dir },
    );
    expect(result.exitCode).not.toBe(CLI_EXIT_CODES.success);
  });

  it("rejects an oversized secret file", async () => {
    const dir = await scratchDir();
    const body = path.join(dir, "body.json");
    await writeFile(body, "{}");
    const secret = path.join(dir, "secret");
    await writeFile(secret, "x".repeat(8192));
    await chmod(secret, 0o600);
    const result = await invoke(
      ["sign", body, "--secret-file", secret, "--json"],
      { cwd: dir },
    );
    expect(result.exitCode).not.toBe(CLI_EXIT_CODES.success);
  });

  it("rejects conflicting secret sources", async () => {
    const dir = await scratchDir();
    const body = path.join(dir, "body.json");
    await writeFile(body, "{}");
    const secret = path.join(dir, "secret");
    await writeFile(secret, whsec);
    await chmod(secret, 0o600);
    const result = await invoke(
      ["sign", body, "--secret-file", secret, "--secret-stdin", "--json"],
      { cwd: dir, stdin: whsec },
    );
    expect(result.exitCode).not.toBe(CLI_EXIT_CODES.success);
  });

  it("rejects an out-of-range integer option", async () => {
    const result = await invoke([
      "timeline",
      "--server",
      "https://reference.example",
      "--limit",
      "0",
      "--json",
    ]);
    expect(result.exitCode).not.toBe(CLI_EXIT_CODES.success);
  });
});

describe("sign timestamp and codegen event selection", () => {
  const whsec = "whsec_QWxhZGRpbjpvcGVuIHNlc2FtZSBmb3IgdGVzdGluZw==";
  const validContract = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "t", version: "1.0.0" },
    webhooks: {
      "order.created": {
        post: {
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
          responses: { "204": { description: "ok" } },
        },
      },
    },
  });

  async function withSecret(): Promise<{
    dir: string;
    body: string;
    secret: string;
  }> {
    const dir = await scratchDir();
    const body = path.join(dir, "body.json");
    await writeFile(body, "{}");
    const secret = path.join(dir, "secret");
    await writeFile(secret, whsec);
    await chmod(secret, 0o600);
    return { dir, body, secret };
  }

  it.each(["not-a-number", "-5", "3.5"])(
    "rejects an invalid sign --timestamp %s",
    async (timestamp) => {
      const { dir, body, secret } = await withSecret();
      const result = await invoke(
        [
          "sign",
          body,
          "--secret-file",
          secret,
          "--timestamp",
          timestamp,
          "--json",
        ],
        { cwd: dir },
      );
      expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
    },
  );

  it.each(["fixture", "types"] as const)(
    "requires --event for %s on a valid contract",
    async (command) => {
      const dir = await scratchDir();
      const contractPath = path.join(dir, "contract.json");
      await writeFile(contractPath, validContract);
      const result = await invoke([command, contractPath, "--json"], {
        cwd: dir,
      });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
    },
  );

  it.each(["fixture", "types"] as const)(
    "generates %s output for a valid contract and event",
    async (command) => {
      const dir = await scratchDir();
      const contractPath = path.join(dir, "contract.json");
      await writeFile(contractPath, validContract);
      const result = await invoke(
        [command, contractPath, "--event", "order.created", "--json"],
        { cwd: dir },
      );
      expect([CLI_EXIT_CODES.success, CLI_EXIT_CODES.partial]).toContain(
        result.exitCode,
      );
    },
  );
});

describe("ingest metadata validation", () => {
  const bad: ReadonlyArray<unknown> = [
    {},
    [],
    [{}],
    [{ kind: "delivery_attempt" }],
    new Array(1001).fill({ kind: "delivery_attempt" }),
    "not json object",
  ];

  it.each(bad.map((value, index) => [index, value] as const))(
    "rejects malformed ingest metadata %i",
    async (_index, value) => {
      const dir = await scratchDir();
      const metadataPath = path.join(dir, "metadata.json");
      await writeFile(metadataPath, JSON.stringify(value));
      const result = await invoke(["ingest", metadataPath, "--json"], {
        cwd: dir,
      });
      expect(result.exitCode).not.toBe(CLI_EXIT_CODES.success);
    },
  );
});
