# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
project intends to use [Semantic Versioning](https://semver.org/) once the first
package versions are published.

No package has been tagged or published yet.

## [Unreleased]

Planned package cohort: `0.1.0`. This is release preparation only; no package,
tag, or release has been published.

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
- The `webhook-portal` CLI and importable single-team reference server.
- Private Apache-2.0 reference-server process wrapper and optional local
  PostgreSQL/MinIO/TLS Compose stack.
- Standalone workspace, boundary, secret-hygiene, coverage, smoke, package,
  release, and CI validation for all 13 public packages.

### Changed

- Extracted the public toolkit from assumptions about absent private
  applications, packages, infrastructure, and operational documents.
- Coordinated all 13 public packages in one release manifest while retaining
  their existing `@webhook-portal/*` names.
