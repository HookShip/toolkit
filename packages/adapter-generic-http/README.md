# `@webhook-portal/adapter-generic-http`

The open reference [`@webhook-portal/adapter-sdk`](../adapter-sdk)
implementation: a generic HTTP adapter for any custom worker, with two
independently selectable modes and no dependency on a specific vendor.

```ts
import { createGenericHttpAdapter } from "@webhook-portal/adapter-generic-http";

const adapter = createGenericHttpAdapter({
  adapter: { id: "generic-http", name: "Generic HTTP", version: "1.0.0" },
  connectionId: "conn_local",
  baseUrl: "https://webhooks.example.com",
  routes: {
    "endpoint.create": { method: "POST", path: "/webhook-endpoints" },
  },
});
```

## Control mode

Signed HTTPS commands to a customer-operated service for endpoint, subscription,
secret, test, and replay operations, with authenticated, replay-resistant
envelopes (`createAuthenticatedCommandEnvelope` /
`verifyAuthenticatedCommandEnvelope`) and signed acknowledgements
(`verifyProviderAcknowledgement`). A route is only ever called if the adapter's
capability document declares it supported.

## Metadata mode

Authenticated push ingestion of normalized delivery-attempt metadata using the
canonical schema from `@webhook-portal/adapter-sdk`
(`validateMetadataDeliveryAttemptInput`, `reduceDeliveryAttempt`). A customer
can use metadata mode alone — this adapter never requires exposing production
payloads or letting this product deliver normal events.

## Safety

- **Destination validation** (`validateHttpDestination`,
  `validateHttpDestinationSyntax`) rejects loopback, RFC1918/private,
  link-local, and cloud-metadata targets by default; an operation must
  explicitly allow local-network testing to bypass this (used only for
  self-contained local demos and tests).
- **Idempotency** (`validateIdempotencyKey`) and **deadlines**
  (`createDeadlineSignal`) are enforced on every side-effecting command.
- Unsupported operations return a typed `unsupportedResult()`; failures
  distinguish `failureResult()` (known failure) from `unknownResult()`
  (indeterminate outcome after a timeout) so callers never treat "no response"
  as success.

This package is exercised by the shared
[`@webhook-portal/adapter-conformance`](../adapter-conformance) harness.

## Breaking route and store contracts

- Route placeholders must occupy complete path segments. Parameter values that
  decode or normalize to `.` or `..` are rejected, and the final normalized
  pathname must preserve the template's literal/parameter segment structure.
- Adapter routes reject `HEAD`; authenticated control/read acknowledgements
  require JSON response bodies. Use `GET` for reads.
- `IdempotencyBeginInput.retainUntil` was replaced by `leaseExpiresAt` and
  `resultExpiresAt`; reservations also carry `commandDeadline` and
  `safetyGraceMilliseconds` so stores can enforce the minimum lease boundary.
- An acquired `begin()` result now returns a unique `leaseToken`. `complete()`
  and `release()` require that exact token, so a stale caller cannot mutate a
  newer reservation.
- `lookup()`, `begin()`, `complete()`, and `release()` now receive `deadlineAt`
  and `AbortSignal`; implementations must cancel external I/O when either
  expires. `AcknowledgementReplayStore.consume()` follows the same contract.
- In-progress reservations remain protected through the command deadline plus
  `idempotencySafetyGraceMilliseconds`. Completed results expire only at
  `resultExpiresAt`; abandoned leases expire only at `leaseExpiresAt`.
- Completed idempotency results default to a 24-hour retention window and are
  capped at 30 days.
- The default Node transport uses one-shot agents and never pools sockets
  between independently validated DNS address sets.
- Command and acknowledgement credentials must use distinct secret material, not
  merely different credential IDs. Equality is checked internally in constant
  time without exposing key bytes or fingerprints.
- `DestinationPolicy.allowLocalNetwork` permits plaintext HTTP only when every
  pinned address is explicitly loopback/private. Public destinations always
  require HTTPS. The deprecated `allowHttp` flag remains only as a local opt-in
  alias and cannot enable public plaintext HTTP.
- Command `providerRef` values are validated before any replay-store lookup or
  dispatch. Provider identity is NFKC/case normalized, while resource types must
  exactly match the operation (`endpoint`, `subscription`, or `secret`).
- Signed envelopes and durable stores retain the original Unicode idempotency
  key. The HTTP `Idempotency-Key` header carries only
  `whp-idem-v1.<sha256-base64url>`; receivers should treat it as an opaque
  correlation value and use the signed envelope key for idempotency identity.
- Temporary DNS failures and resolver timeouts are retryable pre-dispatch
  failures and are never durably reserved; NXDOMAIN/invalid resolver requests
  remain deterministic non-retryable failures.
