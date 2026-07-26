// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildArtifacts } from "./release-artifacts.mjs";
import { workRoot } from "./release-context.mjs";
import { check, loadManifest } from "./release-manifest.mjs";
import { parsePublishArgs, publishCohort } from "./release-publish.mjs";
import {
  openNextDevelopment,
  parsePrepareArgs,
  prepare,
  stageRelease,
} from "./release-versioning.mjs";

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

export { repositoryType, repositoryUrl } from "./release-context.mjs";
export {
  check,
  cohortVersion,
  loadManifest,
  validateOwnership,
  validateRepository,
} from "./release-manifest.mjs";
export {
  internalDependencyGraph,
  parsePublishArgs,
  publishPreflight,
  topologicalOrder,
} from "./release-publish.mjs";
export {
  applyPlan,
  assertTransitionAllowed,
  bumpDependencyRange,
  compareSemver,
  computeBumpPlan,
  parsePrepareArgs,
  resolveNextVersion,
  rewriteChangelogStatus,
  rewriteChangelogVersion,
  rewriteManifestStatus,
  rewriteManifestVersions,
  rewritePackageJson,
} from "./release-versioning.mjs";

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
