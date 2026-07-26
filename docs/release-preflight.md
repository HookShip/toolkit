# Release preflight checklist

This checklist gates the **first** real publish of the coordinated
`@webhook-portal/*` cohort. It complements the machine-enforced rules in
[`release-policy.md`](release-policy.md) and
[`scripts/release.mjs`](../scripts/release.mjs). Every item is verifiable; do
not mark an item done from assumption.

The automated gates (`pnpm check`, `pnpm smoke`, `pnpm pack:smoke`,
`pnpm release:dry-run`, `pnpm test:verdaccio`) prove everything that can be
proven **offline and without registry credentials**. They cannot prove that the
publishing identity is authorized on the public npm registry. That external
prerequisite is tracked separately below and is **unverified** until a
maintainer confirms it.

## External prerequisite — UNVERIFIED, fail-closed

> Status: **UNVERIFIED.** This repository makes no claim that the
> `@webhook-portal` npm scope exists, is owned by the maintainers, or is
> configured for provenance. Publishing is expected to fail closed until the
> items below are confirmed. Do not assert ownership of the scope anywhere in
> the repository until it is verified.

The publish path already fails closed without a valid publishing context:
`scripts/release-publish.mjs` refuses to `--execute` unless an OIDC context or
an authenticated npm user is present (`hasPublishCredentials`), and
`npm publish` itself rejects an unauthorized scope. This checklist makes that
precondition explicit rather than relying on a late failure.

Confirm, before the first tag:

- [ ] The `@webhook-portal` npm scope/organization exists and is owned by the
      release identity (verify with `npm access list packages @webhook-portal`
      or the npm organization settings). If the scope is **not** owned, stop:
      publishing is blocked and the scope must be reserved first.
- [ ] The CI publishing trust is configured for **all 14** packages, using one
      of:
  - npm **trusted publishing (OIDC)** for each package name (preferred; no
    stored token), matching the `release` job's `id-token: write` in
    [`.github/workflows/release.yml`](../.github/workflows/release.yml); or
  - an `NPM_TOKEN` secret on the protected `release` environment with publish +
    provenance rights.
- [ ] npm **provenance** is enabled for the scope so `npm publish --provenance`
      is accepted (`NPM_CONFIG_PROVENANCE: "true"` is already set in the release
      job).
- [ ] A dry rehearsal has been run against a throwaway registry with
      `pnpm test:verdaccio`, and `node scripts/release.mjs publish` (no
      `--execute`) prints a 14-package plan with no unexpected "already on
      registry" entries.

If any box is unchecked, the release is **not** ready; leave the manifest in
`unreleased` and do not tag.

## Repository gates (offline, must all pass)

- [ ] `pnpm check` — format, lint, types, tests, boundaries, sizes, docs,
      secrets, release consistency, and build.
- [ ] `pnpm smoke` — in-memory end-to-end CLI/reference workflow.
- [ ] `pnpm pack:smoke` — pack, install, import, and invoke every package
      together.
- [ ] `pnpm release:dry-run` — tarballs, `SHA256SUMS`, SPDX SBOMs, provenance,
      and `npm publish --dry-run` for the whole cohort.
- [ ] `pnpm check:audit` — no unignored high/critical production dependency
      advisories (needs registry network access).
- [ ] `pnpm test:verdaccio` — publish + install the cohort against a local
      throwaway registry at zero spend.
- [ ] Working tree is clean and the cohort version is intended (see
      [`release-policy.md`](release-policy.md)).

## Staging and tagging

- [ ] `pnpm release:stage` flips the manifest to `releaseStatus: ready` and the
      changelog marker in one atomic, reversible step.
- [ ] Commit, then create an **annotated or signed** tag `vX.Y.Z` matching the
      cohort version and pointing at the built commit. The verify job and
      `publish --execute` both fail closed on a lightweight or mismatched tag.

## Publish and post-release

- [ ] The protected `release` environment approval is granted; only then does
      the publish job run.
- [ ] Ordered, idempotent publish completes; re-running after a partial failure
      is safe because already-published `name@version` pairs are skipped.
- [ ] The GitHub release attaches tarballs, `SHA256SUMS`, SBOMs, and the
      supplementary provenance statements.
- [ ] `pnpm release:next -- <version>` returns `main` to `unreleased` for the
      next cohort without touching the released tag.
