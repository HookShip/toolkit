// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = [path.join(root, "packages"), path.join(root, "apps")];

/**
 * Maximum line count for a toolkit source file. Files above this must be
 * decomposed. Existing hotspots are grandfathered through {@link allowlist} and
 * may only shrink — never grow — so decomposition ratchets monotonically.
 */
export const maximumSourceLines = 800;

/**
 * Grandfathered oversized source files, mapped to the line count they may not
 * exceed. Shrink an entry (or delete it once the file drops to
 * {@link maximumSourceLines} or fewer lines) as decomposition lands. Do not add
 * new entries: a genuinely new oversized file is a ratchet failure.
 */
export const allowlist = new Map([
  ["packages/adapter-conformance/src/harness.ts", 1365],
  ["packages/adapter-generic-http/src/adapter.ts", 2178],
  ["packages/adapter-sdk/src/metadata.ts", 1102],
  ["packages/reference-server-core/src/memory-repository.ts", 1786],
  ["packages/reference-server-core/src/migrations.ts", 1385],
  ["packages/reference-server-core/src/payload-storage.ts", 1827],
  ["packages/reference-server-core/src/postgres-repository.ts", 2504],
  ["packages/reference-server-core/src/server.ts", 2332],
  ["packages/reference-server-core/src/service.ts", 2175],
  ["packages/contract-core/src/diff.ts", 1720],
  ["packages/contract-core/src/fixtures.ts", 1030],
  ["packages/contract-core/src/normalize.ts", 2223],
  ["packages/contract-core/src/schema-processing.ts", 1276],
  ["packages/extension-sdk/src/bundle.ts", 840],
  ["packages/extension-sdk/src/manifest.ts", 1017],
  ["packages/migration-assessment/src/assessment.ts", 860],
  ["packages/migration-assessment/src/import.ts", 1085],
  ["packages/support-evidence/src/fail-closed-validation.ts", 840],
]);

const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const ignoredDirectories = new Set([
  "dist",
  "node_modules",
  ".turbo",
  ".next",
  "coverage",
  "generated",
  "test",
  "tests",
  "__tests__",
]);

function isSourceFile(relativePath) {
  const base = path.basename(relativePath);
  if (base.endsWith(".d.ts") || base.includes(".generated.")) {
    return false;
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/u.test(base)) {
    return false;
  }
  return sourceExtensions.has(path.extname(relativePath));
}

async function collectSourceFiles(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await collectSourceFiles(absolute, files);
      }
    } else if (entry.isFile()) {
      const relative = path.relative(root, absolute);
      if (isSourceFile(relative)) {
        files.push(relative);
      }
    }
  }
  return files;
}

async function countLines(relativePath) {
  const contents = await readFile(path.join(root, relativePath), "utf8");
  if (contents.length === 0) {
    return 0;
  }
  const withoutTrailingNewline = contents.endsWith("\n")
    ? contents.slice(0, -1)
    : contents;
  return withoutTrailingNewline.split("\n").length;
}

export async function evaluateSourceSizes() {
  const files = [];
  for (const scanRoot of scanRoots) {
    await collectSourceFiles(scanRoot, files);
  }
  files.sort();

  const violations = [];
  const seenAllowlisted = new Set();

  for (const relative of files) {
    const lines = await countLines(relative);
    const key = relative.split(path.sep).join("/");
    const allowed = allowlist.get(key);
    if (allowed === undefined) {
      if (lines > maximumSourceLines) {
        violations.push(
          `${key} has ${lines} lines (limit ${maximumSourceLines}). ` +
            `Decompose it or, only if unavoidable, add it to the ratchet allowlist.`,
        );
      }
      continue;
    }
    seenAllowlisted.add(key);
    if (lines > allowed) {
      violations.push(
        `${key} grew to ${lines} lines but is ratcheted at ${allowed}. ` +
          `Oversized files may only shrink.`,
      );
    } else if (lines <= maximumSourceLines) {
      violations.push(
        `${key} is now ${lines} lines (<= ${maximumSourceLines}). ` +
          `Remove it from the ratchet allowlist to lock in the win.`,
      );
    }
  }

  for (const key of allowlist.keys()) {
    if (!seenAllowlisted.has(key)) {
      let exists = true;
      try {
        await stat(path.join(root, key));
      } catch {
        exists = false;
      }
      violations.push(
        exists
          ? `${key} is allowlisted but was not scanned; update the ratchet allowlist.`
          : `${key} is in the ratchet allowlist but no longer exists; remove the entry.`,
      );
    }
  }

  return { files, violations };
}

async function main() {
  const { files, violations } = await evaluateSourceSizes();
  if (violations.length > 0) {
    console.error("Source-size ratchet violations:");
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exitCode = 1;
    return;
  }
  console.error(
    `Source-size ratchet satisfied: ${files.length} files scanned, ` +
      `${allowlist.size} grandfathered hotspots, limit ${maximumSourceLines} lines.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
