# Webhook Portal

**Ship a Stripe-quality webhook experience from one declarative contract —
without migrating the delivery stack you already run.**

Webhook Portal is a vendor-neutral, **contract-driven** foundation for webhook
products: import an OpenAPI/AsyncAPI contract and get canonical validation,
compatibility checks, fixture and TypeScript generation, Standard
Webhooks-compatible signing, capability-based adapter primitives, a scriptable
CLI, and a secure, self-hostable single-team reference server — all Apache-2.0,
all usable without any hosted service.

This repository contains the complete **open foundation** described below plus a
private, `UNLICENSED` managed single-region pilot implementation. The managed
code is a deployable engineering pilot, not an operated hosted service, SLA, or
support commitment. See [Status and limitations](#status-and-limitations).

## What this is (and deliberately isn't)

- **A control plane and customer-experience layer, not a delivery network.** The
  generic HTTP adapter (`@webhook-portal/adapter-generic-http`) and the
  reference server can _invoke_ endpoint, test, and replay operations, but your
  own runtime — custom workers, Svix, or Hookdeck/Outpost — remains the
  production delivery path. This product is never in the normal delivery hot
  path.
- **Metadata-only by default.** Raw webhook payload bodies are never collected
  unless an operator explicitly enables scoped, TTL'd payload retention. See
  [Metadata-only by default](#metadata-only-by-default).
- **Contract-derived, not hand-maintained.** Documentation, fixtures, typed
  clients, and compatibility checks are generated from an imported OpenAPI or
  AsyncAPI contract, not written by hand and left to drift.
- **Open foundation, explicit commercial boundary.** The Apache-2.0 foundation
  works standalone. Private `UNLICENSED` managed packages and apps may depend on
  open packages, never the reverse.

## Packages

| Package                                                                   | What it does                                                                                                                           | Publishable      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| [`@webhook-portal/canonical-model`](packages/canonical-model)             | Canonical contract/event data model, type guards, deterministic ordering and JSON helpers. Zero I/O.                                   | Yes              |
| [`@webhook-portal/contract-core`](packages/contract-core)                 | Parses, validates, canonicalizes, checksums, and diffs OpenAPI/AsyncAPI contracts; generates fixtures and TypeScript types.            | Yes              |
| [`@webhook-portal/signing`](packages/signing)                             | Standard Webhooks-compatible HMAC-SHA256 signing and verification.                                                                     | Yes              |
| [`@webhook-portal/adapter-sdk`](packages/adapter-sdk)                     | Capability-driven adapter interfaces: commands, envelopes, scoped credentials, deadlines, canonical metadata types.                    | Yes              |
| [`@webhook-portal/adapter-conformance`](packages/adapter-conformance)     | Reusable conformance harness so any adapter (first- or third-party) can prove it satisfies the SDK contract.                           | Yes              |
| [`@webhook-portal/adapter-generic-http`](packages/adapter-generic-http)   | The open reference adapter: signed HTTP control commands plus authenticated metadata push/poll.                                        | Yes              |
| [`@webhook-portal/extension-sdk`](packages/extension-sdk)                 | Data-only extension manifests, canonical bundles, Ed25519 trust, permissions, bounded transform/policy runtimes, and dependency locks. | Yes              |
| [`@webhook-portal/extension-conformance`](packages/extension-conformance) | Framework-neutral conformance runner for manifests, bundles, permissions, deterministic execution, and a closed malicious corpus.      | Yes              |
| [`@webhook-portal/portal-components`](packages/portal-components)         | Accessible, server-first headless React components for producer and consumer portals.                                                  | Yes              |
| [`@webhook-portal/cli`](packages/cli)                                     | The `webhook-portal` command line tool, and the importable open single-team reference server (`@webhook-portal/cli/reference-server`). | Yes              |
| [`@webhook-portal/reference-server`](apps/reference-server)               | Deployable process wrapper (Docker image, migrations, TLS) around the open reference server.                                           | No — private app |
| [`@webhook-portal/db`](packages/db)                                       | Private PostgreSQL migrations/repositories with forced RLS, audit chains, jobs, retention, exports, and deletion state.                | No — commercial  |
| [`@webhook-portal/tenancy`](packages/tenancy)                             | Private tenant context, deny-by-default RBAC, support-case, and role-grant policy core.                                                | No — commercial  |
| [`@webhook-portal/kms`](packages/kms)                                     | Private provider-neutral envelope encryption, AAD binding, rotation, one-time reveal, and redaction core.                              | No — commercial  |
| [`@webhook-portal/metering`](packages/metering)                           | Private usage evidence, reconciliation, and plan-decision core.                                                                        | No — commercial  |
| [`@webhook-portal/billing`](packages/billing)                             | Private provider-neutral billing/entitlement lifecycle boundary; no payment provider or validated pricing.                             | No — commercial  |
| [`@webhook-portal/adapter-svix`](packages/adapter-svix)                   | Private scoped Svix adapter with durable idempotency, reconciliation, and metadata mapping.                                            | No — commercial  |
| [`@webhook-portal/adapter-hookdeck`](packages/adapter-hookdeck)           | Private scoped Hookdeck/Outpost/Event Gateway adapter with closed mappings and reconciliation.                                         | No — commercial  |
| [`@webhook-portal/extension-registry`](packages/extension-registry)       | Private tenant-scoped signed-bundle publication, review, trust, channels, installation locks, rollout/rollback, and revocation.        | No — commercial  |
| [`@webhook-portal/control-plane-api`](apps/control-plane-api)             | Private multi-tenant Fastify control plane with OIDC, portal sessions, governance, health, and Prometheus metrics.                     | No — commercial  |
| [`@webhook-portal/worker`](apps/worker)                                   | Private durable PostgreSQL worker for adapters, metadata, governance, audit/outbox, health, and safe telemetry.                        | No — commercial  |
| [`@webhook-portal/portal-web`](apps/portal-web)                           | Private Next.js operator console and hosted/embeddable delegated consumer portal.                                                      | No — commercial  |

Dependencies follow one direction: managed apps → commercial/open packages,
commercial packages → commercial/open packages, and open apps/packages → open
packages only. No package may depend on an app, and open code can never import
commercial code. `pnpm check:boundaries` tests and enforces the exact matrix in
CI (see
[`scripts/check-package-boundaries.mjs`](scripts/check-package-boundaries.mjs)).
For the system diagrams, trust boundaries, flows, and deployment shapes, read
the [architecture overview](docs/architecture/overview.md) and
[ADRs](docs/architecture/README.md).

None of these packages have been published to a public registry yet. Their
`package.json` files are publish-ready (`publishConfig`, `engines`,
`sideEffects`, `exports`, `types`, `files`); until a release is tagged, use them
from source inside this workspace as shown below.

The initial coordinated release manifest contains nine packages.
`@webhook-portal/portal-components` remains open and publishable but is deferred
from that cohort until its separate React compatibility and accessibility
release evidence is accepted. See
[`release/manifest.json`](release/manifest.json) and the
[release operations](docs/launch/release-and-versioning.md).

## Quickstart

Requires Node.js 22+ and [Corepack](https://nodejs.org/api/corepack.html)
(bundles the pinned `pnpm` version).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
```

`pnpm check` runs formatting, lint, type checking, the deterministic unit test
suite, the package-boundary check, and the build, in that order — the same gate
CI runs on every pull request. Everything above is self-contained: no Docker,
network, or hosted service is required.

`pnpm test:coverage` runs every Vitest workspace, merges Node and jsdom
coverage, and enforces measured repository and per-package regression floors.
Reports are written under gitignored `coverage/`; see
[`docs/coverage.md`](docs/coverage.md) for the baseline, exclusions, and CI
artifact contract.

Try the CLI directly from the built workspace:

```sh
node packages/cli/dist/bin.js validate examples/contracts/orders.openapi.yaml
node packages/cli/dist/bin.js fixture examples/contracts/orders.openapi.yaml --event order.created --version 1
```

## Prove the foundation end-to-end (no hosted cloud, no Docker)

```sh
pnpm smoke
```

This runs the full open-foundation workflow — validate, import, publish, and
diff a contract; generate a fixture and TypeScript types; sign and verify a
Standard Webhooks payload; create an endpoint, subscription, and secret; send
and verify a signed test; ingest delivery metadata; and inspect the resulting
timeline — entirely in-process against an in-memory reference server. It proves
the open foundation works without PostgreSQL, MinIO, Docker, or any hosted
service. See [`scripts/smoke.mjs`](scripts/smoke.mjs). Live
PostgreSQL/MinIO/Docker integration is a deliberately separate path (below).

```sh
pnpm pack:smoke
```

Packs every coordinated-release package with `pnpm pack` and verifies the
tarball a real `npm install` would produce — `LICENSE`/`README.md` present, no
dev-only files leaked, and every declared `exports`/`types`/`bin` entry point
actually exists. This includes the implemented extension SDK and extension
conformance harness. It then installs all package tarballs together in a clean
project, imports every public entry point, and invokes the packed CLI through
its generated binary link. See [`scripts/pack-smoke.sh`](scripts/pack-smoke.sh).

## CLI workflows

Full command reference: [`packages/cli/README.md`](packages/cli/README.md).

```sh
webhook-portal validate contract.yaml
webhook-portal import contract.yaml --out contract.canonical.json
webhook-portal diff previous.yaml next.yaml
webhook-portal fixture contract.yaml --event order.created --version 1
webhook-portal types contract.yaml --event order.created --version 1
webhook-portal sign body.json --secret-file .webhook-secret
webhook-portal verify body.json --headers headers.json --secret-file .webhook-secret
webhook-portal publish contract.yaml --server https://127.0.0.1:3210
webhook-portal ingest metadata.json \
  --server https://127.0.0.1:3210 \
  --credential-id "$REFERENCE_INGEST_CREDENTIAL_ID" \
  --secret-env REFERENCE_INGEST_SECRET
webhook-portal timeline --server https://127.0.0.1:3210
webhook-portal serve   # run the reference server from the same binary
webhook-portal migrate # apply reference-server database migrations
```

Run `webhook-portal --help` (or any command with `--help`) for exact, current
usage; the CLI's own help output is the source of truth and is covered by tests
that fail if it drifts from the implemented command set. Ingest reads
`REFERENCE_INGEST_CREDENTIAL_ID` by default and accepts `--credential-id` as an
explicit override; source the generated `infra/.env` before running the example
above.

## Run the reference server

The reference server is a real, single-team-scoped implementation of the
control-plane API (contracts, releases, endpoints, subscriptions, secrets,
signed tests, metadata ingest, timeline, audit) — not a mock, and with a
generated, always-current `/openapi.json` and `/docs` page (see
[`apps/reference-server/README.md`](apps/reference-server/README.md#api-documentation)).
Publish/status and release-list responses are compact and bounded; full
canonical plus original release content is reserved for the explicit release
detail route. It requires Docker for the packaged Compose flow:

```sh
./infra/setup.sh
docker compose --env-file infra/.env -f infra/docker-compose.yml up -d --build app
curl --fail --cacert infra/certs/ca.crt \
  https://127.0.0.1:3210/health/ready
```

`./infra/setup.sh` generates everything the stack needs and writes it only to
your local, gitignored `infra/` directory:

- mode-0600 `infra/.env` with fresh, random PostgreSQL, MinIO, paired ingest
  credential ID/secret, master-key material, and compact payload namespace/store
  IDs whose exact pair derives the S3-safe MinIO bucket name (never committed —
  see [`.gitignore`](.gitignore));
- mode-0600 `infra/.api-token` for CLI/curl use, and `infra/.curl-auth` so
  bearer credentials never appear in process arguments;
- a local development CA plus a CA-signed, 30-day `localhost`/`app` certificate
  under `infra/certs/`.

It refuses to overwrite an existing install. Renew only the TLS certificate with
`./infra/setup.sh --renew-cert`, or rotate every credential (database, object
store, tokens, master key, CA) with `./infra/setup.sh --rotate-all` (existing
volumes may need migration or deletion afterward). Pre-release installs using
the former namespace-only payload bucket must be migrated offline or reset;
legacy bucket names fail closed. Full details, network topology, and
authenticated request examples are in [`infra/README.md`](infra/README.md).

PostgreSQL and MinIO publish no host ports and live only on an internal Compose
network; the app binds to loopback plus a separate, controlled egress network
for reaching real webhook destinations. The one-shot migration service must
complete successfully before the app starts, and `/health/ready` reports the
exact expected migration/checksum state instead of guessing.

## Local demo

```sh
./examples/demo.sh
```

Builds the production image, waits for migration-aware readiness, publishes
`examples/contracts/orders.openapi.yaml` with an idempotency key, creates an
endpoint/subscription/secret, sends a signed test, ingests a metadata sample,
and prints the resulting timeline. Ingest explicitly uses the credential ID
generated by setup, without printing credential material. The stack stays up
afterward; tear it down with `./examples/demo-cleanup.sh` (add `--volumes` to
also erase local data). See [`examples/README.md`](examples/README.md).

## Metadata-only by default

Raw webhook payload bodies, arbitrary headers, and endpoint credentials are
**never** collected by default. The reference server only ever persists
normalized delivery _metadata_ — event type/version, endpoint/adapter
references, timestamps, status, latency, and a normalized error category —
through a closed, allowlist-validated ingest schema that rejects unknown fields,
payload bodies, and anything resembling a credential. Optional payload retention
is a separate, explicit, per-environment, TTL'd, isolated setting; enabling it
is never required for the portal, docs, endpoint management, signed tests, or
the metadata timeline to work.

## Security model

- **Transport:** the reference server refuses to bind outside loopback without a
  certificate and private key, and Compose always serves HTTPS with a locally
  generated CA (see above). The API token is required even on loopback.
- **Secrets:** signing secrets are one-time-reveal only — there is no read or
  list API for secret values. Rotation supports a bounded overlap window;
  revoked or expired secrets cannot sign a new test.
- **Signing:** `@webhook-portal/signing` implements Standard Webhooks
  signing/verification with strict secret decoding (`whsec_` + standard Base64,
  24–64 raw bytes), multi-signature/multi-secret verification, and an injectable
  clock with a bounded timestamp tolerance.
- **Contract parsing:** `@webhook-portal/contract-core` bounds every import
  (input size, node count, reference count, alias/depth limits — see
  [`packages/contract-core/src/limits.ts`](packages/contract-core/src/limits.ts))
  and resolves only supported local `$ref` targets. External and relative
  references are rejected explicitly; the core performs no network or filesystem
  fetches.
- **Outbound requests:** endpoint verification, test sends, and adapter HTTP
  calls share destination-safety checks that reject loopback, RFC1918/private,
  link-local, and cloud-metadata targets unless a caller explicitly opts an
  endpoint into local-network testing (`allowLocalNetwork`), which is what the
  demo and smoke workflows use for their own self-contained test receivers.
- **Credential hygiene:** `infra/setup.sh` writes every generated secret with
  mode `0600`, never places bearer tokens in process arguments
  (`--config infra/.curl-auth` instead), and refuses unsafe renewals.
- **Vulnerability reports:** see [`SECURITY.md`](SECURITY.md) for private
  reporting instructions. Do not open a public issue for a suspected
  vulnerability.

This describes what is implemented in this repository today. It is not a
substitute for an independent security review before any production use.

## Supported standards and versions

| Standard          | Support                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| OpenAPI           | `3.1.x` top-level `webhooks` definitions                                                                      |
| AsyncAPI          | `2.6.0` and `3.0.0` messages/operations                                                                       |
| JSON Schema       | `2020-12` canonical dialect, with documented `draft-07` import compatibility                                  |
| Standard Webhooks | Signing and verification for product-generated test events                                                    |
| CloudEvents       | **Not implemented yet.** Attribute preservation/mapping is a documented future goal, not a current capability |

The product never redefines Standard Webhooks headers/signature calculation,
never claims OpenAPI/AsyncAPI compatibility beyond this matrix, and never
discards unknown source-standard extensions required for round-trip export.

## Status and limitations

| Area                                                                                                                                                                                             | Status                | What that means                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract model/core, signing, adapter SDK/conformance, generic HTTP adapter, CLI, reference server                                                                                               | **Implemented**       | Source, tests, packaging, and self-contained smoke workflows are present. No public registry release has been made.                                                                                    |
| Extension SDK, conformance harness, and first-party data-only packs                                                                                                                              | **Implemented**       | Signed bundles, trust policy, permissions, bounded declarative runtimes, dependency locks, conformance cases, and reproducible fixture packs are present. This is not arbitrary-code plugin execution. |
| Managed PostgreSQL data layer, tenancy, KMS boundary, API, worker, portal, Svix/Hookdeck adapters, metering, billing, and private extension registry                                             | **Engineering pilot** | Implemented and testable in the private single-region composition, with local/injected provider ports. It is not an operated hosted service or SLA.                                                    |
| Managed Docker images, migration/readiness checks, security probes, load/recovery harness, and operations runbooks                                                                               | **Engineering pilot** | Repository tooling can generate local evidence and exercise failure paths. Passing repository tests is not production or customer evidence.                                                            |
| Real IdP, KMS/HSM, object storage, provider/payment accounts, TLS/ingress/egress, encrypted backups/PITR, dashboards/alert routing, legal/support ownership, and independent security acceptance | **External gate**     | Deployment owners must provision, configure, operate, and verify these before real traffic. Local development providers cannot satisfy this gate.                                                      |
| Public package publication and public extension marketplace                                                                                                                                      | **External gate**     | Release dry-run and private extension lifecycle tooling exist, but no package, public marketplace, production publisher trust, or economic marketplace feature is live.                                |
| External adoption and commercial operation                                                                                                                                                       | **External gate**     | There are zero external design partners, completed external pilots, paying customers, revenue, production customer traffic, or operated public service. Launch documents are preparation, not proof.   |

The status labels are used consistently throughout the repository:
**Implemented** means a self-contained open capability exists; **Engineering
pilot** means private managed code and validation tooling exist but are not an
operated service; **External gate** means evidence or deployment-owned systems
are not supplied by this repository.

- **Docker is required** for the Compose-based reference stack, the local demo,
  and the live PostgreSQL/MinIO integration profile. It is not required for
  `pnpm check` or `pnpm smoke`.
- **`webhook-portal types` intentionally exits partial (`4`)** for schema
  constructs it can approximate but not represent exactly in TypeScript; this is
  documented CLI behavior, not a bug.
- Packages are pre-1.0 (`0.1.x`); interfaces may still change before a first
  tagged release. See [`CHANGELOG.md`](CHANGELOG.md).

## Repository layout

```
packages/   Open foundation plus clearly marked private commercial packages
apps/       Open reference server plus private managed API, worker, and portal
infra/      Reference and managed Compose, images, migrations, and probes
examples/   Contracts, metadata, reference demo, and managed pilot sample
docs/       Architecture overview/ADRs, pilot operations, launch gates, and runbooks
scripts/    Repo-wide policy, smoke, package, and security verification tooling
```

## Contributing and community

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development workflow and checks
- [`SUPPORT.md`](SUPPORT.md) — usage questions, bug reports, and support scope
- [`GOVERNANCE.md`](GOVERNANCE.md) — how decisions get made today
- [`ROADMAP.md`](ROADMAP.md) — phased plan and what comes after this foundation
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — community expectations
- [`SECURITY.md`](SECURITY.md) — private vulnerability reporting
- [`docs/operations/README.md`](docs/operations/README.md) — managed pilot
  operations, recovery, SLOs, security acceptance, and support handoff
- [`docs/architecture/overview.md`](docs/architecture/overview.md) — layers,
  planes, dependency direction, data flows, trust boundaries, and deployments
- [`docs/architecture/README.md`](docs/architecture/README.md) — accepted
  architecture decision records
- [`docs/launch/README.md`](docs/launch/README.md) — honest commercial launch
  gates, release operations, metrics, acquisition, extension, and support policy
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes over time

Licensed under [Apache-2.0](LICENSE).
