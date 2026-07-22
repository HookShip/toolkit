// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  allowlist,
  evaluateSourceSizes,
  maximumSourceLines,
} from "./check-source-size.mjs";

test("the toolkit source tree satisfies the size ratchet", async () => {
  const { violations } = await evaluateSourceSizes();
  assert.deepEqual(violations, []);
});

test("every allowlisted hotspot exceeds the limit and is a real file", async () => {
  const { files } = await evaluateSourceSizes();
  const scanned = new Set(files.map((file) => file.split(/[\\/]/).join("/")));
  for (const [file, allowed] of allowlist) {
    assert.ok(
      allowed > maximumSourceLines,
      `${file} is allowlisted at ${allowed} but is not above the ${maximumSourceLines} line limit`,
    );
    assert.ok(scanned.has(file), `${file} is allowlisted but was not scanned`);
  }
});

test("the ratchet only grandfathers files, never new oversized files", () => {
  // The allowlist is a shrinking ledger: adding a brand-new oversized file must
  // be a deliberate, reviewable act, so the limit stays meaningfully low.
  assert.ok(maximumSourceLines <= 800);
  assert.ok(allowlist.size > 0);
});
