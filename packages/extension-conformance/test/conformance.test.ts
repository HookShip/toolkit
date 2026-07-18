// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EXAMPLE_TRANSFORM_ASSET,
  canonicalJsonAsset,
  createExampleTransformManifest,
  createExtensionBundle,
  normalizeExtensionManifestDraft,
  normalizePermissionSet,
  signExtensionBundle,
  type ExtensionBundle,
  type ExtensionDependency,
  type ExtensionKind,
  type SignatureTrustPolicy,
} from "@webhook-portal/extension-sdk";

import {
  MALICIOUS_EXTENSION_CORPUS,
  assertExtensionConformance,
  createExtensionConformanceCases,
  registerExtensionConformanceTests,
  runExtensionConformance,
  runMaliciousCorpus,
  type ConformanceTestRunner,
  type ExtensionConformanceFixture,
} from "../src/index.js";

function unsignedBundle(
  kind: ExtensionKind,
  options: {
    readonly dependencies?: readonly ExtensionDependency[];
    readonly id?: string;
  } = {},
): ExtensionBundle {
  if (kind === "transform") {
    return createExtensionBundle({
      manifest: createExampleTransformManifest(),
      assets: [
        {
          path: "transform.json",
          mediaType: "application/json",
          content: EXAMPLE_TRANSFORM_ASSET,
        },
      ],
    });
  }
  const id = options.id ?? `conformance.${kind}`;
  const common = {
    manifestVersion: "1.0",
    kind,
    identity: {
      id,
      name: `Conformance ${kind}`,
      version: "1.0.0",
      publisher: {
        id: "conformance.publisher",
        name: "Conformance Publisher",
        url: "https://example.com/",
      },
    },
    compatibility: {
      platform: "^1.0.0",
      sdk: "^0.1.0",
      dependencies: options.dependencies ?? [],
      conflicts: [],
    },
    provenance: {
      source: {
        repository: "https://example.com/extensions.git",
        revision: `${kind}-revision`,
      },
      build: {
        builder: "conformance-builder",
        buildType: "declarative-json",
        timestamp: "2026-07-18T00:00:00.000Z",
        reproducible: true,
      },
      sbom: {
        format: "webhook-portal-sbom-v1",
        dependencies: [],
      },
    },
  };
  switch (kind) {
    case "connector": {
      const content = canonicalJsonAsset({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {
          endpoint: { type: "string" },
        },
      });
      return createExtensionBundle({
        manifest: normalizeExtensionManifestDraft({
          ...common,
          capabilities: ["connector.configuration"],
          permissions: normalizePermissionSet({}),
          resources: [
            {
              path: "configuration.schema.json",
              mediaType: "application/schema+json",
            },
          ],
          entry: {
            type: "connector",
            configurationSchema: "configuration.schema.json",
            templates: [],
          },
        }),
        assets: [
          {
            path: "configuration.schema.json",
            mediaType: "application/schema+json",
            content,
          },
        ],
      });
    }
    case "policy": {
      const program = {
        version: "1.0",
        rules: [
          { op: "require", target: "metadata", path: "/eventType" },
          { op: "redact", target: "payload", path: "/email" },
        ],
      };
      return createExtensionBundle({
        manifest: normalizeExtensionManifestDraft({
          ...common,
          capabilities: ["policy.declarative"],
          permissions: normalizePermissionSet({
            metadataRead: ["/eventType"],
            payloadRead: ["/email"],
            payloadWrite: ["/email"],
          }),
          resources: [{ path: "policy.json", mediaType: "application/json" }],
          entry: { type: "policy", program: "policy.json" },
        }),
        assets: [
          {
            path: "policy.json",
            mediaType: "application/json",
            content: canonicalJsonAsset(program as never),
          },
        ],
      });
    }
    case "template":
      return createExtensionBundle({
        manifest: normalizeExtensionManifestDraft({
          ...common,
          capabilities: ["template.assets"],
          permissions: normalizePermissionSet({}),
          resources: [{ path: "message.txt", mediaType: "text/plain" }],
          entry: {
            type: "template",
            templates: [
              {
                name: "message",
                path: "message.txt",
                mediaType: "text/plain",
              },
            ],
          },
        }),
        assets: [
          {
            path: "message.txt",
            mediaType: "text/plain",
            content: "Message {{id}}",
          },
        ],
      });
  }
}

