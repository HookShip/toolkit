#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for required_dockerignore_rule in \
  ".git" \
  "**/dist" \
  "**/node_modules" \
  "**/test" \
  "infra/.api-token" \
  "infra/.curl-auth" \
  "**/.env" \
  "**/.env.*" \
  "!**/.env.example" \
  "infra/certs"; do
  if ! grep -Fqx "$required_dockerignore_rule" .dockerignore; then
    echo ".dockerignore must contain $required_dockerignore_rule" >&2
    exit 1
  fi
done

generated=false
if [[ ! -f infra/.env ]]; then
  ./infra/setup.sh >/dev/null
  generated=true
fi
cleanup() {
  if [[ "$generated" == "true" ]]; then
    rm -f infra/.env infra/.api-token infra/.curl-auth
    rm -rf infra/certs
  fi
}
trap cleanup EXIT

docker compose --profile integration --env-file infra/.env \
  -f infra/docker-compose.yml config --quiet
docker compose --profile integration --env-file infra/.env \
  -f infra/docker-compose.yml \
  config --format json |
  node -e '
let source = "";
process.stdin.on("data", (chunk) => {
  source += chunk;
});
process.stdin.on("end", () => {
  const compose = JSON.parse(source);
  for (const serviceName of ["postgres", "minio"]) {
    if ((compose.services[serviceName]?.ports ?? []).length !== 0) {
      throw new Error(`${serviceName} must not publish host ports`);
    }
  }
  const appPorts = compose.services.app?.ports ?? [];
  if (
    appPorts.length === 0 ||
    appPorts.some((port) => port.host_ip !== "127.0.0.1")
  ) {
    throw new Error("app must publish only on loopback");
  }
  if (
    compose.services.app?.depends_on?.migration?.condition !==
    "service_completed_successfully"
  ) {
    throw new Error("app must wait for the one-shot migration service");
  }
  const appEnvironment = compose.services.app?.environment ?? {};
  const namespaceId = appEnvironment.REFERENCE_PAYLOAD_NAMESPACE_ID;
  const storeId = appEnvironment.REFERENCE_PAYLOAD_STORE_ID;
  if (
    !/^[0-9a-f]{22}$/.test(namespaceId ?? "") ||
    !/^[0-9a-f]{22}$/.test(storeId ?? "") ||
    namespaceId === storeId
  ) {
    throw new Error("app payload namespace/store IDs must be distinct S3-safe IDs");
  }
  const canonicalBucket = `webhook-payloads-${namespaceId}-${storeId}`;
  if (
    appEnvironment.MINIO_PAYLOAD_BUCKET !== canonicalBucket ||
    canonicalBucket.length > 63
  ) {
    throw new Error("app payload bucket must be the canonical namespace/store derivation");
  }
  if (compose.networks?.["reference-backend"]?.internal !== true) {
    throw new Error("reference-backend must be internal");
  }
  if (compose.networks?.["reference-egress"]?.internal === true) {
    throw new Error("reference-egress must allow controlled public egress");
  }
  const networks = (serviceName) =>
    Object.keys(compose.services[serviceName]?.networks ?? {}).sort();
  for (const serviceName of ["postgres", "minio", "migration"]) {
    if (JSON.stringify(networks(serviceName)) !== JSON.stringify(["reference-backend"])) {
      throw new Error(`${serviceName} must use only reference-backend`);
    }
  }
  if (
    JSON.stringify(networks("app")) !==
    JSON.stringify(["reference-backend", "reference-egress"])
  ) {
    throw new Error("app must use the backend and egress networks");
  }
  if (
    JSON.stringify(networks("integration-tests")) !==
      JSON.stringify(["reference-backend"]) ||
    (compose.services["integration-tests"]?.ports ?? []).length !== 0
  ) {
    throw new Error("integration tests must stay on the unexposed backend");
  }
  if (
    compose.services["integration-tests"]?.build?.target !== "integration-test"
  ) {
    throw new Error("integration tests must use the dedicated image stage");
  }
  if ((compose.services["integration-tests"]?.volumes ?? []).length !== 0) {
    throw new Error("integration tests must run from the image without source mounts");
  }
  if (JSON.stringify(compose.services.minio).includes("9001")) {
    throw new Error("MinIO console must not be exposed");
  }
  const healthcheck = JSON.stringify(compose.services.app?.healthcheck ?? {});
  if (
    !healthcheck.includes("/run/tls/ca.crt") ||
    healthcheck.includes("rejectUnauthorized:false")
  ) {
    throw new Error("app healthcheck must verify TLS with the generated CA");
  }
  if (JSON.stringify(compose.services.app?.volumes ?? {}).includes("ca.key")) {
    throw new Error("the CA private key must not be mounted into the app");
  }
  process.stdout.write("Compose configuration is secure and valid.\n");
});
'

./infra/test-setup.sh
./infra/validate-runtime-layout.sh
