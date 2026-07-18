// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonDigest,
  compareUtf16CodeUnits,
  equalDigest,
  isSha256Digest,
  type JsonValue,
} from "./canonical.js";
import { ExtensionValidationError } from "./errors.js";
import {
  normalizePermissionSet,
  type InstallationPermissionGrant,
  type PermissionSet,
} from "./permissions.js";
import {
  type ExtensionResolution,
  type ResolutionDecisionKind,
} from "./resolver.js";
import { parseSemVer, parseSemVerRange, satisfiesSemVer } from "./semver.js";
import {
  expectBoolean,
  expectEnum,
  expectIdentifier,
  expectIsoTimestamp,
  expectString,
  inspectArray,
  inspectClosedObject,
} from "./validation.js";

export const INSTALLATION_LOCK_VERSION = "1.0" as const;

export interface LockedDependency {
  readonly id: string;
  readonly optional: boolean;
  readonly range: string;
  readonly version: string;
}

export interface LockedPermissionGrant {
  readonly grantId: string;
  readonly issuer: string;
  readonly permissions: PermissionSet;
}

export interface LockedExtension {
  readonly bundleDigest: string;
  readonly contentDigest: string;
  readonly dependencies: readonly LockedDependency[];
  readonly id: string;
  readonly permissionGrant: LockedPermissionGrant;
  readonly provenanceDigest: string;
  readonly version: string;
}

export interface LockedDecision {
  readonly fromVersion?: string;
  readonly id: string;
  readonly kind: ResolutionDecisionKind;
  readonly pinned: boolean;
  readonly toVersion?: string;
}

export interface InstallationLock {
  readonly checksum: string;
  readonly createdAt: string;
  readonly decisions: readonly LockedDecision[];
  readonly extensions: readonly LockedExtension[];
  readonly lockVersion: typeof INSTALLATION_LOCK_VERSION;
  readonly platformVersion: string;
  readonly sdkVersion: string;
}

export interface InstallationLockVerification {
  readonly issues: readonly string[];
  readonly lock?: InstallationLock;
  readonly ok: boolean;
}

function parseDigest(value: unknown, path: string): string {
  const digest = expectString(value, path, { maximumLength: 71 });
  if (!isSha256Digest(digest)) {
    throw new ExtensionValidationError(
      "INVALID_DIGEST",
      `${path} must be a SHA-256 digest.`,
      path,
    );
  }
  return digest;
}

function parseLockedDependency(value: unknown, path: string): LockedDependency {
  const object = inspectClosedObject(value, path, [
    "id",
    "version",
    "range",
    "optional",
  ]);
  const version = expectString(object.version, `${path}.version`, {
    maximumLength: 128,
  });
  parseSemVer(version);
  const range = expectString(object.range, `${path}.range`, {
    maximumLength: 512,
  });
  parseSemVerRange(range);
  return Object.freeze({
    id: expectIdentifier(object.id, `${path}.id`, 256),
    version,
    range,
    optional: expectBoolean(object.optional, `${path}.optional`),
  });
}

function parseLockedExtension(value: unknown, path: string): LockedExtension {
  const object = inspectClosedObject(value, path, [
    "id",
    "version",
    "bundleDigest",
    "contentDigest",
    "provenanceDigest",
    "dependencies",
    "permissionGrant",
  ]);
  const version = expectString(object.version, `${path}.version`, {
    maximumLength: 128,
  });
  parseSemVer(version);
  const grant = inspectClosedObject(
    object.permissionGrant,
    `${path}.permissionGrant`,
    ["grantId", "issuer", "permissions"],
  );
  const dependencies = inspectArray(
    object.dependencies,
    `${path}.dependencies`,
    256,
  ).map((candidate, index) =>
    parseLockedDependency(candidate, `${path}.dependencies[${index}]`),
  );
  const dependencyIds = new Set<string>();
  for (const dependency of dependencies) {
    if (dependencyIds.has(dependency.id)) {
      throw new ExtensionValidationError(
        "DUPLICATE_LOCK_DEPENDENCY",
        `${path} contains duplicate dependency ${dependency.id}.`,
        `${path}.dependencies`,
      );
    }
    dependencyIds.add(dependency.id);
  }
  return Object.freeze({
    id: expectIdentifier(object.id, `${path}.id`, 256),
    version,
    bundleDigest: parseDigest(object.bundleDigest, `${path}.bundleDigest`),
    contentDigest: parseDigest(object.contentDigest, `${path}.contentDigest`),
    provenanceDigest: parseDigest(
      object.provenanceDigest,
      `${path}.provenanceDigest`,
    ),
    dependencies: Object.freeze(
      [...dependencies].sort((left, right) =>
        compareUtf16CodeUnits(left.id, right.id),
      ),
    ),
    permissionGrant: Object.freeze({
      grantId: expectIdentifier(
        grant.grantId,
        `${path}.permissionGrant.grantId`,
        256,
      ),
      issuer: expectIdentifier(
        grant.issuer,
        `${path}.permissionGrant.issuer`,
        256,
      ),
      permissions: normalizePermissionSet(grant.permissions),
    }),
  });
}

