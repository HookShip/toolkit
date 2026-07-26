// SPDX-License-Identifier: Apache-2.0

import {
  compareUtf16CodeUnits,
  isSha256Digest,
  type JsonValue,
} from "./canonical.js";
import { ExtensionValidationError } from "./errors.js";
import { normalizePermissionSet } from "./permissions.js";
import { parseSemVer, parseSemVerRange } from "./semver.js";
import { parseBundleSignature } from "./signatures.js";
import {
  expectBoolean,
  expectEnum,
  expectIdentifier,
  expectInteger,
  expectIsoTimestamp,
  expectString,
  inspectArray,
  inspectClosedObject,
} from "./validation.js";
import {
  EXTENSION_ASSET_MEDIA_TYPES,
  EXTENSION_CAPABILITIES,
  EXTENSION_KINDS,
  EXTENSION_MANIFEST_VERSION,
  type ExtensionCapability,
  type ExtensionCompatibility,
  type ExtensionConflict,
  type ExtensionDependency,
  type ExtensionEntry,
  type ExtensionIdentity,
  type ExtensionKind,
  type ExtensionManifest,
  type ExtensionManifestDraft,
  type ExtensionProvenance,
  type ExtensionPublisher,
  type ExtensionResource,
  type ResourceDeclaration,
  type SbomDependency,
  type TemplateDeclaration,
} from "./manifest-types.js";
import {
  assertSafeText,
  normalizeAssetPath,
  parseHttpsUrl,
} from "./manifest-utils.js";

const CAPABILITIES_BY_KIND: Readonly<
  Record<ExtensionKind, readonly ExtensionCapability[]>
> = Object.freeze({
  connector: Object.freeze([
    "connector.configuration",
    "connector.templates",
  ] as const),
  policy: Object.freeze(["policy.declarative"] as const),
  template: Object.freeze(["template.assets"] as const),
  transform: Object.freeze(["transform.declarative"] as const),
});
function parsePublisher(value: unknown): ExtensionPublisher {
  const object = inspectClosedObject(
    value,
    "manifest.identity.publisher",
    ["id", "name"],
    ["url"],
  );
  return Object.freeze({
    id: expectIdentifier(object.id, "manifest.identity.publisher.id", 256),
    name: assertSafeText(
      expectString(object.name, "manifest.identity.publisher.name", {
        maximumLength: 256,
      }),
      "manifest.identity.publisher.name",
    ),
    ...(object.url === undefined
      ? {}
      : { url: parseHttpsUrl(object.url, "manifest.identity.publisher.url") }),
  });
}

function parseIdentity(value: unknown): ExtensionIdentity {
  const object = inspectClosedObject(value, "manifest.identity", [
    "id",
    "name",
    "publisher",
    "version",
  ]);
  const version = expectString(object.version, "manifest.identity.version", {
    maximumLength: 128,
  });
  parseSemVer(version);
  return Object.freeze({
    id: expectIdentifier(object.id, "manifest.identity.id", 256),
    name: assertSafeText(
      expectString(object.name, "manifest.identity.name", {
        maximumLength: 256,
      }),
      "manifest.identity.name",
    ),
    publisher: parsePublisher(object.publisher),
    version,
  });
}

function parseCompatibility(value: unknown): ExtensionCompatibility {
  const object = inspectClosedObject(value, "manifest.compatibility", [
    "platform",
    "sdk",
    "dependencies",
    "conflicts",
  ]);
  const platform = expectString(
    object.platform,
    "manifest.compatibility.platform",
    { maximumLength: 512 },
  );
  const sdk = expectString(object.sdk, "manifest.compatibility.sdk", {
    maximumLength: 512,
  });
  parseSemVerRange(platform);
  parseSemVerRange(sdk);
  const dependencies = inspectArray(
    object.dependencies,
    "manifest.compatibility.dependencies",
    128,
  ).map((candidate, index): ExtensionDependency => {
    const path = `manifest.compatibility.dependencies[${index}]`;
    const dependency = inspectClosedObject(candidate, path, [
      "id",
      "range",
      "optional",
    ]);
    const range = expectString(dependency.range, `${path}.range`, {
      maximumLength: 512,
    });
    parseSemVerRange(range);
    return Object.freeze({
      id: expectIdentifier(dependency.id, `${path}.id`, 256),
      optional: expectBoolean(dependency.optional, `${path}.optional`),
      range,
    });
  });
  const conflicts = inspectArray(
    object.conflicts,
    "manifest.compatibility.conflicts",
    128,
  ).map((candidate, index): ExtensionConflict => {
    const path = `manifest.compatibility.conflicts[${index}]`;
    const conflict = inspectClosedObject(candidate, path, [
      "id",
      "range",
      "reason",
    ]);
    const range = expectString(conflict.range, `${path}.range`, {
      maximumLength: 512,
    });
    parseSemVerRange(range);
    return Object.freeze({
      id: expectIdentifier(conflict.id, `${path}.id`, 256),
      range,
      reason: assertSafeText(
        expectString(conflict.reason, `${path}.reason`, {
          maximumLength: 1_024,
        }),
        `${path}.reason`,
      ),
    });
  });
  for (const [label, values] of [
    ["dependency", dependencies],
    ["conflict", conflicts],
  ] as const) {
    const seen = new Set<string>();
    for (const item of values) {
      if (seen.has(item.id)) {
        throw new ExtensionValidationError(
          "DUPLICATE_COMPATIBILITY_ENTRY",
          `Manifest contains duplicate ${label} ${item.id}.`,
          "manifest.compatibility",
        );
      }
      seen.add(item.id);
    }
  }
  return Object.freeze({
    conflicts: Object.freeze(
      [...conflicts].sort((left, right) =>
        compareUtf16CodeUnits(left.id, right.id),
      ),
    ),
    dependencies: Object.freeze(
      [...dependencies].sort((left, right) =>
        compareUtf16CodeUnits(left.id, right.id),
      ),
    ),
    platform,
    sdk,
  });
}

