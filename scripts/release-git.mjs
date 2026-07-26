// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import { root } from "./release-context.mjs";

export function capture(command, args) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: root,
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

export async function gitValue(args) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("exit", (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

export async function requireCleanTree(action) {
  const status = await gitValue(["status", "--porcelain"]);
  if (status === null) {
    throw new Error(`cannot ${action}: unable to read git status`);
  }
  if (status.trim() !== "") {
    throw new Error(
      `cannot ${action}: refusing to ${action} from a dirty tree`,
    );
  }
}

export async function verifyReleaseTag(tag) {
  const failures = [];
  const type = (await capture("git", ["cat-file", "-t", tag])).stdout.trim();
  if (type !== "tag") {
    failures.push(
      `tag ${tag} must be an annotated or signed tag (found ${type || "no tag object"})`,
    );
    return { failures, signed: false };
  }
  const contents = await capture("git", ["cat-file", "-p", tag]);
  const signed = contents.stdout.includes("-----BEGIN PGP SIGNATURE-----");
  const tagCommit = (
    await capture("git", ["rev-parse", `${tag}^{commit}`])
  ).stdout.trim();
  const head = (
    await capture("git", ["rev-parse", "HEAD^{commit}"])
  ).stdout.trim();
  if (tagCommit === "" || head === "" || tagCommit !== head) {
    failures.push(`tag ${tag} must point at the commit being published (HEAD)`);
  }
  return { failures, signed };
}
