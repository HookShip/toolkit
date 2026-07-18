# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project intends to adhere to [Semantic Versioning](https://semver.org/)
once a first version is tagged and published.

No version has been tagged or published yet. Every publishable package is
pre-1.0 (`0.1.x`); public APIs may still change before a `1.0.0` release.

## [Unreleased]

Planned package cohort: `0.1.0`. This is release preparation only; no package,
image, tag, or release has been published.

### Added

- Canonical webhook contract model (`@webhook-portal/canonical-model`).
- Contract parsing, validation, canonicalization, checksumming, diff/
  compatibility analysis, fixture generation, and TypeScript generation for
  OpenAPI `3.1.x` and AsyncAPI `2.6.0`/`3.0.0`
  (`@webhook-portal/contract-core`).
- Standard Webhooks-compatible signing and verification
  (`@webhook-portal/signing`).
- A capability-driven adapter SDK and reusable conformance harness
  (`@webhook-portal/adapter-sdk`, `@webhook-portal/adapter-conformance`).
- The open generic HTTP control-and-metadata adapter
  (`@webhook-portal/adapter-generic-http`).
- The `webhook-portal` CLI: `validate`, `import`, `publish`, `publish-status`,
  `diff`, `fixture`, `types`, `sign`, `verify`, `send-test`, `serve`, `migrate`,
  `ingest`, and `timeline` (`@webhook-portal/cli`).
- A single-team, self-hostable reference server (contracts and releases,
  endpoints and subscriptions, one-time-reveal secrets with rotation, signed
  test events, metadata ingest, timeline, and audit), importable as
  `@webhook-portal/cli/reference-server` and packaged as a Docker Compose stack
  with generated TLS and credentials (`apps/reference-server`, `infra/`).
- An end-to-end open-foundation smoke workflow (`pnpm smoke`) that proves the
  above without PostgreSQL, MinIO, Docker, or any hosted service.
- A clean-package smoke check (`pnpm pack:smoke`) that packs every publishable
  package, verifies its declared entry points and contents, installs all package
  tarballs together in a clean project, imports every public entry point, and
  invokes the packed CLI.
- Bounded publish/status release metadata, paginated release listings, and an
  explicit full-content release detail route, including large-contract CLI
  acknowledgement recovery.
- A dedicated Compose integration-test image stage with no-daemon context and
  production-layout validation.
- Cross-platform atomic CLI output that preserves POSIX durability errors while
  tolerating unsupported Windows directory fsync operations after rename.
- Community and governance documentation: `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `GOVERNANCE.md`, `ROADMAP.md`.
- Commercial launch-readiness operations covering release/version consistency,
  dry-run publication, checksums, SPDX SBOMs, provenance, launch gates,
  privacy-safe metrics, packaging/pricing experiments, acquisition, extension
  distribution, sourced comparisons, support, and communications.

### Fixed

- Closed the reference payload bucket first-boot ownership race by deriving the
  canonical S3 bucket name from both compact installation namespace and physical
  store IDs, with fail-closed runtime, migration, marker, and database checks.
