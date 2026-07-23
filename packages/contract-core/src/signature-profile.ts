// SPDX-License-Identifier: Apache-2.0

import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type SignatureHeader,
  type SignatureProfile,
} from "@webhook-portal/canonical-model";

import { asString, collectExtensions, compareCodeUnits } from "./json-utils.js";

/**
 * Signature-profile extraction: derives the canonical webhook signature profile
 * from `x-signature-profile` / `x-standard-webhooks` extensions, with the
 * fixed Standard Webhooks preset for `true`. Pure value producers with no
 * diagnostic-context dependency, kept separate from the OpenAPI/AsyncAPI
 * extraction so the shared shape lives in one place.
 */

export function signatureHeaders(
  value: JsonValue | undefined,
): SignatureHeader[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const headers: SignatureHeader[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      headers.push({ name: item, required: true });
    } else if (isJsonObject(item) && typeof item["name"] === "string") {
      headers.push({
        name: item["name"],
        required: item["required"] !== false,
      });
    }
  }

  return headers.length === 0
    ? undefined
    : headers.sort((left, right) => compareCodeUnits(left.name, right.name));
}

export function signatureProfile(
  value: JsonValue | undefined,
): SignatureProfile | undefined {
  if (typeof value === "string") {
    return { name: value };
  }
  if (value === true) {
    return {
      algorithms: ["hmac-sha256"],
      headers: [
        { name: "webhook-id", required: true },
        { name: "webhook-signature", required: true },
        { name: "webhook-timestamp", required: true },
      ],
      name: "standard-webhooks",
    };
  }
  if (!isJsonObject(value)) {
    return undefined;
  }

  const name =
    asString(value["name"]) ??
    asString(value["standard"]) ??
    asString(value["type"]);
  if (name === undefined) {
    return undefined;
  }

  const algorithms = Array.isArray(value["algorithms"])
    ? value["algorithms"]
        .filter((item): item is string => typeof item === "string")
        .sort(compareCodeUnits)
    : typeof value["algorithm"] === "string"
      ? [value["algorithm"]]
      : undefined;
  const headers = signatureHeaders(value["headers"]);
  const extensions = collectExtensions(value);
  return {
    name,
    ...(algorithms === undefined || algorithms.length === 0
      ? {}
      : { algorithms }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(headers === undefined ? {} : { headers }),
    ...(typeof value["version"] === "string"
      ? { version: value["version"] }
      : {}),
  };
}

export function inheritedSignature(
  local: JsonObject,
  parent: JsonObject,
  document: JsonObject,
): SignatureProfile | undefined {
  return (
    signatureProfile(local["x-signature-profile"]) ??
    signatureProfile(local["x-standard-webhooks"]) ??
    signatureProfile(parent["x-signature-profile"]) ??
    signatureProfile(parent["x-standard-webhooks"]) ??
    signatureProfile(document["x-signature-profile"]) ??
    signatureProfile(document["x-standard-webhooks"])
  );
}
