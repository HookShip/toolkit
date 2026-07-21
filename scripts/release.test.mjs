// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyPlan,
  assertTransitionAllowed,
  bumpDependencyRange,
  check,
  cohortVersion,
  compareSemver,
  internalDependencyGraph,
  loadManifest,
  parsePrepareArgs,
  parsePublishArgs,
  publishPreflight,
  repositoryType,
  repositoryUrl,
  resolveNextVersion,
  rewriteChangelogStatus,
  rewriteChangelogVersion,
  rewriteManifestStatus,
  rewriteManifestVersions,
  rewritePackageJson,
  topologicalOrder,
  validateOwnership,
  validateRepository,
} from "./release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readManifest() {
  return JSON.parse(
    await readFile(path.join(root, "release", "manifest.json"), "utf8"),
  );
}

test("the real release manifest passes every consistency gate", async () => {
  await assert.doesNotReject(check());
});

test("loadManifest requires schemaVersion 2", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.schemaVersion, 2);
});

test("the manifest names this repository the sole publisher of the cohort", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.ownership.sourceOfTruth, "this repository");
  assert.equal(manifest.ownership.scope, "@webhook-portal");
  assert.equal(manifest.ownership.coordinatedVersioning, "lockstep");
  assert.equal(manifest.ownership.rename, "none");
  assert.match(manifest.ownership.note, /portal-components/);
  // Every package the manifest publishes must live under the declared scope.
  for (const entry of manifest.openPackages) {
    assert.ok(
      entry.name.startsWith(`${manifest.ownership.scope}/`),
      `${entry.name} must be under ${manifest.ownership.scope}`,
    );
  }
  const names = manifest.openPackages.map((entry) => entry.name);
  assert.ok(
    names.includes("@webhook-portal/portal-components"),
    "portal-components must be owned and published by this repository",
  );
});

test("the expected repository URL is the canonical git+https remote", () => {
  assert.equal(repositoryType, "git");
  assert.equal(
    repositoryUrl,
    "git+https://github.com/HookShip/toolkit.git",
    "the provenance URL must match the actual origin remote",
  );
});

test("every cohort package declares exact monorepo repository provenance", async () => {
  const manifest = await loadManifest();
  for (const entry of manifest.openPackages) {
    const pkg = JSON.parse(
      await readFile(path.join(root, entry.path, "package.json"), "utf8"),
    );
    assert.deepEqual(
      pkg.repository,
      {
        type: "git",
        url: "git+https://github.com/HookShip/toolkit.git",
        directory: entry.path,
      },
      `${entry.name} must declare its monorepo repository metadata`,
    );
  }
});

test("validateRepository fails closed on missing, drifted, miscased, or extra metadata", () => {
  const directory = "packages/canonical-model";
  const valid = {
    type: "git",
    url: "git+https://github.com/HookShip/toolkit.git",
    directory,
  };
  assert.deepEqual(validateRepository(valid, directory, "pkg"), []);

  // Missing entirely.
  assert.ok(
    validateRepository(undefined, directory, "pkg").some((failure) =>
      /missing/.test(failure),
    ),
  );
  // Wrong type.
  assert.ok(
    validateRepository({ ...valid, type: "hg" }, directory, "pkg").some(
      (failure) => /repository\.type/.test(failure),
    ),
  );
  // Casing drift in the org name must fail.
  assert.ok(
    validateRepository(
      { ...valid, url: "git+https://github.com/hookship/toolkit.git" },
      directory,
      "pkg",
    ).some((failure) => /repository\.url/.test(failure)),
  );
  // A different host/URL must fail (no invented URLs accepted).
  assert.ok(
    validateRepository(
      { ...valid, url: "git+https://gitlab.com/HookShip/toolkit.git" },
      directory,
      "pkg",
    ).some((failure) => /repository\.url/.test(failure)),
  );
  // Wrong directory.
  assert.ok(
    validateRepository(
      { ...valid, directory: "packages/cli" },
      directory,
      "pkg",
    ).some((failure) => /repository\.directory/.test(failure)),
  );
  // Missing the git+ prefix must fail (npm's canonical form is required).
  assert.ok(
    validateRepository(
      { ...valid, url: "https://github.com/HookShip/toolkit.git" },
      directory,
      "pkg",
    ).some((failure) => /repository\.url/.test(failure)),
  );
  // Extra fields (e.g. an injected homepage-style key) must fail closed.
  assert.ok(
    validateRepository(
      { ...valid, homepage: "https://example.com" },
      directory,
      "pkg",
    ).some((failure) => /exactly type, url, and directory/.test(failure)),
  );
});

