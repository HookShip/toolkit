# `@webhook-portal/contract-core`

Parses, validates, canonicalizes, checksums, diffs, and generates fixtures and
TypeScript types from webhook event contracts.

```ts
import { parse, validate } from "@webhook-portal/contract-core";

const parsed = parse(sourceText, { sourceUri: "orders.openapi.yaml" });
const result = validate(sourceText, { sourceUri: "orders.openapi.yaml" });
```

Also available as `contractCore`, a frozen object exposing the same functions
under their long-form names (`parse`, `validate`, `canonicalize`, `checksum`,
`diff`, `fixtures`, `types`) for callers that prefer a single namespaced import.

## Supported standards

- **OpenAPI `3.1.x`** — top-level `webhooks` definitions.
- **AsyncAPI `2.6.0` and `3.0.0`** — messages/operations relevant to outbound
  webhook publication.
- **JSON Schema `2020-12`** as the canonical dialect, with documented `draft-07`
  import compatibility for source documents that declare it.

New upstream major versions are adopted deliberately; this package does not
silently change existing normalization behavior for already-supported inputs.

## What each stage does

- **`parse`** reads an OpenAPI or AsyncAPI document (JSON or YAML), detects its
  format/version, and reports whether it is supported before attempting full
  normalization.
- **`validate`** runs full structural and semantic validation, bounded by the
  limits in [`src/limits.ts`](src/limits.ts) (input size, node count, reference
  count, alias/depth limits, validation work, and canonical output bytes/nodes)
  to keep parsing of untrusted input safe and deterministic. Explicit input
  byte/node overrides permit at most two-times canonical expansion unless
  separate output limits are supplied.
- **`canonicalize`** produces the stable, checksummable
  [`CanonicalContract`](../canonical-model) shape re-exported from
  `@webhook-portal/canonical-model`.
- **`diff`** compares two canonical contracts and classifies the result as
  compatible, breaking, docs-only, or unknown — never silently "compatible" when
  it cannot prove it.
- **`fixtures`** generates example payloads for a given event/version from its
  schema.
- **`types`** generates TypeScript types for a given event/version. Schema
  constructs it can approximate but not represent exactly intentionally exit
  with a documented partial status rather than emitting a silently wrong type.

Only supported local `$ref` targets are resolved. External and relative
references fail with explicit diagnostics; this package exposes no remote
resolver and performs no network or filesystem fetches.
