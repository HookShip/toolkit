# Canonical webhook metadata envelope

This transform maps selected Standard Webhooks-style and CloudEvents-style
metadata into one CloudEvents-shaped canonical envelope using only the bounded
extension DSL. It does not parse signatures, invoke code, read the environment,
or perform I/O.

The mapping preserves both source identifiers and version fields:

- canonical `id` prefers the CloudEvents ID and retains both source IDs under
  `extensions`;
- CloudEvents `specversion`, Standard Webhooks version, and event contract
  version remain distinct, including CloudEvents extension versions;
- source, type, subject, time, and data content type are selected from explicit
  metadata paths.

The first operation selects an allowlist. Unknown fields and the input `payload`
branch are therefore excluded by default.

## Permission rationale

Read permission is limited to the 17 declared metadata candidates. There is no
read scope for `/payload` or any descendant.

The transform requests `payloadWrite: ["*"]` because the SDK's safe `select`
operation replaces the local output document. That wildcard is required for
document reconstruction; it grants no network, secret, endpoint, or host-side
storage authority. Narrow destination writes would be redundant once `*` is
present.

## Compatibility

- Manifest: `1.0`
- Transform DSL: `1.0`
- Platform: `^0.1.0`
- Extension SDK: `^0.1.0`
- Runtime dependencies: none

## Fixtures and conformance

The fixture includes a sentinel payload and competing CloudEvents/Standard
Webhooks IDs and versions. Expected output proves payload exclusion and value
preservation. `conformance.json` declares the common suite plus leakage,
minimal-permission, tamper, and deterministic-output checks.

Development signatures use a public test key and are not production trust.
