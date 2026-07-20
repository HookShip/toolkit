// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  check,
  cohortVersion,
  loadManifest,
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
