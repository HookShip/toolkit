// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createEvidenceBundle,
  signEvidenceBundle,
  verifyEvidenceBundle,
} from "../src/index.js";
import { validEvidenceInput } from "./fixtures.js";

const signedAt = "2026-07-18T10:07:00.000Z";
const verificationTime = "2026-07-19T10:00:00.000Z";

describe("Ed25519 evidence signatures", () => {
  it("signs and verifies metadata without serializing private key material", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signEvidenceBundle(
      createEvidenceBundle(validEvidenceInput()),
      {
        keyId: "support-key-2026-07",
        privateKey,
        signedAt,
      },
    );
    const privatePem = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();

    expect(Object.keys(signed.signature ?? {}).sort()).toEqual([
      "algorithm",
      "keyId",
      "signedAt",
      "value",
    ]);
    expect(JSON.stringify(signed)).not.toContain(privatePem);
    expect(JSON.stringify(signed)).not.toContain("PRIVATE KEY");
    expect(
      verifyEvidenceBundle(signed, {
        requireSignature: true,
        now: verificationTime,
        keys: [
          {
            keyId: "support-key-2026-07",
            publicKey,
            validFrom: "2026-07-01T00:00:00.000Z",
            validUntil: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      valid: true,
      integrity: "valid",
      expiry: "valid",
      signature: "valid",
      issues: [],
    });
  });

  it("reports snapshot tampering and invalid signature metadata", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signEvidenceBundle(
      createEvidenceBundle(validEvidenceInput()),
      {
        keyId: "support-key-a",
        privateKey,
        signedAt,
      },
    );
    const tampered = structuredClone(signed);
    (tampered.snapshot.records[1] as unknown as Record<string, unknown>)[
      "status"
    ] = "altered";

    expect(
      verifyEvidenceBundle(tampered, {
        now: verificationTime,
        keys: [{ keyId: "support-key-a", publicKey }],
      }),
    ).toMatchObject({
      valid: false,
      integrity: "tampered",
      signature: "valid",
      issues: ["DIGEST_MISMATCH"],
    });

    const alteredSignature = structuredClone(signed);
    if (alteredSignature.signature !== undefined) {
      (alteredSignature.signature as unknown as Record<string, unknown>)[
        "signedAt"
      ] = "2026-07-18T10:08:00.000Z";
    }
    expect(
      verifyEvidenceBundle(alteredSignature, {
        now: verificationTime,
        keys: [{ keyId: "support-key-a", publicKey }],
      }).signature,
    ).toBe("invalid");
  });

  it("reports bundle expiry and required unsigned evidence", () => {
    const unsigned = createEvidenceBundle(validEvidenceInput());
    expect(
      verifyEvidenceBundle(unsigned, {
        now: "2026-07-26T00:00:00.000Z",
      }),
    ).toMatchObject({
      valid: false,
      expiry: "expired",
      signature: "unsigned",
      issues: ["BUNDLE_EXPIRED"],
    });
    expect(
      verifyEvidenceBundle(unsigned, {
        now: verificationTime,
        requireSignature: true,
      }),
    ).toMatchObject({
      valid: false,
      signature: "unsigned",
      issues: ["SIGNATURE_REQUIRED"],
    });
  });

  it("enforces key validity and revocation policy", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signEvidenceBundle(
      createEvidenceBundle(validEvidenceInput()),
      {
        keyId: "support-key-old",
        privateKey,
        signedAt,
      },
    );
    const expiringKey = {
      keyId: "support-key-old",
      publicKey,
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-07-18T11:00:00.000Z",
    };

    expect(
      verifyEvidenceBundle(signed, {
        now: verificationTime,
        keys: [expiringKey],
      }).signature,
    ).toBe("key-expired");
    expect(
      verifyEvidenceBundle(signed, {
        now: verificationTime,
        allowHistoricalSignatures: true,
        keys: [expiringKey],
      }).signature,
    ).toBe("valid");
    expect(
      verifyEvidenceBundle(signed, {
        now: verificationTime,
        keys: [
          {
            ...expiringKey,
            validUntil: "2026-08-01T00:00:00.000Z",
            revokedAt: "2026-07-18T11:00:00.000Z",
          },
        ],
      }).signature,
    ).toBe("revoked-key");
    expect(
      verifyEvidenceBundle(signed, {
        now: verificationTime,
        keys: [
          {
            ...expiringKey,
            validUntil: "2026-08-01T00:00:00.000Z",
            revokedAt: "2026-07-18T11:00:00.000Z",
            revocationMode: "from-time",
          },
        ],
      }).signature,
    ).toBe("valid");
  });

  it("supports key rotation with distinct trusted key IDs", () => {
    const oldPair = generateKeyPairSync("ed25519");
    const newPair = generateKeyPairSync("ed25519");
    const bundle = createEvidenceBundle(validEvidenceInput());
    const oldSigned = signEvidenceBundle(bundle, {
      keyId: "support-key-old",
      privateKey: oldPair.privateKey,
      signedAt,
    });
    const newSigned = signEvidenceBundle(bundle, {
      keyId: "support-key-new",
      privateKey: newPair.privateKey,
      signedAt,
    });
    const keys = [
      { keyId: "support-key-old", publicKey: oldPair.publicKey },
      { keyId: "support-key-new", publicKey: newPair.publicKey },
    ];

    expect(
      verifyEvidenceBundle(oldSigned, { now: verificationTime, keys }).valid,
    ).toBe(true);
    expect(
      verifyEvidenceBundle(newSigned, { now: verificationTime, keys }).valid,
    ).toBe(true);
  });
});
