# Coverage

The repository uses Vitest's V8 provider for deterministic source coverage
across every app and package with a Vitest suite.

```sh
pnpm test:coverage
```

The root command builds workspace dependencies, runs all 22 Vitest workspaces
with their native Node or jsdom environment, validates that every project
discovers at least one test and emits instrumented source data, merges the
results, and enforces both repository and per-package floors. Each workspace
also exposes `pnpm test:coverage`; use the root command for the authoritative
repository gate because package commands intentionally replace the root
`coverage/` output with that package's report.

## Reports

All output is written beneath the gitignored `coverage/` directory:

- `summary.txt`: human-readable package and aggregate results;
- `coverage-summary.json`: machine-readable baselines, floors, counts, and
  documented exceptions;
- `coverage-final.json`: merged Istanbul coverage map with repository-relative
  paths;
- `lcov.info`: merged LCOV with package-qualified source paths;
- `packages/`: raw Vitest coverage and test-result JSON for each workspace.

CI runs the same threshold gate after `pnpm check` and uploads the complete
directory as `coverage-<run-id>` for 14 days, including partial package output
when a test or threshold fails.

## Scope and exclusions

Coverage includes TypeScript/JavaScript under each workspace's `src/` tree and
both `app/` and `src/` for the Next.js portal. It excludes tests, declarations,
generated files, configuration, build output, `.next`, `coverage`, and
`node_modules`.

No Vitest workspace is silently omitted. A new workspace must be added to
[`scripts/coverage.config.mjs`](../scripts/coverage.config.mjs), or it must have
a documented exclusion. Native `node:test` verification under `extensions/`,
`examples/managed-pilot/`, `infra/managed/pilot/`, and `scripts/` remains part
of `pnpm check`; those suites validate generated artifacts and operational
tooling rather than an instrumentable Vitest runtime.

The `@webhook-portal/reference-server` package is an explicit zero-source
exception: its two files are process and migration entry-point scaffolds around
the tested `@webhook-portal/cli` reference-server implementation. Smoke and
Compose checks execute those wrappers, but they do not currently provide V8 unit
coverage. Its zero line/statement/branch baseline is visible rather than being
hidden by stronger packages.

One `@webhook-portal/contract-core` wall-clock budget test is excluded only from
the instrumented run because V8 instrumentation invalidates its two-second
limit. The ordinary `pnpm test`/`pnpm check` gate still runs it.

## Baseline and regression floors

The measured baseline below was established on 2026-07-18 from 1,019 discovered
tests and 324 source files. Values are ordered **lines / statements / functions
/ branches**. Floors are the conservative whole-number lower bound of each
measured package baseline, so operating-system remapping noise does not create
an artificial target while a package cannot borrow coverage from another.

| Scope                                   | Measured baseline             | Enforced floor                |
| --------------------------------------- | ----------------------------- | ----------------------------- |
| Aggregate                               | 64.23 / 63.68 / 64.84 / 54.27 | 64.00 / 63.00 / 64.00 / 54.00 |
| `@webhook-portal/control-plane-api`     | 66.54 / 65.75 / 67.77 / 51.62 | 66.00 / 65.00 / 67.00 / 51.00 |
| `@webhook-portal/portal-web`            | 51.18 / 49.55 / 46.42 / 42.51 | 51.00 / 49.00 / 46.00 / 42.00 |
| `@webhook-portal/reference-server`      | 0.00 / 0.00 / 100.00 / 0.00   | 0.00 / 0.00 / 100.00 / 0.00   |
| `@webhook-portal/worker`                | 56.68 / 55.97 / 58.64 / 47.02 | 56.00 / 55.00 / 58.00 / 47.00 |
| `@webhook-portal/adapter-conformance`   | 84.94 / 85.12 / 96.36 / 76.14 | 84.00 / 85.00 / 96.00 / 76.00 |
| `@webhook-portal/adapter-generic-http`  | 81.47 / 81.44 / 93.37 / 70.13 | 81.00 / 81.00 / 93.00 / 70.00 |
| `@webhook-portal/adapter-hookdeck`      | 74.53 / 74.56 / 69.23 / 64.93 | 74.00 / 74.00 / 69.00 / 64.00 |
| `@webhook-portal/adapter-sdk`           | 82.33 / 82.19 / 87.32 / 77.76 | 82.00 / 82.00 / 87.00 / 77.00 |
| `@webhook-portal/adapter-svix`          | 82.22 / 82.22 / 83.49 / 71.59 | 82.00 / 82.00 / 83.00 / 71.00 |
| `@webhook-portal/billing`               | 62.03 / 62.07 / 64.10 / 50.38 | 62.00 / 62.00 / 64.00 / 50.00 |
| `@webhook-portal/canonical-model`       | 85.54 / 85.71 / 73.91 / 62.21 | 85.00 / 85.00 / 73.00 / 62.00 |
| `@webhook-portal/cli`                   | 55.92 / 55.83 / 59.11 / 48.15 | 55.00 / 55.00 / 59.00 / 48.00 |
| `@webhook-portal/contract-core`         | 83.78 / 82.79 / 91.64 / 73.76 | 83.00 / 82.00 / 91.00 / 73.00 |
| `@webhook-portal/db`                    | 27.66 / 27.59 / 22.17 / 18.49 | 27.00 / 27.00 / 22.00 / 18.00 |
| `@webhook-portal/extension-conformance` | 94.69 / 94.84 / 91.07 / 80.23 | 94.00 / 94.00 / 91.00 / 80.00 |
| `@webhook-portal/extension-registry`    | 64.00 / 62.94 / 64.17 / 52.45 | 64.00 / 62.00 / 64.00 / 52.00 |
| `@webhook-portal/extension-sdk`         | 79.60 / 79.79 / 91.07 / 68.91 | 79.00 / 79.00 / 91.00 / 68.00 |
| `@webhook-portal/kms`                   | 79.37 / 78.41 / 86.49 / 65.81 | 79.00 / 78.00 / 86.00 / 65.00 |
| `@webhook-portal/metering`              | 86.04 / 85.90 / 93.33 / 82.21 | 86.00 / 85.00 / 93.00 / 82.00 |
| `@webhook-portal/portal-components`     | 79.00 / 79.65 / 88.78 / 63.81 | 78.00 / 79.00 / 88.00 / 63.00 |
| `@webhook-portal/signing`               | 90.95 / 90.59 / 92.06 / 85.80 | 90.00 / 90.00 / 92.00 / 85.00 |
| `@webhook-portal/tenancy`               | 87.57 / 86.71 / 87.10 / 78.72 | 87.00 / 86.00 / 87.00 / 78.00 |

When coverage intentionally improves or source scope changes, run the root
command, review `coverage/coverage-summary.json`, update the measured values in
`scripts/coverage.config.mjs`, and raise (never silently lower) the associated
floors in the same reviewed change. A lower floor requires an explicit
justification in this document.
