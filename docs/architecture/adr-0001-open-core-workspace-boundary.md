# ADR-0001: Open-core workspace boundary

## Status

Accepted

## Context

The project needed to be usable and valuable as a fully self-hostable, no
hosted-service-required toolchain (parsing and validating contracts, signing
webhooks, running a single-team reference server) while also supporting a
private, multi-tenant managed control plane built on top of it. Mixing those two
concerns in one licensing and dependency graph creates two recurring risks: a
contributor or automated tool accidentally letting proprietary, `UNLICENSED`
code leak into the Apache-2.0 surface (a licensing/compliance problem), and the
open foundation silently growing a hard dependency on commercial-only
infrastructure (a self-hostability problem). The repository needed an
enforceable, not just documented, boundary between the two.

## Decision

Every workspace under `packages/*` and `apps/*` is classified as exactly one of
four kinds: `open-package`, `cloud-package`, `open-app`, or `cloud-app`.
`packages/canonical-model`, `contract-core`, `signing`, `adapter-sdk`,
`adapter-conformance`, `adapter-generic-http`, `extension-sdk`,
`extension-conformance`, `portal-components`, and `cli` are open packages;
`apps/reference-server` is the open app. `packages/db`, `tenancy`, `kms`,
`metering`, `billing`, `adapter-svix`, `adapter-hookdeck`, and
`extension-registry` are cloud (private, `UNLICENSED`) packages;
`apps/control-plane-api`, `apps/worker`, and `apps/portal-web` are cloud apps
(see
[`scripts/check-package-boundaries.mjs`](../../scripts/check-package-boundaries.mjs),
`openPackageDirectories` / `cloudPackageDirectories` / `openAppDirectories` /
`cloudAppDirectories`).

The allowed dependency direction is one-way: an open package may depend only on
other open packages; a cloud package may depend on cloud or open packages; an
open app may depend only on open packages; a cloud app may depend on cloud or
open packages; nothing may depend on an app (`isAllowedDirection` in the same
script). `extension-sdk` is further restricted to an explicit allowlist of its
own dependencies (`@webhook-portal/adapter-sdk`, `canonical-model`, `signing`).
This matrix is not just documented — it is asserted by static analysis of every
`import`, `export ... from`, `require`, and dynamic `import()` in the source
tree, and enforced in CI as part of `pnpm check` via `pnpm check:boundaries`,
which runs `scripts/check-package-boundaries.test.mjs` plus the checker itself
against the real workspace (see [`package.json`](../../package.json) `check` and
`check:boundaries` scripts).

Each open package publishes under the repository's root
[`LICENSE`](../../LICENSE) (Apache-2.0); each cloud package/app is
`private`/`UNLICENSED` and documents this explicitly in its own `README.md`
"Licensing boundary" section (for example
[`packages/db/README.md`](../../packages/db/README.md),
[`packages/tenancy/README.md`](../../packages/tenancy/README.md)). The root
[`tsconfig.commercial.json`](../../tsconfig.commercial.json) exists as a
separate compiler entry point for the commercial side rather than folding it
into the shared open `tsconfig.base.json` composition.

## Consequences

- Contributors and tools get a machine-checked guarantee, not a convention: a
  pull request that adds a forbidden import direction fails
  `pnpm check:boundaries` in CI before it can land.
- The open foundation (`README.md` "Packages" table, `Publishable: Yes` rows)
  remains genuinely self-hostable and dependency-free of any commercial package,
  which is what makes the reference server and CLI usable without a hosted
  service at all.
- The boundary is a workspace/import-graph boundary, not a network or process
  boundary — this decision says nothing about deployment topology (see
  [ADR-0003](adr-0003-modular-monolith-control-plane-with-dedicated-worker.md)
  for that).
- New commercial functionality must be added as a new or existing
  `cloud-package`/`cloud-app` entry in the checker's allowlists before it can
  import anything; it cannot silently attach to an open package.
- This is a workspace-boundary and licensing decision about what ships in this
  repository. It does not by itself imply an operated hosted service, pricing,
  or support commitment — see [`docs/launch/README.md`](../launch/README.md) for
  what remains externally gated.
