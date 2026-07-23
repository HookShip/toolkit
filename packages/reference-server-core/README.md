# `@webhook-portal/reference-server-core`

The open, single-team **reference webhook-portal server** runtime, extracted
from `@webhook-portal/cli` so a CLI-only install no longer pulls Fastify,
Postgres, or MinIO.

```ts
import {
  buildReferenceServer,
  runReferenceServerProcess,
  InMemoryReferenceRepository,
  PostgresReferenceRepository,
  ReferenceService,
} from "@webhook-portal/reference-server-core";
```

This package provides:

- A **Fastify** HTTP surface (`buildReferenceServer`,
  `runReferenceServerProcess`) with request parsing, per-resource routes, and an
  OpenAPI document.
- The **repository** layer as segregated role interfaces plus an in-memory
  (`InMemoryReferenceRepository`) and **Postgres**
  (`PostgresReferenceRepository`) implementation, sharing one contract test
  suite.
- **Payload storage** with in-memory, disabled, and **MinIO** backends.
- Forward-only schema **migrations** (`REFERENCE_SERVER_MIGRATIONS`) — the
  canonical source mirrored into `infra/migrations/*.sql`.
- The domain `ReferenceService` (contracts, releases, endpoints, secrets, test
  dispatch, metadata) behind a thin facade.

## Consumers

- [`apps/reference-server`](../../apps/reference-server) depends on this package
  directly to run the standalone server and migrator.
- [`@webhook-portal/cli`](../cli) lists it as an **optional peer** and loads it
  lazily only for the `serve` and `migrate` commands. The deprecated
  `@webhook-portal/cli/reference-server` subpath re-exports this package for
  backward compatibility and resolves only when it is installed.

## Running the reference stack

Postgres and MinIO integration is exercised by the `test:integration` script and
the Compose profile under [`infra/`](../../infra); see
[`infra/OPERATIONS.md`](../../infra/OPERATIONS.md).

## License

Apache-2.0.
