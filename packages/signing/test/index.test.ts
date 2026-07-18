// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  FutureTimestampError,
  InvalidHeaderError,
  InvalidPayloadError,
  MalformedSecretError,
  MalformedSignatureError,
  MissingHeaderError,
  STANDARD_WEBHOOK_TEST_VECTOR,
  STANDARD_WEBHOOK_TEST_VECTORS,
  SignatureMismatchError,
  StaleTimestampError,
  WebhookSecret,
  createDeterministicVector,
  encodeWebhookSecret,
  parseWebhookHeaders,
  signWebhook,
  signWebhookRawBytes,
  tryVerifyWebhook,
  verifyWebhook,
  verifyWebhookRawBytes,
} from "../src/index.js";

const NOW_SECONDS = 1_700_000_000;
const clock = (): number => NOW_SECONDS * 1_000;
const secretBytes = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const encodedSecret = `whsec_${secretBytes.toString("base64")}`;
const secret = WebhookSecret.fromEncoded(encodedSecret, { id: "primary" });

function signedHeaders(
  body: string | Uint8Array = '{"event":"invoice.paid"}',
  timestamp = NOW_SECONDS,
) {
  return signWebhook({
    secret,
    messageId: "msg_01HXYZ",
    timestamp,
    body,
  }).headers;
}

describe("secret handling", () => {
  it("uses canonical standard Base64 with required padding", () => {
    expect(encodeWebhookSecret(secretBytes)).toBe(encodedSecret);
    expect(encodedSecret.endsWith("=")).toBe(true);
    expect(WebhookSecret.fromEncoded(encodedSecret).toString()).toContain(
      "REDACTED",
    );
  });

  it("accepts the inclusive 24–64 byte key range", () => {
    for (const length of [24, 32, 48, 64]) {
      const encoded = encodeWebhookSecret(Buffer.alloc(length, length));
      expect(() => WebhookSecret.fromEncoded(encoded)).not.toThrow();
      expect(() => WebhookSecret.fromBytes(Buffer.alloc(length))).not.toThrow();
    }
  });

  it("rejects keys outside the 24–64 byte range", () => {
    for (const length of [0, 1, 23, 65, 128]) {
      expect(() => encodeWebhookSecret(Buffer.alloc(length))).toThrow(
        MalformedSecretError,
      );
      expect(() => WebhookSecret.fromBytes(Buffer.alloc(length))).toThrow(
        MalformedSecretError,
      );
    }
  });

  it("rejects URL-safe-only encodings and omitted required padding", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xfb, 0xff, 0xef]),
      Buffer.alloc(21, 0xab),
    ]);
    const standard = `whsec_${bytes.toString("base64")}`;
    const urlSafe = `whsec_${bytes.toString("base64url")}`;
    expect(urlSafe).not.toBe(standard);
    expect(() => WebhookSecret.fromEncoded(urlSafe)).toThrow(
      MalformedSecretError,
    );
    expect(() =>
      WebhookSecret.fromEncoded(encodedSecret.replace(/=+$/u, "")),
    ).toThrow(MalformedSecretError);
  });

  it.each([
    "",
    "secret_Zm9v",
    "whsec_",
    "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaS_",
    "whsec_a",
    "whsec_Zg=",
    "whsec_Zg==",
    "whsec_Zg===",
    "whsec_Zg==trailing",
    `whsec_${Buffer.alloc(24).toString("base64")}==`,
  ])("rejects malformed secret %j", (value) => {
    expect(() => WebhookSecret.fromEncoded(value)).toThrow(
      MalformedSecretError,
    );
  });

  it("copies controlled raw bytes and never serializes key material", () => {
    const bytes = Buffer.alloc(32, 0xa5);
    const raw = WebhookSecret.fromBytes(bytes, {
      id: "kms-version-1",
      state: "overlapping",
    });
    bytes.fill(0);
    expect(JSON.stringify(raw)).toBe(
      '{"type":"WebhookSecret","value":"[REDACTED]","state":"overlapping","id":"kms-version-1"}',
    );
    expect(JSON.stringify(raw)).not.toContain("controlled-key");
  });
});

