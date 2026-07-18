// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  type JsonObject,
  type SourceLocation,
  type SourceMediaType,
  type SourceRange,
} from "@webhook-portal/canonical-model";
import {
  LineCounter,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
} from "yaml";

import type {
  ContractInput,
  ContractOptions,
  InputSyntax,
  ParsedContract,
} from "./api-types.js";
import { DiagnosticCollector } from "./diagnostics.js";
import {
  joinPointer,
  sha256,
  snapshotJsonValue,
  stableStringify,
} from "./json-utils.js";
import { resolveLimits } from "./limits.js";
import { PARSED_CONTRACT_BRAND } from "./parsed-brand.js";

export const CONTRACT_CORE_NAME = "@webhook-portal/contract-core" as const;
export const CONTRACT_CORE_VERSION = "1.0.0" as const;

export const SUPPORTED_SOURCE_VERSIONS = Object.freeze({
  asyncapi: Object.freeze(["2.6.0", "3.0.0"]),
  openapi: Object.freeze(["3.1.x"]),
});

function deepFreezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) {
        deepFreezeOwned(descriptor.value);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function finalizeParsedContract(result: ParsedContract): ParsedContract {
  return deepFreezeOwned(result);
}

function locateOffset(source: string, offset: number): SourceRange {
  const prefix = source.slice(0, Math.max(0, offset));
  const lines = prefix.split(/\r\n?|\n/u);
  const start: SourceLocation = {
    column: (lines.at(-1)?.length ?? 0) + 1,
    line: lines.length,
    offset,
  };
  return { start };
}

function jsonErrorOffset(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const position = /position\s+(\d+)/iu.exec(error.message)?.[1];
  return position === undefined ? undefined : Number(position);
}

interface JsonStringToken {
  readonly end: number;
  readonly value?: string;
}

interface DuplicateJsonMember {
  readonly key: string;
  readonly offset: number;
  readonly pointer: string;
}

type JsonScanFrame =
  | {
      readonly keys: Set<string>;
      readonly kind: "object";
      pendingKey?: string;
      readonly pointer: string;
      state: "colon" | "comma-or-end" | "key" | "key-or-end" | "value";
    }
  | {
      index: number;
      readonly kind: "array";
      readonly pointer: string;
      state: "comma-or-end" | "value" | "value-or-end";
    };

function scanJsonString(
  source: string,
  start: number,
  decode: boolean,
): JsonStringToken | undefined {
  if (source[start] !== '"') return undefined;
  let index = start + 1;
  let segmentStart = index;
  let value = "";

  while (index < source.length) {
    const character = source[index] as string;
    if (character === '"') {
      if (decode) value += source.slice(segmentStart, index);
      return { end: index + 1, ...(decode ? { value } : {}) };
    }
    if (character.charCodeAt(0) <= 0x1f) {
      return undefined;
    }
    if (character !== "\\") {
      index += 1;
      continue;
    }

    if (decode) value += source.slice(segmentStart, index);
    index += 1;
    const escape = source[index];
    if (escape === undefined) return undefined;
    if (escape === "u") {
      const hexadecimal = source.slice(index + 1, index + 5);
      if (!/^[0-9A-Fa-f]{4}$/u.test(hexadecimal)) {
        return undefined;
      }
      if (decode)
        value += String.fromCharCode(Number.parseInt(hexadecimal, 16));
      index += 5;
      segmentStart = index;
      continue;
    }
    const escaped = {
      '"': '"',
      "/": "/",
      "\\": "\\",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    }[escape];
    if (escaped === undefined) {
      return undefined;
    }
    if (decode) value += escaped;
    index += 1;
    segmentStart = index;
  }
  return undefined;
}

function duplicateJsonMember(source: string): DuplicateJsonMember | undefined {
  const frames: JsonScanFrame[] = [];
  let index = 0;
  let rootStarted = false;

  const skipWhitespace = (): void => {
    while (
      source[index] === " " ||
      source[index] === "\t" ||
      source[index] === "\n" ||
      source[index] === "\r"
    ) {
      index += 1;
    }
  };

  const scanValue = (pointer: string): boolean => {
    skipWhitespace();
    const character = source[index];
    if (character === "{") {
      index += 1;
      frames.push({
        keys: new Set(),
        kind: "object",
        pointer,
        state: "key-or-end",
      });
      return true;
    }
    if (character === "[") {
      index += 1;
      frames.push({
        index: 0,
        kind: "array",
        pointer,
        state: "value-or-end",
      });
      return true;
    }
    if (character === '"') {
      const token = scanJsonString(source, index, false);
      if (token === undefined) return false;
      index = token.end;
      return true;
    }
    if (
      character === undefined ||
      character === ":" ||
      character === "," ||
      character === "]" ||
      character === "}"
    ) {
      return false;
    }
    const start = index;
    while (
      index < source.length &&
      source[index] !== " " &&
      source[index] !== "\t" &&
      source[index] !== "\n" &&
      source[index] !== "\r" &&
      source[index] !== "," &&
      source[index] !== "]" &&
      source[index] !== "}"
    ) {
      index += 1;
    }
    return index > start;
  };

  while (true) {
    if (frames.length === 0) {
      if (!rootStarted) {
        rootStarted = true;
        if (!scanValue("")) return undefined;
        continue;
      }
      skipWhitespace();
      return undefined;
    }

    const frame = frames.at(-1) as JsonScanFrame;
    skipWhitespace();
    if (frame.kind === "object") {
      if (frame.state === "key-or-end" || frame.state === "key") {
        if (source[index] === "}" && frame.state === "key-or-end") {
          index += 1;
          frames.pop();
          continue;
        }
        const offset = index;
        const token = scanJsonString(source, index, true);
        const key = token?.value;
        if (token === undefined || key === undefined) return undefined;
        if (frame.keys.has(key)) {
          return {
            key,
            offset,
            pointer: joinPointer(frame.pointer, key),
          };
        }
        frame.keys.add(key);
        frame.pendingKey = key;
        frame.state = "colon";
        index = token.end;
        continue;
      }
      if (frame.state === "colon") {
        if (source[index] !== ":") return undefined;
        index += 1;
        frame.state = "value";
        continue;
      }
      if (frame.state === "value") {
        const key = frame.pendingKey;
        if (key === undefined) return undefined;
        delete frame.pendingKey;
        frame.state = "comma-or-end";
        if (!scanValue(joinPointer(frame.pointer, key))) return undefined;
        continue;
      }
      if (source[index] === ",") {
        index += 1;
        frame.state = "key";
        continue;
      }
      if (source[index] === "}") {
        index += 1;
        frames.pop();
        continue;
      }
      return undefined;
    }

    if (frame.state === "value-or-end" || frame.state === "value") {
      if (source[index] === "]" && frame.state === "value-or-end") {
        index += 1;
        frames.pop();
        continue;
      }
      const itemPointer = joinPointer(frame.pointer, frame.index);
      frame.index += 1;
      frame.state = "comma-or-end";
      if (!scanValue(itemPointer)) return undefined;
      continue;
    }
    if (source[index] === ",") {
      index += 1;
      frame.state = "value";
      continue;
    }
    if (source[index] === "]") {
      index += 1;
      frames.pop();
      continue;
    }
    return undefined;
  }
}

function nodeRange(
  node: Node | null | undefined,
  lineCounter: LineCounter,
): SourceRange | undefined {
  if (node?.range == null) {
    return undefined;
  }

  const [startOffset, endOffset] = node.range;
  const start = lineCounter.linePos(startOffset);
  const end = lineCounter.linePos(endOffset);
  return {
    end: { column: end.col, line: end.line, offset: endOffset },
    start: { column: start.col, line: start.line, offset: startOffset },
  };
}

function yamlLocations(
  root: Node | null,
  lineCounter: LineCounter,
): Readonly<Record<string, SourceRange>> {
  const locations: Record<string, SourceRange> = {};

  const visit = (node: Node | null, pointer: string): void => {
    if (node === null) {
      return;
    }

    const range = nodeRange(node, lineCounter);
    if (range !== undefined) {
      locations[pointer] = range;
    }

    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          continue;
        }
        const childPointer = joinPointer(pointer, pair.key.value);
        if (isNode(pair.value)) {
          visit(pair.value, childPointer);
        }
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => {
        if (isNode(item)) {
          visit(item, joinPointer(pointer, index));
        }
      });
    }
  };

  visit(root, "");
  return locations;
}

