// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerignore = await readFile(path.join(root, ".dockerignore"), "utf8");

function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function dockerPatternRegex(pattern) {
  const normalized = pattern
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(character);
    }
  }
  const prefix = normalized.includes("/") ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${source}(?:/.*)?$`, "u");
}

const rules = dockerignore
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => ({
    excluded: !line.startsWith("!"),
    pattern: dockerPatternRegex(line.startsWith("!") ? line.slice(1) : line),
  }));

function isExcluded(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, "/");
  let excluded = false;
  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      excluded = rule.excluded;
    }
  }
  return excluded;
}

for (const secretEnvironmentPath of [
  ".env",
  ".env.local",
  ".env.production",
  "apps/reference-server/.env",
  "packages/cli/.env.test",
  "nested/deeper/.env.credentials",
  "nested/deeper/.env.example.local",
]) {
  if (!isExcluded(secretEnvironmentPath)) {
    throw new Error(
      `Environment secret unexpectedly enters the Docker context: ${secretEnvironmentPath}`,
    );
  }
}

for (const safeTemplatePath of [
  ".env.example",
  "infra/.env.example",
  "nested/deeper/.env.example",
]) {
  if (isExcluded(safeTemplatePath)) {
    throw new Error(
      `Safe environment template is excluded from the Docker context: ${safeTemplatePath}`,
    );
  }
}

const required = new Set([
  "infra/.env.example",
  "infra/migrations/010_payload_store_identity.sql",
  "packages/cli/test/reference-migrations.test.ts",
  "packages/cli/test/reference-minio.integration.test.ts",
  "packages/cli/test/reference-repository.contract.test.ts",
]);

async function listSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      [".turbo", "dist", "node_modules"].includes(entry.name)
    ) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    }
  }
  return files;
}

const files = (
  await Promise.all(
    ["apps", "infra", "packages"].map((directory) =>
      listSourceFiles(path.join(root, directory)),
    ),
  )
).flat();

for (const relativePath of required) {
  if (!files.includes(relativePath)) {
    throw new Error(
      `Required integration context file is missing: ${relativePath}`,
    );
  }
  if (isExcluded(relativePath)) {
    throw new Error(
      `Required integration context file is excluded: ${relativePath}`,
    );
  }
}

for (const relativePath of files) {
  const basename = path.posix.basename(relativePath);
  if (
    (basename === ".env" ||
      (basename.startsWith(".env.") && basename !== ".env.example")) &&
    !isExcluded(relativePath)
  ) {
    throw new Error(
      `Environment secret unexpectedly enters the Docker context: ${relativePath}`,
    );
  }
  if (basename === ".env.example" && isExcluded(relativePath)) {
    throw new Error(
      `Safe environment template is excluded from the Docker context: ${relativePath}`,
    );
  }
  if (
    relativePath.includes("/test/") &&
    !required.has(relativePath) &&
    !isExcluded(relativePath)
  ) {
    throw new Error(
      `Development-only test unexpectedly enters the Docker context: ${relativePath}`,
    );
  }
}

process.stdout.write(
  "Docker context excludes environment secrets and includes only required integration tests.\n",
);
