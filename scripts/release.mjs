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
const supportedSchemaVersion = 2;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

// The release-status lifecycle. `unreleased` is normal development; `ready` is a
// validated release candidate locked for tagging and publishing. Both are valid
// for ordinary checks; only `ready` may be published. The changelog carries a
// matching human- and machine-readable status marker so the two never drift.
const releaseStatuses = new Set(["unreleased", "ready"]);
const changelogUnreleasedStatus = "Release status: unreleased.";
const changelogReadyStatusLine = /^Release status: ready\./m;
const changelogAnyStatusLine =
  /^Release status: (?:unreleased\.|ready\.[^\n]*)$/m;
const releaseTransitions = {
  stage: { from: "unreleased", to: "ready" },
  "open-next": { from: "ready", to: "unreleased" },
};

// The single, machine-checked ownership contract for the public cohort. These
// values are asserted (not merely required to exist) so that a silent edit to
// the manifest that changes the publisher, scope, or versioning model fails the
// release consistency gate rather than drifting unnoticed.
const expectedOwnership = {
  sourceOfTruth: "this repository",
  scope: "@webhook-portal",
  coordinatedVersioning: "lockstep",
  rename: "none",
};

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
  if (manifest.schemaVersion !== supportedSchemaVersion) {
    throw new Error(
      `release/manifest.json must use schemaVersion ${supportedSchemaVersion}`,
    );
  }
  return manifest;
}

