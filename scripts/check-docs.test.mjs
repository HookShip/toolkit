// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkDocs,
  checkLinks,
  checkNavigation,
  checkNoInventedReferences,
  hookServiceRolePhrase,
  requiredNavigation,
  stripCode,
  verifiedRepos,
  verifyHookshipRepo,
} from "./check-docs.mjs";

test("the repository documentation passes every offline check", async () => {
  assert.deepEqual(await checkDocs(), []);
});

test("only the four real HookShip repositories are accepted", () => {
  assert.deepEqual([...verifiedRepos].sort(), [
    ".github",
    "hook-service",
    "platform",
    "toolkit",
  ]);
  assert.equal(verifyHookshipRepo("toolkit"), true);
  assert.equal(verifyHookshipRepo("toolkit.git"), true);
  assert.equal(verifyHookshipRepo("hook-service"), true);
  assert.equal(verifyHookshipRepo("marketing-site"), false);
});

test("stripCode removes fenced and inline code", () => {
  const stripped = stripCode(
    "prose `inline@example.com` more\n```\nblock@example.com\n```\nend",
  );
  assert.doesNotMatch(stripped, /inline@example\.com/);
  assert.doesNotMatch(stripped, /block@example\.com/);
  assert.match(stripped, /prose/);
  assert.match(stripped, /end/);
});

test("checkLinks flags broken relative links but ignores external and code", () => {
  assert.deepEqual(checkLinks("docs/x.md", "[ok](../README.md)"), []);
  assert.deepEqual(checkLinks("docs/x.md", "[ext](https://example.com)"), []);
  assert.deepEqual(checkLinks("docs/x.md", "[anchor](#section)"), []);
  const broken = checkLinks("docs/x.md", "[missing](./does-not-exist.md)");
  assert.equal(broken.length, 1);
  assert.match(broken[0], /broken relative link/);
  // A link that only appears inside a code fence is an example, not a link.
  assert.deepEqual(checkLinks("docs/x.md", "```\n[x](./nope.md)\n```"), []);
});

test("checkWorkspacePathReferences flags moved or renamed source files", async () => {
  const { checkWorkspacePathReferences } = await import("./check-docs.mjs");
  // A real, present workspace file passes.
  assert.deepEqual(
    checkWorkspacePathReferences("d.md", "see `scripts/check-docs.mjs`"),
    [],
  );
  // A moved/renamed source file is flagged.
  const moved = checkWorkspacePathReferences(
    "d.md",
    "see `packages/cli/src/reference-server/server.ts`",
  );
  assert.equal(moved.length, 1);
  assert.match(moved[0], /missing workspace file/);
  // Generated/installed trees are ignored (they do not exist until built).
  assert.deepEqual(
    checkWorkspacePathReferences("d.md", "run `packages/cli/dist/bin.js`"),
    [],
  );
  // Non-path prose and globs are ignored.
  assert.deepEqual(
    checkWorkspacePathReferences(
      "d.md",
      "`packages/*/package.json` and `pnpm build`",
    ),
    [],
  );
});

test("checkCriticalAnchors confirms critical commands, env vars, and ports exist", async () => {
  const { checkCriticalAnchors } = await import("./check-docs.mjs");
  assert.deepEqual(await checkCriticalAnchors(), []);
});

test("checkNoInventedReferences flags invented repos, contacts, SLAs, and GA claims", () => {
  assert.ok(
    checkNoInventedReferences(
      "d.md",
      "see https://github.com/HookShip/made-up-repo",
    ).some((f) => /non-existent HookShip repository "made-up-repo"/.test(f)),
  );
  assert.ok(
    checkNoInventedReferences("d.md", "email us at team@hookship.dev").some(
      (f) => /unexpected contact email/.test(f),
    ),
  );
  assert.ok(
    checkNoInventedReferences("d.md", "we guarantee 99.9% uptime").some((f) =>
      /availability\/SLA percentage/.test(f),
    ),
  );
  assert.ok(
    checkNoInventedReferences(
      "d.md",
      "the product is generally available",
    ).some((f) => /generally available/.test(f)),
  );
});

test("checkNoInventedReferences accepts verified repos and example domains", () => {
  assert.deepEqual(
    checkNoInventedReferences(
      "d.md",
      "consume https://github.com/HookShip/hook-service and post to user@example.com",
    ),
    [],
  );
  // A "no SLA" statement is a denial, not a percentage claim, and is allowed.
  assert.deepEqual(
    checkNoInventedReferences("d.md", "There is no uptime SLA."),
    [],
  );
});

test("checkNavigation requires the org policies, hook-service, and its role", () => {
  const complete = `${requiredNavigation.join(" ")} ${hookServiceRolePhrase}`;
  assert.deepEqual(checkNavigation(complete), []);
  const missing = checkNavigation("nothing here");
  assert.equal(missing.length, requiredNavigation.length + 1);
  assert.ok(missing.some((f) => /delivery data plane/.test(f)));
});
