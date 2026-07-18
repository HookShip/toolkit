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

async function check() {
  const manifest = await loadManifest();
  const failures = [];
  const packageNames = new Set();
  const packagePaths = new Set();
  const imageNames = new Set();
  const imagePaths = new Set();
  const imageDockerfiles = new Set();

  if (manifest.releaseStatus !== "unreleased") {
    failures.push(
      "releaseStatus must remain unreleased until an actual release is approved",
    );
  }
  if (manifest.openPackages.length !== 9) {
    failures.push(
      "the coordinated open-package cohort must contain exactly 9 packages",
    );
  }

  for (const entry of manifest.openPackages) {
    if (packageNames.has(entry.name))
      failures.push(`duplicate package ${entry.name}`);
    if (packagePaths.has(entry.path))
      failures.push(`duplicate package path ${entry.path}`);
    packageNames.add(entry.name);
    packagePaths.add(entry.path);

    if (!semverPattern.test(entry.version)) {
      failures.push(`${entry.name}: invalid release version ${entry.version}`);
    }
    try {
      const pkg = await packageManifest(entry);
      if (pkg.name !== entry.name)
        failures.push(`${entry.path}: name mismatch`);
      if (pkg.version !== entry.version)
        failures.push(`${entry.name}: version mismatch`);
      if (pkg.private === true)
        failures.push(`${entry.name}: release package is private`);
      if (pkg.license !== "Apache-2.0")
        failures.push(`${entry.name}: license must be Apache-2.0`);
      if (pkg.publishConfig?.access !== "public") {
        failures.push(`${entry.name}: publishConfig.access must be public`);
      }
      if (pkg.engines?.node !== ">=22")
        failures.push(`${entry.name}: Node engine mismatch`);
      if (!pkg.exports && !pkg.bin)
        failures.push(`${entry.name}: no exports or bin`);
      if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
        failures.push(`${entry.name}: package files allowlist is missing`);
      }
    } catch (error) {
      failures.push(`${entry.path}: ${error.message}`);
    }
  }

  const cohortVersions = new Set(
    manifest.openPackages.map((entry) => entry.version),
  );
  if (cohortVersions.size !== 1) {
    failures.push("all coordinated open packages must use one release version");
  }
  for (const entry of manifest.openPackages) {
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
            `${entry.name}: public runtime dependency ${dependency} is outside the coordinated cohort`,
          );
        }
        if (!String(range).startsWith("workspace:")) {
          failures.push(
            `${entry.name}: internal dependency ${dependency} must use workspace protocol before packing`,
          );
        }
      }
    } catch {
      // The primary manifest check reports the file error.
    }
  }

  for (const entry of manifest.deferredOpenPackages ?? []) {
    try {
      const pkg = await packageManifest(entry);
      if (pkg.name !== entry.name)
        failures.push(`${entry.path}: deferred name mismatch`);
      if (pkg.private === true || pkg.license !== "Apache-2.0") {
        failures.push(
          `${entry.name}: deferred open package metadata is inconsistent`,
        );
      }
      if (!entry.reason)
        failures.push(`${entry.name}: deferral reason is required`);
    } catch (error) {
      failures.push(`${entry.path}: ${error.message}`);
    }
  }

  const declaredOpenPaths = new Set([
    ...manifest.openPackages.map((entry) => entry.path),
    ...(manifest.deferredOpenPackages ?? []).map((entry) => entry.path),
  ]);
  for (const directory of await readdir(path.join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!directory.isDirectory()) continue;
    const relative = `packages/${directory.name}`;
    try {
      const pkg = await readJson(path.join(root, relative, "package.json"));
      if (
        pkg.private !== true &&
        pkg.publishConfig?.access === "public" &&
        !declaredOpenPaths.has(relative)
      ) {
        failures.push(
          `${pkg.name}: public package must be in the release cohort or deferred list`,
        );
      }
    } catch {
      // Non-workspace directories are ignored.
    }
  }

  const expectedPrivateImages = ["control-plane-api", "portal", "worker"];
  if (
    manifest.privateImages.length !== expectedPrivateImages.length ||
    expectedPrivateImages.some(
      (name) => !manifest.privateImages.some((image) => image.name === name),
    )
  ) {
    failures.push(
      "privateImages must contain exactly control-plane-api, worker, and portal",
    );
  }
  for (const image of manifest.privateImages) {
    if (imageNames.has(image.name))
      failures.push(`duplicate private image ${image.name}`);
    if (imagePaths.has(image.packagePath))
      failures.push(
        `duplicate private image package path ${image.packagePath}`,
      );
    if (imageDockerfiles.has(image.dockerfile))
      failures.push(`duplicate private image Dockerfile ${image.dockerfile}`);
    imageNames.add(image.name);
    imagePaths.add(image.packagePath);
    imageDockerfiles.add(image.dockerfile);
    if (!semverPattern.test(image.version)) {
      failures.push(`${image.name}: invalid image version ${image.version}`);
    }
    if (image.digest !== null && !/^sha256:[a-f0-9]{64}$/u.test(image.digest)) {
      failures.push(`${image.name}: invalid immutable image digest`);
    }
    if (manifest.releaseStatus === "unreleased" && image.digest !== null) {
      failures.push(`${image.name}: unreleased image digest must remain null`);
    }
    try {
      const pkg = await readJson(
        path.join(root, image.packagePath, "package.json"),
      );
      const dockerfile = await readFile(
        path.join(root, image.dockerfile),
        "utf8",
      );
      if (pkg.version !== image.version)
        failures.push(`${image.name}: image/package version mismatch`);
      if (pkg.private !== true || pkg.license !== "UNLICENSED") {
        failures.push(
          `${image.name}: private image package metadata is inconsistent`,
        );
      }
      if (image.status !== "engineering-pilot-only") {
        failures.push(
          `${image.name}: image status must remain engineering-pilot-only`,
        );
      }
      const expectedLabels = {
        "org.opencontainers.image.version": image.version,
        "org.opencontainers.image.revision": "source-revision-required",
        "org.opencontainers.image.licenses": "UNLICENSED",
      };
      if (JSON.stringify(image.ociLabels) !== JSON.stringify(expectedLabels)) {
        failures.push(`${image.name}: OCI label metadata is inconsistent`);
      }
      for (const marker of [
        "WEBHOOK_PORTAL_IMAGE_VERSION",
        "WEBHOOK_PORTAL_SOURCE_REVISION",
        "org.opencontainers.image.version",
        "org.opencontainers.image.revision",
        "org.opencontainers.image.licenses",
      ]) {
        if (!dockerfile.includes(marker)) {
          failures.push(`${image.name}: Dockerfile is missing ${marker}`);
        }
      }
    } catch (error) {
      failures.push(`${image.name}: ${error.message}`);
    }
  }

  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes("## [Unreleased]")) {
    failures.push("CHANGELOG.md must contain an Unreleased section");
  }
  if (!changelog.includes("Planned package cohort: `0.1.0`")) {
    failures.push(
      "CHANGELOG.md must identify the planned package cohort version",
    );
  }

  const requiredDocs = [
    "docs/launch/README.md",
    "docs/launch/release-and-versioning.md",
    "docs/launch/packaging-and-pricing.md",
    "docs/launch/acquisition-and-content.md",
    "docs/launch/analytics.md",
    "docs/launch/extension-distribution.md",
    "docs/launch/claims-and-comparisons.md",
    "docs/launch/support-and-communications.md",
    ".github/RELEASE_TEMPLATE.md",
  ];
  for (const relative of requiredDocs) {
    try {
      await access(path.join(root, relative));
    } catch {
      failures.push(`${relative}: required launch document is missing`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Release consistency failures:\n- ${failures.join("\n- ")}`,
    );
  }
  console.log(
    "Release manifest, package metadata, changelog, images, and launch docs are consistent.",
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
    documentNamespace: `urn:webhook-portal:sbom:${encodeURIComponent(pkg.name)}:${pkg.version}:${checksum}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: webhook-portal-release-script"],
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
          buildType: "urn:webhook-portal:release-script:v1",
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
          builder: { id: "urn:webhook-portal:local-release-script" },
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

  const imageCandidates = await Promise.all(
    manifest.privateImages.map(async (image) => ({
      name: image.name,
      version: image.version,
      status: image.status,
      dockerfile: image.dockerfile,
      dockerfileSha256: await sha256File(path.join(root, image.dockerfile)),
      digest: image.digest,
      ociLabels: {
        ...image.ociLabels,
        "org.opencontainers.image.revision": commit ?? "unknown",
      },
    })),
  );
  const imageMetadata = path.join(metadataRoot, "private-images.json");
  await writeFile(
    imageMetadata,
    `${JSON.stringify(imageCandidates, null, 2)}\n`,
  );
  checksumLines.push(
    `${await sha256File(imageMetadata)}  ${path.relative(workRoot, imageMetadata)}`,
  );

  await writeFile(
    path.join(workRoot, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
  );
  console.log(
    `Release package and private image candidate artifacts verified in ${path.relative(root, workRoot)}/`,
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
