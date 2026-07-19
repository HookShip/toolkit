#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$ROOT/.setup-lifecycle-test"

cleanup() {
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/infra" "$SCRATCH/examples"
cp "$ROOT/infra/setup.sh" "$SCRATCH/infra/setup.sh"
cp "$ROOT/examples/demo.sh" "$SCRATCH/examples/demo.sh"
chmod 755 "$SCRATCH/infra/setup.sh"
chmod 755 "$SCRATCH/examples/demo.sh"

hash_file() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

run_setup() {
  (
    cd "$SCRATCH"
    ./infra/setup.sh "$@"
  )
}

run_setup >/dev/null
openssl verify \
  -CAfile "$SCRATCH/infra/certs/ca.crt" \
  "$SCRATCH/infra/certs/reference.crt" >/dev/null

test_fresh_demo_credential() (
  set -a
  # shellcheck disable=SC1091
  . "$SCRATCH/infra/.env"
  set +a

  if [[ ! "$REFERENCE_INGEST_CREDENTIAL_ID" =~ ^ingest_[A-Za-z0-9_-]{16}$ ]]; then
    echo "setup did not generate a valid ingest credential ID" >&2
    exit 1
  fi
  if [[ ! "$REFERENCE_PAYLOAD_NAMESPACE_ID" =~ ^[0-9a-f]{22}$ ]]; then
    echo "setup did not generate a valid payload namespace ID" >&2
    exit 1
  fi
  if [[ ! "$REFERENCE_PAYLOAD_STORE_ID" =~ ^[0-9a-f]{22}$ ]]; then
    echo "setup did not generate a valid payload store ID" >&2
    exit 1
  fi
  if [[ "$REFERENCE_PAYLOAD_STORE_ID" == "$REFERENCE_PAYLOAD_NAMESPACE_ID" ]]; then
    echo "setup did not separate payload namespace and store IDs" >&2
    exit 1
  fi
  expected_bucket="webhook-payloads-$REFERENCE_PAYLOAD_NAMESPACE_ID-$REFERENCE_PAYLOAD_STORE_ID"
  if [[ "$MINIO_PAYLOAD_BUCKET" != "$expected_bucket" ]]; then
    echo "setup did not bind the payload bucket to its namespace and store IDs" >&2
    exit 1
  fi
  if [[ ! "$MINIO_PAYLOAD_BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] ||
    [[ "${#MINIO_PAYLOAD_BUCKET}" -gt 63 ]]; then
    echo "setup generated an invalid S3 bucket name" >&2
    exit 1
  fi

  fake_bin="$SCRATCH/fake-bin"
  cli_log="$SCRATCH/demo-cli.log"
  demo_stdout="$SCRATCH/demo.stdout"
  demo_stderr="$SCRATCH/demo.stderr"
  real_node="$(command -v node)"
  mkdir -p "$fake_bin"

  cat >"$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  cat >"$fake_bin/pnpm" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  cat >"$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in
    */health/ready)
      exit 0
      ;;
    */v1/endpoints)
      printf '%s\n' '{"endpoint":{"id":"endpoint_demo_test"}}'
      exit 0
      ;;
  esac
done
exit 0
SH
  cat >"$fake_bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1-}" == "packages/cli/dist/bin.js" ]]; then
  shift
  printf '%s' "${1-}" >>"$CLI_LOG"
  shift || true
  printf ' %s' "$@" >>"$CLI_LOG"
  printf '\n' >>"$CLI_LOG"
  if [[ "$(tail -n 1 "$CLI_LOG")" == publish\ * ]]; then
    printf '%s\n' '{"idempotencyKey":"publish-demo-test"}'
  fi
  exit 0
fi
exec "$REAL_NODE" "$@"
SH
  chmod 755 "$fake_bin/docker" "$fake_bin/pnpm" "$fake_bin/curl" "$fake_bin/node"

  PATH="$fake_bin:$PATH" REAL_NODE="$real_node" CLI_LOG="$cli_log" \
    "$SCRATCH/examples/demo.sh" >"$demo_stdout" 2>"$demo_stderr"

  grep -Fq -- \
    "ingest examples/metadata/order-delivered.json --server https://127.0.0.1:3210 --credential-id $REFERENCE_INGEST_CREDENTIAL_ID --secret-env REFERENCE_INGEST_SECRET" \
    "$cli_log"

  assert_absent() {
    local value="$1"
    local file="$2"
    if grep -Fq -- "$value" "$file"; then
      echo "demo printed ingest credential material" >&2
      exit 1
    else
      local status=$?
      if [[ "$status" -ne 1 ]]; then
        echo "failed to inspect demo output for credential material" >&2
        exit "$status"
      fi
    fi
  }

  assert_absent "$REFERENCE_INGEST_CREDENTIAL_ID" "$demo_stdout"
  assert_absent "$REFERENCE_INGEST_CREDENTIAL_ID" "$demo_stderr"
  assert_absent "$REFERENCE_INGEST_SECRET" "$demo_stdout"
  assert_absent "$REFERENCE_INGEST_SECRET" "$demo_stderr"
)

