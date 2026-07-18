// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";

import {
  EXAMPLE_TRANSFORM_ASSET,
  HARD_BUNDLE_LIMITS,
  createExampleTransformManifest,
  createExtensionBundle,
  createInstallationPermissionGrant,
  normalizeExtensionManifestDraft,
  parseExtensionBundle,
  runTransform,
  signExtensionBundle,
  verifyExtensionBundle,
} from "@webhook-portal/extension-sdk";

import { ensureConformance } from "./runner.js";

export const MALICIOUS_CORPUS_IDS = [
  "asset-path-traversal",
  "binary-control-data",
  "bundle-compression-field",
  "duplicate-resource-path",
  "executable-asset-path",
  "manifest-unknown-field",
  "oversized-asset",
  "permission-escalation",
  "prototype-pollution-pointer",
  "serialized-secret-material",
  "signature-revocation",
  "signature-tamper",
] as const;
export type MaliciousCorpusId = (typeof MALICIOUS_CORPUS_IDS)[number];

export interface MaliciousCorpusDescriptor {
  readonly description: string;
  readonly id: MaliciousCorpusId;
}

export interface MaliciousCorpusResult extends MaliciousCorpusDescriptor {
  readonly message?: string;
  readonly passed: boolean;
}

export const MALICIOUS_EXTENSION_CORPUS: readonly MaliciousCorpusDescriptor[] =
  Object.freeze([
    {
      id: "asset-path-traversal",
      description: "Rejects parent-directory traversal in asset paths.",
    },
    {
      id: "binary-control-data",
      description: "Rejects binary/control bytes in data-only assets.",
    },
    {
      id: "bundle-compression-field",
      description: "Rejects undeclared compression/decompression metadata.",
    },
    {
      id: "duplicate-resource-path",
      description: "Rejects duplicate and case-colliding resource paths.",
    },
    {
      id: "executable-asset-path",
      description: "Rejects executable file suffixes.",
    },
    {
      id: "manifest-unknown-field",
      description: "Rejects unknown manifest fields.",
    },
    {
      id: "oversized-asset",
      description: "Rejects data assets above the hard byte bound.",
    },
    {
      id: "permission-escalation",
      description: "Rejects installation grants beyond requested scopes.",
    },
    {
      id: "prototype-pollution-pointer",
      description: "Rejects dangerous declarative JSON Pointer segments.",
    },
    {
      id: "serialized-secret-material",
      description: "Rejects recognized serialized secret material fields.",
    },
    {
      id: "signature-revocation",
      description: "Excludes signatures made by revoked keys.",
    },
    {
      id: "signature-tamper",
      description: "Rejects modified Ed25519 signatures.",
    },
  ]);

function expectRejected(action: () => unknown): void {
  let rejected = false;
  try {
    action();
  } catch {
    rejected = true;
  }
  ensureConformance(rejected, "Malicious input was unexpectedly accepted.");
}

