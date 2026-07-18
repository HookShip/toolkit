// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";

import { MalformedSecretError } from "./errors.js";

const SECRET_PREFIX = "whsec_";
const MIN_SECRET_BYTE_LENGTH = 24;
const MAX_SECRET_BYTE_LENGTH = 64;
const MIN_ENCODED_SECRET_LENGTH = 32;
const MAX_ENCODED_SECRET_LENGTH = 88;

export type SecretLifecycleState =
  "active" | "overlapping" | "revoked" | "expired";

const SECRET_STATES: readonly SecretLifecycleState[] = [
  "active",
  "overlapping",
  "revoked",
  "expired",
];

export interface WebhookSecretOptions {
  readonly id?: string;
  readonly state?: SecretLifecycleState;
  readonly notBefore?: number;
  readonly expiresAt?: number;
}

function validBoundary(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function decodeSecret(value: string): Buffer {
  if (
    !value.startsWith(SECRET_PREFIX) ||
    value.length < SECRET_PREFIX.length + MIN_ENCODED_SECRET_LENGTH ||
    value.length > SECRET_PREFIX.length + MAX_ENCODED_SECRET_LENGTH
  ) {
    throw new MalformedSecretError();
  }

  const encoded = value.slice(SECRET_PREFIX.length);
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    throw new MalformedSecretError();
  }

  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.byteLength < MIN_SECRET_BYTE_LENGTH ||
    decoded.byteLength > MAX_SECRET_BYTE_LENGTH ||
    decoded.toString("base64") !== encoded
  ) {
    throw new MalformedSecretError();
  }
  return decoded;
}

function validateOptions(options: WebhookSecretOptions): void {
  if (
    (options.state !== undefined && !SECRET_STATES.includes(options.state)) ||
    !validBoundary(options.notBefore) ||
    !validBoundary(options.expiresAt) ||
    (options.notBefore !== undefined &&
      options.expiresAt !== undefined &&
      options.notBefore > options.expiresAt)
  ) {
    throw new RangeError(
      "Secret lifecycle timestamps must be valid Unix seconds.",
    );
  }
  if (
    options.id !== undefined &&
    (options.id.length === 0 ||
      options.id.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(options.id))
  ) {
    throw new RangeError("The secret ID is invalid.");
  }
}

export class WebhookSecret {
  readonly id: string | undefined;
  readonly state: SecretLifecycleState;
  readonly notBefore: number | undefined;
  readonly expiresAt: number | undefined;
  readonly #key: Buffer;

  private constructor(key: Uint8Array, options: WebhookSecretOptions) {
    validateOptions(options);
    if (
      key.byteLength < MIN_SECRET_BYTE_LENGTH ||
      key.byteLength > MAX_SECRET_BYTE_LENGTH
    ) {
      throw new MalformedSecretError();
    }

    this.#key = Buffer.from(key);
    this.id = options.id;
    this.state = options.state ?? "active";
    this.notBefore = options.notBefore;
    this.expiresAt = options.expiresAt;
    Object.freeze(this);
  }

  static fromEncoded(
    encodedSecret: string,
    options: WebhookSecretOptions = {},
  ): WebhookSecret {
    return new WebhookSecret(decodeSecret(encodedSecret), options);
  }

  /**
   * Constructs a secret from trusted raw key bytes. Prefer fromEncoded at trust
   * boundaries; this constructor is intended for controlled KMS/HSM adapters
   * and deterministic tests.
   */
  static fromBytes(
    key: Uint8Array,
    options: WebhookSecretOptions = {},
  ): WebhookSecret {
    return new WebhookSecret(key, options);
  }

  isEligibleAt(timestamp: number): boolean {
    return (
      (this.state === "active" || this.state === "overlapping") &&
      (this.notBefore === undefined || timestamp >= this.notBefore) &&
      (this.expiresAt === undefined || timestamp <= this.expiresAt)
    );
  }

  sign(content: Uint8Array): Buffer {
    return createHmac("sha256", this.#key).update(content).digest();
  }

  toString(): string {
    return "[WebhookSecret REDACTED]";
  }

  toJSON(): Readonly<{
    type: "WebhookSecret";
    value: "[REDACTED]";
    state: SecretLifecycleState;
    id?: string;
  }> {
    return {
      type: "WebhookSecret",
      value: "[REDACTED]",
      state: this.state,
      ...(this.id === undefined ? {} : { id: this.id }),
    };
  }
}

export function parseWebhookSecret(
  encodedSecret: string,
  options: WebhookSecretOptions = {},
): WebhookSecret {
  return WebhookSecret.fromEncoded(encodedSecret, options);
}

export function encodeWebhookSecret(key: Uint8Array): string {
  if (
    key.byteLength < MIN_SECRET_BYTE_LENGTH ||
    key.byteLength > MAX_SECRET_BYTE_LENGTH
  ) {
    throw new MalformedSecretError();
  }
  return `${SECRET_PREFIX}${Buffer.from(key).toString("base64")}`;
}
