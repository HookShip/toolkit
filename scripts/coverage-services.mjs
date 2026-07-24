// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Runs a command with disposable Postgres + MinIO containers so the reference
 * server integration suite (Postgres repositories, MinIO payload storage)
 * executes under coverage. Containers are named, force-recreated, and removed
 * on exit. If `TEST_DATABASE_URL` is already set, the caller-provided services
 * are used unchanged and no containers are managed.
 *
 * Usage: node scripts/coverage-services.mjs -- <command> [args...]
 */

const POSTGRES_IMAGE = "postgres:17.5-alpine";
const MINIO_IMAGE = "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z";
const PG_CONTAINER = "toolkit-coverage-postgres";
const MINIO_CONTAINER = "toolkit-coverage-minio";
const PG_PORT = 5433;
const MINIO_PORT = 9100;
const PG_USER = "reference";
const PG_PASSWORD = "reference";
const PG_DB = "reference";
const MINIO_ACCESS_KEY = "minioadmin";
const MINIO_SECRET_KEY = "minioadminsecret";

function docker(args, { capture = false } = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return result;
}

function dockerAvailable() {
  const version = docker(["version", "--format", "{{.Server.Version}}"], {
    capture: true,
  });
  return version.status === 0;
}

function removeContainer(name) {
  docker(["rm", "-f", name], { capture: true });
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = docker(
      ["exec", PG_CONTAINER, "pg_isready", "-U", PG_USER, "-d", PG_DB],
      { capture: true },
    );
    if (ready.status === 0) return;
    await delay(1000);
  }
  throw new Error("Postgres did not become ready within 60s");
}

async function waitForMinio() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${MINIO_PORT}/minio/health/live`,
      );
      if (response.ok) return;
    } catch {
      // MinIO is not accepting connections yet.
    }
    await delay(1000);
  }
  throw new Error("MinIO did not become ready within 60s");
}

async function startServices() {
  removeContainer(PG_CONTAINER);
  removeContainer(MINIO_CONTAINER);
  const pg = docker([
    "run",
    "-d",
    "--name",
    PG_CONTAINER,
    "-e",
    `POSTGRES_DB=${PG_DB}`,
    "-e",
    `POSTGRES_USER=${PG_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    "-p",
    `${PG_PORT}:5432`,
    POSTGRES_IMAGE,
  ]);
  if (pg.status !== 0) throw new Error("failed to start Postgres container");
  const minio = docker([
    "run",
    "-d",
    "--name",
    MINIO_CONTAINER,
    "-e",
    `MINIO_ROOT_USER=${MINIO_ACCESS_KEY}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${MINIO_SECRET_KEY}`,
    "-p",
    `${MINIO_PORT}:9000`,
    MINIO_IMAGE,
    "server",
    "/data",
  ]);
  if (minio.status !== 0) throw new Error("failed to start MinIO container");
  await Promise.all([waitForPostgres(), waitForMinio()]);
}

function stopServices() {
  removeContainer(PG_CONTAINER);
  removeContainer(MINIO_CONTAINER);
}

function runCommand(command, args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const separator = process.argv.indexOf("--");
  const command =
    separator === -1
      ? ["node", "scripts/test-coverage.mjs"]
      : process.argv.slice(separator + 1);
  if (command.length === 0) {
    throw new Error("no command provided after --");
  }

  if (process.env["TEST_DATABASE_URL"]) {
    console.error(
      "Using caller-provided TEST_DATABASE_URL; not managing containers.",
    );
    const code = await runCommand(command[0], command.slice(1), {});
    process.exit(code);
  }

  if (!dockerAvailable()) {
    console.error(
      "Docker is required to run the reference-server integration coverage.",
    );
    process.exit(1);
  }

  const env = {
    TEST_DATABASE_URL: `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}`,
    TEST_MINIO_ENDPOINT: "127.0.0.1",
    TEST_MINIO_PORT: String(MINIO_PORT),
    TEST_MINIO_ACCESS_KEY: MINIO_ACCESS_KEY,
    TEST_MINIO_SECRET_KEY: MINIO_SECRET_KEY,
    TEST_MINIO_USE_SSL: "false",
  };

  try {
    console.error("Starting disposable Postgres + MinIO for coverage ...");
    await startServices();
    process.exitCode = await runCommand(command[0], command.slice(1), env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    stopServices();
  }
  process.exit(process.exitCode ?? 0);
}

process.on("SIGINT", () => {
  stopServices();
  process.exit(130);
});

await main();
