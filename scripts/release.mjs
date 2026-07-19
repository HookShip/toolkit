// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "release", "manifest.json");
const workRoot = path.join(root, ".release-work");
const referenceAppPath = "apps/reference-server";
const publicPackageCount = 13;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function sha256File(file) {
  const content = await readFile(file);
  return createHash("sha256").update(content).digest("hex");
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: process.env,
      stdio: options.quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function loadManifest() {
  const manifest = await readJson(manifestPath);
  if (manifest.schemaVersion !== 1) {
    throw new Error("release/manifest.json must use schemaVersion 1");
  }
  return manifest;
}

async function packageManifest(packageEntry) {
  return readJson(path.join(root, packageEntry.path, "package.json"));
}

async function publicPackagePaths() {
  const entries = await readdir(path.join(root, "packages"), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .sort();
}

function sameValues(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function checkReferenceApp(failures) {
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
    if (pkg.dependencies?.["@webhook-portal/cli"] !== "workspace:*") {
      failures.push(
        `${pkg.name}: wrapper must depend on @webhook-portal/cli via workspace:*`,
      );
    }
    if (Object.keys(pkg.dependencies ?? {}).length !== 1) {
      failures.push(
        `${pkg.name}: wrapper runtime dependencies must contain only @webhook-portal/cli`,
      );
    }
  } catch (error) {
    failures.push(`${referenceAppPath}: ${error.message}`);
  }
}

async function check() {
  const manifest = await loadManifest();
  const failures = [];
  const packageNames = new Set();
  const packagePaths = new Set();
  const manifestKeys = Object.keys(manifest).sort();

  if (
    !sameValues(manifestKeys, [
      "openPackages",
      "releaseStatus",
      "schemaVersion",
    ])
  ) {
    failures.push(
      "release manifest may contain only schemaVersion, releaseStatus, and openPackages",
    );
  }
  if (manifest.releaseStatus !== "unreleased") {
    failures.push(
      "releaseStatus must remain unreleased until an actual release is approved",
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
    } catch (error) {
      failures.push(`${entry.path}: ${error.message}`);
    }
  }

  const cohortVersions = new Set(
    (manifest.openPackages ?? []).map((entry) => entry.version),
  );
  if (cohortVersions.size !== 1) {
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
  if (!changelog.includes("Planned package cohort: `0.1.0`")) {
    failures.push(
      "CHANGELOG.md must identify the planned package cohort version",
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Release consistency failures:\n- ${failures.join("\n- ")}`,
    );
  }
  console.log(
    "All 13 public packages and the private Apache-2.0 reference wrapper are release-consistent.",
  );
}

async function findTarball(directory) {
  const entries = await readdir(directory);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `${directory}: expected one tarball, found ${tarballs.length}`,
    );
  }
  return path.join(directory, tarballs[0]);
}

async function inspectTarball(tarball, extractDirectory) {
  await mkdir(extractDirectory, { recursive: true });
  await run("tar", ["xzf", tarball, "-C", extractDirectory], { quiet: true });
  const contents = path.join(extractDirectory, "package");
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    await access(path.join(contents, required));
  }
  for (const rejected of [
    "src",
    "test",
    ".env",
    ".npmrc",
    "tsconfig.json",
    ".turbo",
  ]) {
    try {
      await access(path.join(contents, rejected));
      throw new Error(`${tarball}: rejected artifact path ${rejected}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return readJson(path.join(contents, "package.json"));
}

function dependencyPackages(pkg) {
  return Object.entries({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  }).map(([name, version], index) => ({
    SPDXID: `SPDXRef-Dependency-${index + 1}`,
    name,
    versionInfo: version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
  }));
}

function sbomFor(pkg, checksum) {
  const dependencies = dependencyPackages(pkg);
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${pkg.name}-${pkg.version}`,
    documentNamespace: `urn:hookship-toolkit:sbom:${encodeURIComponent(pkg.name)}:${pkg.version}:${checksum}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: hookship-toolkit-release-script"],
    },
    packages: [
      {
        SPDXID: "SPDXRef-RootPackage",
        name: pkg.name,
        versionInfo: pkg.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        checksums: [{ algorithm: "SHA256", checksumValue: checksum }],
        licenseConcluded: pkg.license ?? "NOASSERTION",
        licenseDeclared: pkg.license ?? "NOASSERTION",
        copyrightText: "NOASSERTION",
      },
      ...dependencies,
    ],
    relationships: dependencies.map((dependency) => ({
      spdxElementId: "SPDXRef-RootPackage",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: dependency.SPDXID,
    })),
  };
}

async function gitValue(args) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("exit", (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

async function buildArtifacts({ publishDryRun }) {
  await check();
  const manifest = await loadManifest();
  await rm(workRoot, { recursive: true, force: true });
  const tarballRoot = path.join(workRoot, "tarballs");
  const extractRoot = path.join(workRoot, "extract");
  const metadataRoot = path.join(workRoot, "metadata");
  await mkdir(tarballRoot, { recursive: true });
  await mkdir(metadataRoot, { recursive: true });

  const commit = await gitValue(["rev-parse", "HEAD"]);
  const status = await gitValue(["status", "--porcelain"]);
  const lockChecksum = await sha256File(path.join(root, "pnpm-lock.yaml"));
  const checksumLines = [];

  for (const entry of manifest.openPackages) {
    const packageOutput = path.join(tarballRoot, path.basename(entry.path));
    await mkdir(packageOutput, { recursive: true });
    console.log(`Packing ${entry.name}@${entry.version}`);
    await run("pnpm", ["pack", "--pack-destination", packageOutput], {
      cwd: path.join(root, entry.path),
      quiet: true,
    });
    const tarball = await findTarball(packageOutput);
    const packedManifest = await inspectTarball(
      tarball,
      path.join(extractRoot, path.basename(entry.path)),
    );
    if (
      packedManifest.name !== entry.name ||
      packedManifest.version !== entry.version
    ) {
      throw new Error(`${entry.name}: packed manifest name/version mismatch`);
    }
    const checksum = await sha256File(tarball);
    const relativeTarball = path.relative(workRoot, tarball);
    checksumLines.push(`${checksum}  ${relativeTarball}`);

    const safeName = entry.name.replaceAll("/", "-").replace(/^@/, "");
    await writeFile(
      path.join(metadataRoot, `${safeName}-${entry.version}.spdx.json`),
      `${JSON.stringify(sbomFor(packedManifest, checksum), null, 2)}\n`,
    );
    const provenance = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: relativeTarball, digest: { sha256: checksum } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          buildType: "urn:hookship-toolkit:release-script:v1",
          externalParameters: { package: entry.name, version: entry.version },
          internalParameters: {
            gitCommit: commit,
            gitWorkingTreeDirty: status === null ? null : status.length > 0,
          },
          resolvedDependencies: [
            { uri: "pnpm-lock.yaml", digest: { sha256: lockChecksum } },
          ],
        },
        runDetails: {
          builder: { id: "urn:hookship-toolkit:local-release-script" },
          metadata: { invocationId: null },
        },
      },
    };
    await writeFile(
      path.join(metadataRoot, `${safeName}-${entry.version}.provenance.json`),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );

    if (publishDryRun) {
      console.log(`Dry-running npm publish for ${entry.name}`);
      await run(
        "npm",
        [
          "publish",
          "--dry-run",
          "--ignore-scripts",
          "--access",
          "public",
          tarball,
        ],
        { quiet: true },
      );
    }
  }

  await writeFile(
    path.join(workRoot, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
  );
  console.log(
    `Release package artifacts verified in ${path.relative(root, workRoot)}/`,
  );
}

async function main() {
  const command = process.argv[2] ?? "check";
  if (command === "list-packages") {
    const manifest = await loadManifest();
    process.stdout.write(
      `${manifest.openPackages.map((entry) => entry.path).join("\n")}\n`,
    );
    return;
  }
  if (command === "check") return check();
  if (command === "artifacts") return buildArtifacts({ publishDryRun: false });
  if (command === "dry-run") return buildArtifacts({ publishDryRun: true });
  if (command === "clean") {
    await rm(workRoot, { recursive: true, force: true });
    return;
  }
  throw new Error(
    "usage: node scripts/release.mjs [check|list-packages|artifacts|dry-run|clean]",
  );
}

await main();
