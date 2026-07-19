// SPDX-License-Identifier: Apache-2.0

const sourceInclude = ["src/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}"];
const serialVitestArgs = ["--maxWorkers=1", "--fileParallelism=false"];
const measuredBaselines = {
  "@webhook-portal/reference-server": {
    branches: 0,
    functions: 100,
    lines: 0,
    statements: 0,
  },
  "@webhook-portal/adapter-conformance": {
    branches: 76.14,
    functions: 96.36,
    lines: 84.94,
    statements: 85.12,
  },
  "@webhook-portal/adapter-generic-http": {
    branches: 70.13,
    functions: 93.37,
    lines: 81.47,
    statements: 81.44,
  },
  "@webhook-portal/adapter-sdk": {
    branches: 77.76,
    functions: 87.32,
    lines: 82.33,
    statements: 82.19,
  },
  "@webhook-portal/canonical-model": {
    branches: 62.21,
    functions: 73.91,
    lines: 85.54,
    statements: 85.71,
  },
  "@webhook-portal/cli": {
    branches: 48.17,
    functions: 60.81,
    lines: 56.89,
    statements: 56.79,
  },
  "@webhook-portal/compatibility-report": {
    branches: 86.36,
    functions: 96,
    lines: 92.78,
    statements: 92.61,
  },
  "@webhook-portal/contract-core": {
    branches: 73.76,
    functions: 91.64,
    lines: 83.78,
    statements: 82.79,
  },
  "@webhook-portal/extension-conformance": {
    branches: 80.23,
    functions: 91.07,
    lines: 94.69,
    statements: 94.84,
  },
  "@webhook-portal/extension-sdk": {
    branches: 68.91,
    functions: 91.07,
    lines: 79.6,
    statements: 79.79,
  },
  "@webhook-portal/migration-assessment": {
    branches: 74.78,
    functions: 96.52,
    lines: 86.03,
    statements: 86.25,
  },
  "@webhook-portal/portal-components": {
    branches: 63.81,
    functions: 88.78,
    lines: 79,
    statements: 79.65,
  },
  "@webhook-portal/signing": {
    branches: 85.8,
    functions: 92.06,
    lines: 90.95,
    statements: 90.59,
  },
  "@webhook-portal/support-evidence": {
    branches: 75.05,
    functions: 92.38,
    lines: 82.17,
    statements: 82.34,
  },
};

function thresholdsFor(baseline) {
  return Object.fromEntries(
    Object.entries(baseline).map(([metric, value]) => [
      metric,
      Math.floor(value),
    ]),
  );
}

function project(name, directory, options = {}) {
  const baseline = measuredBaselines[name];
  if (baseline === undefined) {
    throw new Error(`Missing measured coverage baseline for ${name}`);
  }
  return {
    name,
    directory,
    include: options.include ?? sourceInclude,
    vitestArgs: [...serialVitestArgs, ...(options.vitestArgs ?? [])],
    testExclusions: options.testExclusions ?? [],
    coverageException: options.coverageException,
    baseline,
    thresholds: {
      ...thresholdsFor(baseline),
      ...(options.thresholds ?? {}),
    },
  };
}

export const coverageExclude = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*.{test,spec}.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
  "**/coverage/**",
  "**/dist/**",
  "**/.next/**",
  "**/generated/**",
  "**/*.generated.*",
  "**/*.config.*",
  "**/node_modules/**",
  "**/*.d.ts",
];

export const coverageProjects = [
  project("@webhook-portal/reference-server", "apps/reference-server", {
    coverageException:
      "This private Apache-2.0 app is a thin process and migration wrapper around the tested @webhook-portal/cli reference-server implementation. Its entry-point scaffolds are exercised by smoke and Compose validation.",
  }),
  project(
    "@webhook-portal/adapter-conformance",
    "packages/adapter-conformance",
  ),
  project(
    "@webhook-portal/adapter-generic-http",
    "packages/adapter-generic-http",
  ),
  project("@webhook-portal/adapter-sdk", "packages/adapter-sdk"),
  project("@webhook-portal/canonical-model", "packages/canonical-model"),
  project("@webhook-portal/cli", "packages/cli"),
  project(
    "@webhook-portal/compatibility-report",
    "packages/compatibility-report",
  ),
  project("@webhook-portal/contract-core", "packages/contract-core", {
    vitestArgs: [
      "--testNamePattern=^(?!.*indexes many anchors once under shared timing and work budgets).*$",
    ],
    testExclusions: [
      {
        test: "parser resource and object safety > indexes many anchors once under shared timing and work budgets",
        reason:
          "V8 instrumentation invalidates this test's five-second local wall-clock budget; pnpm test still runs and gates it without instrumentation.",
      },
    ],
  }),
  project(
    "@webhook-portal/extension-conformance",
    "packages/extension-conformance",
  ),
  project("@webhook-portal/extension-sdk", "packages/extension-sdk"),
  project(
    "@webhook-portal/migration-assessment",
    "packages/migration-assessment",
  ),
  project("@webhook-portal/portal-components", "packages/portal-components", {
    // The displayed 79.00% baseline is 78.995% before rounding.
    thresholds: { lines: 78 },
  }),
  project("@webhook-portal/signing", "packages/signing"),
  project("@webhook-portal/support-evidence", "packages/support-evidence"),
];

// A future app/package without a Vitest suite must be listed here with a
// concrete reason. An empty list means every current workspace is covered.
export const workspaceCoverageExclusions = [];

export const aggregateBaseline = {
  branches: 65.7,
  functions: 80.98,
  lines: 74.73,
  statements: 74.61,
};
export const aggregateThresholds = thresholdsFor(aggregateBaseline);

export const nonVitestCoverageScopes = [
  {
    directory: "extensions",
    reason:
      "The seed-pack Node test validates generated and signed data artifacts rather than an instrumentable workspace runtime.",
  },
  {
    directory: "scripts",
    reason:
      "Repository policy scripts are exercised by Node's native test runner and direct validation commands.",
  },
];
