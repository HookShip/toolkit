// SPDX-License-Identifier: Apache-2.0

import { compareUtf16CodeUnits } from "./canonical.js";
import { ResolutionError } from "./errors.js";
import { parseExtensionManifest, type ExtensionManifest } from "./manifest.js";
import {
  compareSemVer,
  parseSemVer,
  parseSemVerRange,
  satisfiesSemVer,
} from "./semver.js";
import {
  expectIdentifier,
  expectInteger,
  expectString,
  inspectArray,
  inspectClosedObject,
  inspectRecord,
} from "./validation.js";

export interface ExtensionRequirement {
  readonly id: string;
  readonly range: string;
}

export interface InstalledExtensionVersion {
  readonly bundleDigest: string;
  readonly id: string;
  readonly version: string;
}

export interface ResolverLimits {
  readonly maximumAttempts?: number;
  readonly maximumCandidates?: number;
  readonly maximumPackages?: number;
}

export interface ResolutionNode {
  readonly bundleDigest: string;
  readonly id: string;
  readonly manifest: ExtensionManifest;
  readonly version: string;
}

export interface ResolutionEdge {
  readonly from: string;
  readonly optional: boolean;
  readonly range: string;
  readonly to: string;
}

export type ResolutionDecisionKind =
  "install" | "keep" | "remove" | "replace" | "rollback" | "upgrade";

export interface ResolutionDecision {
  readonly fromVersion?: string;
  readonly id: string;
  readonly kind: ResolutionDecisionKind;
  readonly pinned: boolean;
  readonly toVersion?: string;
}

export interface ExtensionResolution {
  readonly decisions: readonly ResolutionDecision[];
  readonly edges: readonly ResolutionEdge[];
  readonly nodes: readonly ResolutionNode[];
}

interface Constraint {
  readonly from: string;
  readonly optional: boolean;
  readonly range: string;
}

interface SearchState {
  readonly constraints: Map<string, readonly Constraint[]>;
  readonly selected: Map<string, ExtensionManifest>;
  readonly skipped: ReadonlySet<string>;
}

interface SearchFailure {
  readonly code:
    | "DEPENDENCY_CONFLICT"
    | "DEPENDENCY_CYCLE"
    | "RESOLUTION_LIMIT"
    | "UNSATISFIABLE_DEPENDENCY";
  readonly details: Readonly<Record<string, unknown>>;
  readonly message: string;
}

function boundedLimits(limits: ResolverLimits = {}) {
  const limit = (
    value: number | undefined,
    hard: number,
    path: string,
  ): number =>
    value === undefined ? hard : expectInteger(value, path, 1, hard);
  return Object.freeze({
    maximumAttempts: limit(
      limits.maximumAttempts,
      100_000,
      "limits.maximumAttempts",
    ),
    maximumCandidates: limit(
      limits.maximumCandidates,
      4_096,
      "limits.maximumCandidates",
    ),
    maximumPackages: limit(
      limits.maximumPackages,
      256,
      "limits.maximumPackages",
    ),
  });
}

function parseRequirement(value: unknown, path: string): ExtensionRequirement {
  const object = inspectClosedObject(value, path, ["id", "range"]);
  const range = expectString(object.range, `${path}.range`, {
    maximumLength: 512,
  });
  parseSemVerRange(range);
  return Object.freeze({
    id: expectIdentifier(object.id, `${path}.id`, 256),
    range,
  });
}

function parseInstalled(
  value: unknown,
  path: string,
): InstalledExtensionVersion {
  const object = inspectClosedObject(value, path, [
    "id",
    "version",
    "bundleDigest",
  ]);
  const version = expectString(object.version, `${path}.version`, {
    maximumLength: 128,
  });
  parseSemVer(version);
  return Object.freeze({
    id: expectIdentifier(object.id, `${path}.id`, 256),
    version,
    bundleDigest: expectString(object.bundleDigest, `${path}.bundleDigest`, {
      maximumLength: 71,
    }),
  });
}

