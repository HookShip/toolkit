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
  lifecycleScriptViolations,
  validateOwnership,
  validateRepository,
} from "./release-manifest.mjs";
import {
  ciBuildContext,
  declaredLicense,
  dependencyPackages,
  provenanceStatement,
  purlName,
  resolveDependencyMetadata,
  sbomFor,
} from "./release-artifacts.mjs";
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

test("dependencyPackages uses resolved versions/licenses and falls back to the range", () => {
  const resolved = {
    pg: { version: "8.22.0", license: "MIT" },
    "@webhook-portal/canonical-model": {
      version: "0.1.0",
      license: "Apache-2.0",
    },
  };
  const deps = dependencyPackages(
    {
      dependencies: {
        pg: "^8.0.0",
        "@webhook-portal/canonical-model": "0.1.0",
      },
      peerDependencies: { unresolved: "^3.0.0" },
    },
    resolved,
  );
  const pg = deps.find((d) => d.name === "pg");
  assert.equal(pg.versionInfo, "8.22.0");
  assert.equal(pg.licenseConcluded, "MIT");
  assert.equal(pg.licenseDeclared, "MIT");
  assert.deepEqual(pg.externalRefs, [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: "pkg:npm/pg@8.22.0",
    },
  ]);
  // A scoped resolved dependency gets a percent-encoded purl namespace.
  const canonical = deps.find(
    (d) => d.name === "@webhook-portal/canonical-model",
  );
  assert.equal(
    canonical.externalRefs[0].referenceLocator,
    "pkg:npm/%40webhook-portal/canonical-model@0.1.0",
  );
  // An unresolved dependency keeps its declared range and NOASSERTION license
  // and carries no purl (no exact version is known).
  const unresolved = deps.find((d) => d.name === "unresolved");
  assert.equal(unresolved.versionInfo, "^3.0.0");
  assert.equal(unresolved.licenseDeclared, "NOASSERTION");
  assert.equal(unresolved.externalRefs, undefined);
});

test("purlName percent-encodes scoped names and passes through unscoped names", () => {
  assert.equal(purlName("pg"), "pg");
  assert.equal(purlName("@webhook-portal/cli"), "%40webhook-portal/cli");
});

test("declaredLicense reads string, deprecated object, and array license forms", () => {
  assert.equal(declaredLicense({ license: "MIT" }), "MIT");
  assert.equal(declaredLicense({ license: { type: "ISC" } }), "ISC");
  assert.equal(
    declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    "(MIT OR Apache-2.0)",
  );
  assert.equal(declaredLicense({}), null);
  assert.equal(declaredLicense(null), null);
});

test("resolveDependencyMetadata reads exact versions and licenses from the install tree", async () => {
  // The CLI depends on `yaml`, resolvable from its local node_modules.
  const resolved = await resolveDependencyMetadata(
    { dependencies: { yaml: "^2.9.0" } },
    "packages/cli",
  );
  assert.ok(resolved.yaml, "yaml should resolve from packages/cli");
  assert.match(resolved.yaml.version, /^\d+\.\d+\.\d+/u);
  assert.equal(typeof resolved.yaml.license, "string");
  // An unknown dependency is simply omitted, never invented.
  const missing = await resolveDependencyMetadata(
    { dependencies: { "definitely-not-installed-xyz": "^1.0.0" } },
    "packages/cli",
  );
  assert.equal(missing["definitely-not-installed-xyz"], undefined);
});

test("ciBuildContext reports CI metadata only when present and never invents it", () => {
  const local = ciBuildContext({ GITHUB_ACTIONS: "false" });
  assert.equal(local.onCi, false);
  assert.equal(local.invocationId, null);
  assert.equal(local.builderId, "urn:hookship-toolkit:local-release-script");

  const ci = ciBuildContext({
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: "42",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "HookShip/toolkit",
    GITHUB_WORKFLOW_REF:
      "HookShip/toolkit/.github/workflows/release.yml@refs/tags/v1.2.3",
  });
  assert.equal(ci.onCi, true);
  assert.equal(
    ci.invocationId,
    "https://github.com/HookShip/toolkit/actions/runs/42",
  );
  assert.match(ci.builderId, /release\.yml@refs\/tags\/v1\.2\.3$/u);
});

test("provenanceStatement marks itself supplementary and unsigned vs npm OIDC", () => {
  const statement = provenanceStatement({
    entry: { name: "@webhook-portal/example", version: "1.2.3" },
    checksum: "sha256-abc",
    relativeTarball: "tarballs/example/x.tgz",
    commit: "deadbeef",
    dirty: false,
    lockChecksum: "sha256-lock",
    ci: { builderId: "urn:x", invocationId: null },
  });
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
  const attestation =
    statement.predicate.buildDefinition.internalParameters.attestation;
  assert.equal(attestation.signed, false);
  assert.equal(attestation.supplementary, true);
  assert.equal(
    attestation.authoritativeProvenance,
    "npm registry OIDC provenance",
  );
  assert.equal(
    statement.predicate.buildDefinition.resolvedDependencies[0].digest.sha256,
    "sha256-lock",
  );
});

test("lifecycleScriptViolations flags automatic install/publish hooks only", () => {
  assert.deepEqual(
    lifecycleScriptViolations({
      scripts: { build: "tsc", test: "vitest", pretypecheck: "x" },
    }),
    [],
  );
  assert.deepEqual(
    lifecycleScriptViolations({
      scripts: { postinstall: "curl evil", prepublishOnly: "x", build: "tsc" },
    }),
    ["postinstall", "prepublishOnly"],
  );
  assert.deepEqual(lifecycleScriptViolations({}), []);
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
