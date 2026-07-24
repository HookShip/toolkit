// SPDX-License-Identifier: Apache-2.0

import {
  createCompatibilityReport,
  renderCompatibilityReportJson,
  renderCompatibilityReportMarkdown,
  type ReportView,
} from "@webhook-portal/compatibility-report";

import {
  booleanOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import { ensurePositionals, type CliDependencies } from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import { assertSingleStdinConsumer } from "./io.js";
import {
  artifactFormat,
  emitArtifact,
  enumOption,
  readExactContract,
} from "./learning-support.js";

export async function compatibilityReportCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    format: { type: "string" },
    audience: { type: "string" },
    out: { type: "string", short: "o" },
    "allow-breaking": { type: "boolean" },
  });
  ensurePositionals(parsed.positionals, 2);
  assertSingleStdinConsumer(
    parsed.positionals.map((input, index) => ({
      name: index === 0 ? "previous contract" : "next contract",
      usesStdin: input === "-",
    })),
  );
  const format = artifactFormat(parsed.values, "markdown");
  const audience = enumOption(
    parsed.values,
    "audience",
    ["producer", "consumer"],
    "producer",
  );
  const previous = await readExactContract(
    parsed.positionals[0]!,
    dependencies,
  );
  const next = await readExactContract(parsed.positionals[1]!, dependencies);
  const report = createCompatibilityReport(previous, next, {
    view:
      stringOption(parsed.values, "audience") === undefined
        ? "combined"
        : (audience as ReportView),
  });
  const content =
    format === "json"
      ? `${renderCompatibilityReportJson(report)}\n`
      : renderCompatibilityReportMarkdown(report);
  const outputPath = stringOption(parsed.values, "out");
  await emitArtifact(dependencies, {
    content,
    envelope: {
      command: "compatibility-report",
      format,
      status: report.status,
      audience: report.view,
      report,
    },
    humanSummary: [
      `Compatibility: ${report.status}`,
      `Decision: ${report.decision}`,
    ],
    json: booleanOption(parsed.values, "json"),
    ...(outputPath === undefined ? {} : { outputPath }),
  });
  if (
    report.status === "unknown" ||
    (report.status === "breaking" &&
      !booleanOption(parsed.values, "allow-breaking"))
  ) {
    return CLI_EXIT_CODES.incompatible;
  }
  return CLI_EXIT_CODES.success;
}
