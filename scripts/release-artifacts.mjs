// SPDX-License-Identifier: Apache-2.0

import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  readJson,
  root,
  run,
  sha256File,
  workRoot,
} from "./release-context.mjs";
import { gitValue } from "./release-git.mjs";
import {
  check,
  loadManifest,
  validateRepository,
} from "./release-manifest.mjs";

export async function findTarball(directory) {
  const entries = await readdir(directory);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `${directory}: expected one tarball, found ${tarballs.length}`,
    );
  }
  return path.join(directory, tarballs[0]);
}

export async function inspectTarball(tarball, extractDirectory) {
  await mkdir(extractDirectory, { recursive: true });
  await run("tar", ["xzf", tarball, "-C", extractDirectory], { quiet: true });
  const contents = path.join(extractDirectory, "package");
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    await access(path.join(contents, required));
  }
  for (const rejected of [
    "src",
    "test",
    ".env",
    ".npmrc",
    "tsconfig.json",
    ".turbo",
  ]) {
    try {
      await access(path.join(contents, rejected));
      throw new Error(`${tarball}: rejected artifact path ${rejected}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return readJson(path.join(contents, "package.json"));
}

export function dependencyPackages(pkg, resolved = {}) {
  return Object.entries({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  }).map(([name, declaredRange], index) => {
    const info = resolved[name] ?? {};
    const version =
      typeof info.version === "string" ? info.version : declaredRange;
    const license =
      typeof info.license === "string" ? info.license : "NOASSERTION";
    const entry = {
      SPDXID: `SPDXRef-Dependency-${index + 1}`,
      name,
      versionInfo: version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: license,
      licenseDeclared: license,
      copyrightText: "NOASSERTION",
    };
    // A package-URL is a stable identifier (not an invented endpoint), so it is
    // only emitted once the exact installed version is known.
    if (typeof info.version === "string") {
      entry.externalRefs = [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:npm/${purlName(name)}@${info.version}`,
        },
      ];
    }
    return entry;
  });
}

// npm package URLs encode a scope's leading "@" as %40 and keep the "/" between
// scope and package name as the purl namespace separator.
export function purlName(name) {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash !== -1) {
      return `%40${name.slice(1, slash)}/${name.slice(slash + 1)}`;
    }
  }
  return name;
}

// Extracts a declared SPDX license expression from an installed package's
// manifest, tolerating the deprecated `license` object and `licenses` array
// forms. Returns null when no license is declared so callers fall back to
// NOASSERTION rather than inventing one.
export function declaredLicense(pkg) {
  if (!pkg || typeof pkg !== "object") return null;
  if (typeof pkg.license === "string" && pkg.license.trim() !== "") {
    return pkg.license.trim();
  }
  if (
    pkg.license &&
    typeof pkg.license === "object" &&
    typeof pkg.license.type === "string" &&
    pkg.license.type.trim() !== ""
  ) {
    return pkg.license.type.trim();
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((entry) => entry?.type)
      .filter((type) => typeof type === "string" && type.trim() !== "");
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(" OR ")})`;
  }
  return null;
}

// Reads the resolved version and declared license of every runtime dependency
// from the frozen install tree, without executing any dependency code. pnpm
// nests a package's own dependencies under its local node_modules and symlinks
// them into the content-addressed store, so the package directory is checked
// first and the workspace root second. Dependencies that cannot be resolved are
// omitted, and the SBOM then falls back to their declared range.
export async function resolveDependencyMetadata(pkg, packageDir) {
  const names = Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  });
  const resolved = {};
  for (const name of names) {
    for (const base of [path.join(root, packageDir), root]) {
      try {
        const manifest = await readJson(
          path.join(base, "node_modules", name, "package.json"),
        );
        resolved[name] = {
          version:
            typeof manifest.version === "string" ? manifest.version : null,
          license: declaredLicense(manifest),
        };
        break;
      } catch {
        // Try the next candidate location; unresolved names are left out.
      }
    }
  }
  return resolved;
}

export function sbomFor(pkg, checksum, resolved = {}) {
  const dependencies = dependencyPackages(pkg, resolved);
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${pkg.name}-${pkg.version}`,
    documentNamespace: `urn:hookship-toolkit:sbom:${encodeURIComponent(pkg.name)}:${pkg.version}:${checksum}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: hookship-toolkit-release-script"],
    },
    packages: [
      {
        SPDXID: "SPDXRef-RootPackage",
        name: pkg.name,
        versionInfo: pkg.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        checksums: [{ algorithm: "SHA256", checksumValue: checksum }],
        licenseConcluded: pkg.license ?? "NOASSERTION",
        licenseDeclared: pkg.license ?? "NOASSERTION",
        copyrightText: "NOASSERTION",
      },
      ...dependencies,
    ],
    relationships: dependencies.map((dependency) => ({
      spdxElementId: "SPDXRef-RootPackage",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: dependency.SPDXID,
    })),
  };
}

// Derives a trustworthy builder identity and invocation id from the GitHub
// Actions environment when present, and otherwise reports the local release
// script. It never fabricates CI metadata: outside CI the invocation id is null
// and the builder is the local URN.
export function ciBuildContext(env = process.env) {
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_RUN_ID) {
    const server = env.GITHUB_SERVER_URL ?? "https://github.com";
    const repository = env.GITHUB_REPOSITORY ?? null;
    const workflowRef = env.GITHUB_WORKFLOW_REF ?? null;
    return {
      builderId: workflowRef
        ? `${server}/${workflowRef}`
        : repository
          ? `${server}/${repository}`
          : "urn:hookship-toolkit:github-actions",
      invocationId: repository
        ? `${server}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
      onCi: true,
    };
  }
  return {
    builderId: "urn:hookship-toolkit:local-release-script",
    invocationId: null,
    onCi: false,
  };
}

