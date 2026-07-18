# ADR-0002: Metadata-only payload isolation

## Status

Accepted

## Context

A webhook developer portal that ingests information about every delivery attempt
is inherently adjacent to sensitive data: raw webhook bodies can contain
customer PII, financial data, or credentials, and endpoint configuration can
contain secrets. A product whose default behavior is to collect and retain that
raw data by default maximizes both its own breach blast radius and every
adopting team's compliance burden, for a purpose (delivery observability) that
does not usually require the raw body at all. The project needed a data-handling
default that a security-conscious team could adopt without a lengthy
data-processing review, while still leaving an explicit, scoped path open for
teams that do need payload retention (for example, for support replay).

## Decision

The system persists normalized delivery **metadata** — event type/version,
endpoint/adapter references, timestamps, status, latency, and a normalized error
category — through a closed, allowlist-validated ingest schema that rejects
unknown fields, payload bodies, and anything resembling a credential by default
(see `README.md` "Metadata-only by default" and
[`packages/adapter-sdk`](../../packages/adapter-sdk)'s `CanonicalMetadataRecord`
/ `reduceDeliveryAttempt`, which is the allowlisted shape every adapter's
delivery/test observation is normalized into before it reaches storage).
Optional raw payload retention is a **separate, explicit, per-environment,
TTL'd** setting; it is never required for contract management, endpoint
management, signed tests, or the metadata timeline to work.

Where payload retention is enabled, the schema tracks payload state as a
first-class, cleanable lifecycle rather than an incidental blob column:
dedicated migrations introduce payload cleanup claims, payload generations,
namespace/store identity, and derived bucket handling
([`infra/migrations/004_payload_cleanup_claims.sql`](../../infra/migrations/004_payload_cleanup_claims.sql),
`005_payload_generations.sql`, `007_payload_storage_identity.sql`,
`008_namespace_binding_timeline_identity.sql`,
`009_namespace_derived_bucket.sql`, `010_payload_store_identity.sql`,
`011_store_derived_bucket.sql`). The managed worker's task catalog runs
dedicated `payload.reference.cleanup`, `payload.orphan.cleanup`, and
`retention.sweep` jobs as ongoing governance work rather than best-effort manual
cleanup (see [`apps/worker/README.md`](../../apps/worker/README.md) "Task
catalog"). `infra/setup.sh` generates a compact payload namespace/store ID pair
that derives the object-store bucket name, and explicitly fails closed on
pre-release installs still using the retired namespace-only bucket naming rather
than silently reinterpreting old data (`README.md` local setup section).

## Consequences

- The safest configuration is also the default configuration: a team that
  deploys the reference server or the managed pilot without changing any payload
  setting never stores a raw webhook body, header, or credential.
- Enabling payload retention is an explicit, bounded, reversible opt-in (scoped,
  TTL'd) rather than an implicit consequence of enabling any other feature,
  which keeps the blast radius of a misconfiguration small and auditable.
- The payload lifecycle (generation, cleanup claim, orphan cleanup, retention
  sweep) is treated as durable state with its own migrations and worker jobs,
  which costs additional schema and job-catalog complexity but avoids the common
  failure mode of "retention" being an unenforced policy comment.
- Because metadata ingestion uses a closed, allowlist-validated schema, adding a
  new metadata field requires a deliberate schema and adapter-SDK change; it
  cannot silently widen through an adapter passing through extra fields.
- This decision governs default data handling behavior implemented in the
  repository. It does not itself constitute a compliance certification, DPA, or
  data-processing commitment — those remain deployment- and
  legal-owner-specific, per [`docs/launch/README.md`](../launch/README.md).
