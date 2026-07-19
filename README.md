# HookShip Toolkit

HookShip Toolkit is a standalone, Apache-2.0 toolkit for building
contract-driven webhook products. It provides OpenAPI/AsyncAPI import and
validation, compatibility reports, fixtures and TypeScript generation, Standard
Webhooks-compatible signing, adapter and extension SDKs, portal components, a
CLI, and a self-hostable single-team reference server.

This repository contains only the public toolkit. It has no dependency on a
hosted service, managed control plane, private package, customer environment, or
external infrastructure beyond the optional local reference stack.

> Package names intentionally remain under `@webhook-portal/*`. The `@hookship`
> npm scope is not yet authenticated or reserved, so published package scopes
> must not be renamed yet.

## What it is

- **A control-plane toolkit, not a delivery network.** Your existing delivery
  runtime remains responsible for normal webhook delivery.
- **Contract driven.** Import OpenAPI or AsyncAPI and derive canonical
  validation, diffs, fixtures, types, and release evidence.
- **Metadata only by default.** Delivery observations use a closed, allowlisted
  metadata shape. Optional payload retention is explicit and time-bounded.
- **Standalone.** Package tests, builds, coverage, smoke tests, and release
  checks run without any private repository or hosted service.

## Packages

All 13 packages are Apache-2.0, public-package candidates, and part of the
coordinated release manifest.

| Package                                                                   | Purpose                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`@webhook-portal/canonical-model`](packages/canonical-model)             | Canonical contract and event model with deterministic JSON utilities.                            |
| [`@webhook-portal/contract-core`](packages/contract-core)                 | OpenAPI/AsyncAPI parsing, validation, normalization, diffs, fixtures, and TypeScript generation. |
| [`@webhook-portal/compatibility-report`](packages/compatibility-report)   | Deterministic compatibility decisions, remediation guidance, and integrity verification.         |
| [`@webhook-portal/signing`](packages/signing)                             | Standard Webhooks-compatible HMAC signing and verification.                                      |
| [`@webhook-portal/adapter-sdk`](packages/adapter-sdk)                     | Capability-based adapter commands, results, credentials, and metadata contracts.                 |
| [`@webhook-portal/adapter-conformance`](packages/adapter-conformance)     | Reusable adapter conformance harness.                                                            |
| [`@webhook-portal/adapter-generic-http`](packages/adapter-generic-http)   | Generic signed HTTP control and metadata adapter.                                                |
| [`@webhook-portal/extension-sdk`](packages/extension-sdk)                 | Data-only extension manifests, signed bundles, permissions, locks, transforms, and policies.     |
| [`@webhook-portal/extension-conformance`](packages/extension-conformance) | Extension validation, determinism, permissions, and malicious-corpus conformance.                |
| [`@webhook-portal/migration-assessment`](packages/migration-assessment)   | Credential-free migration inventory and target-readiness assessment.                             |
| [`@webhook-portal/support-evidence`](packages/support-evidence)           | Metadata-only support evidence bundles with optional signatures.                                 |
| [`@webhook-portal/portal-components`](packages/portal-components)         | Accessible, server-first React components for webhook portals.                                   |
| [`@webhook-portal/cli`](packages/cli)                                     | CLI plus the importable single-team reference-server implementation.                             |

[`apps/reference-server`](apps/reference-server) is a private packaging wrapper
around `@webhook-portal/cli/reference-server`. It is Apache-2.0 but is not an
npm release package.

No package has been published yet. Source versions are `0.1.0` release
candidates, not evidence of an existing registry release.

## Requirements

- Node.js 22 or newer
- Corepack
- Gitleaks 8.30.1 or newer for the full repository check
- Docker with Compose only for the optional reference infrastructure

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs formatting, linting, type checking, deterministic tests,
workspace boundary checks, secret hygiene, release-manifest checks, and the
build.

Additional validation:

```sh
pnpm test:coverage  # all 13 packages plus the reference app wrapper
pnpm smoke          # in-memory end-to-end CLI/reference workflow
pnpm pack:smoke     # pack, inspect, install, import, and invoke all packages
pnpm check:compose  # static reference Compose and production-layout checks
pnpm release:dry-run
pnpm release:clean
```

