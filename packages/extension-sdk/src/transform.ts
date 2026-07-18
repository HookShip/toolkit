// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJson,
  cloneJson,
  compareUtf16CodeUnits,
  type JsonValue,
} from "./canonical.js";
import { DeclarativeRuntimeError } from "./errors.js";
import {
  deleteJsonPointer,
  getJsonPointer,
  normalizeJsonPointer,
  parseJsonPointer,
  setJsonPointer,
} from "./json-pointer.js";
import {
  assertPermissionSetContains,
  normalizePermissionSet,
  type PermissionSet,
} from "./permissions.js";
import {
  expectEnum,
  expectIdentifier,
  expectInteger,
  expectString,
  inspectArray,
  inspectClosedObject,
  inspectRecord,
} from "./validation.js";

export const TRANSFORM_DSL_VERSION = "1.0" as const;

export interface SelectTransformOperation {
  readonly op: "select";
  readonly paths: readonly string[];
}

export interface RenameTransformOperation {
  readonly from: string;
  readonly op: "rename";
  readonly to: string;
}

export interface DropTransformOperation {
  readonly op: "drop";
  readonly paths: readonly string[];
}

export interface SetTransformOperation {
  readonly op: "set";
  readonly path: string;
  readonly value: JsonValue;
}

export interface CoalesceTransformOperation {
  readonly from: readonly string[];
  readonly op: "coalesce";
  readonly to: string;
}

export interface MapEnumTransformOperation {
  readonly default?: JsonValue;
  readonly map: Readonly<Record<string, JsonValue>>;
  readonly op: "map-enum";
  readonly path: string;
}

export interface FormatTransformOperation {
  readonly op: "format";
  readonly template: string;
  readonly to: string;
  readonly variables: Readonly<Record<string, string>>;
}

export type TransformOperation =
  | CoalesceTransformOperation
  | DropTransformOperation
  | FormatTransformOperation
  | MapEnumTransformOperation
  | RenameTransformOperation
  | SelectTransformOperation
  | SetTransformOperation;

export interface TransformProgram {
  readonly operations: readonly TransformOperation[];
  readonly version: typeof TRANSFORM_DSL_VERSION;
}

export interface TransformRuntimeLimits {
  readonly maximumDepth?: number;
  readonly maximumOperations?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumSteps?: number;
  readonly maximumStringLength?: number;
}

export const HARD_TRANSFORM_LIMITS = Object.freeze({
  maximumDepth: 32,
  maximumOperations: 128,
  maximumOutputBytes: 1024 * 1024,
  maximumSteps: 20_000,
  maximumStringLength: 64 * 1024,
});

function boundedLimits(limits: TransformRuntimeLimits = {}) {
  const limit = (
    value: number | undefined,
    hard: number,
    path: string,
  ): number =>
    value === undefined ? hard : expectInteger(value, path, 1, hard);
  return Object.freeze({
    maximumDepth: limit(
      limits.maximumDepth,
      HARD_TRANSFORM_LIMITS.maximumDepth,
      "limits.maximumDepth",
    ),
    maximumOperations: limit(
      limits.maximumOperations,
      HARD_TRANSFORM_LIMITS.maximumOperations,
      "limits.maximumOperations",
    ),
    maximumOutputBytes: limit(
      limits.maximumOutputBytes,
      HARD_TRANSFORM_LIMITS.maximumOutputBytes,
      "limits.maximumOutputBytes",
    ),
    maximumSteps: limit(
      limits.maximumSteps,
      HARD_TRANSFORM_LIMITS.maximumSteps,
      "limits.maximumSteps",
    ),
    maximumStringLength: limit(
      limits.maximumStringLength,
      HARD_TRANSFORM_LIMITS.maximumStringLength,
      "limits.maximumStringLength",
    ),
  });
}

function normalizePaths(
  value: unknown,
  path: string,
  maximumDepth: number,
): readonly string[] {
  const values = inspectArray(value, path, 256).map((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const normalized = normalizeJsonPointer(
      expectString(candidate, itemPath, { maximumLength: 2_048 }),
      itemPath,
    );
    parseJsonPointer(normalized, itemPath, maximumDepth);
    return normalized;
  });
  if (values.length === 0) {
    throw new DeclarativeRuntimeError(
      "EMPTY_PATHS",
      `${path} must contain at least one path.`,
      path,
    );
  }
  return Object.freeze([...new Set(values)].sort(compareUtf16CodeUnits));
}

