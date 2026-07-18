// SPDX-License-Identifier: Apache-2.0

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalized);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, normalized(item)]),
  );
}

export function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(normalized(value), undefined, space);
}
