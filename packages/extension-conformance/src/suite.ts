// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  comparePermissionSets,
  compareUtf16CodeUnits,
  createInstallationPermissionGrant,
  loadConnectorPack,
  loadPolicyProgram,
  loadTemplatePack,
  loadTransformProgram,
  parseExtensionBundle,
  parseExtensionManifest,
  resolveExtensions,
  runPolicy,
  runTransform,
  satisfiesSemVer,
  serializeExtensionBundle,
  verifyExtensionBundle,
  type ExtensionBundle,
  type ExtensionResolution,
  type JsonValue,
  type SignatureTrustPolicy,
} from "@webhook-portal/extension-sdk";

import { runMaliciousCorpus } from "./malicious-corpus.js";
import {
  assertExtensionConformance,
  ensureConformance,
  registerConformanceCases,
  runConformanceCases,
  type ConformanceTestRunner,
  type ExtensionConformanceCase,
  type ExtensionConformanceReport,
} from "./runner.js";

export interface ExtensionConformanceFixture {
  readonly availableManifests?: readonly unknown[];
  readonly bundle: unknown;
  readonly expectedKind?: "connector" | "policy" | "template" | "transform";
  readonly grantedPermissions?: unknown;
  readonly name?: string;
  readonly platformVersion: string;
  readonly policyInput?: {
    readonly metadata: JsonValue;
    readonly payload?: JsonValue;
  };
  readonly rebuild?: () => ExtensionBundle | Promise<ExtensionBundle>;
  readonly sdkVersion: string;
  readonly transformInput?: JsonValue;
  readonly trustPolicy: SignatureTrustPolicy;
}

function verified(fixture: ExtensionConformanceFixture) {
  const result = verifyExtensionBundle(fixture.bundle, {
    trustPolicy: fixture.trustPolicy,
  });
  ensureConformance(
    result.ok && result.bundle !== undefined,
    `Bundle verification failed: ${result.issues
      .map((issue) => issue.code)
      .join(", ")}.`,
  );
  return { result, bundle: result.bundle };
}

function assertResolutionClosure(
  resolution: ExtensionResolution,
  root: { readonly id: string; readonly version: string },
  platformVersion: string,
  sdkVersion: string,
): void {
  const nodeIds = resolution.nodes.map((node) => node.id);
  ensureConformance(
    new Set(nodeIds).size === nodeIds.length,
    "Dependency resolution selected an extension more than once.",
  );
  ensureConformance(
    nodeIds.every(
      (id, index) =>
        index === 0 ||
        compareUtf16CodeUnits(resolution.nodes[index - 1]!.id, id) < 0,
    ),
    "Dependency resolution nodes are not deterministically ordered.",
  );
  const nodes = new Map(resolution.nodes.map((node) => [node.id, node]));
  ensureConformance(
    nodes.get(root.id)?.version === root.version,
    "Dependency resolution did not select the fixture root.",
  );

  const edgeKeys = resolution.edges.map(
    (edge) => `${edge.from}\u0000${edge.to}`,
  );
  ensureConformance(
    new Set(edgeKeys).size === edgeKeys.length,
    "Dependency resolution contains duplicate edges.",
  );
  ensureConformance(
    edgeKeys.every(
      (key, index) =>
        index === 0 || compareUtf16CodeUnits(edgeKeys[index - 1]!, key) < 0,
    ),
    "Dependency resolution edges are not deterministically ordered.",
  );
  ensureConformance(
    resolution.decisions.every(
      (decision, index) =>
        index === 0 ||
        compareUtf16CodeUnits(
          resolution.decisions[index - 1]!.id,
          decision.id,
        ) < 0,
    ),
    "Dependency resolution decisions are not deterministically ordered.",
  );
  const edges = new Map(
    resolution.edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge]),
  );
  const adjacency = new Map<string, string[]>();

  for (const node of resolution.nodes) {
    ensureConformance(
      satisfiesSemVer(platformVersion, node.manifest.compatibility.platform) &&
        satisfiesSemVer(sdkVersion, node.manifest.compatibility.sdk),
      `Selected extension ${node.id} is incompatible with the fixture runtime.`,
    );
    for (const dependency of node.manifest.compatibility.dependencies) {
      const selected = nodes.get(dependency.id);
      ensureConformance(
        dependency.optional || selected !== undefined,
        `Required dependency ${dependency.id} was not selected.`,
      );
      if (selected === undefined) {
        continue;
      }
      ensureConformance(
        satisfiesSemVer(selected.version, dependency.range),
        `Dependency ${dependency.id}@${selected.version} does not satisfy ${dependency.range}.`,
      );
      const edge = edges.get(`${node.id}\u0000${dependency.id}`);
      ensureConformance(
        edge?.range === dependency.range &&
          edge.optional === dependency.optional,
        `Dependency edge ${node.id} -> ${dependency.id} is missing or inconsistent.`,
      );
      const targets = adjacency.get(node.id) ?? [];
      targets.push(dependency.id);
      adjacency.set(node.id, targets);
    }
  }

  ensureConformance(
    resolution.edges.every((edge) => {
      const from = nodes.get(edge.from);
      return (
        from !== undefined &&
        nodes.has(edge.to) &&
        from.manifest.compatibility.dependencies.some(
          (dependency) =>
            dependency.id === edge.to &&
            dependency.range === edge.range &&
            dependency.optional === edge.optional,
        )
      );
    }),
    "Dependency resolution contains an undeclared or unresolved edge.",
  );

  for (let left = 0; left < resolution.nodes.length; left += 1) {
    for (let right = left + 1; right < resolution.nodes.length; right += 1) {
      const leftNode = resolution.nodes[left]!;
      const rightNode = resolution.nodes[right]!;
      const conflict =
        leftNode.manifest.compatibility.conflicts.some(
          (candidate) =>
            candidate.id === rightNode.id &&
            satisfiesSemVer(rightNode.version, candidate.range),
        ) ||
        rightNode.manifest.compatibility.conflicts.some(
          (candidate) =>
            candidate.id === leftNode.id &&
            satisfiesSemVer(leftNode.version, candidate.range),
        );
      ensureConformance(
        !conflict,
        `Selected extensions ${leftNode.id} and ${rightNode.id} conflict.`,
      );
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): void => {
    ensureConformance(
      !active.has(id),
      `Dependency resolution contains a cycle involving ${id}.`,
    );
    if (visited.has(id)) {
      return;
    }
    active.add(id);
    for (const dependency of adjacency.get(id) ?? []) {
      visit(dependency);
    }
    active.delete(id);
    visited.add(id);
  };
  visit(root.id);
  ensureConformance(
    visited.size === resolution.nodes.length,
    "Dependency resolution contains extensions outside the root dependency closure.",
  );
}

