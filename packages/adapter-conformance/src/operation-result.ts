// SPDX-License-Identifier: Apache-2.0

import {
  isMappingVersion,
  isSideEffectingOperation,
  validateCanonicalMetadataRecord,
  type AdapterCommandResult,
  type AdapterOperation,
} from "@webhook-portal/adapter-sdk";

function plainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateOperationResult(
  operation: AdapterOperation,
  result: AdapterCommandResult,
): readonly string[] {
  const issues: string[] = [];
  if (!isSideEffectingOperation(operation) && result.sideEffects !== "none") {
    issues.push(`${operation} incorrectly reported side effects.`);
  }
  if (result.status === "unsupported" || result.status === "failure") {
    issues.push(`${operation} returned ${result.status} in its success probe.`);
    return issues;
  }
  if (result.status === "unknown") {
    issues.push(`${operation} returned unknown in its normal success probe.`);
    return issues;
  }
  const value = result.value;
  if (!plainObject(value)) {
    issues.push(`${operation} did not return an operation-specific object.`);
    return issues;
  }
  if (operation.startsWith("endpoint.")) {
    const endpointStates = new Set([
      "active",
      "deleted",
      "paused",
      "pending",
      "unknown",
    ]);
    if (
      !plainObject(value["endpoint"]) ||
      typeof value["endpoint"]["state"] !== "string" ||
      !endpointStates.has(value["endpoint"]["state"]) ||
      !isMappingVersion(value["endpoint"]["mappingVersion"])
    ) {
      issues.push(`${operation} returned an invalid endpoint result.`);
    }
    if (
      operation === "endpoint.delete" &&
      typeof value["deleted"] !== "boolean"
    ) {
      issues.push("endpoint.delete must return deleted.");
    }
    if (
      operation === "endpoint.verify" &&
      typeof value["verified"] !== "boolean"
    ) {
      issues.push("endpoint.verify must return verified.");
    }
  } else if (operation.startsWith("subscription.")) {
    const subscriptionStates = new Set([
      "active",
      "paused",
      "pending",
      "unknown",
    ]);
    if (
      !plainObject(value["subscription"]) ||
      typeof value["subscription"]["state"] !== "string" ||
      !subscriptionStates.has(value["subscription"]["state"]) ||
      !isMappingVersion(value["subscription"]["mappingVersion"])
    ) {
      issues.push(`${operation} returned an invalid subscription result.`);
    }
  } else if (operation.startsWith("secret.")) {
    const secretStates = new Set([
      "active",
      "overlapping",
      "pending",
      "revoked",
      "unknown",
    ]);
    if (
      !plainObject(value["secret"]) ||
      typeof value["secret"]["state"] !== "string" ||
      !secretStates.has(value["secret"]["state"]) ||
      !isMappingVersion(value["secret"]["mappingVersion"])
    ) {
      issues.push(`${operation} returned an invalid secret result.`);
    }
  } else if (operation === "send_test") {
    if (
      typeof value["accepted"] !== "boolean" ||
      (value["state"] !== "accepted" && value["state"] !== "pending")
    ) {
      issues.push("send_test returned an invalid dispatch result.");
    }
  } else if (operation === "request_replay") {
    if (
      typeof value["accepted"] !== "boolean" ||
      (value["state"] !== "accepted" && value["state"] !== "pending")
    ) {
      issues.push("request_replay returned an invalid replay result.");
    }
  } else if (
    operation === "metadata.poll" ||
    operation === "metadata.backfill"
  ) {
    if (
      !Array.isArray(value["records"]) ||
      !Array.isArray(value["reductions"]) ||
      typeof value["hasMore"] !== "boolean"
    ) {
      issues.push(`${operation} returned an invalid metadata result.`);
    } else if (
      value["records"].some(
        (record) => !validateCanonicalMetadataRecord(record).ok,
      )
    ) {
      issues.push(`${operation} returned non-canonical metadata records.`);
    }
  }
  if (isSideEffectingOperation(operation) && result.sideEffects === "none") {
    issues.push(`${operation} did not report its side-effect outcome.`);
  }
  return Object.freeze(issues);
}
