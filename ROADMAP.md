# Roadmap

This roadmap describes the project's intended direction and current phase. It is
not a delivery commitment, and later phases have no committed dates — each phase
is gated on the previous one actually working, not on a calendar.

## Phase 1 — Validation assets (repository work complete)

The repository records the product wedge, primary users, threat/retention model,
pilot acceptance criteria, and architecture boundary used to guide
implementation. This was internal product and engineering validation; it is not
evidence of external design-partner validation.

## Phase 2 — Open foundation (implemented)

A contract-driven toolchain and a self-hostable reference implementation that
work completely without a hosted service:

- Canonical contract model, and OpenAPI/AsyncAPI parsing, validation,
  canonicalization, diffing, fixture generation, and TypeScript generation.
- Standard Webhooks-compatible signing and verification.
- A capability-driven adapter SDK, a reusable conformance harness, and the open
  generic HTTP adapter.
- The `webhook-portal` CLI.
- A single-team, self-hostable reference server (contracts, releases, endpoints,
  subscriptions, secrets, signed tests, metadata ingest, timeline, audit) with a
  Docker Compose packaging.

**Repository evidence:** `pnpm smoke`, `pnpm pack:smoke`, and
`pnpm check:compose` exercise the repeatable implementation gate. Independent
external-developer adoption evidence has not yet been collected.

## Phase 3 — Managed control plane (engineering pilot implemented)

A multi-tenant control-plane API and hosted/embeddable portal: organizations,
projects, environments, delegated consumer sessions, RBAC, and audit — built _on
top of_ the open foundation, never forking it. The repository includes the
forced-RLS PostgreSQL data layer, control API, worker, operator console,
consumer portal, metering evidence, lifecycle workflows, and a deployable
single-region pilot composition. Real IdP, KMS/HSM, object storage, provider
credentials, backups, and alert routing remain deployment-specific gates.

## Phase 4 — Runtime adapters and observability (engineering pilot implemented)

Svix and Hookdeck adapters (in addition to the open generic HTTP adapter),
normalized delivery timeline search, replay invocation, and failure
reconciliation across runtimes.

## Phase 5 — Private extension lifecycle (engineering pilot implemented)

A versioned, closed extension manifest; canonical signed bundles; permissions;
bounded declarative transform/policy runtimes; deterministic dependency locks;
conformance tooling; reproducible first-party packs; and private tenant-scoped
publication, review, trust, install/rollback, and revocation are implemented.

Arbitrary executable extensions are deliberately excluded. Public discovery,
third-party publisher onboarding, production signing operations, marketplace
economics, and public abuse/revocation operations remain external gates and
should be added only after demonstrated ecosystem demand.

## Phase 6 — Pilot hardening (engineering tooling implemented)

Retention/export/deletion workflows, optional isolated payload capture, load and
accessibility testing, backup/restore drills, incident runbooks, security
acceptance checks, and a fail-closed load/failure harness. Live full-profile
Docker/cloud results and real design-partner evidence remain external gates.

## Phase 7 — Commercial launch (external gate)

Self-serve packaging, billing/metering integration, and a supported managed
offering, built on the same open packages published from this repository.

**Current status:** commercial operations are prepared as checklists, policies,
templates, and release dry-run automation; commercial launch is not complete.
There are zero external design partners, completed external pilots, paying
customers, revenue, production customer traffic, or operated public service.
Production IdP/KMS/object/provider/payment accounts, legal terms/privacy/DPA,
on-call/support ownership, status communications, and production observability
remain external gates. See [`docs/launch/README.md`](docs/launch/README.md).

## After launch — Evidence-led expansion

Governance, deeper observability, enterprise deployment options, and additional
destinations — each added only in response to repeated demand, not spun up
speculatively.

## Current status matrix

| Capability                                                                                                  | Status                |
| ----------------------------------------------------------------------------------------------------------- | --------------------- |
| Open contract/signing/adapter/CLI/reference foundation                                                      | **Implemented**       |
| Data-only extension SDK, conformance, and first-party packs                                                 | **Implemented**       |
| Managed API, PostgreSQL worker/data layer, portal, billing, private registry, and deployment tooling        | **Engineering pilot** |
| Real production providers, operated service, independent acceptance, external pilots, and commercial launch | **External gate**     |

## What stays permanently open

The open entries in the [Packages table](README.md#packages) — the contract
toolchain, canonical model, signing, adapter SDK and conformance harness, the
generic HTTP adapter, the CLI, and the single-team reference server — are
Apache-2.0 and are not planned to move behind a paid boundary. Clearly marked
private `UNLICENSED` packages implement the managed multi-tenant engineering
pilot (control plane, hosted portal, metering, lifecycle, and administration) on
top of those open packages.

## Out of scope indefinitely

- A first-party, globally distributed webhook delivery network. Existing
  runtimes (custom workers, and later Svix/Hookdeck) remain the delivery data
  plane; this project is a control plane and customer-experience layer.
- A proprietary webhook signing/event standard. This project interoperates with
  OpenAPI, AsyncAPI, JSON Schema, and Standard Webhooks rather than inventing a
  new one.
- General-purpose, no-code workflow automation.
- Raw payload capture as a default behavior.