function normalizePins(value: unknown): ReadonlyMap<string, string> {
  const record = inspectRecord(value ?? {}, "pins", {
    maximumEntries: 256,
  });
  const result = new Map<string, string>();
  for (const id of Object.keys(record).sort(compareUtf16CodeUnits)) {
    expectIdentifier(id, "pins key", 256);
    const version = expectString(record[id], `pins.${id}`, {
      maximumLength: 128,
    });
    parseSemVer(version);
    result.set(id, version);
  }
  return result;
}

function addConstraint(
  constraints: Map<string, readonly Constraint[]>,
  id: string,
  constraint: Constraint,
): void {
  const current = constraints.get(id) ?? [];
  constraints.set(
    id,
    Object.freeze(
      [...current, constraint].sort((left, right) => {
        const from = compareUtf16CodeUnits(left.from, right.from);
        return from === 0
          ? compareUtf16CodeUnits(left.range, right.range)
          : from;
      }),
    ),
  );
}

function cloneConstraints(
  constraints: ReadonlyMap<string, readonly Constraint[]>,
): Map<string, readonly Constraint[]> {
  return new Map(constraints);
}

function candidateMatches(
  candidate: ExtensionManifest,
  constraints: readonly Constraint[],
  pin: string | undefined,
): boolean {
  return (
    (pin === undefined || candidate.identity.version === pin) &&
    constraints.every((constraint) =>
      satisfiesSemVer(candidate.identity.version, constraint.range),
    )
  );
}

function manifestsConflict(
  left: ExtensionManifest,
  right: ExtensionManifest,
): boolean {
  return (
    left.compatibility.conflicts.some(
      (conflict) =>
        conflict.id === right.identity.id &&
        satisfiesSemVer(right.identity.version, conflict.range),
    ) ||
    right.compatibility.conflicts.some(
      (conflict) =>
        conflict.id === left.identity.id &&
        satisfiesSemVer(left.identity.version, conflict.range),
    )
  );
}

function dependencyCycle(
  selected: ReadonlyMap<string, ExtensionManifest>,
): readonly string[] | undefined {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): readonly string[] | undefined => {
    if (active.has(id)) {
      const start = stack.indexOf(id);
      return Object.freeze([...stack.slice(start), id]);
    }
    if (visited.has(id)) {
      return undefined;
    }
    active.add(id);
    stack.push(id);
    const manifest = selected.get(id);
    if (manifest !== undefined) {
      const dependencies = manifest.compatibility.dependencies
        .filter((dependency) => selected.has(dependency.id))
        .map((dependency) => dependency.id)
        .sort(compareUtf16CodeUnits);
      for (const dependency of dependencies) {
        const cycle = visit(dependency);
        if (cycle !== undefined) {
          return cycle;
        }
      }
    }
    stack.pop();
    active.delete(id);
    visited.add(id);
    return undefined;
  };

  for (const id of [...selected.keys()].sort(compareUtf16CodeUnits)) {
    const cycle = visit(id);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return undefined;
}

