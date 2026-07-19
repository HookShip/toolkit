# ADR-0007: Declarative, signed extensions with no arbitrary code execution

## Status

Accepted

## Context

Executable third-party plugins inherit broad host capabilities and require a
sandbox, resource controls, network policy, and operational trust model.
HookShip Toolkit needs configuration- and data-shaped extensibility without
introducing an arbitrary-code execution boundary.

## Decision

`@webhook-portal/extension-sdk` has no module loader, JavaScript/Wasm entry
point, `eval`, provider-call runtime, network client, clock, or random source.

The closed manifest supports four data-only kinds:

- connector configuration and text templates;
- bounded declarative transforms;
- bounded declarative policies;
- named text assets.

Manifests and bundles bind identity, version, compatibility, dependencies,
permissions, resources, provenance, dependency metadata, digests, and Ed25519
signatures. Unknown fields are rejected at closed object boundaries. Permissions
are empty by default and scoped to declared metadata fields.

`verifyExtensionBundle` validates digests and signatures against an explicit
trust policy.
[`@webhook-portal/extension-conformance`](../../packages/extension-conformance)
tests manifest closure, permission denial, deterministic evaluation, traversal,
executable assets, prototype pollution, secret material, and signature
tampering. Public source packs under [`extensions/`](../../extensions) use a
clearly marked deterministic development key only for reproducibility tests.

Remote installation and a public marketplace are outside this repository's
scope.

## Consequences

- Arbitrary network access, host APIs, and non-deterministic plugin execution
  are excluded by construction.
- Extension authors trade general-purpose code for bounded declarative
  transforms, policies, schemas, and templates.
- Bundle verification and conformance are load-bearing security boundaries.
- Development signatures are test fixtures, never production trust or
  endorsement.