function exampleBundle() {
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

export function runMaliciousCorpusCase(id: MaliciousCorpusId): void {
  const draft = createExampleTransformManifest();
  switch (id) {
    case "asset-path-traversal":
      expectRejected(() =>
        createExtensionBundle({
          manifest: draft,
          assets: [
            {
              path: "../transform.json",
              mediaType: "application/json",
              content: EXAMPLE_TRANSFORM_ASSET,
            },
          ],
        }),
      );
      return;
    case "binary-control-data":
      expectRejected(() =>
        createExtensionBundle({
          manifest: draft,
          assets: [
            {
              path: "transform.json",
              mediaType: "application/json",
              content: `${EXAMPLE_TRANSFORM_ASSET}\u0000`,
            },
          ],
        }),
      );
      return;
    case "bundle-compression-field":
      expectRejected(() =>
        parseExtensionBundle({ ...exampleBundle(), compression: "gzip" }),
      );
      return;
    case "duplicate-resource-path":
      expectRejected(() =>
        normalizeExtensionManifestDraft({
          ...draft,
          resources: [
            ...draft.resources,
            { path: "TRANSFORM.JSON", mediaType: "application/json" },
          ],
        }),
      );
      return;
    case "executable-asset-path":
      expectRejected(() =>
        normalizeExtensionManifestDraft({
          ...draft,
          resources: [{ path: "program.js", mediaType: "text/plain" }],
          entry: { type: "transform", program: "program.js" },
        }),
      );
      return;
    case "manifest-unknown-field":
      expectRejected(() =>
        normalizeExtensionManifestDraft({ ...draft, eval: "index.js" }),
      );
      return;
    case "oversized-asset":
      expectRejected(() =>
        createExtensionBundle({
          manifest: draft,
          assets: [
            {
              path: "transform.json",
              mediaType: "application/json",
              content: "x".repeat(HARD_BUNDLE_LIMITS.maximumAssetBytes + 1),
            },
          ],
        }),
      );
      return;
    case "permission-escalation": {
      const bundle = exampleBundle();
      expectRejected(() =>
        createInstallationPermissionGrant({
          bundleDigest: bundle.manifest.integrity.bundleDigest,
          extensionId: bundle.manifest.identity.id,
          grantId: "malicious-grant",
          issuer: "conformance",
          requested: bundle.manifest.permissions,
          granted: { payloadRead: ["*"], payloadWrite: ["*"] },
        }),
      );
      return;
    }
    case "prototype-pollution-pointer":
      expectRejected(() =>
        runTransform(
          {
            version: "1.0",
            operations: [
              { op: "set", path: "/__proto__/polluted", value: true },
            ],
          },
          {},
          { permissions: { payloadWrite: ["*"] } },
        ),
      );
      ensureConformance(
        (Object.prototype as Record<string, unknown>).polluted === undefined,
        "Prototype pollution side effect was observed.",
      );
      return;
    case "serialized-secret-material":
      expectRejected(() =>
        createExtensionBundle({
          manifest: draft,
          assets: [
            {
              path: "transform.json",
              mediaType: "application/json",
              content: '{"secretValue":"plaintext"}',
            },
          ],
        }),
      );
      return;
    case "signature-revocation": {
      const key = generateKeyPairSync("ed25519");
      const signed = signExtensionBundle(exampleBundle(), {
        keyId: "revoked-key",
        privateKey: key.privateKey,
      });
      const result = verifyExtensionBundle(signed, {
        trustPolicy: {
          keys: [
            {
              keyId: "revoked-key",
              publicKey: key.publicKey,
              status: "revoked",
            },
          ],
        },
      });
      ensureConformance(!result.ok, "Revoked signature was accepted.");
      ensureConformance(
        result.signatureErrors.some((error) => error.code === "KEY_REVOKED"),
        "Revocation did not produce the expected verification code.",
      );
      return;
    }
    case "signature-tamper": {
      const key = generateKeyPairSync("ed25519");
      const signed = signExtensionBundle(exampleBundle(), {
        keyId: "publisher-key",
        privateKey: key.privateKey,
      });
      const signature = signed.manifest.integrity.signatures[0];
      ensureConformance(signature !== undefined, "Fixture was not signed.");
      const tampered = {
        ...signed,
        manifest: {
          ...signed.manifest,
          integrity: {
            ...signed.manifest.integrity,
            signatures: [
              {
                ...signature,
                signature: `${
                  signature.signature.startsWith("A") ? "B" : "A"
                }${signature.signature.slice(1)}`,
              },
            ],
          },
        },
      };
      const result = verifyExtensionBundle(tampered, {
        trustPolicy: {
          keys: [
            {
              keyId: "publisher-key",
              publicKey: key.publicKey,
              status: "active",
            },
          ],
        },
      });
      ensureConformance(!result.ok, "Tampered signature was accepted.");
      return;
    }
  }
}

export function runMaliciousCorpus(): readonly MaliciousCorpusResult[] {
  return Object.freeze(
    MALICIOUS_EXTENSION_CORPUS.map((descriptor) => {
      try {
        runMaliciousCorpusCase(descriptor.id);
        return Object.freeze({ ...descriptor, passed: true });
      } catch (cause) {
        return Object.freeze({
          ...descriptor,
          passed: false,
          message:
            cause instanceof Error
              ? cause.message
              : "Malicious corpus case failed.",
        });
      }
    }),
  );
}
