// SPDX-License-Identifier: Apache-2.0

export function classNames(
  ...values: ReadonlyArray<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

export function descriptionIds(
  ...values: ReadonlyArray<string | false | null | undefined>
): string | undefined {
  const joined = values.filter(Boolean).join(" ");
  return joined.length > 0 ? joined : undefined;
}
