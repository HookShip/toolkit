# ADR-0007: Declarative, signed extensions with no arbitrary code execution

## Status

Accepted

## Context

Letting third parties extend a webhook control plane (custom connectors, payload
transforms, routing/redaction policies) is valuable, but a plugin model built
around arbitrary executable code (a module loader, `eval`, or a Wasm/JS entry
point) inherits that code's full blast radius: it can make network calls, read
the host clock or random source, or run indefinitely, none of which a manifest
or permission scope can fully bound after the fact. The project needed
extensibility for configuration- and data-shaped customization (transforms,
policies, connector configuration, templates) without taking on an
arbitrary-code sandboxing problem the rest of the architecture is not designed
to contain.

## Decision

`@webhook-portal/extension-sdk` is built, by its own description, to
"deliberately [have] no module loader, JavaScript/Wasm entry point, `eval`,
provider-call runtime, network client, clock, or random source" (see
[`packages/extension-sdk/README.md`](../../packages/extension-sdk/README.md)).
The closed `1.0` manifest supports exactly four kinds, all data- or
bounded-program-shaped: `connector` (configuration schema plus text template
assets only), `transform` (a bounded declarative transform program), `policy` (a
bounded declarative policy program), and `template` (named text assets only).
Every manifest binds identity, publisher, semver, platform/SDK compatibility,
dependencies/conflicts, capabilities, requested permissions, resources, entry
declarations, source/build provenance, SBOM-like dependency metadata, a content
digest, a bundle digest, and Ed25519 signatures; unknown fields are rejected at
every closed object boundary. Permissions are empty by default and scoped
explicitly (metadata read/write JSON Pointer fields, per the same `README.md`
"Permissions" section). Transform and policy programs run through the SDK's own
closed parser/evaluator (`/transform`, `/policy` entry points) rather than any
general-purpose language runtime, so "executing" an extension means evaluating a
bounded declarative program, not running arbitrary code.

Trust is established by verification, not by sandboxing an untrusted runtime:
`verifyExtensionBundle` checks bundle contents against an explicit `trustPolicy`
(minimum signature count, named keys with status), and private signing keys are
documented as "inputs to signing only" that are "never placed in a manifest,
bundle, verification result, or lock." The private, tenant-scoped
`@webhook-portal/extension-registry` package builds on this: it owns "publisher
trust, immutable signed bundle versions, review and publication state, private
channels, deterministic dependency locks, installation rollout/rollback,
revocation attention states, audit evidence, PostgreSQL/RLS persistence, and an
injected object-store boundary," and states explicitly that "registry code never
executes extension assets" (see
[`packages/extension-registry/README.md`](../../packages/extension-registry/README.md)).
`@webhook-portal/extension-conformance` provides a framework-neutral harness
covering manifest validation, signature/digest verification, deny-by-default
permission checks, transform/policy determinism, and a closed malicious corpus
(traversal, executable assets, prototype pollution, secret material, signature
tampering) — the same suite used to validate the SDK's own safety properties
(see
[`packages/extension-conformance/README.md`](../../packages/extension-conformance/README.md)).

A **public** extension marketplace — third-party discovery, billing, revenue
share, ratings — is explicitly deferred: `extension-registry/README.md` states
these are "intentionally outside this private lifecycle boundary," and
[`docs/launch/extension-distribution.md`](../launch/extension-distribution.md)
records the decision that "a public registry/marketplace is deferred until
executable runtime, independent author demand, review capacity, abuse handling,
legal terms, and revocation operations are proven," with "no public listing,
certification, endorsement, revenue share, or availability claim exists today."

## Consequences

- Because there is no code-execution entry point in the SDK by construction, a
  large class of extension-supply-chain risks (arbitrary network access, timing
  side channels, non-determinism, resource exhaustion from unbounded loops) is
  architecturally excluded rather than merely policed by review.
- The tradeoff is expressiveness: an extension author cannot write arbitrary
  logic, only configure connectors/templates or compose bounded declarative
  transform/policy programs against the SDK's own DSL — use cases that need
  genuine custom code are out of scope for this extension model as designed.
- Verification (signatures, digests, permission scopes, conformance corpus) is
  the security boundary, which means the manifest/bundle format and the
  conformance harness are load-bearing: a gap in either weakens every installed
  extension, not just one.
- Private, tenant-scoped extension distribution is implemented today (signed
  publication, review, trust-key rotation, channels, deterministic install/
  upgrade/rollback locks, revocation — per
  [`apps/control-plane-api/README.md`](../../apps/control-plane-api/README.md)
  "Surface"); a public multi-tenant marketplace with economic features is a
  deliberately separate, not-yet-met future decision, not an oversight.
- This decision is specific to the extension model. It does not change the
  metadata-only default of
  [ADR-0002](adr-0002-metadata-only-payload-isolation.md) — extension
  permissions are scoped to declared metadata fields, not raw payload access.
