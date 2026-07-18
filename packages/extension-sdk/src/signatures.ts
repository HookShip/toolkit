// SPDX-License-Identifier: Apache-2.0

import {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";

import { isSha256Digest } from "./canonical.js";
import { ExtensionValidationError } from "./errors.js";
import {
  expectBoolean,
  expectEnum,
  expectIdentifier,
  expectInteger,
  expectIsoTimestamp,
  expectString,
  inspectArray,
  inspectClosedObject,
} from "./validation.js";

export interface BundleSignature {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signature: string;
  readonly signedDigest: string;
}

export interface ExtensionSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject | string | Uint8Array;
}

export const TRUSTED_KEY_STATUSES = ["active", "retired", "revoked"] as const;
export type TrustedKeyStatus = (typeof TRUSTED_KEY_STATUSES)[number];

export interface TrustedExtensionKey {
  readonly keyId: string;
  readonly notAfter?: string;
  readonly notBefore?: string;
  readonly publicKey: KeyObject | string | Uint8Array;
  readonly replacementKeyId?: string;
  readonly status: TrustedKeyStatus;
}

export interface SignatureTrustPolicy {
  readonly allowRetiredKeys?: boolean;
  readonly keys: readonly TrustedExtensionKey[];
  readonly minimumSignatures?: number;
  readonly rejectUnknownSignatures?: boolean;
  readonly requiredKeyIds?: readonly string[];
  readonly verificationTime?: string;
}

export type SignatureVerificationErrorCode =
  | "DUPLICATE_KEY"
  | "INVALID_SIGNATURE"
  | "KEY_EXPIRED"
  | "KEY_NOT_YET_VALID"
  | "KEY_RETIRED"
  | "KEY_REVOKED"
  | "MALFORMED_KEY"
  | "MALFORMED_SIGNATURE"
  | "REQUIRED_KEY_MISSING"
  | "SIGNED_DIGEST_MISMATCH"
  | "THRESHOLD_NOT_MET"
  | "UNKNOWN_KEY";

export interface SignatureVerificationError {
  readonly code: SignatureVerificationErrorCode;
  readonly keyId?: string;
  readonly message: string;
}

export interface SignatureVerificationResult {
  readonly errors: readonly SignatureVerificationError[];
  readonly ok: boolean;
  readonly validKeyIds: readonly string[];
}

function signingPayload(digest: string): Uint8Array {
  if (!isSha256Digest(digest)) {
    throw new ExtensionValidationError(
      "INVALID_DIGEST",
      "Signature input must be a canonical SHA-256 digest.",
      "digest",
    );
  }
  return Buffer.from(`webhook-portal-extension-bundle-v1\n${digest}`, "utf8");
}

function privateKeyObject(key: KeyObject | string | Uint8Array): KeyObject {
  const object =
    key instanceof KeyObject
      ? key
      : createPrivateKey(typeof key === "string" ? key : Buffer.from(key));
  if (object.type !== "private" || object.asymmetricKeyType !== "ed25519") {
    throw new ExtensionValidationError(
      "INVALID_SIGNING_KEY",
      "Signing key must be an Ed25519 private key.",
      "privateKey",
    );
  }
  return object;
}

function publicKeyObject(key: KeyObject | string | Uint8Array): KeyObject {
  const input =
    key instanceof KeyObject
      ? key
      : createPublicKey(typeof key === "string" ? key : Buffer.from(key));
  const object = input;
  if (object.type !== "public" || object.asymmetricKeyType !== "ed25519") {
    throw new ExtensionValidationError(
      "INVALID_TRUST_KEY",
      "Trust key must be an Ed25519 public key.",
      "publicKey",
    );
  }
  return object;
}

function isBase64Url(value: string): boolean {
  if (value.length === 0 || value.length > 256 || value.includes("=")) {
    return false;
  }
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      character === "-" ||
      character === "_"
    );
  });
}

export function parseBundleSignature(
  value: unknown,
  path = "signature",
): BundleSignature {
  const object = inspectClosedObject(value, path, [
    "algorithm",
    "keyId",
    "signature",
    "signedDigest",
  ]);
  const algorithm = expectEnum(object.algorithm, `${path}.algorithm`, [
    "Ed25519",
  ] as const);
  const keyId = expectIdentifier(object.keyId, `${path}.keyId`, 256);
  const signature = expectString(object.signature, `${path}.signature`, {
    maximumLength: 256,
  });
  if (!isBase64Url(signature)) {
    throw new ExtensionValidationError(
      "MALFORMED_SIGNATURE",
      `${path}.signature must be unpadded Base64url.`,
      `${path}.signature`,
    );
  }
  const signedDigest = expectString(
    object.signedDigest,
    `${path}.signedDigest`,
    { maximumLength: 71 },
  );
  if (!isSha256Digest(signedDigest)) {
    throw new ExtensionValidationError(
      "INVALID_DIGEST",
      `${path}.signedDigest must be a SHA-256 digest.`,
      `${path}.signedDigest`,
    );
  }
  return Object.freeze({ algorithm, keyId, signature, signedDigest });
}

