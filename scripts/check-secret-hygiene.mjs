// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenBasenames = new Set([".env", ".npmrc"]);
const reviewedFixturesAndDetectors = new Set([
  "extensions/test-fixtures/development-signing-key/DO-NOT-USE-IN-PRODUCTION-private.pem",
  "extensions/test/seed-packs.test.mjs",
  "packages/extension-sdk/src/bundle.ts",
  "scripts/check-secret-hygiene.mjs",
]);
const secretPatterns = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Stripe secret key", /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/],
];

async function listedFiles() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
    );
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`git ls-files exited ${code}`));
      resolve(
        Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean),
      );
    });
  });
}

const failures = [];
for (const relative of await listedFiles()) {
  if (reviewedFixturesAndDetectors.has(relative)) continue;
  const basename = path.basename(relative);
  if (
    forbiddenBasenames.has(basename) &&
    !relative.endsWith(".example") &&
    relative !== ".npmrc"
  ) {
    failures.push(`${relative}: forbidden secret-bearing filename`);
    continue;
  }
  const file = path.join(root, relative);
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > 2_000_000) continue;
  const content = await readFile(file);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) failures.push(`${relative}: possible ${label}`);
  }
}

if (failures.length > 0) {
  console.error("Secret hygiene failures:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    "No tracked or unignored file matches the high-confidence secret checks.",
  );
}
