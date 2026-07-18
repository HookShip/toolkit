# `@webhook-portal/support-evidence`

Privacy-safe, metadata-only evidence bundles for webhook support cases. The
package creates deterministic snapshots, SHA-256 digests, optional Ed25519
signatures, and neutral JSON or Markdown summaries.

## Security model

The sanitizer is a closed allowlist. It accepts only:

- an opaque support case ID;
- explicit opaque or SHA-256 tenant, environment, and project identifiers;
- an operator-selected UTC time range and neutral purpose category;
- event and attempt occurrence/ingestion timestamps;
- event type/version, provider event/attempt references, endpoint ID, status,
  response code, latency, retry category, and bounded trace/correlation IDs;
- contract/version/SHA-256 references; and
- source SHA-256 checksums and exact record counts.

Payloads, bodies, arbitrary headers, URLs, query strings, authorization,
cookies, credentials, secrets, payment data, PII fields, binary values,
accessors, custom prototypes, prototype-pollution keys, and unknown keys are
rejected. Rejected values are never copied into errors or output.

Opaque identifiers are still visible metadata. Do not encode personal data or
secrets in them; use the explicit hashed tenant identifier form when possible.

## Install

```sh
npm install @webhook-portal/support-evidence
```

Node.js 22 or newer is required.

## Create a bundle

```ts
import { createEvidenceBundle } from "@webhook-portal/support-evidence/bundle";

const bundle = createEvidenceBundle({
  supportCaseId: "case_01",
  tenantScope: {
    tenantId: {
      kind: "hashed",
      algorithm: "sha256",
      value: "1".repeat(64),
    },
    environmentId: { kind: "opaque", value: "env_production" },
  },
  selection: {
    from: "2026-07-18T10:00:00.000Z",
    to: "2026-07-18T10:05:00.000Z",
    purpose: "case-review",
  },
  records: [
    {
      recordType: "attempt",
      sourceId: "provider_export_01",
      occurredAt: "2026-07-18T10:01:01.000Z",
      ingestedAt: "2026-07-18T10:01:01.200Z",
      eventType: "invoice.created",
      eventVersion: "2026-01",
      providerEventRef: "evt_01",
      providerAttemptRef: "attempt_01",
      endpointId: "endpoint_01",
      status: "delivered",
      responseCode: 202,
      latencyMs: 185,
      retryCategory: "none",
      correlationId: "corr_01",
    },
  ],
  contractReferences: [
    {
      contractId: "billing_events",
      version: "2026-01",
      checksum: { algorithm: "sha256", value: "2".repeat(64) },
    },
  ],
  sources: [
    {
      sourceId: "provider_export_01",
      checksum: { algorithm: "sha256", value: "3".repeat(64) },
      recordCount: 1,
    },
  ],
  createdAt: "2026-07-18T10:06:00.000Z",
  expiresAt: "2026-07-25T10:06:00.000Z",
});
```

Timestamps must be canonical UTC strings with milliseconds. Records are sorted
deterministically, source counts must match, occurrences must fall inside the
selection, and the deeply frozen snapshot records its active limits and
redaction policy version.

Defaults are 1,000 records, 1 MiB canonical snapshot size, a 31-day selection,
and a 30-day bundle lifetime. Callers can lower or raise limits only within the
exported hard ceilings.

## Sign and verify

```ts
import { generateKeyPairSync } from "node:crypto";
import {
  signEvidenceBundle,
  verifyEvidenceBundle,
} from "@webhook-portal/support-evidence/signatures";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signed = signEvidenceBundle(bundle, {
  keyId: "support-key-2026-07",
  privateKey,
  signedAt: "2026-07-18T10:07:00.000Z",
});

const result = verifyEvidenceBundle(signed, {
  requireSignature: true,
  now: "2026-07-19T10:00:00.000Z",
  keys: [
    {
      keyId: "support-key-2026-07",
      publicKey,
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
    },
  ],
});
```

Only the Ed25519 algorithm, key ID, signing timestamp, and signature value are
serialized. The private `KeyObject` is never added to the bundle or an error.
Trust policies support multiple rotation keys, validity windows, revocation,
historical-signature policy, required signatures, and bounded clock skew.

Verification separately reports:

- `integrity`: `valid`, `tampered`, or `malformed`;
- `expiry`: `valid`, `expired`, `not-yet-created`, or `unknown`; and
- `signature`: `valid`, `unsigned`, trust/key-policy states, or `invalid`.

A digest detects changes but does not authenticate an unsigned bundle. Require a
trusted signature when authenticity is needed.

## Render summaries

```ts
import {
  renderEvidenceJson,
  renderEvidenceMarkdown,
} from "@webhook-portal/support-evidence/renderers";

const json = renderEvidenceJson(signed);
const markdown = renderEvidenceMarkdown(signed);
```

Both renderers validate integrity, use stable code-unit ordering, avoid locale
formatting, and include the selected evidence plus explicit limitations. The
Markdown renderer escapes active Markdown and HTML syntax. Summaries report
metadata; they do not determine causation, responsibility, correctness, or
outcome.

## Resolution duration

```ts
import { computeResolutionDuration } from "@webhook-portal/support-evidence/metrics";

const metric = computeResolutionDuration({
  openedAt: "2026-07-18T10:00:00.000Z",
  resolvedAt: "2026-07-18T10:03:30.000Z",
});
```

This helper performs only timestamp subtraction on the supplied case timestamps.
It does not infer resolution from timeline status or make a service quality
claim.

## Examples and exports

`@webhook-portal/support-evidence/examples` exports a deterministic,
non-sensitive example input and `createExampleEvidenceBundle()`.

The package also exposes `./bundle`, `./canonical`, `./errors`, `./metrics`,
`./renderers`, `./sanitizer`, `./signatures`, and `./types`.

## License

Apache-2.0
