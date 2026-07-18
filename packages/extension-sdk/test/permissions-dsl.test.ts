// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SecretReference,
  analyzePolicyPermissions,
  analyzeTransformPermissions,
  authorizePermission,
  comparePermissionSets,
  createInstallationPermissionGrant,
  loadConnectorPack,
  loadPolicyProgram,
  loadTemplatePack,
  loadTransformProgram,
  normalizePermissionSet,
  runPolicy,
  runTransform,
  signExtensionBundle,
  validateConfigurationSchema,
  verifyExtensionBundle,
  type BundleVerificationResult,
} from "../src/index.js";

import { makeBundle } from "./fixtures.js";

describe("deny-by-default permissions", () => {
  it("normalizes scopes and compares wildcard coverage without escalation", () => {
    const granted = normalizePermissionSet({
      metadataRead: ["/event/**", "/event/id", "/event/id"],
      outboundHosts: ["*.example.com", "api.example.com"],
      payloadRead: [],
    });
    expect(granted.metadataRead).toEqual(["/event/**", "/event/id"]);
    expect(
      comparePermissionSets(
        {
          metadataRead: ["/event/type"],
          outboundHosts: ["hooks.example.com"],
        },
        granted,
      ).allowed,
    ).toBe(true);
    expect(
      comparePermissionSets({ payloadRead: ["/customer/email"] }, granted),
    ).toMatchObject({
      allowed: false,
      missing: { payloadRead: ["/customer/email"] },
    });
  });

  it("binds grants to extension identity and immutable bundle digest", () => {
    const bundle = makeBundle();
    expect(() =>
      createInstallationPermissionGrant({
        bundleDigest: bundle.manifest.integrity.bundleDigest,
        extensionId: bundle.manifest.identity.id,
        grantId: "grant-1",
        issuer: "control-plane",
        requested: bundle.manifest.permissions,
        granted: {
          ...bundle.manifest.permissions,
          payloadRead: ["*"],
        },
      }),
    ).toThrow(/exceed/u);

    const grant = createInstallationPermissionGrant({
      bundleDigest: bundle.manifest.integrity.bundleDigest,
      extensionId: bundle.manifest.identity.id,
      grantId: "grant-1",
      issuer: "control-plane",
      requested: {
        outboundHosts: ["*.example.com"],
        secretReferences: ["connector-api-key"],
      },
      granted: {
        outboundHosts: ["api.example.com"],
        secretReferences: ["connector-api-key"],
      },
    });
    expect(
      authorizePermission(grant, {
        extensionId: grant.extensionId,
        bundleDigest: grant.bundleDigest,
        operation: {
          kind: "outbound",
          hostUrl: "https://api.example.com/v1/events",
        },
      }),
    ).toEqual({ allowed: true, code: "ALLOWED" });
    expect(
      authorizePermission(grant, {
        extensionId: grant.extensionId,
        bundleDigest: grant.bundleDigest,
        operation: {
          kind: "outbound",
          hostUrl: "https://api.example.com.evil.test/v1/events",
        },
      }),
    ).toEqual({ allowed: false, code: "SCOPE_DENIED" });
    expect(
      authorizePermission(grant, {
        extensionId: grant.extensionId,
        bundleDigest: grant.bundleDigest,
        delegatedBy: "other.extension",
        operation: {
          kind: "secret-reference",
          reference: "connector-api-key",
        },
      }),
    ).toEqual({ allowed: false, code: "CONFUSED_DEPUTY" });
    expect(
      authorizePermission(grant, {
        extensionId: "other.extension",
        bundleDigest: grant.bundleDigest,
        operation: {
          kind: "secret-reference",
          reference: "connector-api-key",
        },
      }),
    ).toEqual({ allowed: false, code: "IDENTITY_MISMATCH" });
  });

  it("serializes secret references but never secret material", () => {
    const reference = new SecretReference("kms/connector/key-v2");
    expect(JSON.stringify(reference)).toBe(
      '{"type":"secret-reference","id":"kms/connector/key-v2"}',
    );
    expect(JSON.stringify(reference)).not.toContain("secret-value");
  });
});

