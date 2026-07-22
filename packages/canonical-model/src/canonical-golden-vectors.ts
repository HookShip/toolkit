// SPDX-License-Identifier: Apache-2.0

import type { CanonicalJsonInput } from "./canonical-json.js";

/**
 * Cross-package golden vectors for canonical JSON. Every package that produces
 * signatures or checksums re-exports its serializer through
 * {@link canonicalJson} and asserts these vectors, guaranteeing byte-identical
 * output across the cohort. The `sha256` values are computed independently of
 * the serializer (directly from the hand-written `canonical` strings) so a bug
 * in the serializer cannot silently "confirm" itself.
 */
export interface CanonicalGoldenVector {
  readonly description: string;
  readonly input: CanonicalJsonInput;
  readonly canonical: string;
  readonly sha256: string;
}

export const CANONICAL_GOLDEN_VECTORS: readonly CanonicalGoldenVector[] =
  Object.freeze([
    {
      description: "empty object",
      input: {},
      canonical: "{}",
      sha256:
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    },
    {
      description: "empty array",
      input: [],
      canonical: "[]",
      sha256:
        "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    },
    {
      description: "object keys sorted by code unit",
      input: { b: 1, a: 2 },
      canonical: '{"a":2,"b":1}',
      sha256:
        "sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772",
    },
    {
      description: "array order preserved and negative zero normalized",
      input: [3, -0, 2, 1.5],
      canonical: "[3,0,2,1.5]",
      sha256:
        "sha256:a15e4d3cef7debc809a44c3dd985fb74fb065ff8fc11427b9aa66848902720f7",
    },
    {
      description: "unicode keys sorted by UTF-16 code unit",
      input: { z: 1, "ä": 2, "İ": 3, i: 4, "😀": 5 },
      canonical: '{"i":4,"z":1,"ä":2,"İ":3,"😀":5}',
      sha256:
        "sha256:d3472266da9d454a9772290ea49da8f9967a6eb1e78420e2288dcd38ce18f5c4",
    },
    {
      description: "number formatting matches JSON.stringify",
      input: { big: 1e21, frac: 1.5, neg: -0, int: 42 },
      canonical: '{"big":1e+21,"frac":1.5,"int":42,"neg":0}',
      sha256:
        "sha256:7ccf06162ed7958b4b9dbd7c897429a4fbdf55fc445d1476552419b9a1035f77",
    },
    {
      description: "nested objects and arrays",
      input: { a: { c: [true, null, "x"], b: 1 } },
      canonical: '{"a":{"b":1,"c":[true,null,"x"]}}',
      sha256:
        "sha256:f4528f26cc1869a4dd360a947ccce26133d36e05e6b9c6b93783f58cbd001b8a",
    },
    {
      description: "string escaping",
      input: { s: 'a"b\n\t\\' },
      canonical: '{"s":"a\\"b\\n\\t\\\\"}',
      sha256:
        "sha256:e3e336d0045ab6147aa7e208827c37964e20f9b0fdffd766ec818258117dc637",
    },
  ]);
