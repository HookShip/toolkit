// SPDX-License-Identifier: Apache-2.0

import { CANONICAL_GOLDEN_VECTORS } from "@webhook-portal/canonical-model";
import { describe, expect, it } from "vitest";

import {
  SecretReference,
  canonicalJson,
  canonicalJsonDigest,
  type JsonValue,
} from "../src/canonical.js";

describe("cross-package canonical golden vectors", () => {
  it.each(CANONICAL_GOLDEN_VECTORS)(
    "reproduces canonical bytes for $description",
    ({ input, canonical, sha256 }) => {
      expect(canonicalJson(input as JsonValue)).toBe(canonical);
      expect(canonicalJsonDigest(input as JsonValue)).toBe(sha256);
    },
  );
});

describe("SecretReference", () => {
  it("serializes to a tagged object and a redacted string", () => {
    const reference = new SecretReference("connection-secret");
    expect(reference.toJSON()).toEqual({
      type: "secret-reference",
      id: "connection-secret",
    });
    expect(reference.toString()).toBe("SecretReference(connection-secret)");
  });

  it("rejects empty, oversized, and malformed identifiers", () => {
    expect(() => new SecretReference("")).toThrow(/Secret reference/u);
    expect(() => new SecretReference("x".repeat(257))).toThrow(
      /Secret reference/u,
    );
    expect(() => new SecretReference("\ud800")).toThrow(/Secret reference/u);
  });
});
