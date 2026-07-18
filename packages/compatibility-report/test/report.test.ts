// SPDX-License-Identifier: Apache-2.0

import {
  diffContracts,
  importContract,
  type CanonicalContract,
  type CompatibilityChange,
  type CompatibilityResult,
  type JsonObject,
  type JsonSchema,
} from "@webhook-portal/contract-core";
import { describe, expect, it } from "vitest";

import {
  createCompatibilityReport,
  renderCompatibilityReportJson,
  renderCompatibilityReportMarkdown,
  verifyCompatibilityReport,
} from "../src/index.js";

const baseSchema: JsonSchema = {
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    state: { enum: ["new", "paid"], type: "string" },
  },
  required: ["id"],
  type: "object",
};

function contract(
  schema: JsonSchema = baseSchema,
  options: {
    readonly description?: string;
    readonly eventName?: string;
    readonly publicVersion?: string;
    readonly signature?: JsonObject | boolean;
    readonly title?: string;
  } = {},
): CanonicalContract {
  const eventName = options.eventName ?? "invoice.created";
  const source: JsonObject = {
    info: {
      title: options.title ?? "Billing",
      version: options.publicVersion ?? "1",
    },
    openapi: "3.1.0",
    webhooks: {
      [eventName]: {
        post: {
          ...(options.description === undefined
            ? {}
            : { description: options.description }),
          requestBody: {
            content: { "application/json": { schema } },
          },
          responses: { "200": { description: "Accepted" } },
          "x-event-type": eventName,
        },
      },
    },
    ...(options.signature === undefined
      ? {}
      : { "x-standard-webhooks": options.signature }),
  };
  const result = importContract(source);
  if (result.contract === undefined) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.contract;
}

function suppliedDiff(
  previous: CanonicalContract,
  next: CanonicalContract,
  changes: readonly CompatibilityChange[],
  status: CompatibilityResult["status"],
): CompatibilityResult {
  return {
    changes,
    nextChecksum: next.checksum,
    previousChecksum: previous.checksum,
    status,
    summary: "Ignored by the report",
  };
}