test("rewritePackageJson preserves repository provenance across a version bump", () => {
  const raw = JSON.stringify(
    {
      name: "@webhook-portal/cli",
      version: "0.1.0",
      license: "Apache-2.0",
      repository: {
        type: "git",
        url: "git+https://github.com/HookShip/toolkit.git",
        directory: "packages/cli",
      },
      dependencies: { "@webhook-portal/signing": "workspace:*" },
    },
    null,
    2,
  );
  const bumped = JSON.parse(
    rewritePackageJson(
      raw,
      "0.1.0",
      "0.2.0",
      new Set(["@webhook-portal/signing"]),
    ),
  );
  assert.equal(bumped.version, "0.2.0");
  assert.deepEqual(bumped.repository, {
    type: "git",
    url: "git+https://github.com/HookShip/toolkit.git",
    directory: "packages/cli",
  });
});

test("validateOwnership rejects a drifted or absent ownership block", () => {
  const missing = [];
  validateOwnership({}, missing);
  assert.ok(missing.some((failure) => /ownership block/.test(failure)));

  const drifted = [];
  validateOwnership(
    {
      ownership: {
        sourceOfTruth: "somewhere else",
        scope: "@hookship",
        coordinatedVersioning: "independent",
        rename: "planned",
        note: "",
      },
    },
    drifted,
  );
  assert.ok(drifted.some((failure) => /sourceOfTruth/.test(failure)));
  assert.ok(drifted.some((failure) => /scope/.test(failure)));
  assert.ok(drifted.some((failure) => /coordinatedVersioning/.test(failure)));
  assert.ok(drifted.some((failure) => /rename/.test(failure)));
  assert.ok(drifted.some((failure) => /note/.test(failure)));
});

test("validateOwnership rejects unexpected ownership keys", () => {
  const failures = [];
  validateOwnership(
    {
      ownership: {
        sourceOfTruth: "this repository",
        scope: "@webhook-portal",
        coordinatedVersioning: "lockstep",
        rename: "none",
        note: "ok",
        publisherUrl: "https://example.com",
      },
    },
    failures,
  );
  assert.ok(failures.some((failure) => /exactly/.test(failure)));
});

test("cohortVersion returns one coordinated version and rejects divergence", () => {
  assert.equal(
    cohortVersion({
      openPackages: [{ version: "1.2.3" }, { version: "1.2.3" }],
    }),
    "1.2.3",
  );
  assert.throws(
    () =>
      cohortVersion({
        openPackages: [{ version: "1.2.3" }, { version: "1.2.4" }],
      }),
    /one coordinated version/,
  );
});

