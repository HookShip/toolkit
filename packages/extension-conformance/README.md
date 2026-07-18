# `@webhook-portal/extension-conformance`

Framework-neutral conformance harness for
[`@webhook-portal/extension-sdk`](../extension-sdk). Version `0.1.0`.

The runtime package imports no Vitest types. It can run directly, be registered
with any test framework exposing `describe`/`test`, or be wrapped by CI.

## Covered categories

1. closed/versioned manifest validation;
2. resource, digest, and signature verification;
3. deny-by-default permission and escalation checks;
4. transform/policy determinism or connector/template data-only checks;
5. platform/SDK compatibility and deterministic resolution;
6. canonical serialization and optional reproducible rebuild;
7. a closed malicious corpus for traversal, binary/executable assets, unknown
   fields, bombs, permission escalation, prototype pollution, secret material,
   signature tampering, and revocation.

## Direct runner

```ts
import {
  assertExtensionConformance,
  runExtensionConformance,
} from "@webhook-portal/extension-conformance";

const report = await runExtensionConformance({
  name: "Acme transform",
  bundle,
  expectedKind: "transform",
  platformVersion: "1.2.0",
  sdkVersion: "0.1.0",
  trustPolicy,
  transformInput: { event: { type: "invoice.paid" } },
  rebuild: () => rebuildBundleFromSource(),
});

assertExtensionConformance(report);
```

Reports contain stable case IDs, categories, pass/fail status, and sanitized
failure messages. Timing is intentionally omitted so report content remains
reproducible.

## Test-framework adapter

```ts
import { describe, test } from "node:test";
import { registerExtensionConformanceTests } from "@webhook-portal/extension-conformance/suite";

registerExtensionConformanceTests({ describe, test }, fixture);
```

Vitest, Jest, Node test, and other adapters can provide the same small
`ConformanceTestRunner` interface; the package itself has no dependency on them.

## Public entry points

- package root: complete API;
- `/suite`: fixture cases, direct runner, and framework registration;
- `/runner`: generic deterministic case/report primitives;
- `/malicious-corpus`: corpus descriptors and closed corpus runner.

The harness verifies SDK-level safety properties. It does not replace publisher
review, trust-policy operations, host network sandboxing, contextual output
escaping, or deployment-specific abuse testing.
