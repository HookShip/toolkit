// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { ADAPTER_OPERATIONS } from "@webhook-portal/adapter-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { CLI_EXIT_CODES, runCli } from "../src/index.js";

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
  const directory = path.resolve("test", `.learning-scratch-${randomUUID()}`);
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

async function invoke(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly stdin?: string;
    readonly now?: Date;
  } = {},
) {
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const exitCode = await runCli(argv, {
    cwd: options.cwd ?? process.cwd(),
    environment: {},
    stdin: Readable.from([options.stdin ?? ""]),
    stdout,
    stderr,
    ...(options.now === undefined ? {} : { now: () => options.now! }),
  });
  return {
    exitCode,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
  };
}

function contract(
  options: {
    readonly openapi?: string;
    readonly requireCurrency?: boolean;
  } = {},
): string {
  return JSON.stringify({
    openapi: options.openapi ?? "3.1.0",
    info: {
      title: "Synthetic learning command contract",
      version: options.requireCurrency === true ? "2.0.0" : "1.0.0",
    },
    webhooks: {
      "order.created": {
        post: {
          "x-event-id": "synthetic-order-created",
          "x-event-type": "order.created",
          "x-event-version": "1",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required:
                    options.requireCurrency === true
                      ? ["id", "currency"]
                      : ["id"],
                  properties: {
                    id: { type: "string" },
                    ...(options.requireCurrency === true
                      ? { currency: { type: "string" } }
                      : {}),
                  },
                },
              },
            },
          },
          responses: { "204": { description: "Synthetic acknowledgement" } },
        },
      },
    },
  });
}

function inventory(extra: Record<string, unknown> = {}) {
  return {
    $schema:
      "https://webhook-portal.dev/schemas/migration-inventory/2026-07-18",
    destinations: [
      {
        id: "destination-orders",
        kind: "http",
        providerId: "receiver-orders",
        url: "https://receiver.example/webhooks/orders",
      },
    ],
    endpoints: [
      {
        destinationIds: ["destination-orders"],
        id: "orders-production",
        observability: {
          attemptLogs: true,
          auditLogs: false,
          deliveryLogs: true,
          metrics: true,
          replay: true,
        },
        providerId: "orders-production",
        rate: { requestsPerSecond: 10, supported: true },
        retention: { attemptLogDays: 7, deliveryLogDays: 30 },
        retry: {
          backoff: "exponential",
          maxAttempts: 5,
          supported: true,
        },
        signing: {
          algorithms: ["hmac-sha256"],
          headerNames: ["webhook-signature"],
          profile: "synthetic-hmac",
          rotationSupported: true,
        },
        state: "active",
        subscriptions: [{ event: "order.created" }],
      },
    ],
    format: "webhook-portal.migration-inventory",
    formatVersion: "1.0.0",
    provider: {
      accountId: "synthetic-account",
      kind: "custom-http",
    },
    schemaVersion: "2026-07-18",
    ...extra,
  };
}

function capabilities(
  overrides: Partial<Record<(typeof ADAPTER_OPERATIONS)[number], string>> = {},
) {
  return {
    adapter: {
      id: "synthetic-target",
      name: "Synthetic target",
      version: "1.0.0",
    },
    capabilities: Object.fromEntries(
      ADAPTER_OPERATIONS.map((operation) => [
        operation,
        overrides[operation] ?? "supported",
      ]),
    ),
  };
}

function timeline(extra: Record<string, unknown> = {}) {
  return {
    records: [
      {
        attempt: 1,
        deliveryId: "synthetic-delivery-1",
        durationMilliseconds: 120,
        endpointId: "synthetic-endpoint",
        eventId: "synthetic-order-created",
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
        occurredAt: "2026-07-18T10:01:00.000Z",
        providerAttemptId: "synthetic-attempt-1",
        responseStatusCode: 202,
        retryable: false,
        schemaVersion: "2026-07-01",
        sequence: 1,
        status: "delivered",
        traceId: "synthetic-trace-1",
        ...extra,
      },
    ],
  };
}

function scope() {
  return {
    tenantId: { kind: "opaque", value: "synthetic-tenant" },
    environmentId: { kind: "opaque", value: "synthetic-environment" },
  };
}

