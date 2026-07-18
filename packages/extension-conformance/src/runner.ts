// SPDX-License-Identifier: Apache-2.0

export const CONFORMANCE_CATEGORIES = [
  "bundle",
  "compatibility",
  "determinism",
  "malicious-corpus",
  "manifest",
  "permissions",
  "transformer-policy",
] as const;
export type ConformanceCategory = (typeof CONFORMANCE_CATEGORIES)[number];

export interface ExtensionConformanceCase {
  readonly category: ConformanceCategory;
  readonly id: string;
  readonly name: string;
  run(): Promise<void> | void;
}

export interface ExtensionConformanceCaseResult {
  readonly category: ConformanceCategory;
  readonly id: string;
  readonly message?: string;
  readonly name: string;
  readonly status: "failed" | "passed";
}

export interface ExtensionConformanceReport {
  readonly failed: number;
  readonly name: string;
  readonly passed: boolean;
  readonly results: readonly ExtensionConformanceCaseResult[];
  readonly succeeded: number;
}

export interface ConformanceTestRunner {
  describe(name: string, body: () => void): void;
  test(name: string, body: () => Promise<void> | void): void;
}

export class ExtensionConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionConformanceError";
  }
}

export function ensureConformance(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new ExtensionConformanceError(message);
  }
}

function failureMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return "Conformance case failed with a non-Error value.";
}

export async function runConformanceCases(
  name: string,
  cases: readonly ExtensionConformanceCase[],
): Promise<ExtensionConformanceReport> {
  const results: ExtensionConformanceCaseResult[] = [];
  const ids = new Set<string>();
  for (const candidate of cases) {
    if (ids.has(candidate.id)) {
      throw new ExtensionConformanceError(
        `Duplicate conformance case ID ${candidate.id}.`,
      );
    }
    ids.add(candidate.id);
    try {
      await candidate.run();
      results.push(
        Object.freeze({
          id: candidate.id,
          name: candidate.name,
          category: candidate.category,
          status: "passed" as const,
        }),
      );
    } catch (cause) {
      results.push(
        Object.freeze({
          id: candidate.id,
          name: candidate.name,
          category: candidate.category,
          status: "failed" as const,
          message: failureMessage(cause),
        }),
      );
    }
  }
  const failed = results.filter((result) => result.status === "failed").length;
  return Object.freeze({
    name,
    passed: failed === 0,
    failed,
    succeeded: results.length - failed,
    results: Object.freeze(results),
  });
}

export function assertExtensionConformance(
  report: ExtensionConformanceReport,
): void {
  if (report.passed) {
    return;
  }
  const failures = report.results
    .filter((result) => result.status === "failed")
    .map((result) => `${result.id}: ${result.message ?? "failed"}`)
    .join("; ");
  throw new ExtensionConformanceError(
    `${report.name} failed ${report.failed} conformance case(s): ${failures}`,
  );
}

export function registerConformanceCases(
  runner: ConformanceTestRunner,
  name: string,
  cases: readonly ExtensionConformanceCase[],
): void {
  runner.describe(name, () => {
    for (const candidate of cases) {
      runner.test(
        `[${candidate.category}] ${candidate.name}`,
        async (): Promise<void> => {
          await candidate.run();
        },
      );
    }
  });
}
