#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Packs all 13 public packages with `pnpm pack` and verifies the package
# that a real `npm install` would actually produce, independent of the
# in-workspace build tree:
#   - LICENSE, README, and package.json are present (LICENSE is injected
#     automatically by `pnpm pack` from the workspace root since these
#     packages do not ship their own copy);
#   - no dev-only workspace surface (src/, test/, tsconfig*.json, .turbo)
#     leaked into the tarball, i.e. the "files" allowlist is correct;
#   - every file referenced by "exports"/"types"/"bin" in the packed
#     package.json actually exists in the tarball.
#
# It then installs all tarballs together into an isolated npm project with no
# workspace/monorepo context, imports every public entry point, and invokes the
# packed CLI binary. Installing the complete release set at once lets npm
# satisfy internal @webhook-portal dependencies from the local tarballs,
# proving the packages work as publishable artifacts before a registry exists.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PACKAGES=()
while IFS= read -r package_dir; do
  PACKAGES+=("$package_dir")
done < <(node scripts/release.mjs list-packages)

WORKDIR="$ROOT/.pack-smoke-work"
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

TARBALLS=()

echo "Packing ${#PACKAGES[@]} publishable package(s) into $WORKDIR ..."

for package_dir in "${PACKAGES[@]}"; do
  name="$(node -p "require('./$package_dir/package.json').name")"
  version="$(node -p "require('./$package_dir/package.json').version")"
  echo
  echo "== $name@$version =="

  pack_dir="$WORKDIR/tarballs/$(basename "$package_dir")"
  mkdir -p "$pack_dir"
  (cd "$package_dir" && pnpm pack --pack-destination "$pack_dir" >/dev/null)

  tarball="$(find "$pack_dir" -maxdepth 1 -name '*.tgz')"
  if [[ -z "$tarball" ]]; then
    echo "no tarball produced for $name" >&2
    exit 1
  fi
  TARBALLS+=("$tarball")

  extract_dir="$WORKDIR/extract/$(basename "$package_dir")"
  mkdir -p "$extract_dir"
  tar xzf "$tarball" -C "$extract_dir"
  contents_dir="$extract_dir/package"

  for required in package.json README.md LICENSE; do
    if [[ ! -f "$contents_dir/$required" ]]; then
      echo "$name: packed tarball is missing $required" >&2
      exit 1
    fi
  done

  for unwanted in src test tsconfig.json tsconfig.test.json .turbo; do
    if [[ -e "$contents_dir/$unwanted" ]]; then
      echo "$name: packed tarball unexpectedly contains $unwanted" >&2
      exit 1
    fi
  done

  node --input-type=module -e "
    import { access, readFile, stat } from 'node:fs/promises';
    import path from 'node:path';

    const contentsDir = process.argv[1];
    const pkg = JSON.parse(
      await readFile(path.join(contentsDir, 'package.json'), 'utf8'),
    );

    const referenced = new Set();
    function collectExportPaths(node) {
      if (typeof node === 'string') {
        referenced.add(node);
      } else if (node && typeof node === 'object') {
        for (const value of Object.values(node)) {
          collectExportPaths(value);
        }
      }
    }
    if (pkg.exports) collectExportPaths(pkg.exports);
    if (pkg.types) referenced.add(pkg.types);
    const binPaths = new Set();
    if (typeof pkg.bin === 'string') {
      referenced.add(pkg.bin);
      binPaths.add(pkg.bin);
    }
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const value of Object.values(pkg.bin)) {
        referenced.add(value);
        binPaths.add(value);
      }
    }

    if (referenced.size === 0) {
      throw new Error('package.json declares no exports/types/bin entry to verify');
    }
    for (const relative of referenced) {
      await access(path.join(contentsDir, relative));
    }
    for (const relative of binPaths) {
      const absolute = path.join(contentsDir, relative);
      const metadata = await stat(absolute);
      if ((metadata.mode & 0o111) === 0) {
        throw new Error(\`packed bin is not executable: \${relative}\`);
      }
      const source = await readFile(absolute, 'utf8');
      if (!source.startsWith('#!/usr/bin/env node')) {
        throw new Error(\`packed bin has no Node.js shebang: \${relative}\`);
      }
    }
    console.log(\`  verified \${referenced.size} declared entry point(s) exist in the tarball\`);
  " "$contents_dir"

  echo "  OK: LICENSE/README present, no dev-only files leaked"
done

echo
echo "Installing the complete tarball set into a clean npm project ..."
install_dir="$WORKDIR/install"
mkdir -p "$install_dir"
(
  cd "$install_dir"
  npm init --yes >/dev/null 2>&1
  npm install --no-audit --no-fund --omit=dev \
    "${TARBALLS[@]}" \
    "typescript@6.0.3"

  node --input-type=module -e '
    const entryPoints = [
      "@webhook-portal/canonical-model",
      "@webhook-portal/contract-core",
      "@webhook-portal/signing",
      "@webhook-portal/adapter-sdk",
      "@webhook-portal/adapter-conformance",
      "@webhook-portal/adapter-generic-http",
      "@webhook-portal/extension-sdk",
      "@webhook-portal/extension-sdk/transform",
      "@webhook-portal/extension-conformance",
      "@webhook-portal/extension-conformance/runner",
      "@webhook-portal/compatibility-report",
      "@webhook-portal/migration-assessment",
      "@webhook-portal/support-evidence",
      "@webhook-portal/portal-components",
      "@webhook-portal/cli",
      "@webhook-portal/cli/reference-server",
    ];
    for (const entryPoint of entryPoints) {
      const loaded = await import(entryPoint);
      if (loaded === undefined) {
        throw new Error(`failed to import ${entryPoint}`);
      }
      console.log(`  imported ${entryPoint}`);
    }
  '

  if [[ ! -f node_modules/@types/pg/package.json ]]; then
    echo "packed CLI did not install @types/pg as a production dependency" >&2
    exit 1
  fi

  cat > consumer.ts <<'EOF'
import {
  PostgresReferenceRepository,
  type BuildReferenceServerOptions,
} from "@webhook-portal/cli/reference-server";

const repositoryConstructor = PostgresReferenceRepository;
const acceptsOptions = (options: BuildReferenceServerOptions): void => {
  void options;
};

void repositoryConstructor;
void acceptsOptions;
EOF
  cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "skipLibCheck": true,
    "strict": true,
    "target": "ES2022",
    "types": []
  },
  "include": ["consumer.ts"]
}
EOF
  ./node_modules/.bin/tsc --project tsconfig.json
  echo "  compiled a clean TypeScript consumer of the packed reference-server export"

  help_output="$(./node_modules/.bin/webhook-portal --help)"
  if [[ "$help_output" != *"Usage: webhook-portal <command> [options]"* ]]; then
    echo "packed CLI binary did not return the expected help output" >&2
    exit 1
  fi
  echo "  invoked packed webhook-portal binary"
)

echo
echo "All packages have correct tarball contents and install together cleanly."
