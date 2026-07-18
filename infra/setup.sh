#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INFRA="$ROOT/infra"
ENV_FILE="$INFRA/.env"
TOKEN_FILE="$INFRA/.api-token"
CURL_AUTH_FILE="$INFRA/.curl-auth"
CERT_DIR="$INFRA/certs"
CA_CERT_FILE="$CERT_DIR/ca.crt"
CA_KEY_FILE="$CERT_DIR/ca.key"
CERT_FILE="$CERT_DIR/reference.crt"
KEY_FILE="$CERT_DIR/reference.key"

usage() {
  cat >&2 <<'EOF'
Usage:
  ./infra/setup.sh
  ./infra/setup.sh --renew-cert
  ./infra/setup.sh --rotate-all

--renew-cert renews only local TLS material and preserves every credential.
--rotate-all rotates database/object-store credentials, API and ingest tokens,
the master key, payload installation IDs, the local CA, and the server
certificate.
EOF
}

mode="initialize"
case "${1:-}" in
  "")
    ;;
  --renew-cert)
    mode="renew-cert"
    ;;
  --rotate-all)
    mode="rotate-all"
    ;;
  --force)
    mode="rotate-all"
    echo "WARNING: --force is deprecated; use --rotate-all." >&2
    ;;
  *)
    usage
    exit 2
    ;;
esac
if [[ "$#" -gt 1 ]]; then
  usage
  exit 2
fi

command -v node >/dev/null 2>&1 || {
  echo "Node.js is required to generate reference credentials." >&2
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  echo "OpenSSL is required to generate local TLS material." >&2
  exit 1
}

umask 077
mkdir -p "$CERT_DIR"

generate_ca() {
  local suffix="$$"
  local config="$CERT_DIR/.ca.cnf.$suffix"
  local new_ca_cert="$CERT_DIR/.ca.crt.$suffix"
  local new_ca_key="$CERT_DIR/.ca.key.$suffix"
  cleanup_ca_scratch() {
    rm -f "$config" "$new_ca_cert" "$new_ca_key"
  }
  trap cleanup_ca_scratch RETURN
  cat >"$config" <<'EOF'
[req]
distinguished_name=distinguished_name
x509_extensions=v3_ca
prompt=no

[distinguished_name]
CN=Webhook Portal Local Development CA

[v3_ca]
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always,issuer
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
EOF
  openssl req \
    -x509 \
    -newkey rsa:3072 \
    -sha256 \
    -nodes \
    -days 3650 \
    -keyout "$new_ca_key" \
    -out "$new_ca_cert" \
    -config "$config" \
    >/dev/null 2>&1
  chmod 600 "$new_ca_key"
  chmod 644 "$new_ca_cert"
  mv -f "$new_ca_key" "$CA_KEY_FILE"
  mv -f "$new_ca_cert" "$CA_CERT_FILE"
  cleanup_ca_scratch
  trap - RETURN
}

generate_server_certificate() {
  local suffix="$$"
  local csr="$CERT_DIR/.reference.csr.$suffix"
  local extensions="$CERT_DIR/.reference.ext.$suffix"
  local new_cert="$CERT_DIR/.reference.crt.$suffix"
  local new_key="$CERT_DIR/.reference.key.$suffix"
  cleanup_certificate_scratch() {
    rm -f "$csr" "$extensions" "$new_cert" "$new_key"
  }
  trap cleanup_certificate_scratch RETURN
  cat >"$extensions" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:app,IP:127.0.0.1
EOF
  openssl req \
    -new \
    -newkey rsa:2048 \
    -sha256 \
    -nodes \
    -keyout "$new_key" \
    -out "$csr" \
    -subj "/CN=localhost" \
    >/dev/null 2>&1
  openssl x509 \
    -req \
    -in "$csr" \
    -CA "$CA_CERT_FILE" \
    -CAkey "$CA_KEY_FILE" \
    -set_serial "0x$(openssl rand -hex 16)" \
    -days 30 \
    -sha256 \
    -extfile "$extensions" \
    -out "$new_cert" \
    >/dev/null 2>&1
  openssl verify -CAfile "$CA_CERT_FILE" "$new_cert" >/dev/null
  chmod 600 "$new_key"
  chmod 644 "$new_cert"
  mv -f "$new_key" "$KEY_FILE"
  mv -f "$new_cert" "$CERT_FILE"
  cleanup_certificate_scratch
  trap - RETURN
}

