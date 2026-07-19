# ADR-0006: Capability-based adapter interfaces

## Status

Accepted

## Context

Webhook delivery runtimes differ in which endpoint, subscription, secret,
testing, replay, and metadata operations they support. A fixed interface would
either force adapters to fake unsupported behavior or leak runtime-specific
knowledge into callers.

## Decision

Every adapter implements the shared `@webhook-portal/adapter-sdk` interface:

- `capabilities()` returns a versioned capability document;
- `execute(command, context)` returns a typed `ok`, `unsupported`, `degraded`,
  or `unknown` result.

Commands carry actor/environment context, deadline, and idempotency data.
Callers must check capabilities before offering an action and must handle every
result variant explicitly.

[`@webhook-portal/adapter-conformance`](../../packages/adapter-conformance)
provides the reusable executable contract, and
[`@webhook-portal/adapter-generic-http`](../../packages/adapter-generic-http) is
the public reference implementation.

Cross-cutting safety stays in the SDK: scoped self-redacting credentials,
canonical allowlisted delivery metadata, deadline handling, and signed
replay-resistant command envelopes.

## Consequences

- A new adapter can be developed against one public interface and one
  conformance harness.
- Unsupported operations remain explicit rather than becoming no-ops or false
  successes.
- Credential and metadata safety are consistent across implementations.
- Callers must handle capability negotiation and four result variants.
