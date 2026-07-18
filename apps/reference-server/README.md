# Reference server application

This package is the standalone process wrapper around the open single-team
reference API.

```sh
pnpm --filter @webhook-portal/reference-server build
node apps/reference-server/dist/migrate.js
node apps/reference-server/dist/index.js
```

For normal local use, prefer `./infra/setup.sh` and Compose. The packaged
deployment runs migrations before the app, requires an API token on loopback,
and serves HTTPS whenever it binds outside loopback.

Important environment inputs:

- `DATABASE_URL`
- `REFERENCE_MASTER_KEY`
- `REFERENCE_INGEST_CREDENTIAL_ID`
- `REFERENCE_INGEST_SECRET`
- distinct non-secret 22-character lowercase hexadecimal
  `REFERENCE_PAYLOAD_NAMESPACE_ID` and `REFERENCE_PAYLOAD_STORE_ID` values
  shared by replicas of one installation
- `REFERENCE_API_TOKEN` or permission-restricted `REFERENCE_API_TOKEN_FILE`
- paired `REFERENCE_TLS_CERT_FILE` and `REFERENCE_TLS_KEY_FILE` for TLS
- optional MinIO variables for cleanup/reconciliation, even when new payload
  capture is disabled
- `REFERENCE_PAYLOAD_MAINTENANCE_INTERVAL_SECONDS`,
  `REFERENCE_PAYLOAD_MAINTENANCE_GRACE_SECONDS`, and
  `REFERENCE_PAYLOAD_MAINTENANCE_BATCH_SIZE`

Readiness checks the exact migration set and checksums, the database/bucket
namespace and physical-store binding, cleanup-capable storage, and
payload-maintenance health. Historical payload state without cleanup-capable
storage returns `payload_storage_required`, even when new capture is disabled.
`MINIO_PAYLOAD_BUCKET` must exactly equal
`webhook-payloads-<namespace-id>-<store-id>`; legacy namespace-only or otherwise
incorrect names are rejected before any bucket request. Pre-release installs
using the former 32-character IDs require a coordinated data migration or a
local volume/credential reset as documented in
[`infra/README.md`](../../infra/README.md). `/health/maintenance` and `/metrics`
expose only safe aggregate state. Startup errors intentionally avoid echoing
credentials or internal exception details.

## API documentation

`/openapi.json` (OpenAPI 3.0.3) and an interactive `/docs` page are generated
from the same route definitions that implement the API, so they cannot drift
from actual behavior. Both require the API token, consistent with every other
non-health, non-ingest, non-test-receiver route:

```sh
curl --config infra/.curl-auth --cacert infra/certs/ca.crt \
  https://127.0.0.1:3210/openapi.json
```

Publish and idempotency-status responses expose bounded release metadata rather
than the stored canonical export or original source. Release listings use
`limit`/`beforeSequence` pagination. Fetch full canonical and original content
only through the explicit `GET /v1/releases/{id}` detail route; contract imports
remain capped by `REFERENCE_CONTRACT_BODY_LIMIT_BYTES`.
