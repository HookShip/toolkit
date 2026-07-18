#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end proof that the open foundation works without a hosted service:
// validate/import/diff/publish a contract, generate a fixture and
// TypeScript types, sign/verify a Standard Webhooks payload, run a full
// endpoint/subscription/secret/send-test workflow against an in-memory,
// in-process reference server, ingest delivery metadata, and inspect the
// resulting timeline.
//
// Everything here runs against an in-memory repository and a real loopback
// HTTP listener started in this same process — no PostgreSQL, MinIO,
// Docker, or hosted service is used or required. Live PostgreSQL/MinIO/
// Docker integration is intentionally a separate path; see
// `infra/README.md` and `pnpm check:compose`.
//
// Every step below checks an explicit exit code and/or response field.
// Nothing here treats "did not throw" as success on its own, and nothing
// swallows an unexpected result — nothing here has a hidden fallback.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import { runCli } from "@webhook-portal/cli";
import {
  AesGcmSecretCipher,
  DEFAULT_REFERENCE_SERVER_CONFIG,
  DisabledPayloadStorage,
  InMemoryReferenceRepository,
  buildReferenceServer,
} from "@webhook-portal/cli/reference-server";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const contractFixture = path.join(
  repoRoot,
  "examples/contracts/orders.openapi.yaml",
);
const metadataFixture = path.join(
  repoRoot,
  "examples/metadata/order-delivered.json",
);
const learningExamples = path.join(repoRoot, "examples/learning");
const compatibilityPrevious = path.join(
  learningExamples,
  "compatibility-previous.openapi.yaml",
);
const compatibilityNext = path.join(
  learningExamples,
  "compatibility-next-breaking.openapi.yaml",
);
const migrationInventory = path.join(
  learningExamples,
  "migration.inventory.json",
);
const targetCapabilities = path.join(
  learningExamples,
  "target-capabilities.json",
);
const targetPolicy = path.join(learningExamples, "target-policy.json");
const supportTimeline = path.join(learningExamples, "support-timeline.json");
const supportScope = path.join(learningExamples, "support-scope.json");

let currentStep = "startup";
function step(name) {
  currentStep = name;
  process.stdout.write(`\n→ ${name}\n`);
}

function fail(message) {
  const error = new Error(`[${currentStep}] ${message}`);
  error.smoke = true;
  throw error;
}

class CaptureStream extends PassThrough {
  #text = "";

  constructor() {
    super();
    this.on("data", (chunk) => {
      this.#text += chunk.toString("utf8");
    });
  }

  text() {
    return this.#text;
  }

  /** Parses the last JSON object written (CLI output is one JSON value per call). */
  json() {
    const trimmed = this.#text.trim();
    if (trimmed.length === 0) {
      fail(`expected JSON output but got none. stderr follows if any.`);
    }
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      fail(
        `could not parse CLI output as JSON: ${error.message}\n---\n${trimmed}`,
      );
    }
  }
}

async function cli(args, environment = process.env) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const stdin = new PassThrough();
  stdin.end();
  const exitCode = await runCli([...args, "--json"], {
    cwd: repoRoot,
    environment,
    stdin,
    stdout,
    stderr,
  });
  return { exitCode, stdout, stderr };
}

function expectExit(result, allowed, context) {
  if (!allowed.includes(result.exitCode)) {
    fail(
      `${context}: expected exit code in [${allowed.join(", ")}], got ${result.exitCode}.\nstdout: ${result.stdout.text()}\nstderr: ${result.stderr.text()}`,
    );
  }
}

