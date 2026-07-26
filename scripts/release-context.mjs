// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const manifestPath = path.join(root, "release", "manifest.json");

export const workRoot = path.join(root, ".release-work");

export const referenceAppPath = "apps/reference-server";

export const publicPackageCount = 14;

export const supportedSchemaVersion = 2;

export const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export const releaseStatuses = new Set(["unreleased", "ready"]);

export const changelogUnreleasedStatus = "Release status: unreleased.";

export const changelogReadyStatusLine = /^Release status: ready\./m;

export const changelogAnyStatusLine =
  /^Release status: (?:unreleased\.|ready\.[^\n]*)$/m;

export const releaseTransitions = {
  stage: { from: "unreleased", to: "ready" },
  "open-next": { from: "ready", to: "unreleased" },
};

export const expectedOwnership = {
  sourceOfTruth: "this repository",
  scope: "@webhook-portal",
  coordinatedVersioning: "lockstep",
  rename: "none",
};

export const repositoryType = "git";

export const repositoryUrl = "git+https://github.com/HookShip/toolkit.git";

export const releaseTypes = new Set(["major", "minor", "patch"]);

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function sha256File(file) {
  const content = await readFile(file);
  return createHash("sha256").update(content).digest("hex");
}

export async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: process.env,
      stdio: options.quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
