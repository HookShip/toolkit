# ADR-0005: Contract normalization standards

## Status

Accepted

## Context

Webhook producers describe their events in different, evolving standards —
OpenAPI `webhooks` definitions, AsyncAPI messages/operations — and consumers
need stable, checksummable, diffable artifacts (fixtures, generated types,
compatibility results) derived from those descriptions. If the system parsed
each contract format ad hoc and generated downstream artifacts directly from
provider-specific structures, every new supported standard or version would risk
inconsistent behavior, and there would be no single place to bound untrusted
input (contracts are frequently imported from third parties) or to decide,
deterministically, whether a change is compatible or breaking.

## Decision

Every supported contract format is parsed down to one shared **canonical model**
before anything else happens to it. `@webhook-portal/canonical-model` defines
"the canonical contract/event/version shape produced by
`@webhook-portal/contract-core` after parsing an OpenAPI or AsyncAPI source
document," is zero-I/O, and provides "deterministic JSON helpers and
stable-ordering utilities used to keep checksums and diffs reproducible across
Node.js versions and locales" (see
[`packages/canonical-model/README.md`](../../packages/canonical-model/README.md)).
`@webhook-portal/contract-core` supports exactly "OpenAPI `3.1.x`" top-level
`webhooks` definitions, "AsyncAPI `2.6.0` and `3.0.0`" messages/operations, and
"JSON Schema `2020-12`" as the canonical dialect, with documented `draft-07`
import compatibility — and states explicitly that "new upstream major versions
are adopted deliberately; this package does not silently change existing
normalization behavior for already-supported inputs" (see
[`packages/contract-core/README.md`](../../packages/contract-core/README.md)
"Supported standards").

The pipeline is staged and each stage has one explicit responsibility: `parse`
detects format/version and reports support before attempting full normalization;
`validate` runs full structural/semantic validation bounded by explicit limits
(input size, node count, reference count, alias/depth, validation work,
canonical output size — see
[`packages/contract-core/src/limits.ts`](../../packages/contract-core/src/limits.ts))
so that parsing untrusted contract input stays safe and deterministic;
`canonicalize` produces the stable, checksummable `CanonicalContract`; `diff`
classifies a change as "compatible, breaking, docs-only, or unknown — never
silently 'compatible' when it cannot prove it"; `fixtures` and `types` generate
example payloads and TypeScript types, and `types` "intentionally exit[s] with a
documented partial status rather than emitting a silently wrong type" for schema
constructs it cannot represent exactly. Only supported local `$ref` targets are
resolved; external and relative references fail explicitly, and the package
performs no network or filesystem fetches (`contract-core/README.md`).

## Consequences

- Every downstream consumer (fixture generation, TypeScript generation,
  compatibility-gated publish, the adapter SDK's canonical metadata, extensions)
  works against one stable canonical shape instead of format-specific
  structures, so adding a new contract source format only requires a new
  `parse`/`canonicalize` path, not changes throughout the system.
- Explicit, documented input bounds mean importing a large or adversarial
  contract fails predictably (a bounded error) instead of exhausting memory or
  CPU — a deliberate safety property for a feature (`contract import`) that by
  nature accepts input from parties the operator does not fully trust.
- Refusing to silently guess at compatibility, or emit a silently wrong
  generated type, trades convenience (a diff or type is sometimes "unknown" or
  "partial" instead of a confident-looking answer) for correctness —
  compatibility gates that block a `breaking` or `unknown` diff can produce
  false positives that require investigation, which is the accepted cost of
  never producing a false negative.
- Committing to specific standard versions (OpenAPI 3.1.x, AsyncAPI 2.6.0/
  3.0.0, JSON Schema 2020-12) deliberately excludes older or newer contract
  documents until a documented, deliberate adoption of the new version —
  contracts in unsupported dialects must be migrated by the producer, not
  silently reinterpreted.
- This decision is a data-normalization and validation architecture already
  implemented in `packages/contract-core` and `packages/canonical-model`, both
  Apache-2.0 public packages usable independently in this standalone toolkit
  (see [ADR-0001](adr-0001-open-core-workspace-boundary.md)).
