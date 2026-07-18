// SPDX-License-Identifier: Apache-2.0

import {
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";

import { evidenceSnapshotDigest, parseEvidenceBundle } from "./bundle.js";
import { canonicalJson, equalDigest } from "./canonical.js";
import { EvidenceSignatureError } from "./errors.js";
import {
  assertCanonicalTimestamp,
  assertInteger,
  assertSafeToken,
  deepFreeze,
  timestampMilliseconds,
} from "./internal.js";
import type {
  EvidenceBundle,
  EvidenceSignature,
  EvidenceVerificationResult,
  ExpiryStatus,
  SignatureStatus,
  VerificationIssueCode,
} from "./types.js";

export interface SignEvidenceBundleOptions {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly signedAt: string;
}

export interface TrustedEvidenceKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly revokedAt?: string;
  readonly revocationMode?: "all" | "from-time";
}

export interface EvidenceVerificationPolicy {
  readonly keys?: readonly TrustedEvidenceKey[];
  readonly requireSignature?: boolean;
  readonly now?: Date | string;
  readonly maximumClockSkewMs?: number;
  readonly allowHistoricalSignatures?: boolean;
}

function signatureError(code: string, message: string, path: string): never {
  throw new EvidenceSignatureError(code, message, path);
}

function validatePrivateKey(key: KeyObject): void {
  if (
    key === null ||
    typeof key !== "object" ||
    key.type !== "private" ||
    key.asymmetricKeyType !== "ed25519"
  ) {
    signatureError(
      "INVALID_PRIVATE_KEY",
      "An Ed25519 private KeyObject is required.",
      "$.privateKey",
    );
  }
}

function validatePublicKey(key: KeyObject): void {
  if (
    key === null ||
    typeof key !== "object" ||
    key.type !== "public" ||
    key.asymmetricKeyType !== "ed25519"
  ) {
    signatureError(
      "INVALID_PUBLIC_KEY",
      "An Ed25519 public KeyObject is required.",
      "$.publicKey",
    );
  }
}

function signingPayload(
  bundle: Pick<EvidenceBundle, "digest" | "snapshot">,
  signature: Pick<EvidenceSignature, "algorithm" | "keyId" | "signedAt">,
): Buffer {
  return Buffer.from(
    canonicalJson({
      algorithm: signature.algorithm,
      digest: bundle.digest,
      format: bundle.snapshot.format,
      formatVersion: bundle.snapshot.formatVersion,
      keyId: signature.keyId,
      signedAt: signature.signedAt,
    }),
    "utf8",
  );
}

export function signEvidenceBundle(
  input: unknown,
  options: SignEvidenceBundleOptions,
): EvidenceBundle {
  const bundle = parseEvidenceBundle(input);
  const calculatedDigest = evidenceSnapshotDigest(bundle.snapshot);
  if (!equalDigest(bundle.digest, calculatedDigest)) {
    signatureError(
      "DIGEST_MISMATCH",
      "Cannot sign a bundle whose digest does not match its snapshot.",
      "$.digest",
    );
  }
  validatePrivateKey(options.privateKey);
  const keyId = assertSafeToken(options.keyId, "$.keyId", 128);
  const signedAt = assertCanonicalTimestamp(options.signedAt, "$.signedAt");
  if (
    timestampMilliseconds(signedAt) <
      timestampMilliseconds(bundle.snapshot.createdAt) ||
    timestampMilliseconds(signedAt) >
      timestampMilliseconds(bundle.snapshot.expiresAt)
  ) {
    signatureError(
      "INVALID_SIGNATURE_TIME",
      "Signature time must be within the bundle lifetime.",
      "$.signedAt",
    );
  }

  const signatureMetadata = {
    algorithm: "Ed25519",
    keyId,
    signedAt,
  } as const;
  const signature: EvidenceSignature = {
    ...signatureMetadata,
    value: nodeSign(
      null,
      signingPayload(bundle, signatureMetadata),
      options.privateKey,
    ).toString("base64url"),
  };
  return deepFreeze({
    snapshot: bundle.snapshot,
    digest: bundle.digest,
    signature,
  });
}

function verificationNow(value: Date | string | undefined): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.valueOf())) {
      signatureError(
        "INVALID_VERIFICATION_TIME",
        "Verification time is invalid.",
        "$.now",
      );
    }
    return value.toISOString();
  }
  return assertCanonicalTimestamp(value, "$.now");
}

function keyTimestamp(
  value: string | undefined,
  fallback: string,
  path: string,
): string {
  return value === undefined ? fallback : assertCanonicalTimestamp(value, path);
}

function malformedResult(): EvidenceVerificationResult {
  return deepFreeze({
    valid: false,
    integrity: "malformed",
    expiry: "unknown",
    signature: "malformed",
    issues: ["MALFORMED_BUNDLE"],
  });
}

