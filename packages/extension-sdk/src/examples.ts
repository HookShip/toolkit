// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonAsset } from "./bundle.js";
import {
  normalizeExtensionManifestDraft,
  type ExtensionManifestDraft,
} from "./manifest.js";
import { normalizePermissionSet } from "./permissions.js";
import { POLICY_DSL_VERSION, type PolicyProgram } from "./policy.js";
import { TRANSFORM_DSL_VERSION, type TransformProgram } from "./transform.js";

export const EXAMPLE_TRANSFORM_PROGRAM: TransformProgram = Object.freeze({
  version: TRANSFORM_DSL_VERSION,
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

export const EXAMPLE_POLICY_PROGRAM: PolicyProgram = Object.freeze({
  version: POLICY_DSL_VERSION,
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
      replacement: "[REDACTED]",
    }),
  ]),
});

export const EXAMPLE_TRANSFORM_ASSET = canonicalJsonAsset(
  EXAMPLE_TRANSFORM_PROGRAM as unknown as import("./canonical.js").JsonValue,
);

export function createExampleTransformManifest(
  overrides: {
    readonly id?: string;
    readonly version?: string;
  } = {},
): ExtensionManifestDraft {
  return normalizeExtensionManifestDraft({
    manifestVersion: "1.0",
    kind: "transform",
    identity: {
      id: overrides.id ?? "example.transform",
      name: "Example declarative transform",
      version: overrides.version ?? "0.1.0",
      publisher: {
        id: "example.publisher",
        name: "Example Publisher",
        url: "https://example.com/",
      },
    },
    compatibility: {
      platform: "^0.1.0",
      sdk: "^0.1.0",
      dependencies: [],
      conflicts: [],
    },
    capabilities: ["transform.declarative"],
    permissions: normalizePermissionSet({
      payloadRead: ["/customer/email"],
      payloadWrite: ["/customer/email", "/customer/contact", "/schemaVersion"],
    }),
    resources: [
      {
        path: "transform.json",
        mediaType: "application/json",
      },
    ],
    entry: {
      type: "transform",
      program: "transform.json",
    },
    provenance: {
      source: {
        repository: "https://example.com/extensions.git",
        revision: "example-revision",
      },
      build: {
        builder: "example-builder",
        buildType: "declarative-json",
        timestamp: "2026-01-01T00:00:00.000Z",
        reproducible: true,
      },
      sbom: {
        format: "webhook-portal-sbom-v1",
        dependencies: [],
      },
    },
  });
}
