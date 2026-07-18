// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import { compareUtf16CodeUnits, isSha256Digest } from "./canonical.js";
import { PermissionDeniedError } from "./errors.js";
import { normalizeJsonPointer, pointerScopeAllows } from "./json-pointer.js";
import {
  expectEnum,
  expectIdentifier,
  expectString,
  inspectArray,
  inspectClosedObject,
} from "./validation.js";

export const ENDPOINT_ACTIONS = [
  "create",
  "delete",
  "read",
  "rotate-secret-reference",
  "update",
] as const;
export type EndpointAction = (typeof ENDPOINT_ACTIONS)[number];

export const SUBSCRIPTION_ACTIONS = [
  "create",
  "delete",
  "read",
  "update",
] as const;
export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number];

export const TIMELINE_ACTIONS = ["append", "read"] as const;
export type TimelineAction = (typeof TIMELINE_ACTIONS)[number];

export const AUDIT_ACTIONS = ["emit"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const METRIC_ACTIONS = ["emit"] as const;
export type MetricAction = (typeof METRIC_ACTIONS)[number];

export interface PermissionSet {
  readonly auditActions: readonly AuditAction[];
  readonly endpointActions: readonly EndpointAction[];
  readonly metadataRead: readonly string[];
  readonly metadataWrite: readonly string[];
  readonly metricActions: readonly MetricAction[];
  readonly outboundHosts: readonly string[];
  readonly payloadRead: readonly string[];
  readonly payloadWrite: readonly string[];
  readonly secretReferences: readonly string[];
  readonly subscriptionActions: readonly SubscriptionAction[];
  readonly timelineActions: readonly TimelineAction[];
}

export type PermissionSetInput = Partial<PermissionSet>;

export const EMPTY_PERMISSION_SET: PermissionSet = Object.freeze({
  auditActions: Object.freeze([]),
  endpointActions: Object.freeze([]),
  metadataRead: Object.freeze([]),
  metadataWrite: Object.freeze([]),
  metricActions: Object.freeze([]),
  outboundHosts: Object.freeze([]),
  payloadRead: Object.freeze([]),
  payloadWrite: Object.freeze([]),
  secretReferences: Object.freeze([]),
  subscriptionActions: Object.freeze([]),
  timelineActions: Object.freeze([]),
});

const PERMISSION_FIELDS = [
  "auditActions",
  "endpointActions",
  "metadataRead",
  "metadataWrite",
  "metricActions",
  "outboundHosts",
  "payloadRead",
  "payloadWrite",
  "secretReferences",
  "subscriptionActions",
  "timelineActions",
] as const;

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort(compareUtf16CodeUnits));
}

function normalizePathScope(value: string, path: string): string {
  if (value === "*") {
    return value;
  }
  if (value.endsWith("/**")) {
    const base = value.slice(0, -3);
    return `${normalizeJsonPointer(base, path)}/**`;
  }
  return normalizeJsonPointer(value, path);
}

function enumArray<const T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): readonly T[] {
  return uniqueSorted(
    inspectArray(value ?? [], path, allowed.length).map((candidate, index) =>
      expectEnum(candidate, `${path}[${index}]`, allowed),
    ),
  );
}

function pathArray(value: unknown, path: string): readonly string[] {
  return uniqueSorted(
    inspectArray(value ?? [], path, 256).map((candidate, index) => {
      const itemPath = `${path}[${index}]`;
      return normalizePathScope(expectString(candidate, itemPath), itemPath);
    }),
  );
}

function referenceArray(value: unknown, path: string): readonly string[] {
  return uniqueSorted(
    inspectArray(value ?? [], path, 256).map((candidate, index) =>
      expectIdentifier(candidate, `${path}[${index}]`, 256),
    ),
  );
}

function isAsciiLetterOrDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39);
}

function validateDomain(host: string, path: string): string {
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    host.includes("..")
  ) {
    throw new PermissionDeniedError(
      "INVALID_OUTBOUND_HOST",
      `${path} is not a valid hostname.`,
      path,
    );
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    throw new PermissionDeniedError(
      "UNSAFE_OUTBOUND_HOST",
      `${path} must be a fully qualified public hostname.`,
      path,
    );
  }
  for (const label of labels) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-") ||
      [...label].some(
        (character) => !isAsciiLetterOrDigit(character) && character !== "-",
      )
    ) {
      throw new PermissionDeniedError(
        "INVALID_OUTBOUND_HOST",
        `${path} contains an invalid DNS label.`,
        path,
      );
    }
  }
  if (
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host === "localhost" ||
    isIP(host) !== 0
  ) {
    throw new PermissionDeniedError(
      "UNSAFE_OUTBOUND_HOST",
      `${path} must not target local names or IP literals.`,
      path,
    );
  }
  return host;
}

