// SPDX-License-Identifier: Apache-2.0

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { CanonicalMetadataRecord } from "@webhook-portal/adapter-sdk";

import type { EncryptedValue } from "./types.js";

export interface SecretCipher {
  encrypt(value: string): EncryptedValue;
  decrypt(value: EncryptedValue): string;
}

function decodeMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const decoded = /^[a-f0-9]{64}$/iu.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (decoded.byteLength !== 32) {
    throw new RangeError(
      "REFERENCE_MASTER_KEY must decode to exactly 32 bytes.",
    );
  }
  return decoded;
}

export class AesGcmSecretCipher implements SecretCipher {
  readonly #key: Buffer;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(
    masterKey: string | Uint8Array,
    randomSource: (size: number) => Buffer = randomBytes,
  ) {
    this.#key =
      typeof masterKey === "string"
        ? decodeMasterKey(masterKey)
        : Buffer.from(masterKey);
    if (this.#key.byteLength !== 32) {
      throw new RangeError("The master key must contain exactly 32 bytes.");
    }
    this.#randomBytes = randomSource;
  }

  encrypt(value: string): EncryptedValue {
    const iv = this.#randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Object.freeze({
      algorithm: "aes-256-gcm",
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
  }

  decrypt(value: EncryptedValue): string {
    if (value.algorithm !== "aes-256-gcm") {
      throw new RangeError("Unsupported encrypted secret algorithm.");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(value.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function safeTokenEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function referenceSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function metadataTimelineIdentityKey(
  record: CanonicalMetadataRecord,
): string {
  return `whp:timeline:v1:${referenceSha256(
    JSON.stringify([
      record.tenantId,
      record.environment,
      record.connectionId,
      record.adapterId,
      record.deliveryId,
      record.endpointId,
      record.eventId,
      record.eventVersion.eventType,
      record.eventVersion.version,
      record.eventVersion.schemaChecksum,
      record.mappingVersion.name,
      record.mappingVersion.version,
      record.mappingVersion.schemaVersion,
    ]),
  )}`;
}
