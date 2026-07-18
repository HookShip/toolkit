// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workDirectory = path.join(packageRoot, ".pack-smoke-work");

function collectExportPaths(value, paths = new Set()) {
  if (typeof value === "string") {
    paths.add(value);
    return paths;
  }

  if (value !== null && typeof value === "object") {
    for (const nestedValue of Object.values(value)) {
      collectExportPaths(nestedValue, paths);
    }
  }

  return paths;
}

await rm(workDirectory, { force: true, recursive: true });

try {
  const tarballDirectory = path.join(workDirectory, "tarball");
  const extractDirectory = path.join(workDirectory, "extract");
  await mkdir(tarballDirectory, { recursive: true });
  await mkdir(extractDirectory, { recursive: true });

  execFileSync("pnpm", ["pack", "--pack-destination", tarballDirectory], {
    cwd: packageRoot,
    stdio: "ignore",
  });

  const tarballName = (await readdir(tarballDirectory)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (tarballName === undefined) {
    throw new Error("pnpm pack did not produce a tarball");
  }

  execFileSync(
    "tar",
    ["xzf", path.join(tarballDirectory, tarballName), "-C", extractDirectory],
    { stdio: "ignore" },
  );

  const contentsDirectory = path.join(extractDirectory, "package");
  const packageJson = JSON.parse(
    await readFile(path.join(contentsDirectory, "package.json"), "utf8"),
  );

  for (const requiredFile of [
    "package.json",
    "README.md",
    "LICENSE",
    "styles/portal.css",
  ]) {
    await access(path.join(contentsDirectory, requiredFile));
  }

  for (const excludedPath of ["src", "test", "scripts", "tsconfig.json"]) {
    try {
      await access(path.join(contentsDirectory, excludedPath));
      throw new Error(`development path leaked into package: ${excludedPath}`);
    } catch (error) {
      if (
        error instanceof Error &&
        !("code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  }

  const exportPaths = collectExportPaths(packageJson.exports);
  exportPaths.add(packageJson.types);
  for (const exportPath of exportPaths) {
    await access(path.join(contentsDirectory, exportPath));
  }

  const runtimeImports = Object.values(packageJson.exports)
    .flatMap((entry) =>
      typeof entry === "object" && entry !== null && "import" in entry
        ? [entry.import]
        : [],
    )
    .filter((entry) => typeof entry === "string");

  for (const runtimeImport of runtimeImports) {
    await import(
      pathToFileURL(path.join(contentsDirectory, runtimeImport)).href
    );
  }

  const clientEntry = await readFile(
    path.join(contentsDirectory, "dist/client/secret-reveal.js"),
    "utf8",
  );
  if (!clientEntry.startsWith('"use client";')) {
    throw new Error("client entry did not preserve its client directive");
  }

  console.log(
    `Packed @webhook-portal/portal-components@${packageJson.version}; ` +
      `${exportPaths.size} exported files verified and runtime imports loaded.`,
  );
} finally {
  await rm(workDirectory, { force: true, recursive: true });
}