async function writeLearningFixtures(directory: string) {
  const paths = {
    previous: path.join(directory, "previous.json"),
    next: path.join(directory, "next.json"),
    partial: path.join(directory, "partial.json"),
    invalid: path.join(directory, "invalid.json"),
    inventory: path.join(directory, "inventory.json"),
    capabilities: path.join(directory, "capabilities.json"),
    timeline: path.join(directory, "timeline.json"),
    scope: path.join(directory, "scope.json"),
  };
  await Promise.all([
    writeFile(paths.previous, contract()),
    writeFile(paths.next, contract({ requireCurrency: true })),
    writeFile(paths.partial, contract({ openapi: "3.0.3" })),
    writeFile(paths.invalid, '{"openapi":'),
    writeFile(paths.inventory, JSON.stringify(inventory())),
    writeFile(paths.capabilities, JSON.stringify(capabilities())),
    writeFile(paths.timeline, JSON.stringify(timeline())),
    writeFile(paths.scope, JSON.stringify(scope())),
  ]);
  return paths;
}

const evidenceNow = new Date("2026-07-18T10:06:00.000Z");

function evidenceArgs(paths: {
  readonly timeline: string;
  readonly scope: string;
}): string[] {
  return [
    "support-evidence",
    paths.timeline,
    "--case-id",
    "case_synthetic_001",
    "--scope",
    paths.scope,
    "--from",
    "2026-07-18T10:00:00.000Z",
    "--to",
    "2026-07-18T10:03:00.000Z",
  ];
}

describe("compatibility-report", () => {
  it("renders JSON and Markdown, preserves a breaking report, and supports atomic output", async () => {
    const directory = await scratch();
    const paths = await writeLearningFixtures(directory);

    const json = await invoke([
      "compatibility-report",
      paths.previous,
      paths.next,
      "--format",
      "json",
    ]);
    const markdown = await invoke([
      "compatibility-report",
      paths.previous,
      paths.next,
      "--format",
      "markdown",
      "--audience",
      "consumer",
    ]);
    const output = path.join(directory, "report.json");
    const written = await invoke([
      "compatibility-report",
      paths.previous,
      paths.next,
      "--format",
      "json",
      "--out",
      output,
      "--allow-breaking",
      "--json",
    ]);

    expect(json.exitCode).toBe(CLI_EXIT_CODES.incompatible);
    expect(JSON.parse(json.stdout)).toMatchObject({
      status: "breaking",
      decision: "block",
    });
    expect(markdown.exitCode).toBe(CLI_EXIT_CODES.incompatible);
    expect(markdown.stdout).toContain("# Compatibility report");
    expect(markdown.stdout).toContain("**View:** consumer");
    expect(written.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(written.stdout)).toMatchObject({
      command: "compatibility-report",
      status: "breaking",
      output,
    });
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      status: "breaking",
    });
    expect(
      (await readdir(directory)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  it("uses partial 4 and invalid 3 for non-exact contracts", async () => {
    const directory = await scratch();
    const paths = await writeLearningFixtures(directory);

    const partial = await invoke([
      "compatibility-report",
      paths.partial,
      paths.next,
      "--json",
    ]);
    const invalid = await invoke([
      "compatibility-report",
      paths.invalid,
      paths.next,
      "--json",
    ]);

    expect(partial.exitCode).toBe(CLI_EXIT_CODES.partial);
    expect(JSON.parse(partial.stderr)).toMatchObject({
      error: { code: "CONTRACT_PARTIAL" },
    });
    expect(invalid.exitCode).toBe(CLI_EXIT_CODES.invalid);
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      error: { code: "CONTRACT_INVALID" },
    });
  });
});

