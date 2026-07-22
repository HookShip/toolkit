// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  REDACTED,
  isCredentialFieldName,
  looksLikeCredentialValue,
  redactText,
} from "../src/redaction.js";

// Known secret shapes that MUST be detected. Adding a bypass here that slips
// through is a security regression.
const MALICIOUS_VALUE_CORPUS: readonly string[] = [
  "Bearer abcdef123456",
  "basic dXNlcjpwYXNz",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "AKIAIOSFODNN7EXAMPLE",
  "ghp_0123456789abcdef0123456789abcdef0123",
  "gho_0123456789abcdef0123456789abcdef0123",
  "ghs_0123456789abcdef0123456789abcdef0123",
  "sk_live_0123456789abcdefABCDEF",
  "sk_test_0123456789abcdefABCDEF",
  "whsec_0123456789abcdefABCDEF",
  "xoxb-0123456789-0123456789-abcdef",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwMTIzNDU2Nzg5MCJ9.dGVzdHNpZ25hdHVyZS12YWx1ZS1oZXJl",
];

// Safe near-misses that MUST NOT be flagged as credential *values*.
const SAFE_VALUE_CORPUS: readonly string[] = [
  "hello world",
  "order.created",
  "https://api.example.com/webhooks",
  "bearerish-brand-name",
  "a normal sentence mentioning a bearer of news",
  "1234567890",
];

describe("credential value-shape detection", () => {
  it.each(MALICIOUS_VALUE_CORPUS)("flags %s", (value) => {
    expect(looksLikeCredentialValue(value)).toBe(true);
  });

  it.each(SAFE_VALUE_CORPUS)("does not flag %s", (value) => {
    expect(looksLikeCredentialValue(value)).toBe(false);
  });
});

describe("credential field-name detection", () => {
  it.each([
    "apiKey",
    "api_key",
    "api-key",
    "API-KEY",
    "Authorization",
    "x-signing-secret",
    "webhook.secret",
    "privateKey",
    "private_key",
    "password",
    "access_token",
  ])("flags credential field %s", (name) => {
    expect(isCredentialFieldName(name)).toBe(true);
  });

  it.each(["eventType", "id", "timestamp", "region", "status"])(
    "does not flag benign field %s",
    (name) => {
      expect(isCredentialFieldName(name)).toBe(false);
    },
  );
});

describe("textual redaction", () => {
  it("redacts inline credentials while leaving prose intact", () => {
    expect(redactText("api_key=supersecretvalue")).toBe(REDACTED);
    expect(redactText("token=supersecretvalue trailing")).toBe(
      `${REDACTED} trailing`,
    );
    expect(redactText("call whsec_0123456789abcdefABCDEF now")).toBe(
      `call ${REDACTED} now`,
    );
    expect(redactText("a plain message")).toBe("a plain message");
  });
});
