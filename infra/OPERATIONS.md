# Reference stack operations

This runbook covers operating the optional local reference stack defined in
[`docker-compose.yml`](docker-compose.yml): PostgreSQL, MinIO, a one-shot
migration service, and the HTTPS application. It assumes you have completed the
first-run setup in [`README.md`](README.md). This is a local, single-node
reference deployment for evaluation, not an operated service; see
[what is deliberately unsupported](#deliberately-unsupported-pre-release).

All commands run from the repository root. The Compose project is
`hookship-toolkit-local`, so its volumes are
`hookship-toolkit-local_webhook-postgres-data` and
`hookship-toolkit-local_webhook-minio-data`. A shorthand used below:

```sh
dc() { docker compose --env-file infra/.env -f infra/docker-compose.yml "$@"; }
```

## Upgrade and reset semantics

The application image is built locally from source
(`hookship-toolkit-reference:local`), so an upgrade is: pull the new revision,
rebuild, and let the one-shot migration service run before the app starts.

```sh
git pull
dc build app migration
dc up -d --build app
dc exec -T app true # app is up only after migration completed successfully
```

Schema migrations are **forward-only** (`infra/migrations/001..011`). The app
refuses to start until the migration container exits successfully, and
`/health/ready` returns `503` with a safe summary when the schema is missing,
unexpected, ahead of the binary, or checksum-mismatched. There is no down
migration; a schema rollback is a restore (see below).

The canonical source for the schema is the CLI/Postgres migrator manifest
`REFERENCE_SERVER_MIGRATIONS` in
[`packages/reference-server-core/src/migrations.ts`](../packages/reference-server-core/src/migrations.ts).
The standalone `infra/migrations/*.sql` files are the deployment mirror for the
Compose/psql path: the advisory-lock, migration-state guard, and checksum
bookkeeping are hand-maintained boilerplate, while the DDL body, version, and
recorded checksum are copied verbatim from the manifest. A change to the schema
starts in the manifest and is mirrored into the matching `.sql` file;
`packages/cli/test/reference-migration-parity.test.ts` fails if the two drift.

Some pre-release changes are intentionally breaking — for example the payload
storage-identity change enforced by migration `011`, which rejects legacy bucket
bindings and does not adopt a legacy bucket automatically. The supported local
upgrade for such a change is a **reset**:

```sh
dc down --volumes
./infra/setup.sh --rotate-all
dc up -d --build app
```

A reset erases local PostgreSQL and MinIO data. Preserving pre-release payload
data across a breaking storage-identity change requires an operator-managed,
offline migration of the PostgreSQL binding, generated environment, bucket name,
and marker body/metadata as one coordinated operation; until every value matches
the new canonical pair, migration or readiness fails closed.

Certificate and credential lifecycle is owned by `setup.sh`: `--renew-cert`
renews only the 30-day TLS material and preserves every credential, while
`--rotate-all` rotates database/object-store credentials, API and ingest tokens,
the master key, payload namespace/store IDs, the CA, and the server certificate.
`--force` remains only as a deprecated alias for `--rotate-all`.

## Backup and restore

Take backups before any upgrade, reset, or rollback. Store them outside the
repository working tree with restrictive permissions; they contain data but no
credentials (credentials live in `infra/.env` and `infra/certs/`, which you back
up separately and never commit).

### PostgreSQL (logical, hot)

PostgreSQL publishes no host port, so dump through the container:

```sh
mkdir -p backups
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' \
  > "backups/postgres-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Restore into a freshly reset database so no stale rows survive:

```sh
dc down --volumes
dc up -d postgres
dc exec -T postgres sh -c \
  'until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done'
dc exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < backups/postgres-<timestamp>.dump
dc up -d --build app
```

The restored dump already contains the schema at backup time, so the app image
must be the revision whose migrations produced that schema. If it is newer, the
migration service applies the remaining forward migrations; if it is older,
`/health/ready` reports an unexpected/future schema and stays non-ready.

### MinIO / PostgreSQL (cold, volume-level)

With the stack stopped, back up either volume as a tarball. This is the most
reliable option for MinIO because it captures object data and the unversioned
bucket exactly:

```sh
dc down
docker run --rm \
  -v hookship-toolkit-local_webhook-minio-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf "/backup/minio-$(date -u +%Y%m%dT%H%M%SZ).tgz" -C /data .
```

Restore into a fresh volume while the stack is stopped, then start:

```sh
dc down --volumes
docker run --rm \
  -v hookship-toolkit-local_webhook-minio-data:/data \
  -v "$PWD/backups:/backup" \
  alpine sh -c 'cd /data && tar xzf /backup/minio-<timestamp>.tgz'
dc up -d --build app
```

The payload bucket must remain unversioned; do not enable bucket versioning on a
restored volume, because deleting only the current key could retain noncurrent
payload bytes. Restore PostgreSQL and MinIO from backups taken at the same time
so payload references and stored objects agree.

## Rollback

There is no schema down-migration. To roll back a change:

1. Stop the app: `dc stop app`.
2. Restore the PostgreSQL (and, if payloads are retained, MinIO) backup taken
   before the change, using the restore procedures above.
3. Rebuild the app image from the previous source revision
   (`git checkout <prev> && dc build app migration`).
4. Start the app: `dc up -d --build app` and confirm `/health/ready` is `200`.

Roll back application revision and data together: an older binary against a
newer schema fails readiness by design, and a newer binary against an older
schema applies forward migrations that a data restore then contradicts.

## Recovery and troubleshooting

Inspect state without exposing services:

```sh
dc ps
dc logs --tail=100 migration
dc logs --tail=100 app
curl --config infra/.curl-auth --cacert infra/certs/ca.crt \
  https://127.0.0.1:3210/health/ready
```

| Symptom                                                                 | Likely cause and action                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App container never becomes healthy                                     | The migration service failed; read `dc logs migration`, fix the cause, then `dc up -d --build app`.                                                                                                      |
| `/health/ready` 503, schema missing/unexpected/future/checksum-mismatch | Run the migration service (`dc up migration`) or align the app image with the schema; forward-only, so a downgrade needs a restore.                                                                      |
| `/health/ready` 503 with `payload_storage_required`                     | Cleanup-capable MinIO configuration was removed while payload references, upload intents, cleanup tasks, or a storage binding remained. Restore MinIO configuration; cleanup is never silently disabled. |
| App up but `/health/maintenance` degraded                               | Storage maintenance/reconciliation is failing; readiness fails rather than silently disabling cleanup. Check MinIO health and logs.                                                                      |
| TLS handshake fails after ~30 days                                      | The server certificate expired. `./infra/setup.sh --renew-cert` then `dc up -d --build app`.                                                                                                             |
| MinIO container unhealthy                                               | The app will not become ready until MinIO is live; check `dc logs minio` and the `webhook-minio-data` volume.                                                                                            |

`/health/live` reflects process liveness only, `/health/maintenance` exposes
safe aggregate storage state, and `/metrics` exposes Prometheus gauges without
object keys or payload data. None of these require authentication; the data API
does.

## Local and remote (SSH) access

The app binds `127.0.0.1:3210` only, and PostgreSQL and MinIO publish no host
ports at all. Keep it that way.

- **Local:** use the authenticated HTTPS API on loopback with the generated CA:

  ```sh
  curl --config infra/.curl-auth --cacert infra/certs/ca.crt \
    https://127.0.0.1:3210/v1/endpoints
  ```

- **Remote operator access:** do not republish the port on a public interface.
  Forward loopback over SSH instead, then use the API locally:

  ```sh
  ssh -N -L 3210:127.0.0.1:3210 operator@your-host
  # copy infra/certs/ca.crt from the host to verify TLS locally
  ```

- **PostgreSQL and MinIO:** reach them only through `dc exec` on the host (over
  SSH). They are on an internal-only network by design; do not add host port
  publishing to inspect them.

- **Credentials:** `infra/.env`, `infra/.api-token`, `infra/.curl-auth`, and
  `infra/certs/` are mode-`0600` and Git-ignored. Copy them over a secure
  channel only, and never place bearer tokens in process arguments — the CLI and
  `--config infra/.curl-auth` avoid that.

## Deliberately unsupported (pre-release)

This reference stack is a single local node for evaluation. Until a release
exists, the following are intentionally **not** provided and must not be
assumed:

- High availability, clustering, replication, failover, or multi-node operation.
- Scheduled or automated backups; run the documented commands yourself.
- Live schema down-migration; migrations are forward-only and rollback is a
  restore.
- Automatic legacy-bucket adoption or in-place payload migration across a
  breaking storage-identity change.
- Zero-downtime upgrades; a breaking storage-identity change is handled by a
  reset.
- Managed secret rotation beyond `setup.sh`, or external KMS/HSM integration in
  this stack.
- Any availability, throughput, durability, or service-level commitment. The
  durable state of record is PostgreSQL; MinIO holds only optional payload
  bytes.

Report vulnerabilities through the process in
[`../SECURITY.md`](../SECURITY.md). Organization placement and release policies
are linked from [`../docs/org-context.md`](../docs/org-context.md).
