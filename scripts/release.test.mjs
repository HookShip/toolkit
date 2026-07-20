// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bumpDependencyRange,
  check,
  cohortVersion,
  compareSemver,
  internalDependencyGraph,
  loadManifest,
  parsePrepareArgs,
  parsePublishArgs,
  publishPreflight,
  resolveNextVersion,
  rewriteChangelogVersion,
  rewriteManifestVersions,
  rewritePackageJson,
  topologicalOrder,
  validateOwnership,
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