async function authenticated(address, apiToken, requestPath, init = {}) {
  const response = await fetch(`${address}${requestPath}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text.length === 0 ? undefined : JSON.parse(text);
  if (!response.ok) {
    fail(
      `${init.method ?? "GET"} ${requestPath} returned ${response.status}: ${text}`,
    );
  }
  return { status: response.status, body };
}

async function main() {
  const workRoot = path.join(repoRoot, ".smoke-work");
  const workDir = path.join(workRoot, String(process.pid));
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  let running;
  try {
    // --- 1. validate -------------------------------------------------------
    step("validate the example contract");
    const validated = await cli(["validate", contractFixture]);
    expectExit(validated, [0], "validate");
    const validatedBody = validated.stdout.json();
    assert.equal(validatedBody.status, "valid", "contract should be valid");
    assert.equal(
      validatedBody.supported,
      true,
      "contract format/version should be supported",
    );

    // --- 2. import -----------------------------------------------------------
    step("import the contract to a canonical export");
    const canonicalPath = path.join(workDir, "orders.canonical.json");
    const imported = await cli([
      "import",
      contractFixture,
      "--out",
      canonicalPath,
    ]);
    expectExit(imported, [0], "import");
    const canonicalExport = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(
      canonicalExport.format,
      "webhook-portal.canonical-contract",
      "canonical export should declare its format",
    );
    assert.ok(
      canonicalExport.canonical?.checksum?.value,
      "canonical export should carry a checksum",
    );

    // --- 3. diff (contract against itself: must report no semantic changes) -
    step("diff the contract against itself");
    const diffed = await cli(["diff", contractFixture, contractFixture]);
    expectExit(diffed, [0], "diff");
    const diffedBody = diffed.stdout.json();
    assert.ok(
      diffedBody.status !== "breaking" && diffedBody.status !== "unknown",
      `diffing a contract against itself must not be breaking/unknown, got ${diffedBody.status}`,
    );
    assert.deepEqual(
      diffedBody.changes,
      [],
      "diffing a contract against itself must report zero semantic changes",
    );
    assert.equal(
      diffedBody.previousChecksum.value,
      diffedBody.nextChecksum.value,
    );

    // --- 4. compatibility report --------------------------------------------
    step("render a breaking compatibility report");
    const compatibility = await cli([
      "compatibility-report",
      compatibilityPrevious,
      compatibilityNext,
      "--format",
      "json",
    ]);
    expectExit(compatibility, [5], "compatibility-report");
    const compatibilityBody = compatibility.stdout.json();
    assert.equal(compatibilityBody.status, "breaking");
    assert.equal(compatibilityBody.report.decision, "block");

    // --- 5. migration assessment --------------------------------------------
    step("assess the synthetic migration inventory without provider access");
    const assessed = await cli([
      "migration-assess",
      migrationInventory,
      compatibilityPrevious,
      "--target-capabilities",
      targetCapabilities,
      "--target-policy",
      targetPolicy,
      "--format",
      "json",
    ]);
    expectExit(assessed, [0], "migration-assess");
    const assessedBody = assessed.stdout.json();
    assert.equal(assessedBody.assessment.readiness.blocked, false);
    assert.equal(assessedBody.assessment.counts.endpoints, 1);

    // --- 6. support evidence -------------------------------------------------
    step("create and verify an unsigned metadata-only evidence bundle");
    const evidencePath = path.join(workDir, "support-evidence.json");
    const evidence = await cli([
      "support-evidence",
      supportTimeline,
      "--case-id",
      "case_synthetic_smoke",
      "--scope",
      supportScope,
      "--from",
      "2026-07-18T10:00:00.000Z",
      "--to",
      "2026-07-18T10:03:00.000Z",
      "--format",
      "json",
      "--out",
      evidencePath,
    ]);
    expectExit(evidence, [0], "support-evidence");
    assert.equal(evidence.stdout.json().status, "unsigned");
    const evidenceVerification = await cli([
      "support-evidence-verify",
      evidencePath,
    ]);
    expectExit(evidenceVerification, [0], "support-evidence-verify");
    assert.equal(evidenceVerification.stdout.json().valid, true);
    assert.equal(evidenceVerification.stdout.json().signature, "unsigned");

    // --- 7. fixture ----------------------------------------------------------
    step("generate a fixture for order.created v1");
    const fixtured = await cli([
      "fixture",
      contractFixture,
      "--event",
      "order.created",
      "--version",
      "1",
    ]);
    expectExit(fixtured, [0], "fixture");
    const fixturedBody = fixtured.stdout.json();
    assert.equal(fixturedBody.status, "generated");
    assert.equal(typeof fixturedBody.value.id, "string");
    assert.ok(["created", "paid"].includes(fixturedBody.value.status));

    // --- 8. types --------------------------------------------------------
    step("generate TypeScript types for order.created v1");
    const typed = await cli([
      "types",
      contractFixture,
      "--event",
      "order.created",
      "--version",
      "1",
    ]);
    // "generated" (0) is expected for this simple schema; "partial" (4) is
    // documented, intentional behavior for schema constructs this package
    // can approximate but not represent exactly — never treated as failure.
    expectExit(typed, [0, 4], "types");
    const typedBody = typed.stdout.json();
    assert.ok(
      typeof typedBody.code === "string" &&
        typedBody.code.includes("OrderCreated"),
      "generated types should declare the event's generated type name",
    );

    // --- 9. sign / verify (independent of any server) ----------------------
    step("sign a payload and verify it back");
    const bodyPath = path.join(workDir, "test-body.json");
    const headersPath = path.join(workDir, "test-headers.json");
    await writeFile(
      bodyPath,
      JSON.stringify({ id: "ord_smoke", status: "created" }),
    );
    const webhookSecret = `whsec_${randomBytes(32).toString("base64")}`;
    const signEnv = { ...process.env, WEBHOOK_SECRET: webhookSecret };
    const signed = await cli(["sign", bodyPath], signEnv);
    expectExit(signed, [0], "sign");
    const signedBody = signed.stdout.json();
    const headers = {
      "webhook-id": signedBody.headers["webhook-id"],
      "webhook-timestamp": signedBody.headers["webhook-timestamp"],
      "webhook-signature": signedBody.headers["webhook-signature"],
    };
    assert.ok(headers["webhook-id"] && headers["webhook-signature"]);
    await writeFile(headersPath, JSON.stringify(headers));
    const verified = await cli(
      ["verify", bodyPath, "--headers", headersPath],
      signEnv,
    );
    expectExit(verified, [0], "verify");
    const verifiedBody = verified.stdout.json();
    assert.equal(verifiedBody.ok, true, "signed payload must verify");

    // --- 10. start the in-memory, in-process reference server --------------
    step("start an in-memory reference server (no PostgreSQL/MinIO/Docker)");
    const apiToken = randomBytes(24).toString("base64url");
    const ingestSecret = randomBytes(24).toString("base64url");
    const config = {
      ...DEFAULT_REFERENCE_SERVER_CONFIG,
      apiToken,
      host: "127.0.0.1",
      port: 0,
      allowLocalNetwork: true,
      ingestCredential: { id: "local-ingest", secret: ingestSecret },
    };
    const built = await buildReferenceServer({
      repository: new InMemoryReferenceRepository(),
      cipher: new AesGcmSecretCipher(randomBytes(32)),
      config,
      payloadStorage: new DisabledPayloadStorage(),
    });
    await built.app.listen({ host: config.host, port: config.port });
    running = built.app;
    const address = `http://127.0.0.1:${built.app.server.address().port}`;
    process.stdout.write(`  reference server listening at ${address}\n`);

    // --- 11. publish + publish-status ---------------------------------------
    step("publish the contract to the reference server");
    const serverEnv = { ...process.env, REFERENCE_API_TOKEN: apiToken };
    const published = await cli(
      ["publish", contractFixture, "--server", address],
      serverEnv,
    );
    expectExit(published, [0], "publish");
    const publishedBody = published.stdout.json();
    assert.ok(publishedBody.release?.id, "publish must return a release id");
    assert.equal(publishedBody.recovered, false);

    step("check publish status is completed");
    const publishStatus = await cli(
      [
        "publish-status",
        "--server",
        address,
        "--idempotency-key",
        publishedBody.idempotencyKey,
      ],
      serverEnv,
    );
    expectExit(publishStatus, [0], "publish-status");
    assert.equal(publishStatus.stdout.json().response.status, "completed");

    // --- 12. injected reference workflow: endpoint, subscription, secret,
    //        signed test — driven directly over loopback HTTP -------------
    step("create an endpoint, subscription, and secret");
    const created = await authenticated(address, apiToken, "/v1/endpoints", {
      method: "POST",
      body: JSON.stringify({
        url: `${address}/v1/test-receiver/pending`,
        allowLocalNetwork: true,
      }),
    });
    const endpointId = created.body.endpoint.id;
    assert.ok(endpointId, "endpoint creation must return an id");
    await authenticated(address, apiToken, `/v1/endpoints/${endpointId}`, {
      method: "PATCH",
      body: JSON.stringify({
        url: `${address}/v1/test-receiver/${endpointId}`,
        allowLocalNetwork: true,
      }),
    });
    await authenticated(
      address,
      apiToken,
      `/v1/endpoints/${endpointId}/subscriptions`,
      {
        method: "PUT",
        body: JSON.stringify({ eventTypes: ["order.created"] }),
      },
    );
    const secretCreated = await authenticated(
      address,
      apiToken,
      `/v1/endpoints/${endpointId}/secrets`,
      { method: "POST", body: JSON.stringify({}) },
    );
    assert.ok(
      secretCreated.body.oneTimeSecret,
      "secret creation must reveal the secret exactly once",
    );

    step("send and verify a signed test through the reference server");
    const sent = await authenticated(
      address,
      apiToken,
      `/v1/endpoints/${endpointId}/send-test`,
      {
        method: "POST",
        headers: { "idempotency-key": "smoke-send-test-0001" },
        body: JSON.stringify({ eventType: "order.created", version: "1" }),
      },
    );
    assert.ok(
      [200, 202].includes(sent.status),
      `send-test should return 200 or 202, got ${sent.status}`,
    );
    assert.equal(
      sent.body.command.evidence.status,
      "completed",
      "the self-addressed loopback test receiver must acknowledge synchronously",
    );

    // --- 13. ingest metadata -------------------------------------------------
    step("ingest a metadata delivery observation");
    const ingested = await cli(
      ["ingest", metadataFixture, "--server", address],
      { ...process.env, REFERENCE_INGEST_SECRET: ingestSecret },
    );
    expectExit(ingested, [0], "ingest");

    // --- 14. timeline --------------------------------------------------------
    step("inspect the resulting timeline");
    const timeline = await cli(
      ["timeline", "--server", address, "--limit", "50"],
      serverEnv,
    );
    expectExit(timeline, [0], "timeline");
    const timelineItems = timeline.stdout.json().response.items;
    assert.ok(
      Array.isArray(timelineItems) && timelineItems.length >= 2,
      `expected at least 2 timeline entries (send-test + ingest), got ${timelineItems?.length}`,
    );

    process.stdout.write(
      `\n✓ Open-foundation smoke workflow completed: ${timelineItems.length} timeline entr${timelineItems.length === 1 ? "y" : "ies"} observed.\n`,
    );
  } finally {
    if (running !== undefined) {
      await running.close();
    }
    await rm(workDir, { recursive: true, force: true });
    await rmdir(workRoot).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`\n✗ Smoke failed: ${error.message ?? error}\n`);
  if (error.stack && !error.smoke) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
