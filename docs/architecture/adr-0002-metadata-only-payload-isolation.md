# ADR-0002: Metadata-only payload isolation

## Status

Accepted

## Context

Webhook bodies and headers can contain personal data, credentials, and
application secrets. Delivery observability usually needs status, timing, and
identity metadata rather than full request bodies. Collecting payloads by
default would unnecessarily increase the security and privacy impact of running
the reference server.

## Decision

The adapter SDK defines a closed canonical delivery-metadata shape. Adapters and
the reference server normalize observations through that allowlist and reject
unknown fields, raw payloads, arbitrary headers, and credential-like values by
default. See [`packages/adapter-sdk`](../../packages/adapter-sdk) and the
reference-server implementation under
[`packages/cli/src/reference-server`](../../packages/cli/src/reference-server).

Optional payload retention is a separate explicit setting with a bounded TTL. It
is not required for contracts, endpoints, subscriptions, signed tests, metadata
ingest, timeline, or audit.

When enabled, object storage uses an installation namespace and physical store
identifier to derive and verify the bucket identity. Migrations under
[`infra/migrations`](../../infra/migrations) track cleanup claims, payload
generations, namespace/store bindings, and derived bucket names. Runtime
readiness fails closed when configured storage does not match the persisted
identity or when cleanup-capable storage is required but unavailable.

## Consequences

- The safest data-handling mode is the default.
- Payload retention is explicit, bounded, reversible, and independently
  testable.
- Metadata schema changes require deliberate SDK and validation changes.
- Storage identity and cleanup add implementation complexity but prevent silent
  retention or cross-installation bucket reuse.
- This decision is an implementation property, not a compliance certification or
  legal commitment.