export function resolveExtensions(input: {
  readonly available: readonly unknown[];
  readonly installed?: readonly unknown[];
  readonly limits?: ResolverLimits;
  readonly pins?: Readonly<Record<string, string>>;
  readonly platformVersion: string;
  readonly roots: readonly unknown[];
  readonly sdkVersion: string;
}): ExtensionResolution {
  const limits = boundedLimits(input.limits);
  parseSemVer(input.platformVersion);
  parseSemVer(input.sdkVersion);
  const roots = inspectArray(input.roots, "roots", limits.maximumPackages).map(
    (candidate, index) => parseRequirement(candidate, `roots[${index}]`),
  );
  if (roots.length === 0) {
    throw new ResolutionError(
      "EMPTY_ROOTS",
      "At least one root extension requirement is required.",
    );
  }
  const rootIds = new Set<string>();
  for (const root of roots) {
    if (rootIds.has(root.id)) {
      throw new ResolutionError(
        "DUPLICATE_ROOT",
        `Root extension ${root.id} is declared more than once.`,
      );
    }
    rootIds.add(root.id);
  }
  const pins = normalizePins(input.pins);
  const candidates = inspectArray(
    input.available,
    "available",
    limits.maximumCandidates,
  ).map((candidate) => parseExtensionManifest(candidate));
  const byId = new Map<string, ExtensionManifest[]>();
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const identity = `${candidate.identity.id}@${candidate.identity.version}`;
    if (identities.has(identity)) {
      throw new ResolutionError(
        "DUPLICATE_CANDIDATE",
        `Duplicate available extension ${identity}.`,
      );
    }
    identities.add(identity);
    if (
      !satisfiesSemVer(
        input.platformVersion,
        candidate.compatibility.platform,
      ) ||
      !satisfiesSemVer(input.sdkVersion, candidate.compatibility.sdk)
    ) {
      continue;
    }
    const group = byId.get(candidate.identity.id) ?? [];
    group.push(candidate);
    byId.set(candidate.identity.id, group);
  }
  for (const group of byId.values()) {
    group.sort((left, right) => {
      const version = compareSemVer(
        right.identity.version,
        left.identity.version,
      );
      return version === 0
        ? compareUtf16CodeUnits(
            left.integrity.bundleDigest,
            right.integrity.bundleDigest,
          )
        : version;
    });
  }

  const initialConstraints = new Map<string, readonly Constraint[]>();
  for (const root of roots) {
    addConstraint(initialConstraints, root.id, {
      from: "$root",
      optional: false,
      range: root.range,
    });
  }

  let attempts = 0;
  let lastFailure: SearchFailure = {
    code: "UNSATISFIABLE_DEPENDENCY",
    message: "No extension set satisfies all requirements.",
    details: {},
  };

  const search = (
    state: SearchState,
  ): Map<string, ExtensionManifest> | undefined => {
    attempts += 1;
    if (attempts > limits.maximumAttempts) {
      lastFailure = {
        code: "RESOLUTION_LIMIT",
        message: "Dependency resolution attempt limit exceeded.",
        details: { attempts },
      };
      return undefined;
    }
    if (state.selected.size > limits.maximumPackages) {
      lastFailure = {
        code: "RESOLUTION_LIMIT",
        message: "Resolved package count exceeds the configured limit.",
        details: { packages: state.selected.size },
      };
      return undefined;
    }
    for (const [id, selected] of state.selected) {
      const constraints = state.constraints.get(id) ?? [];
      if (!candidateMatches(selected, constraints, pins.get(id))) {
        lastFailure = {
          code: "UNSATISFIABLE_DEPENDENCY",
          message: `Selected extension ${id} no longer satisfies accumulated constraints.`,
          details: { id },
        };
        return undefined;
      }
    }
    const unresolved = [...state.constraints.keys()]
      .filter((id) => !state.selected.has(id) && !state.skipped.has(id))
      .sort(compareUtf16CodeUnits);
    const id = unresolved[0];
    if (id === undefined) {
      const cycle = dependencyCycle(state.selected);
      if (cycle !== undefined) {
        lastFailure = {
          code: "DEPENDENCY_CYCLE",
          message: `Dependency cycle detected: ${cycle.join(" -> ")}.`,
          details: { cycle },
        };
        return undefined;
      }
      return new Map(state.selected);
    }
    const constraints = state.constraints.get(id) ?? [];
    const matching = (byId.get(id) ?? []).filter((candidate) =>
      candidateMatches(candidate, constraints, pins.get(id)),
    );
    for (const candidate of matching) {
      const conflict = [...state.selected.values()].find((selected) =>
        manifestsConflict(candidate, selected),
      );
      if (conflict !== undefined) {
        lastFailure = {
          code: "DEPENDENCY_CONFLICT",
          message: `${candidate.identity.id}@${candidate.identity.version} conflicts with ${conflict.identity.id}@${conflict.identity.version}.`,
          details: {
            left: candidate.identity.id,
            right: conflict.identity.id,
          },
        };
        continue;
      }
      const selected = new Map(state.selected);
      selected.set(id, candidate);
      const nextConstraints = cloneConstraints(state.constraints);
      const skipped = new Set(state.skipped);
      for (const dependency of candidate.compatibility.dependencies) {
        addConstraint(nextConstraints, dependency.id, {
          from: id,
          optional: dependency.optional,
          range: dependency.range,
        });
        if (!dependency.optional) {
          skipped.delete(dependency.id);
        }
      }
      const resolved = search({
        constraints: nextConstraints,
        selected,
        skipped,
      });
      if (resolved !== undefined) {
        return resolved;
      }
      if (lastFailure.code === "RESOLUTION_LIMIT") {
        return undefined;
      }
    }
    if (constraints.length > 0 && constraints.every((item) => item.optional)) {
      const skipped = new Set(state.skipped);
      skipped.add(id);
      return search({ ...state, skipped });
    }
    if (matching.length === 0) {
      lastFailure = {
        code: "UNSATISFIABLE_DEPENDENCY",
        message: `No compatible version of ${id} satisfies all constraints.`,
        details: {
          id,
          ranges: constraints.map((constraint) => constraint.range),
          pin: pins.get(id),
        },
      };
    }
    return undefined;
  };

  const selected = search({
    constraints: initialConstraints,
    selected: new Map(),
    skipped: new Set(),
  });
  if (selected === undefined) {
    throw new ResolutionError(
      lastFailure.code,
      lastFailure.message,
      lastFailure.details,
    );
  }

  const nodes: ResolutionNode[] = [...selected.values()]
    .sort((left, right) =>
      compareUtf16CodeUnits(left.identity.id, right.identity.id),
    )
    .map((manifest) =>
      Object.freeze({
        id: manifest.identity.id,
        version: manifest.identity.version,
        bundleDigest: manifest.integrity.bundleDigest,
        manifest,
      }),
    );
  const edges: ResolutionEdge[] = [];
  for (const manifest of selected.values()) {
    for (const dependency of manifest.compatibility.dependencies) {
      if (selected.has(dependency.id)) {
        edges.push(
          Object.freeze({
            from: manifest.identity.id,
            to: dependency.id,
            range: dependency.range,
            optional: dependency.optional,
          }),
        );
      }
    }
  }
  edges.sort((left, right) => {
    const from = compareUtf16CodeUnits(left.from, right.from);
    return from === 0 ? compareUtf16CodeUnits(left.to, right.to) : from;
  });

  const installed = inspectArray(
    input.installed ?? [],
    "installed",
    limits.maximumPackages,
  ).map((candidate, index) => parseInstalled(candidate, `installed[${index}]`));
  const installedIds = new Set<string>();
  for (const item of installed) {
    if (installedIds.has(item.id)) {
      throw new ResolutionError(
        "DUPLICATE_INSTALLED_EXTENSION",
        `Installed extension ${item.id} is declared more than once.`,
      );
    }
    installedIds.add(item.id);
  }
  const installedById = new Map(installed.map((item) => [item.id, item]));
  const decisions: ResolutionDecision[] = [];
  for (const node of nodes) {
    const prior = installedById.get(node.id);
    let kind: ResolutionDecisionKind;
    if (prior === undefined) {
      kind = "install";
    } else {
      const comparison = compareSemVer(node.version, prior.version);
      if (comparison > 0) {
        kind = "upgrade";
      } else if (comparison < 0) {
        kind = "rollback";
      } else if (node.bundleDigest === prior.bundleDigest) {
        kind = "keep";
      } else {
        kind = "replace";
      }
      installedById.delete(node.id);
    }
    decisions.push(
      Object.freeze({
        id: node.id,
        kind,
        pinned: pins.has(node.id),
        ...(prior === undefined ? {} : { fromVersion: prior.version }),
        toVersion: node.version,
      }),
    );
  }
  for (const prior of installedById.values()) {
    decisions.push(
      Object.freeze({
        id: prior.id,
        kind: "remove",
        pinned: false,
        fromVersion: prior.version,
      }),
    );
  }
  decisions.sort((left, right) => compareUtf16CodeUnits(left.id, right.id));
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    decisions: Object.freeze(decisions),
  });
}
