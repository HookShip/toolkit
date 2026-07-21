# Release policy

This document is owned by this repository and describes how the public
`@webhook-portal/*` cohort is versioned, verified, and published. It is the
process counterpart to the machine-enforced rules in
[`release/manifest.json`](../release/manifest.json) and
[`scripts/release.mjs`](../scripts/release.mjs).

## Ownership

- This repository is the **sole publisher and single source of truth** for every
  `@webhook-portal/*` package, including `@webhook-portal/portal-components`.
  This is asserted by the `ownership` block in the release manifest and checked
  by `node scripts/release.mjs check` (part of `pnpm check`).
- Other repositories **consume** the published packages. They must not publish,
  re-publish, or fork-publish any `@webhook-portal/*` package. Migrating a
  downstream consumer (for example, a hosted platform) to depend on the
  published cohort is a separate, dependent workstream and is out of scope here.
- Package names stay under `@webhook-portal`. A rename to `@hookship` is
  deferred until that scope is reserved and authenticated, and would require its
  own compatibility and deprecation plan.

## Coordinated versioning

All packages share one version and are released together. The manifest is the
one place the coordinated version is recorded; `check` fails if any package
disagrees with it or if the changelog does not name it.

## Preparing a version

`node scripts/release.mjs prepare <version|major|minor|patch> [--dry-run]`
(alias `bump`) rewrites the coordinated version everywhere it appears — the
manifest, every package's own version and any pinned internal range, the
lockfile, and the changelog's planned-cohort line — as one atomic operation.

- `--dry-run` prints the plan and writes nothing.
- Applying snapshots every affected file, refreshes the lockfile offline, runs
  the full consistency check, and restores the snapshot if verification fails,
  so a failed prepare never leaves a partial tree.
- The command refuses to move the version backwards.

`prepare` only changes the planned version; it does not mark anything released.
The repository stays `unreleased` until an actual, approved release is cut.

## Publishing

`node scripts/release.mjs publish [--execute] [--provenance] [--tag <tag>] [--registry <url>]`

- **Ordered.** Packages are published in dependency order (see the
  [compatibility matrix](compatibility-matrix.md)).
- **Idempotent.** Each `name@version` already present on the registry is
  skipped, so a re-run after a partial failure is safe.
- **Fails closed.** A dirty working tree, a git tag that disagrees with the
  cohort version, or any package/manifest version mismatch aborts the run before
  anything is published.
- **Provenance / OIDC.** Real publishing packs the verified tarballs and runs
  `npm publish --provenance`, which relies on CI OIDC (`id-token: write`).
- **No stored tokens.** The script only reads an ambient publishing context (an
  OIDC token or an already-authenticated npm user) and never reads, writes, or
  persists a token. There is no npm token in this repository.
- Without `--execute` the command is a non-mutating plan. `--registry` targets a
  specific registry and is what the local Verdaccio harness uses.

## Automated release workflow

[`.github/workflows/release.yml`](../.github/workflows/release.yml) is
tag-driven and approval-gated:

1. A maintainer pushes a `vX.Y.Z` tag matching the cohort version.
2. The **verify** job runs every existing gate (`pnpm check`, `pnpm smoke`,
   `pnpm pack:smoke`, `pnpm release:dry-run`) plus a non-mutating publish plan,
   with no credentials.
3. The **release** job runs only for tags and only after the protected `release`
   environment is approved. It packs artifacts (tarballs, SBOM, checksums,
   provenance), publishes the cohort in order with provenance, then creates the
   GitHub release and attaches the assets.

Execution stays credential-gated: nothing publishes until the `release`
environment's approval and publishing trust are satisfied. `workflow_dispatch`
runs the gates and a publish plan only.

## Local verification

| Command                | What it proves                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:release`   | Manifest, ownership, versions, scope, and changelog are consistent (unit tests + `check`).                                            |
| `pnpm release:dry-run` | Tarballs, checksums, SBOM, provenance, and `npm publish --dry-run` all succeed locally.                                               |
| `pnpm release:prepare` | Preview or apply an atomic coordinated version bump.                                                                                  |
| `pnpm release:publish` | Non-mutating publish plan: order and per-package registry state.                                                                      |
| `pnpm test:verdaccio`  | Publishes the whole cohort to a throwaway local Verdaccio and installs, imports, and invokes it from a clean consumer, at zero spend. |
| `pnpm pack:smoke`      | Every tarball installs together and every entry point and the CLI work.                                                               |

`pnpm release:clean` removes local release artifacts.

## Release status

No package, tag, or release has been published yet. The current cohort version
is a release candidate. This document describes the process that will be used
once the `@webhook-portal` scope is authenticated for publishing.