describe("compatibility report", () => {
  it("reports breaking removals without claiming consumer usage", () => {
    const previous = contract();
    const next = contract(baseSchema, { eventName: "invoice.renamed" });
    const report = createCompatibilityReport(previous, next);

    expect(report).toMatchObject({
      consumerImpact: {
        summary: expect.stringContaining(
          "does not assert actual consumer usage",
        ),
      },
      decision: "block",
      status: "breaking",
    });
    expect(report.groups.flatMap(({ changes }) => changes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EVENT_REMOVED", priority: "P0" }),
      ]),
    );
    expect(report.rollout.dualVersion.applicable).toBe(true);
  });

  it("reports compatible additions as conditional on verification", () => {
    const nextSchema: JsonSchema = {
      ...baseSchema,
      properties: {
        ...((baseSchema as JsonObject)["properties"] as JsonObject),
        note: { type: "string" },
      },
    };
    const report = createCompatibilityReport(contract(), contract(nextSchema));

    expect(report.status).toBe("compatible");
    expect(report.decision).toBe("proceed-with-verification");
    expect(report.executiveSummary.headline).toContain("require verification");
    expect(report.remediation.recommended[0]?.changeCode).toBe(
      "OPTIONAL_PROPERTY_ADDED",
    );

    const producer = createCompatibilityReport(
      contract(),
      contract(nextSchema),
      {
        view: "producer",
      },
    );
    const markdown = renderCompatibilityReportMarkdown(producer);
    expect(markdown).toContain("## Producer impact");
    expect(markdown).not.toContain("## Consumer impact");
    expect(producer.consumerImpact.summary).toContain(
      "does not assert actual consumer usage",
    );
  });

  it("reports documentation-only changes without copying descriptions", () => {
    const malicious = `<script>alert("copied")</script>`;
    const report = createCompatibilityReport(
      contract(baseSchema, { description: "Before" }),
      contract(baseSchema, { description: malicious }),
    );
    const markdown = renderCompatibilityReportMarkdown(report);

    expect(report.status).toBe("docs-only");
    expect(markdown).not.toContain("alert");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("documentation");
  });

  it("keeps unsupported and unrecognized changes unknown", () => {
    const unsupported: JsonSchema = {
      ...baseSchema,
      not: { required: ["legacy"] },
    };
    const previous = contract();
    const next = contract(unsupported);
    expect(createCompatibilityReport(previous, next)).toMatchObject({
      decision: "review",
      status: "unknown",
      uncertainty: { requiresReview: true },
    });

    const unknown = suppliedDiff(
      previous,
      previous,
      [
        {
          code: "FUTURE_MEANING",
          kind: "schema-changed",
          message: "Do not trust this narrative",
          pointer: "/",
          status: "compatible",
        },
      ],
      "compatible",
    );
    const report = createCompatibilityReport(previous, previous, {
      diff: unknown,
    });
    expect(report.status).toBe("unknown");
    expect(report.groups[0]?.changes[0]).toMatchObject({
      code: "FUTURE_MEANING",
      status: "unknown",
      title: "Unrecognized compatibility change",
    });
    expect(renderCompatibilityReportJson(report)).not.toContain(
      "Do not trust this narrative",
    );
  });

  it("covers event versions and signature changes", () => {
    const versionReport = createCompatibilityReport(
      contract(baseSchema, { publicVersion: "1" }),
      contract(baseSchema, { publicVersion: "2" }),
    );
    expect(versionReport.groups.flatMap(({ changes }) => changes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "EVENT_VERSION_ADDED",
          version: "2",
        }),
      ]),
    );

    const signatureReport = createCompatibilityReport(
      contract(baseSchema, { signature: true }),
      contract(baseSchema, {
        signature: { algorithm: "ed25519", name: "custom" },
      }),
    );
    expect(signatureReport).toMatchObject({
      rollout: { rollback: { required: true } },
      status: "breaking",
    });
    expect(
      signatureReport.groups
        .flatMap(({ changes }) => changes)
        .some(({ code }) => code.includes("SIGNATURE_PROFILE_CHANGED")),
    ).toBe(true);
  });

  it("bounds changes, groups, text, steps, and output", () => {
    const previous = contract();
    const next = contract();
    const changes: CompatibilityChange[] = Array.from(
      { length: 20 },
      (_, index) => ({
        code: "OPTIONAL_PROPERTY_ADDED",
        eventId: `event-${index}`,
        kind: "property-added",
        message: "ignored",
        pointer: `/properties/${index}`,
        status: "compatible",
      }),
    );
    const report = createCompatibilityReport(previous, next, {
      diff: suppliedDiff(previous, next, changes, "compatible"),
      limits: {
        maxChanges: 5,
        maxGroups: 2,
        maxSteps: 1,
        maxTextCodePoints: 8,
      },
    });
    const json = renderCompatibilityReportJson(report);

    expect(report.status).toBe("unknown");
    expect(report.groups).toHaveLength(2);
    expect(report.remediation.recommended).toHaveLength(1);
    expect(report.groups[0]?.eventName?.length).toBeLessThanOrEqual(8);
    expect(json.length).toBeLessThan(15_000);
    expect(report.uncertainty.disclosures.join(" ")).toContain("omitted");
  });

  it("escapes malicious event names and preserves Unicode safely", () => {
    const eventName = `<img src=x onerror=alert(1)>-注文-🚀`;
    const previous = contract(baseSchema, { eventName: "safe.event" });
    const next = contract(baseSchema, { eventName });
    const report = createCompatibilityReport(previous, next);
    const markdown = renderCompatibilityReportMarkdown(report);
    const json = renderCompatibilityReportJson(report);

    expect(markdown).not.toContain("<img");
    expect(markdown).toContain("&lt;img");
    expect(markdown).toContain("注文");
    expect(json).not.toContain("<img");
    expect(json).toContain("\\u003cimg");
    expect(JSON.parse(json)).toEqual(report);
  });

  it("is reproducible across diff order and object key insertion order", () => {
    const previous = contract();
    const next = contract();
    const changes: CompatibilityChange[] = [
      {
        code: "EVENT_ADDED",
        eventId: "β",
        kind: "event-added",
        message: "ignored",
        pointer: "/eventTypes/β",
        status: "compatible",
      },
      {
        code: "CONTRACT_DOCUMENTATION_CHANGED",
        kind: "documentation-changed",
        message: "ignored",
        pointer: "",
        status: "docs-only",
      },
    ];
    const forward = createCompatibilityReport(previous, next, {
      diff: suppliedDiff(previous, next, changes, "compatible"),
    });
    const reverse = createCompatibilityReport(previous, next, {
      diff: suppliedDiff(previous, next, [...changes].reverse(), "compatible"),
    });

    expect(renderCompatibilityReportJson(forward)).toBe(
      renderCompatibilityReportJson(reverse),
    );
    expect(forward.integrity.value).toBe(reverse.integrity.value);
    expect({
      decision: forward.decision,
      groups: forward.groups.map((group) => ({
        codes: group.changes.map(({ code }) => code),
        scope: group.scope,
      })),
      status: forward.status,
    }).toMatchInlineSnapshot(`
      {
        "decision": "proceed-with-verification",
        "groups": [
          {
            "codes": [
              "CONTRACT_DOCUMENTATION_CHANGED",
            ],
            "scope": "contract",
          },
          {
            "codes": [
              "EVENT_ADDED",
            ],
            "scope": "event",
          },
        ],
        "status": "compatible",
      }
    `);
  });

  it("verifies checksums and detects tampering", () => {
    const previous = contract();
    const next = contract(baseSchema, { title: "Next" });
    const report = createCompatibilityReport(previous, next);

    expect(
      verifyCompatibilityReport(report, {
        nextCanonicalChecksum: next.checksum.value,
        previousCanonicalChecksum: previous.checksum.value,
      }),
    ).toEqual({ errors: [], valid: true });

    const tampered = {
      ...report,
      decision: "block" as const,
    };
    expect(verifyCompatibilityReport(tampered)).toMatchObject({
      errors: ["Report checksum mismatch"],
      valid: false,
    });
  });

  it("rejects a supplied diff for different contracts", () => {
    const previous = contract();
    const next = contract(baseSchema, { title: "Next" });
    expect(() =>
      createCompatibilityReport(previous, next, {
        diff: diffContracts(previous, previous),
      }),
    ).toThrow("Diff next checksum does not match next contract");
  });
});