test_fresh_demo_credential

env_before="$(hash_file "$SCRATCH/infra/.env")"
token_before="$(hash_file "$SCRATCH/infra/.api-token")"
curl_before="$(hash_file "$SCRATCH/infra/.curl-auth")"
ca_cert_before="$(hash_file "$SCRATCH/infra/certs/ca.crt")"
ca_key_before="$(hash_file "$SCRATCH/infra/certs/ca.key")"
cert_before="$(hash_file "$SCRATCH/infra/certs/reference.crt")"
key_before="$(hash_file "$SCRATCH/infra/certs/reference.key")"

run_setup --renew-cert >/dev/null
[[ "$(hash_file "$SCRATCH/infra/.env")" == "$env_before" ]]
[[ "$(hash_file "$SCRATCH/infra/.api-token")" == "$token_before" ]]
[[ "$(hash_file "$SCRATCH/infra/.curl-auth")" == "$curl_before" ]]
[[ "$(hash_file "$SCRATCH/infra/certs/ca.crt")" == "$ca_cert_before" ]]
[[ "$(hash_file "$SCRATCH/infra/certs/ca.key")" == "$ca_key_before" ]]
[[ "$(hash_file "$SCRATCH/infra/certs/reference.crt")" != "$cert_before" ]]
[[ "$(hash_file "$SCRATCH/infra/certs/reference.key")" != "$key_before" ]]
openssl verify \
  -CAfile "$SCRATCH/infra/certs/ca.crt" \
  "$SCRATCH/infra/certs/reference.crt" >/dev/null

if run_setup >/dev/null 2>&1; then
  echo "setup unexpectedly overwrote an existing install" >&2
  exit 1
fi

rotation_warning="$SCRATCH/rotation-warning"
run_setup --rotate-all >/dev/null 2>"$rotation_warning"
grep -q "full credential rotation" "$rotation_warning"
[[ "$(hash_file "$SCRATCH/infra/.env")" != "$env_before" ]]
[[ "$(hash_file "$SCRATCH/infra/.api-token")" != "$token_before" ]]
[[ "$(hash_file "$SCRATCH/infra/.curl-auth")" != "$curl_before" ]]
[[ "$(hash_file "$SCRATCH/infra/certs/ca.crt")" != "$ca_cert_before" ]]
[[ "$(hash_file "$SCRATCH/infra/certs/ca.key")" != "$ca_key_before" ]]
openssl verify \
  -CAfile "$SCRATCH/infra/certs/ca.crt" \
  "$SCRATCH/infra/certs/reference.crt" >/dev/null

legacy_env="$(hash_file "$SCRATCH/infra/.env")"
legacy_token="$(hash_file "$SCRATCH/infra/.api-token")"
legacy_curl="$(hash_file "$SCRATCH/infra/.curl-auth")"
rm -f "$SCRATCH/infra/certs/ca.crt" "$SCRATCH/infra/certs/ca.key"
run_setup --renew-cert >/dev/null
[[ "$(hash_file "$SCRATCH/infra/.env")" == "$legacy_env" ]]
[[ "$(hash_file "$SCRATCH/infra/.api-token")" == "$legacy_token" ]]
[[ "$(hash_file "$SCRATCH/infra/.curl-auth")" == "$legacy_curl" ]]
openssl verify \
  -CAfile "$SCRATCH/infra/certs/ca.crt" \
  "$SCRATCH/infra/certs/reference.crt" >/dev/null

node --input-type=module - "$SCRATCH" <<'NODE'
import { statSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
for (const relative of [
  "infra/.env",
  "infra/.api-token",
  "infra/.curl-auth",
  "infra/certs/ca.key",
  "infra/certs/reference.key",
]) {
  if ((statSync(path.join(root, relative)).mode & 0o777) !== 0o600) {
    throw new Error(`${relative} must use mode 0600`);
  }
}
for (const relative of ["infra/certs/ca.crt", "infra/certs/reference.crt"]) {
  if ((statSync(path.join(root, relative)).mode & 0o777) !== 0o644) {
    throw new Error(`${relative} must use mode 0644`);
  }
}
NODE

echo "Setup initialization, certificate renewal, and full rotation are valid."
