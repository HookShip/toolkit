// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";

import {
  InvalidHeaderError,
  MalformedSignatureError,
  MissingHeaderError,
  type WebhookHeaderName,
} from "./errors.js";

const SIGNATURE_BYTE_LENGTH = 32;

export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

export interface HeaderParsingLimits {
  readonly maxHeaderLength?: number;
  readonly maxMessageIdLength?: number;
  readonly maxSignatures?: number;
}

interface ResolvedHeaderParsingLimits {
  readonly maxHeaderLength: number;
  readonly maxMessageIdLength: number;
  readonly maxSignatures: number;
}

export type WebhookHeadersInput =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | {
      get(name: string): string | null;
    };

export class ParsedSignature {
  readonly version = "v1";
  readonly #digest: Buffer;

  constructor(digest: Uint8Array) {
    this.#digest = Buffer.from(digest);
    Object.freeze(this);
  }

  matches(expected: Uint8Array): boolean {
    const candidate = Buffer.from(expected);
    return (
      candidate.byteLength === this.#digest.byteLength &&
      timingSafeEqual(candidate, this.#digest)
    );
  }

  toString(): string {
    return "[WebhookSignature REDACTED]";
  }

  toJSON(): Readonly<{
    type: "WebhookSignature";
    version: "v1";
    value: "[REDACTED]";
  }> {
    return {
      type: "WebhookSignature",
      version: "v1",
      value: "[REDACTED]",
    };
  }
}

export interface ParsedWebhookHeaders {
  readonly messageId: string;
  readonly timestamp: number;
  readonly timestampText: string;
  readonly signatures: readonly ParsedSignature[];
}

function resolveLimits(
  limits: HeaderParsingLimits,
): ResolvedHeaderParsingLimits {
  const resolved = {
    maxHeaderLength: limits.maxHeaderLength ?? 4_096,
    maxMessageIdLength: limits.maxMessageIdLength ?? 256,
    maxSignatures: limits.maxSignatures ?? 16,
  };
  for (const value of Object.values(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError("Header parsing limits must be positive integers.");
    }
  }
  return resolved;
}

function isHeaderGetter(
  headers: WebhookHeadersInput,
): headers is { get(name: string): string | null } {
  return typeof (headers as { get?: unknown }).get === "function";
}

function readHeader(
  headers: WebhookHeadersInput,
  name: WebhookHeaderName,
  maxLength: number,
  maxValues: number,
): readonly string[] {
  let values: readonly string[];
  if (isHeaderGetter(headers)) {
    const value = headers.get(name);
    values = value === null ? [] : [value];
  } else {
    const matches = Object.entries(headers).filter(
      ([key]) => key.toLowerCase() === name,
    );
    if (matches.length === 0) {
      values = [];
    } else {
      values = matches.flatMap(([, value]) =>
        typeof value === "string" ? [value] : (value ?? []),
      );
    }
  }

  if (values.length === 0) {
    throw new MissingHeaderError(name);
  }
  if (
    values.length > maxValues ||
    values.reduce((length, value) => length + value.length, 0) > maxLength
  ) {
    throw new InvalidHeaderError(name);
  }
  return values;
}

function parseMessageId(value: string, maxLength: number): string {
  if (
    value.length === 0 ||
    value.length > maxLength ||
    value.includes(".") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new InvalidHeaderError(WEBHOOK_ID_HEADER);
  }
  return value;
}

function parseTimestamp(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new InvalidHeaderError(WEBHOOK_TIMESTAMP_HEADER);
  }
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw new InvalidHeaderError(WEBHOOK_TIMESTAMP_HEADER);
  }
  return timestamp;
}

function decodeSignature(value: string): ParsedSignature {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new MalformedSignatureError();
  }

  const digest = Buffer.from(value, "base64");
  if (
    digest.byteLength !== SIGNATURE_BYTE_LENGTH ||
    digest.toString("base64") !== value
  ) {
    throw new MalformedSignatureError();
  }
  return new ParsedSignature(digest);
}

function parseSignatures(
  values: readonly string[],
  maxSignatures: number,
): readonly ParsedSignature[] {
  const tokens = values.flatMap((value) => value.trim().split(/\s+/u));
  if (tokens.length === 0 || tokens.length > maxSignatures) {
    throw new MalformedSignatureError();
  }

  const parsed: ParsedSignature[] = [];
  for (const token of tokens) {
    const comma = token.indexOf(",");
    if (comma <= 0 || comma !== token.lastIndexOf(",")) {
      throw new MalformedSignatureError();
    }
    const version = token.slice(0, comma);
    if (version === "v1") {
      parsed.push(decodeSignature(token.slice(comma + 1)));
    }
  }
  if (parsed.length === 0) {
    throw new MalformedSignatureError();
  }
  return Object.freeze(parsed);
}

export function parseWebhookHeaders(
  headers: WebhookHeadersInput,
  limits: HeaderParsingLimits = {},
): ParsedWebhookHeaders {
  const resolved = resolveLimits(limits);
  const messageId = parseMessageId(
    readHeader(headers, WEBHOOK_ID_HEADER, resolved.maxHeaderLength, 1)[0]!,
    resolved.maxMessageIdLength,
  );
  const timestampText = readHeader(
    headers,
    WEBHOOK_TIMESTAMP_HEADER,
    resolved.maxHeaderLength,
    1,
  )[0]!;
  const signatureValues = readHeader(
    headers,
    WEBHOOK_SIGNATURE_HEADER,
    resolved.maxHeaderLength,
    resolved.maxSignatures,
  );

  return Object.freeze({
    messageId,
    timestamp: parseTimestamp(timestampText),
    timestampText,
    signatures: parseSignatures(signatureValues, resolved.maxSignatures),
  });
}
