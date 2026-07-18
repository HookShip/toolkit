# Local reference infrastructure

The reference stack contains PostgreSQL, MinIO, a one-shot migration service,
and the HTTPS application. PostgreSQL and MinIO publish no host ports and use
only the internal backend network. The app publishes on `127.0.0.1`, joins the
backend, and separately joins an egress-capable network so public webhook
destinations remain reachable. MinIO's console is not exposed.

## First run

```sh
./infra/setup.sh
docker compose --env-file infra/.env -f infra/docker-compose.yml up -d --build app
curl --fail --cacert infra/certs/ca.crt \
  https://127.0.0.1:3210/health/ready
```

`setup.sh` creates:

- mode-0600 `infra/.env` with generated PostgreSQL, MinIO, a paired
  `REFERENCE_INGEST_CREDENTIAL_ID`/`REFERENCE_INGEST_SECRET`, and master-key
  material;
- mode-0600 `infra/.api-token` for CLI use and the app's mounted token;
- mode-0600 `infra/.curl-auth`, so bearer credentials are not placed in process
  arguments;
- a restricted local CA key, public CA certificate, and a 30-day localhost/app
  server certificate.

It refuses to overwrite an installation. Renew only the server certificate,
without changing database credentials, API/ingest tokens, the master key, or the
CA:

```sh
./infra/setup.sh --renew-cert
```

Full rotation is deliberately separate and prints a strong warning:

```sh
./infra/setup.sh --rotate-all
```

Full rotation changes database/object-store credentials, API and ingest tokens,
the encryption master key, payload namespace/store IDs, the CA, and the server
certificate. Existing volumes may require migration or deletion afterward.
`--force` remains only as a deprecated alias.

The app cannot start until the migration container exits successfully.
`/health/ready` returns 503 with safe missing, unexpected/future, and
checksum-mismatch version summaries when the schema is not exact.

Payload capture is metadata-only by default. MinIO credentials still enable
startup and periodic bounded cleanup/reconciliation of historical objects,
including durable upload intents, even while new capture is disabled.
`/health/maintenance` exposes safe aggregate state and `/metrics` exposes
Prometheus gauges without object keys or payload data. Maintenance or storage
failures make readiness fail instead of silently disabling cleanup.

The payload bucket must remain unversioned. Enabled or suspended bucket
versioning is rejected because deleting only the current key could retain
noncurrent payload bytes. `setup.sh` generates distinct, non-secret,
22-character lowercase hexadecimal `REFERENCE_PAYLOAD_NAMESPACE_ID` and
`REFERENCE_PAYLOAD_STORE_ID` values and sets `MINIO_PAYLOAD_BUCKET` to
`webhook-payloads-<namespace-id>-<store-id>`. The full generated IDs fit the
63-character S3 bucket-name limit, so the derivation is exact rather than a
truncated alias. Runtime verifies this exact value before making any bucket
request. Replicas sharing both IDs converge on one bucket, while the same
namespace paired with a different physical store ID necessarily selects a
different valid bucket. PostgreSQL binding plus the
`.webhook-portal/payload-namespace` body and metadata checks remain defense in
depth; markers are never adopted as database identity.

This is a pre-release breaking storage-identity change. Migration 011 rejects
existing bindings with the legacy 32-character IDs, and runtime rejects the old
namespace-only bucket name before contacting MinIO. There is no automatic
legacy-bucket adoption. The recommended local upgrade is a reset:

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml down --volumes
./infra/setup.sh --rotate-all
```

Preserving pre-release payload data requires an operator-managed, offline
migration of the PostgreSQL binding, generated environment, bucket name, and
marker body/metadata as one coordinated operation. Until every value matches the
new canonical pair, migration or readiness fails closed without reconciling or
deleting payload references.

If cleanup-capable MinIO configuration is removed while any payload references,
upload intents, cleanup claims/tasks, or storage binding remains, the app may
serve liveness but readiness stays non-ready with `payload_storage_required`.
Cleanup is never silently disabled.

CI validates rendered network/port/TLS invariants, setup renewal/rotation
semantics, the exact no-daemon Docker context for reference integration tests,
and the pruned production runtime layout without starting containers:

```sh
pnpm check:compose
```

## Authenticated requests

```sh
curl --config infra/.curl-auth \
  --cacert infra/certs/ca.crt \
  https://127.0.0.1:3210/v1/endpoints
```

The API token is required even on loopback. Non-loopback listeners cannot start
without a TLS certificate and private key. Metadata ingest uses a separately
scoped signed envelope plus required ingest authorization headers. The CLI reads
`REFERENCE_INGEST_CREDENTIAL_ID` by default, supports an explicit
`--credential-id` override, and never prints credential material.

## Live persistence tests

Default tests are deterministic and skip external services. The integration
profile runs PostgreSQL/MinIO contracts inside the internal Compose backend, so
neither service needs a host port. Its dedicated image stage contains only the
three required CLI/reference integration test files plus the migration fixture;
the production runtime contains no test or source tree:

```sh
docker compose --profile integration \
  --env-file infra/.env \
  -f infra/docker-compose.yml \
  run --rm --build integration-tests
```

Stop without deleting data:

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml down
```

Add `--volumes` only when the local PostgreSQL and MinIO data should be erased.
