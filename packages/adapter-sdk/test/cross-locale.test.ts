// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const locales = ["C", "en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"];

const script = String.raw`
import {
  CANONICAL_METADATA_SCHEMA_VERSION,
  DEFAULT_ADAPTER_MAPPING_VERSION,
  SecretValue,
  canonicalizeMetadataRecord,
  createAdapterContext,
  createAuthenticatedCommandEnvelope,
  createAuthenticatedMetadataIngestEnvelope,
  deliveryAttemptDedupeKey,
} from "./dist/index.js";

const now = 1800000000000;
const commandCredential = {
  id: "command-key",
  kind: "bearer",
  role: "command",
  secret: new SecretValue("command-secret"),
  scope: {
    adapterId: "adapter-1",
    connectionId: "connection-1",
    tenantId: "tenant-1",
    environments: ["production"],
    operations: ["endpoint.create"],
  },
};
const command = {
  kind: "endpoint.create",
  context: createAdapterContext({
    tenant: { id: "tenant-1" },
    environment: { id: "production" },
    connection: { id: "connection-1" },
    actor: { id: "actor-1", type: "service" },
    idempotency: { key: "locale-key" },
    credential: commandCredential,
    deadline: now + 30000,
  }),
  input: {
    endpoint: {
      id: "endpoint-1",
      url: "https://receiver.example/webhooks",
      labels: { "ä": "1", "z": "2", "İ": "3", "i": "4", "😀": "5" },
    },
  },
};
const commandEnvelope = createAuthenticatedCommandEnvelope(
  command,
  commandCredential,
  { issuedAt: now, nonce: "fixed-command-nonce" },
);

const metadataCredential = {
  id: "metadata-key",
  kind: "header",
  role: "metadata_ingest",
  secret: new SecretValue("metadata-secret"),
  scope: {
    adapterId: "adapter-1",
    connectionId: "connection-1",
    tenantId: "tenant-1",
    environments: ["production"],
    operations: ["metadata.ingest"],
  },
};
const record = {
  kind: "delivery_attempt",
  schemaVersion: CANONICAL_METADATA_SCHEMA_VERSION,
  eventId: "event-ä",
  deliveryId: "delivery-İ",
  endpointId: "endpoint-1",
  eventVersion: {
    eventType: "invoice.😀",
    version: "2026-07-01",
    schemaChecksum: "a".repeat(64),
  },
  mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
  attempt: 1,
  sequence: 2,
  status: "attempting",
  occurredAt: "2026-07-01T00:00:00.000Z",
  sourceDedupeKey: "z-ä-İ-😀",
};
const identity = {
  tenantId: "tenant-1",
  environment: "production",
  adapterId: "adapter-1",
  connectionId: "connection-1",
};
const metadataEnvelope = createAuthenticatedMetadataIngestEnvelope(
  [record],
  identity,
  "batch-ä",
  metadataCredential,
  { issuedAt: now, expiresAt: now + 30000 },
);
const canonical = canonicalizeMetadataRecord(record, identity);
const loneHigh = JSON.parse('"\\ud800"');
const loneLow = JSON.parse('"\\udc00"');
const rejects = (callback) => {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
};
const malformedRejected = [
  rejects(() => new SecretValue(loneHigh)),
  rejects(() =>
    createAuthenticatedCommandEnvelope(
      {
        ...command,
        input: {
          endpoint: {
            ...command.input.endpoint,
            description: loneHigh,
          },
        },
      },
      commandCredential,
      { issuedAt: now, nonce: "malformed-value" },
    ),
  ),
  rejects(() =>
    createAuthenticatedCommandEnvelope(
      {
        ...command,
        input: {
          endpoint: {
            ...command.input.endpoint,
            labels: { [loneLow]: "value" },
          },
        },
      },
      commandCredential,
      { issuedAt: now, nonce: "malformed-key" },
    ),
  ),
  rejects(() =>
    createAuthenticatedMetadataIngestEnvelope(
      [{ ...record, sourceDedupeKey: loneLow }],
      identity,
      "malformed-batch",
      metadataCredential,
      { issuedAt: now, expiresAt: now + 30000 },
    ),
  ),
].every(Boolean);
console.log(JSON.stringify({
  commandFingerprint: commandEnvelope.commandFingerprint,
  commandSignature: commandEnvelope.signature.value,
  metadataFingerprint: metadataEnvelope.batchFingerprint,
  metadataSignature: metadataEnvelope.signature.value,
  metadataDedupe: deliveryAttemptDedupeKey(canonical),
  malformedRejected,
  supplementaryAccepted: commandEnvelope.command.input.endpoint.labels["😀"] === "5",
}));
`;

function outputForLocale(locale: string): string {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale },
      timeout: 15_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("locale-independent SDK canonicalization", () => {
  it("keeps command and metadata signatures/fingerprints identical across locales", () => {
    const outputs = locales.map((locale) => outputForLocale(locale));
    expect(new Set(outputs).size).toBe(1);
    expect(JSON.parse(outputs[0] ?? "{}")).toMatchObject({
      commandFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      commandSignature: expect.any(String),
      metadataFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      metadataSignature: expect.any(String),
      metadataDedupe: expect.stringMatching(
        /^whp:delivery-attempt:v3:[a-f0-9]{64}$/u,
      ),
      malformedRejected: true,
      supplementaryAccepted: true,
    });
  }, 60_000);
});
