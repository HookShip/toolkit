#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f infra/.env || ! -f infra/.api-token ]]; then
  ./infra/setup.sh
fi
if [[ ! -f infra/certs/ca.crt ]]; then
  ./infra/setup.sh --renew-cert
fi

set -a
# shellcheck disable=SC1091
. infra/.env
set +a

COMPOSE=(docker compose --env-file infra/.env -f infra/docker-compose.yml)
SERVER="https://127.0.0.1:${REFERENCE_PORT}"
CACERT="$ROOT/infra/certs/ca.crt"
TOKEN_FILE="$ROOT/infra/.api-token"
CLI=(node packages/cli/dist/bin.js)

"${COMPOSE[@]}" up -d --build app

ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --cacert "$CACERT" \
    "$SERVER/health/ready" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  "${COMPOSE[@]}" ps
  echo "Reference app did not become ready." >&2
  exit 1
fi

export NODE_EXTRA_CA_CERTS="$CACERT"
pnpm --filter @webhook-portal/cli... build

"${CLI[@]}" validate examples/contracts/orders.openapi.yaml
set +e
"${CLI[@]}" types examples/contracts/orders.openapi.yaml \
  --event order.created --version 1 >/dev/null
types_exit=$?
set -e
if [[ "$types_exit" -ne 0 && "$types_exit" -ne 4 ]]; then
  echo "Type generation failed with unexpected exit $types_exit." >&2
  exit "$types_exit"
fi

PUBLISH_JSON="$(
  "${CLI[@]}" publish examples/contracts/orders.openapi.yaml \
    --server "$SERVER" \
    --api-token-file "$TOKEN_FILE" \
    --json
)"
PUBLISH_KEY="$(
  printf "%s" "$PUBLISH_JSON" |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).idempotencyKey))"
)"
"${CLI[@]}" publish-status \
  --server "$SERVER" \
  --api-token-file "$TOKEN_FILE" \
  --idempotency-key "$PUBLISH_KEY"

authorized_curl() {
  curl --fail --silent --show-error \
    --config infra/.curl-auth \
    --cacert "$CACERT" \
    "$@"
}

ENDPOINT_JSON="$(
  authorized_curl -X POST "$SERVER/v1/endpoints" \
    -H "content-type: application/json" \
    --data '{"url":"https://app:3210/v1/test-receiver/pending","allowLocalNetwork":true}'
)"
ENDPOINT_ID="$(
  printf "%s" "$ENDPOINT_JSON" |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).endpoint.id))"
)"

authorized_curl -X PATCH "$SERVER/v1/endpoints/$ENDPOINT_ID" \
  -H "content-type: application/json" \
  --data "{\"url\":\"https://app:3210/v1/test-receiver/$ENDPOINT_ID\",\"allowLocalNetwork\":true}" \
  >/dev/null
authorized_curl -X PUT "$SERVER/v1/endpoints/$ENDPOINT_ID/subscriptions" \
  -H "content-type: application/json" \
  --data '{"eventTypes":["order.created"]}' >/dev/null
authorized_curl -X POST "$SERVER/v1/endpoints/$ENDPOINT_ID/secrets" \
  -H "content-type: application/json" --data '{}' >/dev/null
authorized_curl -X POST "$SERVER/v1/endpoints/$ENDPOINT_ID/send-test" \
  -H "content-type: application/json" \
  -H "idempotency-key: demo-signed-test-0001" \
  --data '{"eventType":"order.created","version":"1"}' >/dev/null

"${CLI[@]}" ingest examples/metadata/order-delivered.json \
  --server "$SERVER" \
  --credential-id "$REFERENCE_INGEST_CREDENTIAL_ID" \
  --secret-env REFERENCE_INGEST_SECRET
"${CLI[@]}" timeline \
  --server "$SERVER" \
  --api-token-file "$TOKEN_FILE" \
  --limit 10

echo "Demo completed; the reference stack remains running."
echo "Authenticated preview:"
echo "  curl --config infra/.curl-auth --cacert infra/certs/ca.crt $SERVER/preview"
echo "Cleanup:"
echo "  ./examples/demo-cleanup.sh"
