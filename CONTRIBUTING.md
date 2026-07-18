# Contributing

Thank you for contributing. This repository combines the Apache-2.0 open
foundation with clearly marked private `UNLICENSED` managed-pilot workspaces
(see the README's "Status and limitations" section). Preserve both the
dependency direction and each workspace's licensing boundary.

## Development setup

```sh
corepack enable
pnpm install --frozen-lockfile
```

Node.js 22+ and Corepack (bundles the pinned `pnpm` version from `package.json`)
are required; `engine-strict=true` in `.npmrc` enforces this for every install.

## Testing tiers and release gates

These tiers describe test scope and prerequisites, not a runtime or service
level promise. Run the narrowest relevant tier while developing, then the
required broader gate before review or release.

| Tier                        | Command                                                                                                                                                                                                                                                                         | Prerequisites and purpose                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fast**                    | `pnpm test:required`                                                                                                                                                                                                                                                            | Node.js dependencies only. Runs hygiene, deterministic workspace tests, managed-pilot fixtures, and extension-pack fixtures.                                                                                                                                         |
| **Full**                    | `pnpm check`                                                                                                                                                                                                                                                                    | Node.js dependencies only. Runs formatting, linting, type checking, Fast tests, dependency-boundary checks, and builds; this is the normal pull-request gate.                                                                                                        |
| **Coverage (supplemental)** | `pnpm test:coverage`                                                                                                                                                                                                                                                            | Node.js dependencies only. Builds workspace dependencies, aggregates every configured Vitest workspace, and enforces checked-in aggregate plus per-package regression floors. It does not replace behavior or integration tests.                                     |
| **Live PostgreSQL**         | `pnpm test:live:managed`                                                                                                                                                                                                                                                        | Generated `infra/managed/.env`, built managed artifacts, and the managed migration/PostgreSQL stack. Runs zero-skip database and worker repository contracts.                                                                                                        |
| **Reference Docker**        | `./infra/setup.sh`, then `pnpm test:live:reference`                                                                                                                                                                                                                             | Docker plus generated reference secrets. Builds the integration image and checks live PostgreSQL migrations/repositories and MinIO object-storage contracts on internal networks.                                                                                    |
| **Managed Docker**          | Follow [`infra/managed/README.md`](infra/managed/README.md#local-development), ending with `node infra/managed/test-migration-readiness.mjs`, `node infra/managed/test-live.mjs`, `node infra/managed/test-api-worker-smoke.mjs`, and `node infra/managed/probe-operations.mjs` | Docker plus generated managed secrets. Validates role separation, forced RLS, migration drift rejection, API/worker/portal composition, provider simulation, and operational probes.                                                                                 |
| **Managed pilot**           | `pnpm test:pilot:managed:local` or `pnpm test:pilot:managed:ci`                                                                                                                                                                                                                 | Docker and the managed stack. The local profile runs reduced-scale load/recovery; the CI profile runs the full repository acceptance profile. Neither is customer or production evidence.                                                                            |
| **Release dry-run**         | `pnpm check:release && pnpm check && pnpm pack:smoke && pnpm release:dry-run`                                                                                                                                                                                                   | Clean candidate checkout. Validates release metadata, artifacts, package installation, dry-run publication, SBOM/provenance output, and private image-candidate metadata without publishing, tagging, or deploying. Clean generated files with `pnpm release:clean`. |

The control-plane suite uses two isolated file workers so per-file in-memory
harnesses can run concurrently without oversubscribing the wider Turbo test run.
Routine request logs are hidden at the default `error` level; error logs remain
visible, and `LOG_LEVEL=info` (or `debug`) restores request logging for
diagnosis.

## Before opening a pull request

1. Create a focused branch and keep changes scoped to one concern.
2. Run `pnpm check` — it runs formatting, lint, type checking, the deterministic
   unit test suite, the package-boundary check, and the build, in the same order
   CI does.
3. Run `pnpm smoke` if you touched contract parsing, signing, the adapter SDK,
   the CLI, or the reference server — it exercises the full validate → publish →
   sign/verify → ingest → timeline workflow in-process.
4. If you touched a publishable package's `package.json` (`exports`, `files`,
   `bin`, dependencies), run `pnpm pack:smoke` — it packs each package and
   verifies the tarball, then installs all public package tarballs together in a
   clean project and imports every public entry point.
5. If you touched `infra/` or `apps/reference-server`, also run
   `pnpm check:compose` (renders and validates the Compose stack; does not
   require a running Docker daemon).
6. Add or update tests for behavior changes, and update the relevant `README.md`
   (root, package, or `infra/`/`examples/`) so documentation never drifts from
   behavior.
7. If you touched managed security, deployment, migrations, health/metrics, or
   `docs/operations/`, run `pnpm check:operations`.
8. Preserve the open-core dependency boundary enforced by
   `pnpm check:boundaries`: packages under `packages/` must never import an app,
   and packages listed as open in the README must never import commercial code.
9. If you touch release metadata, package versions, changelog entries, launch
   policy, or artifact contents, run `pnpm check:release`, `pnpm pack:smoke`,
   and `pnpm release:dry-run`, then remove ignored artifacts with
   `pnpm release:clean`. These commands never publish, tag, or deploy.

## Coverage

Run `pnpm test:coverage` after changing runtime source or tests. It exercises
every Vitest workspace, fails if a configured package discovers no tests or
emits no source coverage, and enforces measured aggregate plus per-package
floors. The merged text, JSON, and LCOV reports are written to gitignored
`coverage/` and uploaded by CI. Package-level `pnpm test:coverage` scripts use
the same configuration for focused work; the root command is the authoritative
gate. See [`docs/coverage.md`](docs/coverage.md) for scope, current baselines,
and documented exceptions.

## Repository layout

See the README's [Repository layout](README.md#repository-layout) section for
where things live (`packages/`, `apps/`, `infra/`, `examples/`, `scripts/`).

## Commit and PR conventions

- Prefer small, reviewable pull requests over large ones.
- Please add a `Signed-off-by` line to commits (`git commit --signoff`) as a
  Developer Certificate of Origin-style attestation. This is requested but not
  currently enforced by CI; see [`GOVERNANCE.md`](GOVERNANCE.md).
- Explain the "why," not only the "what," in the pull request description —
  especially for anything hard to reverse later.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Please report security issues privately as described in
[SECURITY.md](SECURITY.md) — do not open a public issue for a suspected
vulnerability. For usage questions and normal bug reports, see
[SUPPORT.md](SUPPORT.md).
