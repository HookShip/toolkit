// SPDX-License-Identifier: Apache-2.0

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { assertWellFormedUnicode } from "@webhook-portal/adapter-sdk";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type HostResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly ResolvedAddress[]>;

export interface DestinationPolicy {
  /** @deprecated Use allowLocalNetwork. HTTP remains local/private-only. */
  readonly allowHttp?: boolean;
  readonly allowLocalNetwork?: boolean;
  readonly allowedHosts?: readonly string[];
  readonly allowedPorts?: readonly number[];
  readonly maxUrlLength?: number;
  readonly resolver?: HostResolver;
}

export interface ValidatedDestination {
  readonly addresses: readonly ResolvedAddress[];
  readonly url: URL;
}

export class UnsafeDestinationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UnsafeDestinationError";
    this.code = code;
  }
}

export class DestinationResolutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "DestinationResolutionError";
    this.code = code;
    this.retryable = retryable;
  }
}

const blockedAddresses = new BlockList();
const alwaysForbiddenAddresses = new Set(["168.63.129.16"]);
const localNetworkAddresses = new BlockList();

for (const [address, prefix] of [
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  localNetworkAddresses.addSubnet(address, prefix, "ipv4");
}
localNetworkAddresses.addAddress("::1", "ipv6");
localNetworkAddresses.addSubnet("fc00::", 7, "ipv6");

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv4");
}
blockedAddresses.addAddress("168.63.129.16", "ipv4");

for (const [address, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv6");
}

const forbiddenHostnames = new Set([
  "instance-data",
  "metadata",
  "metadata.aws.internal",
  "metadata.google.internal",
]);

function normalizedHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/u, "");
}

function hostMatches(hostname: string, allowed: string): boolean {
  const host = normalizedHostname(hostname);
  const pattern = normalizedHostname(allowed);
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    return false;
  }
  if (alwaysForbiddenAddresses.has(address.toLowerCase())) {
    return false;
  }
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function isLocalNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    return false;
  }
  return localNetworkAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function allowsLocalNetwork(policy: DestinationPolicy): boolean {
  return policy.allowLocalNetwork === true || policy.allowHttp === true;
}

function assertHostAllowed(hostname: string, policy: DestinationPolicy): void {
  const normalized = normalizedHostname(hostname);
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    forbiddenHostnames.has(normalized)
  ) {
    throw new UnsafeDestinationError(
      "destination.forbidden_host",
      "The destination hostname is not allowed.",
    );
  }
  if (
    policy.allowedHosts !== undefined &&
    !policy.allowedHosts.some((allowed) => hostMatches(normalized, allowed))
  ) {
    throw new UnsafeDestinationError(
      "destination.host_not_allowed",
      "The destination hostname is outside the configured allowlist.",
    );
  }
}

function assertPortAllowed(url: URL, policy: DestinationPolicy): void {
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  const allowedPorts =
    policy.allowedPorts ??
    (allowsLocalNetwork(policy) ? ([80, 443] as const) : ([443] as const));
  if (!Number.isSafeInteger(port) || !allowedPorts.includes(port)) {
    throw new UnsafeDestinationError(
      "destination.port_not_allowed",
      "The destination port is not allowed.",
    );
  }
}

export function validateHttpDestinationSyntax(
  input: string | URL,
  policy: DestinationPolicy = {},
): URL {
  const source = input instanceof URL ? input.href : input;
  assertWellFormedUnicode(source, "Destination URL");
  if (source.length > (policy.maxUrlLength ?? 4_096)) {
    throw new UnsafeDestinationError(
      "destination.url_too_long",
      "The destination URL is too long.",
    );
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new UnsafeDestinationError(
      "destination.invalid_url",
      "The destination URL is invalid.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeDestinationError(
      "destination.invalid_scheme",
      "The destination must use HTTP or HTTPS.",
    );
  }
  if (url.protocol === "http:" && !allowsLocalNetwork(policy)) {
    throw new UnsafeDestinationError(
      "destination.invalid_scheme",
      "Plaintext HTTP requires explicit local-network opt-in.",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new UnsafeDestinationError(
      "destination.credentials_forbidden",
      "Credentials are not allowed in destination URLs.",
    );
  }
  if (source.includes("#")) {
    throw new UnsafeDestinationError(
      "destination.fragment_forbidden",
      "Fragments are not allowed in destination URLs.",
    );
  }

  assertHostAllowed(url.hostname, policy);
  assertPortAllowed(url, policy);

  const literal = normalizedHostname(url.hostname);
  if (isIP(literal) !== 0) {
    const isPublic = isPublicIpAddress(literal);
    const isLocal = isLocalNetworkAddress(literal);
    if (!isPublic && !(isLocal && allowsLocalNetwork(policy))) {
      throw new UnsafeDestinationError(
        "destination.non_public_address",
        "The destination address is prohibited.",
      );
    }
    if (url.protocol === "http:" && !isLocal) {
      throw new UnsafeDestinationError(
        "destination.public_http_forbidden",
        "Globally routable destinations require HTTPS.",
      );
    }
  }
  return url;
}

export const defaultHostResolver: HostResolver = async (hostname, signal) => {
  signal.throwIfAborted();
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) =>
    Object.freeze({
      address: entry.address,
      family: entry.family as 4 | 6,
    }),
  );
};