// Builds the in-toto/SLSA provenance statement for one packed tarball. This is a
// supplementary, unsigned build record: the authoritative, cryptographically
// verifiable provenance is the npm registry OIDC provenance produced by
// `npm publish --provenance`. That distinction is recorded machine-readably in
// internalParameters.attestation so consumers do not over-trust this file.
export function provenanceStatement({
  entry,
  checksum,
  relativeTarball,
  commit,
  dirty,
  lockChecksum,
  ci = ciBuildContext(),
}) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: relativeTarball, digest: { sha256: checksum } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "urn:hookship-toolkit:release-script:v1",
        externalParameters: { package: entry.name, version: entry.version },
        internalParameters: {
          gitCommit: commit,
          gitWorkingTreeDirty: dirty,
          attestation: {
            authoritativeProvenance: "npm registry OIDC provenance",
            generatedBy: "hookship-toolkit release script",
            signed: false,
            supplementary: true,
          },
        },
        resolvedDependencies: [
          { uri: "pnpm-lock.yaml", digest: { sha256: lockChecksum } },
        ],
      },
      runDetails: {
        builder: { id: ci.builderId },
        metadata: { invocationId: ci.invocationId },
      },
    },
  };
}

export async function buildArtifacts({ publishDryRun }) {
  await check();
  const manifest = await loadManifest();
  await rm(workRoot, { recursive: true, force: true });
  const tarballRoot = path.join(workRoot, "tarballs");
  const extractRoot = path.join(workRoot, "extract");
  const metadataRoot = path.join(workRoot, "metadata");
  await mkdir(tarballRoot, { recursive: true });
  await mkdir(metadataRoot, { recursive: true });

  const commit = await gitValue(["rev-parse", "HEAD"]);
  const status = await gitValue(["status", "--porcelain"]);
  const lockChecksum = await sha256File(path.join(root, "pnpm-lock.yaml"));
  const checksumLines = [];

  for (const entry of manifest.openPackages) {
    const packageOutput = path.join(tarballRoot, path.basename(entry.path));
    await mkdir(packageOutput, { recursive: true });
    console.log(`Packing ${entry.name}@${entry.version}`);
    await run("pnpm", ["pack", "--pack-destination", packageOutput], {
      cwd: path.join(root, entry.path),
      quiet: true,
    });
    const tarball = await findTarball(packageOutput);
    const packedManifest = await inspectTarball(
      tarball,
      path.join(extractRoot, path.basename(entry.path)),
    );
    if (
      packedManifest.name !== entry.name ||
      packedManifest.version !== entry.version
    ) {
      throw new Error(`${entry.name}: packed manifest name/version mismatch`);
    }
    // The packed tarball must retain the repository provenance metadata, or a
    // published package would carry unverifiable provenance.
    const packedRepositoryFailures = validateRepository(
      packedManifest.repository,
      entry.path,
      `${entry.name} (packed)`,
    );
    if (packedRepositoryFailures.length > 0) {
      throw new Error(packedRepositoryFailures.join("; "));
    }
    const checksum = await sha256File(tarball);
    const relativeTarball = path.relative(workRoot, tarball);
    checksumLines.push(`${checksum}  ${relativeTarball}`);

    const safeName = entry.name.replaceAll("/", "-").replace(/^@/, "");
    const resolvedDependencies = await resolveDependencyMetadata(
      packedManifest,
      entry.path,
    );
    await writeFile(
      path.join(metadataRoot, `${safeName}-${entry.version}.spdx.json`),
      `${JSON.stringify(sbomFor(packedManifest, checksum, resolvedDependencies), null, 2)}\n`,
    );
    const provenance = provenanceStatement({
      entry,
      checksum,
      relativeTarball,
      commit,
      dirty: status === null ? null : status.length > 0,
      lockChecksum,
    });
    await writeFile(
      path.join(metadataRoot, `${safeName}-${entry.version}.provenance.json`),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );

    if (publishDryRun) {
      console.log(`Dry-running npm publish for ${entry.name}`);
      await run(
        "npm",
        [
          "publish",
          "--dry-run",
          "--ignore-scripts",
          "--access",
          "public",
          tarball,
        ],
        { quiet: true },
      );
    }
  }

  await writeFile(
    path.join(workRoot, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
  );
  console.log(
    `Release package artifacts verified in ${path.relative(root, workRoot)}/`,
  );
}