describe("safe transform DSL", () => {
  const program = {
    version: "1.0",
    operations: [
      { op: "rename", from: "/customer/email", to: "/customer/contact" },
      { op: "drop", paths: ["/remove"] },
      { op: "set", path: "/constant", value: 7 },
      {
        op: "coalesce",
        from: ["/missing", "/backup"],
        to: "/chosen",
      },
      {
        op: "map-enum",
        path: "/status",
        map: { paid: "settled", failed: "rejected" },
      },
      {
        op: "format",
        to: "/message",
        template: "{{contact}}:{{status}}",
        variables: {
          contact: "/customer/contact",
          status: "/status",
        },
      },
    ],
  };

  it("executes only closed deterministic operations with explicit payload access", () => {
    const permissions = analyzeTransformPermissions(program);
    const output = runTransform(
      program,
      {
        customer: { email: "customer@example.com" },
        backup: "fallback",
        status: "paid",
        remove: true,
      },
      { permissions },
    );
    expect(output).toEqual({
      customer: { contact: "customer@example.com" },
      backup: "fallback",
      status: "settled",
      constant: 7,
      chosen: "fallback",
      message: "customer@example.com:settled",
    });
    expect(() => runTransform(program, {}, { permissions: {} })).toThrow(
      /Required permission scopes are missing/u,
    );
  });

  it("distinguishes explicit null enum mappings and defaults from absence", () => {
    const nullMapping = {
      version: "1.0",
      operations: [
        {
          op: "map-enum",
          path: "/status",
          map: { paid: null },
          default: "unknown",
        },
      ],
    };
    const permissions = analyzeTransformPermissions(nullMapping);
    expect(
      runTransform(nullMapping, { status: "paid" }, { permissions }),
    ).toEqual({ status: null });
    expect(
      runTransform(nullMapping, { status: "missing" }, { permissions }),
    ).toEqual({ status: "unknown" });

    const nullDefault = {
      version: "1.0",
      operations: [
        {
          op: "map-enum",
          path: "/status",
          map: {},
          default: null,
        },
      ],
    };
    expect(
      runTransform(
        nullDefault,
        { status: "missing" },
        {
          permissions: analyzeTransformPermissions(nullDefault),
        },
      ),
    ).toEqual({ status: null });

    const absentDefault = {
      version: "1.0",
      operations: [{ op: "map-enum", path: "/status", map: {} }],
    };
    expect(
      runTransform(
        absentDefault,
        { status: "missing" },
        {
          permissions: analyzeTransformPermissions(absentDefault),
        },
      ),
    ).toEqual({ status: "missing" });
  });

  it("accepts only prototype-safe enum maps and rejects inherited mappings", () => {
    const inheritedMap = Object.create({ paid: "polluted" }) as Record<
      string,
      string
    >;
    inheritedMap.failed = "rejected";
    const program = {
      version: "1.0",
      operations: [
        {
          op: "map-enum",
          path: "/status",
          map: inheritedMap,
          default: "unknown",
        },
      ],
    };
    expect(() => analyzeTransformPermissions(program)).toThrow(
      /Object\.prototype or a null prototype/u,
    );

    const dangerousMap = JSON.parse(
      '{"__proto__":"polluted","paid":"settled"}',
    ) as Record<string, string>;
    expect(() =>
      analyzeTransformPermissions({
        version: "1.0",
        operations: [{ op: "map-enum", path: "/status", map: dangerousMap }],
      }),
    ).toThrow(/dangerous field/u);
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();
  });

  it("blocks prototype pollution, depth, steps, and output expansion", () => {
    expect(() =>
      runTransform(
        {
          version: "1.0",
          operations: [{ op: "execute", command: "whoami" }],
        },
        {},
        { permissions: {} },
      ),
    ).toThrow(/unknown field|must be one of/u);
    expect(() =>
      runTransform(
        {
          version: "1.0",
          operations: [{ op: "set", path: "/__proto__/polluted", value: true }],
        },
        {},
        { permissions: { payloadWrite: ["*"] } },
      ),
    ).toThrow(/dangerous/u);
    expect(
      (Object.prototype as Record<string, unknown>).polluted,
    ).toBeUndefined();

    expect(() =>
      runTransform(
        {
          version: "1.0",
          operations: [{ op: "set", path: "/a", value: "x".repeat(32) }],
        },
        {},
        {
          permissions: { payloadWrite: ["/a"] },
          limits: { maximumOutputBytes: 16 },
        },
      ),
    ).toThrow(/output limit/u);
    expect(() =>
      runTransform(
        program,
        {},
        {
          permissions: analyzeTransformPermissions(program),
          limits: { maximumSteps: 1 },
        },
      ),
    ).toThrow(/step limit/u);
    expect(() =>
      runTransform(
        {
          version: "1.0",
          operations: [{ op: "set", path: "/a", value: true }],
        },
        { a: { b: { c: true } } },
        {
          permissions: { payloadWrite: ["/a"] },
          limits: { maximumDepth: 2 },
        },
      ),
    ).toThrow(/depth limit/u);
  });
});

