#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f infra/.env ]]; then
  echo "No generated reference installation was found."
  exit 0
fi

args=(down)
if [[ "${1:-}" == "--volumes" ]]; then
  args+=(--volumes)
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--volumes]" >&2
  exit 2
fi

docker compose --env-file infra/.env -f infra/docker-compose.yml "${args[@]}"