function parseCapabilities(
  value: unknown,
  kind: ExtensionKind,
): readonly ExtensionCapability[] {
  const capabilities = inspectArray(value, "manifest.capabilities", 16).map(
    (candidate, index) =>
      expectEnum(
        candidate,
        `manifest.capabilities[${index}]`,
        EXTENSION_CAPABILITIES,
      ),
  );
  const unique = [...new Set(capabilities)].sort(compareUtf16CodeUnits);
  const allowed = CAPABILITIES_BY_KIND[kind];
  if (
    unique.some((capability) => !allowed.includes(capability)) ||
    (kind !== "connector" && unique.length !== 1) ||
    (kind === "connector" && !unique.includes("connector.configuration"))
  ) {
    throw new ExtensionValidationError(
      "CAPABILITY_KIND_MISMATCH",
      `Capabilities do not match extension kind ${kind}.`,
      "manifest.capabilities",
    );
  }
  return Object.freeze(unique);
}

function parseTemplateDeclaration(
  value: unknown,
  path: string,
): TemplateDeclaration {
  const object = inspectClosedObject(value, path, [
    "name",
    "path",
    "mediaType",
  ]);
  return Object.freeze({
    name: expectIdentifier(object.name, `${path}.name`, 128),
    path: normalizeAssetPath(object.path, `${path}.path`),
    mediaType: expectEnum(object.mediaType, `${path}.mediaType`, [
      "text/markdown",
      "text/plain",
      "text/x-webhook-template",
    ] as const),
  });
}

function parseEntry(value: unknown, kind: ExtensionKind): ExtensionEntry {
  const path = "manifest.entry";
  switch (kind) {
    case "connector": {
      const object = inspectClosedObject(value, path, [
        "type",
        "configurationSchema",
        "templates",
      ]);
      if (
        expectEnum(object.type, `${path}.type`, ["connector"] as const) !== kind
      ) {
        throw new ExtensionValidationError(
          "ENTRY_KIND_MISMATCH",
          "Entry type does not match extension kind.",
          `${path}.type`,
        );
      }
      return Object.freeze({
        type: "connector",
        configurationSchema: normalizeAssetPath(
          object.configurationSchema,
          `${path}.configurationSchema`,
        ),
        templates: Object.freeze(
          inspectArray(object.templates, `${path}.templates`, 128)
            .map((candidate, index) =>
              normalizeAssetPath(candidate, `${path}.templates[${index}]`),
            )
            .sort(compareUtf16CodeUnits),
        ),
      });
    }
    case "policy": {
      const object = inspectClosedObject(value, path, ["type", "program"]);
      expectEnum(object.type, `${path}.type`, ["policy"] as const);
      return Object.freeze({
        type: "policy",
        program: normalizeAssetPath(object.program, `${path}.program`),
      });
    }
    case "template": {
      const object = inspectClosedObject(value, path, ["type", "templates"]);
      expectEnum(object.type, `${path}.type`, ["template"] as const);
      const templates = inspectArray(
        object.templates,
        `${path}.templates`,
        128,
      ).map((candidate, index) =>
        parseTemplateDeclaration(candidate, `${path}.templates[${index}]`),
      );
      if (templates.length === 0) {
        throw new ExtensionValidationError(
          "EMPTY_TEMPLATE_PACK",
          "Template extension must declare at least one template.",
          `${path}.templates`,
        );
      }
      const names = new Set<string>();
      for (const template of templates) {
        if (names.has(template.name)) {
          throw new ExtensionValidationError(
            "DUPLICATE_TEMPLATE",
            `Duplicate template name ${template.name}.`,
            `${path}.templates`,
          );
        }
        names.add(template.name);
      }
      return Object.freeze({
        type: "template",
        templates: Object.freeze(
          [...templates].sort((left, right) =>
            compareUtf16CodeUnits(left.name, right.name),
          ),
        ),
      });
    }
    case "transform": {
      const object = inspectClosedObject(value, path, ["type", "program"]);
      expectEnum(object.type, `${path}.type`, ["transform"] as const);
      return Object.freeze({
        type: "transform",
        program: normalizeAssetPath(object.program, `${path}.program`),
      });
    }
  }
}

