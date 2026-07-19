# ADR-0001: Standalone public toolkit workspace boundary

## Status

Accepted

## Context

The extracted toolkit must build, test, package, and release without depending
on unavailable applications, packages, repositories, or operational
infrastructure. A documented inventory alone is too easy to drift: a new
workspace or dependency can silently introduce an unavailable or non-publishable
component.

## Decision

The workspace contains exactly 13 `public-package` entries under `packages/` and
one `private-app` packaging wrapper at `apps/reference-server`.

The authoritative inventories are enforced by
[`scripts/check-package-boundaries.mjs`](../../scripts/check-package-boundaries.mjs),
[`scripts/check-package-boundaries.test.mjs`](../../scripts/check-package-boundaries.test.mjs),
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), and
[`release/manifest.json`](../../release/manifest.json).

Public packages:

- `adapter-conformance`
- `adapter-generic-http`
- `adapter-sdk`
- `canonical-model`
- `cli`
- `compatibility-report`
- `contract-core`
- `extension-conformance`
- `extension-sdk`
- `migration-assessment`
- `portal-components`
- `signing`
- `support-evidence`

Every public package must be Apache-2.0, non-private, and configured for public
npm access. The reference app must remain private, Apache-2.0, and depend at
runtime only on `@webhook-portal/cli`.

The allowed dependency direction is:

- public package → public package;
- private app wrapper → public package.

No package may depend on an app. Unknown `@webhook-portal/*` workspace
dependencies and imports fail the boundary check. `extension-sdk` has an
additional minimal allowlist: `adapter-sdk`, `canonical-model`, and `signing`.
Runtime workspaces may not import the data assets under `extensions/` or
`examples/extensions/`.

Package names remain under `@webhook-portal/*` until a future npm-scope
migration is separately approved.

## Consequences

- A new package must be deliberately added to the workspace, boundary inventory,
  tests, coverage inventory, and release manifest.
- The reference server remains deployable without becoming an accidentally
  published npm package.
- The toolkit cannot silently regain dependencies on absent private code.
- The strict inventory requires coordinated metadata changes when packages are
  added, removed, or renamed.
