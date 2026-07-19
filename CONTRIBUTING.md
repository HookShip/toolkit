# Contributing

Thank you for contributing to HookShip Toolkit. This repository is entirely
Apache-2.0 and contains 13 public packages plus the private Apache-2.0
`apps/reference-server` packaging wrapper.

## Setup

```sh
corepack enable
pnpm install --frozen-lockfile
```

Node.js 22+ and Gitleaks 8.30.1+ are required for the full check. The pinned
pnpm version is declared in [`package.json`](package.json), and `.npmrc` enables
strict engine and peer dependency checks. CI installs Gitleaks 8.30.1 before
running `pnpm check`.

## Validation

Run the narrowest relevant command while developing, then the broader gate:

| Scope                                | Command                |
| ------------------------------------ | ---------------------- |
| Tests                                | `pnpm test`            |
| Full Node.js gate                    | `pnpm check`           |
| Coverage                             | `pnpm test:coverage`   |
| In-memory workflow                   | `pnpm smoke`           |
| Package tarballs                     | `pnpm pack:smoke`      |
| Reference infrastructure             | `pnpm check:compose`   |
| Release metadata                     | `pnpm check:release`   |
| Release artifacts without publishing | `pnpm release:dry-run` |

`pnpm check` covers formatting, linting, type checking, all deterministic
workspace tests, extension-pack tests, package boundaries, secret hygiene,
release consistency, and builds.

Docker is needed only for running the reference stack or live integration
profile. `pnpm check:compose` renders Compose configuration and validates the
Docker context and production deployment layout.

## Change requirements

1. Keep changes focused and add tests for behavior changes.
2. Preserve security behavior, especially parser bounds, destination safety,
   secret redaction, metadata allowlists, and extension determinism.
3. Keep every package under `packages/` public, Apache-2.0, and listed in both
   the boundary inventory and release manifest.
4. Keep `apps/reference-server` private and Apache-2.0; it is a packaging
   wrapper, not a publishable npm package.
5. Do not add dependencies on absent private repositories, hosted services, or
   deployment-specific credentials.
6. Update package or root documentation when commands, exports, or behavior
   change.
7. Run `pnpm pack:smoke` after changing package exports, files, binaries, or
   runtime dependencies.
8. Run `pnpm release:clean` after inspecting generated release artifacts.

Package scopes remain `@webhook-portal/*` until a separately reviewed npm-scope
migration is possible.

## Pull requests

- Explain why the change is needed and how it was validated.
- Prefer small, reviewable changes.
- Add a `Signed-off-by` line if you use the project's optional DCO-style
  convention.
- Follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).
