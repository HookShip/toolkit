# ADR-0008: Release ownership and automation

## Status

Accepted

## Context

The `@webhook-portal/*` packages can appear in more than one repository during
development. Without an explicit, enforced statement of who publishes them, two
repositories could claim the same package names, versions could drift, and a
consumer could not tell which repository is authoritative. The packages are also
released as one coordinated cohort with internal dependencies, so publishing
them safely requires a defined order, idempotency, and closed failure modes —
not an ad hoc `npm publish` loop.

## Decision

This repository is the sole publisher and single source of truth for every
`@webhook-portal/*` package, including `@webhook-portal/portal-components`. This
is recorded in an `ownership` block in
[`release/manifest.json`](../../release/manifest.json) and enforced by
[`scripts/release.mjs`](../../scripts/release.mjs) `check`, which asserts the
publisher, scope, coordinated (lockstep) versioning, and that no rename has
occurred, and which fails if any published package is outside the declared
scope. Other repositories consume the published packages and do not re-publish
them.

Release tooling in `scripts/release.mjs` provides:

- an atomic, reversible `prepare`/`bump` path that rewrites the coordinated
  version across the manifest, package manifests, lockfile, and changelog, with
  a dry run and automatic rollback on failed verification;
- a fail-closed release-status lifecycle (`unreleased <-> ready`): `stage` locks
  a validated candidate and `next` returns to development for the next cohort
  without touching a tag, with the manifest state and a changelog marker
  cross-validated so they cannot drift;
- an ordered, idempotent `publish` path that publishes in dependency order,
  skips already-published versions, uses `npm publish --provenance` (CI OIDC),
  never stores tokens, and fails closed unless the source is `ready` with a
  clean tree and an annotated/signed tag that matches the version and points at
  the built commit.

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) drives
releases from a `vX.Y.Z` tag behind a protected `release` environment: a verify
job runs all existing gates with no credentials, and a gated release job packs
artifacts, publishes with provenance, and attaches release assets.
[`scripts/verdaccio-harness.mjs`](../../scripts/verdaccio-harness.mjs) proves
the cohort is installable by name from a registry using a throwaway local
Verdaccio, at zero spend and with no long-running daemon.

## Consequences

- The publisher, scope, and versioning model cannot drift silently; a change to
  any of them fails `pnpm check`.
- Releasing is a defined, reproducible sequence rather than a manual loop, and a
  failed or partial release can be safely re-run.
- The tagged source records its own release-ready state: a release is staged
  before tagging, `publish --execute` refuses to run from the development state,
  and the next development cycle is reopened without mutating the released tag.
- Credentials never live in the repository; publishing depends on an approved
  environment and OIDC, so the workflow is inert until a maintainer both tags a
  release and approves it.
- Migrating downstream consumers off any local copy of these packages and onto
  the published cohort is a separate, dependent workstream and is intentionally
  not done here.
- The `@webhook-portal` scope is retained; a future `@hookship` rename remains a
  separate, deliberately deferred decision.
