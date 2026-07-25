# Public package compatibility matrix

This repository is the single source of truth and sole publisher for every
`@webhook-portal/*` package below. Ownership is enforced by the `ownership`
block in [`release/manifest.json`](../release/manifest.json) and by
[`scripts/release.mjs`](../scripts/release.mjs) `check`. Any other repository
that needs these packages consumes the published versions; it does not
re-publish them.

The cohort is versioned and released in lockstep: every package always shares
one coordinated version and is published together from a single tag.

## Cohort

- **Scope:** `@webhook-portal` (retained; a rename to `@hookship` is deferred
  and is not performed by this repository).
- **Coordinated version:** `0.1.0` (release candidate; nothing is published
  yet).
- **Node.js engine:** `>=22` for every package.
- **License:** Apache-2.0 for every package.
- **Repository provenance:** every package declares monorepo repository metadata
  — `type: git`, `url: git+https://github.com/HookShip/toolkit.git`, and its own
  `directory` — matching the actual remote, so npm provenance is verifiable.
  `scripts/release.mjs check` fails closed on any missing, drifted, or miscased
  value, and the packed tarballs are verified to retain it.
- **Registry:** the public npm registry, once the scope is authenticated. No
  homepage or registry URL is asserted until one exists.

## Packages

| Package                                 | Internal runtime dependencies                                                                                                            | Peer requirements                          | Binary           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------- |
| `@webhook-portal/canonical-model`       | (none)                                                                                                                                   | —                                          | —                |
| `@webhook-portal/contract-core`         | canonical-model                                                                                                                          | —                                          | —                |
| `@webhook-portal/compatibility-report`  | canonical-model, contract-core                                                                                                           | —                                          | —                |
| `@webhook-portal/signing`               | (none)                                                                                                                                   | —                                          | —                |
| `@webhook-portal/adapter-sdk`           | canonical-model, signing                                                                                                                 | —                                          | —                |
| `@webhook-portal/adapter-conformance`   | adapter-sdk                                                                                                                              | —                                          | —                |
| `@webhook-portal/adapter-generic-http`  | adapter-sdk, canonical-model, signing                                                                                                    | —                                          | —                |
| `@webhook-portal/extension-sdk`         | (none)                                                                                                                                   | —                                          | —                |
| `@webhook-portal/extension-conformance` | extension-sdk                                                                                                                            | —                                          | —                |
| `@webhook-portal/migration-assessment`  | adapter-sdk, canonical-model                                                                                                             | —                                          | —                |
| `@webhook-portal/support-evidence`      | (none)                                                                                                                                   | —                                          | —                |
| `@webhook-portal/portal-components`     | (none)                                                                                                                                   | `react >=18.3 <20`, `react-dom >=18.3 <20` | —                |
| `@webhook-portal/cli`                   | adapter-generic-http, adapter-sdk, canonical-model, compatibility-report, contract-core, migration-assessment, signing, support-evidence | —                                          | `webhook-portal` |

Internal dependencies use the workspace protocol in-repo and are rewritten to
the exact cohort version when packed. Because every package shares one version,
a consumer that pins one `@webhook-portal/*` package to version `X` should pin
all of them to `X`.

## Publish order

Packages are published in dependency order so every dependency is on the
registry before anything that depends on it. The order is derived
deterministically by [`scripts/release.mjs`](../scripts/release.mjs) and is:

1. `@webhook-portal/canonical-model`
2. `@webhook-portal/portal-components`
3. `@webhook-portal/signing`
4. `@webhook-portal/adapter-sdk`
5. `@webhook-portal/contract-core`
6. `@webhook-portal/extension-sdk`
7. `@webhook-portal/support-evidence`
8. `@webhook-portal/adapter-conformance`
9. `@webhook-portal/adapter-generic-http`
10. `@webhook-portal/compatibility-report`
11. `@webhook-portal/extension-conformance`
12. `@webhook-portal/migration-assessment`
13. `@webhook-portal/reference-server-core`
14. `@webhook-portal/cli`

The order is regenerated from the manifest on every run, so it stays correct if
dependencies change. See [`release-policy.md`](release-policy.md) for the full
release process.

## Reference server

The reference server runtime ships as the public
[`@webhook-portal/reference-server-core`](../packages/reference-server-core)
package (Fastify, Postgres, and MinIO live here, not in the CLI).
[`apps/reference-server`](../apps/reference-server) is a private Apache-2.0
process/migration wrapper that depends directly on that package; it is not part
of the published cohort and has no npm release version. The CLI keeps the
runtime as an **optional peer** and exposes a deprecated
`@webhook-portal/cli/reference-server` compatibility re-export that resolves
only when the core package is also installed, so a CLI-only install never pulls
Fastify/PG/MinIO.

## Provenance

This matrix is **derived from the package manifests, not hand-asserted**. The
scope, versions, internal dependencies, peer requirements, Node engine, and
repository provenance are the values in each `packages/*/package.json`, and
`node scripts/release.mjs check` fails closed if any package drifts from them.
The publish order is recomputed from the manifest's dependency graph on every
run rather than transcribed here. When a manifest changes, regenerate the
affected rows and let the release check confirm them. See
[`generated-artifacts.md`](generated-artifacts.md).
