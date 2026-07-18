# `@webhook-portal/adapter-sdk`

Capability-driven interfaces that every webhook provider adapter (open or
third-party) implements against, so the rest of the system never has to
special-case a specific provider.

```ts
import type { Adapter, AdapterCommand } from "@webhook-portal/adapter-sdk";
```

Core pieces:

- **`Adapter`** — the interface every adapter implements: `capabilities()`
  returns a versioned `AdapterCapabilityDocument`, and
  `execute(command, context)` runs one `AdapterCommand` and returns a typed `ok`
  / `unsupported` / `degraded` / `unknown` result. A UI must check capabilities
  before offering an action, and must never imply an unsupported operation
  succeeded.
- **Commands** (`AdapterCommandInputMap`) —
  `endpoint.{create,read,update, pause,resume,delete,verify}`,
  `subscription.{read,replace,pause,resume}`,
  `secret.{create,rotate_with_overlap,revoke}`, `send_test`, `request_replay`,
  and `metadata.{poll,backfill}`. Every command carries tenant/actor/environment
  context, a deadline, and an idempotency key.
- **Scoped credentials** (`ScopedCredential`, `SecretValue`) — adapter
  credentials are scoped to the minimum required resources, redact themselves
  from string/JSON output, and are never exposed to a browser.
- **Path-aware secret redaction** (`redactSecrets`) — preserves `SecretValue`
  identifiers and purpose metadata while redacting converted `material.value`
  and rotation `replacement` fields in command envelopes.
- **Canonical metadata** (`CanonicalMetadataRecord`,
  `MetadataDeliveryAttemptInput`, `reduceDeliveryAttempt`) — the allowlisted,
  provider-agnostic shape that delivery/test observations are normalized into
  before they reach storage.
- **Authenticated envelopes** (`createAuthenticatedCommandEnvelope`,
  `verifyAuthenticatedCommandEnvelope`) — signed, replay-resistant envelopes
  used to authenticate control commands and metadata ingests.

If you are building a new adapter, also depend on
[`@webhook-portal/adapter-conformance`](../adapter-conformance) and run its
harness against your implementation — it is the same suite the open generic HTTP
adapter is tested against.

## Delivery-attempt dedupe migration

Generated delivery-attempt dedupe keys now include status, occurrence time, and
bounded outcome fields. Consumers must recompute keys with this SDK rather than
reimplementing or persisting the key algorithm. Exact observations still dedupe,
while meaningful same-sequence observations such as `attempting` followed by
`delivered` advance monotonically. Generated keys now use the
`whp:delivery-attempt:v3:` prefix.

## Command receiver replay protection

Stateless `verifyAuthenticatedCommandEnvelope()` no longer returns success for
side-effecting commands. Receivers must use
`verifyAuthenticatedCommandEnvelopeWithReplay()` with an atomic
`CommandEnvelopeReplayStore`, then persist the result with
`completeCommandEnvelopeReplay()`. Replay-store operations are asynchronous and
carry deadline/abort context. Duplicate in-progress envelopes are rejected;
completed duplicates return the stored typed result.

Replay records use `retainUntil` (replacing `expiresAt`) and default to a
24-hour idempotency window from receiver acceptance, capped at 30 days. The
retain-until timestamp is always at least the command-envelope deadline, so a
newly signed equivalent command can replay the stored result after the original
envelope expires. `commandReplayIdentityStorageKey()` and
`commandReplayNonceStorageKey()` produce printable ASCII SHA-256 keys for
durable indexes without embedding tenant, connection, nonce, or idempotency
material in database keys.

Host-scoped credentials fail closed: when `scope.hosts` is non-empty,
verification must provide a matching normalized host. Host context remains
optional only for credentials without host restrictions.
