// SPDX-License-Identifier: Apache-2.0

import {
  diff,
  fixtures,
  types,
  type ContractImportResult,
} from "@webhook-portal/contract-core";

import {
  booleanOption,
  integerOption,
  parseCommandArguments,
  stringOption,
} from "./arguments.js";
import {
  CliCommandError,
  commandOutput,
  ensurePositionals,
  optionSpec,
  type CliDependencies,
} from "./command-support.js";
import { CLI_EXIT_CODES, type CliExitCode } from "./exit-codes.js";
import { assertSingleStdinConsumer } from "./io.js";
import { emitSuccess } from "./output.js";
import {
  readContract,
  requireValidContract,
  selectEventVersion,
  writeOrEmit,
} from "./command-helpers.js";

function statusExit(result: ContractImportResult): CliExitCode {
  if (result.status === "invalid") {
    return CLI_EXIT_CODES.invalid;
  }
  if (result.status === "partial") {
    return CLI_EXIT_CODES.partial;
  }
  return CLI_EXIT_CODES.success;
}

export async function validateCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args);
  ensurePositionals(parsed.positionals, 1);
  const { result } = await readContract(parsed.positionals[0]!, dependencies);
  const exitCode = statusExit(result);
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    {
      command: "validate",
      status: result.status,
      supported: result.parsed.supported,
      format: result.parsed.format,
      specificationVersion: result.parsed.specificationVersion,
      sourceChecksum: result.parsed.sourceChecksum,
      canonicalChecksum: result.contract?.checksum,
      diagnostics: result.diagnostics,
    },
    [
      `Contract status: ${result.status}`,
      `Supported: ${String(result.parsed.supported)}`,
      `Diagnostics: ${result.diagnostics.length}`,
      ...(result.contract === undefined
        ? []
        : [`Canonical checksum: ${result.contract.checksum.value}`]),
    ],
  );
  return exitCode;
}

export async function importCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(
    args,
    optionSpec({ out: { type: "string", short: "o" } }),
  );
  ensurePositionals(parsed.positionals, 1);
  const input = parsed.positionals[0]!;
  const { result } = await readContract(input, dependencies);
  const exitCode = statusExit(result);
  if (result.export === undefined) {
    emitSuccess(
      commandOutput(dependencies, booleanOption(parsed.values, "json")),
      {
        command: "import",
        status: result.status,
        diagnostics: result.diagnostics,
      },
      [
        `Import status: ${result.status}`,
        `Diagnostics: ${result.diagnostics.length}`,
      ],
    );
    return exitCode;
  }
  const outputPath =
    stringOption(parsed.values, "out") ??
    (input === "-" ? undefined : `${input}.canonical.json`);
  if (input === "-" && outputPath === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "OUTPUT_REQUIRED",
      "Importing from stdin requires --out.",
    );
  }
  await writeOrEmit(
    dependencies,
    booleanOption(parsed.values, "json"),
    outputPath,
    `${JSON.stringify(result.export, null, 2)}\n`,
    {
      command: "import",
      status: result.status,
      canonicalChecksum: result.contract?.checksum.value,
      diagnostics: result.diagnostics,
    },
    [`Import status: ${result.status}`],
  );
  return exitCode;
}

export async function diffCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    "max-changes": { type: "string" },
  });
  ensurePositionals(parsed.positionals, 2);
  assertSingleStdinConsumer(
    parsed.positionals.map((input, index) => ({
      name: `contract ${index + 1}`,
      usesStdin: input === "-",
    })),
  );
  const previous = requireValidContract(
    (await readContract(parsed.positionals[0]!, dependencies)).result,
  );
  const next = requireValidContract(
    (await readContract(parsed.positionals[1]!, dependencies)).result,
  );
  const result = diff(previous, next, {
    maxChanges: integerOption(parsed.values, "max-changes", 1000, 1, 10_000),
  });
  emitSuccess(
    commandOutput(dependencies, booleanOption(parsed.values, "json")),
    { command: "diff", ...result },
    [
      `Compatibility: ${result.status}`,
      result.summary,
      `Changes: ${result.changes.length}`,
    ],
  );
  return result.status === "breaking" || result.status === "unknown"
    ? CLI_EXIT_CODES.incompatible
    : CLI_EXIT_CODES.success;
}

export async function fixtureCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    event: { type: "string" },
    version: { type: "string" },
    out: { type: "string", short: "o" },
    "include-optional": { type: "boolean" },
    "max-depth": { type: "string" },
    "max-array-items": { type: "string" },
  });
  ensurePositionals(parsed.positionals, 1);
  const eventName = stringOption(parsed.values, "event");
  if (eventName === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "EVENT_REQUIRED",
      "--event is required.",
    );
  }
  const contract = requireValidContract(
    (await readContract(parsed.positionals[0]!, dependencies)).result,
  );
  const version = selectEventVersion(
    contract,
    eventName,
    stringOption(parsed.values, "version"),
  );
  const generated = fixtures(version.schema.value, {
    includeOptionalProperties: booleanOption(parsed.values, "include-optional"),
    maxDepth: integerOption(parsed.values, "max-depth", 32, 1, 128),
    maxArrayItems: integerOption(parsed.values, "max-array-items", 3, 0, 100),
  });
  if (generated.value === undefined) {
    emitSuccess(
      commandOutput(dependencies, booleanOption(parsed.values, "json")),
      { command: "fixture", ...generated },
      [`Fixture status: ${generated.status}`],
    );
    return generated.status === "unsupported"
      ? CLI_EXIT_CODES.partial
      : CLI_EXIT_CODES.invalid;
  }
  await writeOrEmit(
    dependencies,
    booleanOption(parsed.values, "json"),
    stringOption(parsed.values, "out"),
    `${JSON.stringify(generated.value, null, 2)}\n`,
    { command: "fixture", ...generated },
    [`Fixture status: ${generated.status}`],
  );
  return generated.status === "generated"
    ? CLI_EXIT_CODES.success
    : CLI_EXIT_CODES.partial;
}

export async function typesCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseCommandArguments(args, {
    event: { type: "string" },
    version: { type: "string" },
    out: { type: "string", short: "o" },
    name: { type: "string" },
    "max-depth": { type: "string" },
    "no-export": { type: "boolean" },
  });
  ensurePositionals(parsed.positionals, 1);
  const eventName = stringOption(parsed.values, "event");
  if (eventName === undefined) {
    throw new CliCommandError(
      CLI_EXIT_CODES.usage,
      "EVENT_REQUIRED",
      "--event is required.",
    );
  }
  const contract = requireValidContract(
    (await readContract(parsed.positionals[0]!, dependencies)).result,
  );
  const version = selectEventVersion(
    contract,
    eventName,
    stringOption(parsed.values, "version"),
  );
  const generated = types(version.schema.value, {
    typeName: stringOption(parsed.values, "name") ?? eventName,
    maxDepth: integerOption(parsed.values, "max-depth", 32, 1, 128),
    exportType: !booleanOption(parsed.values, "no-export"),
  });
  await writeOrEmit(
    dependencies,
    booleanOption(parsed.values, "json"),
    stringOption(parsed.values, "out"),
    generated.code,
    { command: "types", ...generated },
    [`Type generation status: ${generated.status}`],
  );
  return generated.status === "generated"
    ? CLI_EXIT_CODES.success
    : CLI_EXIT_CODES.partial;
}
