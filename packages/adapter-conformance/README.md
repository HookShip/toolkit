# `@webhook-portal/adapter-conformance`

A reusable conformance harness that proves an
[`@webhook-portal/adapter-sdk`](../adapter-sdk) implementation behaves correctly
— the same suite the open generic HTTP adapter is tested against, and the
intended way for a third-party adapter to prove it satisfies the contract
described in the SDK.

```ts
import type { ConformanceAdapter } from "@webhook-portal/adapter-conformance";
```

An adapter under test implements `ConformanceAdapter` — a capability document
plus an `execute(command)` function — and the harness exercises it against
probes covering:

- **Capability negotiation** — capability documents follow the versioned schema
  (`ADAPTER_CAPABILITY_SCHEMA_ID`) and unsupported operations return a typed
  `unsupported` result rather than a silent success.
- **Idempotency** — retried commands (including across a restart) do not
  duplicate side effects.
- **Deadlines** — commands that exceed their deadline are cancelled rather than
  left to run unbounded.
- **Metadata normalization** — delivery-attempt metadata reduces to the
  canonical, allowlisted shape regardless of provider-specific input.
- **Secret handling** — secret values are redacted from string/JSON output and
  never logged in the clear.

Run it against your own adapter to catch drift from the SDK contract before it
reaches production, independent of which provider your adapter targets.
