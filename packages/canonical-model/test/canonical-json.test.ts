// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CANONICAL_GOLDEN_VECTORS,
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonDigest,
  equalDigest,
  isWellFormedUnicode,
  orderJsonKeys,
  sha256Digest,
  stableJson,
  type CanonicalJsonInput,
} from "../src/index.js";

describe("canonical JSON golden vectors", () => {
  it.each(CANONICAL_GOLDEN_VECTORS)(
    "encodes $description",
    ({ input, canonical, sha256 }) => {
      expect(canonicalJson(input)).toBe(canonical);
      expect(canonicalJsonDigest(input)).toBe(sha256);
    },
  );

  it("is stable under key reordering", () => {
    const value = { z: 1, a: 2, m: { y: 1, x: 2 } };
    const reordered = { m: { x: 2, y: 1 }, a: 2, z: 1 };
    expect(canonicalJson(value)).toBe(canonicalJson(reordered));
    expect(canonicalJsonDigest(value)).toBe(canonicalJsonDigest(reordered));
  });
});

describe("canonical JSON strict semantics", () => {
  it("rejects unpaired surrogates in strings and keys", () => {
    expect(isWellFormedUnicode("\ud800")).toBe(false);
    expect(() => canonicalJson({ a: "\ud800" })).toThrow(CanonicalJsonError);
    const key = JSON.parse('{"\\ud800":1}') as CanonicalJsonInput;
    expect(() => canonicalJson(key)).toThrow(/unpaired UTF-16 surrogate/u);
  });

  it("rejects undefined, non-finite numbers, and cycles", () => {
    expect(() =>
      canonicalJson({ a: undefined } as unknown as CanonicalJsonInput),
    ).toThrow(/non-JSON value/u);
    expect(() =>
      canonicalJson({ a: Number.NaN } as unknown as CanonicalJsonInput),
    ).toThrow(/non-finite/u);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() =>
      canonicalJson(cyclic as unknown as CanonicalJsonInput),
    ).toThrow(/cycle/u);
  });

  it("rejects prototype-polluting keys unless explicitly allowed", () => {
    const polluted = JSON.parse('{"__proto__":1}') as CanonicalJsonInput;
    expect(() => canonicalJson(polluted)).toThrow(/prototype-related/u);
    expect(canonicalJson(polluted, { allowUnsafeKeys: true })).toBe(
      '{"__proto__":1}',
    );
  });

  it("rejects buffers and typed arrays", () => {
    expect(() =>
      canonicalJson({
        b: Buffer.from("x"),
      } as unknown as CanonicalJsonInput),
    ).toThrow(/unsupported object/u);
  });

  it("routes failures through a custom error factory", () => {
    class DomainError extends Error {}
    expect(() =>
      canonicalJson({ a: Number.NaN } as unknown as CanonicalJsonInput, {
        onError: (kind, path, message) => new DomainError(`${kind}:${message}`),
      }),
    ).toThrow(DomainError);
  });

  it("supports pretty and HTML-safe variants", () => {
    expect(canonicalJson({ a: 1 }, { indent: 2 })).toBe('{\n  "a": 1\n}');
    expect(canonicalJson({ a: "<&>" }, { htmlSafe: true })).toBe(
      '{"a":"\\u003c\\u0026\\u003e"}',
    );
  });
});

describe("lenient stable JSON", () => {
  it("drops undefined object properties and orders keys", () => {
    expect(stableJson({ b: 1, a: undefined, c: 2 })).toBe('{"b":1,"c":2}');
    expect(orderJsonKeys({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
  });

  it("coerces non-finite numbers to null like JSON.stringify", () => {
    expect(stableJson({ a: Number.POSITIVE_INFINITY })).toBe('{"a":null}');
  });

  it("supports indentation", () => {
    expect(stableJson({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
  });
});

describe("digest helpers", () => {
  it("produces sha256-prefixed digests and compares them safely", () => {
    const digest = sha256Digest("hello");
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(equalDigest(digest, digest)).toBe(true);
    expect(equalDigest(digest, sha256Digest("world"))).toBe(false);
  });
});
