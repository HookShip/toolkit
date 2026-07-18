// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkBoundaries,
  cloudPackageDirectories,
  isAllowedDirection,
  isAllowedWorkspaceDependency,
  isOpenCoreExtensionAssetTarget,
  workspaceKind,
  workspacePackageName,
} from "./check-package-boundaries.mjs";

const kinds = ["open-package", "cloud-package", "open-app", "cloud-app"];
const allowed = new Set([
  "open-package->open-package",
  "cloud-package->open-package",
  "cloud-package->cloud-package",
  "open-app->open-package",
  "cloud-app->open-package",
  "cloud-app->cloud-package",
]);

test("permits only apps to cloud/open and cloud packages to open/cloud", () => {
  for (const from of kinds) {
    for (const to of kinds) {
      assert.equal(
        isAllowedDirection(from, to),
        allowed.has(`${from}->${to}`),
        `${from}->${to}`,
      );
    }
  }
});

test("classifies every managed workspace in the commercial layer", () => {
  for (const directory of [
    "adapter-hookdeck",
    "adapter-svix",
    "billing",
    "db",
    "extension-registry",
    "kms",
    "metering",
    "tenancy",
  ]) {
    assert.equal(workspaceKind("packages", directory), "cloud-package");
  }
  for (const directory of ["control-plane-api", "portal-web", "worker"]) {
    assert.equal(workspaceKind("apps", directory), "cloud-app");
  }
});

test("classifies extension SDK and conformance as open packages", () => {
  assert.equal(workspaceKind("packages", "extension-sdk"), "open-package");
  assert.equal(
    workspaceKind("packages", "extension-conformance"),
    "open-package",
  );
});

test("enforces extension package dependency boundaries", () => {
  assert.equal(
    isAllowedWorkspaceDependency(
      "packages",
      "extension-sdk",
      "open-package",
      "@webhook-portal/canonical-model",
    ),
    true,
  );
  assert.equal(
    isAllowedWorkspaceDependency(
      "packages",
      "extension-sdk",
      "open-package",
      "@webhook-portal/contract-core",
    ),
    false,
  );
  assert.equal(
    isAllowedWorkspaceDependency(
      "packages",
      "extension-conformance",
      "open-package",
      "@webhook-portal/extension-sdk",
    ),
    true,
  );
  assert.equal(
    isAllowedWorkspaceDependency(
      "packages",
      "extension-conformance",
      "cloud-package",
      "@webhook-portal/extension-registry",
    ),
    false,
  );
  assert.equal(
    isAllowedWorkspaceDependency(
      "packages",
      "extension-registry",
      "open-package",
      "@webhook-portal/extension-sdk",
    ),
    true,
  );
  assert.equal(
    isAllowedWorkspaceDependency(
      "packages",
      "extension-registry",
      "cloud-package",
      "@webhook-portal/db",
    ),
    true,
  );
});

test("treats extension examples and artifacts as data outside open core", () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  for (const target of [
    path.join(repositoryRoot, "extensions", "connectors", "fixture.json"),
    path.join(repositoryRoot, "examples", "extensions", "fixture.json"),
  ]) {
    assert.equal(isOpenCoreExtensionAssetTarget("open-package", target), true);
    assert.equal(isOpenCoreExtensionAssetTarget("open-app", target), true);
    assert.equal(
      isOpenCoreExtensionAssetTarget("cloud-package", target),
      false,
    );
  }
});

test("keeps the reference server in the open application layer", () => {
  assert.equal(workspaceKind("apps", "reference-server"), "open-app");
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

test("keeps commercial packages out of the release cohort", async () => {
  const releaseManifest = JSON.parse(
    await readFile(
      new URL("../release/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const releasePaths = releaseManifest.openPackages.map((entry) => entry.path);
  for (const directory of cloudPackageDirectories) {
    assert.equal(releasePaths.includes(`packages/${directory}`), false);
  }
});

test("packs implemented open extension packages but not the private registry", async () => {
  const releaseManifest = JSON.parse(
    await readFile(
      new URL("../release/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const releasePaths = releaseManifest.openPackages.map((entry) => entry.path);
  for (const directory of ["extension-sdk", "extension-conformance"]) {
    assert.equal(releasePaths.includes(`packages/${directory}`), true);
  }
  assert.equal(releasePaths.includes("packages/extension-registry"), false);
});
