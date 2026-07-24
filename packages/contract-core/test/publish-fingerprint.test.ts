// SPDX-License-Identifier: Apache-2.0

import { sha256Hex } from "@webhook-portal/canonical-model";
import { describe, expect, it } from "vitest";

import { publishRequestFingerprint } from "../src/publish-fingerprint.js";

describe("publishRequestFingerprint", () => {
  it("matches the documented sha256(JSON) encoding with a null sentinel", () => {
    const checksum = "sha256:abc123";
    const expected = sha256Hex(
      JSON.stringify({ canonicalChecksum: checksum, overrideReason: null }),
    );
    expect(publishRequestFingerprint(checksum)).toBe(expected);
  });

  it("is deterministic for identical inputs", () => {
    expect(publishRequestFingerprint("sha256:aa", "compat override")).toBe(
      publishRequestFingerprint("sha256:aa", "compat override"),
    );
  });

  it("distinguishes an absent reason from an empty-string reason", () => {
    expect(publishRequestFingerprint("sha256:aa")).not.toBe(
      publishRequestFingerprint("sha256:aa", ""),
    );
  });

  it("changes when the override reason changes", () => {
    expect(publishRequestFingerprint("sha256:aa", "reason-a")).not.toBe(
      publishRequestFingerprint("sha256:aa", "reason-b"),
    );
  });

  it("changes when the canonical checksum changes", () => {
    expect(publishRequestFingerprint("sha256:aa")).not.toBe(
      publishRequestFingerprint("sha256:bb"),
    );
  });
});