export function verifyEvidenceBundle(
  input: unknown,
  policy: EvidenceVerificationPolicy = {},
): EvidenceVerificationResult {
  let bundle: EvidenceBundle;
  try {
    bundle = parseEvidenceBundle(input);
  } catch {
    return malformedResult();
  }

  const issues: VerificationIssueCode[] = [];
  const calculatedDigest = evidenceSnapshotDigest(bundle.snapshot);
  const integrity = equalDigest(bundle.digest, calculatedDigest)
    ? "valid"
    : "tampered";
  if (integrity === "tampered") {
    issues.push("DIGEST_MISMATCH");
  }

  const now = verificationNow(policy.now);
  const nowMilliseconds = timestampMilliseconds(now);
  let expiry: ExpiryStatus = "valid";
  if (nowMilliseconds < timestampMilliseconds(bundle.snapshot.createdAt)) {
    expiry = "not-yet-created";
    issues.push("BUNDLE_NOT_YET_CREATED");
  } else if (
    nowMilliseconds >= timestampMilliseconds(bundle.snapshot.expiresAt)
  ) {
    expiry = "expired";
    issues.push("BUNDLE_EXPIRED");
  }

  let signatureStatus: SignatureStatus;
  let keyId: string | undefined;
  if (bundle.signature === undefined) {
    signatureStatus = "unsigned";
    if (policy.requireSignature === true) {
      issues.push("SIGNATURE_REQUIRED");
    }
  } else {
    keyId = bundle.signature.keyId;
    const maximumClockSkewMs =
      policy.maximumClockSkewMs === undefined
        ? 5 * 60 * 1_000
        : assertInteger(
            policy.maximumClockSkewMs,
            "$.maximumClockSkewMs",
            0,
            24 * 60 * 60 * 1_000,
          );
    if (
      timestampMilliseconds(bundle.signature.signedAt) >
      nowMilliseconds + maximumClockSkewMs
    ) {
      signatureStatus = "not-yet-valid";
      issues.push("SIGNATURE_NOT_YET_VALID");
    } else {
      const matchingKeys = (policy.keys ?? []).filter(
        (candidate) => candidate.keyId === bundle.signature?.keyId,
      );
      if (matchingKeys.length === 0) {
        signatureStatus = "untrusted-key";
        issues.push("UNTRUSTED_KEY");
      } else if (matchingKeys.length > 1) {
        signatureStatus = "ambiguous-key";
        issues.push("AMBIGUOUS_KEY");
      } else {
        const trustedKey = matchingKeys[0];
        if (trustedKey === undefined) {
          signatureError(
            "INVALID_TRUST_POLICY",
            "Trust policy key lookup failed.",
            "$.keys",
          );
        }
        validatePublicKey(trustedKey.publicKey);
        const trustedKeyId = assertSafeToken(
          trustedKey.keyId,
          "$.keys.keyId",
          128,
        );
        if (trustedKeyId !== bundle.signature.keyId) {
          signatureError(
            "INVALID_TRUST_POLICY",
            "Trust policy key ID is inconsistent.",
            "$.keys.keyId",
          );
        }
        const validFrom = keyTimestamp(
          trustedKey.validFrom,
          "1970-01-01T00:00:00.000Z",
          "$.keys.validFrom",
        );
        const validUntil = keyTimestamp(
          trustedKey.validUntil,
          "9999-12-31T23:59:59.999Z",
          "$.keys.validUntil",
        );
        if (
          timestampMilliseconds(validFrom) >= timestampMilliseconds(validUntil)
        ) {
          signatureError(
            "INVALID_TRUST_POLICY",
            "Trust key validity window is invalid.",
            "$.keys",
          );
        }
        const signatureMilliseconds = timestampMilliseconds(
          bundle.signature.signedAt,
        );
        const revokedAt =
          trustedKey.revokedAt === undefined
            ? undefined
            : assertCanonicalTimestamp(
                trustedKey.revokedAt,
                "$.keys.revokedAt",
              );
        if (
          trustedKey.revocationMode !== undefined &&
          trustedKey.revocationMode !== "all" &&
          trustedKey.revocationMode !== "from-time"
        ) {
          signatureError(
            "INVALID_TRUST_POLICY",
            "Trust key revocation mode is invalid.",
            "$.keys.revocationMode",
          );
        }
        const revoked =
          revokedAt !== undefined &&
          (trustedKey.revocationMode === "from-time"
            ? signatureMilliseconds >= timestampMilliseconds(revokedAt)
            : nowMilliseconds >= timestampMilliseconds(revokedAt));

        if (revoked) {
          signatureStatus = "revoked-key";
          issues.push("KEY_REVOKED");
        } else if (
          signatureMilliseconds < timestampMilliseconds(validFrom) ||
          nowMilliseconds < timestampMilliseconds(validFrom)
        ) {
          signatureStatus = "key-not-yet-valid";
          issues.push("KEY_NOT_YET_VALID");
        } else if (
          signatureMilliseconds >= timestampMilliseconds(validUntil) ||
          (policy.allowHistoricalSignatures !== true &&
            nowMilliseconds >= timestampMilliseconds(validUntil))
        ) {
          signatureStatus = "key-expired";
          issues.push("KEY_EXPIRED");
        } else if (
          nodeVerify(
            null,
            signingPayload(bundle, bundle.signature),
            trustedKey.publicKey,
            Buffer.from(bundle.signature.value, "base64url"),
          )
        ) {
          signatureStatus = "valid";
        } else {
          signatureStatus = "invalid";
          issues.push("INVALID_SIGNATURE");
        }
      }
    }
  }

  const signatureAcceptable =
    signatureStatus === "valid" ||
    (signatureStatus === "unsigned" && policy.requireSignature !== true);
  const result: {
    valid: boolean;
    integrity: "tampered" | "valid";
    expiry: ExpiryStatus;
    signature: SignatureStatus;
    issues: readonly VerificationIssueCode[];
    keyId?: string;
  } = {
    valid: integrity === "valid" && expiry === "valid" && signatureAcceptable,
    integrity,
    expiry,
    signature: signatureStatus,
    issues: Object.freeze([...issues]),
  };
  if (keyId !== undefined) {
    result.keyId = keyId;
  }
  return deepFreeze(result);
}