describe("Standard Webhooks signing", () => {
  it("matches official JavaScript and Rust implementation vectors", () => {
    expect(STANDARD_WEBHOOK_TEST_VECTOR).toBe(STANDARD_WEBHOOK_TEST_VECTORS[0]);
    for (const vector of STANDARD_WEBHOOK_TEST_VECTORS) {
      const signed = signWebhook({
        secret: WebhookSecret.fromEncoded(vector.secret),
        messageId: vector.messageId,
        timestamp: vector.timestamp,
        body: vector.body,
      });
      expect(signed.headers).toEqual({
        "webhook-id": vector.messageId,
        "webhook-timestamp": String(vector.timestamp),
        "webhook-signature": vector.signature,
      });
      expect(
        verifyWebhook({
          body: vector.body,
          headers: signed.headers,
          secrets: WebhookSecret.fromEncoded(vector.secret),
          toleranceSeconds: 0,
          clock: () => vector.timestamp * 1_000,
        }).ok,
      ).toBe(true);
    }
  });

  it("rejects dots in IDs for signing and header parsing", () => {
    expect(() =>
      signWebhook({
        secret,
        messageId: "msg.with-dot",
        timestamp: NOW_SECONDS,
        body: "payload",
      }),
    ).toThrow(RangeError);
    expect(() =>
      parseWebhookHeaders({
        ...signedHeaders("payload"),
        "webhook-id": "msg.with-dot",
      }),
    ).toThrow(InvalidHeaderError);
  });

  it("blocks the canonical tuple collision regression", () => {
    const original = signWebhook({
      secret,
      messageId: "msg",
      timestamp: 1_700_000_000,
      body: "1700000001.payload",
    });

    expect(() =>
      verifyWebhook({
        body: "payload",
        headers: {
          "webhook-id": "msg.1700000000",
          "webhook-timestamp": "1700000001",
          "webhook-signature": original.signature,
        },
        secrets: secret,
        toleranceSeconds: 0,
        clock: () => 1_700_000_001_000,
      }),
    ).toThrow(InvalidHeaderError);
  });

  it("signs strings and valid raw HTTP body bytes as UTF-8", () => {
    const utf8 = signWebhook({
      secret,
      messageId: "unicode",
      timestamp: NOW_SECONDS,
      body: "こんにちは🌍",
    });
    const utf8Bytes = Buffer.from("こんにちは🌍", "utf8");
    const bytesSigned = signWebhook({
      secret,
      messageId: "utf8-bytes",
      timestamp: NOW_SECONDS,
      body: utf8Bytes,
    });

    expect(
      verifyWebhook({
        body: utf8Bytes,
        headers: utf8.headers,
        secrets: secret,
        clock,
      }).ok,
    ).toBe(true);
    expect(
      verifyWebhook({
        body: utf8Bytes,
        headers: bytesSigned.headers,
        secrets: secret,
        clock,
      }).ok,
    ).toBe(true);
  });

  it("isolates invalid UTF-8 support behind raw-bytes APIs", () => {
    const binary = Buffer.from([0, 255, 1, 128, 46, 10]);
    expect(() =>
      signWebhook({
        secret,
        messageId: "binary",
        timestamp: NOW_SECONDS,
        body: binary,
      }),
    ).toThrow(InvalidPayloadError);

    const signed = signWebhookRawBytes({
      secret,
      messageId: "binary",
      timestamp: NOW_SECONDS,
      body: binary,
    });
    expect(
      verifyWebhookRawBytes({
        body: binary,
        headers: signed.headers,
        secrets: secret,
        clock,
      }).ok,
    ).toBe(true);
    expect(() =>
      verifyWebhook({
        body: binary,
        headers: signed.headers,
        secrets: secret,
        clock,
      }),
    ).toThrow(InvalidPayloadError);
  });

  it("provides deterministic vectors", () => {
    expect(
      createDeterministicVector(
        "fixture",
        "msg_fixture",
        1_700_000_000,
        "body",
      ),
    ).toEqual(
      createDeterministicVector(
        "fixture",
        "msg_fixture",
        1_700_000_000,
        "body",
      ),
    );
  });
});