export function signBundleDigest(
  digest: string,
  signer: ExtensionSigningKey,
): BundleSignature {
  const keyId = expectIdentifier(signer.keyId, "signer.keyId", 256);
  const key = privateKeyObject(signer.privateKey);
  const signature = nodeSign(null, signingPayload(digest), key).toString(
    "base64url",
  );
  return Object.freeze({
    algorithm: "Ed25519",
    keyId,
    signature,
    signedDigest: digest,
  });
}

function normalizeTrustPolicy(policy: SignatureTrustPolicy) {
  const minimumSignatures = expectInteger(
    policy.minimumSignatures ?? 1,
    "trustPolicy.minimumSignatures",
    1,
    64,
  );
  const keys = inspectArray(policy.keys, "trustPolicy.keys", 128).map(
    (candidate, index) => {
      const path = `trustPolicy.keys[${index}]`;
      const object = inspectClosedObject(
        candidate,
        path,
        ["keyId", "publicKey", "status"],
        ["notAfter", "notBefore", "replacementKeyId"],
      );
      const keyId = expectIdentifier(object.keyId, `${path}.keyId`, 256);
      return Object.freeze({
        keyId,
        publicKey: publicKeyObject(
          object.publicKey as KeyObject | string | Uint8Array,
        ),
        status: expectEnum(
          object.status,
          `${path}.status`,
          TRUSTED_KEY_STATUSES,
        ),
        ...(object.notBefore === undefined
          ? {}
          : {
              notBefore: expectIsoTimestamp(
                object.notBefore,
                `${path}.notBefore`,
              ),
            }),
        ...(object.notAfter === undefined
          ? {}
          : {
              notAfter: expectIsoTimestamp(object.notAfter, `${path}.notAfter`),
            }),
        ...(object.replacementKeyId === undefined
          ? {}
          : {
              replacementKeyId: expectIdentifier(
                object.replacementKeyId,
                `${path}.replacementKeyId`,
                256,
              ),
            }),
      });
    },
  );
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key.keyId)) {
      throw new ExtensionValidationError(
        "DUPLICATE_TRUST_KEY",
        `Trust policy contains duplicate key ${key.keyId}.`,
        "trustPolicy.keys",
      );
    }
    seen.add(key.keyId);
  }
  for (const key of keys) {
    if (
      key.replacementKeyId !== undefined &&
      (key.replacementKeyId === key.keyId || !seen.has(key.replacementKeyId))
    ) {
      throw new ExtensionValidationError(
        "INVALID_KEY_ROTATION",
        `Trust key ${key.keyId} names an absent or self replacement key.`,
        "trustPolicy.keys",
      );
    }
  }
  const requiredKeyIds = inspectArray(
    policy.requiredKeyIds ?? [],
    "trustPolicy.requiredKeyIds",
    64,
  ).map((candidate, index) =>
    expectIdentifier(candidate, `trustPolicy.requiredKeyIds[${index}]`, 256),
  );
  const verificationTime =
    policy.verificationTime === undefined
      ? undefined
      : expectIsoTimestamp(
          policy.verificationTime,
          "trustPolicy.verificationTime",
        );
  if (
    verificationTime === undefined &&
    keys.some(
      (key) => key.notBefore !== undefined || key.notAfter !== undefined,
    )
  ) {
    throw new ExtensionValidationError(
      "MISSING_VERIFICATION_TIME",
      "Trust policy must provide verificationTime when keys have validity windows.",
      "trustPolicy.verificationTime",
    );
  }
  return {
    allowRetiredKeys: expectBoolean(
      policy.allowRetiredKeys ?? true,
      "trustPolicy.allowRetiredKeys",
    ),
    keys,
    minimumSignatures,
    rejectUnknownSignatures: expectBoolean(
      policy.rejectUnknownSignatures ?? false,
      "trustPolicy.rejectUnknownSignatures",
    ),
    requiredKeyIds: Object.freeze([...new Set(requiredKeyIds)].sort()),
    verificationTime,
  };
}

