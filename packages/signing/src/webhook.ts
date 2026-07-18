// SPDX-License-Identifier: Apache-2.0

import {
  FutureTimestampError,
  InvalidPayloadError,
  SignatureMismatchError,
  SigningError,
  StaleTimestampError,
} from "./errors.js";
import {
  parseWebhookHeaders,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type HeaderParsingLimits,
  type ParsedWebhookHeaders,
  type WebhookHeadersInput,
} from "./headers.js";
import { WebhookSecret } from "./secret.js";

export type StandardWebhookBody = string | Uint8Array;
export type WebhookBody = StandardWebhookBody;
/** Returns a Date or JavaScript epoch milliseconds, matching Date.now(). */
export type Clock = () => number | Date;

export interface SignWebhookInput {
  readonly messageId: string;
  readonly body: StandardWebhookBody;
  readonly secret: WebhookSecret;
  readonly timestamp?: number;
  readonly clock?: Clock;
}

export interface SignWebhookRawBytesInput extends Omit<
  SignWebhookInput,
  "body"
> {
  readonly body: Uint8Array;
}

export interface SignedWebhook {
  readonly messageId: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly headers: Readonly<{
    "webhook-id": string;
    "webhook-timestamp": string;
    "webhook-signature": string;
  }>;
}

interface VerifyWebhookOptions {
  readonly headers: WebhookHeadersInput;
  readonly secrets: WebhookSecret | readonly WebhookSecret[];
  readonly toleranceSeconds?: number;
  readonly clock?: Clock;
  readonly limits?: HeaderParsingLimits;
}

export interface VerifyWebhookInput extends VerifyWebhookOptions {
  readonly body: StandardWebhookBody;
}

export interface VerifyWebhookRawBytesInput extends VerifyWebhookOptions {
  readonly body: Uint8Array;
}

export interface VerificationSuccess {
  readonly ok: true;
  readonly messageId: string;
  readonly timestamp: number;
  readonly matchedSecretId?: string;
}

export interface VerificationFailure {
  readonly ok: false;
  readonly error: SigningError;
}

export type VerificationResult = VerificationSuccess | VerificationFailure;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function unixSeconds(clock: Clock | undefined): number {
  const value = (clock ?? Date.now)();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  const seconds = Math.floor(milliseconds / 1_000);
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(seconds)) {
    throw new RangeError("The clock must return a valid time.");
  }
  return seconds;
}

function validateTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError("The timestamp must be a non-negative integer.");
  }
}

function validateTolerance(toleranceSeconds: number): void {
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError("Timestamp tolerance must be a non-negative integer.");
  }
}

function validateMessageId(messageId: string): void {
  if (
    messageId.length === 0 ||
    messageId.length > 256 ||
    messageId.includes(".") ||
    /[\u0000-\u001f\u007f]/u.test(messageId)
  ) {
    throw new RangeError("The message ID is invalid.");
  }
}

function standardBodyBytes(body: StandardWebhookBody): Buffer {
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  const bytes = Buffer.from(body);
  try {
    UTF8_DECODER.decode(bytes);
  } catch {
    throw new InvalidPayloadError();
  }
  return bytes;
}

function canonicalContent(
  messageId: string,
  timestamp: number | string,
  body: Uint8Array,
): Buffer {
  validateMessageId(messageId);
  const timestampText =
    typeof timestamp === "string" ? timestamp : String(timestamp);
  return Buffer.concat([
    Buffer.from(`${messageId}.${timestampText}.`, "utf8"),
    body,
  ]);
}

export function canonicalWebhookContent(
  messageId: string,
  timestamp: number | string,
  body: StandardWebhookBody,
): Buffer {
  return canonicalContent(messageId, timestamp, standardBodyBytes(body));
}

/**
 * Local byte-exact extension. Invalid UTF-8 payloads are outside Standard
 * Webhooks cross-language interoperability guarantees.
 */
export function canonicalWebhookRawBytesContent(
  messageId: string,
  timestamp: number | string,
  body: Uint8Array,
): Buffer {
  return canonicalContent(messageId, timestamp, Buffer.from(body));
}

