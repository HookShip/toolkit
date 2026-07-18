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

You will not usually depend on this package directly unless you are building a
new adapter or tool against the canonical model; most consumers use
[`@webhook-portal/contract-core`](../contract-core) or
[`@webhook-portal/adapter-sdk`](../adapter-sdk) instead, which re-export the
parts of this model they need.
