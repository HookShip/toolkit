// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  changelogAnyStatusLine,
  changelogReadyStatusLine,
  changelogUnreleasedStatus,
  expectedOwnership,
  manifestPath,
  publicPackageCount,
  readJson,
  referenceAppPath,
  releaseStatuses,
  repositoryType,
  repositoryUrl,
  root,
  semverPattern,
  supportedSchemaVersion,
} from "./release-context.mjs";

export function validateRepository(repository, directory, label) {
  const failures = [];
  if (
    repository === null ||
    typeof repository !== "object" ||
    Array.isArray(repository)
  ) {
    failures.push(`${label}: repository provenance metadata is missing`);
    return failures;
  }
  if (
    !sameValues(Object.keys(repository).sort(), ["directory", "type", "url"])
  ) {
    failures.push(
      `${label}: repository must contain exactly type, url, and directory`,
    );
  }
  if (repository.type !== repositoryType) {
    failures.push(`${label}: repository.type must be "${repositoryType}"`);
  }
  if (repository.url !== repositoryUrl) {
    failures.push(`${label}: repository.url must be "${repositoryUrl}"`);
  }
  if (repository.directory !== directory) {
    failures.push(
      `${label}: repository.directory must be "${directory}" (got "${repository.directory}")`,
    );
  }
  return failures;
}

export async function loadManifest() {
  const manifest = await readJson(manifestPath);
  if (manifest.schemaVersion !== supportedSchemaVersion) {
    throw new Error(
      `release/manifest.json must use schemaVersion ${supportedSchemaVersion}`,
    );
  }
  return manifest;
}

export function cohortVersion(manifest) {
  const versions = new Set(
    (manifest.openPackages ?? []).map((entry) => entry.version),
  );
  if (versions.size !== 1) {
    throw new Error("all public packages must use one coordinated version");
  }
  return [...versions][0];
}

export async function packageManifest(packageEntry) {
  return readJson(path.join(root, packageEntry.path, "package.json"));
}

