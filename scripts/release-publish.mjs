// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { run, workRoot } from "./release-context.mjs";
import { capture, gitValue, verifyReleaseTag } from "./release-git.mjs";
import { buildArtifacts, findTarball } from "./release-artifacts.mjs";
import {
  check,
  cohortVersion,
  loadManifest,
  packageManifest,
} from "./release-manifest.mjs";

export function topologicalOrder(graph) {
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

export async function internalDependencyGraph(manifest) {
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

export function publishPreflight({
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

export async function isPublished(name, version, registry) {
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

export async function hasPublishCredentials(registry) {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) return true;
  const args = ["whoami"];
  if (registry) args.push("--registry", registry);
  const result = await capture("npm", args);
  return result.code === 0;
}

export async function tarballForEntry(entry) {
  return findTarball(
    path.join(workRoot, "tarballs", path.basename(entry.path)),
  );
}

export function parsePublishArgs(argv) {
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

export async function publishCohort(options) {
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
      // Publishing a prebuilt tarball needs no scripts; disabling them keeps a
      // future prepublish/prepack/publish hook from executing in the trusted
      // release environment (defense in depth alongside the manifest check).
      "--ignore-scripts",
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