// The coordinated cohort version, derived from the manifest so the bump path is
// the single place that changes it. Throws when packages disagree, which the
// caller surfaces as a release consistency failure.
function cohortVersion(manifest) {
  const versions = new Set(
    (manifest.openPackages ?? []).map((entry) => entry.version),
  );
  if (versions.size !== 1) {
    throw new Error("all public packages must use one coordinated version");
  }
  return [...versions][0];
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

function validateOwnership(manifest, failures) {
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

async function check() {
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

// ---------------------------------------------------------------------------
// Atomic prepare / bump path
//
// Rewrites the cohort version everywhere it appears — the release manifest,
// every public package.json (its own version and any pinned internal range),
// the lockfile, and the changelog's planned-cohort line — as one all-or-nothing
// operation. `--dry-run` prints the plan and writes nothing. When it does write,
// it snapshots every file first and restores them if post-write verification
// fails, so a failed bump never leaves a half-updated tree.
// ---------------------------------------------------------------------------

const releaseTypes = new Set(["major", "minor", "patch"]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSemver(version) {
  const match = semverPattern.exec(version);
  if (!match) return null;
  const dash = version.indexOf("-");
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: dash === -1 ? "" : version.slice(dash + 1),
  };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`cannot compare versions ${left} and ${right}`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  // A version without a prerelease outranks one with a prerelease (semver §11).
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function resolveNextVersion(current, spec) {
  if (releaseTypes.has(spec)) {
    const parsed = parseSemver(current);
    if (!parsed) throw new Error(`current version ${current} is not semver`);
    if (spec === "major") return `${parsed.major + 1}.0.0`;
    if (spec === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
  if (!semverPattern.test(spec)) {
    throw new Error(
      `invalid version or release type "${spec}" (expected semver or major|minor|patch)`,
    );
  }
  if (compareSemver(spec, current) <= 0) {
    throw new Error(
      `next version ${spec} must be greater than current ${current}`,
    );
  }
  return spec;
}

// Rewrites one internal dependency range to the next version, preserving the
// range operator. `workspace:*` carries no version and is left untouched.
function bumpDependencyRange(range, nextVersion) {
  if (typeof range !== "string") return range;
  const workspaceMatch = /^workspace:([\^~]?)(.+)$/.exec(range);
  if (workspaceMatch) {
    const [, operator, spec] = workspaceMatch;
    if (spec === "*") return range;
    if (semverPattern.test(spec)) return `workspace:${operator}${nextVersion}`;
    return range;
  }
  const rangeMatch = /^([\^~]?)(.+)$/.exec(range);
  if (rangeMatch && semverPattern.test(rangeMatch[2])) {
    return `${rangeMatch[1]}${nextVersion}`;
  }
  return range;
}

// Surgical text rewrite of a package.json: the top-level version field plus any
// pinned internal range. Editing text (not re-serializing) preserves the file's
// exact formatting so the diff stays minimal and reviewable.
function rewritePackageJson(raw, oldVersion, nextVersion, internalNames) {
  const versionPattern = new RegExp(
    `("version":\\s*")${escapeRegExp(oldVersion)}(")`,
  );
  if (!versionPattern.test(raw)) {
    throw new Error(`could not find top-level version ${oldVersion}`);
  }
  let next = raw.replace(versionPattern, `$1${nextVersion}$2`);
  for (const name of internalNames) {
    const depPattern = new RegExp(
      `("${escapeRegExp(name)}":\\s*")([^"]+)(")`,
      "g",
    );
    next = next.replace(
      depPattern,
      (_match, pre, range, post) =>
        `${pre}${bumpDependencyRange(range, nextVersion)}${post}`,
    );
  }
  return next;
}

function rewriteManifestVersions(raw, oldVersion, nextVersion) {
  const pattern = new RegExp(
    `("version": ")${escapeRegExp(oldVersion)}(")`,
    "g",
  );
  return raw.replace(pattern, `$1${nextVersion}$2`);
}

function rewriteChangelogVersion(raw, oldVersion, nextVersion) {
  const marker = `Planned package cohort: \`${oldVersion}\``;
  if (!raw.includes(marker)) {
    throw new Error(`CHANGELOG.md is missing "${marker}"`);
  }
  return raw.replaceAll(marker, `Planned package cohort: \`${nextVersion}\``);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Flips the manifest lifecycle marker, refusing to run unless it currently holds
// the expected value (so a double transition fails closed instead of silently
// mangling the file).
function rewriteManifestStatus(raw, from, to) {
  const pattern = new RegExp(`("releaseStatus": ")${from}(")`);
  if (!pattern.test(raw)) {
    throw new Error(`manifest releaseStatus is not "${from}"`);
  }
  return raw.replace(pattern, `$1${to}$2`);
}

// Flips the changelog status marker to match the manifest lifecycle state.
function rewriteChangelogStatus(raw, to, date) {
  if (!changelogAnyStatusLine.test(raw)) {
    throw new Error('CHANGELOG.md is missing a "Release status:" marker line');
  }
  const line =
    to === "ready"
      ? `Release status: ready. Staged ${date}.`
      : changelogUnreleasedStatus;
  return raw.replace(changelogAnyStatusLine, line);
}

// Confirms a lifecycle transition is legal for the current status, throwing a
// clear error otherwise. Returns the transition descriptor.
function assertTransitionAllowed(action, currentStatus) {
  const transition = releaseTransitions[action];
  if (!transition) throw new Error(`unknown transition ${action}`);
  if (currentStatus !== transition.from) {
    throw new Error(
      `cannot ${action}: releaseStatus is "${currentStatus}" (expected "${transition.from}")`,
    );
  }
  return transition;
}

async function requireCleanTree(action) {
  const status = await gitValue(["status", "--porcelain"]);
  if (status === null) {
    throw new Error(`cannot ${action}: unable to read git status`);
  }
  if (status.trim() !== "") {
    throw new Error(
      `cannot ${action}: refusing to ${action} from a dirty tree`,
    );
  }
}

// Writes a plan atomically: snapshot every file (and the lockfile when versions
// move), write the changes, verify, and restore the snapshot if verification
// throws so a failed transition never leaves a partial tree. `verify` is
// injectable for testing; it defaults to the full consistency check.
async function applyPlan(plan, { refreshLockfile, verify = check }) {
  const changed = plan.filter((edit) => edit.before !== edit.after);
  const snapshots = plan.map((edit) => ({
    relative: edit.relative,
    before: edit.before,
  }));
  const lockRelative = "pnpm-lock.yaml";
  if (refreshLockfile) {
    snapshots.push({
      relative: lockRelative,
      before: await readFile(path.join(root, lockRelative), "utf8"),
    });
  }
  const restore = async () => {
    for (const snapshot of snapshots) {
      await writeFile(path.join(root, snapshot.relative), snapshot.before);
    }
  };
  try {
    for (const edit of changed) {
      await writeFile(path.join(root, edit.relative), edit.after);
    }
    if (refreshLockfile) {
      await run("pnpm", ["install", "--lockfile-only"], { quiet: true });
    }
    await verify();
  } catch (error) {
    await restore();
    throw new Error(
      `release update failed and was rolled back: ${error.message}`,
      { cause: error },
    );
  }
  return changed;
}

// Builds the ordered list of file edits for a bump without touching disk beyond
// reads. Each edit records before/after so a caller can preview, apply, or
// restore atomically.
async function computeBumpPlan(manifest, oldVersion, nextVersion) {
  const names = new Set(manifest.openPackages.map((entry) => entry.name));
  const edits = [];

  const manifestRaw = await readFile(manifestPath, "utf8");
  edits.push({
    relative: "release/manifest.json",
    before: manifestRaw,
    after: rewriteManifestVersions(manifestRaw, oldVersion, nextVersion),
  });

  for (const entry of manifest.openPackages) {
    const relative = `${entry.path}/package.json`;
    const before = await readFile(path.join(root, relative), "utf8");
    edits.push({
      relative,
      before,
      after: rewritePackageJson(before, oldVersion, nextVersion, names),
    });
  }

  const changelogRaw = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  edits.push({
    relative: "CHANGELOG.md",
    before: changelogRaw,
    after: rewriteChangelogVersion(changelogRaw, oldVersion, nextVersion),
  });

  return edits;
}

async function prepare({ spec, dryRun }) {
  if (!spec) {
    throw new Error(
      "usage: node scripts/release.mjs prepare <version|major|minor|patch> [--dry-run]",
    );
  }
  const manifest = await loadManifest();
  const current = cohortVersion(manifest);
  const nextVersion = resolveNextVersion(current, spec);
  const plan = await computeBumpPlan(manifest, current, nextVersion);
  const changed = plan.filter((edit) => edit.before !== edit.after);

  console.log(
    `Preparing cohort ${current} -> ${nextVersion} (${changed.length} file(s) change, ${plan.length} inspected)`,
  );
  for (const edit of changed) {
    console.log(`  update ${edit.relative}`);
  }

  if (dryRun) {
    console.log("Dry run: no files written, lockfile untouched.");
    return;
  }

  await applyPlan(plan, { refreshLockfile: true });

  console.log(
    `Prepared release ${nextVersion}. Review the diff; revert with "git checkout -- ." if needed.`,
  );
}

// ---------------------------------------------------------------------------
// Release-status lifecycle: unreleased <-> ready
//
// `stage` locks a validated release candidate (unreleased -> ready) so the
// tagged source records a release-ready state; `open-next` returns the cohort to
// development for the next version (ready -> unreleased) without touching any
// tag. Both are atomic, reversible, and fail closed on an illegal transition or
// (for a real apply) a dirty tree.
// ---------------------------------------------------------------------------

async function stageRelease({ dryRun }) {
  const manifest = await loadManifest();
  assertTransitionAllowed("stage", manifest.releaseStatus);
  const cohort = cohortVersion(manifest);

  const manifestRaw = await readFile(manifestPath, "utf8");
  const changelogRaw = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const plan = [
    {
      relative: "release/manifest.json",
      before: manifestRaw,
      after: rewriteManifestStatus(manifestRaw, "unreleased", "ready"),
    },
    {
      relative: "CHANGELOG.md",
      before: changelogRaw,
      after: rewriteChangelogStatus(changelogRaw, "ready", todayIso()),
    },
  ];
  const changed = plan.filter((edit) => edit.before !== edit.after);

  console.log(
    `Staging cohort ${cohort} as a release candidate (unreleased -> ready), ${changed.length} file(s):`,
  );
  for (const edit of changed) console.log(`  update ${edit.relative}`);

  if (dryRun) {
    console.log("Dry run: no files written.");
    return;
  }

  // A release candidate must be staged from a clean, already-consistent tree.
  await requireCleanTree("stage");
  await check();
  await applyPlan(plan, { refreshLockfile: false });

  console.log(
    `Staged ${cohort}. Commit, then create an annotated tag v${cohort}. Revert with "git checkout -- ." if needed.`,
  );
}

async function openNextDevelopment({ spec, dryRun }) {
  if (!spec) {
    throw new Error(
      "usage: node scripts/release.mjs next <version|major|minor|patch> [--dry-run]",
    );
  }
  const manifest = await loadManifest();
  assertTransitionAllowed("open-next", manifest.releaseStatus);
  const current = cohortVersion(manifest);
  const nextVersion = resolveNextVersion(current, spec);
  const names = new Set(manifest.openPackages.map((entry) => entry.name));

  const plan = [];
  const manifestRaw = await readFile(manifestPath, "utf8");
  plan.push({
    relative: "release/manifest.json",
    before: manifestRaw,
    after: rewriteManifestStatus(
      rewriteManifestVersions(manifestRaw, current, nextVersion),
      "ready",
      "unreleased",
    ),
  });
  for (const entry of manifest.openPackages) {
    const relative = `${entry.path}/package.json`;
    const before = await readFile(path.join(root, relative), "utf8");
    plan.push({
      relative,
      before,
      after: rewritePackageJson(before, current, nextVersion, names),
    });
  }
  const changelogRaw = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  plan.push({
    relative: "CHANGELOG.md",
    before: changelogRaw,
    after: rewriteChangelogStatus(
      rewriteChangelogVersion(changelogRaw, current, nextVersion),
      "unreleased",
    ),
  });
  const changed = plan.filter((edit) => edit.before !== edit.after);

  console.log(
    `Opening next development ${current} (ready) -> ${nextVersion} (unreleased), ${changed.length} file(s):`,
  );
  for (const edit of changed) console.log(`  update ${edit.relative}`);

  if (dryRun) {
    console.log("Dry run: no files written, lockfile untouched.");
    return;
  }

  await requireCleanTree("open next development");
  await applyPlan(plan, { refreshLockfile: true });

  console.log(
    `Opened development on ${nextVersion} (unreleased). No tag was touched.`,
  );
}

function parsePrepareArgs(argv) {
  const flags = new Set(argv.filter((value) => value.startsWith("--")));
  const positionals = argv.filter((value) => !value.startsWith("--"));
  return { spec: positionals[0], dryRun: flags.has("--dry-run") };
}

// ---------------------------------------------------------------------------
// Ordered, idempotent publish
//
// Publishes the cohort in dependency order (a dependency is always on the
// registry before anything that depends on it), skips versions already present
// so re-running a partially-completed release is safe, and fails closed on a
// dirty tree, a tag that disagrees with the cohort version, or any package /
// manifest version mismatch. Real publishing uses `npm publish --provenance`,
// which relies on CI OIDC; no token is ever read into or written by this script.
// ---------------------------------------------------------------------------

function capture(command, args) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", () => resolve({ code: -1, stdout, stderr }));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// Kahn-style topological sort over the internal dependency graph. Deterministic
// (ties broken alphabetically) and throws on a cycle rather than looping.
function topologicalOrder(graph) {
  const names = Object.keys(graph).sort();
  const nameSet = new Set(names);
  const done = new Set();
  const order = [];
  while (order.length < names.length) {
    const ready = names.filter(
      (name) =>
        !done.has(name) &&
        graph[name]
          .filter((dependency) => nameSet.has(dependency))
          .every((dependency) => done.has(dependency)),
    );
    if (ready.length === 0) {
      throw new Error("cycle detected in internal dependency graph");
    }
    for (const name of ready) {
      order.push(name);
      done.add(name);
    }
  }
  return order;
}

async function internalDependencyGraph(manifest) {
  const names = new Set(manifest.openPackages.map((entry) => entry.name));
  const graph = {};
  for (const entry of manifest.openPackages) {
    const pkg = await packageManifest(entry);
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    graph[entry.name] = Object.keys(dependencies).filter((dependency) =>
      names.has(dependency),
    );
  }
  return graph;
}

function publishPreflight({
  statusPorcelain,
  tag,
  cohort,
  releaseStatus,
  execute,
}) {
  const failures = [];
  if (statusPorcelain === null) {
    failures.push("could not read git status to verify a clean tree");
  } else if (statusPorcelain.trim() !== "") {
    failures.push("refusing to publish from a dirty working tree");
  }
  if (execute && releaseStatus !== "ready") {
    failures.push(
      `refusing to publish: releaseStatus is "${releaseStatus}" (stage the release with "release.mjs stage" first)`,
    );
  }
  if (execute && tag === undefined) {
    failures.push(
      "refusing to publish: an annotated --tag vX.Y.Z is required for --execute",
    );
  }
  if (tag !== undefined && tag !== `v${cohort}` && tag !== cohort) {
    failures.push(
      `git tag ${tag} does not match cohort version ${cohort} (expected v${cohort})`,
    );
  }
  return failures;
}

// Confirms the release tag is an annotated (or signed) tag that points at the
// commit being published. Lightweight tags and tags that do not point at HEAD
// fail closed. Returns { failures, signed }.
async function verifyReleaseTag(tag) {
  const failures = [];
  const type = (await capture("git", ["cat-file", "-t", tag])).stdout.trim();
  if (type !== "tag") {
    failures.push(
      `tag ${tag} must be an annotated or signed tag (found ${type || "no tag object"})`,
    );
    return { failures, signed: false };
  }
  const contents = await capture("git", ["cat-file", "-p", tag]);
  const signed = contents.stdout.includes("-----BEGIN PGP SIGNATURE-----");
  const tagCommit = (
    await capture("git", ["rev-parse", `${tag}^{commit}`])
  ).stdout.trim();
  const head = (
    await capture("git", ["rev-parse", "HEAD^{commit}"])
  ).stdout.trim();
  if (tagCommit === "" || head === "" || tagCommit !== head) {
    failures.push(`tag ${tag} must point at the commit being published (HEAD)`);
  }
  return { failures, signed };
}

// True only when the exact name@version already exists on the registry. A 404
// means "not published yet". Anything else is ambiguous and throws, so callers
// never publish (or skip) on a guess.
async function isPublished(name, version, registry) {
  const args = ["view", `${name}@${version}`, "version"];
  if (registry) args.push("--registry", registry);
  const result = await capture("npm", args);
  if (result.code === 0 && result.stdout.trim() !== "") return true;
  if (/E404|not found|is not in this registry/i.test(result.stderr)) {
    return false;
  }
  throw new Error(
    `could not determine publish state of ${name}@${version}: ${
      result.stderr.trim() || `npm view exited ${result.code}`
    }`,
  );
}

// Credentials are never stored by this script; it only checks whether an ambient
// publishing context exists: a CI OIDC token (the provenance path) or an
// already-authenticated npm user.
async function hasPublishCredentials(registry) {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) return true;
  const args = ["whoami"];
  if (registry) args.push("--registry", registry);
  const result = await capture("npm", args);
  return result.code === 0;
}

async function tarballForEntry(entry) {
  return findTarball(
    path.join(workRoot, "tarballs", path.basename(entry.path)),
  );
}

function parsePublishArgs(argv) {
  const options = {
    execute: false,
    provenance: false,
    tag: undefined,
    registry: undefined,
    distTag: undefined,
  };
  const booleanFlags = { "--execute": "execute", "--provenance": "provenance" };
  const valueFlags = {
    "--tag": "tag",
    "--registry": "registry",
    "--dist-tag": "distTag",
  };
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let inlineValue;
    const equals = arg.indexOf("=");
    if (arg.startsWith("--") && equals !== -1) {
      inlineValue = arg.slice(equals + 1);
      arg = arg.slice(0, equals);
    }
    if (arg in booleanFlags) {
      options[booleanFlags[arg]] = true;
    } else if (arg in valueFlags) {
      options[valueFlags[arg]] =
        inlineValue !== undefined ? inlineValue : argv[(index += 1)];
    } else {
      throw new Error(`unknown publish option: ${arg}`);
    }
  }
  return options;
}

async function publishCohort(options) {
  const { execute, provenance, tag, registry, distTag } = options;
  const manifest = await loadManifest();
  const cohort = cohortVersion(manifest);

  // Fail closed on any package/manifest version mismatch or metadata drift.
  await check();

  const status = await gitValue(["status", "--porcelain"]);
  const failures = publishPreflight({
    statusPorcelain: status,
    tag,
    cohort,
    releaseStatus: manifest.releaseStatus,
    execute,
  });
  if (failures.length > 0) {
    throw new Error(`Publish preflight failed:\n- ${failures.join("\n- ")}`);
  }

  // For a real publish, the tag itself must be annotated/signed and point at the
  // commit being published.
  if (execute) {
    const { failures: tagFailures, signed } = await verifyReleaseTag(tag);
    if (tagFailures.length > 0) {
      throw new Error(
        `Publish preflight failed:\n- ${tagFailures.join("\n- ")}`,
      );
    }
    console.log(
      `Release tag ${tag} verified (${signed ? "signed" : "annotated"}, points at HEAD).`,
    );
  }

  const order = topologicalOrder(await internalDependencyGraph(manifest));
  const entriesByName = new Map(
    manifest.openPackages.map((entry) => [entry.name, entry]),
  );

  console.log(
    `Publish order for cohort ${cohort}${registry ? ` -> ${registry}` : ""} (${execute ? "execute" : "plan"}):`,
  );
  for (const name of order) console.log(`  ${name}`);

  if (execute && !(await hasPublishCredentials(registry))) {
    throw new Error(
      "refusing to publish: no CI OIDC context or authenticated npm user is available",
    );
  }
  if (execute) {
    // Pack and verify the exact artifacts we are about to publish.
    await buildArtifacts({ publishDryRun: false });
  }

  let published = 0;
  let skipped = 0;
  for (const name of order) {
    const entry = entriesByName.get(name);
    let already;
    try {
      already = await isPublished(name, entry.version, registry);
    } catch (error) {
      if (execute) throw error;
      console.log(
        `  unknown ${name}@${entry.version} (registry query failed: ${error.message})`,
      );
      continue;
    }
    if (already) {
      skipped += 1;
      console.log(`  skip ${name}@${entry.version} (already on registry)`);
      continue;
    }
    if (!execute) {
      console.log(`  would publish ${name}@${entry.version}`);
      continue;
    }
    const args = [
      "publish",
      await tarballForEntry(entry),
      "--access",
      "public",
    ];
    if (provenance) args.push("--provenance");
    if (registry) args.push("--registry", registry);
    if (distTag) args.push("--tag", distTag);
    console.log(`  publish ${name}@${entry.version}`);
    await run("npm", args, { quiet: true });
    published += 1;
  }

  console.log(
    execute
      ? `Publish complete: ${published} published, ${skipped} already present.`
      : "Publish plan complete; no packages were published.",
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
  if (command === "prepare" || command === "bump") {
    return prepare(parsePrepareArgs(process.argv.slice(3)));
  }
  if (command === "stage" || command === "ready") {
    return stageRelease({
      dryRun: process.argv.slice(3).includes("--dry-run"),
    });
  }
  if (command === "next" || command === "open-next") {
    return openNextDevelopment(parsePrepareArgs(process.argv.slice(3)));
  }
  if (command === "publish") {
    return publishCohort(parsePublishArgs(process.argv.slice(3)));
  }
  if (command === "artifacts") return buildArtifacts({ publishDryRun: false });
  if (command === "dry-run") return buildArtifacts({ publishDryRun: true });
  if (command === "clean") {
    await rm(workRoot, { recursive: true, force: true });
    return;
  }
  throw new Error(
    "usage: node scripts/release.mjs [check|list-packages|prepare|bump|stage|next|publish|artifacts|dry-run|clean]",
  );
}

export {
  applyPlan,
  assertTransitionAllowed,
  bumpDependencyRange,
  check,
  cohortVersion,
  compareSemver,
  computeBumpPlan,
  internalDependencyGraph,
  loadManifest,
  parsePrepareArgs,
  parsePublishArgs,
  publishPreflight,
  resolveNextVersion,
  rewriteChangelogStatus,
  rewriteChangelogVersion,
  rewriteManifestStatus,
  rewriteManifestVersions,
  rewritePackageJson,
  topologicalOrder,
  validateOwnership,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