function parseSbomDependency(value: unknown, path: string): SbomDependency {
  const object = inspectClosedObject(
    value,
    path,
    ["name", "version", "relationship", "direct"],
    ["digest", "license", "purl"],
  );
  const version = expectString(object.version, `${path}.version`, {
    maximumLength: 128,
  });
  parseSemVer(version);
  const digest =
    object.digest === undefined
      ? undefined
      : expectString(object.digest, `${path}.digest`, { maximumLength: 71 });
  if (digest !== undefined && !isSha256Digest(digest)) {
    throw new ExtensionValidationError(
      "INVALID_DIGEST",
      `${path}.digest must be a SHA-256 digest.`,
      `${path}.digest`,
    );
  }
  return Object.freeze({
    name: expectIdentifier(object.name, `${path}.name`, 256),
    version,
    relationship: expectEnum(object.relationship, `${path}.relationship`, [
      "build",
      "optional",
      "runtime",
    ] as const),
    direct: expectBoolean(object.direct, `${path}.direct`),
    ...(digest === undefined ? {} : { digest }),
    ...(object.license === undefined
      ? {}
      : {
          license: expectIdentifier(object.license, `${path}.license`, 128),
        }),
    ...(object.purl === undefined
      ? {}
      : {
          purl: assertSafeText(
            expectString(object.purl, `${path}.purl`, {
              maximumLength: 1_024,
            }),
            `${path}.purl`,
          ),
        }),
  });
}

function parseProvenance(value: unknown): ExtensionProvenance {
  const object = inspectClosedObject(value, "manifest.provenance", [
    "source",
    "build",
    "sbom",
  ]);
  const source = inspectClosedObject(
    object.source,
    "manifest.provenance.source",
    ["repository", "revision"],
  );
  const build = inspectClosedObject(object.build, "manifest.provenance.build", [
    "builder",
    "buildType",
    "timestamp",
    "reproducible",
  ]);
  const sbom = inspectClosedObject(object.sbom, "manifest.provenance.sbom", [
    "format",
    "dependencies",
  ]);
  const dependencies = inspectArray(
    sbom.dependencies,
    "manifest.provenance.sbom.dependencies",
    512,
  ).map((candidate, index) =>
    parseSbomDependency(
      candidate,
      `manifest.provenance.sbom.dependencies[${index}]`,
    ),
  );
  return Object.freeze({
    source: Object.freeze({
      repository: parseHttpsUrl(
        source.repository,
        "manifest.provenance.source.repository",
      ),
      revision: expectIdentifier(
        source.revision,
        "manifest.provenance.source.revision",
        256,
      ),
    }),
    build: Object.freeze({
      builder: expectIdentifier(
        build.builder,
        "manifest.provenance.build.builder",
        256,
      ),
      buildType: expectIdentifier(
        build.buildType,
        "manifest.provenance.build.buildType",
        256,
      ),
      timestamp: expectIsoTimestamp(
        build.timestamp,
        "manifest.provenance.build.timestamp",
      ),
      reproducible: expectBoolean(
        build.reproducible,
        "manifest.provenance.build.reproducible",
      ),
    }),
    sbom: Object.freeze({
      format: expectEnum(sbom.format, "manifest.provenance.sbom.format", [
        "webhook-portal-sbom-v1",
      ] as const),
      dependencies: Object.freeze(
        [...dependencies].sort((left, right) => {
          const name = compareUtf16CodeUnits(left.name, right.name);
          return name === 0
            ? compareUtf16CodeUnits(left.version, right.version)
            : name;
        }),
      ),
    }),
  });
}