function parseLockedDecision(value: unknown, path: string): LockedDecision {
  const object = inspectClosedObject(
    value,
    path,
    ["id", "kind", "pinned"],
    ["fromVersion", "toVersion"],
  );
  const fromVersion =
    object.fromVersion === undefined
      ? undefined
      : expectString(object.fromVersion, `${path}.fromVersion`, {
          maximumLength: 128,
        });
  const toVersion =
    object.toVersion === undefined
      ? undefined
      : expectString(object.toVersion, `${path}.toVersion`, {
          maximumLength: 128,
        });
  if (fromVersion !== undefined) {
    parseSemVer(fromVersion);
  }
  if (toVersion !== undefined) {
    parseSemVer(toVersion);
  }
  return Object.freeze({
    id: expectIdentifier(object.id, `${path}.id`, 256),
    kind: expectEnum(object.kind, `${path}.kind`, [
      "install",
      "keep",
      "remove",
      "replace",
      "rollback",
      "upgrade",
    ] as const),
    pinned: expectBoolean(object.pinned, `${path}.pinned`),
    ...(fromVersion === undefined ? {} : { fromVersion }),
    ...(toVersion === undefined ? {} : { toVersion }),
  });
}

function lockChecksumValue(
  lock: Omit<InstallationLock, "checksum"> | InstallationLock,
): JsonValue {
  const {
    createdAt,
    decisions,
    extensions,
    lockVersion,
    platformVersion,
    sdkVersion,
  } = lock;
  return {
    lockVersion,
    createdAt,
    platformVersion,
    sdkVersion,
    extensions,
    decisions,
  } as unknown as JsonValue;
}

export function computeInstallationLockChecksum(
  lock: Omit<InstallationLock, "checksum"> | InstallationLock,
): string {
  return canonicalJsonDigest(lockChecksumValue(lock), {
    maximumOutputBytes: 4 * 1024 * 1024,
  });
}

export function parseInstallationLock(value: unknown): InstallationLock {
  const object = inspectClosedObject(value, "lock", [
    "lockVersion",
    "createdAt",
    "platformVersion",
    "sdkVersion",
    "extensions",
    "decisions",
    "checksum",
  ]);
  const platformVersion = expectString(
    object.platformVersion,
    "lock.platformVersion",
    { maximumLength: 128 },
  );
  const sdkVersion = expectString(object.sdkVersion, "lock.sdkVersion", {
    maximumLength: 128,
  });
  parseSemVer(platformVersion);
  parseSemVer(sdkVersion);
  const extensions = inspectArray(
    object.extensions,
    "lock.extensions",
    256,
  ).map((candidate, index) =>
    parseLockedExtension(candidate, `lock.extensions[${index}]`),
  );
  const ids = new Set<string>();
  for (const extension of extensions) {
    if (ids.has(extension.id)) {
      throw new ExtensionValidationError(
        "DUPLICATE_LOCK_EXTENSION",
        `Lock contains duplicate extension ${extension.id}.`,
        "lock.extensions",
      );
    }
    ids.add(extension.id);
  }
  const decisions = inspectArray(object.decisions, "lock.decisions", 512).map(
    (candidate, index) =>
      parseLockedDecision(candidate, `lock.decisions[${index}]`),
  );
  return Object.freeze({
    lockVersion: expectEnum(object.lockVersion, "lock.lockVersion", [
      INSTALLATION_LOCK_VERSION,
    ] as const),
    createdAt: expectIsoTimestamp(object.createdAt, "lock.createdAt"),
    platformVersion,
    sdkVersion,
    extensions: Object.freeze(
      [...extensions].sort((left, right) =>
        compareUtf16CodeUnits(left.id, right.id),
      ),
    ),
    decisions: Object.freeze(
      [...decisions].sort((left, right) =>
        compareUtf16CodeUnits(left.id, right.id),
      ),
    ),
    checksum: parseDigest(object.checksum, "lock.checksum"),
  });
}

