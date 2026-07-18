// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateBaseline,
  aggregateThresholds,
  coverageExclude,
  coverageProjects,
  nonVitestCoverageScopes,
  workspaceCoverageExclusions,
} from "./coverage.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coverageRoot = path.join(root, "coverage");
const packageReportsRoot = path.join(coverageRoot, "packages");
const metrics = ["lines", "statements", "functions", "branches"];

function selectedProjects() {
  const argumentIndex = process.argv.indexOf("--project");
  if (argumentIndex === -1) return coverageProjects;
  const selector = process.argv[argumentIndex + 1];
  if (selector === undefined || selector.startsWith("--")) {
    throw new Error("--project requires a package name or workspace directory");
  }
  const project = coverageProjects.find(
    (candidate) =>
      candidate.name === selector || candidate.directory === selector,
  );
  if (project === undefined) {
    throw new Error(`Unknown coverage project: ${selector}`);
  }
  return [project];
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function portablePath(file) {
  return file.split(path.sep).join("/");
}

async function validateWorkspaceCoverageList() {
  const configured = new Set(
    coverageProjects.map((project) => project.directory),
  );
  const excluded = new Map(
    workspaceCoverageExclusions.map((entry) => [entry.directory, entry.reason]),
  );
  const discovered = [];

  for (const area of ["apps", "packages"]) {
    const areaRoot = path.join(root, area);
    for (const entry of await readdir(areaRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${area}/${entry.name}`;
      const manifestPath = path.join(areaRoot, entry.name, "package.json");
      if (!(await exists(manifestPath))) continue;
      const manifest = await readJson(manifestPath);
      if (/\bvitest\b/.test(manifest.scripts?.test ?? "")) {
        const expectedCoverageScript = `node ../../scripts/test-coverage.mjs --project ${directory}`;
        if (manifest.scripts?.["test:coverage"] !== expectedCoverageScript) {
          throw new Error(
            `${directory} must define test:coverage as "${expectedCoverageScript}"`,
          );
        }
        discovered.push(directory);
      } else if (!excluded.has(directory)) {
        throw new Error(
          `${directory} has no Vitest coverage project and no documented exclusion`,
        );
      }
    }
  }

  const missing = discovered.filter((directory) => !configured.has(directory));
  const stale = [...configured].filter(
    (directory) => !discovered.includes(directory),
  );
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      [
        missing.length > 0
          ? `unconfigured Vitest workspaces: ${missing.join(", ")}`
          : undefined,
        stale.length > 0
          ? `configured projects without a Vitest test script: ${stale.join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
}

function metricSummary(values) {
  const total = values.length;
  const covered = values.filter((value) => value > 0).length;
  return {
    total,
    covered,
    skipped: 0,
    pct: total === 0 ? 100 : (covered / total) * 100,
  };
}

function coverageSummary(coverageMap) {
  const statementValues = [];
  const functionValues = [];
  const branchValues = [];
  const lineValues = [];

  for (const coverage of Object.values(coverageMap)) {
    statementValues.push(...Object.values(coverage.s));
    functionValues.push(...Object.values(coverage.f));
    branchValues.push(...Object.values(coverage.b).flat());

    const lines = new Map();
    for (const [statementId, count] of Object.entries(coverage.s)) {
      const line = coverage.statementMap[statementId]?.start?.line;
      if (line === undefined) continue;
      lines.set(line, Math.max(lines.get(line) ?? 0, count));
    }
    lineValues.push(...lines.values());
  }

  return {
    lines: metricSummary(lineValues),
    statements: metricSummary(statementValues),
    functions: metricSummary(functionValues),
    branches: metricSummary(branchValues),
  };
}

function roundPercentage(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function serializableSummary(summary) {
  return Object.fromEntries(
    metrics.map((metric) => [
      metric,
      {
        ...summary[metric],
        pct: roundPercentage(summary[metric].pct),
      },
    ]),
  );
}

function assertThresholds(label, summary, thresholds) {
  const failures = [];
  for (const metric of metrics) {
    if (summary[metric].pct + Number.EPSILON < thresholds[metric]) {
      failures.push(
        `${metric} ${summary[metric].pct.toFixed(2)}% < ${thresholds[metric].toFixed(2)}%`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`${label} coverage regression: ${failures.join(", ")}`);
  }
}

function rewriteLcov(project, lcov) {
  return lcov
    .split("\n")
    .map((line) => {
      if (line.startsWith("TN:")) return `TN:${project.name}`;
      if (!line.startsWith("SF:")) return line;
      const source = line.slice(3);
      const absolute = path.isAbsolute(source)
        ? source
        : path.join(root, project.directory, source);
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          `${project.name} emitted LCOV outside the repository: ${source}`,
        );
      }
      return `SF:${portablePath(relative)}`;
    })
    .join("\n")
    .trim();
}

async function runProject(project) {
  const reportDirectory = path.join(
    packageReportsRoot,
    project.directory.replaceAll("/", "-"),
  );
  const testReportPath = path.join(reportDirectory, "test-results.json");
  const coveragePath = path.join(reportDirectory, "coverage-final.json");
  const lcovPath = path.join(reportDirectory, "lcov.info");
  await mkdir(reportDirectory, { recursive: true });

  console.log(`\n=== ${project.name} ===`);
  await run("pnpm", [
    "--dir",
    project.directory,
    "exec",
    "vitest",
    "run",
    "--passWithNoTests=false",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${testReportPath}`,
    "--coverage.enabled",
    "--coverage.provider=v8",
    `--coverage.reportsDirectory=${reportDirectory}`,
    "--coverage.reporter=json",
    "--coverage.reporter=lcovonly",
    "--coverage.excludeAfterRemap=true",
    ...project.include.map((pattern) => `--coverage.include=${pattern}`),
    ...coverageExclude.map((pattern) => `--coverage.exclude=${pattern}`),
    ...project.vitestArgs,
  ]);

  for (const file of [testReportPath, coveragePath, lcovPath]) {
    if (!(await exists(file)) || (await stat(file)).size === 0) {
      throw new Error(`${project.name} did not produce ${file}`);
    }
  }

  const testReport = await readJson(testReportPath);
  if (
    !Number.isInteger(testReport.numTotalTests) ||
    testReport.numTotalTests < 1
  ) {
    throw new Error(`${project.name} discovered zero tests`);
  }

  const rawCoverage = await readJson(coveragePath);
  if (Object.keys(rawCoverage).length === 0) {
    throw new Error(`${project.name} produced no coverage files`);
  }
  const summary = coverageSummary(rawCoverage);
  if (summary.statements.total === 0) {
    throw new Error(`${project.name} produced no instrumentable coverage data`);
  }
  assertThresholds(project.name, summary, project.thresholds);

  return {
    project,
    tests: testReport.numTotalTests,
    files: Object.keys(rawCoverage).length,
    rawCoverage,
    summary,
    lcov: rewriteLcov(project, await readFile(lcovPath, "utf8")),
  };
}

function normalizeCoverageMap(result, combinedCoverage) {
  for (const [file, coverage] of Object.entries(result.rawCoverage)) {
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `${result.project.name} emitted coverage outside the repository: ${file}`,
      );
    }
    const normalized = portablePath(relative);
    if (combinedCoverage[normalized] !== undefined) {
      throw new Error(`duplicate aggregate coverage entry: ${normalized}`);
    }
    combinedCoverage[normalized] = {
      ...coverage,
      path: normalized,
    };
  }
}

function formatCell(value, width, alignRight = false) {
  return alignRight ? value.padStart(width) : value.padEnd(width);
}

function formatTable(results, aggregateSummary, aggregateFloors) {
  const rows = results.map((result) => [
    result.project.name,
    String(result.tests),
    String(result.files),
    ...metrics.map(
      (metric) =>
        `${result.summary[metric].pct.toFixed(2)} / ${result.project.thresholds[
          metric
        ].toFixed(2)}`,
    ),
  ]);
  rows.push([
    "TOTAL",
    String(results.reduce((sum, result) => sum + result.tests, 0)),
    String(results.reduce((sum, result) => sum + result.files, 0)),
    ...metrics.map(
      (metric) =>
        `${aggregateSummary[metric].pct.toFixed(2)} / ${aggregateFloors[
          metric
        ].toFixed(2)}`,
    ),
  ]);

  const headers = [
    "Package",
    "Tests",
    "Files",
    "Lines current/floor",
    "Statements current/floor",
    "Functions current/floor",
    "Branches current/floor",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const render = (row) =>
    row
      .map((cell, index) => formatCell(cell, widths[index], index > 0))
      .join(" | ");
  return [render(headers), separator, ...rows.map(render)].join("\n");
}

async function main() {
  await validateWorkspaceCoverageList();
  const projects = selectedProjects();
  if (projects.length === coverageProjects.length) {
    await run("pnpm", ["build"]);
  } else {
    await run("pnpm", ["--filter", `${projects[0].name}...`, "build"]);
  }
  await rm(coverageRoot, { recursive: true, force: true });
  await mkdir(packageReportsRoot, { recursive: true });

  const results = [];
  for (const project of projects) {
    results.push(await runProject(project));
  }

  const combinedCoverage = {};
  for (const result of results) {
    normalizeCoverageMap(result, combinedCoverage);
  }
  const aggregateSummary = coverageSummary(combinedCoverage);
  const baseline =
    projects.length === coverageProjects.length
      ? aggregateBaseline
      : projects[0].baseline;
  const thresholds =
    projects.length === coverageProjects.length
      ? aggregateThresholds
      : projects[0].thresholds;
  assertThresholds("aggregate", aggregateSummary, thresholds);

  const machineSummary = {
    total: serializableSummary(aggregateSummary),
    baseline,
    thresholds,
    packages: Object.fromEntries(
      results.map((result) => [
        result.project.name,
        {
          directory: result.project.directory,
          tests: result.tests,
          files: result.files,
          coverage: serializableSummary(result.summary),
          baseline: result.project.baseline,
          thresholds: result.project.thresholds,
          coverageException: result.project.coverageException,
          testExclusions: result.project.testExclusions,
        },
      ]),
    ),
    excludedScopes: {
      workspaces: workspaceCoverageExclusions,
      nonVitest: nonVitestCoverageScopes,
    },
  };
  const table = formatTable(results, aggregateSummary, thresholds);
  const summaryText = [
    "Repository coverage regression gate",
    "",
    table,
    "",
    "Percentages are shown as current / enforced floor.",
  ].join("\n");

  await writeFile(
    path.join(coverageRoot, "coverage-final.json"),
    `${JSON.stringify(combinedCoverage, null, 2)}\n`,
  );
  await writeFile(
    path.join(coverageRoot, "coverage-summary.json"),
    `${JSON.stringify(machineSummary, null, 2)}\n`,
  );
  await writeFile(
    path.join(coverageRoot, "lcov.info"),
    `${results.map((result) => result.lcov).join("\n")}\n`,
  );
  await writeFile(path.join(coverageRoot, "summary.txt"), `${summaryText}\n`);

  console.log(`\n${summaryText}`);
  console.log(`\nCoverage reports: ${path.relative(root, coverageRoot)}/`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