test("resolveNextVersion increments release types and validates explicit input", () => {
  assert.equal(resolveNextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(resolveNextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(resolveNextVersion("0.1.0", "major"), "1.0.0");
  assert.equal(resolveNextVersion("0.1.0", "0.1.5"), "0.1.5");
  assert.equal(resolveNextVersion("0.1.0", "0.2.0-rc.1"), "0.2.0-rc.1");
  assert.throws(() => resolveNextVersion("0.1.0", "0.1.0"), /must be greater/);
  assert.throws(() => resolveNextVersion("0.1.0", "0.0.9"), /must be greater/);
  assert.throws(() => resolveNextVersion("0.1.0", "nope"), /invalid version/);
});

test("compareSemver orders releases and prereleases", () => {
  assert.equal(compareSemver("0.1.0", "0.2.0"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("0.2.0", "0.2.0-rc.1"), 1);
  assert.equal(compareSemver("0.2.0-rc.1", "0.2.0-rc.2"), -1);
});

test("bumpDependencyRange preserves operators and leaves workspace:* alone", () => {
  assert.equal(bumpDependencyRange("workspace:*", "0.2.0"), "workspace:*");
  assert.equal(
    bumpDependencyRange("workspace:^0.1.0", "0.2.0"),
    "workspace:^0.2.0",
  );
  assert.equal(
    bumpDependencyRange("workspace:0.1.0", "0.2.0"),
    "workspace:0.2.0",
  );
  assert.equal(bumpDependencyRange("^0.1.0", "0.2.0"), "^0.2.0");
  assert.equal(bumpDependencyRange("0.1.0", "0.2.0"), "0.2.0");
  assert.equal(bumpDependencyRange("^7.0.0", "0.2.0"), "^0.2.0");
});

test("rewritePackageJson bumps the version and pinned internal ranges only", () => {
  const raw = JSON.stringify(
    {
      name: "@webhook-portal/cli",
      version: "0.1.0",
      dependencies: {
        "@webhook-portal/signing": "workspace:*",
        "@webhook-portal/canonical-model": "workspace:^0.1.0",
        fastify: "^5.10.0",
      },
    },
    null,
    2,
  );
  const next = rewritePackageJson(
    raw,
    "0.1.0",
    "0.2.0",
    new Set(["@webhook-portal/signing", "@webhook-portal/canonical-model"]),
  );
  const parsed = JSON.parse(next);
  assert.equal(parsed.version, "0.2.0");
  assert.equal(parsed.dependencies["@webhook-portal/signing"], "workspace:*");
  assert.equal(
    parsed.dependencies["@webhook-portal/canonical-model"],
    "workspace:^0.2.0",
  );
  assert.equal(parsed.dependencies.fastify, "^5.10.0");
  assert.throws(
    () => rewritePackageJson(raw, "9.9.9", "0.2.0", new Set()),
    /top-level version/,
  );
});

test("rewriteManifestVersions and rewriteChangelogVersion update every marker", () => {
  const manifest = `{
  "schemaVersion": 2,
  "openPackages": [
    { "name": "a", "version": "0.1.0" },
    { "name": "b", "version": "0.1.0" }
  ]
}`;
  const bumped = rewriteManifestVersions(manifest, "0.1.0", "0.2.0");
  assert.equal((bumped.match(/0\.2\.0/g) ?? []).length, 2);
  assert.ok(bumped.includes('"schemaVersion": 2'));

  const changelog = "Planned package cohort: `0.1.0`. Preparation only.";
  assert.equal(
    rewriteChangelogVersion(changelog, "0.1.0", "0.2.0"),
    "Planned package cohort: `0.2.0`. Preparation only.",
  );
  assert.throws(
    () => rewriteChangelogVersion("no marker here", "0.1.0", "0.2.0"),
    /missing/,
  );
});

test("parsePrepareArgs separates the version spec from the dry-run flag", () => {
  assert.deepEqual(parsePrepareArgs(["minor", "--dry-run"]), {
    spec: "minor",
    dryRun: true,
  });
  assert.deepEqual(parsePrepareArgs(["0.2.0"]), {
    spec: "0.2.0",
    dryRun: false,
  });
  assert.deepEqual(parsePrepareArgs([]), { spec: undefined, dryRun: false });
});

test("topologicalOrder places dependencies before dependents and detects cycles", () => {
  const order = topologicalOrder({
    a: [],
    b: ["a"],
    c: ["a", "b"],
    d: ["c"],
  });
  const rank = (name) => order.indexOf(name);
  assert.ok(rank("a") < rank("b"));
  assert.ok(rank("b") < rank("c"));
  assert.ok(rank("c") < rank("d"));
  assert.throws(
    () => topologicalOrder({ a: ["b"], b: ["a"] }),
    /cycle detected/,
  );
});

test("the real cohort graph is acyclic and publishes deps before dependents", async () => {
  const manifest = await loadManifest();
  const graph = await internalDependencyGraph(manifest);
  const order = topologicalOrder(graph);
  assert.equal(order.length, manifest.openPackages.length);
  for (const [name, dependencies] of Object.entries(graph)) {
    for (const dependency of dependencies) {
      assert.ok(
        order.indexOf(dependency) < order.indexOf(name),
        `${dependency} must be published before ${name}`,
      );
    }
  }
  // canonical-model has no internal dependencies, so it must lead; the CLI
  // depends on almost everything, so it must trail.
  assert.equal(order[0], "@webhook-portal/canonical-model");
  assert.equal(order.at(-1), "@webhook-portal/cli");
});

test("publishPreflight fails closed on a dirty tree, unreadable status, or tag mismatch", () => {
  // Plan mode (execute: false) with a clean tree and no tag is fine.
  assert.deepEqual(
    publishPreflight({ statusPorcelain: "", tag: undefined, cohort: "0.1.0" }),
    [],
  );
  assert.deepEqual(
    publishPreflight({ statusPorcelain: "", tag: "v0.1.0", cohort: "0.1.0" }),
    [],
  );
  assert.ok(
    publishPreflight({
      statusPorcelain: " M file",
      tag: undefined,
      cohort: "0.1.0",
    }).some((failure) => /dirty working tree/.test(failure)),
  );
  assert.ok(
    publishPreflight({
      statusPorcelain: null,
      tag: undefined,
      cohort: "0.1.0",
    }).some((failure) => /could not read git status/.test(failure)),
  );
  assert.ok(
    publishPreflight({
      statusPorcelain: "",
      tag: "v9.9.9",
      cohort: "0.1.0",
    }).some((failure) => /does not match cohort version/.test(failure)),
  );
});

test("publishPreflight execute requires the ready state and a matching tag", () => {
  // A staged, clean, correctly-tagged execute passes.
  assert.deepEqual(
    publishPreflight({
      statusPorcelain: "",
      tag: "v0.1.0",
      cohort: "0.1.0",
      releaseStatus: "ready",
      execute: true,
    }),
    [],
  );
  // Executing from the development state is refused.
  assert.ok(
    publishPreflight({
      statusPorcelain: "",
      tag: "v0.1.0",
      cohort: "0.1.0",
      releaseStatus: "unreleased",
      execute: true,
    }).some((failure) => /releaseStatus is "unreleased"/.test(failure)),
  );
  // Executing without a tag is refused.
  assert.ok(
    publishPreflight({
      statusPorcelain: "",
      tag: undefined,
      cohort: "0.1.0",
      releaseStatus: "ready",
      execute: true,
    }).some((failure) => /--tag vX\.Y\.Z is required/.test(failure)),
  );
  // The ready gate does not apply to a non-mutating plan.
  assert.deepEqual(
    publishPreflight({
      statusPorcelain: "",
      tag: undefined,
      cohort: "0.1.0",
      releaseStatus: "unreleased",
      execute: false,
    }),
    [],
  );
});

test("assertTransitionAllowed enforces the lifecycle direction", () => {
  assert.deepEqual(assertTransitionAllowed("stage", "unreleased"), {
    from: "unreleased",
    to: "ready",
  });
  assert.deepEqual(assertTransitionAllowed("open-next", "ready"), {
    from: "ready",
    to: "unreleased",
  });
  // Staging a already-staged cohort, or opening development from a development
  // state, are both invalid transitions.
  assert.throws(
    () => assertTransitionAllowed("stage", "ready"),
    /releaseStatus is "ready"/,
  );
  assert.throws(
    () => assertTransitionAllowed("open-next", "unreleased"),
    /releaseStatus is "unreleased"/,
  );
});

test("rewriteManifestStatus flips the marker and refuses a double transition", () => {
  const raw = '  "releaseStatus": "unreleased",\n';
  const staged = rewriteManifestStatus(raw, "unreleased", "ready");
  assert.equal(staged, '  "releaseStatus": "ready",\n');
  assert.equal(
    rewriteManifestStatus(staged, "ready", "unreleased"),
    '  "releaseStatus": "unreleased",\n',
  );
  // Repeating a transition after it already happened fails closed.
  assert.throws(
    () => rewriteManifestStatus(staged, "unreleased", "ready"),
    /releaseStatus is not "unreleased"/,
  );
});

test("rewriteChangelogStatus flips the changelog marker in both directions", () => {
  const dev = "before\nRelease status: unreleased.\nafter\n";
  const ready = rewriteChangelogStatus(dev, "ready", "2026-07-21");
  assert.match(ready, /^Release status: ready\. Staged 2026-07-21\.$/m);
  assert.doesNotMatch(ready, /Release status: unreleased\./);
  const back = rewriteChangelogStatus(ready, "unreleased");
  assert.match(back, /^Release status: unreleased\.$/m);
  assert.throws(
    () => rewriteChangelogStatus("no marker here", "ready", "2026-07-21"),
    /Release status:/,
  );
});

test("repeated planning is deterministic and does not mutate its input", () => {
  const manifest = '  "releaseStatus": "unreleased",\n  "version": "0.1.0"\n';
  const changelog =
    "Planned package cohort: `0.1.0`.\nRelease status: unreleased.\n";
  // Planning the same transition repeatedly yields byte-identical output, so a
  // dry run can be re-run safely without drift.
  assert.equal(
    rewriteManifestStatus(manifest, "unreleased", "ready"),
    rewriteManifestStatus(manifest, "unreleased", "ready"),
  );
  assert.equal(
    rewriteChangelogStatus(changelog, "ready", "2026-07-21"),
    rewriteChangelogStatus(changelog, "ready", "2026-07-21"),
  );
  assert.deepEqual(
    publishPreflight({
      statusPorcelain: "",
      tag: "v0.1.0",
      cohort: "0.1.0",
      releaseStatus: "ready",
      execute: true,
    }),
    publishPreflight({
      statusPorcelain: "",
      tag: "v0.1.0",
      cohort: "0.1.0",
      releaseStatus: "ready",
      execute: true,
    }),
  );
  // Planning never mutates its inputs.
  assert.equal(
    manifest,
    '  "releaseStatus": "unreleased",\n  "version": "0.1.0"\n',
  );
  assert.equal(
    changelog,
    "Planned package cohort: `0.1.0`.\nRelease status: unreleased.\n",
  );
});

test("applyPlan writes on success and rolls every file back on verify failure", async () => {
  const rel = ".release-lifecycle-rollback-test.tmp";
  const file = path.join(root, rel);
  await writeFile(file, "ORIGINAL");

  // Success path: the file is updated and verification is invoked.
  let verified = 0;
  const changed = await applyPlan(
    [{ relative: rel, before: "ORIGINAL", after: "UPDATED" }],
    {
      refreshLockfile: false,
      verify: async () => {
        verified += 1;
      },
    },
  );
  assert.equal(changed.length, 1);
  assert.equal(verified, 1);
  assert.equal(await readFile(file, "utf8"), "UPDATED");

  // Failure path: a throwing verify restores the pre-write content.
  await assert.rejects(
    applyPlan([{ relative: rel, before: "UPDATED", after: "BROKEN" }], {
      refreshLockfile: false,
      verify: async () => {
        throw new Error("verification failed");
      },
    }),
    /rolled back/,
  );
  assert.equal(await readFile(file, "utf8"), "UPDATED");
  await rm(file);
});

test("parsePublishArgs reads flags, inline values, and rejects unknown options", () => {
  assert.deepEqual(parsePublishArgs([]), {
    execute: false,
    provenance: false,
    tag: undefined,
    registry: undefined,
    distTag: undefined,
  });
  assert.deepEqual(
    parsePublishArgs([
      "--execute",
      "--provenance",
      "--tag",
      "v0.1.0",
      "--registry",
      "http://localhost:4873",
      "--dist-tag=next",
    ]),
    {
      execute: true,
      provenance: true,
      tag: "v0.1.0",
      registry: "http://localhost:4873",
      distTag: "next",
    },
  );
  assert.throws(() => parsePublishArgs(["--nope"]), /unknown publish option/);
});
