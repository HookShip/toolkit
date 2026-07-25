# Coverage

The repository uses Vitest's V8 provider across all 14 public packages and the
private Apache-2.0 reference-server wrapper.

```sh
pnpm test:coverage
```

The command builds workspace dependencies, verifies that every Vitest workspace
is explicitly inventoried, runs each project serially, requires at least one
discovered test and instrumented source file, merges the results, and enforces
per-project plus aggregate regression floors.

## Reports

Generated reports are gitignored under `coverage/`:

- `summary.txt`: human-readable current/floor table;
- `coverage-summary.json`: machine-readable counts, baselines, floors, and
  exceptions;
- `coverage-final.json`: merged Istanbul map with repository-relative paths;
- `lcov.info`: merged LCOV;
- `packages/`: per-workspace test and coverage data.

CI uploads the directory for 14 days, including partial results when a coverage
job fails.

## Scope and exceptions

Coverage includes TypeScript/JavaScript under each workspace's `src/` tree. It
excludes tests, declarations, generated files, configuration, build output,
coverage output, and dependencies.

The reference app is an explicit zero-line wrapper exception. Its process and
migration entry points delegate to the covered
`@webhook-portal/reference-server-core` runtime and are exercised by the
package's own server suite, subprocess smoke wrappers, and Compose validation.

One `@webhook-portal/contract-core` wall-clock budget test is excluded only from
the instrumented run because V8 instrumentation invalidates its five-second
local limit. The ordinary `pnpm test` gate still runs it.

The native `node:test` suites under `extensions/` and `scripts/` validate data
artifacts and repository policy rather than workspace runtime source.

## Measured baseline

Measured on 2026-07-19 with Node.js `22.23.1` and pnpm `11.13.0`: 607 discovered
tests and 136 source files. Values are **lines / statements / functions /
branches**. Floors are conservative whole-number lower bounds, except the
portal-components line floor remains 78 because its displayed 79.00% value is
78.995% before rounding.

| Scope                                   | Measured baseline             | Enforced floor    |
| --------------------------------------- | ----------------------------- | ----------------- |
| Aggregate                               | 80.90 / 80.90 / 89.50 / 70.50 | 80 / 80 / 89 / 70 |
| `@webhook-portal/reference-server`      | 0.00 / 0.00 / 100.00 / 0.00   | 0 / 0 / 100 / 0   |
| `@webhook-portal/reference-server-core` | 76.00 / 76.00 / 84.00 / 66.00 | 76 / 76 / 84 / 66 |
| `@webhook-portal/adapter-conformance`   | 84.94 / 85.12 / 96.36 / 76.14 | 84 / 85 / 96 / 76 |
| `@webhook-portal/adapter-generic-http`  | 81.47 / 81.44 / 93.37 / 70.13 | 81 / 81 / 93 / 70 |
| `@webhook-portal/adapter-sdk`           | 82.33 / 82.19 / 87.32 / 77.76 | 82 / 82 / 87 / 77 |
| `@webhook-portal/canonical-model`       | 88.03 / 87.87 / 87.23 / 71.72 | 87 / 87 / 86 / 70 |
| `@webhook-portal/cli`                   | 80.56 / 80.29 / 91.82 / 65.29 | 80 / 80 / 91 / 65 |
| `@webhook-portal/compatibility-report`  | 92.78 / 92.61 / 96.00 / 86.36 | 92 / 92 / 96 / 86 |
| `@webhook-portal/contract-core`         | 83.78 / 82.79 / 91.64 / 73.76 | 83 / 82 / 91 / 73 |
| `@webhook-portal/extension-conformance` | 94.69 / 94.84 / 91.07 / 80.23 | 94 / 94 / 91 / 80 |
| `@webhook-portal/extension-sdk`         | 79.60 / 79.79 / 91.07 / 68.91 | 79 / 79 / 91 / 68 |
| `@webhook-portal/migration-assessment`  | 86.03 / 86.25 / 96.52 / 74.78 | 86 / 86 / 96 / 74 |
| `@webhook-portal/portal-components`     | 79.00 / 79.65 / 88.78 / 63.81 | 78 / 79 / 88 / 63 |
| `@webhook-portal/signing`               | 90.95 / 90.59 / 92.06 / 85.80 | 90 / 90 / 92 / 85 |
| `@webhook-portal/support-evidence`      | 82.17 / 82.34 / 92.38 / 75.05 | 82 / 82 / 92 / 75 |

When coverage intentionally improves or the source scope changes, run the root
command, review `coverage/coverage-summary.json`, update
`scripts/coverage.config.mjs`, and update this table in the same change.
Lowering a floor requires an explicit justification.

## Live-integration coverage

`@webhook-portal/reference-server-core` owns the Fastify server, Postgres
repository, payload storage, and migration runtime that formerly lived under the
CLI. Its `server.ts` route modules and in-memory repository are covered by the
provider-agnostic suite, while the Postgres repository, payload maintenance, and
migration failure paths are exercised end-to-end against a **real disposable
Postgres + MinIO** stack. `pnpm test:coverage` provisions that stack through
`scripts/coverage-services.mjs`, so those branches are measured (not skipped) in
the enforced run; `pnpm test:coverage:unit` runs the same gate without the
containers for a fast inner loop. Extracting the runtime into its own package
also let `@webhook-portal/cli` branch coverage rise from a floor of 48 to 65
because the CLI no longer carries server code it could not unit-test.

## Provenance

These figures are **measured, not asserted**. `pnpm test:coverage` instruments
the real sources with Vitest's V8 provider and enforces the floors in
`scripts/coverage.config.mjs`; the table records what that run produced on the
stated date and toolchain. The reports themselves are generated output and are
git-ignored under `coverage/`, so the committed source is the config and this
table, not the numbers' backing files. See
[`generated-artifacts.md`](generated-artifacts.md).