function signedWebhook(
  input: Omit<SignWebhookInput, "body">,
  content: Uint8Array,
): SignedWebhook {
  validateMessageId(input.messageId);
  const timestamp = input.timestamp ?? unixSeconds(input.clock);
  validateTimestamp(timestamp);
  if (!input.secret.isEligibleAt(timestamp)) {
    throw new RangeError(
      "The signing secret is not eligible at the timestamp.",
    );
  }

  const timestampText = String(timestamp);
  const signature = `v1,${input.secret.sign(content).toString("base64")}`;
  return Object.freeze({
    messageId: input.messageId,
    timestamp,
    signature,
    headers: Object.freeze({
      [WEBHOOK_ID_HEADER]: input.messageId,
      [WEBHOOK_TIMESTAMP_HEADER]: timestampText,
      [WEBHOOK_SIGNATURE_HEADER]: signature,
    }),
  });
}

export function signWebhook(input: SignWebhookInput): SignedWebhook {
  const timestamp = input.timestamp ?? unixSeconds(input.clock);
  validateTimestamp(timestamp);
  return signedWebhook(
    { ...input, timestamp },
    canonicalWebhookContent(input.messageId, timestamp, input.body),
  );
}

/**
 * Signs arbitrary bytes byte-for-byte as a local extension. Use signWebhook
 * for payloads that need Standard Webhooks cross-language interoperability.
 */
export function signWebhookRawBytes(
  input: SignWebhookRawBytesInput,
): SignedWebhook {
  const timestamp = input.timestamp ?? unixSeconds(input.clock);
  validateTimestamp(timestamp);
  return signedWebhook(
    { ...input, timestamp },
    canonicalWebhookRawBytesContent(input.messageId, timestamp, input.body),
  );
}

function verifyParsed(
  parsed: ParsedWebhookHeaders,
  content: Uint8Array,
  secrets: readonly WebhookSecret[],
): VerificationSuccess {
  let matchedSecret: WebhookSecret | undefined;
  for (const secret of secrets) {
    if (!secret.isEligibleAt(parsed.timestamp)) {
      continue;
    }
    const expected = secret.sign(content);
    for (const signature of parsed.signatures) {
      const matches = signature.matches(expected);
      if (matches && matchedSecret === undefined) {
        matchedSecret = secret;
      }
    }
  }

  if (matchedSecret === undefined) {
    throw new SignatureMismatchError();
  }
  return Object.freeze({
    ok: true,
    messageId: parsed.messageId,
    timestamp: parsed.timestamp,
    ...(matchedSecret.id === undefined
      ? {}
      : { matchedSecretId: matchedSecret.id }),
  });
}

function verifyWebhookCore(
  input: VerifyWebhookOptions,
  createContent: (parsed: ParsedWebhookHeaders) => Buffer,
): VerificationSuccess {
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  validateTolerance(toleranceSeconds);
  const parsed = parseWebhookHeaders(input.headers, input.limits);
  const now = unixSeconds(input.clock);

  if (now - parsed.timestamp > toleranceSeconds) {
    throw new StaleTimestampError();
  }
  if (parsed.timestamp - now > toleranceSeconds) {
    throw new FutureTimestampError();
  }

  const secrets = Array.isArray(input.secrets)
    ? input.secrets
    : [input.secrets];
  if (secrets.length === 0) {
    throw new SignatureMismatchError();
  }
  return verifyParsed(parsed, createContent(parsed), secrets);
}

export function verifyWebhook(input: VerifyWebhookInput): VerificationSuccess {
  return verifyWebhookCore(input, (parsed) =>
    canonicalWebhookContent(parsed.messageId, parsed.timestampText, input.body),
  );
}

/**
 * Verifies arbitrary byte payloads as a local extension. Invalid UTF-8 payloads
 * are not cross-language Standard Webhooks interoperable.
 */
export function verifyWebhookRawBytes(
  input: VerifyWebhookRawBytesInput,
): VerificationSuccess {
  return verifyWebhookCore(input, (parsed) =>
    canonicalWebhookRawBytesContent(
      parsed.messageId,
      parsed.timestampText,
      input.body,
    ),
  );
}

function tryVerify(operation: () => VerificationSuccess): VerificationResult {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof SigningError) {
      return Object.freeze({ ok: false, error });
    }
    throw error;
  }
}

export function tryVerifyWebhook(
  input: VerifyWebhookInput,
): VerificationResult {
  return tryVerify(() => verifyWebhook(input));
}

export function tryVerifyWebhookRawBytes(
  input: VerifyWebhookRawBytesInput,
): VerificationResult {
  return tryVerify(() => verifyWebhookRawBytes(input));
}
