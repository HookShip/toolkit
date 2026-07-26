# ADR-0011: Single-responsibility module and function sizes

## Status

Accepted

## Context

Several packages had accumulated very large "god" source files and functions — a
2504-line Postgres repository, a 2332-line HTTP server, a 2223-line
normalization module, 2000-line CLI command files, and 800-2000-line adapter,
extension, migration, and payload files — with dozens of methods or hundreds of
lines each. A [source-size ratchet](../../scripts/check-source-size.mjs)
grandfathered these hotspots on an allowlist. Large modules obscure single
responsibilities, make review and testing coarse-grained, and let unrelated
concerns share mutable state implicitly.

## Decision

The toolkit enforces two size ceilings on non-generated production source, and
decomposes along single-responsibility seams to meet them:

- **No source file exceeds 800 lines**, with exactly one documented exception:
  `packages/contract-core/src/diff.ts`, a cohesive structural-diff engine whose
  phases share one traversal. The ratchet allowlist may otherwise contain only
  this file; ordinary production code is decomposed rather than grandfathered.
- **No production function exceeds 150 lines.** Long functions are split into
  order-preserving helpers at one level of abstraction.

The decompositions preserve behavior byte-for-byte and follow consistent
patterns:

- **Repositories** are composed from per-role modules (contract/release,
  endpoint, secret, test-command, timeline/audit/outbox, and payload —
  references/cleanup/namespace) implementing the segregated interfaces in
  `types.ts`, over a shared per-backend context/state that owns pooling, the
  `AsyncLocalStorage` transaction, and query/state helpers. The public
  `PostgresReferenceRepository` and `InMemoryReferenceRepository` remain thin
  composition facades; no role module exceeds 600 lines.
- **The HTTP server** is a <=150-line `buildReferenceServer` aggregator over
  typed request-parsing, serialization, schema, security, lifecycle, and
  per-resource route modules.
- **`ReferenceService`** is a thin facade over Contract/Release/Endpoint/Secret/
  TestDispatch/TestEvidence/Metadata domain services; `sendTest` is broken into
  prepare/dispatch/deliver/complete phases.
- **Migrations** are one module per SQL migration built through a shared
  checksum helper, assembled by an ordered registry, with migration-state logic
  separated; the `infra/migrations/*.sql` single-source parity and checksums are
  unchanged.
- **Payload storage** is split by backend (disabled/in-memory/MinIO) and
  lifecycle (object operations vs reconciliation vs identity vs maintenance).
- **Contract normalization** is split into extraction-context, OpenAPI/AsyncAPI
  extraction, example validation, and canonicalization modules, and long
  extraction/diff functions are reduced below 150 lines.

## Consequences

- Every public surface is unchanged; checksum/signature golden vectors, the
  OpenAPI operation snapshot, the migration parity test, and the live
  Postgres+MinIO integration all stay green, so the decomposition is provably
  behavior-preserving.
- The ratchet fails closed on any new oversized file and on any allowlist entry
  that is no longer needed, so the win cannot silently regress; only `diff.ts`
  remains grandfathered, with a written justification in the allowlist.
- Package dependency direction stays acyclic (enforced by
  `scripts/check-package-boundaries.mjs`); role/phase modules are internal and
  are not re-exported through package barrels.
- Coverage is measured per role/module boundary (direct role, migration, and
  payload-backend tests were added) with all package floors preserved.
