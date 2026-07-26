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
  release, and CI validation for all 14 public packages.
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
- Documentation package-count gate in `scripts/check-docs.mjs`: prose
  cohort-size claims and the README package table are checked against the
  enforced `publicPackageCount`, so a docs edit cannot drift from the manifest.
- Deterministic production dependency vulnerability gate
  (`scripts/check-vulnerabilities.mjs`, `pnpm check:audit`) that fails closed on
  any high/critical production advisory not covered by a reviewed, time-bounded
  exception in `scripts/vulnerability-allowlist.json`. Wired into the CI
  `dependency-audit` job and the release verify job.

### Changed

- Generated SPDX SBOMs now record each dependency's exact installed version and
  declared license (resolved from the frozen install tree) plus a `purl`
  identity, instead of the declared semver range.
- Generated `*.provenance.json` statements now mark themselves supplementary and
  unsigned and name npm registry OIDC provenance as authoritative, and populate
  a real GitHub Actions builder id and invocation id when run in CI.
- Extracted the public toolkit from assumptions about absent private
  applications, packages, infrastructure, and operational documents.
- Coordinated all 14 public packages in one release manifest while retaining
  their existing `@webhook-portal/*` names.
- Documented that this repository is the sole publisher of the cohort; other
  repositories consume the published packages rather than re-publishing them.
  Migrating a downstream consumer is a separate, dependent workstream.

### Security

- Pinned four transitive production dependencies to patched versions via
  narrowly scoped `overrides` in `pnpm-workspace.yaml`, clearing the
  corresponding high-severity Dependabot advisories without changing any
  published package's declared ranges:
  - `find-my-way` `<=9.6.0` -> `9.7.0` (GHSA-c96f-x56v-gq3h, HTTP/2 DDoS);
  - `fast-uri` `3.x <=3.1.3` -> `3.1.4` and `4.x <4.1.1` -> `4.1.1`
    (GHSA-v2hh-gcrm-f6hx, ReDoS);
  - `fast-xml-parser` `>=5.9.3 <5.10.1` -> `5.10.1` (GHSA-8r6m-32jq-jx6q,
    entity-expansion limit reset).
  - `brace-expansion` `5.x <=5.0.7` -> `5.0.8` (GHSA-mh99-v99m-4gvg, ReDoS); a
    development-only toolchain dependency (reached solely through
    eslint/typescript-eslint), pinned so the whole tree carries no known
    high/critical advisory while the enforced gate stays production-scoped.
