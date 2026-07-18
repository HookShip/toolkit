// SPDX-License-Identifier: Apache-2.0

import type { SecretValue } from "./secret.js";
import { isWellFormedUnicode } from "./canonical.js";

export type AdapterJsonPrimitive = boolean | null | number | string;
export type AdapterJsonValue =
  AdapterJsonPrimitive | AdapterJsonObject | readonly AdapterJsonValue[];
export interface AdapterJsonObject {
  readonly [key: string]: AdapterJsonValue | undefined;
}

export interface MappingVersion {
  readonly name: string;
  readonly schemaVersion?: string;
  readonly version: string;
}

export const DEFAULT_ADAPTER_MAPPING_VERSION = Object.freeze({
  name: "webhook-portal.canonical",
  version: "1.0.0",
  schemaVersion: "2026-07-01",
}) satisfies MappingVersion;

export interface ProviderNativeRef {
  readonly accountId?: string;
  readonly etag?: string;
  readonly id: string;
  readonly provider: string;
  readonly region?: string;
  readonly resourceType: string;
}

export interface ResourceLocator {
  readonly id?: string;
  readonly providerRef?: ProviderNativeRef;
}

export type EndpointLifecycleState =
  "active" | "deleted" | "paused" | "pending" | "unknown";

export interface EndpointDefinition {
  readonly description?: string;
  readonly eventTypes?: readonly string[];
  readonly id?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly url: string;
}

export interface EndpointPatch {
  readonly description?: string | null;
  readonly eventTypes?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly url?: string;
}

export interface EndpointResource {
  readonly id?: string;
  readonly mappingVersion: MappingVersion;
  readonly providerRef?: ProviderNativeRef;
  readonly state: EndpointLifecycleState;
}

export type SubscriptionLifecycleState =
  "active" | "paused" | "pending" | "unknown";

export interface SubscriptionDefinition {
  readonly endpoint: ResourceLocator;
  readonly eventTypes: readonly string[];
  readonly filter?: AdapterJsonObject;
  readonly id?: string;
}

export interface SubscriptionResource {
  readonly id?: string;
  readonly mappingVersion: MappingVersion;
  readonly providerRef?: ProviderNativeRef;
  readonly state: SubscriptionLifecycleState;
}

export interface SecretResource {
  readonly expiresAt?: string;
  readonly id?: string;
  readonly mappingVersion: MappingVersion;
  readonly overlapUntil?: string;
  readonly providerRef?: ProviderNativeRef;
  readonly state: "active" | "overlapping" | "pending" | "revoked" | "unknown";
}

export interface EndpointOperationOutput {
  readonly endpoint: EndpointResource;
}

export interface EndpointDeleteOutput extends EndpointOperationOutput {
  readonly deleted: boolean;
}

export interface EndpointVerifyOutput extends EndpointOperationOutput {
  readonly verified: boolean;
}

export interface SubscriptionOperationOutput {
  readonly subscription: SubscriptionResource;
}

export interface SecretOperationOutput {
  readonly secret: SecretResource;
}

export interface SendTestOutput {
  readonly accepted: boolean;
  readonly deliveryId?: string;
  readonly providerRef?: ProviderNativeRef;
  readonly state: "accepted" | "pending";
}

export interface RequestReplayOutput {
  readonly accepted: boolean;
  readonly providerRef?: ProviderNativeRef;
  readonly replayId?: string;
  readonly state: "accepted" | "pending";
}

export interface SecretCreateMaterial {
  readonly label?: string;
  readonly value?: SecretValue;
}

export function isProviderNativeRef(
  value: unknown,
): value is ProviderNativeRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([
    "accountId",
    "etag",
    "id",
    "provider",
    "region",
    "resourceType",
  ]);
  if (
    !Object.keys(descriptors).every(
      (key) => isWellFormedUnicode(key) && allowed.has(key),
    ) ||
    !Object.values(descriptors).every(
      (descriptor) =>
        descriptor.enumerable === true &&
        "value" in descriptor &&
        descriptor.get === undefined &&
        descriptor.set === undefined,
    )
  ) {
    return false;
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  const validScalar = (item: unknown, required = false): item is string =>
    typeof item === "string" &&
    (required ? item.length > 0 : true) &&
    item.length <= 2_048 &&
    isWellFormedUnicode(item) &&
    !/[\u0000-\u001f\u007f]/u.test(item);
  return (
    validScalar(candidate["id"], true) &&
    validScalar(candidate["provider"], true) &&
    validScalar(candidate["resourceType"], true) &&
    (candidate["accountId"] === undefined ||
      validScalar(candidate["accountId"], true)) &&
    (candidate["etag"] === undefined || validScalar(candidate["etag"], true)) &&
    (candidate["region"] === undefined ||
      validScalar(candidate["region"], true))
  );
}

export function isMappingVersion(value: unknown): value is MappingVersion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<MappingVersion>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    isWellFormedUnicode(candidate.name) &&
    typeof candidate.version === "string" &&
    candidate.version.length > 0 &&
    isWellFormedUnicode(candidate.version) &&
    (candidate.schemaVersion === undefined ||
      (typeof candidate.schemaVersion === "string" &&
        isWellFormedUnicode(candidate.schemaVersion)))
  );
}
