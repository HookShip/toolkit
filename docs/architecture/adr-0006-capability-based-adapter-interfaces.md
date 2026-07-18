# ADR-0006: Capability-based adapter interfaces

## Status

Accepted

## Context

The system must control endpoints, subscriptions, secrets, tests, and replays
across multiple delivery runtimes — the open generic HTTP adapter, and
(privately) Svix and Hookdeck/Outpost — without the control plane, worker, or UI
special-casing each provider. Providers differ in which operations they actually
support (for example, not every provider can pause a subscription or rotate a
secret with an overlap window), so a naive single fixed interface either forces
every adapter to fake unsupported operations or forces the rest of the system to
hold provider-specific knowledge. Either path makes adding a new adapter, or
reasoning about what a given deployment can actually do, progressively harder.

## Decision

Every adapter — first-party or third-party — implements one shared interface
from `@webhook-portal/adapter-sdk`: `capabilities()` returns a versioned
`AdapterCapabilityDocument`, and `execute(command, context)` runs one
`AdapterCommand` and returns a typed `ok` / `unsupported` / `degraded` /
`unknown` result. The SDK's contract is explicit that "a UI must check
capabilities before offering an action, and must never imply an unsupported
operation succeeded" (see
[`packages/adapter-sdk/README.md`](../../packages/adapter-sdk/README.md) "Core
pieces"). The command set itself is closed and enumerated —
`endpoint.{create,read,update,pause,resume,delete,verify}`,
`subscription.{read,replace,pause,resume}`,
`secret.{create,rotate_with_overlap,revoke}`, `send_test`, `request_replay`, and
`metadata.{poll,backfill}` — and every command carries tenant, actor, and
environment context, a deadline, and an idempotency key.

Conformance is a shared, executable harness rather than a written checklist:
`@webhook-portal/adapter-conformance` is "a reusable conformance harness so any
adapter (first- or third-party) can prove it satisfies the SDK contract," and it
is explicitly "the same suite the open generic HTTP adapter is tested against"
(`adapter-sdk/README.md`). The open reference implementation,
`@webhook-portal/adapter-generic-http`, and the private, scoped `adapter-svix`
and `adapter-hookdeck` packages all sit behind this identical interface (see the
`README.md` packages table). Supporting cross-cutting concerns are part of the
same SDK rather than left to each adapter to reimplement: scoped, self-redacting
credentials (`ScopedCredential`, `SecretValue`, `redactSecrets`); a canonical,
allowlisted delivery-metadata shape (`CanonicalMetadataRecord`,
`reduceDeliveryAttempt`, feeding
[ADR-0002](adr-0002-metadata-only-payload-isolation.md)); and signed,
replay-resistant command envelopes (`createAuthenticatedCommandEnvelope`,
`verifyAuthenticatedCommandEnvelopeWithReplay`). The worker consumes adapters
only through an `AdapterRegistry` port, and only ever receives a scoped
credential inside a `withCredential` callback — credential material is never
placed in a job, result, dead letter, diagnostic, metric, or span (see
[`apps/worker/README.md`](../../apps/worker/README.md) "Public integration
boundaries").

## Consequences

- Adding a new provider adapter (open or commercial) means implementing one
  interface and passing one shared conformance suite, not modifying the control
  plane, worker, or UI to understand a new provider.
- The UI and worker can never assume a capability exists — every
  provider-specific gap surfaces as an explicit `unsupported`/`degraded` result
  rather than a silent no-op or a misleading success, at the cost of every call
  site needing to handle four result variants instead of one.
- Standardizing delivery-attempt observations into one canonical, allowlisted
  metadata shape before storage is what makes
  [ADR-0002](adr-0002-metadata-only-payload-isolation.md)'s metadata-only ingest
  schema enforceable across providers with different native event shapes.
- Because credential material only exists inside a `withCredential` scope, an
  adapter bug that logs its command/result cannot leak credential material by
  construction — this is a stronger guarantee than "the code is not supposed to
  log secrets."
- Commercial adapters (`adapter-svix`, `adapter-hookdeck`) still depend only on
  the open `adapter-sdk` interface, not the reverse, preserving the dependency
  direction from [ADR-0001](adr-0001-open-core-workspace-boundary.md).