function validateConstant(
  value: unknown,
  path: string,
  limits: ReturnType<typeof boundedLimits>,
): JsonValue {
  canonicalJson(value as JsonValue, {
    maximumDepth: limits.maximumDepth,
    maximumOutputBytes: limits.maximumOutputBytes,
  });
  return cloneJson(value as JsonValue);
}

function parseOperation(
  value: unknown,
  index: number,
  limits: ReturnType<typeof boundedLimits>,
): TransformOperation {
  const path = `program.operations[${index}]`;
  const header = inspectClosedObject(
    value,
    path,
    ["op"],
    [
      "default",
      "from",
      "map",
      "path",
      "paths",
      "template",
      "to",
      "value",
      "variables",
    ],
  );
  const op = expectEnum(header.op, `${path}.op`, [
    "coalesce",
    "drop",
    "format",
    "map-enum",
    "rename",
    "select",
    "set",
  ] as const);
  switch (op) {
    case "select": {
      const object = inspectClosedObject(value, path, ["op", "paths"]);
      return Object.freeze({
        op,
        paths: normalizePaths(
          object.paths,
          `${path}.paths`,
          limits.maximumDepth,
        ),
      });
    }
    case "drop": {
      const object = inspectClosedObject(value, path, ["op", "paths"]);
      return Object.freeze({
        op,
        paths: normalizePaths(
          object.paths,
          `${path}.paths`,
          limits.maximumDepth,
        ),
      });
    }
    case "rename": {
      const object = inspectClosedObject(value, path, ["op", "from", "to"]);
      const from = normalizeJsonPointer(
        expectString(object.from, `${path}.from`),
        `${path}.from`,
      );
      const to = normalizeJsonPointer(
        expectString(object.to, `${path}.to`),
        `${path}.to`,
      );
      parseJsonPointer(from, `${path}.from`, limits.maximumDepth);
      parseJsonPointer(to, `${path}.to`, limits.maximumDepth);
      if (
        from === to ||
        from.startsWith(`${to}/`) ||
        to.startsWith(`${from}/`)
      ) {
        throw new DeclarativeRuntimeError(
          "OVERLAPPING_POINTERS",
          "Rename source and destination must not overlap.",
          path,
        );
      }
      return Object.freeze({ op, from, to });
    }
    case "set": {
      const object = inspectClosedObject(value, path, ["op", "path", "value"]);
      const target = normalizeJsonPointer(
        expectString(object.path, `${path}.path`),
        `${path}.path`,
      );
      parseJsonPointer(target, `${path}.path`, limits.maximumDepth);
      return Object.freeze({
        op,
        path: target,
        value: validateConstant(object.value, `${path}.value`, limits),
      });
    }
    case "coalesce": {
      const object = inspectClosedObject(value, path, ["op", "from", "to"]);
      const to = normalizeJsonPointer(
        expectString(object.to, `${path}.to`),
        `${path}.to`,
      );
      parseJsonPointer(to, `${path}.to`, limits.maximumDepth);
      return Object.freeze({
        op,
        from: normalizePaths(object.from, `${path}.from`, limits.maximumDepth),
        to,
      });
    }
    case "map-enum": {
      const object = inspectClosedObject(
        value,
        path,
        ["op", "path", "map"],
        ["default"],
      );
      const mappings = inspectRecord(object.map, `${path}.map`, {
        maximumEntries: 256,
      });
      const normalizedMap = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(mappings).sort(compareUtf16CodeUnits)) {
        if (key.length === 0 || key.length > 1_024) {
          throw new DeclarativeRuntimeError(
            "INVALID_ENUM_KEY",
            `${path}.map contains an invalid key.`,
            `${path}.map`,
          );
        }
        normalizedMap[key] = validateConstant(
          mappings[key],
          `${path}.map.${key}`,
          limits,
        );
      }
      const target = normalizeJsonPointer(
        expectString(object.path, `${path}.path`),
        `${path}.path`,
      );
      parseJsonPointer(target, `${path}.path`, limits.maximumDepth);
      return Object.freeze({
        op,
        path: target,
        map: Object.freeze(normalizedMap),
        ...(!Object.hasOwn(object, "default")
          ? {}
          : {
              default: validateConstant(
                object.default,
                `${path}.default`,
                limits,
              ),
            }),
      });
    }
    case "format": {
      const object = inspectClosedObject(value, path, [
        "op",
        "to",
        "template",
        "variables",
      ]);
      const variables = inspectRecord(object.variables, `${path}.variables`, {
        maximumEntries: 128,
      });
      const normalizedVariables = Object.create(null) as Record<string, string>;
      for (const name of Object.keys(variables).sort(compareUtf16CodeUnits)) {
        expectIdentifier(name, `${path}.variables key`, 64);
        const pointer = normalizeJsonPointer(
          expectString(variables[name], `${path}.variables.${name}`),
          `${path}.variables.${name}`,
        );
        parseJsonPointer(
          pointer,
          `${path}.variables.${name}`,
          limits.maximumDepth,
        );
        normalizedVariables[name] = pointer;
      }
      const to = normalizeJsonPointer(
        expectString(object.to, `${path}.to`),
        `${path}.to`,
      );
      parseJsonPointer(to, `${path}.to`, limits.maximumDepth);
      return Object.freeze({
        op,
        to,
        template: expectString(object.template, `${path}.template`, {
          allowEmpty: true,
          maximumLength: limits.maximumStringLength,
        }),
        variables: Object.freeze(normalizedVariables),
      });
    }
  }
}

