# Roadmap

HookShip Toolkit is an early-stage standalone open-source project. This roadmap
describes direction, not delivery dates or service commitments.

## Current: standalone public toolkit

Implemented in this repository:

- 13 Apache-2.0 packages for contracts, compatibility, signing, adapters,
  declarative extensions, migration assessment, support evidence, portal
  components, and the CLI.
- A private Apache-2.0 packaging wrapper for the single-team reference server.
- In-memory smoke coverage and an optional PostgreSQL/MinIO Compose stack.
- Workspace boundaries, secret hygiene, measured coverage floors, package
  tarball installation checks, and release dry-run artifacts.
- Public examples and reproducible data-only extension packs.

No package has been published yet. The current release manifest is preparation
for a coordinated `0.1.0` release.

## Next: first public package release

- Keep all 13 package manifests, exports, types, licenses, and tarballs
  independently installable.
- Review API consistency and changelog entries across the coordinated cohort.
- Run the complete CI, coverage, smoke, pack-smoke, and release dry-run gates
  from a clean checkout.
- Publish only after the existing `@webhook-portal` npm scope is authenticated
  for the release process.

Renaming packages to `@hookship/*` is explicitly deferred until that npm scope
is reserved and authenticated. A scope migration would require a separate
compatibility and deprecation plan.

## Later: interoperability and contributor evidence

- Add standards or versions only with fixtures, conformance tests, and explicit
  normalization behavior.
- Expand adapter examples without adding provider-specific assumptions to the
  SDK.
- Improve portal-component accessibility and framework integration evidence.
- Add extension packs only when they remain data-only, deterministic, and
  locally reviewable.
- Raise coverage floors when measured behavior improves.

## Out of scope for this repository

- An operated hosted service or support SLA.
- A globally distributed webhook delivery network.
- Billing, metering, tenancy, or a multi-tenant control plane.
- Provider credentials or production infrastructure.
- A public extension marketplace or arbitrary executable plugins.
- Claims about customers, certifications, compliance, availability, or
  production readiness.