function validateYamlMappingKeys(
  node: Node | null,
  pointer: string,
  lineCounter: LineCounter,
  collector: DiagnosticCollector,
): void {
  if (node === null) return;
  if (isMap(node)) {
    const coercedKeys = new Set<string>();
    for (const pair of node.items) {
      const keyNode = isNode(pair.key) ? pair.key : undefined;
      const scalarValue = isScalar(pair.key) ? pair.key.value : undefined;
      const key =
        typeof scalarValue === "string" ? scalarValue : String(scalarValue);
      if (!isScalar(pair.key) || typeof scalarValue !== "string") {
        collector.add({
          code: "YAML_NON_STRING_MAPPING_KEY",
          message: "YAML mapping keys must be strings",
          pointer,
          severity: "fatal",
          source: nodeRange(keyNode, lineCounter),
        });
      }
      if (coercedKeys.has(key)) {
        collector.add({
          code: "YAML_KEY_COERCION_COLLISION",
          message: `YAML mapping keys collide after string coercion: "${key}"`,
          pointer,
          severity: "fatal",
          source: nodeRange(keyNode, lineCounter),
        });
      }
      coercedKeys.add(key);
      if (isNode(pair.value)) {
        validateYamlMappingKeys(
          pair.value,
          typeof scalarValue === "string"
            ? joinPointer(pointer, scalarValue)
            : pointer,
          lineCounter,
          collector,
        );
      }
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => {
      if (isNode(item)) {
        validateYamlMappingKeys(
          item,
          joinPointer(pointer, index),
          lineCounter,
          collector,
        );
      }
    });
  }
}