`release:dry-run` creates local tarballs, checksums, SPDX documents, provenance,
and npm publish dry-runs. It never publishes, tags, commits, or pushes.

## CLI

Build and run from the workspace:

```sh
pnpm build
node packages/cli/dist/bin.js validate examples/contracts/orders.openapi.yaml
node packages/cli/dist/bin.js fixture \
  examples/contracts/orders.openapi.yaml \
  --event order.created \
  --version 1
```

Common installed commands:

```sh
webhook-portal validate contract.yaml
webhook-portal import contract.yaml --out contract.canonical.json
webhook-portal diff previous.yaml next.yaml
webhook-portal compatibility-report previous.yaml next.yaml --format markdown
webhook-portal migration-assess inventory.json contract.yaml
webhook-portal support-evidence timeline.json --case-id case_opaque_001
webhook-portal fixture contract.yaml --event order.created --version 1
webhook-portal types contract.yaml --event order.created --version 1
webhook-portal sign body.json --secret-file .webhook-secret
webhook-portal verify body.json --headers headers.json --secret-file .webhook-secret
webhook-portal serve
webhook-portal migrate
```

See [`packages/cli/README.md`](packages/cli/README.md) for the full command
reference.

## Reference server

The reference server implements contracts, releases, endpoints, subscriptions,
one-time-reveal secrets, signed tests, metadata ingest, timeline, and audit for
a single team.

The default smoke test needs no external services:

```sh
pnpm smoke
```

The optional local stack uses PostgreSQL, MinIO, generated credentials, and
locally generated TLS:

```sh
./infra/setup.sh
docker compose --env-file infra/.env -f infra/docker-compose.yml \
  up -d --build app
curl --fail --cacert infra/certs/ca.crt \
  https://127.0.0.1:3210/health/ready
```

PostgreSQL and MinIO publish no host ports. The application binds to loopback,
waits for the one-shot migration service, and uses a separate egress network for
explicit destination calls. See [`infra/README.md`](infra/README.md).

## Security model

- API authentication is required even on loopback.
- Non-loopback listeners require TLS.
- Signing secrets are one-time reveal and support bounded rotation overlap.
- Contract parsing is size-, depth-, reference-, and work-bounded and performs
  no network fetches.
- Destination safety rejects loopback, private, link-local, and metadata-service
  targets unless local-network testing is explicitly enabled.
- Generated local credentials are mode `0600` and ignored by Git.
- Extension execution is limited to closed declarative transforms and policies;
  there is no JavaScript, Wasm, module-loader, network, clock, or random-source
  entry point.

This is an implementation description, not a certification or production
security assessment. Report vulnerabilities through the process in
[`SECURITY.md`](SECURITY.md).

## Coverage and release inventory

Coverage includes every workspace with a Vitest suite. Per-workspace and
aggregate regression floors are documented in
[`docs/coverage.md`](docs/coverage.md).

[`release/manifest.json`](release/manifest.json) lists exactly the 13 public
packages. [`scripts/release.mjs`](scripts/release.mjs) rejects missing, extra,
private, non-Apache, or incorrectly scoped package entries and separately
verifies that the reference app remains a private Apache-2.0 wrapper.

## Repository layout

```text
packages/    13 public Apache-2.0 packages
apps/        private Apache-2.0 reference-server packaging wrapper
infra/       optional local reference Compose stack and migrations
examples/    public contracts, metadata, learning inputs, and demo scripts
extensions/  public data-only first-party extension source packs
docs/        architecture decisions and measured coverage
scripts/     repository, smoke, packaging, release, and hygiene checks
release/     coordinated public package manifest
```

## Project documents

- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`ROADMAP.md`](ROADMAP.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`GOVERNANCE.md`](GOVERNANCE.md)
- [`SUPPORT.md`](SUPPORT.md)
- [`SECURITY.md`](SECURITY.md)
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- [`docs/architecture/README.md`](docs/architecture/README.md)

Licensed under [Apache-2.0](LICENSE).
