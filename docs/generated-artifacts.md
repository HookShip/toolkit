# Generated and handwritten artifacts

This repository distinguishes **handwritten** sources, which are the source of
truth and are reviewed directly, from **generated** artifacts, which are derived
reproducibly from those sources. The rule is simple: commit the source, not the
output, and never hand-edit a generated artifact — regenerate it.

## Handwritten (source of truth)

- TypeScript and JavaScript sources under each `packages/*/src` and `scripts/`.
- Documentation (`*.md`), configuration (`tsconfig*.json`, `eslint.config.mjs`,
  `.prettierrc.json`, Compose and Dockerfiles), and the release
  [`manifest`](../release/manifest.json).
- Example inputs under `examples/` — synthetic, credential-free fixtures. See
  [`examples/README.md`](../examples/README.md).
- Extension **source** packs: each `manifest.source.json` plus its `assets/`,
  fixtures, and `conformance.json`. See
  [`extensions/README.md`](../extensions/README.md).
- Forward-only migration SQL under [`infra/migrations`](../infra/migrations).
  The DDL body, version, and checksum in each `.sql` file mirror the canonical
  `REFERENCE_SERVER_MIGRATIONS` manifest in
  [`packages/reference-server-core/src/migrations.ts`](../packages/reference-server-core/src/migrations.ts);
  `reference-migration-parity.test.ts` fails on drift.

## Generated (reproducible, derived)

| Artifact                                                             | Produced by                                  | Committed?          |
| -------------------------------------------------------------------- | -------------------------------------------- | ------------------- |
| `packages/*/dist`                                                    | `tsc` (`pnpm build`)                         | No (git-ignored)    |
| `coverage/`                                                          | Vitest V8 (`pnpm test:coverage`)             | No (git-ignored)    |
| `.release-work/` tarballs, `SHA256SUMS`, SPDX SBOMs, SLSA provenance | `pnpm release:dry-run` / `release:artifacts` | No (git-ignored)    |
| `extensions/dist/` signed bundles                                    | `extensions/scripts/build-sign.mjs`          | No (git-ignored)    |
| Coordinated version across every manifest                            | `node scripts/release.mjs prepare`           | Yes (a source edit) |
| Publish order for the cohort                                         | derived from the manifest by `release.mjs`   | No (recomputed)     |
| Contract fixtures and TypeScript types                               | the `webhook-portal` CLI at run time         | No (user output)    |

Two entries are deliberate exceptions to "not committed": the coordinated
version and the repository provenance metadata are written **into** the
handwritten manifests by the release tooling, then reviewed as an ordinary
source change. Everything else is rebuilt from source — release tooling
re-packs, re-signs, and re-derives rather than trusting a checked-in copy, which
is why those outputs are git-ignored.

## Provenance of the outputs

- Release artifacts carry their own provenance: SPDX SBOMs, `SHA256SUMS`
  checksums, and in-toto/SLSA provenance statements are generated for every
  packed tarball by
  [`scripts/release-artifacts.mjs`](../scripts/release-artifacts.mjs) (invoked
  through `release:dry-run`/`release:artifacts`). See
  [`release-policy.md`](release-policy.md).
- **SBOM contents are resolved, not merely declared.** Each dependency in a
  generated SPDX SBOM records the exact version and declared license read from
  the frozen install tree (`pnpm install --frozen-lockfile`), plus a `purl`
  package-URL identity, instead of the declared semver range. A dependency that
  cannot be resolved falls back to its declared range with a `NOASSERTION`
  license and no `purl`.
- Extension bundles are reproducible from a fixed source digest and build
  timestamp; local signatures use a development key fixture and must be
  re-signed by controlled release keys. See each pack's `PROVENANCE.md`.
- Coverage and compatibility figures are measured or derived, never asserted;
  see [`coverage.md`](coverage.md) and
  [`compatibility-matrix.md`](compatibility-matrix.md).