function parseYaml(
  source: string,
  maxAliases: number,
  collector: DiagnosticCollector,
): {
  readonly document?: unknown;
  readonly locations: Readonly<Record<string, SourceRange>>;
} {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });

  for (const error of document.errors) {
    const start = error.linePos?.[0];
    collector.add({
      code: `YAML_${error.code}`,
      message: error.message,
      severity: "fatal",
      ...(start === undefined
        ? {}
        : { source: { start: { column: start.col, line: start.line } } }),
    });
  }

  for (const warning of document.warnings) {
    const start = warning.linePos?.[0];
    collector.add({
      code: `YAML_${warning.code}`,
      message: warning.message,
      severity: "warning",
      ...(start === undefined
        ? {}
        : { source: { start: { column: start.col, line: start.line } } }),
    });
  }

  if (document.errors.length > 0) {
    return { locations: {} };
  }

  validateYamlMappingKeys(document.contents, "", lineCounter, collector);
  if (collector.hasErrors()) {
    return { locations: {} };
  }

  try {
    return {
      document: document.toJS({ maxAliasCount: maxAliases }),
      locations: yamlLocations(document.contents, lineCounter),
    };
  } catch (error) {
    collector.add({
      code: "YAML_ALIAS_LIMIT_EXCEEDED",
      message:
        error instanceof Error ? error.message : "YAML alias expansion failed",
      severity: "fatal",
    });
    return { locations: {} };
  }
}

function detectSyntax(
  source: string,
  hint: InputSyntax | undefined,
): InputSyntax {
  if (hint !== undefined) {
    return hint;
  }

  const first = source.trimStart().at(0);
  return first === "{" || first === "[" ? "json" : "yaml";
}

function supportedVersion(
  format: "asyncapi" | "openapi",
  version: string,
): boolean {
  if (format === "openapi") {
    return /^3\.1\.\d+$/u.test(version);
  }

  return version === "2.6.0" || version === "3.0.0";
}