export function createInstallationLock(input: {
  readonly createdAt: string;
  readonly grants: readonly InstallationPermissionGrant[];
  readonly platformVersion: string;
  readonly resolution: ExtensionResolution;
  readonly sdkVersion: string;
}): InstallationLock {
  const grants = new Map(
    input.grants.map((grant) => [grant.extensionId, grant]),
  );
  if (grants.size !== input.grants.length) {
    throw new ExtensionValidationError(
      "DUPLICATE_PERMISSION_GRANT",
      "Installation grants must have unique extension IDs.",
      "grants",
    );
  }
  const nodeById = new Map(
    input.resolution.nodes.map((node) => [node.id, node]),
  );
  const extensions: LockedExtension[] = input.resolution.nodes.map((node) => {
    const grant = grants.get(node.id);
    if (grant === undefined || grant.bundleDigest !== node.bundleDigest) {
      throw new ExtensionValidationError(
        "MISSING_PERMISSION_GRANT",
        `Extension ${node.id} needs a permission grant bound to its bundle digest.`,
        "grants",
      );
    }
    const dependencies = input.resolution.edges
      .filter((edge) => edge.from === node.id)
      .map((edge): LockedDependency => {
        const target = nodeById.get(edge.to);
        if (target === undefined) {
          throw new ExtensionValidationError(
            "LOCK_GRAPH_MISMATCH",
            `Resolved edge target ${edge.to} is absent.`,
            "resolution.edges",
          );
        }
        return Object.freeze({
          id: edge.to,
          version: target.version,
          range: edge.range,
          optional: edge.optional,
        });
      });
    return Object.freeze({
      id: node.id,
      version: node.version,
      bundleDigest: node.bundleDigest,
      contentDigest: node.manifest.integrity.contentDigest,
      provenanceDigest: canonicalJsonDigest(
        node.manifest.provenance as unknown as JsonValue,
      ),
      dependencies: Object.freeze(
        dependencies.sort((left, right) =>
          compareUtf16CodeUnits(left.id, right.id),
        ),
      ),
      permissionGrant: Object.freeze({
        grantId: grant.grantId,
        issuer: grant.issuer,
        permissions: normalizePermissionSet(grant.permissions),
      }),
    });
  });
  const withoutChecksum = {
    lockVersion: INSTALLATION_LOCK_VERSION,
    createdAt: input.createdAt,
    platformVersion: input.platformVersion,
    sdkVersion: input.sdkVersion,
    extensions: Object.freeze(
      extensions.sort((left, right) =>
        compareUtf16CodeUnits(left.id, right.id),
      ),
    ),
    decisions: Object.freeze(
      input.resolution.decisions.map((decision) =>
        Object.freeze({ ...decision }),
      ),
    ),
  };
  const checksum = computeInstallationLockChecksum(
    parseInstallationLock({
      ...withoutChecksum,
      checksum:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
  );
  return parseInstallationLock({ ...withoutChecksum, checksum });
}

export function verifyInstallationLock(
  value: unknown,
): InstallationLockVerification {
  let lock: InstallationLock;
  try {
    lock = parseInstallationLock(value);
  } catch (cause) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([
        cause instanceof Error ? cause.message : "Lock is malformed.",
      ]),
    });
  }
  const expected = computeInstallationLockChecksum(lock);
  if (!equalDigest(expected, lock.checksum)) {
    return Object.freeze({
      ok: false,
      lock,
      issues: Object.freeze(["Installation lock checksum does not match."]),
    });
  }
  const extensionById = new Map(
    lock.extensions.map((extension) => [extension.id, extension]),
  );
  const graphIssues: string[] = [];
  for (const extension of lock.extensions) {
    for (const dependency of extension.dependencies) {
      const target = extensionById.get(dependency.id);
      if (target === undefined) {
        graphIssues.push(
          `${extension.id} references missing dependency ${dependency.id}.`,
        );
      } else if (
        target.version !== dependency.version ||
        !satisfiesSemVer(target.version, dependency.range)
      ) {
        graphIssues.push(
          `${extension.id} dependency ${dependency.id} has an inconsistent locked version.`,
        );
      }
    }
  }
  if (graphIssues.length > 0) {
    return Object.freeze({
      ok: false,
      lock,
      issues: Object.freeze(graphIssues),
    });
  }
  return Object.freeze({ ok: true, lock, issues: Object.freeze([]) });
}