function parseResources(
  value: unknown,
  complete: boolean,
): readonly (ExtensionResource | ResourceDeclaration)[] {
  const resources = inspectArray(value, "manifest.resources", 256).map(
    (candidate, index): ExtensionResource | ResourceDeclaration => {
      const path = `manifest.resources[${index}]`;
      const object = inspectClosedObject(
        candidate,
        path,
        complete
          ? ["path", "mediaType", "digest", "size"]
          : ["path", "mediaType"],
      );
      const base = {
        path: normalizeAssetPath(object.path, `${path}.path`),
        mediaType: expectEnum(
          object.mediaType,
          `${path}.mediaType`,
          EXTENSION_ASSET_MEDIA_TYPES,
        ),
      };
      if (!complete) {
        return Object.freeze(base);
      }
      const digest = expectString(object.digest, `${path}.digest`, {
        maximumLength: 71,
      });
      if (!isSha256Digest(digest)) {
        throw new ExtensionValidationError(
          "INVALID_DIGEST",
          `${path}.digest must be a SHA-256 digest.`,
          `${path}.digest`,
        );
      }
      return Object.freeze({
        ...base,
        digest,
        size: expectInteger(object.size, `${path}.size`, 0, 1024 * 1024),
      });
    },
  );
  const aliases = new Set<string>();
  for (const resource of resources) {
    const alias = resource.path.toLowerCase();
    if (aliases.has(alias)) {
      throw new ExtensionValidationError(
        "DUPLICATE_RESOURCE_PATH",
        `Duplicate or case-colliding resource path ${resource.path}.`,
        "manifest.resources",
      );
    }
    aliases.add(alias);
  }
  return Object.freeze(
    [...resources].sort((left, right) =>
      compareUtf16CodeUnits(left.path, right.path),
    ),
  );
}

function referencedPaths(entry: ExtensionEntry): readonly string[] {
  switch (entry.type) {
    case "connector":
      return [entry.configurationSchema, ...entry.templates];
    case "policy":
    case "transform":
      return [entry.program];
    case "template":
      return entry.templates.map((template) => template.path);
  }
}

function validateEntryResources(
  entry: ExtensionEntry,
  resources: readonly (ExtensionResource | ResourceDeclaration)[],
  capabilities: readonly ExtensionCapability[],
): void {
  const resourcePaths = new Set(resources.map((resource) => resource.path));
  for (const path of referencedPaths(entry)) {
    if (!resourcePaths.has(path)) {
      throw new ExtensionValidationError(
        "UNLISTED_ENTRY_RESOURCE",
        `Entry references unlisted resource ${path}.`,
        "manifest.entry",
      );
    }
  }
  const resourceByPath = new Map(
    resources.map((resource) => [resource.path, resource]),
  );
  switch (entry.type) {
    case "connector": {
      if (
        resourceByPath.get(entry.configurationSchema)?.mediaType !==
        "application/schema+json"
      ) {
        throw new ExtensionValidationError(
          "ENTRY_MEDIA_TYPE_MISMATCH",
          "Connector configuration schema must use application/schema+json.",
          "manifest.entry.configurationSchema",
        );
      }
      if (
        entry.templates.some((templatePath) => {
          const mediaType = resourceByPath.get(templatePath)?.mediaType;
          return (
            mediaType !== "text/markdown" &&
            mediaType !== "text/plain" &&
            mediaType !== "text/x-webhook-template"
          );
        })
      ) {
        throw new ExtensionValidationError(
          "ENTRY_MEDIA_TYPE_MISMATCH",
          "Connector templates must use a supported text media type.",
          "manifest.entry.templates",
        );
      }
      const declaresTemplates = entry.templates.length > 0;
      if (capabilities.includes("connector.templates") !== declaresTemplates) {
        throw new ExtensionValidationError(
          "CAPABILITY_ENTRY_MISMATCH",
          "connector.templates capability must exactly match template declarations.",
          "manifest.capabilities",
        );
      }
      break;
    }
    case "policy":
    case "transform":
      if (resourceByPath.get(entry.program)?.mediaType !== "application/json") {
        throw new ExtensionValidationError(
          "ENTRY_MEDIA_TYPE_MISMATCH",
          "Declarative programs must use application/json.",
          "manifest.entry.program",
        );
      }
      break;
    case "template":
      for (const template of entry.templates) {
        if (
          resourceByPath.get(template.path)?.mediaType !== template.mediaType
        ) {
          throw new ExtensionValidationError(
            "ENTRY_MEDIA_TYPE_MISMATCH",
            `Template ${template.name} media type does not match its resource.`,
            "manifest.entry.templates",
          );
        }
      }
      break;
  }
}