describe("verification and rotation", () => {
  it("checks multiple signatures and secrets during overlap", () => {
    const next = WebhookSecret.fromBytes(Buffer.alloc(32, 7), {
      id: "next",
      state: "overlapping",
    });
    const nextSignature = signWebhook({
      secret: next,
      messageId: "msg_01HXYZ",
      timestamp: NOW_SECONDS,
      body: "payload",
    }).signature;
    const unrelatedSignature = signWebhook({
      secret: WebhookSecret.fromBytes(Buffer.alloc(32, 9)),
      messageId: "msg_01HXYZ",
      timestamp: NOW_SECONDS,
      body: "payload",
    }).signature;

    const result = verifyWebhook({
      body: "payload",
      headers: {
        "Webhook-Id": "msg_01HXYZ",
        "WEBHOOK-TIMESTAMP": String(NOW_SECONDS),
        "webhook-signature": `${unrelatedSignature} ${nextSignature}`,
      },
      secrets: [secret, next],
      clock,
    });
    expect(result).toEqual({
      ok: true,
      messageId: "msg_01HXYZ",
      timestamp: NOW_SECONDS,
      matchedSecretId: "next",
    });
  });

  it.each(["revoked", "expired"] as const)("excludes %s secrets", (state) => {
    const excluded = WebhookSecret.fromBytes(secretBytes, { state });
    expect(() =>
      verifyWebhook({
        body: "payload",
        headers: signedHeaders("payload"),
        secrets: excluded,
        clock,
      }),
    ).toThrow(SignatureMismatchError);
  });

  it("applies not-before and expiry boundaries inclusively", () => {
    const bounded = WebhookSecret.fromBytes(secretBytes, {
      notBefore: NOW_SECONDS,
      expiresAt: NOW_SECONDS,
    });
    expect(
      verifyWebhook({
        body: "payload",
        headers: signedHeaders("payload"),
        secrets: bounded,
        toleranceSeconds: 0,
        clock,
      }).ok,
    ).toBe(true);
  });

  it("accepts exact timestamp boundaries and rejects one second beyond", () => {
    expect(
      verifyWebhook({
        body: "body",
        headers: signedHeaders("body", NOW_SECONDS - 300),
        secrets: secret,
        clock,
      }).ok,
    ).toBe(true);
    expect(
      verifyWebhook({
        body: "body",
        headers: signedHeaders("body", NOW_SECONDS + 300),
        secrets: secret,
        clock,
      }).ok,
    ).toBe(true);
    expect(() =>
      verifyWebhook({
        body: "body",
        headers: signedHeaders("body", NOW_SECONDS - 301),
        secrets: secret,
        clock,
      }),
    ).toThrow(StaleTimestampError);
    expect(() =>
      verifyWebhook({
        body: "body",
        headers: signedHeaders("body", NOW_SECONDS + 301),
        secrets: secret,
        clock,
      }),
    ).toThrow(FutureTimestampError);
  });
});

describe("bounded header parsing and errors", () => {
  it("returns narrow missing and invalid header errors", () => {
    expect(() => parseWebhookHeaders({})).toThrow(MissingHeaderError);
    expect(() =>
      parseWebhookHeaders({
        "webhook-id": ["a", "b"],
        "webhook-timestamp": String(NOW_SECONDS),
        "webhook-signature": signedHeaders()["webhook-signature"],
      }),
    ).toThrow(InvalidHeaderError);
  });

  it.each([
    "v1,not-base64!",
    "v1,YQ==",
    "v1,YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==",
    "v2,Zm9v",
    "v1,",
    "v1,a,b",
  ])("rejects malformed signature %j", (signature) => {
    expect(() =>
      parseWebhookHeaders({
        "webhook-id": "msg",
        "webhook-timestamp": String(NOW_SECONDS),
        "webhook-signature": signature,
      }),
    ).toThrow(MalformedSignatureError);
  });

  it("rejects non-canonical Standard Base64 signature variants", () => {
    const canonical = STANDARD_WEBHOOK_TEST_VECTORS[1]!.signature.slice(
      "v1,".length,
    );
    const variants = [
      canonical.replace(/=+$/u, ""),
      canonical.replace(/\+/gu, "-").replace(/\//gu, "_"),
      `${canonical}=`,
      canonical.replace(/w=$/u, "x="),
    ];

    for (const signature of variants) {
      expect(signature).not.toBe(canonical);
      expect(() =>
        parseWebhookHeaders({
          "webhook-id": "msg",
          "webhook-timestamp": String(NOW_SECONDS),
          "webhook-signature": `v1,${signature}`,
        }),
      ).toThrow(MalformedSignatureError);
    }
  });

  it("enforces signature count and header length bounds", () => {
    const value = signedHeaders()["webhook-signature"];
    expect(() =>
      parseWebhookHeaders(
        {
          "webhook-id": "msg",
          "webhook-timestamp": String(NOW_SECONDS),
          "webhook-signature": `${value} ${value}`,
        },
        { maxSignatures: 1 },
      ),
    ).toThrow(MalformedSignatureError);
    expect(() =>
      parseWebhookHeaders(signedHeaders(), { maxHeaderLength: 4 }),
    ).toThrow(InvalidHeaderError);
  });

  it("does not expose signatures in parsed stringification or errors", () => {
    const headers = signedHeaders("sensitive-body");
    const signature = headers["webhook-signature"];
    const parsed = parseWebhookHeaders(headers);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(signature);
    expect(serialized).toContain("[REDACTED]");

    const failure = tryVerifyWebhook({
      body: "tampered",
      headers,
      secrets: secret,
      clock,
    });
    expect(failure.ok).toBe(false);
    expect(JSON.stringify(failure)).not.toContain(signature);
    expect(JSON.stringify(failure)).not.toContain(encodedSecret);
  });
});
