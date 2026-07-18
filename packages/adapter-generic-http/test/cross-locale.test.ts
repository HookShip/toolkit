// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const locales = ["C", "en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"];

const script = String.raw`
import {
  DEFAULT_ADAPTER_MAPPING_VERSION,
  SecretValue,
} from "../adapter-sdk/dist/index.js";
import {
  createAuthenticatedProviderAcknowledgement,
  fingerprintWireValue,
  verifyProviderAcknowledgement,
} from "./dist/index.js";

const responseCredential = {
  id: "response-key",
  kind: "header",
  role: "response",
  secret: new SecretValue("response-secret"),
  scope: {
    adapterId: "adapter-1",
    connectionId: "connection-1",
    tenantId: "tenant-1",
    environments: ["production"],
    operations: ["acknowledgement.verify"],
  },
};
const acknowledgement = createAuthenticatedProviderAcknowledgement(
  {
    operation: "endpoint.create",
    connectionId: "connection-1",
    tenantId: "tenant-1",
    environment: "production",
    requestNonce: "request-ä-İ-😀",
    idempotencyKey: "idempotency-z",
    commandFingerprint: "a".repeat(64),
    disposition: "completed",
    mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
    result: {
      kind: "resource",
      resource: {
        type: "endpoint",
        id: "endpoint-ä-İ-😀",
        state: "active",
      },
    },
  },
  responseCredential,
  {
    issuedAt: 1800000000000,
    expiresAt: 1800000030000,
    nonce: "response-z-ä-İ-😀",
  },
);
const wireFingerprint = fingerprintWireValue(
  {
    "ä": "one",
    "z": "two",
    "İ": "three",
    "i": "four",
    "😀": { "ö": true, "a": false },
  },
  { maxBodyBytes: 10000, maxDepth: 16, maxNodes: 1000 },
);
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
let replayAccesses = 0;
const malformedVerification = await verifyProviderAcknowledgement(
  {
    ...acknowledgement,
    result: {
      kind: "resource",
      resource: {
        type: "endpoint",
        id: "endpoint-ä-İ-😀",
        state: loneLow,
      },
    },
  },
  {
    adapterId: "adapter-1",
    operation: "endpoint.create",
    connectionId: "connection-1",
    tenantId: "tenant-1",
    environment: "production",
    requestNonce: "request-ä-İ-😀",
    idempotencyKey: "idempotency-z",
    commandFingerprint: "a".repeat(64),
    mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
    expectedResourceId: "endpoint-ä-İ-😀",
  },
  responseCredential,
  {
    async consume() {
      replayAccesses += 1;
      return true;
    },
  },
  { now: 1800000000000 },
);
const malformedRejected = [
  rejects(() =>
    fingerprintWireValue(
      { value: loneHigh },
      { maxBodyBytes: 10000, maxDepth: 16, maxNodes: 1000 },
    ),
  ),
  rejects(() =>
    fingerprintWireValue(
      { [loneLow]: "value" },
      { maxBodyBytes: 10000, maxDepth: 16, maxNodes: 1000 },
    ),
  ),
  rejects(() =>
    createAuthenticatedProviderAcknowledgement(
      {
        operation: "endpoint.create",
        connectionId: "connection-1",
        tenantId: "tenant-1",
        environment: "production",
        requestNonce: "request-unicode",
        idempotencyKey: "idempotency-unicode",
        commandFingerprint: "b".repeat(64),
        disposition: "completed",
        mappingVersion: DEFAULT_ADAPTER_MAPPING_VERSION,
        result: {
          kind: "resource",
          resource: {
            type: "endpoint",
            id: loneHigh,
            state: "active",
          },
        },
      },
      responseCredential,
      {
        issuedAt: 1800000000000,
        expiresAt: 1800000030000,
        nonce: "response-unicode",
      },
    ),
  ),
].every(Boolean);
console.log(JSON.stringify({
  acknowledgementSignature: acknowledgement.signature.value,
  wireFingerprint,
  malformedRejected,
  malformedVerificationRejected: !malformedVerification.ok,
  replayUntouched: replayAccesses === 0,
  supplementaryAccepted:
    fingerprintWireValue(
      { "emoji-😀": "satellite-🛰️" },
      { maxBodyBytes: 10000, maxDepth: 16, maxNodes: 1000 },
    ).length === 64,
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

describe("locale-independent HTTP canonicalization", () => {
  it("keeps acknowledgement signatures and wire fingerprints identical across locales", () => {
    const outputs = locales.map((locale) => outputForLocale(locale));
    expect(new Set(outputs).size).toBe(1);
    expect(JSON.parse(outputs[0] ?? "{}")).toMatchObject({
      acknowledgementSignature: expect.any(String),
      wireFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      malformedRejected: true,
      malformedVerificationRejected: true,
      replayUntouched: true,
      supplementaryAccepted: true,
    });
  }, 60_000);
});
