// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkBoundaries,
  isAllowedDirection,
  isAllowedWorkspaceDependency,
  isToolkitExtensionAssetTarget,
  privateAppDirectories,
  publicPackageDirectories,
  workspaceKind,
  workspacePackageName,
} from "./check-package-boundaries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedPackages = [
  "adapter-conformance",
  "adapter-generic-http",
  "adapter-sdk",
  "canonical-model",
  "cli",
  "compatibility-report",
  "contract-core",
  "extension-conformance",
  "extension-sdk",
  "migration-assessment",
  "portal-components",
  "signing",
  "support-evidence",
];

test("classifies exactly the 13 public packages and private app wrapper", async () => {
  assert.deepEqual([...publicPackageDirectories].sort(), expectedPackages);
  assert.deepEqual([...privateAppDirectories], ["reference-server"]);

  const packageDirectories = (
    await readdir(path.join(root, "packages"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const appDirectories = (
    await readdir(path.join(root, "apps"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(packageDirectories, expectedPackages);
  assert.deepEqual(appDirectories, ["reference-server"]);
  for (const directory of expectedPackages) {
    assert.equal(workspaceKind("packages", directory), "public-package");
  }
  assert.equal(workspaceKind("apps", "reference-server"), "private-app");
});

test("permits package dependencies and app-to-package dependencies only", () => {
  const kinds = ["public-package", "private-app"];
  for (const from of kinds) {
    for (const to of kinds) {
      assert.equal(
        isAllowedDirection(from, to),
        from === "public-package"
          ? to === "public-package"
          : to === "public-package",
        `${from}->${to}`,
      );
    }
  }
});

test("keeps extension-sdk on its minimal dependency allowlist", () => {
  for (const dependency of [
    "@webhook-portal/adapter-sdk",
    "@webhook-portal/canonical-model",
    "@webhook-portal/signing",
  ]) {
    assert.equal(
      isAllowedWorkspaceDependency(
        "packages",
        "extension-sdk",
        "public-package",
        dependency,
      ),
      true,
    );
  }
  assert.equal(
    isAllowedWorkspaceDependency(
      "packages",
      "extension-sdk",
      "public-package",
      "@webhook-portal/contract-core",
    ),
    false,
  );
});

test("keeps runtime workspaces independent from extension data assets", () => {
  for (const target of [
    path.join(root, "extensions", "connectors", "fixture.json"),
    path.join(root, "examples", "extensions", "fixture.json"),
  ]) {
    assert.equal(isToolkitExtensionAssetTarget("public-package", target), true);
    assert.equal(isToolkitExtensionAssetTarget("private-app", target), true);
  }
});

test("normalizes workspace subpath imports to their package name", () => {
  assert.equal(
    workspacePackageName("@webhook-portal/cli/reference-server"),
    "@webhook-portal/cli",
  );
  assert.equal(workspacePackageName("vitest"), undefined);
});

test("validates the real workspace manifests and imports", async () => {
  assert.deepEqual(await checkBoundaries(), []);
});

test("release manifest contains every public package and no app wrapper", async () => {
  const releaseManifest = JSON.parse(
    await readFile(path.join(root, "release", "manifest.json"), "utf8"),
  );
  const releasePaths = releaseManifest.openPackages
    .map((entry) => entry.path)
    .sort();
  assert.deepEqual(
    releasePaths,
    expectedPackages.map((directory) => `packages/${directory}`).sort(),
  );
  assert.equal(releasePaths.includes("apps/reference-server"), false);
});
