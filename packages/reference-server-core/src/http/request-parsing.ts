// SPDX-License-Identifier: Apache-2.0

import type { FastifyRequest } from "fastify";

import { ReferenceApiError } from "../service.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (!isObject(request.body)) {
    throw new ReferenceApiError(
      400,
      "INVALID_BODY",
      "A JSON object request body is required.",
    );
  }
  return request.body;
}

export function stringField(
  object: Record<string, unknown>,
  name: string,
  options: { readonly required?: boolean; readonly maxLength?: number } = {},
): string | undefined {
  const value = object[name];
  if (value === undefined && options.required !== true) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > (options.maxLength ?? 4096)
  ) {
    throw new ReferenceApiError(
      400,
      "INVALID_FIELD",
      `Field "${name}" must be a non-empty string within its size limit.`,
    );
  }
  return value;
}

export function booleanField(
  object: Record<string, unknown>,
  name: string,
  fallback = false,
): boolean {
  const value = object[name];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ReferenceApiError(
      400,
      "INVALID_FIELD",
      `Field "${name}" must be a boolean.`,
    );
  }
  return value;
}

export function integerField(
  object: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = object[name];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ReferenceApiError(
      400,
      "INVALID_FIELD",
      `Field "${name}" must be an integer.`,
    );
  }
  return value;
}

export function stringArrayField(
  object: Record<string, unknown>,
  name: string,
): readonly string[] {
  const value = object[name];
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some(
      (item) =>
        typeof item !== "string" || item.length === 0 || item.length > 256,
    )
  ) {
    throw new ReferenceApiError(
      400,
      "INVALID_FIELD",
      `Field "${name}" must be an array of bounded strings.`,
    );
  }
  return value;
}

export function parameter(request: FastifyRequest, name: string): string {
  const params = request.params;
  if (!isObject(params) || typeof params[name] !== "string") {
    throw new ReferenceApiError(
      400,
      "INVALID_PARAMETER",
      `Path parameter "${name}" is required.`,
    );
  }
  return params[name];
}

export function queryObject(request: FastifyRequest): Record<string, unknown> {
  return isObject(request.query) ? request.query : {};
}

export function queryString(
  query: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = query[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function queryLimit(
  query: Record<string, unknown>,
  fallback: number,
  maximum: number,
): number {
  const candidate = query["limit"];
  const raw =
    typeof candidate === "number" ? candidate : queryString(query, "limit");
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ReferenceApiError(
      400,
      "INVALID_LIMIT",
      `The limit must be between 1 and ${maximum}.`,
    );
  }
  return value;
}

export function queryPositiveInteger(
  query: Record<string, unknown>,
  name: string,
): number | undefined {
  const candidate = query[name];
  if (candidate === undefined) {
    return undefined;
  }
  const value = Number(candidate);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReferenceApiError(
      400,
      "INVALID_PARAMETER",
      `The ${name} parameter must be a positive integer.`,
    );
  }
  return value;
}
