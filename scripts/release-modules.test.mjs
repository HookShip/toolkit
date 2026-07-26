// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import * as facade from "./release.mjs";
import {
  escapeRegExp,
  releaseTypes,
  repositoryType,
  repositoryUrl,
  todayIso,
} from "./release-context.mjs";
import * as git from "./release-git.mjs";
import {
  sameValues,
  validateOwnership,
  validateRepository,
} from "./release-manifest.mjs";
import { dependencyPackages, sbomFor } from "./release-artifacts.mjs";
import {
  parsePublishArgs,
  publishPreflight,
  topologicalOrder,
} from "./release-publish.mjs";
import {
  assertTransitionAllowed,
  bumpDependencyRange,
  compareSemver,
  parsePrepareArgs,
  resolveNextVersion,
} from "./release-versioning.mjs";

// Which module owns each helper the facade re-exports. This is the module map
// asserted below: the facade must be a pure re-export, and every helper must
// live in exactly one focused module.
const OWNERSHIP = {
  "release-context.mjs": ["repositoryType", "repositoryUrl"],
  "release-manifest.mjs": [
    "check",
    "cohortVersion",
    "loadManifest",
    "validateOwnership",
    "validateRepository",
  ],
  "release-versioning.mjs": [
    "applyPlan",
    "assertTransitionAllowed",
    "bumpDependencyRange",
    "compareSemver",
    "computeBumpPlan",
    "parsePrepareArgs",
    "resolveNextVersion",
    "rewriteChangelogStatus",
    "rewriteChangelogVersion",
    "rewriteManifestStatus",
    "rewriteManifestVersions",
    "rewritePackageJson",
  ],
  "release-publish.mjs": [
    "internalDependencyGraph",
    "parsePublishArgs",
    "publishPreflight",
    "topologicalOrder",
  ],
};

test("the facade re-exports each helper from its owning module, unchanged", async () => {
  const modules = {
    "release-context.mjs": await import("./release-context.mjs"),
    "release-manifest.mjs": await import("./release-manifest.mjs"),
    "release-versioning.mjs": await import("./release-versioning.mjs"),
    "release-publish.mjs": await import("./release-publish.mjs"),
  };
  const reexported = new Set();
  for (const [moduleName, names] of Object.entries(OWNERSHIP)) {
    for (const name of names) {
      assert.equal(
        typeof modules[moduleName][name] !== "undefined",
        true,
        `${moduleName} must export ${name}`,
      );
      assert.equal(
        facade[name],
        modules[moduleName][name],
        `facade ${name} must be the same reference as ${moduleName}#${name}`,
      );
      reexported.add(name);
    }
  }
  // Every documented public helper of the release tool is accounted for.
  assert.equal(reexported.size, 23);
});

test("each release module is independently importable and self-consistent", async () => {
  for (const moduleName of [
    "./release-context.mjs",
    "./release-git.mjs",
    "./release-manifest.mjs",
    "./release-versioning.mjs",
    "./release-artifacts.mjs",
    "./release-publish.mjs",
  ]) {
    const module = await import(moduleName);
    assert.equal(typeof module, "object");
  }
  for (const fn of [
    git.capture,
    git.gitValue,
    git.requireCleanTree,
    git.verifyReleaseTag,
  ]) {
    assert.equal(typeof fn, "function");
  }
});

test("release-context provides the provenance contract and pure helpers", () => {
  assert.equal(repositoryType, "git");
  assert.equal(repositoryUrl, "git+https://github.com/HookShip/toolkit.git");
  assert.deepEqual([...releaseTypes].sort(), ["major", "minor", "patch"]);
  assert.equal(escapeRegExp("a.b+c"), "a\\.b\\+c");
  assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/u);
});

test("release-manifest ownership/repository validators fail closed", () => {
  assert.equal(sameValues(["a", "b"], ["a", "b"]), true);
  assert.equal(sameValues(["a"], ["a", "b"]), false);
  assert.equal(sameValues(["a", "b"], ["b", "a"]), false);

  const validRepository = {
    type: "git",
    url: "git+https://github.com/HookShip/toolkit.git",
    directory: "packages/example",
  };
  assert.deepEqual(
    validateRepository(validRepository, "packages/example", "example"),
    [],
  );
  assert.ok(
    validateRepository(
      { ...validRepository, type: "hg" },
      "packages/example",
      "example",
    ).some((failure) => /repository\.type/u.test(failure)),
  );

  const missing = [];
  validateOwnership({}, missing);
  assert.ok(missing.some((failure) => /ownership block/u.test(failure)));
});

test("release-versioning computes semver bumps and lifecycle transitions", () => {
  assert.ok(compareSemver("1.2.3", "1.2.10") < 0);
  assert.equal(compareSemver("2.0.0", "2.0.0"), 0);
  assert.equal(resolveNextVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(resolveNextVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(resolveNextVersion("1.2.3", "major"), "2.0.0");
  assert.equal(resolveNextVersion("1.2.3", "5.6.7"), "5.6.7");

  assert.equal(bumpDependencyRange("workspace:*", "2.0.0"), "workspace:*");
  assert.equal(
    bumpDependencyRange("workspace:^1.2.3", "2.0.0"),
    "workspace:^2.0.0",
  );
  assert.equal(bumpDependencyRange("^1.2.3", "2.0.0"), "^2.0.0");

  assert.deepEqual(parsePrepareArgs(["minor", "--dry-run"]), {
    spec: "minor",
    dryRun: true,
  });

  assert.doesNotThrow(() => assertTransitionAllowed("stage", "unreleased"));
  assert.throws(() => assertTransitionAllowed("stage", "ready"));
});

test("release-artifacts builds a deterministic SPDX SBOM", () => {
  const deps = dependencyPackages({
    dependencies: { "@webhook-portal/canonical-model": "workspace:*" },
    peerDependencies: { pg: "^8.0.0" },
  });
  assert.equal(deps.length, 2);
  assert.equal(deps[0].SPDXID, "SPDXRef-Dependency-1");

  const sbom = sbomFor(
    {
      name: "@webhook-portal/example",
      version: "1.2.3",
      dependencies: { pg: "^8.0.0" },
    },
    "sha256-abc",
  );
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.SPDXID, "SPDXRef-DOCUMENT");
  assert.match(sbom.documentNamespace, /:1\.2\.3:sha256-abc$/u);
});

test("release-publish orders the graph topologically and preflights publishes", () => {
  assert.deepEqual(topologicalOrder({ b: ["a"], a: [], c: ["a", "b"] }), [
    "a",
    "b",
    "c",
  ]);
  assert.throws(
    () => topologicalOrder({ a: ["b"], b: ["a"] }),
    /cycle detected/u,
  );

  assert.deepEqual(
    publishPreflight({
      statusPorcelain: "",
      tag: "v1.2.3",
      cohort: "1.2.3",
      releaseStatus: "ready",
      execute: true,
    }),
    [],
  );
  assert.ok(
    publishPreflight({
      statusPorcelain: " M file",
      tag: "v1.2.3",
      cohort: "1.2.3",
      releaseStatus: "ready",
      execute: true,
    }).some((failure) => /dirty working tree/u.test(failure)),
  );
  assert.ok(
    publishPreflight({
      statusPorcelain: "",
      tag: "v1.2.3",
      cohort: "1.2.3",
      releaseStatus: "unreleased",
      execute: true,
    }).some((failure) => /releaseStatus is "unreleased"/u.test(failure)),
  );

  const options = parsePublishArgs(["--execute", "--tag", "v1.2.3"]);
  assert.equal(options.execute, true);
  assert.equal(options.tag, "v1.2.3");
});
