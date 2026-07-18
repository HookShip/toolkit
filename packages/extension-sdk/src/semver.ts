// SPDX-License-Identifier: Apache-2.0

import { ExtensionValidationError } from "./errors.js";
import { expectString } from "./validation.js";

export interface SemVer {
  readonly build: readonly string[];
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly raw: string;
}

type ComparatorOperator = "<" | "<=" | "=" | ">" | ">=";

interface Comparator {
  readonly operator: ComparatorOperator;
  readonly version: SemVer;
}

interface ComparatorSet {
  readonly comparators: readonly Comparator[];
}

export interface SemVerRange {
  readonly raw: string;
  readonly sets: readonly ComparatorSet[];
}

const MAXIMUM_VERSION_LENGTH = 128;
const MAXIMUM_COMPONENT = 999_999_999;
const MAXIMUM_RANGE_LENGTH = 512;
const MAXIMUM_RANGE_SETS = 8;
const MAXIMUM_COMPARATORS = 16;

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isIdentifierCharacter(code: number): boolean {
  return (
    isAsciiDigit(code) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2d
  );
}

function parseNumericComponent(value: string, label: string): number {
  if (
    value.length === 0 ||
    (value.length > 1 && value.startsWith("0")) ||
    [...value].some((character) => !isAsciiDigit(character.charCodeAt(0)))
  ) {
    throw new ExtensionValidationError(
      "INVALID_SEMVER",
      `${label} is not a canonical numeric semver component.`,
      label,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAXIMUM_COMPONENT) {
    throw new ExtensionValidationError(
      "SEMVER_LIMIT",
      `${label} exceeds the supported semver bound.`,
      label,
    );
  }
  return parsed;
}

function parseIdentifiers(
  value: string | undefined,
  path: string,
  numericLeadingZeroAllowed: boolean,
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const identifiers = value.split(".");
  if (identifiers.length > 32) {
    throw new ExtensionValidationError(
      "SEMVER_LIMIT",
      `${path} contains too many identifiers.`,
      path,
    );
  }
  for (const identifier of identifiers) {
    if (
      identifier.length === 0 ||
      identifier.length > 64 ||
      [...identifier].some(
        (character) => !isIdentifierCharacter(character.charCodeAt(0)),
      )
    ) {
      throw new ExtensionValidationError(
        "INVALID_SEMVER",
        `${path} contains an invalid identifier.`,
        path,
      );
    }
    if (
      !numericLeadingZeroAllowed &&
      identifier.length > 1 &&
      [...identifier].every((character) =>
        isAsciiDigit(character.charCodeAt(0)),
      ) &&
      identifier.startsWith("0")
    ) {
      throw new ExtensionValidationError(
        "INVALID_SEMVER",
        `${path} contains a numeric identifier with a leading zero.`,
        path,
      );
    }
  }
  return identifiers;
}

export function parseSemVer(value: string): SemVer {
  const raw = expectString(value, "version", {
    maximumLength: MAXIMUM_VERSION_LENGTH,
  });
  const plus = raw.indexOf("+");
  const coreAndPrerelease = plus === -1 ? raw : raw.slice(0, plus);
  const buildText = plus === -1 ? undefined : raw.slice(plus + 1);
  if (plus !== -1 && raw.indexOf("+", plus + 1) !== -1) {
    throw new ExtensionValidationError(
      "INVALID_SEMVER",
      "Semver contains multiple build separators.",
      "version",
    );
  }
  const dash = coreAndPrerelease.indexOf("-");
  const core =
    dash === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, dash);
  const prereleaseText =
    dash === -1 ? undefined : coreAndPrerelease.slice(dash + 1);
  const components = core.split(".");
  if (components.length !== 3) {
    throw new ExtensionValidationError(
      "INVALID_SEMVER",
      "Semver must contain major, minor, and patch components.",
      "version",
    );
  }
  const majorText = components[0];
  const minorText = components[1];
  const patchText = components[2];
  if (
    majorText === undefined ||
    minorText === undefined ||
    patchText === undefined
  ) {
    throw new ExtensionValidationError(
      "INVALID_SEMVER",
      "Semver is incomplete.",
      "version",
    );
  }
  return Object.freeze({
    raw,
    major: parseNumericComponent(majorText, "version.major"),
    minor: parseNumericComponent(minorText, "version.minor"),
    patch: parseNumericComponent(patchText, "version.patch"),
    prerelease: Object.freeze(
      parseIdentifiers(prereleaseText, "version.prerelease", false),
    ),
    build: Object.freeze(parseIdentifiers(buildText, "version.build", true)),
  });
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = [...left].every((character) =>
    isAsciiDigit(character.charCodeAt(0)),
  );
  const rightNumeric = [...right].every((character) =>
    isAsciiDigit(character.charCodeAt(0)),
  );
  if (leftNumeric && rightNumeric) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemVer(
  leftInput: SemVer | string,
  rightInput: SemVer | string,
): number {
  const left =
    typeof leftInput === "string" ? parseSemVer(leftInput) : leftInput;
  const right =
    typeof rightInput === "string" ? parseSemVer(rightInput) : rightInput;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const maximum = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < maximum; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    const comparison = compareIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function version(major: number, minor: number, patch: number): SemVer {
  return parseSemVer(`${major}.${minor}.${patch}`);
}

function comparator(
  operator: ComparatorOperator,
  candidate: SemVer,
): Comparator {
  return Object.freeze({ operator, version: candidate });
}

function partialComparators(token: string): readonly Comparator[] | undefined {
  const components = token.split(".");
  if (components.length > 3 || components.length === 0) {
    return undefined;
  }
  const wildcard = (component: string | undefined): boolean =>
    component === undefined ||
    component === "*" ||
    component === "x" ||
    component === "X";
  if (wildcard(components[0])) {
    return [];
  }
  const majorText = components[0];
  if (majorText === undefined) {
    return [];
  }
  const major = parseNumericComponent(majorText, "range.major");
  if (wildcard(components[1])) {
    return [
      comparator(">=", version(major, 0, 0)),
      comparator("<", version(major + 1, 0, 0)),
    ];
  }
  const minorText = components[1];
  if (minorText === undefined) {
    return [];
  }
  const minor = parseNumericComponent(minorText, "range.minor");
  if (wildcard(components[2])) {
    return [
      comparator(">=", version(major, minor, 0)),
      comparator("<", version(major, minor + 1, 0)),
    ];
  }
  return undefined;
}

function upperForCaret(candidate: SemVer): SemVer {
  if (candidate.major > 0) {
    return version(candidate.major + 1, 0, 0);
  }
  if (candidate.minor > 0) {
    return version(0, candidate.minor + 1, 0);
  }
  return version(0, 0, candidate.patch + 1);
}

function parseComparatorToken(token: string): readonly Comparator[] {
  if (token === "*" || token === "x" || token === "X") {
    return [];
  }
  if (token.startsWith("^")) {
    const candidate = parseSemVer(token.slice(1));
    return [
      comparator(">=", candidate),
      comparator("<", upperForCaret(candidate)),
    ];
  }
  if (token.startsWith("~")) {
    const candidate = parseSemVer(token.slice(1));
    return [
      comparator(">=", candidate),
      comparator("<", version(candidate.major, candidate.minor + 1, 0)),
    ];
  }
  for (const operator of [">=", "<=", ">", "<", "="] as const) {
    if (token.startsWith(operator)) {
      return [comparator(operator, parseSemVer(token.slice(operator.length)))];
    }
  }
  const partial = partialComparators(token);
  if (partial !== undefined) {
    return partial;
  }
  return [comparator("=", parseSemVer(token))];
}

export function parseSemVerRange(value: string): SemVerRange {
  const raw = expectString(value, "range", {
    maximumLength: MAXIMUM_RANGE_LENGTH,
  }).trim();
  if (raw.length === 0) {
    throw new ExtensionValidationError(
      "INVALID_SEMVER_RANGE",
      "Semver range must not be empty.",
      "range",
    );
  }
  const groupTexts = raw.split("||").map((group) => group.trim());
  if (
    groupTexts.length > MAXIMUM_RANGE_SETS ||
    groupTexts.some((group) => group.length === 0)
  ) {
    throw new ExtensionValidationError(
      "SEMVER_RANGE_LIMIT",
      "Semver range has too many or empty alternative sets.",
      "range",
    );
  }
  const sets = groupTexts.map((group) => {
    const tokens = group.split(/\s+/u);
    const comparators = tokens.flatMap((token) => parseComparatorToken(token));
    if (comparators.length > MAXIMUM_COMPARATORS) {
      throw new ExtensionValidationError(
        "SEMVER_RANGE_LIMIT",
        "Semver range contains too many comparators.",
        "range",
      );
    }
    return Object.freeze({ comparators: Object.freeze(comparators) });
  });
  return Object.freeze({ raw, sets: Object.freeze(sets) });
}

function comparatorMatches(candidate: SemVer, constraint: Comparator): boolean {
  const comparison = compareSemVer(candidate, constraint.version);
  switch (constraint.operator) {
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case "=":
      return comparison === 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
  }
}

export function satisfiesSemVer(
  versionInput: SemVer | string,
  rangeInput: SemVerRange | string,
): boolean {
  const candidate =
    typeof versionInput === "string" ? parseSemVer(versionInput) : versionInput;
  const range =
    typeof rangeInput === "string" ? parseSemVerRange(rangeInput) : rangeInput;
  return range.sets.some((set) =>
    set.comparators.every((constraint) =>
      comparatorMatches(candidate, constraint),
    ),
  );
}
