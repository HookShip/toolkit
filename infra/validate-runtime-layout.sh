#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAYOUT="$ROOT/.docker-layout-validation"

cleanup() {
  rm -rf "$LAYOUT"
}
trap cleanup EXIT

cd "$ROOT"
rm -rf "$LAYOUT"
node infra/validate-docker-context.mjs
pnpm --filter @webhook-portal/reference-server... build >/dev/null
pnpm --config.inject-workspace-packages=true \
  --filter @webhook-portal/reference-server \
  deploy --prod "$LAYOUT" >/dev/null

node --input-type=module - "$LAYOUT" <<'NODE'
import { access, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2];
for (const relative of [
  "package.json",
  "README.md",
  "dist/index.js",
  "dist/migrate.js",
  "node_modules/@webhook-portal/cli/dist/reference-server/runtime.js",
]) {
  await access(path.join(root, relative));
}

const entries = new Set(await readdir(root));
for (const unwanted of [
  ".turbo",
  "src",
  "test",
  "tsconfig.json",
  "tsconfig.test.json",
]) {
  if (entries.has(unwanted)) {
    throw new Error(`Production deploy unexpectedly contains ${unwanted}.`);
  }
}

for (const relative of [
  "test",
  "node_modules/@webhook-portal/cli/src",
  "node_modules/@webhook-portal/cli/test",
  "node_modules/@webhook-portal/cli/tsconfig.test.json",
]) {
  try {
    await access(path.join(root, relative));
    throw new Error(
      `Production deploy unexpectedly contains ${relative}.`,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
}

const packages = await readdir(path.join(root, "node_modules/.pnpm"));
for (const developmentOnly of ["typescript@", "vitest@"]) {
  if (packages.some((entry) => entry.startsWith(developmentOnly))) {
    throw new Error(
      `Production deploy unexpectedly contains ${developmentOnly.slice(0, -1)}.`,
    );
  }
}
NODE

echo "Production Docker runtime layout is valid."