function fixture(kind: ExtensionKind): ExtensionConformanceFixture {
  const key = generateKeyPairSync("ed25519");
  const unsigned = unsignedBundle(kind);
  const bundle = signExtensionBundle(unsigned, {
    keyId: "conformance-key",
    privateKey: key.privateKey,
  });
  const trustPolicy: SignatureTrustPolicy = {
    keys: [
      {
        keyId: "conformance-key",
        publicKey: key.publicKey,
        status: "active",
      },
    ],
  };
  return {
    name: `${kind} fixture`,
    bundle,
    expectedKind: kind,
    platformVersion: kind === "transform" ? "0.1.0" : "1.2.0",
    sdkVersion: "0.1.0",
    trustPolicy,
    transformInput: {
      customer: { email: "customer@example.com" },
    },
    policyInput: {
      metadata: { eventType: "invoice.paid" },
      payload: { email: "customer@example.com" },
    },
    rebuild: () => unsignedBundle(kind),
  };
}

describe("extension conformance suite", () => {
  it.each(["connector", "policy", "template", "transform"] as const)(
    "passes all mandatory cases for a %s data pack",
    async (kind) => {
      const report = await runExtensionConformance(fixture(kind));
      expect(report.passed).toBe(true);
      expect(report.failed).toBe(0);
      expect(report.succeeded).toBe(7);
      expect(report.results.map((result) => result.category)).toEqual([
        "manifest",
        "bundle",
        "permissions",
        "transformer-policy",
        "compatibility",
        "determinism",
        "malicious-corpus",
      ]);
      expect(() => assertExtensionConformance(report)).not.toThrow();
    },
  );

  it("accepts a valid deterministic transitive dependency closure", async () => {
    const leaf = unsignedBundle("template", {
      id: "conformance.graph.leaf",
    });
    const middle = unsignedBundle("policy", {
      id: "conformance.graph.middle",
      dependencies: [
        {
          id: leaf.manifest.identity.id,
          range: "^1.0.0",
          optional: false,
        },
      ],
    });
    const root = unsignedBundle("connector", {
      id: "conformance.graph.root",
      dependencies: [
        {
          id: middle.manifest.identity.id,
          range: ">=1.0.0 <2.0.0",
          optional: false,
        },
      ],
    });
    const key = generateKeyPairSync("ed25519");
    const bundle = signExtensionBundle(root, {
      keyId: "dependency-graph-key",
      privateKey: key.privateKey,
    });
    const baseFixture: ExtensionConformanceFixture = {
      bundle,
      expectedKind: "connector",
      platformVersion: "1.2.0",
      sdkVersion: "0.1.0",
      trustPolicy: {
        keys: [
          {
            keyId: "dependency-graph-key",
            publicKey: key.publicKey,
            status: "active",
          },
        ],
      },
    };
    const manifests = [leaf.manifest, middle.manifest];
    const left = await runExtensionConformance({
      ...baseFixture,
      availableManifests: manifests,
    });
    const right = await runExtensionConformance({
      ...baseFixture,
      availableManifests: [...manifests].reverse(),
    });
    expect(left.passed).toBe(true);
    expect(right.passed).toBe(true);
    expect(left.results).toEqual(right.results);
  });

  it("reports tampered bundles without depending on a test framework", async () => {
    const complete = fixture("transform");
    const bundle = complete.bundle as ExtensionBundle;
    const signature = bundle.manifest.integrity.signatures[0];
    expect(signature).toBeDefined();
    const tampered = {
      ...complete,
      bundle: {
        ...bundle,
        manifest: {
          ...bundle.manifest,
          integrity: {
            ...bundle.manifest.integrity,
            signatures: [
              {
                ...signature,
                signature: `${
                  signature?.signature.startsWith("A") ? "B" : "A"
                }${signature?.signature.slice(1)}`,
              },
            ],
          },
        },
      },
    };
    const report = await runExtensionConformance(tampered);
    expect(report.passed).toBe(false);
    expect(report.failed).toBeGreaterThan(0);
    expect(() => assertExtensionConformance(report)).toThrow(
      /failed .*conformance case/u,
    );
  });

  it("registers cases through a framework-neutral runner interface", () => {
    const names: string[] = [];
    const runner: ConformanceTestRunner = {
      describe(name, body) {
        names.push(name);
        body();
      },
      test(name) {
        names.push(name);
      },
    };
    const extensionFixture = fixture("transform");
    registerExtensionConformanceTests(runner, extensionFixture);
    expect(names).toHaveLength(
      createExtensionConformanceCases(extensionFixture).length + 1,
    );
    expect(names[0]).toBe("transform fixture");
  });
});

describe("malicious extension corpus", () => {
  it("runs every closed corpus item and rejects all attacks", () => {
    const results = runMaliciousCorpus();
    expect(results).toHaveLength(MALICIOUS_EXTENSION_CORPUS.length);
    expect(results).toHaveLength(12);
    expect(results.every((result) => result.passed)).toBe(true);
  });
});