export async function publicPackagePaths() {
  const entries = await readdir(path.join(root, "packages"), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .sort();
}

export function sameValues(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export async function checkReferenceApp(failures) {
  try {
    const pkg = await readJson(
      path.join(root, referenceAppPath, "package.json"),
    );
    if (pkg.name !== "@webhook-portal/reference-server") {
      failures.push(`${referenceAppPath}: package name mismatch`);
    }
    if (pkg.private !== true) {
      failures.push(`${pkg.name}: packaging wrapper must remain private`);
    }
    if (pkg.license !== "Apache-2.0") {
      failures.push(`${pkg.name}: license must be Apache-2.0`);
    }
    if (pkg.publishConfig !== undefined) {
      failures.push(`${pkg.name}: private wrapper must not be publishable`);
    }
    if (
      pkg.dependencies?.["@webhook-portal/reference-server-core"] !==
      "workspace:*"
    ) {
      failures.push(
        `${pkg.name}: wrapper must depend on @webhook-portal/reference-server-core via workspace:*`,
      );
    }
    if (Object.keys(pkg.dependencies ?? {}).length !== 1) {
      failures.push(
        `${pkg.name}: wrapper runtime dependencies must contain only @webhook-portal/reference-server-core`,
      );
    }
  } catch (error) {
    failures.push(`${referenceAppPath}: ${error.message}`);
  }
}

export function validateOwnership(manifest, failures) {
  const ownership = manifest.ownership;
  if (ownership === null || typeof ownership !== "object") {
    failures.push("release manifest must declare an ownership block");
    return;
  }
  const allowedKeys = [
    "coordinatedVersioning",
    "note",
    "rename",
    "scope",
    "sourceOfTruth",
  ];
  if (!sameValues(Object.keys(ownership).sort(), allowedKeys)) {
    failures.push(`ownership must contain exactly: ${allowedKeys.join(", ")}`);
  }
  for (const [key, expected] of Object.entries(expectedOwnership)) {
    if (ownership[key] !== expected) {
      failures.push(`ownership.${key} must be "${expected}"`);
    }
  }
  if (typeof ownership.note !== "string" || ownership.note.trim() === "") {
    failures.push("ownership.note must be a non-empty string");
  }
}

export async function check() {
  const manifest = await loadManifest();
  const failures = [];
  const packageNames = new Set();
  const packagePaths = new Set();
  const manifestKeys = Object.keys(manifest).sort();

  if (
    !sameValues(manifestKeys, [
      "openPackages",
      "ownership",
      "releaseStatus",
      "schemaVersion",
    ])
  ) {
    failures.push(
      "release manifest may contain only schemaVersion, releaseStatus, ownership, and openPackages",
    );
  }
  validateOwnership(manifest, failures);
  if (!releaseStatuses.has(manifest.releaseStatus)) {
    failures.push(
      'releaseStatus must be "unreleased" or "ready" (staged for release)',
    );
  }
  if (
    !Array.isArray(manifest.openPackages) ||
    manifest.openPackages.length !== publicPackageCount
  ) {
    failures.push(
      `the public package cohort must contain exactly ${publicPackageCount} packages`,
    );
  }

  for (const entry of manifest.openPackages ?? []) {
    if (packageNames.has(entry.name)) {
      failures.push(`duplicate package ${entry.name}`);
    }
    if (packagePaths.has(entry.path)) {
      failures.push(`duplicate package path ${entry.path}`);
    }
    packageNames.add(entry.name);
    packagePaths.add(entry.path);

    if (!entry.path.startsWith("packages/")) {
      failures.push(`${entry.name}: release path must be under packages/`);
    }
    if (
      typeof manifest.ownership?.scope === "string" &&
      !entry.name.startsWith(`${manifest.ownership.scope}/`)
    ) {
      failures.push(
        `${entry.name}: release package must be under the ${manifest.ownership.scope} scope`,
      );
    }
    if (!semverPattern.test(entry.version)) {
      failures.push(`${entry.name}: invalid release version ${entry.version}`);
    }
    try {
      const pkg = await packageManifest(entry);
      if (pkg.name !== entry.name)
        failures.push(`${entry.path}: name mismatch`);
      if (pkg.version !== entry.version) {
        failures.push(`${entry.name}: version mismatch`);
      }
      if (pkg.private === true) {
        failures.push(`${entry.name}: release package is private`);
      }
      if (pkg.license !== "Apache-2.0") {
        failures.push(`${entry.name}: license must be Apache-2.0`);
      }
      if (pkg.publishConfig?.access !== "public") {
        failures.push(`${entry.name}: publishConfig.access must be public`);
      }
      if (pkg.engines?.node !== ">=22") {
        failures.push(`${entry.name}: Node engine mismatch`);
      }
      if (!pkg.exports && !pkg.bin) {
        failures.push(`${entry.name}: no exports or bin`);
      }
      if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
        failures.push(`${entry.name}: package files allowlist is missing`);
      }
      for (const failure of validateRepository(
        pkg.repository,
        entry.path,
        entry.name,
      )) {
        failures.push(failure);
      }
    } catch (error) {
      failures.push(`${entry.path}: ${error.message}`);
    }
  }

  const cohortVersions = new Set(
    (manifest.openPackages ?? []).map((entry) => entry.version),
  );
  const coordinatedVersion =
    cohortVersions.size === 1 ? [...cohortVersions][0] : null;
  if (coordinatedVersion === null) {
    failures.push("all public packages must use one coordinated version");
  }

  for (const entry of manifest.openPackages ?? []) {
    try {
      const pkg = await packageManifest(entry);
      const runtimeDependencies = {
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      };
      for (const [dependency, range] of Object.entries(runtimeDependencies)) {
        if (!dependency.startsWith("@webhook-portal/")) continue;
        if (!packageNames.has(dependency)) {
          failures.push(
            `${entry.name}: public runtime dependency ${dependency} is outside the release cohort`,
          );
        }
        if (!String(range).startsWith("workspace:")) {
          failures.push(
            `${entry.name}: internal dependency ${dependency} must use workspace protocol before packing`,
          );
        }
      }
    } catch {
      // The primary package metadata check reports the file error.
    }
  }

  const actualPaths = await publicPackagePaths();
  const declaredPaths = [...packagePaths].sort();
  if (!sameValues(actualPaths, declaredPaths)) {
    failures.push(
      `release package paths must match packages/: expected ${actualPaths.join(", ")}`,
    );
  }

  await checkReferenceApp(failures);

  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes("## [Unreleased]")) {
    failures.push("CHANGELOG.md must contain an Unreleased section");
  }
  if (
    coordinatedVersion !== null &&
    !changelog.includes(`Planned package cohort: \`${coordinatedVersion}\``)
  ) {
    failures.push(
      `CHANGELOG.md must identify the planned package cohort version (\`${coordinatedVersion}\`)`,
    );
  }
  // The changelog status marker must agree with the manifest lifecycle state so
  // a stage/reset cannot update one without the other.
  const hasUnreleasedMarker = changelog.includes(changelogUnreleasedStatus);
  const hasReadyMarker = changelogReadyStatusLine.test(changelog);
  if (!changelogAnyStatusLine.test(changelog)) {
    failures.push('CHANGELOG.md must contain a "Release status:" marker line');
  } else if (manifest.releaseStatus === "unreleased" && !hasUnreleasedMarker) {
    failures.push(
      'CHANGELOG.md must record "Release status: unreleased." while the manifest is unreleased',
    );
  } else if (manifest.releaseStatus === "ready" && !hasReadyMarker) {
    failures.push(
      'CHANGELOG.md must record "Release status: ready." while the manifest is ready',
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Release consistency failures:\n- ${failures.join("\n- ")}`,
    );
  }
  console.log(
    `All ${publicPackageCount} public packages and the private Apache-2.0 reference wrapper are release-consistent.`,
  );
}
