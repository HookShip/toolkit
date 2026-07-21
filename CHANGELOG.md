# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
project intends to use [Semantic Versioning](https://semver.org/) once the first
package versions are published.

No package has been tagged or published yet.

## [Unreleased]

Planned package cohort: `0.1.0`. This is release preparation only; no package,
tag, or release has been published.

Release status: unreleased.

### Added

- Canonical webhook contract model and deterministic JSON utilities.
- OpenAPI/AsyncAPI parsing, validation, normalization, checksums, diffs,
  fixtures, and TypeScript generation.
- Compatibility reports, migration assessment, and metadata-only support
  evidence packages.
- Standard Webhooks-compatible signing and verification.
- Adapter SDK, adapter conformance harness, and generic HTTP adapter.
- Data-only extension SDK, conformance harness, and reproducible public source
  packs.
- Accessible server-first portal components.
- Server-safe backend capability matrix and gated backend selection review in
  `portal-components`, driven by plain serializable view models.
- `hookship-native` provider kind for read-only migration inventory import and
  assessment.
- The `webhook-portal` CLI and importable single-team reference server.
- Private Apache-2.0 reference-server process wrapper and optional local
  PostgreSQL/MinIO/TLS Compose stack.
- Standalone workspace, boundary, secret-hygiene, coverage, smoke, package,
  release, and CI validation for all 13 public packages.
- Release ownership block in `release/manifest.json` (schema 2) naming this
  repository the sole publisher and source of truth for the `@webhook-portal`
  cohort, enforced by `scripts/release.mjs check`.
- Atomic, reversible `prepare`/`bump` release path and an ordered, idempotent,
  provenance-based `publish` path that fails closed on a dirty tree, tag
  mismatch, or version mismatch and never stores tokens.
- Fail-closed release-status lifecycle (`unreleased <-> ready`) with atomic
  `stage` and `next` transitions; `publish --execute` now requires the `ready`
  state and an annotated/signed tag that matches the version and points at the
  built commit, and `check` cross-validates the manifest state against the
  changelog marker.
- Monorepo repository provenance metadata (`type`, `url`, `directory`) on every
  public package, matching the actual
  `git+https://github.com/HookShip/toolkit.git` remote, enforced exactly by
  `scripts/release.mjs check` and verified to survive packing, so npm provenance
  is valid.
- Tag-driven, approval-gated release workflow that runs all gates and, once
  approved, publishes with provenance and attaches artifacts, SBOM, checksums,
  and provenance as release assets.
- Zero-spend local Verdaccio integration harness (`pnpm test:verdaccio`) that
  publishes the cohort to a throwaway registry and installs, imports, and
  invokes it from a clean consumer.
- Release policy and compatibility matrix documentation owned by this repository
  (`docs/release-policy.md`, `docs/compatibility-matrix.md`) and ADR-0008 on
  release ownership and automation.

### Changed

- Extracted the public toolkit from assumptions about absent private
  applications, packages, infrastructure, and operational documents.
- Coordinated all 13 public packages in one release manifest while retaining
  their existing `@webhook-portal/*` names.
- Documented that this repository is the sole publisher of the cohort; other
  repositories consume the published packages rather than re-publishing them.
  Migrating a downstream consumer is a separate, dependent workstream.
