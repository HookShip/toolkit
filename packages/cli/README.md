# `@webhook-portal/cli`

Contract, signing, test, metadata, and reference-server tooling.

```sh
webhook-portal validate contract.yaml
webhook-portal import contract.yaml --out contract.canonical.json
webhook-portal diff previous.yaml next.yaml
webhook-portal compatibility-report previous.yaml next.yaml --format markdown
webhook-portal migration-assess inventory.json contract.yaml \
  --target-capabilities target-capabilities.json
webhook-portal support-evidence timeline.json \
  --case-id case_opaque_001 --scope scope.json --out evidence.json
webhook-portal support-evidence-verify evidence.json
webhook-portal fixture contract.yaml --event order.created --version 1
webhook-portal types contract.yaml --event order.created --version 1
webhook-portal sign body.json --secret-file .webhook-secret
webhook-portal verify body.json --headers headers.json --secret-file .webhook-secret
```

Run `webhook-portal --help`, or any command with `--help`, for the exact,
current command list and flags — it is generated from the same switch statement
that dispatches commands, and a test fails if the two drift apart.

Relative input, output, `--secret-file`, and API-token file paths resolve from
the CLI working directory. Embedded callers set that directory with the `runCli`
`cwd` dependency; it does not need to match the host process directory.

When an event has more than one public version, `--version` is mandatory unless
the contract explicitly marks one current through
`x-webhook-portal-current-version`/`x-current-version` or a version-level
`x-webhook-portal-current: true`/`x-current: true`. Versions are never chosen
lexicographically.

## Compatibility, migration, and support evidence

The repository includes synthetic, credential-free examples under
[`examples/learning`](../../examples/learning):

```sh
# Returns exit 5 because the next synthetic contract adds a required field.
webhook-portal compatibility-report \
  examples/learning/compatibility-previous.openapi.yaml \
  examples/learning/compatibility-next-breaking.openapi.yaml \
  --audience consumer \
  --format markdown \
  --out compatibility-report.md

# Read-only: no provider credentials, network access, or provider mutations.
webhook-portal migration-assess \
  examples/learning/migration.inventory.json \
  examples/learning/compatibility-previous.openapi.yaml \
  --target-capabilities examples/learning/target-capabilities.json \
  --target-policy examples/learning/target-policy.json \
  --format json \
  --out migration-assessment.json

# Produces metadata-only, explicitly unsigned evidence when no key is supplied.
webhook-portal support-evidence \
  examples/learning/support-timeline.json \
  --case-id case_synthetic_001 \
  --scope examples/learning/support-scope.json \
  --from 2026-07-18T10:00:00.000Z \
  --to 2026-07-18T10:03:00.000Z \
  --purpose case-review \
  --format json \
  --out support-evidence.json

webhook-portal support-evidence-verify support-evidence.json --json
```

`compatibility-report` accepts only exact, valid contracts. Invalid contracts
exit `3`, partial contracts exit `4`, and breaking or unknown reports exit `5`.
`--allow-breaking` changes only the exit for a known breaking report; it never
changes the report status or permits an unknown result. JSON and Markdown
artifacts are deterministic, and `--out` uses the CLI's atomic file writer.

`migration-assess` accepts bounded JSON or YAML inventory, capability, and
optional policy files. Inventory imports use the migration package's closed
credential-free schema. A blocked assessment exits `5`; malformed or secret-
shaped input exits `3`. The command never accepts provider credentials and does
not perform network calls or provider writes.

`support-evidence` accepts a bounded metadata timeline plus a strict tenant
scope. `--from`/`--to` default to the supplied records, `--purpose` defaults to
`case-review`, and `--expires-at` defaults to seven days after creation.
Unsigned output includes a digest and explicit `unsigned` status. To sign, use
an Ed25519 PKCS#8 private key in a permission-restricted file:

```sh
webhook-portal support-evidence \
  examples/learning/support-timeline.json \
  --case-id case_synthetic_001 \
  --scope examples/learning/support-scope.json \
  --signing-key-file support-private.pem \
  --key-id support-key-2026-07 \
  --out signed-support-evidence.json

webhook-portal support-evidence-verify signed-support-evidence.json \
  --public-key-file support-public.pem \
  --require-signature
```

Private keys are never accepted literally or from stdin, and files granting
group/other access are rejected. Verification also supports `--trust-policy`,
`--valid-from`, `--valid-until`, `--revoked-at`,
`--revocation-mode all|from-time`, `--allow-historical-signatures`, `--now`, and
`--max-clock-skew-ms`. Tampered, expired, revoked, or otherwise untrusted
evidence exits `6`; malformed bundles exit `3`. A trust policy contains `keys`
entries with `keyId`, `publicKeyFile`, and optional validity/revocation
timestamps. Relative public-key paths resolve from the policy file directory.

