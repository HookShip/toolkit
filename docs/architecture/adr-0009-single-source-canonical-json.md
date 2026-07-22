# ADR-0009: Single-source canonical JSON serialization

## Status

Accepted

## Context

Reproducible signatures, checksums, and digests are load-bearing across the
toolkit: extension bundles, evidence bundles, command envelopes, delivery
metadata dedupe keys, compatibility reports, migration assessments, and
canonical contracts all commit to bytes that must be recomputable identically on
any Node.js version, in any locale, forever. Historically each package carried
its own canonical/stable JSON serializer — seven or more implementations of the
same algorithm — that had drifted into two families:

- A **strict** family (`@webhook-portal/extension-sdk`,
  `@webhook-portal/support-evidence`, `@webhook-portal/adapter-sdk`) that
  rejected `undefined`, non-finite numbers, unpaired surrogates, cycles, and
  exotic objects, normalized `-0` to `0`, and sorted object keys by UTF-16 code
  unit.
- A **lenient** family (`@webhook-portal/contract-core`,
  `@webhook-portal/migration-assessment`,
  `@webhook-portal/compatibility-report`) built on
  `JSON.stringify(orderedRecursively)`, which drops `undefined` object
  properties and coerces non-finite numbers to `null`.

Duplication of security-critical serialization is a correctness and audit
hazard: a subtle divergence between two copies silently breaks cross-package
reproducibility, and there was no shared, independently-verified proof that the
copies agreed.

## Decision

`@webhook-portal/canonical-model` — the dependency-free leaf that every other
package already sits above — owns the single canonical serialization
implementation:

- `canonicalJson` is the strict serializer with fully documented edge semantics
  (see [`packages/canonical-model/README.md`](../../packages/canonical-model/README.md)).
  Failures throw `CanonicalJsonError` carrying a stable `kind`; packages that
  expose their own error taxonomy pass an `onError` factory that translates the
  `kind` into their domain error while preserving byte output.
- `stableJson`/`orderJsonKeys` is the lenient companion that preserves the
  historical `JSON.stringify(orderedRecursively)` checksum bytes for consumers
  that predate the strict form.
- `CANONICAL_GOLDEN_VECTORS` are cross-package golden vectors whose `sha256`
  values are computed independently of the serializer. Each producing package
  asserts them, so any divergence fails a test rather than corrupting a
  signature.

The strict family delegates its serializer to `canonicalJson`; the lenient
family delegates to `stableJson`. `@webhook-portal/adapter-sdk` keeps its
secret-resolving, `undefined`-dropping canonicalization pre-pass but delegates
the final byte production to `canonicalJson`. No package retains a second
copy of the traversal.

## Consequences

- Signatures and checksums are guaranteed byte-identical across the cohort by
  construction and proven by shared golden vectors; existing committed
  seed-pack signatures and every package's reproducibility suite continue to
  pass unchanged.
- `@webhook-portal/extension-sdk` and `@webhook-portal/support-evidence` gained
  a dependency on `@webhook-portal/canonical-model`. The dependency direction
  remains acyclic (canonical-model is a leaf) and is enforced by
  `scripts/check-package-boundaries.mjs`.
- Edge semantics (unicode, `-0`, arrays, `undefined`, key ordering, prototype
  keys) now have exactly one authoritative definition and one place to change.
- The lenient and strict variants are intentionally distinct because they must
  reproduce different historical bytes; both live in one module so the
  distinction is explicit rather than accidental.