export function normalizeOutboundHost(value: string, path = "host"): string {
  const candidate = expectString(value, path, { maximumLength: 300 });
  if (
    candidate.includes("/") ||
    candidate.includes("@") ||
    candidate.includes("?") ||
    candidate.includes("#") ||
    candidate.includes(":")
  ) {
    throw new PermissionDeniedError(
      "INVALID_OUTBOUND_HOST",
      `${path} must contain only a hostname or wildcard hostname.`,
      path,
    );
  }
  const wildcard = candidate.startsWith("*.");
  const rawHost = wildcard ? candidate.slice(2) : candidate;
  const ascii = domainToASCII(rawHost.toLowerCase());
  if (ascii.length === 0) {
    throw new PermissionDeniedError(
      "INVALID_OUTBOUND_HOST",
      `${path} could not be converted to an ASCII hostname.`,
      path,
    );
  }
  const host = validateDomain(ascii, path);
  return wildcard ? `*.${host}` : host;
}

function hostArray(value: unknown, path: string): readonly string[] {
  return uniqueSorted(
    inspectArray(value ?? [], path, 128).map((candidate, index) =>
      normalizeOutboundHost(
        expectString(candidate, `${path}[${index}]`),
        `${path}[${index}]`,
      ),
    ),
  );
}

export function normalizePermissionSet(value: unknown): PermissionSet {
  const object = inspectClosedObject(
    value ?? {},
    "permissions",
    [],
    [...PERMISSION_FIELDS],
  );
  return Object.freeze({
    auditActions: enumArray(
      object.auditActions,
      "permissions.auditActions",
      AUDIT_ACTIONS,
    ),
    endpointActions: enumArray(
      object.endpointActions,
      "permissions.endpointActions",
      ENDPOINT_ACTIONS,
    ),
    metadataRead: pathArray(object.metadataRead, "permissions.metadataRead"),
    metadataWrite: pathArray(object.metadataWrite, "permissions.metadataWrite"),
    metricActions: enumArray(
      object.metricActions,
      "permissions.metricActions",
      METRIC_ACTIONS,
    ),
    outboundHosts: hostArray(object.outboundHosts, "permissions.outboundHosts"),
    payloadRead: pathArray(object.payloadRead, "permissions.payloadRead"),
    payloadWrite: pathArray(object.payloadWrite, "permissions.payloadWrite"),
    secretReferences: referenceArray(
      object.secretReferences,
      "permissions.secretReferences",
    ),
    subscriptionActions: enumArray(
      object.subscriptionActions,
      "permissions.subscriptionActions",
      SUBSCRIPTION_ACTIONS,
    ),
    timelineActions: enumArray(
      object.timelineActions,
      "permissions.timelineActions",
      TIMELINE_ACTIONS,
    ),
  });
}

function hostCovered(granted: readonly string[], requested: string): boolean {
  if (granted.includes(requested)) {
    return true;
  }
  if (requested.startsWith("*.")) {
    return false;
  }
  return granted.some(
    (host) =>
      host.startsWith("*.") &&
      requested.endsWith(host.slice(1)) &&
      requested !== host.slice(2),
  );
}

function missingValues(
  requested: readonly string[],
  granted: readonly string[],
  allows: (grantedValues: readonly string[], requestedValue: string) => boolean,
): readonly string[] {
  return requested.filter((value) => !allows(granted, value));
}

function exactAllows(granted: readonly string[], requested: string): boolean {
  return granted.includes(requested);
}

function pointerAllows(granted: readonly string[], requested: string): boolean {
  if (requested === "*") {
    return granted.includes("*");
  }
  if (requested.endsWith("/**")) {
    return granted.includes(requested) || granted.includes("*");
  }
  return pointerScopeAllows(granted, requested);
}

export interface PermissionComparison {
  readonly allowed: boolean;
  readonly missing: Readonly<
    Partial<Record<keyof PermissionSet, readonly string[]>>
  >;
}

export function comparePermissionSets(
  requestedInput: unknown,
  grantedInput: unknown,
): PermissionComparison {
  const requested = normalizePermissionSet(requestedInput);
  const granted = normalizePermissionSet(grantedInput);
  const missing: Partial<Record<keyof PermissionSet, readonly string[]>> = {};
  const add = (
    key: keyof PermissionSet,
    allows: (
      grantedValues: readonly string[],
      requestedValue: string,
    ) => boolean,
  ): void => {
    const values = missingValues(requested[key], granted[key], allows);
    if (values.length > 0) {
      missing[key] = values;
    }
  };
  add("auditActions", exactAllows);
  add("endpointActions", exactAllows);
  add("metadataRead", pointerAllows);
  add("metadataWrite", pointerAllows);
  add("metricActions", exactAllows);
  add("outboundHosts", hostCovered);
  add("payloadRead", pointerAllows);
  add("payloadWrite", pointerAllows);
  add("secretReferences", exactAllows);
  add("subscriptionActions", exactAllows);
  add("timelineActions", exactAllows);
  return Object.freeze({
    allowed: Object.keys(missing).length === 0,
    missing: Object.freeze(missing),
  });
}

