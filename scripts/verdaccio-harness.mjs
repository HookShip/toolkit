#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Zero-spend local Verdaccio integration harness.
//
// Proves the public cohort works as real published packages — not just as
// local tarballs — without touching any hosted registry or incurring any
// spend. It starts a throwaway Verdaccio on an ephemeral loopback port whose
// storage, auth, and config all live under a git-ignored work directory, packs
// and publishes every @webhook-portal package to it in dependency order, then
// from a clean consumer project installs the whole cohort *by name*, imports
// every published entry point, and invokes the packed CLI. Installing by name
// forces internal @webhook-portal dependencies to resolve from the registry
// (not from the workspace or local tarball paths), which is exactly what a
// downstream consumer does.
//
// The registry is never left running: it is always stopped and the work
// directory removed in a finally block and on SIGINT/SIGTERM. No token is
// stored anywhere tracked — the only credential is a throwaway token minted at
// runtime for the local registry and written under the git-ignored work
// directory, which is deleted on teardown.

import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  internalDependencyGraph,
  loadManifest,
  topologicalOrder,
} from "./release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(root, ".verdaccio-work");
// The Verdaccio install is expensive to fetch, so it persists across runs.
const runtimeDir = path.join(workRoot, "runtime");
// Everything else is per-run and is removed on teardown.
const sessionDir = path.join(workRoot, "session");
const storageDir = path.join(sessionDir, "storage");
const configPath = path.join(sessionDir, "config.yaml");
const npmrcPath = path.join(sessionDir, ".npmrc");
const tarballDir = path.join(sessionDir, "tarballs");
const consumerDir = path.join(sessionDir, "consumer");
const logPath = path.join(sessionDir, "verdaccio.log");

// Every published entry point, mirroring scripts/pack-smoke.sh so the two
// harnesses stay in agreement about the public import surface.
const entryPoints = [
  "@webhook-portal/canonical-model",
  "@webhook-portal/contract-core",
  "@webhook-portal/signing",
  "@webhook-portal/adapter-sdk",
  "@webhook-portal/adapter-conformance",
  "@webhook-portal/adapter-generic-http",
  "@webhook-portal/extension-sdk",
  "@webhook-portal/extension-sdk/transform",
  "@webhook-portal/extension-conformance",
  "@webhook-portal/extension-conformance/runner",
  "@webhook-portal/compatibility-report",
  "@webhook-portal/migration-assessment",
  "@webhook-portal/support-evidence",
  "@webhook-portal/portal-components",
  "@webhook-portal/reference-server-core",
  "@webhook-portal/cli",
  "@webhook-portal/cli/reference-server",
];

function step(message) {
  process.stdout.write(`\n→ ${message}\n`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: options.quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", () => resolve({ code: -1, stdout, stderr }));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function ensureVerdaccioInstalled() {
  const binary = path.join(runtimeDir, "node_modules", ".bin", "verdaccio");
  if (await pathExists(binary)) return binary;
  step("Installing Verdaccio into the isolated runtime (first run only)");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "verdaccio-runtime", private: true }, null, 2)}\n`,
  );
  await run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-save", "verdaccio@^6"],
    { cwd: runtimeDir, quiet: true },
  );
  return binary;
}

async function writeVerdaccioConfig() {
  // $authenticated publish means only a token-holder can publish; access stays
  // open so the consumer can install. Non-cohort packages proxy npmjs so the
  // consumer can resolve external runtime dependencies (fastify, pg, ...).
  const config = `storage: ./storage
auth:
  htpasswd:
    file: ./htpasswd
    max_users: 1000
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    cache: true
    maxage: 30m
packages:
  "@webhook-portal/*":
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  "@*/*":
    access: $all
    publish: $authenticated
    proxy: npmjs
  "**":
    access: $all
    publish: $authenticated
    proxy: npmjs
log:
  type: stdout
  format: pretty
  level: warn
`;
  await writeFile(configPath, config);
}

async function startVerdaccio(binary, port) {
  // Verdaccio 6's file logger prevents startup, so it logs to stdout, which we
  // capture to a session log file for post-mortem without keeping a console open.
  const logFile = await open(logPath, "a");
  const child = spawn(
    binary,
    ["--config", configPath, "--listen", `http://127.0.0.1:${port}`],
    { cwd: sessionDir, stdio: ["ignore", logFile.fd, logFile.fd] },
  );
  child.once("exit", () => logFile.close().catch(() => {}));
  child.once("error", (error) => {
    process.stderr.write(`verdaccio failed to start: ${error.message}\n`);
  });
  return child;
}

async function readLogTail() {
  try {
    const text = await readFile(logPath, "utf8");
    const lines = text.trimEnd().split("\n");
    return lines.slice(-15).join("\n");
  } catch {
    return "(no verdaccio log captured)";
  }
}