function error(
  code: SignatureVerificationErrorCode,
  message: string,
  keyId?: string,
): SignatureVerificationError {
  return Object.freeze({
    code,
    message,
    ...(keyId === undefined ? {} : { keyId }),
  });
}

export function verifyBundleDigestSignatures(
  digest: string,
  signaturesInput: readonly BundleSignature[],
  trustPolicy: SignatureTrustPolicy,
): SignatureVerificationResult {
  signingPayload(digest);
  const policy = normalizeTrustPolicy(trustPolicy);
  const trusted = new Map(policy.keys.map((key) => [key.keyId, key]));
  const errors: SignatureVerificationError[] = [];
  const valid = new Set<string>();
  const observed = new Set<string>();

  for (let index = 0; index < signaturesInput.length; index += 1) {
    let signature: BundleSignature;
    try {
      signature = parseBundleSignature(
        signaturesInput[index],
        `signatures[${index}]`,
      );
    } catch {
      errors.push(
        error("MALFORMED_SIGNATURE", "Signature envelope is malformed."),
      );
      continue;
    }
    if (observed.has(signature.keyId)) {
      errors.push(
        error(
          "DUPLICATE_KEY",
          "A key may contribute at most one signature.",
          signature.keyId,
        ),
      );
      continue;
    }
    observed.add(signature.keyId);
    if (signature.signedDigest !== digest) {
      errors.push(
        error(
          "SIGNED_DIGEST_MISMATCH",
          "Signature is bound to a different digest.",
          signature.keyId,
        ),
      );
      continue;
    }
    const key = trusted.get(signature.keyId);
    if (key === undefined) {
      errors.push(
        error("UNKNOWN_KEY", "Signature key is not trusted.", signature.keyId),
      );
      continue;
    }
    if (key.status === "revoked") {
      errors.push(
        error("KEY_REVOKED", "Signature key is revoked.", signature.keyId),
      );
      continue;
    }
    if (key.status === "retired" && !policy.allowRetiredKeys) {
      errors.push(
        error("KEY_RETIRED", "Signature key is retired.", signature.keyId),
      );
      continue;
    }
    const verificationTime = policy.verificationTime;
    if (
      verificationTime !== undefined &&
      key.notBefore !== undefined &&
      verificationTime < key.notBefore
    ) {
      errors.push(
        error(
          "KEY_NOT_YET_VALID",
          "Signature key is not yet valid.",
          signature.keyId,
        ),
      );
      continue;
    }
    if (
      verificationTime !== undefined &&
      key.notAfter !== undefined &&
      verificationTime > key.notAfter
    ) {
      errors.push(
        error("KEY_EXPIRED", "Signature key has expired.", signature.keyId),
      );
      continue;
    }
    let verified = false;
    try {
      verified = nodeVerify(
        null,
        signingPayload(digest),
        key.publicKey,
        Buffer.from(signature.signature, "base64url"),
      );
    } catch {
      errors.push(
        error(
          "MALFORMED_KEY",
          "Signature verification key could not be used.",
          signature.keyId,
        ),
      );
      continue;
    }
    if (!verified) {
      errors.push(
        error(
          "INVALID_SIGNATURE",
          "Cryptographic signature did not verify.",
          signature.keyId,
        ),
      );
      continue;
    }
    valid.add(signature.keyId);
  }

  for (const requiredKeyId of policy.requiredKeyIds) {
    if (!valid.has(requiredKeyId)) {
      errors.push(
        error(
          "REQUIRED_KEY_MISSING",
          "A required signing key did not provide a valid signature.",
          requiredKeyId,
        ),
      );
    }
  }
  if (valid.size < policy.minimumSignatures) {
    errors.push(
      error(
        "THRESHOLD_NOT_MET",
        `Only ${valid.size} valid signature(s) satisfied a threshold of ${policy.minimumSignatures}.`,
      ),
    );
  }
  const blockingUnknown =
    policy.rejectUnknownSignatures &&
    errors.some((candidate) => candidate.code === "UNKNOWN_KEY");
  const requiredMissing = errors.some(
    (candidate) => candidate.code === "REQUIRED_KEY_MISSING",
  );
  return Object.freeze({
    ok:
      valid.size >= policy.minimumSignatures &&
      !blockingUnknown &&
      !requiredMissing,
    errors: Object.freeze(errors),
    validKeyIds: Object.freeze([...valid].sort()),
  });
}
