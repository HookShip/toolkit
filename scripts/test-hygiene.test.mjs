// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const expectedTestWorkspaces = [
  "apps/control-plane-api",
  "apps/portal-web",
  "apps/reference-server",
  "apps/worker",
  "packages/adapter-conformance",
  "packages/adapter-generic-http",
  "packages/adapter-hookdeck",
  "packages/adapter-sdk",
  "packages/adapter-svix",
  "packages/billing",
  "packages/canonical-model",
  "packages/cli",
  "packages/compatibility-report",
  "packages/contract-core",
  "packages/db",
  "packages/extension-conformance",
  "packages/extension-registry",
  "packages/extension-sdk",
  "packages/kms",
  "packages/metering",
  "packages/migration-assessment",
  "packages/portal-components",
  "packages/signing",
  "packages/support-evidence",
  "packages/tenancy",
];
const testFilePattern = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;

async function workspaceDirectories(parent) {
  const entries = await readdir(path.join(root, parent), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
    .sort();
}

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await testFiles(entryPath)));
    } else if (testFilePattern.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

test("the test-bearing workspace inventory is explicit", async () => {
  const actual = [
    ...(await workspaceDirectories("apps")),
    ...(await workspaceDirectories("packages")),
  ].sort();
  assert.deepEqual(
    actual,
    expectedTestWorkspaces,
    "Classify every new workspace explicitly instead of allowing a silent testless scaffold.",
  );
});

test("no package script masks a missing Vitest suite", async () => {
  const manifests = [
    "package.json",
    "extensions/package.json",
    ...expectedTestWorkspaces.map((workspace) => `${workspace}/package.json`),
  ];
  for (const manifest of manifests) {
    const contents = await readFile(path.join(root, manifest), "utf8");
    assert.doesNotMatch(
      contents,
      /--passWithNoTests\b/u,
      `${manifest} must not mask missing tests`,
    );
  }
});

test("workspace tests cannot pass after accidental test deletion", async () => {
  for (const workspace of expectedTestWorkspaces) {
    const manifestPath = path.join(root, workspace, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const testScript = manifest.scripts?.test;
    assert.equal(
      typeof testScript,
      "string",
      `${workspace} must define a test script`,
    );
    assert.doesNotMatch(
      testScript,
      /(?:^|\s)--passWithNoTests(?:\s|$)/u,
      `${workspace} must fail when Vitest cannot find tests`,
    );
    assert.ok(
      (await testFiles(path.join(root, workspace))).length > 0,
      `${workspace} must contain at least one test file`,
    );
  }
});