function parseManifestIntegrity(
  object: Readonly<Record<string, unknown>>,
  base: Omit<ExtensionManifestDraft, "resources"> & {
    readonly resources: readonly (ExtensionResource | ResourceDeclaration)[];
  },
  resources: readonly (ExtensionResource | ResourceDeclaration)[],
): ExtensionManifest {
  const integrityObject = inspectClosedObject(
    object.integrity,
    "manifest.integrity",
    ["contentDigest", "bundleDigest", "signatures"],
  );
  const contentDigest = expectString(
    integrityObject.contentDigest,
    "manifest.integrity.contentDigest",
    { maximumLength: 71 },
  );
  const bundleDigest = expectString(
    integrityObject.bundleDigest,
    "manifest.integrity.bundleDigest",
    { maximumLength: 71 },
  );
  if (!isSha256Digest(contentDigest) || !isSha256Digest(bundleDigest)) {
    throw new ExtensionValidationError(
      "INVALID_DIGEST",
      "Manifest integrity digests must use SHA-256.",
      "manifest.integrity",
    );
  }
  const signatures = inspectArray(
    integrityObject.signatures,
    "manifest.integrity.signatures",
    64,
  ).map((signature, index) =>
    parseBundleSignature(signature, `manifest.integrity.signatures[${index}]`),
  );
  const keyIds = new Set<string>();
  for (const signature of signatures) {
    if (keyIds.has(signature.keyId)) {
      throw new ExtensionValidationError(
        "DUPLICATE_SIGNATURE",
        `Manifest contains duplicate signature key ${signature.keyId}.`,
        "manifest.integrity.signatures",
      );
    }
    keyIds.add(signature.keyId);
  }
  return Object.freeze({
    ...base,
    resources: resources as readonly ExtensionResource[],
    integrity: Object.freeze({
      contentDigest,
      bundleDigest,
      signatures: Object.freeze(
        [...signatures].sort((left, right) =>
          compareUtf16CodeUnits(left.keyId, right.keyId),
        ),
      ),
    }),
  }) as ExtensionManifest;
}

function parseManifestBase(
  value: unknown,
  complete: boolean,
): ExtensionManifest | ExtensionManifestDraft {
  const required = [
    "manifestVersion",
    "kind",
    "identity",
    "compatibility",
    "capabilities",
    "permissions",
    "resources",
    "entry",
    "provenance",
  ];
  if (complete) {
    required.push("integrity");
  }
  const object = inspectClosedObject(value, "manifest", required);
  const manifestVersion = expectEnum(
    object.manifestVersion,
    "manifest.manifestVersion",
    [EXTENSION_MANIFEST_VERSION] as const,
  );
  const kind = expectEnum(object.kind, "manifest.kind", EXTENSION_KINDS);
  const identity = parseIdentity(object.identity);
  const compatibility = parseCompatibility(object.compatibility);
  if (
    compatibility.dependencies.some(
      (dependency) => dependency.id === identity.id,
    ) ||
    compatibility.conflicts.some((conflict) => conflict.id === identity.id)
  ) {
    throw new ExtensionValidationError(
      "SELF_REFERENCE",
      "Extension must not depend on or conflict with itself.",
      "manifest.compatibility",
    );
  }
  const capabilities = parseCapabilities(object.capabilities, kind);
  const permissions = normalizePermissionSet(object.permissions);
  const resources = parseResources(object.resources, complete);
  const entry = parseEntry(object.entry, kind);
  const provenance = parseProvenance(object.provenance);
  validateEntryResources(entry, resources, capabilities);
  const base = {
    manifestVersion,
    kind,
    identity,
    compatibility,
    capabilities,
    permissions,
    resources,
    entry,
    provenance,
  };
  if (!complete) {
    return Object.freeze(base) as ExtensionManifestDraft;
  }
  return parseManifestIntegrity(object, base, resources);
}

export function parseExtensionManifest(value: unknown): ExtensionManifest {
  return parseManifestBase(value, true) as ExtensionManifest;
}

export function normalizeExtensionManifestDraft(
  value: unknown,
): ExtensionManifestDraft {
  return parseManifestBase(value, false) as ExtensionManifestDraft;
}

export function manifestContentValue(
  manifest: ExtensionManifest | ExtensionManifestDraft,
): JsonValue {
  const {
    capabilities,
    compatibility,
    entry,
    identity,
    kind,
    manifestVersion,
    permissions,
    provenance,
    resources,
  } = manifest;
  return {
    manifestVersion,
    kind,
    identity,
    compatibility,
    capabilities,
    permissions,
    resources,
    entry,
    provenance,
  } as unknown as JsonValue;
}