describe("migration-assess", () => {
  it("renders read-only JSON/Markdown and returns 5 for a blocked target", async () => {
    const directory = await scratch();
    const paths = await writeLearningFixtures(directory);
    const markdown = await invoke([
      "migration-assess",
      paths.inventory,
      paths.previous,
      "--target-capabilities",
      paths.capabilities,
      "--format",
      "markdown",
    ]);
    const blockedCapabilities = path.join(
      directory,
      "blocked-capabilities.json",
    );
    await writeFile(
      blockedCapabilities,
      JSON.stringify(
        capabilities({
          "endpoint.create": "unsupported",
          "endpoint.verify": "unsupported",
        }),
      ),
    );
    const blocked = await invoke([
      "migration-assess",
      paths.inventory,
      paths.previous,
      "--target-capabilities",
      blockedCapabilities,
      "--format",
      "json",
      "--json",
    ]);

    expect(markdown.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(markdown.stdout).toContain("# Migration assessment");
    expect(markdown.stdout).toContain("Read-only planning output");
    expect(blocked.exitCode).toBe(CLI_EXIT_CODES.incompatible);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      command: "migration-assess",
      status: "blocked",
      assessment: {
        readiness: { blocked: true },
      },
    });
  });

  it("rejects provider credentials and malicious fields without leaking values or creating output", async () => {
    const directory = await scratch();
    const paths = await writeLearningFixtures(directory);
    const marker = "whsec_never_echo_this_secret_value";
    const maliciousInventory = path.join(directory, "malicious-inventory.json");
    const output = path.join(directory, "must-not-exist.json");
    await writeFile(
      maliciousInventory,
      JSON.stringify(inventory({ apiKey: marker })),
    );

    const embedded = await invoke([
      "migration-assess",
      maliciousInventory,
      paths.previous,
      "--target-capabilities",
      paths.capabilities,
      "--out",
      output,
      "--json",
    ]);
    const argument = await invoke([
      "migration-assess",
      paths.inventory,
      paths.previous,
      "--target-capabilities",
      paths.capabilities,
      "--api-token",
      marker,
      "--json",
    ]);

    expect(embedded.exitCode).toBe(CLI_EXIT_CODES.invalid);
    expect(`${embedded.stdout}${embedded.stderr}`).not.toContain(marker);
    await expect(readFile(output, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(argument.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(`${argument.stdout}${argument.stderr}`).not.toContain(marker);
  });

  it("treats a partial assessment contract as invalid input", async () => {
    const directory = await scratch();
    const paths = await writeLearningFixtures(directory);
    const result = await invoke([
      "migration-assess",
      paths.inventory,
      paths.partial,
      "--target-capabilities",
      paths.capabilities,
      "--json",
    ]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalid);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "CONTRACT_PARTIAL" },
    });
  });
});

