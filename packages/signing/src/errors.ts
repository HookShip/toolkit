// SPDX-License-Identifier: Apache-2.0

export type SigningErrorCode =
  | "malformed_secret"
  | "missing_header"
  | "invalid_header"
  | "stale_timestamp"
  | "future_timestamp"
  | "malformed_signature"
  | "signature_mismatch"
  | "invalid_payload";

export type WebhookHeaderName =
  "webhook-id" | "webhook-timestamp" | "webhook-signature";

export class SigningError extends Error {
  readonly code: SigningErrorCode;

  constructor(code: SigningErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }

  toJSON(): Readonly<{
    name: string;
    code: SigningErrorCode;
    message: string;
  }> {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export class MalformedSecretError extends SigningError {
  constructor() {
    super(
      "malformed_secret",
      "The signing secret is not a valid whsec_ standard Base64 value.",
    );
  }
}

export class MissingHeaderError extends SigningError {
  readonly header: WebhookHeaderName;

  constructor(header: WebhookHeaderName) {
    super("missing_header", `The required ${header} header is missing.`);
    this.header = header;
  }
}

export class InvalidHeaderError extends SigningError {
  readonly header: WebhookHeaderName;

  constructor(header: WebhookHeaderName) {
    super("invalid_header", `The ${header} header is invalid.`);
    this.header = header;
  }
}

export class StaleTimestampError extends SigningError {
  constructor() {
    super(
      "stale_timestamp",
      "The webhook timestamp is outside the allowed age.",
    );
  }
}

export class FutureTimestampError extends SigningError {
  constructor() {
    super(
      "future_timestamp",
      "The webhook timestamp is too far in the future.",
    );
  }
}

export class MalformedSignatureError extends SigningError {
  constructor() {
    super("malformed_signature", "The webhook signature header is malformed.");
  }
}

export class SignatureMismatchError extends SigningError {
  constructor() {
    super(
      "signature_mismatch",
      "No webhook signature matched an eligible signing secret.",
    );
  }
}

export class InvalidPayloadError extends SigningError {
  constructor() {
    super(
      "invalid_payload",
      "The Standard Webhooks payload must contain valid UTF-8 bytes.",
    );
  }
}