// A cold first start (right after installing Verdaccio) can take much longer
// than a warm one, so the readiness window is generous. If the process exits or
// the window elapses, the captured log tail is surfaced for diagnosis.
async function waitForRegistry(registry, child, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Verdaccio exited during startup (code ${child.exitCode}, signal ${child.signalCode}).\n${await readLogTail()}`,
      );
    }
    try {
      const response = await fetch(`${registry}-/ping`);
      if (response.ok) return;
    } catch {
      // Not up yet; keep polling.
    }
    await sleep(300);
  }
  throw new Error(
    `Verdaccio did not become ready at ${registry} within ${timeoutMs / 1000}s.\n${await readLogTail()}`,
  );
}

async function mintToken(registry) {
  // Create a throwaway user and return its registry token. The password is a
  // local-only literal; the token is never persisted outside the git-ignored
  // work directory.
  const response = await fetch(`${registry}-/user/org.couchdb.user:harness`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "harness",
      password: "local-throwaway-only",
    }),
  });
  if (!response.ok) {
    throw new Error(`could not create local registry user: ${response.status}`);
  }
  const body = await response.json();
  if (!body.token) throw new Error("local registry did not return a token");
  return body.token;
}

async function packCohort(manifest) {
  await mkdir(tarballDir, { recursive: true });
  const tarballs = new Map();
  for (const entry of manifest.openPackages) {
    const destination = path.join(tarballDir, path.basename(entry.path));
    await mkdir(destination, { recursive: true });
    await run("pnpm", ["pack", "--pack-destination", destination], {
      cwd: path.join(root, entry.path),
      quiet: true,
    });
    const produced = (await readdir(destination)).filter((name) =>
      name.endsWith(".tgz"),
    );
    if (produced.length !== 1) {
      throw new Error(
        `expected one tarball for ${entry.name}, found ${produced.length}`,
      );
    }
    tarballs.set(entry.name, path.join(destination, produced[0]));
  }
  return tarballs;
}

async function isPublished(name, version, registry) {
  const result = await capture("npm", [
    "view",
    `${name}@${version}`,
    "version",
    "--registry",
    registry,
  ]);
  return result.code === 0 && result.stdout.trim() === version;
}

async function publishCohort(manifest, tarballs, registry) {
  const order = topologicalOrder(await internalDependencyGraph(manifest));
  const entriesByName = new Map(
    manifest.openPackages.map((entry) => [entry.name, entry]),
  );
  for (const name of order) {
    const entry = entriesByName.get(name);
    if (await isPublished(name, entry.version, registry)) {
      process.stdout.write(
        `  skip ${name}@${entry.version} (already present)\n`,
      );
      continue;
    }
    process.stdout.write(`  publish ${name}@${entry.version}\n`);
    await run(
      "npm",
      [
        "publish",
        tarballs.get(name),
        "--registry",
        registry,
        "--userconfig",
        npmrcPath,
        "--loglevel",
        "warn",
      ],
      { quiet: true },
    );
  }
}

async function verifyConsumer(manifest, registry) {
  await mkdir(consumerDir, { recursive: true });
  await writeFile(path.join(consumerDir, ".npmrc"), `registry=${registry}\n`);
  await writeFile(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "verdaccio-consumer", private: true }, null, 2)}\n`,
  );

  step("Installing the entire cohort by name from the local registry");
  const cohortSpecs = manifest.openPackages.map((entry) => entry.name);
  await run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--registry",
      registry,
      ...cohortSpecs,
    ],
    { cwd: consumerDir },
  );

  step("Importing every published entry point");
  const importScript = `${entryPoints
    .map(
      (entryPoint) =>
        `{ const m = await import(${JSON.stringify(entryPoint)}); if (m === undefined) throw new Error("failed to import ${entryPoint}"); console.log("  imported ${entryPoint}"); }`,
    )
    .join("\n")}`;
  await run("node", ["--input-type=module", "-e", importScript], {
    cwd: consumerDir,
  });

  step("Invoking the packed CLI binary");
  const help = await capture(
    path.join(consumerDir, "node_modules", ".bin", "webhook-portal"),
    ["--help"],
    { cwd: consumerDir },
  );
  if (!help.stdout.includes("Usage: webhook-portal <command> [options]")) {
    throw new Error(
      `packed CLI did not return expected help output (exit ${help.code})`,
    );
  }
  process.stdout.write("  invoked webhook-portal --help\n");
}

async function stopVerdaccio(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function main() {
  // Preserve the persistent runtime install; only reset the per-run session.
  await rm(sessionDir, { recursive: true, force: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });

  step("Building the workspace so packed tarballs contain dist output");
  await run("pnpm", ["build"], { quiet: true });

  const binary = await ensureVerdaccioInstalled();
  await writeVerdaccioConfig();
  const port = await findFreePort();
  const registry = `http://127.0.0.1:${port}/`;

  let child;
  const onSignal = () => {
    stopVerdaccio(child).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    step(`Starting throwaway Verdaccio at ${registry}`);
    child = await startVerdaccio(binary, port);
    await waitForRegistry(registry, child);

    const token = await mintToken(registry);
    await writeFile(
      npmrcPath,
      `registry=${registry}\n//127.0.0.1:${port}/:_authToken=${token}\n`,
    );

    const manifest = await loadManifest();

    step("Packing the cohort");
    const tarballs = await packCohort(manifest);

    step("Publishing the cohort to the local registry in dependency order");
    await publishCohort(manifest, tarballs, registry);

    await verifyConsumer(manifest, registry);

    process.stdout.write(
      `\n✓ Verdaccio harness passed: published ${manifest.openPackages.length} packages and installed, imported, and invoked them from a clean consumer.\n`,
    );
  } finally {
    await stopVerdaccio(child);
    await rm(sessionDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `\n✗ Verdaccio harness failed: ${error.message ?? error}\n`,
  );
  if (error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
