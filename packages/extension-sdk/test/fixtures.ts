// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonAsset,
  createExtensionBundle,
  normalizeExtensionManifestDraft,
  normalizePermissionSet,
  type BundleAssetInput,
  type ExtensionBundle,
  type ExtensionConflict,
  type ExtensionDependency,
  type ExtensionKind,
  type ExtensionManifestDraft,
  type PermissionSetInput,
} from "../src/index.js";

export const transformProgram = Object.freeze({
  version: "1.0",
  operations: Object.freeze([
    Object.freeze({
      op: "rename",
      from: "/customer/email",
      to: "/customer/contact",
    }),
    Object.freeze({
      op: "set",
      path: "/schemaVersion",
      value: "1.0",
    }),
  ]),
});

export const policyProgram = Object.freeze({
  version: "1.0",
  rules: Object.freeze([
    Object.freeze({
      op: "require",
      target: "metadata",
      path: "/eventType",
    }),
    Object.freeze({
      op: "redact",
      target: "payload",
      path: "/customer/email",
    }),
  ]),
});

interface FixtureOptions {
  readonly conflicts?: readonly ExtensionConflict[];
  readonly dependencies?: readonly ExtensionDependency[];
  readonly id?: string;
  readonly kind?: ExtensionKind;
  readonly permissions?: PermissionSetInput;
  readonly version?: string;
}

function kindAssets(kind: ExtensionKind): {
  readonly assets: readonly BundleAssetInput[];
  readonly entry: ExtensionManifestDraft["entry"];
} {
  switch (kind) {
    case "connector":
      return {
        assets: [
          {
            path: "configuration.schema.json",
            mediaType: "application/schema+json",
            content: canonicalJsonAsset({
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              additionalProperties: false,
              properties: {
                endpoint: { type: "string", format: "uri" },
                secretReference: { type: "string" },
              },
              required: ["endpoint", "secretReference"],
            }),
          },
          {
            path: "request.template",
            mediaType: "text/x-webhook-template",
            content: "Configured request for {{endpoint}}",
          },
        ],
        entry: {
          type: "connector",
          configurationSchema: "configuration.schema.json",
          templates: ["request.template"],
        },
      };
    case "policy":
      return {
        assets: [
          {
            path: "policy.json",
            mediaType: "application/json",
            content: canonicalJsonAsset(
              policyProgram as unknown as import("../src/index.js").JsonValue,
            ),
          },
        ],
        entry: { type: "policy", program: "policy.json" },
      };
    case "template":
      return {
        assets: [
          {
            path: "delivery.txt",
            mediaType: "text/plain",
            content: "Delivery {{deliveryId}}",
          },
        ],
        entry: {
          type: "template",
          templates: [
            {
              name: "delivery",
              path: "delivery.txt",
              mediaType: "text/plain",
            },
          ],
        },
      };
    case "transform":
      return {
        assets: [
          {
            path: "transform.json",
            mediaType: "application/json",
            content: canonicalJsonAsset(
              transformProgram as unknown as import("../src/index.js").JsonValue,
            ),
          },
        ],
        entry: { type: "transform", program: "transform.json" },
      };
  }
}

function capabilities(kind: ExtensionKind) {
  switch (kind) {
    case "connector":
      return ["connector.configuration", "connector.templates"] as const;
    case "policy":
      return ["policy.declarative"] as const;
    case "template":
      return ["template.assets"] as const;
    case "transform":
      return ["transform.declarative"] as const;
  }
}

function defaultPermissions(kind: ExtensionKind): PermissionSetInput {
  switch (kind) {
    case "connector":
      return {
        outboundHosts: ["api.example.com"],
        secretReferences: ["connector-api-key"],
      };
    case "policy":
      return {
        metadataRead: ["/eventType"],
        payloadRead: ["/customer/email"],
        payloadWrite: ["/customer/email"],
      };
    case "template":
      return {};
    case "transform":
      return {
        payloadRead: ["/customer/email"],
        payloadWrite: [
          "/customer/email",
          "/customer/contact",
          "/schemaVersion",
        ],
      };
  }
}

export function makeManifestDraft(
  options: FixtureOptions = {},
): ExtensionManifestDraft {
  const kind = options.kind ?? "transform";
  const id = options.id ?? `example.${kind}`;
  const { assets, entry } = kindAssets(kind);
  return normalizeExtensionManifestDraft({
    manifestVersion: "1.0",
    kind,
    identity: {
      id,
      name: `Example ${kind}`,
      version: options.version ?? "1.0.0",
      publisher: {
        id: "example.publisher",
        name: "Example Publisher",
        url: "https://example.com/",
      },
    },
    compatibility: {
      platform: "^1.0.0",
      sdk: "^0.1.0",
      dependencies: options.dependencies ?? [],
      conflicts: options.conflicts ?? [],
    },
    capabilities: capabilities(kind),
    permissions: normalizePermissionSet(
      options.permissions ?? defaultPermissions(kind),
    ),
    resources: assets.map(({ path, mediaType }) => ({ path, mediaType })),
    entry,
    provenance: {
      source: {
        repository: "https://example.com/extensions.git",
        revision: `${id.replaceAll(".", "-")}-${options.version ?? "1-0-0"}`,
      },
      build: {
        builder: "fixture-builder",
        buildType: "declarative-json",
        timestamp: "2026-07-18T00:00:00.000Z",
        reproducible: true,
      },
      sbom: {
        format: "webhook-portal-sbom-v1",
        dependencies: [],
      },
    },
  });
}

export function makeBundle(options: FixtureOptions = {}): ExtensionBundle {
  const kind = options.kind ?? "transform";
  return createExtensionBundle({
    manifest: makeManifestDraft(options),
    assets: kindAssets(kind).assets,
  });
}
