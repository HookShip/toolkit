#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

while IFS= read -r -d '' output_dir; do
  rm -rf "$output_dir"
done < <(
  find apps packages \
    -path '*/node_modules' -prune -o \
    -type d \( -name dist -o -name .turbo \) -print0 -prune
)
rm -rf .turbo

if ! grep -Fqx \
  "pnpm --filter @webhook-portal/cli... build" \
  examples/demo.sh; then
  echo "demo host preparation must build the CLI with workspace dependencies" >&2
  exit 1
fi

pnpm --filter @webhook-portal/cli... build

for output in \
  packages/canonical-model/dist/index.js \
  packages/contract-core/dist/index.js \
  packages/signing/dist/index.js \
  packages/adapter-sdk/dist/index.js \
  packages/adapter-generic-http/dist/index.js \
  packages/cli/dist/index.js \
  packages/cli/dist/bin.js; do
  if [[ ! -f "$output" ]]; then
    echo "demo host preparation did not build $output" >&2
    exit 1
  fi
done

if [[ -e apps/reference-server/dist || -e packages/portal-components/dist ]]; then
  echo "demo host preparation built an unrelated workspace" >&2
  exit 1
fi

echo "Demo host CLI and all workspace dependencies build from clean output state."
