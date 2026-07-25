# ADR-0010: Reference server runtime as its own package

## Status

Accepted

## Context

The single-team reference server (a Fastify HTTP surface backed by Postgres and
MinIO, with migrations, payload storage, and the `ReferenceService` domain
logic) originally lived inside `@webhook-portal/cli`, exposed through the
`@webhook-portal/cli/reference-server` subpath. That coupling had three costs:

- **Dependency weight.** Every consumer of the CLI — including CLI-only users
  who only validate contracts, sign payloads, or produce evidence — transitively
  installed Fastify, `pg`, MinIO, and Swagger, even though those are only needed
  to _run_ a server.
- **Testability.** The server, repository, and migration code could only be
  coverage-measured as part of the CLI project, where its failure paths (live
  Postgres transactions, payload cleanup, migration readiness) could not be
  exercised without a database. Its branches dominated the CLI's coverage floor
  and could not be raised without running or faking that stack.
- **Ownership clarity.** The reference runtime is a distinct deliverable from
  the command-line tool, but the manifest, boundaries, and release surface
  treated them as one package.

## Decision

The reference server runtime is extracted into its own public package,
`@webhook-portal/reference-server-core`, which owns the Fastify server, the
in-memory and Postgres repositories, payload storage, migrations, and the
reference domain services. It is a normal member of the published cohort with
its own manifest ownership, versioning, boundaries entry, and coverage project.

- **`apps/reference-server`** depends directly on
  `@webhook-portal/reference-server-core` and no longer routes through the CLI.
- **`@webhook-portal/cli`** keeps the runtime as an **optional peer dependency**
  (`peerDependenciesMeta.optional`). Its `serve` and `migrate` commands load it
  with a lazy `await import(...)` guarded by a
  `REFERENCE_SERVER_RUNTIME_MISSING` error, and command types reference it with
  `import type` (which is erased at runtime). A CLI-only install therefore never
  pulls Fastify/PG/MinIO — asserted by the pack smoke's CLI-only-install check.
- The **`@webhook-portal/cli/reference-server`** subpath remains as a deprecated
  compatibility re-export
  (`export * from "@webhook-portal/reference-server-core"`) that resolves only
  when the optional core package is also installed.
- Two modules that are genuinely shared between the CLI and the runtime moved to
  leaf packages to keep the dependency direction acyclic:
  `resolveSafeDestination` to `@webhook-portal/adapter-generic-http`, and
  `selectCanonicalEventVersion` and `publishRequestFingerprint` to
  `@webhook-portal/contract-core`. The publish idempotency fingerprint is thus
  computed identically by the CLI (which sends it) and the server (which
  recomputes it) without the CLI importing the server.

## Consequences

- CLI-only consumers install a substantially smaller dependency tree; the
  pack-smoke harness proves Fastify/PG/MinIO/Swagger are absent from a
  cohort-minus-core install and that the deprecated subpath fails closed without
  core.
- The reference runtime's server, repository, migration, and payload-cleanup
  branches are now measured against a **real disposable Postgres + MinIO** stack
  provisioned by `scripts/coverage-services.mjs`, lifting its own branch floor
  to ≥65 and letting the CLI's branch floor rise from 48 to 65 now that it no
  longer carries untestable server code.
- The published cohort grows from 13 to 14 packages. The release manifest,
  publish order, package-boundary allowlist, Verdaccio and pack smoke cohorts,
  Docker/Compose integration context, and compatibility matrix are updated
  accordingly, and `scripts/release.mjs check` enforces the new ownership.
- The dependency direction remains acyclic (core sits above adapter, contract,
  and signing leaves; the CLI sits above core only as an optional peer) and is
  enforced by `scripts/check-package-boundaries.mjs`.