export interface InstallationPermissionGrant {
  readonly bundleDigest: string;
  readonly extensionId: string;
  readonly grantId: string;
  readonly issuer: string;
  readonly permissions: PermissionSet;
}

export function createInstallationPermissionGrant(input: {
  readonly bundleDigest: string;
  readonly extensionId: string;
  readonly grantId: string;
  readonly granted: unknown;
  readonly issuer: string;
  readonly requested: unknown;
}): InstallationPermissionGrant {
  if (!isSha256Digest(input.bundleDigest)) {
    throw new PermissionDeniedError(
      "INVALID_GRANT_DIGEST",
      "Permission grant must bind to a SHA-256 bundle digest.",
    );
  }
  const requested = normalizePermissionSet(input.requested);
  const granted = normalizePermissionSet(input.granted);
  const comparison = comparePermissionSets(granted, requested);
  if (!comparison.allowed) {
    throw new PermissionDeniedError(
      "PERMISSION_ESCALATION",
      "Granted permissions exceed the extension's requested permissions.",
    );
  }
  return Object.freeze({
    bundleDigest: input.bundleDigest,
    extensionId: expectIdentifier(input.extensionId, "extensionId", 256),
    grantId: expectIdentifier(input.grantId, "grantId", 256),
    issuer: expectIdentifier(input.issuer, "issuer", 256),
    permissions: granted,
  });
}

export type PermissionOperation =
  | { readonly action: AuditAction; readonly kind: "audit" }
  | { readonly action: EndpointAction; readonly kind: "endpoint" }
  | { readonly action: MetricAction; readonly kind: "metrics" }
  | { readonly action: SubscriptionAction; readonly kind: "subscription" }
  | { readonly action: TimelineAction; readonly kind: "timeline" }
  | { readonly field: string; readonly kind: "metadata.read" }
  | { readonly field: string; readonly kind: "metadata.write" }
  | { readonly hostUrl: string; readonly kind: "outbound" }
  | { readonly kind: "payload.read"; readonly path: string }
  | { readonly kind: "payload.write"; readonly path: string }
  | { readonly kind: "secret-reference"; readonly reference: string };

export interface PermissionRequest {
  readonly bundleDigest: string;
  readonly delegatedBy?: string;
  readonly extensionId: string;
  readonly operation: PermissionOperation;
}

export interface AuthorizationResult {
  readonly allowed: boolean;
  readonly code:
    | "ALLOWED"
    | "CONFUSED_DEPUTY"
    | "DIGEST_MISMATCH"
    | "IDENTITY_MISMATCH"
    | "SCOPE_DENIED";
}

function outboundUrlAllowed(hosts: readonly string[], rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0
  ) {
    return false;
  }
  try {
    const host = normalizeOutboundHost(url.hostname);
    return hostCovered(hosts, host);
  } catch {
    return false;
  }
}

export function authorizePermission(
  grant: InstallationPermissionGrant,
  request: PermissionRequest,
): AuthorizationResult {
  if (request.delegatedBy !== undefined) {
    return { allowed: false, code: "CONFUSED_DEPUTY" };
  }
  if (grant.extensionId !== request.extensionId) {
    return { allowed: false, code: "IDENTITY_MISMATCH" };
  }
  if (grant.bundleDigest !== request.bundleDigest) {
    return { allowed: false, code: "DIGEST_MISMATCH" };
  }
  const permission = grant.permissions;
  const operation = request.operation;
  let allowed = false;
  switch (operation.kind) {
    case "audit":
      allowed = permission.auditActions.includes(operation.action);
      break;
    case "endpoint":
      allowed = permission.endpointActions.includes(operation.action);
      break;
    case "metadata.read":
      allowed = pointerScopeAllows(permission.metadataRead, operation.field);
      break;
    case "metadata.write":
      allowed = pointerScopeAllows(permission.metadataWrite, operation.field);
      break;
    case "metrics":
      allowed = permission.metricActions.includes(operation.action);
      break;
    case "outbound":
      allowed = outboundUrlAllowed(permission.outboundHosts, operation.hostUrl);
      break;
    case "payload.read":
      allowed = pointerScopeAllows(permission.payloadRead, operation.path);
      break;
    case "payload.write":
      allowed = pointerScopeAllows(permission.payloadWrite, operation.path);
      break;
    case "secret-reference":
      allowed = permission.secretReferences.includes(operation.reference);
      break;
    case "subscription":
      allowed = permission.subscriptionActions.includes(operation.action);
      break;
    case "timeline":
      allowed = permission.timelineActions.includes(operation.action);
      break;
  }
  return allowed
    ? { allowed: true, code: "ALLOWED" }
    : { allowed: false, code: "SCOPE_DENIED" };
}

export function assertPermissionSetContains(
  granted: unknown,
  required: unknown,
): void {
  const comparison = comparePermissionSets(required, granted);
  if (!comparison.allowed) {
    throw new PermissionDeniedError(
      "SCOPE_DENIED",
      `Required permission scopes are missing: ${JSON.stringify(
        comparison.missing,
      )}.`,
    );
  }
}