describe("support evidence", () => {
  it("creates explicit unsigned JSON and Markdown evidence", async () => {
    const directory = await scratch();
    const paths = await writeLearningFixtures(directory);
    const json = await invoke([...evidenceArgs(paths), "--json"], {
      now: evidenceNow,
    });
    const markdown = await invoke(
      [...evidenceArgs(paths), "--format", "markdown"],
      { now: evidenceNow },
    );

    expect(json.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(json.stdout)).toMatchObject({
      command: "support-evidence",
      status: "unsigned",
      bundle: {
        snapshot: { recordCount: 1 },
      },
    });
    expect(markdown.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(markdown.stdout).toContain("# Support evidence bundle");
    expect(markdown.stdout).toContain("Signature status: unsigned");
  });

  it("signs, verifies through a trust policy, detects tampering, expiry, and revocation", async () => {
    const directory = await scratch();
    const paths = await writeLearningFixtures(directory);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePath = path.join(directory, "support-private.pem");
    const publicPath = path.join(directory, "support-public.pem");
    const bundlePath = path.join(directory, "support-evidence.json");
    await writeFile(
      privatePath,
      privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    await chmod(privatePath, 0o600);
    await writeFile(
      publicPath,
      publicKey.export({ format: "pem", type: "spki" }),
    );

    const created = await invoke(
      [
        ...evidenceArgs(paths),
        "--signing-key-file",
        privatePath,
        "--key-id",
        "support-key-2026-07",
        "--out",
        bundlePath,
        "--format",
        "json",
        "--json",
      ],
      { now: evidenceNow },
    );
    const trustPath = path.join(directory, "trust-policy.json");
    await writeFile(
      trustPath,
      JSON.stringify({
        requireSignature: true,
        keys: [
          {
            keyId: "support-key-2026-07",
            publicKeyFile: path.basename(publicPath),
            validFrom: "2026-07-01T00:00:00.000Z",
            validUntil: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const verified = await invoke([
      "support-evidence-verify",
      bundlePath,
      "--trust-policy",
      trustPath,
      "--now",
      "2026-07-18T10:07:00.000Z",
      "--json",
    ]);

    const tamperedPath = path.join(directory, "tampered.json");
    const tampered = JSON.parse(await readFile(bundlePath, "utf8")) as {
      evidence: { records: Record<string, unknown>[] };
    };
    tampered.evidence.records[0]!["status"] = "altered";
    await writeFile(tamperedPath, JSON.stringify(tampered));
    const tamperedResult = await invoke([
      "support-evidence-verify",
      tamperedPath,
      "--public-key-file",
      publicPath,
      "--now",
      "2026-07-18T10:07:00.000Z",
      "--json",
    ]);
    const expired = await invoke([
      "support-evidence-verify",
      bundlePath,
      "--public-key-file",
      publicPath,
      "--now",
      "2026-07-26T00:00:00.000Z",
      "--json",
    ]);
    const revoked = await invoke([
      "support-evidence-verify",
      bundlePath,
      "--public-key-file",
      publicPath,
      "--revoked-at",
      "2026-07-18T10:06:30.000Z",
      "--revocation-mode",
      "all",
      "--now",
      "2026-07-18T10:07:00.000Z",
      "--json",
    ]);

    expect(created.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(created.stdout)).toMatchObject({ status: "signed" });
    expect(verified.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      valid: true,
      integrity: "valid",
      signature: "valid",
    });
    expect(tamperedResult.exitCode).toBe(CLI_EXIT_CODES.security);
    expect(JSON.parse(tamperedResult.stdout)).toMatchObject({
      valid: false,
      integrity: "tampered",
    });
    expect(expired.exitCode).toBe(CLI_EXIT_CODES.security);
    expect(JSON.parse(expired.stdout)).toMatchObject({
      valid: false,
      expiry: "expired",
    });
    expect(revoked.exitCode).toBe(CLI_EXIT_CODES.security);
    expect(JSON.parse(revoked.stdout)).toMatchObject({
      valid: false,
      signature: "revoked-key",
    });
  });

  it("enforces private-key permissions and rejects literal keys or non-metadata fields without leaks", async () => {
    const directory = await scratch();
    const paths = await writeLearningFixtures(directory);
    const { privateKey } = generateKeyPairSync("ed25519");
    const privatePath = path.join(directory, "world-readable-private.pem");
    await writeFile(
      privatePath,
      privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o644 },
    );
    await chmod(privatePath, 0o644);
    const permissions = await invoke(
      [
        ...evidenceArgs(paths),
        "--signing-key-file",
        privatePath,
        "--key-id",
        "support-key",
        "--json",
      ],
      { now: evidenceNow },
    );

    const marker = "whsec_never_echo_support_secret_value";
    const literal = await invoke(
      [...evidenceArgs(paths), "--signing-key", marker, "--json"],
      { now: evidenceNow },
    );
    const keyStdin = await invoke(
      [
        ...evidenceArgs(paths),
        "--signing-key-file",
        "-",
        "--key-id",
        "support-key",
        "--json",
      ],
      { now: evidenceNow },
    );
    const maliciousTimeline = path.join(directory, "malicious-timeline.json");
    const output = path.join(directory, "must-not-exist.json");
    await writeFile(
      maliciousTimeline,
      JSON.stringify(timeline({ body: marker })),
    );
    const malicious = await invoke(
      [
        ...evidenceArgs({ ...paths, timeline: maliciousTimeline }),
        "--out",
        output,
        "--json",
      ],
      { now: evidenceNow },
    );

    expect(permissions.exitCode).toBe(CLI_EXIT_CODES.security);
    expect(permissions.stderr).toContain("PRIVATE_KEY_PERMISSIONS");
    expect(literal.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(`${literal.stdout}${literal.stderr}`).not.toContain(marker);
    expect(keyStdin.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(keyStdin.stderr).toContain("KEY_STDIN_FORBIDDEN");
    expect(malicious.exitCode).toBe(CLI_EXIT_CODES.invalid);
    expect(`${malicious.stdout}${malicious.stderr}`).not.toContain(marker);
    await expect(readFile(output, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["compatibility-report", ["compatibility-report", "-", "-", "--json"]],
    [
      "migration-assess",
      [
        "migration-assess",
        "-",
        "contract.json",
        "--target-capabilities",
        "-",
        "--json",
      ],
    ],
    [
      "support-evidence",
      [
        "support-evidence",
        "-",
        "--case-id",
        "case_1",
        "--scope",
        "-",
        "--json",
      ],
    ],
  ])("rejects multiple stdin consumers for %s", async (_name, argv) => {
    const result = await invoke(argv, { stdin: "{}" });
    expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(result.stderr).toContain("STDIN_CONFLICT");
  });
});
