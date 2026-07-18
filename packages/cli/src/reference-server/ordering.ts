// SPDX-License-Identifier: Apache-2.0

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
