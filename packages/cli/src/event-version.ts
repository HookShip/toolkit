// SPDX-License-Identifier: Apache-2.0

import type {
  CanonicalContract,
  CanonicalEventType,
  CanonicalEventVersion,
  JsonObject,
  JsonValue,
} from "@webhook-portal/contract-core";

export type EventVersionSelection =
  | {
      readonly status: "found";
      readonly event: CanonicalEventType;
      readonly version: CanonicalEventVersion;
    }
  | {
      readonly status: "event_not_found";
      readonly availableVersions: readonly string[];
    }
  | {
      readonly status: "version_required";
      readonly event: CanonicalEventType;
      readonly availableVersions: readonly string[];
    }
  | {
      readonly status: "invalid_current_version";
      readonly event: CanonicalEventType;
      readonly availableVersions: readonly string[];
    };

function extension(
  extensions: JsonObject | undefined,
  names: readonly string[],
): JsonValue | undefined {
  for (const name of names) {
    const value = extensions?.[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function markedCurrentVersions(event: CanonicalEventType): readonly string[] {
  const marked = new Set<string>();
  const eventMarker = extension(event.extensions, [
    "x-webhook-portal-current-version",
    "x-current-version",
  ]);
  if (typeof eventMarker === "string" && eventMarker.length > 0) {
    marked.add(eventMarker);
  }
  for (const version of event.versions) {
    const versionMarker = extension(version.extensions, [
      "x-webhook-portal-current",
      "x-current",
    ]);
    if (versionMarker === true) {
      marked.add(version.publicVersion);
    }
  }
  return [...marked];
}

export function selectCanonicalEventVersion(
  contract: CanonicalContract,
  eventName: string,
  publicVersion?: string,
): EventVersionSelection {
  const event = contract.eventTypes.find(
    (candidate) =>
      candidate.externalName === eventName || candidate.id === eventName,
  );
  if (event === undefined) {
    return { status: "event_not_found", availableVersions: [] };
  }
  const availableVersions = event.versions.map(
    (version) => version.publicVersion,
  );
  if (publicVersion !== undefined) {
    const version = event.versions.find(
      (candidate) => candidate.publicVersion === publicVersion,
    );
    return version === undefined
      ? { status: "event_not_found", availableVersions }
      : { status: "found", event, version };
  }
  if (event.versions.length === 1) {
    return { status: "found", event, version: event.versions[0]! };
  }
  const current = markedCurrentVersions(event);
  if (current.length === 1) {
    const version = event.versions.find(
      (candidate) => candidate.publicVersion === current[0],
    );
    if (version !== undefined) {
      return { status: "found", event, version };
    }
  }
  if (current.length > 0) {
    return {
      status: "invalid_current_version",
      event,
      availableVersions,
    };
  }
  return { status: "version_required", event, availableVersions };
}
