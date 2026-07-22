# `@webhook-portal/canonical-model`

Canonical, dependency-free webhook contract and event data model shared by every
other package in this repository. Zero I/O; safe to use in browsers, edge
runtimes, or Node.js.

```ts
import {
  CANONICAL_MODEL_VERSION,
  CANONICAL_SCHEMA_VERSION,
  JSON_SCHEMA_2020_12_DIALECT,
  type CanonicalContract,
  type CanonicalEventVersion,
} from "@webhook-portal/canonical-model";
```

This package defines:

- The canonical contract/event/version shape produced by
  [`@webhook-portal/contract-core`](../contract-core) after parsing an OpenAPI
  or AsyncAPI source document.
- Deterministic JSON helpers and stable-ordering utilities used to keep
  checksums and diffs reproducible across Node.js versions and locales.
- Type guards for narrowing untyped JSON into the canonical model safely.

## Canonical JSON

`canonicalJson` is the single, hardened, RFC 8785-style serializer that every
signature, checksum, and digest in the toolkit routes through. Consolidating the
seven previous per-package implementations here guarantees byte-identical output
across the cohort — proven by the shared `CANONICAL_GOLDEN_VECTORS`.

```ts
import {
  canonicalJson,
  canonicalJsonDigest,
  stableJson,
} from "@webhook-portal/canonical-model";

canonicalJson({ b: 1, a: 2 }); // '{"a":2,"b":1}'
canonicalJsonDigest({ b: 1, a: 2 }); // 'sha256:<hex>'
```

Exact edge semantics:

| Concern            | Behavior                                                             |
| ------------------ | -------------------------------------------------------------------- |
| Key ordering       | Ascending by UTF-16 code unit (locale-independent).                  |
| Unicode            | Unpaired surrogates in strings **or keys** are rejected.             |
| Negative zero      | `-0` serializes to `0`.                                              |
| Non-finite numbers | `NaN`/`±Infinity` are rejected.                                      |
| `undefined`        | Rejected wherever it appears (array element or object property).     |
| Arrays             | Must be dense, standard-prototype arrays of index data properties.   |
| Objects            | Enumerable data properties only; accessors/symbols/proxies rejected. |
| Prototype keys     | `__proto__`/`constructor`/`prototype` rejected unless opted in.      |

Consumers that must keep the historical `JSON.stringify(orderedRecursively)`
checksum bytes (which drop `undefined` object properties and coerce non-finite
numbers to `null`) use the lenient companion `stableJson`/`orderJsonKeys`
instead. Failures throw `CanonicalJsonError` with a stable `kind`; packages that
own their own error taxonomy pass an `onError` factory to translate it (see
`@webhook-portal/extension-sdk` and `@webhook-portal/support-evidence`).

You will not usually depend on this package directly unless you are building a
new adapter or tool against the canonical model; most consumers use
[`@webhook-portal/contract-core`](../contract-core) or
[`@webhook-portal/adapter-sdk`](../adapter-sdk) instead, which re-export the
parts of this model they need.