For all four commands, `--json` emits a machine command envelope while
`--format` selects the artifact representation. At most one input may use `-`
for stdin.

## Talking to a reference server

Reference control-plane commands (`publish`, `publish-status`, `timeline`)
require a token from `REFERENCE_API_TOKEN`, `REFERENCE_API_TOKEN_FILE`,
`--api-token-env`, or a mode-0600 `--api-token-file`. Metadata ingest instead
uses the separately scoped `REFERENCE_INGEST_SECRET` and credential ID:

```sh
export NODE_EXTRA_CA_CERTS="$PWD/infra/certs/ca.crt"
set -a
. infra/.env
set +a

webhook-portal publish contract.yaml \
  --server https://127.0.0.1:3210 \
  --api-token-file infra/.api-token

webhook-portal publish-status \
  --server https://127.0.0.1:3210 \
  --api-token-file infra/.api-token \
  --idempotency-key publish_...

webhook-portal ingest metadata.json \
  --server https://127.0.0.1:3210 \
  --credential-id "$REFERENCE_INGEST_CREDENTIAL_ID" \
  --secret-env REFERENCE_INGEST_SECRET \
  --batch-id batch_...

webhook-portal timeline --server https://127.0.0.1:3210 --limit 10
```

Authenticated remote `http://` URLs are rejected before fetch. Loopback HTTP is
allowed only because the token is still mandatory; generated Compose installs
use HTTPS. By default, publish derives a stable idempotency key from the
canonical contract checksum and normalized override reason. It preflights that
key, replays the same release across equivalent imports, rejects different
content, and checks publish status after a lost response before returning
exit 7. An explicit `--idempotency-key` remains available for external
workflows. Publish and `publish-status` responses contain only bounded release
metadata (checksum, state, timestamps, compatibility counts, and a capped event
preview), so recovery remains below the CLI response limit even for contracts
near the 4 MiB input limit. Full canonical and original content is available
only from `GET /v1/releases/{id}`; `GET /v1/releases` is compact and paginated.

For ingest, `--credential-id` overrides `REFERENCE_INGEST_CREDENTIAL_ID`; when
neither is set, the local-development ID `local-ingest` remains the fallback.
The generated demo passes the setup-created ID explicitly. Credential material
is never included in CLI output.

Metadata ingest reports its batch ID on success. If a mutating ingest response
is lost, the CLI returns exit `7` with `METADATA_INGEST_OUTCOME_UNKNOWN` and the
same batch ID for audit reconciliation; it does not report a definite failure
after the server may have committed the batch. Use an explicit `--batch-id` when
an external workflow needs a predetermined reconciliation identifier.

Timeline cursor failures use the stable `INVALID_CURSOR` code and invalid-input
exit `3`.

## Sending a signed test directly to a URL

`send-test` signs a body and POSTs it straight to a destination — independent of
any reference server — using the same destination-safety checks as the generic
HTTP adapter:

```sh
webhook-portal send-test body.json \
  --url https://example-customer.internal/webhooks \
  --secret-file .webhook-secret
```

The destination must pass public-network safety validation unless
`--allow-local-network` is set (only appropriate for local demos/tests against
your own loopback receiver).

## Running the reference server from this binary

`serve` and `migrate` run the same open reference-server implementation packaged
separately as [`apps/reference-server`](../../apps/reference-server), using the
environment variables documented there (`DATABASE_URL`, `REFERENCE_MASTER_KEY`,
`REFERENCE_INGEST_CREDENTIAL_ID`, `REFERENCE_INGEST_SECRET`,
`REFERENCE_API_TOKEN`/`REFERENCE_API_TOKEN_FILE`, distinct non-secret
22-character lowercase hexadecimal
`REFERENCE_PAYLOAD_NAMESPACE_ID`/`REFERENCE_PAYLOAD_STORE_ID` values, TLS file
pairs, and optional MinIO variables). When MinIO is configured,
`MINIO_PAYLOAD_BUCKET` must be the exact
`webhook-payloads-<namespace-id>-<store-id>` derivation; legacy or custom names
fail before object-store access:

```sh
webhook-portal migrate
webhook-portal serve --migrate
```

## Secrets and I/O

Secrets are accepted only from environment variables, permission-restricted
files, or stdin. Every command centrally rejects more than one stdin consumer
before reading. Successful JSON, fixtures, contracts, and generated code are
never redacted or rewritten; only errors/diagnostics receive key-aware
redaction.

Atomic file output writes and fsyncs a temporary file before rename. It also
fsyncs the parent directory on POSIX; Windows-only unsupported directory
open/fsync results are tolerated after a successful rename without hiding real
POSIX failures.

Exit codes: success `0`, runtime `1`, usage/stdin conflict `2`, invalid `3`,
partial `4`, incompatible `5`, security `6`, unknown outcome `7`, rejected `8`.