async function resolveWithAbort(
  resolver: HostResolver,
  hostname: string,
  signal: AbortSignal,
): Promise<readonly ResolvedAddress[]> {
  let resolution: Promise<readonly ResolvedAddress[]>;
  try {
    resolution = Promise.resolve(resolver(hostname, signal));
  } catch (error: unknown) {
    resolution = Promise.reject(error);
  }
  return new Promise<readonly ResolvedAddress[]>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      }
    };
    const abort = (): void => {
      finish(() =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted.", "AbortError"),
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void resolution.then(
      (addresses) => finish(() => resolve(addresses)),
      (error: unknown) =>
        finish(() => {
          if (signal.aborted) {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError"),
            );
            return;
          }
          if (
            error instanceof UnsafeDestinationError ||
            error instanceof DestinationResolutionError
          ) {
            reject(error);
            return;
          }
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? String(
                  (error as { readonly code?: unknown }).code,
                ).toUpperCase()
              : "";
          if (
            [
              "EAI_AGAIN",
              "ECONNRESET",
              "EHOSTUNREACH",
              "ENETUNREACH",
              "ESERVFAIL",
              "ETIME",
              "ETIMEDOUT",
              "SERVFAIL",
            ].includes(code)
          ) {
            reject(
              new DestinationResolutionError(
                "destination.dns_temporary",
                "Destination resolution failed temporarily.",
                true,
              ),
            );
            return;
          }
          if (["EAI_NONAME", "ENOTFOUND", "NXDOMAIN"].includes(code)) {
            reject(
              new DestinationResolutionError(
                "destination.dns_not_found",
                "The destination hostname does not exist.",
                false,
              ),
            );
            return;
          }
          if (
            ["EAI_BADFLAGS", "EAI_FAMILY", "EAI_SERVICE", "EINVAL"].includes(
              code,
            )
          ) {
            reject(
              new DestinationResolutionError(
                "destination.dns_invalid",
                "The destination resolver rejected the request.",
                false,
              ),
            );
            return;
          }
          reject(
            new DestinationResolutionError(
              "destination.dns_failure",
              "Destination resolution failed.",
              true,
            ),
          );
        }),
    );
  });
}

export async function validateHttpDestination(
  input: string | URL,
  policy: DestinationPolicy = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<ValidatedDestination> {
  const url = validateHttpDestinationSyntax(input, policy);
  const hostname = normalizedHostname(url.hostname);
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 4 || literalFamily === 6
      ? [
          Object.freeze({
            address: hostname,
            family: literalFamily,
          }),
        ]
      : await resolveWithAbort(
          policy.resolver ?? defaultHostResolver,
          hostname,
          signal,
        );

  if (addresses.length === 0) {
    throw new UnsafeDestinationError(
      "destination.dns_empty",
      "The destination hostname did not resolve.",
    );
  }
  for (const address of addresses) {
    if (
      (address.family !== 4 && address.family !== 6) ||
      isIP(address.address) !== address.family
    ) {
      throw new UnsafeDestinationError(
        "destination.invalid_address",
        "The destination resolver returned an invalid address.",
      );
    }
  }
  const allPublic = addresses.every(({ address }) =>
    isPublicIpAddress(address),
  );
  const allLocal = addresses.every(({ address }) =>
    isLocalNetworkAddress(address),
  );
  if ((!allPublic && !allLocal) || (allLocal && !allowsLocalNetwork(policy))) {
    throw new UnsafeDestinationError(
      "destination.non_public_address",
      "The destination resolved to a prohibited or mixed address set.",
    );
  }
  if (url.protocol === "http:" && !allLocal) {
    throw new UnsafeDestinationError(
      "destination.public_http_forbidden",
      "Globally routable destinations require HTTPS.",
    );
  }

  return Object.freeze({
    url,
    addresses: Object.freeze(
      addresses.map((address) => Object.freeze({ ...address })),
    ),
  });
}