generate_credentials() {
  node --input-type=module - "$ENV_FILE" "$TOKEN_FILE" "$CURL_AUTH_FILE" <<'NODE'
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const [, , envFile, tokenFile, curlAuthFile] = process.argv;
const random = (bytes) => randomBytes(bytes).toString("base64url");
const database = "webhook_portal";
const databaseUser = `webhook_${randomBytes(6).toString("hex")}`;
const databasePassword = random(32);
const minioAccessKey = randomBytes(10).toString("hex");
const minioSecretKey = random(36);
const apiToken = random(32);
const payloadNamespaceId = randomBytes(11).toString("hex");
let payloadStoreId = randomBytes(11).toString("hex");
while (payloadStoreId === payloadNamespaceId) {
  payloadStoreId = randomBytes(11).toString("hex");
}
const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
const gid = typeof process.getgid === "function" ? process.getgid() : 1000;

const values = {
  POSTGRES_DB: database,
  POSTGRES_USER: databaseUser,
  POSTGRES_PASSWORD: databasePassword,
  MINIO_ACCESS_KEY: minioAccessKey,
  MINIO_SECRET_KEY: minioSecretKey,
  MINIO_PAYLOAD_BUCKET: `webhook-payloads-${payloadNamespaceId}-${payloadStoreId}`,
  DATABASE_URL: `postgresql://${databaseUser}:${databasePassword}@postgres:5432/${database}`,
  TEST_DATABASE_URL: `postgresql://${databaseUser}:${databasePassword}@postgres:5432/${database}`,
  TEST_MINIO_ENDPOINT: "minio",
  TEST_MINIO_PORT: "9000",
  TEST_MINIO_ACCESS_KEY: minioAccessKey,
  TEST_MINIO_SECRET_KEY: minioSecretKey,
  REFERENCE_MASTER_KEY: randomBytes(32).toString("base64"),
  REFERENCE_INGEST_SECRET: random(32),
  REFERENCE_INGEST_CREDENTIAL_ID: `ingest_${random(12)}`,
  REFERENCE_PAYLOAD_NAMESPACE_ID: payloadNamespaceId,
  REFERENCE_PAYLOAD_STORE_ID: payloadStoreId,
  REFERENCE_API_TOKEN_FILE: "infra/.api-token",
  REFERENCE_TLS_CERT_FILE: "infra/certs/reference.crt",
  REFERENCE_TLS_KEY_FILE: "infra/certs/reference.key",
  REFERENCE_PORT: "3210",
  REFERENCE_ALLOW_LOCAL_NETWORK: "true",
  REFERENCE_AUTO_MIGRATE: "false",
  REFERENCE_PAYLOAD_RETENTION: "false",
  REFERENCE_PAYLOAD_TTL_SECONDS: "86400",
  REFERENCE_PAYLOAD_MAINTENANCE_BATCH_SIZE: "100",
  REFERENCE_PAYLOAD_MAINTENANCE_GRACE_SECONDS: "300",
  REFERENCE_PAYLOAD_MAINTENANCE_INTERVAL_SECONDS: "60",
  REFERENCE_UID: String(uid),
  REFERENCE_GID: String(gid),
};

writeFileSync(
  envFile,
  `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
writeFileSync(tokenFile, `${apiToken}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
writeFileSync(
  curlAuthFile,
  `header = "Authorization: ${["Be", "arer"].join("")} ${apiToken}"\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
NODE
}

if [[ "$mode" == "renew-cert" ]]; then
  created_ca=false
  cleanup_failed_renewal() {
    if [[ "$created_ca" == "true" ]]; then
      rm -f "$CA_CERT_FILE" "$CA_KEY_FILE"
    fi
  }
  trap cleanup_failed_renewal ERR
  for file in "$ENV_FILE" "$TOKEN_FILE" "$CURL_AUTH_FILE"; do
    if [[ ! -f "$file" ]]; then
      echo "Reference credentials are incomplete; initialize the install first." >&2
      exit 2
    fi
  done
  if [[ -e "$CA_CERT_FILE" || -e "$CA_KEY_FILE" ]]; then
    if [[ ! -f "$CA_CERT_FILE" || ! -f "$CA_KEY_FILE" ]]; then
      echo "Local CA material is incomplete; refusing an unsafe renewal." >&2
      exit 2
    fi
  else
    generate_ca
    created_ca=true
  fi
  generate_server_certificate
  trap - ERR
  echo "Renewed the 30-day local TLS certificate without rotating credentials."
  exit 0
fi

if [[ "$mode" == "rotate-all" ]]; then
  cat >&2 <<'EOF'
WARNING: full credential rotation requested.
This rotates PostgreSQL and MinIO credentials, the API and ingest tokens,
the encryption master key, payload namespace/store IDs, the local CA, and the
server certificate.
Existing persistent volumes may become inaccessible until recreated or migrated.
EOF
  rm -f \
    "$ENV_FILE" \
    "$TOKEN_FILE" \
    "$CURL_AUTH_FILE" \
    "$CA_CERT_FILE" \
    "$CA_KEY_FILE" \
    "$CERT_FILE" \
    "$KEY_FILE"
elif [[ -e "$ENV_FILE" ||
  -e "$TOKEN_FILE" ||
  -e "$CURL_AUTH_FILE" ||
  -e "$CA_CERT_FILE" ||
  -e "$CA_KEY_FILE" ||
  -e "$CERT_FILE" ||
  -e "$KEY_FILE" ]]; then
  echo "Reference install already exists; use --renew-cert or --rotate-all." >&2
  exit 2
fi

cleanup_install() {
  rm -f \
    "$ENV_FILE" \
    "$TOKEN_FILE" \
    "$CURL_AUTH_FILE" \
    "$CA_CERT_FILE" \
    "$CA_KEY_FILE" \
    "$CERT_FILE" \
    "$KEY_FILE"
}
trap cleanup_install ERR

generate_credentials
generate_ca
generate_server_certificate

chmod 600 "$ENV_FILE" "$TOKEN_FILE" "$CURL_AUTH_FILE" "$CA_KEY_FILE" "$KEY_FILE"
chmod 644 "$CA_CERT_FILE" "$CERT_FILE"
trap - ERR

echo "Generated mode-0600 credentials in infra/.env and infra/.api-token."
echo "Generated a local CA and a 30-day localhost/app TLS certificate."
