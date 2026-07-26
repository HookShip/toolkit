# Release policy

This document is owned by this repository and describes how the public
`@webhook-portal/*` cohort is versioned, verified, and published. It is the
process counterpart to the machine-enforced rules in
[`release/manifest.json`](../release/manifest.json) and
[`scripts/release.mjs`](../scripts/release.mjs).

The release tool is a thin executable facade over focused, independently tested
modules: `release-manifest.mjs` (manifest/ownership consistency),
`release-versioning.mjs` (the coordinated version and prepare/stage/open-next
lifecycle), `release-artifacts.mjs` (tarball/SBOM/provenance generation),
`release-publish.mjs` (topological publish planning and execution),
`release-git.mjs` (git/tag preflight), and `release-context.mjs` (shared
constants and primitives). Their behavior is covered by
`scripts/release.test.mjs` and `scripts/release-modules.test.mjs`.

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

`prepare` only changes the planned version and is allowed only in the
`unreleased` state; it does not mark anything released.

## Release-status lifecycle

The manifest's `releaseStatus` moves through a small, fail-closed state machine,
and the changelog carries a matching `Release status:` marker that `check`
cross-validates so the two can never drift:

- **`unreleased`** — normal development. Publishing is refused.
- **`ready`** — a validated release candidate, locked for tagging and
  publishing.

`node scripts/release.mjs stage [--dry-run]` (alias `ready`) transitions
`unreleased -> ready`. It refuses unless the tree is clean and already
consistent (it runs the full check first), then atomically flips the manifest
status and the changelog marker, with rollback on failure. After staging, a
maintainer commits and creates an **annotated (or signed)** tag `vX.Y.Z`.

`node scripts/release.mjs next <version|major|minor|patch> [--dry-run]` (alias
`open-next`) transitions `ready -> unreleased` for the next cohort and bumps the
version in the same atomic step. It never touches a tag, so a released tag stays
immutable while `main` moves on.

Both transitions fail closed on an illegal direction (for example, staging an
already-staged cohort, or opening development from a development state) and, for
a real apply, on a dirty tree. Ordinary development checks accept both states.

## Publishing

`node scripts/release.mjs publish [--execute] [--provenance] [--tag <tag>] [--registry <url>]`

- **Ordered.** Packages are published in dependency order (see the
  [compatibility matrix](compatibility-matrix.md)).
- **Idempotent.** Each `name@version` already present on the registry is
  skipped, so a re-run after a partial failure is safe.
- **Fails closed.** `--execute` aborts before publishing anything unless the
  repository is in the `ready` state, the tree is clean, and an **annotated or
  signed** `--tag vX.Y.Z` that matches the cohort version and points at the
  commit being published (`HEAD`) is supplied. A dirty tree, a lightweight or
  mismatched tag, the `unreleased` state, or any package/manifest version
  mismatch all abort the run.
- **Provenance / OIDC.** Real publishing packs the verified tarballs and runs
  `npm publish --provenance`, which relies on CI OIDC (`id-token: write`). The
  npm registry provenance is the **authoritative** attestation. The SBOM,
  checksums, and `*.provenance.json` statements the release script attaches to
  the GitHub release are **supplementary and unsigned** (they declare this in
  their `attestation` block); see
  [`generated-artifacts.md`](generated-artifacts.md).
- **No install/publish code execution.** `check` fails closed if any publishable
  package declares an automatic install or publish lifecycle script
  (`preinstall`, `install`, `postinstall`, `prepare`, `prepublish`,
  `prepublishOnly`, `prepack`, `postpack`, `publish`, `postpublish`), and the
  execute path also passes `npm publish --ignore-scripts`, so neither installing
  nor publishing the cohort runs arbitrary package code.
- **No stored tokens.** The script only reads an ambient publishing context (an
  OIDC token or an already-authenticated npm user) and never reads, writes, or
  persists a token. There is no npm token in this repository.
- Without `--execute` the command is a non-mutating plan that understands both
  lifecycle states and never publishes. `--registry` targets a specific registry
  and is what the local Verdaccio harness uses.

## Automated release workflow

[`.github/workflows/release.yml`](../.github/workflows/release.yml) is
tag-driven and approval-gated:

1. A maintainer runs `pnpm release:stage`, commits, and pushes an annotated
   `vX.Y.Z` tag matching the cohort version.
2. The **verify** job runs every existing gate (`pnpm check`, `pnpm smoke`,
   `pnpm pack:smoke`, `pnpm release:dry-run`) plus a non-mutating publish plan,
   with no credentials, and (for a tag) confirms the manifest is staged
   (`releaseStatus: ready`).
3. The **release** job runs only for tags and only after the protected `release`
   environment is approved. It packs artifacts (tarballs, SBOM, checksums,
   provenance), publishes the cohort in order with provenance, then creates the
   GitHub release and attaches the assets.

After the release, a maintainer runs `pnpm release:next -- <version>` on `main`
to return to `unreleased` for the next cohort. This never mutates the released
tag.

Execution stays credential-gated: nothing publishes until the `release`
environment's approval and publishing trust are satisfied. `workflow_dispatch`
runs the gates and a publish plan only.

## Local verification

| Command                | What it proves                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:release`   | Manifest, ownership, versions, scope, lifecycle state, and changelog are consistent (unit tests + `check`).                                   |
| `pnpm release:dry-run` | Tarballs, checksums, SBOM, provenance, and `npm publish --dry-run` all succeed locally.                                                       |
| `pnpm release:prepare` | Preview or apply an atomic coordinated version bump.                                                                                          |
| `pnpm release:stage`   | Preview or apply the `unreleased -> ready` transition (add `-- --dry-run` to preview).                                                        |
| `pnpm release:next`    | Preview or apply the `ready -> unreleased` transition and next-cohort bump.                                                                   |
| `pnpm release:publish` | Non-mutating publish plan: order and per-package registry state.                                                                              |
| `pnpm check:audit`     | Deterministic prod-scoped high/critical dependency vulnerability gate (needs registry network access; runs in CI and the release verify job). |
| `pnpm test:verdaccio`  | Publishes the whole cohort to a throwaway local Verdaccio and installs, imports, and invokes it from a clean consumer, at zero spend.         |
| `pnpm pack:smoke`      | Every tarball installs together and every entry point and the CLI work.                                                                       |

`pnpm release:clean` removes local release artifacts.

## Release status

No package, tag, or release has been published yet; the manifest is `unreleased`
and the current cohort version is a release candidate. This document describes
the process that will be used once the `@webhook-portal` scope is authenticated
for publishing.