export function createExtensionConformanceCases(
  fixture: ExtensionConformanceFixture,
): readonly ExtensionConformanceCase[] {
  return Object.freeze([
    {
      id: "manifest.closed-versioned",
      name: "manifest is closed, versioned, and kind-consistent",
      category: "manifest",
      run(): void {
        const bundle = parseExtensionBundle(fixture.bundle);
        const manifest = parseExtensionManifest(bundle.manifest);
        ensureConformance(
          fixture.expectedKind === undefined ||
            manifest.kind === fixture.expectedKind,
          `Expected ${fixture.expectedKind ?? "declared"} extension kind, received ${manifest.kind}.`,
        );
        ensureConformance(
          manifest.entry.type === manifest.kind,
          "Manifest entry type does not match extension kind.",
        );
      },
    },
    {
      id: "bundle.integrity-trust",
      name: "bundle content, resources, and signatures verify",
      category: "bundle",
      run(): void {
        verified(fixture);
      },
    },
    {
      id: "permissions.no-escalation",
      name: "installation permissions remain within requested scopes",
      category: "permissions",
      run(): void {
        const { bundle } = verified(fixture);
        const granted =
          fixture.grantedPermissions ?? bundle.manifest.permissions;
        const comparison = comparePermissionSets(
          granted,
          bundle.manifest.permissions,
        );
        ensureConformance(
          comparison.allowed,
          "Fixture grants permissions not requested by the extension.",
        );
        createInstallationPermissionGrant({
          bundleDigest: bundle.manifest.integrity.bundleDigest,
          extensionId: bundle.manifest.identity.id,
          grantId: "conformance-grant",
          issuer: "extension-conformance",
          requested: bundle.manifest.permissions,
          granted,
        });
      },
    },
    {
      id: "runtime.declarative-only",
      name: "extension entry loads as bounded declarative data",
      category: "transformer-policy",
      run(): void {
        const { result, bundle } = verified(fixture);
        switch (bundle.manifest.kind) {
          case "transform": {
            const program = loadTransformProgram(result);
            const input = fixture.transformInput ?? {};
            const left = runTransform(program, input, {
              permissions: bundle.manifest.permissions,
            });
            const right = runTransform(program, input, {
              permissions: bundle.manifest.permissions,
            });
            ensureConformance(
              canonicalJson(left) === canonicalJson(right),
              "Transform output is not deterministic.",
            );
            break;
          }
          case "policy": {
            const program = loadPolicyProgram(result);
            const input = fixture.policyInput ?? { metadata: {} };
            const left = runPolicy(program, input, {
              permissions: bundle.manifest.permissions,
            });
            const right = runPolicy(program, input, {
              permissions: bundle.manifest.permissions,
            });
            ensureConformance(
              canonicalJson(left as unknown as JsonValue) ===
                canonicalJson(right as unknown as JsonValue),
              "Policy output is not deterministic.",
            );
            break;
          }
          case "connector": {
            const pack = loadConnectorPack(result);
            ensureConformance(
              !Object.hasOwn(pack, "execute"),
              "Connector pack unexpectedly exposes executable behavior.",
            );
            break;
          }
          case "template": {
            const pack = loadTemplatePack(result);
            ensureConformance(
              !Object.hasOwn(pack, "execute"),
              "Template pack unexpectedly exposes executable behavior.",
            );
            break;
          }
        }
      },
    },
    {
      id: "compatibility.resolvable",
      name: "platform, SDK, and dependency metadata resolve deterministically",
      category: "compatibility",
      run(): void {
        const { bundle } = verified(fixture);
        ensureConformance(
          satisfiesSemVer(
            fixture.platformVersion,
            bundle.manifest.compatibility.platform,
          ),
          "Extension is incompatible with the fixture platform version.",
        );
        ensureConformance(
          satisfiesSemVer(
            fixture.sdkVersion,
            bundle.manifest.compatibility.sdk,
          ),
          "Extension is incompatible with the fixture SDK version.",
        );
        const available = [
          bundle.manifest,
          ...(fixture.availableManifests ?? []).filter((candidate) => {
            try {
              const manifest = parseExtensionManifest(candidate);
              return !(
                manifest.identity.id === bundle.manifest.identity.id &&
                manifest.identity.version === bundle.manifest.identity.version
              );
            } catch {
              return true;
            }
          }),
        ];
        const request = {
          platformVersion: fixture.platformVersion,
          sdkVersion: fixture.sdkVersion,
          roots: [
            {
              id: bundle.manifest.identity.id,
              range: bundle.manifest.identity.version,
            },
          ],
        } as const;
        const resolution = resolveExtensions({ ...request, available });
        const reversed = resolveExtensions({
          ...request,
          available: [...available].reverse(),
        });
        ensureConformance(
          canonicalJson(resolution as unknown as JsonValue) ===
            canonicalJson(reversed as unknown as JsonValue),
          "Dependency resolution changes with candidate input order.",
        );
        assertResolutionClosure(
          resolution,
          {
            id: bundle.manifest.identity.id,
            version: bundle.manifest.identity.version,
          },
          fixture.platformVersion,
          fixture.sdkVersion,
        );
      },
    },
    {
      id: "determinism.reproducible",
      name: "canonical serialization and optional rebuild are reproducible",
      category: "determinism",
      async run(): Promise<void> {
        const { bundle } = verified(fixture);
        const serialized = serializeExtensionBundle(bundle);
        ensureConformance(
          serializeExtensionBundle(
            parseExtensionBundle(JSON.parse(serialized)),
          ) === serialized,
          "Bundle serialization is not canonical and reproducible.",
        );
        if (fixture.rebuild !== undefined) {
          const rebuilt = await fixture.rebuild();
          ensureConformance(
            rebuilt.manifest.integrity.contentDigest ===
              bundle.manifest.integrity.contentDigest &&
              rebuilt.manifest.integrity.bundleDigest ===
                bundle.manifest.integrity.bundleDigest,
            "Rebuilt bundle digests differ from the supplied bundle.",
          );
        }
      },
    },
    {
      id: "malicious-corpus.closed-failures",
      name: "malicious corpus is rejected fail-closed",
      category: "malicious-corpus",
      run(): void {
        const results = runMaliciousCorpus();
        const failures = results.filter((result) => !result.passed);
        ensureConformance(
          failures.length === 0,
          `Malicious corpus failures: ${failures
            .map((failure) => failure.id)
            .join(", ")}.`,
        );
      },
    },
  ]);
}

export async function runExtensionConformance(
  fixture: ExtensionConformanceFixture,
): Promise<ExtensionConformanceReport> {
  return runConformanceCases(
    fixture.name ?? "Extension conformance",
    createExtensionConformanceCases(fixture),
  );
}

export async function assertConformingExtension(
  fixture: ExtensionConformanceFixture,
): Promise<void> {
  assertExtensionConformance(await runExtensionConformance(fixture));
}

export function registerExtensionConformanceTests(
  runner: ConformanceTestRunner,
  fixture: ExtensionConformanceFixture,
): void {
  registerConformanceCases(
    runner,
    fixture.name ?? "Extension conformance",
    createExtensionConformanceCases(fixture),
  );
}
