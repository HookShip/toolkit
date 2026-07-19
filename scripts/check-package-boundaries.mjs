// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "packages");
const appRoot = path.join(root, "apps");
const extensionAssetRoots = [
  path.join(root, "extensions"),
  path.join(root, "examples", "extensions"),
];

export const publicPackageDirectories = new Set([
  "adapter-conformance",
  "adapter-generic-http",
  "adapter-sdk",
  "canonical-model",
  "cli",
  "compatibility-report",
  "contract-core",
  "extension-conformance",
  "extension-sdk",
  "migration-assessment",
  "portal-components",
  "signing",
  "support-evidence",
]);

export const privateAppDirectories = new Set(["reference-server"]);

const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const importPattern =
  /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)/g;

export function workspaceKind(area, directoryName) {
  if (area === "packages" && publicPackageDirectories.has(directoryName)) {
    return "public-package";
  }
  if (area === "apps" && privateAppDirectories.has(directoryName)) {
    return "private-app";
  }
  return undefined;
}

export function isAllowedDirection(fromKind, toKind) {
  if (fromKind === "public-package") return toKind === "public-package";
  if (fromKind === "private-app") return toKind === "public-package";
  return false;
}

const extensionSdkDependencies = new Set([
  "@webhook-portal/adapter-sdk",
  "@webhook-portal/canonical-model",
  "@webhook-portal/signing",
]);

export function isAllowedWorkspaceDependency(
  fromArea,
  fromDirectory,
  toKind,
  toPackageName,
) {
  const fromKind = workspaceKind(fromArea, fromDirectory);
  if (!fromKind || !isAllowedDirection(fromKind, toKind)) return false;
  if (fromArea === "packages" && fromDirectory === "extension-sdk") {
    return extensionSdkDependencies.has(toPackageName);
  }
  return true;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function isToolkitExtensionAssetTarget(kind, candidate) {
  if (kind !== "public-package" && kind !== "private-app") return false;
  return extensionAssetRoots.some((directory) =>
    isWithin(directory, candidate),
  );
}

export function workspacePackageName(specifier) {
  if (!specifier.startsWith("@webhook-portal/")) return undefined;
  return specifier.split("/").slice(0, 2).join("/");
}

async function workspaceEntries(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function readManifest(directory) {
  return JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
}

async function sourceFiles(directory) {
  const files = [];

  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (sourceExtensions.has(path.extname(entry.name))) {
        files.push(entryPath);
      }
    }
  }

  await visit(directory);
  return files;
}

function dependencyNames(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  });
}

function importedSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(importPattern)) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  }
  return specifiers;
}

function targetFromRelativeImport(file, specifier, workspacesByPath) {
  const resolved = path.resolve(path.dirname(file), specifier);
  return workspacesByPath.find((workspace) =>
    isWithin(workspace.directory, resolved),
  );
}

function validateManifest(workspace, violations) {
  const { kind, manifest } = workspace;
  if (manifest.license !== "Apache-2.0") {
    violations.push(`${manifest.name}: license must be Apache-2.0`);
  }
  if (kind === "public-package") {
    if (manifest.private === true) {
      violations.push(`${manifest.name}: public packages must not be private`);
    }
    if (manifest.publishConfig?.access !== "public") {
      violations.push(
        `${manifest.name}: public packages must set publishConfig.access=public`,
      );
    }
  }
  if (kind === "private-app") {
    if (manifest.private !== true) {
      violations.push(`${manifest.name}: app wrappers must set private=true`);
    }
    if (manifest.publishConfig !== undefined) {
      violations.push(
        `${manifest.name}: private app wrappers must not declare publishConfig`,
      );
    }
  }
}

export async function checkBoundaries() {
  const workspaces = [];
  const workspaceByName = new Map();
  const violations = [];

  for (const area of ["packages", "apps"]) {
    const areaRoot = area === "packages" ? packageRoot : appRoot;
    for (const directoryName of await workspaceEntries(areaRoot)) {
      const directory = path.join(areaRoot, directoryName);
      const manifest = await readManifest(directory);
      const kind = workspaceKind(area, directoryName);
      if (!kind) {
        violations.push(
          `${area}/${directoryName}: workspace is not part of the public toolkit inventory`,
        );
        continue;
      }
      const workspace = { area, directory, directoryName, kind, manifest };
      workspaces.push(workspace);
      if (workspaceByName.has(manifest.name)) {
        violations.push(`${manifest.name}: duplicate workspace package name`);
      }
      workspaceByName.set(manifest.name, workspace);
      validateManifest(workspace, violations);
    }
  }

  const workspacesByPath = [...workspaces].sort(
    (left, right) => right.directory.length - left.directory.length,
  );

  for (const workspace of workspaces) {
    for (const dependency of dependencyNames(workspace.manifest)) {
      const dependencyName = workspacePackageName(dependency);
      if (!dependencyName) continue;

      const target = workspaceByName.get(dependencyName);
      if (!target) {
        violations.push(
          `${workspace.manifest.name}: unknown toolkit dependency ${dependencyName}`,
        );
      } else if (
        !isAllowedWorkspaceDependency(
          workspace.area,
          workspace.directoryName,
          target.kind,
          dependencyName,
        )
      ) {
        violations.push(
          `${workspace.manifest.name}: ${workspace.kind} must not depend on ${target.kind} ${dependencyName}`,
        );
      }
    }

    for (const file of await sourceFiles(
      path.join(workspace.directory, "src"),
    )) {
      const source = await readFile(file, "utf8");
      for (const specifier of importedSpecifiers(source)) {
        const relativeFile = path.relative(root, file);
        const dependencyName = workspacePackageName(specifier);
        let target;

        if (specifier.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), specifier);
          if (isToolkitExtensionAssetTarget(workspace.kind, resolved)) {
            violations.push(
              `${relativeFile}: toolkit workspaces must not import extension data assets ${specifier}`,
            );
            continue;
          }
        }

        if (dependencyName) {
          target = workspaceByName.get(dependencyName);
          if (!target) {
            violations.push(
              `${relativeFile}: unknown toolkit import ${dependencyName}`,
            );
            continue;
          }
        } else if (specifier.startsWith(".")) {
          target = targetFromRelativeImport(file, specifier, workspacesByPath);
        }

        if (
          target &&
          target !== workspace &&
          !isAllowedWorkspaceDependency(
            workspace.area,
            workspace.directoryName,
            target.kind,
            target.manifest.name,
          )
        ) {
          violations.push(
            `${relativeFile}: ${workspace.kind} must not import ${target.kind} ${target.manifest.name}`,
          );
        }
      }
    }
  }

  return violations.sort();
}

async function main() {
  const violations = await checkBoundaries();
  if (violations.length > 0) {
    console.error("Package boundary violations:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Package boundaries are valid.");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
