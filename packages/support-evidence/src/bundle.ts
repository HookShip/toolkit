// SPDX-License-Identifier: Apache-2.0

import { canonicalSha256, equalDigest } from "./canonical.js";
import { EvidenceValidationError } from "./errors.js";
import {
  assertCanonicalTimestamp,
  assertSafeToken,
  createInspectionContext,
  deepFreeze,
  hasOwn,
  readRecord,
  required,
  timestampMilliseconds,
} from "./internal.js";
import {
  createEvidenceSnapshot,
  sanitizeEvidenceInput,
  validateEvidenceSnapshot,
} from "./sanitizer.js";
import type {
  EvidenceBundle,
  EvidenceLimitOverrides,
  EvidenceSignature,
  EvidenceSnapshot,
  Sha256Digest,
} from "./types.js";

const bundleKeys = new Set(["snapshot", "digest", "signature"]);
const signatureKeys = new Set(["algorithm", "keyId", "signedAt", "value"]);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const signatureValuePattern = /^[A-Za-z0-9_-]{86}$/u;

function validationError(code: string, message: string, path: string): never {
  throw new EvidenceValidationError(code, message, path);
}

function parseDigest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    validationError(
      "INVALID_DIGEST",
      "A lowercase SHA-256 digest is required.",
      "$.digest",
    );
  }
  return value as Sha256Digest;
}

function parseSignature(
  value: unknown,
  snapshot: EvidenceSnapshot,
): EvidenceSignature {
  const context = createInspectionContext();
  return readRecord(value, "$.signature", signatureKeys, context, (record) => {
    if (required(record, "algorithm", "$.signature") !== "Ed25519") {
      validationError(
        "INVALID_SIGNATURE_ALGORITHM",
        "Only Ed25519 signatures are allowed.",
        "$.signature.algorithm",
      );
    }
    const signedAt = assertCanonicalTimestamp(
      required(record, "signedAt", "$.signature"),
      "$.signature.signedAt",
    );
    if (
      timestampMilliseconds(signedAt) <
        timestampMilliseconds(snapshot.createdAt) ||
      timestampMilliseconds(signedAt) >
        timestampMilliseconds(snapshot.expiresAt)
    ) {
      validationError(
        "INVALID_SIGNATURE_TIME",
        "Signature time must be within the bundle lifetime.",
        "$.signature.signedAt",
      );
    }
    const signatureValue = required(record, "value", "$.signature");
    if (
      typeof signatureValue !== "string" ||
      !signatureValuePattern.test(signatureValue) ||
      Buffer.from(signatureValue, "base64url").byteLength !== 64
    ) {
      validationError(
        "INVALID_SIGNATURE_VALUE",
        "Ed25519 signature encoding is invalid.",
        "$.signature.value",
      );
    }
    return {
      algorithm: "Ed25519",
      keyId: assertSafeToken(
        required(record, "keyId", "$.signature"),
        "$.signature.keyId",
        128,
      ),
      signedAt,
      value: signatureValue,
    };
  });
}

export function evidenceSnapshotDigest(
  snapshot: EvidenceSnapshot | unknown,
): Sha256Digest {
  const validated = validateEvidenceSnapshot(snapshot);
  return canonicalSha256(validated, {
    maximumOutputBytes: validated.limits.maximumBytes,
  });
}

export function createEvidenceBundle(
  input: unknown,
  limitOverrides: EvidenceLimitOverrides = {},
): EvidenceBundle {
  const snapshot = createEvidenceSnapshot(
    sanitizeEvidenceInput(input, limitOverrides),
  );
  return deepFreeze({
    snapshot,
    digest: evidenceSnapshotDigest(snapshot),
  });
}

export function parseEvidenceBundle(input: unknown): EvidenceBundle {
  const context = createInspectionContext();
  return readRecord(input, "$", bundleKeys, context, (record) => {
    const snapshot = validateEvidenceSnapshot(
      required(record, "snapshot", "$"),
    );
    const bundle: {
      snapshot: EvidenceSnapshot;
      digest: Sha256Digest;
      signature?: EvidenceSignature;
    } = {
      snapshot,
      digest: parseDigest(required(record, "digest", "$")),
    };
    if (hasOwn(record, "signature")) {
      bundle.signature = parseSignature(record["signature"], snapshot);
    }
    return deepFreeze(bundle);
  });
}

export function assertEvidenceBundleIntegrity(input: unknown): EvidenceBundle {
  const bundle = parseEvidenceBundle(input);
  const calculated = evidenceSnapshotDigest(bundle.snapshot);
  if (!equalDigest(bundle.digest, calculated)) {
    validationError(
      "DIGEST_MISMATCH",
      "Evidence bundle digest does not match its snapshot.",
      "$.digest",
    );
  }
  return bundle;
}