export function parseContract(
  input: ContractInput,
  options: ContractOptions = {},
): ParsedContract {
  const limits = resolveLimits(options.limits);
  const collector = new DiagnosticCollector(limits.maxDiagnostics);
  let document: unknown;
  let syntax: InputSyntax;
  let mediaType: SourceMediaType;
  let locations: Readonly<Record<string, SourceRange>> = {};

  if (typeof input === "string") {
    const inputBytes = Buffer.byteLength(input, "utf8");
    if (inputBytes > limits.maxInputBytes) {
      collector.add({
        code: "INPUT_SIZE_LIMIT_EXCEEDED",
        details: {
          actualBytes: inputBytes,
          maximumBytes: limits.maxInputBytes,
        },
        message: `Input is ${inputBytes} bytes; maximum is ${limits.maxInputBytes}`,
        severity: "fatal",
      });
      return finalizeParsedContract({
        diagnostics: collector.toArray(),
        [PARSED_CONTRACT_BRAND]: true,
        locations,
        ok: false,
        original: input,
        supported: false,
      });
    }

    syntax = detectSyntax(input, options.formatHint);
    mediaType = syntax === "json" ? "application/json" : "application/yaml";

    if (syntax === "json") {
      const duplicate = duplicateJsonMember(input);
      if (duplicate !== undefined) {
        collector.add({
          code: "JSON_DUPLICATE_OBJECT_MEMBER",
          details: { member: duplicate.key },
          message: `JSON object member "${duplicate.key}" is duplicated`,
          pointer: duplicate.pointer,
          severity: "fatal",
          source: locateOffset(input, duplicate.offset),
        });
      } else {
        try {
          document = JSON.parse(input) as unknown;
        } catch (error) {
          const offset = jsonErrorOffset(error);
          collector.add({
            code: "JSON_PARSE_ERROR",
            message:
              error instanceof Error ? error.message : "Invalid JSON input",
            severity: "fatal",
            ...(offset === undefined
              ? {}
              : { source: locateOffset(input, offset) }),
          });
        }
      }
    } else {
      const parsed = parseYaml(input, limits.maxAliases, collector);
      document = parsed.document;
      locations = parsed.locations;
    }
  } else {
    syntax = "json";
    mediaType = "application/json";
    document = input;
  }

  let sourceChecksum = typeof input === "string" ? sha256(input) : undefined;
  let originalSnapshot: ContractInput =
    typeof input === "string" ? input : (Object.freeze({}) as JsonObject);
  let structurallySafe = false;

  if (document !== undefined) {
    let inspection;
    try {
      inspection = snapshotJsonValue(document, limits);
    } catch (error) {
      collector.add({
        code: "OBJECT_INSPECTION_FAILED",
        message:
          error instanceof Error
            ? `Object inspection failed: ${error.message}`
            : "Object inspection failed",
        severity: "fatal",
      });
    }
    if (inspection?.failure !== undefined) {
      collector.add({
        code: inspection.failure.code,
        message: inspection.failure.message,
        pointer: inspection.failure.pointer,
        severity: "fatal",
        source: locations[inspection.failure.pointer],
      });
    } else if (inspection?.value !== undefined) {
      document = inspection.value;
      structurallySafe = true;
      if (typeof input !== "string") {
        originalSnapshot = inspection.value as JsonObject;
        sourceChecksum = sha256(stableStringify(inspection.value));
      }
    }
  }

  if (document !== undefined && !isJsonObject(document)) {
    collector.add({
      code: "DOCUMENT_NOT_OBJECT",
      message: "A contract document must be a JSON object",
      severity: "fatal",
    });
  }

  let format: "asyncapi" | "openapi" | undefined;
  let specificationVersion: string | undefined;
  let supported = false;
  if (structurallySafe && isJsonObject(document)) {
    const openapi = document["openapi"];
    const asyncapi = document["asyncapi"];
    if (typeof openapi === "string" && typeof asyncapi === "string") {
      collector.add({
        code: "AMBIGUOUS_SOURCE_FORMAT",
        message: "Document cannot declare both OpenAPI and AsyncAPI versions",
        severity: "fatal",
      });
    } else if (typeof openapi === "string") {
      format = "openapi";
      specificationVersion = openapi;
    } else if (typeof asyncapi === "string") {
      format = "asyncapi";
      specificationVersion = asyncapi;
    } else {
      collector.add({
        code: "SOURCE_FORMAT_UNRECOGNIZED",
        message: 'Expected a top-level "openapi" or "asyncapi" version',
        severity: "fatal",
      });
    }

    if (format !== undefined && specificationVersion !== undefined) {
      supported = supportedVersion(format, specificationVersion);
      if (!supported) {
        const pointer = format === "openapi" ? "/openapi" : "/asyncapi";
        collector.add({
          code: "UNSUPPORTED_SOURCE_VERSION",
          details: { format, version: specificationVersion },
          message: `Unsupported ${format} version "${specificationVersion}"`,
          pointer,
          severity: "error",
          source: locations[pointer],
        });
      }
    }
  }

  const diagnostics = collector.toArray();
  return finalizeParsedContract({
    diagnostics,
    ...(structurallySafe && isJsonObject(document) ? { document } : {}),
    ...(format === undefined ? {} : { format }),
    [PARSED_CONTRACT_BRAND]: true,
    locations,
    mediaType,
    ok: !diagnostics.some(
      ({ severity }) => severity === "error" || severity === "fatal",
    ),
    original: originalSnapshot,
    ...(options.sourceUri === undefined
      ? {}
      : { sourceUri: options.sourceUri }),
    ...(sourceChecksum === undefined ? {} : { sourceChecksum }),
    ...(specificationVersion === undefined ? {} : { specificationVersion }),
    supported,
    syntax,
  });
}

export function isParsedContract(value: unknown): value is ParsedContract {
  if (!isJsonObject(value)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    value,
    PARSED_CONTRACT_BRAND,
  );
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.value !== true
  ) {
    return false;
  }
  const candidate = value as unknown as Partial<ParsedContract>;
  return (
    Object.isFrozen(value) &&
    Array.isArray(candidate.diagnostics) &&
    Object.isFrozen(candidate.diagnostics) &&
    isJsonObject(candidate.locations) &&
    Object.isFrozen(candidate.locations) &&
    typeof candidate.ok === "boolean" &&
    typeof candidate.supported === "boolean" &&
    (typeof candidate.original === "string" ||
      (isJsonObject(candidate.original) &&
        Object.isFrozen(candidate.original))) &&
    (candidate.document === undefined ||
      (isJsonObject(candidate.document) &&
        Object.isFrozen(candidate.document))) &&
    (candidate.format === undefined ||
      candidate.format === "asyncapi" ||
      candidate.format === "openapi")
  );
}
