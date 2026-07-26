// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  changelogAnyStatusLine,
  changelogUnreleasedStatus,
  escapeRegExp,
  manifestPath,
  releaseTransitions,
  releaseTypes,
  root,
  run,
  semverPattern,
  todayIso,
} from "./release-context.mjs";
import { requireCleanTree } from "./release-git.mjs";
import { check, cohortVersion, loadManifest } from "./release-manifest.mjs";

export function parseSemver(version) {
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

export function compareSemver(left, right) {
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

export function resolveNextVersion(current, spec) {
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

export function bumpDependencyRange(range, nextVersion) {
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

export function rewritePackageJson(
  raw,
  oldVersion,
  nextVersion,
  internalNames,
) {
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

export function rewriteManifestVersions(raw, oldVersion, nextVersion) {
  const pattern = new RegExp(
    `("version": ")${escapeRegExp(oldVersion)}(")`,
    "g",
  );
  return raw.replace(pattern, `$1${nextVersion}$2`);
}

export function rewriteChangelogVersion(raw, oldVersion, nextVersion) {
  const marker = `Planned package cohort: \`${oldVersion}\``;
  if (!raw.includes(marker)) {
    throw new Error(`CHANGELOG.md is missing "${marker}"`);
  }
  return raw.replaceAll(marker, `Planned package cohort: \`${nextVersion}\``);
}

export function rewriteManifestStatus(raw, from, to) {
  const pattern = new RegExp(`("releaseStatus": ")${from}(")`);
  if (!pattern.test(raw)) {
    throw new Error(`manifest releaseStatus is not "${from}"`);
  }
  return raw.replace(pattern, `$1${to}$2`);
}

export function rewriteChangelogStatus(raw, to, date) {
  if (!changelogAnyStatusLine.test(raw)) {
    throw new Error('CHANGELOG.md is missing a "Release status:" marker line');
  }
  const line =
    to === "ready"
      ? `Release status: ready. Staged ${date}.`
      : changelogUnreleasedStatus;
  return raw.replace(changelogAnyStatusLine, line);
}

export function assertTransitionAllowed(action, currentStatus) {
  const transition = releaseTransitions[action];
  if (!transition) throw new Error(`unknown transition ${action}`);
  if (currentStatus !== transition.from) {
    throw new Error(
      `cannot ${action}: releaseStatus is "${currentStatus}" (expected "${transition.from}")`,
    );
  }
  return transition;
}

export async function applyPlan(plan, { refreshLockfile, verify = check }) {
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

export async function computeBumpPlan(manifest, oldVersion, nextVersion) {
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

export async function prepare({ spec, dryRun }) {
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

export async function stageRelease({ dryRun }) {
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

export async function openNextDevelopment({ spec, dryRun }) {
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

export function parsePrepareArgs(argv) {
  const flags = new Set(argv.filter((value) => value.startsWith("--")));
  const positionals = argv.filter((value) => !value.startsWith("--"));
  return { spec: positionals[0], dryRun: flags.has("--dry-run") };
}