describe("safe policy DSL", () => {
  it("runs metadata-only policies without payload access", () => {
    const program = {
      version: "1.0",
      rules: [
        { op: "require", target: "metadata", path: "/eventType" },
        {
          op: "classify",
          target: "metadata",
          path: "/tenantId",
          classification: "internal",
        },
      ],
    };
    const result = runPolicy(
      program,
      { metadata: { eventType: "invoice.paid", tenantId: "tenant-1" } },
      { permissions: analyzePolicyPermissions(program) },
    );
    expect(result.decision).toBe("allow");
    expect(result.payload).toBeUndefined();
    expect(result.findings).toEqual([
      {
        code: "field_classified",
        path: "/tenantId",
        ruleIndex: 1,
        severity: "info",
        target: "metadata",
        classification: "internal",
      },
    ]);
  });

  it("redacts, hashes, classifies, and denies deterministically", () => {
    const program = {
      version: "1.0",
      rules: [
        { op: "require", target: "metadata", path: "/eventType" },
        { op: "redact", target: "payload", path: "/customer/email" },
        { op: "hash", target: "payload", path: "/customer/ssn" },
        { op: "deny", target: "payload", path: "/blocked" },
        {
          op: "classify",
          target: "payload",
          path: "/customer/ssn",
          classification: "restricted",
        },
      ],
    };
    const input = {
      metadata: { eventType: "invoice.paid" },
      payload: {
        customer: { email: "a@example.com", ssn: "000-00-0000" },
        blocked: true,
      },
    };
    const permissions = analyzePolicyPermissions(program);
    const first = runPolicy(program, input, { permissions });
    const second = runPolicy(program, input, { permissions });
    expect(first).toEqual(second);
    expect(first.decision).toBe("deny");
    expect(first.payload).toMatchObject({
      customer: {
        email: "[REDACTED]",
        ssn: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    expect(first.findings.map((finding) => finding.code)).toEqual([
      "field_redacted",
      "field_hashed",
      "field_denied",
      "field_classified",
    ]);
    expect(() => runPolicy(program, input, { permissions: {} })).toThrow(
      /Required permission scopes are missing/u,
    );
  });
});

describe("configuration-only connector and template packs", () => {
  function verified(kind: "connector" | "policy" | "template" | "transform") {
    const key = generateKeyPairSync("ed25519");
    const bundle = signExtensionBundle(makeBundle({ kind }), {
      keyId: "pack-key",
      privateKey: key.privateKey,
    });
    return verifyExtensionBundle(bundle, {
      trustPolicy: {
        keys: [
          {
            keyId: "pack-key",
            publicKey: key.publicKey,
            status: "active",
          },
        ],
      },
    });
  }

  it("loads data assets without exposing provider-call execution", () => {
    const connector = loadConnectorPack(verified("connector"));
    expect(connector.configurationSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(connector.templates).toHaveProperty("request.template");
    expect(connector).not.toHaveProperty("execute");

    const templates = loadTemplatePack(verified("template"));
    expect(templates.templates.delivery).toEqual({
      content: "Delivery {{deliveryId}}",
      mediaType: "text/plain",
    });
    expect(loadTransformProgram(verified("transform")).version).toBe("1.0");
    expect(loadPolicyProgram(verified("policy")).version).toBe("1.0");
  });

  it("rejects executable or remotely resolved schema vocabulary", () => {
    expect(() =>
      validateConfigurationSchema({
        type: "object",
        $ref: "https://evil.example/schema.json",
      }),
    ).toThrow(/unknown field/u);
    expect(() =>
      validateConfigurationSchema({
        type: "object",
        additionalProperties: true,
      }),
    ).toThrow(/additionalProperties=false/u);
    expect(() =>
      loadConnectorPack({
        ok: false,
        issues: [],
        signatureErrors: [],
        validKeyIds: [],
      } satisfies BundleVerificationResult),
    ).toThrow(/verified bundle/u);
  });
});
