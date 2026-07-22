// SPDX-License-Identifier: Apache-2.0

import { CANONICAL_GOLDEN_VECTORS } from "@webhook-portal/canonical-model";
import { describe, expect, it } from "vitest";

import { canonicalJson, canonicalSha256 } from "../src/canonical.js";

describe("cross-package canonical golden vectors", () => {
  it.each(CANONICAL_GOLDEN_VECTORS)(
    "reproduces canonical bytes for $description",
    ({ input, canonical, sha256 }) => {
      expect(canonicalJson(input)).toBe(canonical);
      expect(canonicalSha256(input)).toBe(sha256);
    },
  );
});
