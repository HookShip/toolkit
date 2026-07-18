// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createEvidenceBundle,
  evidenceSnapshotDigest,
  parseEvidenceBundle,
} from "../src/index.js";
import { validEvidenceInput } from "./fixtures.js";

describe("canonical evidence bundles", () => {
  it("produces deterministic ordering and digests independent of input order", () => {
    const firstInput = validEvidenceInput();
    const secondInput = validEvidenceInput();
    secondInput.records.reverse();

    const first = createEvidenceBundle(firstInput);
    const second = createEvidenceBundle(secondInput);

    expect(second.digest).toBe(first.digest);
    expect(canonicalJson(second.snapshot)).toBe(canonicalJson(first.snapshot));
    expect(evidenceSnapshotDigest(first.snapshot)).toBe(first.digest);
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("changes the digest when allowed evidence metadata changes", () => {
    const first = createEvidenceBundle(validEvidenceInput());
    const changedInput = validEvidenceInput();
    changedInput.records[1]!.status = "retried";
    const changed = createEvidenceBundle(changedInput);

    expect(changed.digest).not.toBe(first.digest);
  });

  it("uses locale-independent UTF-16 object ordering", () => {
    expect(canonicalJson({ ä: 1, z: 2, İ: 3, i: 4 })).toBe(
      '{"i":4,"z":2,"ä":1,"İ":3}',
    );
  });

  it("round-trips strict canonical bundles and rejects added artifact fields", () => {
    const bundle = createEvidenceBundle(validEvidenceInput());
    expect(parseEvidenceBundle(structuredClone(bundle))).toEqual(bundle);

    const extra = {
      ...structuredClone(bundle),
      privateKey: "must-not-be-accepted",
    };
    expect(() => parseEvidenceBundle(extra)).toThrowError(/unknown field/iu);
  });
});