export function parseTransformProgram(
  value: unknown,
  runtimeLimits: TransformRuntimeLimits = {},
): TransformProgram {
  const limits = boundedLimits(runtimeLimits);
  const object = inspectClosedObject(value, "program", [
    "version",
    "operations",
  ]);
  const version = expectEnum(object.version, "program.version", [
    TRANSFORM_DSL_VERSION,
  ] as const);
  const operations = inspectArray(
    object.operations,
    "program.operations",
    limits.maximumOperations,
  ).map((candidate, index) => parseOperation(candidate, index, limits));
  if (operations.length === 0) {
    throw new DeclarativeRuntimeError(
      "EMPTY_PROGRAM",
      "Transform program must contain at least one operation.",
      "program.operations",
    );
  }
  return Object.freeze({ version, operations: Object.freeze(operations) });
}

export function analyzeTransformPermissions(
  value: unknown,
  limits: TransformRuntimeLimits = {},
): PermissionSet {
  const program = parseTransformProgram(value, limits);
  const read = new Set<string>();
  const write = new Set<string>();
  for (const operation of program.operations) {
    switch (operation.op) {
      case "select":
        operation.paths.forEach((path) => read.add(path));
        write.add("*");
        break;
      case "drop":
        operation.paths.forEach((path) => write.add(path));
        break;
      case "rename":
        read.add(operation.from);
        write.add(operation.from);
        write.add(operation.to);
        break;
      case "set":
        write.add(operation.path);
        break;
      case "coalesce":
        operation.from.forEach((path) => read.add(path));
        write.add(operation.to);
        break;
      case "map-enum":
        read.add(operation.path);
        write.add(operation.path);
        break;
      case "format":
        Object.values(operation.variables).forEach((path) => read.add(path));
        write.add(operation.to);
        break;
    }
  }
  return normalizePermissionSet({
    payloadRead: [...read],
    payloadWrite: [...write],
  });
}

function formatScalar(value: JsonValue, path: string): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value === null ? "" : String(value);
  }
  throw new DeclarativeRuntimeError(
    "FORMAT_NON_SCALAR",
    `Format variable ${path} is not a scalar.`,
    path,
  );
}

function renderTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
  read: (pointer: string) => JsonValue | undefined,
  maximumLength: number,
): string {
  let output = "";
  let cursor = 0;
  while (cursor < template.length) {
    const opening = template.indexOf("{{", cursor);
    if (opening === -1) {
      output += template.slice(cursor);
      break;
    }
    output += template.slice(cursor, opening);
    const closing = template.indexOf("}}", opening + 2);
    if (closing === -1) {
      throw new DeclarativeRuntimeError(
        "MALFORMED_TEMPLATE",
        "Format template contains an unclosed placeholder.",
      );
    }
    const name = template.slice(opening + 2, closing);
    const pointer = variables[name];
    if (pointer === undefined) {
      throw new DeclarativeRuntimeError(
        "UNKNOWN_TEMPLATE_VARIABLE",
        `Format template references unknown variable ${name}.`,
      );
    }
    const value = read(pointer);
    if (value !== undefined) {
      output += formatScalar(value, pointer);
    }
    if (output.length > maximumLength) {
      throw new DeclarativeRuntimeError(
        "STRING_OUTPUT_LIMIT",
        "Formatted string exceeds the runtime limit.",
      );
    }
    cursor = closing + 2;
  }
  if (output.length > maximumLength) {
    throw new DeclarativeRuntimeError(
      "STRING_OUTPUT_LIMIT",
      "Formatted string exceeds the runtime limit.",
    );
  }
  return output;
}

export function runTransform(
  programInput: unknown,
  input: JsonValue,
  options: {
    readonly limits?: TransformRuntimeLimits;
    readonly permissions?: unknown;
  } = {},
): JsonValue {
  const limits = boundedLimits(options.limits);
  const program = parseTransformProgram(programInput, limits);
  const required = analyzeTransformPermissions(program, limits);
  assertPermissionSetContains(
    normalizePermissionSet(options.permissions ?? {}),
    required,
  );
  canonicalJson(input, {
    maximumDepth: limits.maximumDepth,
    maximumOutputBytes: limits.maximumOutputBytes,
  });
  let output = cloneJson(input);
  let steps = 0;
  const tick = (count = 1): void => {
    steps += count;
    if (steps > limits.maximumSteps) {
      throw new DeclarativeRuntimeError(
        "STEP_LIMIT",
        "Transform runtime step limit exceeded.",
      );
    }
  };
  const read = (pointer: string): JsonValue | undefined => {
    tick(parseJsonPointer(pointer).length + 1);
    const lookup = getJsonPointer(output, pointer);
    return lookup.found ? lookup.value : undefined;
  };
  const write = (pointer: string, value: JsonValue): void => {
    tick(parseJsonPointer(pointer).length + 1);
    setJsonPointer(output, pointer, cloneJson(value));
  };

  for (const operation of program.operations) {
    tick();
    switch (operation.op) {
      case "select": {
        const selected = Object.create(null) as Record<string, JsonValue>;
        for (const pointer of operation.paths) {
          const value = read(pointer);
          if (value !== undefined) {
            setJsonPointer(selected, pointer, cloneJson(value));
          }
        }
        output = selected;
        break;
      }
      case "drop":
        operation.paths.forEach((pointer) => {
          tick(parseJsonPointer(pointer).length + 1);
          deleteJsonPointer(output, pointer);
        });
        break;
      case "rename": {
        const value = read(operation.from);
        if (value !== undefined) {
          tick(parseJsonPointer(operation.from).length + 1);
          deleteJsonPointer(output, operation.from);
          write(operation.to, value);
        }
        break;
      }
      case "set":
        write(operation.path, operation.value);
        break;
      case "coalesce": {
        for (const pointer of operation.from) {
          const value = read(pointer);
          if (value !== undefined && value !== null) {
            write(operation.to, value);
            break;
          }
        }
        break;
      }
      case "map-enum": {
        const value = read(operation.path);
        if (value !== undefined) {
          const mapped =
            typeof value === "string" && Object.hasOwn(operation.map, value)
              ? operation.map[value]
              : operation.default;
          if (mapped !== undefined) {
            write(operation.path, mapped);
          }
        }
        break;
      }
      case "format":
        write(
          operation.to,
          renderTemplate(
            operation.template,
            operation.variables,
            read,
            limits.maximumStringLength,
          ),
        );
        break;
    }
    canonicalJson(output, {
      maximumDepth: limits.maximumDepth,
      maximumOutputBytes: limits.maximumOutputBytes,
    });
  }
  return output;
}
