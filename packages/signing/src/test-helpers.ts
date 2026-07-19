// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { encodeWebhookSecret, WebhookSecret } from "./secret.js";
import { signWebhook, type WebhookBody } from "./webhook.js";

export interface DeterministicWebhookVector {
  readonly secret: string;
  readonly messageId: string;
  readonly timestamp: number;
  readonly body: WebhookBody;
  readonly signature: string;
}

function testSecret(encoded: string): string {
  return ["whsec_", encoded].join("");
}

export const STANDARD_WEBHOOK_TEST_VECTORS: readonly DeterministicWebhookVector[] =
  Object.freeze([
    Object.freeze({
      secret: testSecret("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"),
      messageId: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: 1_614_265_330,
      body: '{"test": 2432232314}',
      signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    }),
    Object.freeze({
      secret: testSecret("C2FVsBQIhrscChlQIMV+b5sSYspob7oD"),
      messageId: "msg_27UH4WbU6Z5A5EzD8u03UvzRbpk",
      timestamp: 1_649_367_553,
      body: '{"email":"test@example.com","username":"test_user"}',
      signature: "v1,tZ1I4/hDygAJgO5TYxiSd6Sd0kDW6hPenDe+bTa3Kkw=",
    }),
  ]);

export const STANDARD_WEBHOOK_TEST_VECTOR: DeterministicWebhookVector =
  STANDARD_WEBHOOK_TEST_VECTORS[0]!;

export function deterministicSecret(
  label: string,
  options: Parameters<typeof WebhookSecret.fromBytes>[1] = {},
): WebhookSecret {
  return WebhookSecret.fromBytes(
    createHash("sha256").update(label, "utf8").digest(),
    options,
  );
}

export function deterministicEncodedSecret(label: string): string {
  return encodeWebhookSecret(
    createHash("sha256").update(label, "utf8").digest(),
  );
}

export function createDeterministicVector(
  label: string,
  messageId: string,
  timestamp: number,
  body: WebhookBody,
): DeterministicWebhookVector {
  const secret = deterministicEncodedSecret(label);
  const signed = signWebhook({
    secret: WebhookSecret.fromEncoded(secret),
    messageId,
    timestamp,
    body,
  });
  return Object.freeze({
    secret,
    messageId,
    timestamp,
    body,
    signature: signed.signature,
  });
}
