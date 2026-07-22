// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  EvidenceValidationError,
  createEvidenceBundle,
  sanitizeEvidenceInput,
} from "../src/index.js";
import { validEvidenceInput } from "./fixtures.js";

describe("closed metadata sanitizer", () => {
  it("retains only canonical metadata and deeply freezes the snapshot", () => {
    const bundle = createEvidenceBundle(validEvidenceInput());

    expect(bundle.snapshot).toMatchObject({
      supportCaseId: "case_01",
      recordCount: 2,
      redactionPolicyVersion: "support-evidence-metadata-v1",
      selection: {
        purpose: "case-review",
      },
      sources: [{ sourceId: "source_01", recordCount: 2 }],
    });
    expect(bundle.snapshot.records[0]).toMatchObject({
      recordType: "event",
      occurredAt: "2026-07-18T10:01:00.000Z",
      ingestedAt: "2026-07-18T10:01:00.100Z",
    });
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.snapshot)).toBe(true);
    expect(Object.isFrozen(bundle.snapshot.records)).toBe(true);
    expect(Object.isFrozen(bundle.snapshot.records[0])).toBe(true);
  });

  it.each([
    "payload",
    "body",
    "requestHeaders",
    "url",
    "queryString",
    "authorization",
    "cookie",
    "secret",
    "cardNumber",
    "email",
    "customerName",
    "rawResponse",
  ])("rejects forbidden field %s without retaining its value", (field) => {
    const input = validEvidenceInput();
    const sensitiveValue = "plaintext-sensitive-value";
    Object.assign(input.records[0] as Record<string, unknown>, {
      [field]: sensitiveValue,
    });

    let thrown: unknown;
    try {
      createEvidenceBundle(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EvidenceValidationError);
    expect(JSON.stringify(thrown)).not.toContain(sensitiveValue);
    expect(String(thrown)).not.toContain(sensitiveValue);
  });

  it("rejects unknown keys, URLs, query strings, and sensitive-looking plaintext", () => {
    const unknown = validEvidenceInput();
    Object.assign(unknown.records[0] as Record<string, unknown>, {
      arbitraryMetadata: "value",
    });
    expect(() => createEvidenceBundle(unknown)).toThrowError(/unknown field/iu);

    const url = validEvidenceInput();
    url.supportCaseId = "https://example.test/case?id=1";
    expect(() => createEvidenceBundle(url)).toThrow(EvidenceValidationError);

    const email = validEvidenceInput();
    email.supportCaseId = "operator@example.test";
    expect(() => createEvidenceBundle(email)).toThrow(EvidenceValidationError);

    const payment = validEvidenceInput();
    payment.supportCaseId = "4111111111111111";
    expect(() => createEvidenceBundle(payment)).toThrow(
      EvidenceValidationError,
    );
  });

  it("does not invoke accessors and rejects prototypes, pollution keys, and binary values", () => {
    const accessorInput = validEvidenceInput();
    let accessed = false;
    Object.defineProperty(accessorInput.records[0], "status", {
      enumerable: true,
      configurable: true,
      get() {
        accessed = true;
        return "accepted";
      },
    });
    expect(() => createEvidenceBundle(accessorInput)).toThrow(
      EvidenceValidationError,
    );
    expect(accessed).toBe(false);

    const prototypeInput = validEvidenceInput();
    Object.setPrototypeOf(prototypeInput.records[0], { polluted: true });
    expect(() => createEvidenceBundle(prototypeInput)).toThrow(
      EvidenceValidationError,
    );

    const pollutionInput = validEvidenceInput();
    Object.defineProperty(pollutionInput.records[0], "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    expect(() => createEvidenceBundle(pollutionInput)).toThrow(
      EvidenceValidationError,
    );
    expect(
      (Object.prototype as unknown as Record<string, unknown>)["polluted"],
    ).toBeUndefined();

    const binaryInput = validEvidenceInput();
    (binaryInput.records[0] as Record<string, unknown>)["traceId"] =
      Buffer.from("not-metadata");
    expect(() => createEvidenceBundle(binaryInput)).toThrow(
      EvidenceValidationError,
    );
  });

  it("enforces record, byte, time-range, string, source-count, and lifetime bounds", () => {
    expect(() =>
      createEvidenceBundle(validEvidenceInput(), { maximumRecords: 1 }),
    ).toThrowError(/array length/iu);

    expect(() =>
      createEvidenceBundle(validEvidenceInput(), {
        maximumTimeRangeMs: 60_000,
      }),
    ).toThrowError(/time range/iu);

    expect(() =>
      createEvidenceBundle(validEvidenceInput(), { maximumBytes: 1_000 }),
    ).toThrowError(/output limit/iu);

    const longTrace = validEvidenceInput();
    longTrace.records[1]!.traceId = "a".repeat(129);
    expect(() => createEvidenceBundle(longTrace)).toThrowError(
      /string length/iu,
    );

    const wrongCount = validEvidenceInput();
    wrongCount.sources[0]!.recordCount = 1;
    expect(() => createEvidenceBundle(wrongCount)).toThrowError(
      /record count/iu,
    );

    const longLifetime = validEvidenceInput();
    longLifetime.expiresAt = "2026-09-18T10:06:00.000Z";
    expect(() => createEvidenceBundle(longLifetime)).toThrowError(/lifetime/iu);
  });

  it("requires neutral purpose categories and canonical timestamps", () => {
    const purpose = validEvidenceInput();
    purpose.selection.purpose = "prove-customer-fault";
    expect(() => sanitizeEvidenceInput(purpose)).toThrowError(/purpose/iu);

    const timestamp = validEvidenceInput();
    timestamp.createdAt = "2026-07-18 10:06:00Z";
    expect(() => sanitizeEvidenceInput(timestamp)).toThrowError(/timestamp/iu);
  });
});
