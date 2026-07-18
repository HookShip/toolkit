// SPDX-License-Identifier: Apache-2.0

import {
  defaultHostResolver,
  isPublicIpAddress,
  validateHttpDestination,
  type ValidatedDestination,
} from "@webhook-portal/adapter-generic-http";
import { BlockList, isIP } from "node:net";

export interface ResolveDestinationOptions {
  readonly allowLocalNetwork: boolean;
  readonly timeoutMilliseconds?: number;
}

const explicitlyAllowedLocalAddresses = new BlockList();
for (const [address, prefix] of [
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  explicitlyAllowedLocalAddresses.addSubnet(address, prefix, "ipv4");
}
explicitlyAllowedLocalAddresses.addAddress("::1", "ipv6");
explicitlyAllowedLocalAddresses.addSubnet("fc00::", 7, "ipv6");

const alwaysForbiddenHostnames = new Set([
  "instance-data",
  "metadata",
  "metadata.aws.internal",
  "metadata.google.internal",
]);

function normalizedHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/gu, "")
    .toLowerCase()
    .replace(/\.$/u, "");
}

function isExplicitlyAllowedLocalAddress(address: string): boolean {
  const family = isIP(address);
  return (
    (family === 4 && explicitlyAllowedLocalAddresses.check(address, "ipv4")) ||
    (family === 6 && explicitlyAllowedLocalAddresses.check(address, "ipv6"))
  );
}

function localHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

export function destinationRequiresLocalOptIn(
  destination: ValidatedDestination,
): boolean {
  return (
    localHostname(destination.url.hostname) ||
    destination.addresses.some(({ address }) => !isPublicIpAddress(address))
  );
}

export async function resolveSafeDestination(
  input: string,
  options: ResolveDestinationOptions,
): Promise<ValidatedDestination> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Destination resolution timed out.")),
    options.timeoutMilliseconds ?? 5000,
  );
  timer.unref();
  try {
    if (!options.allowLocalNetwork) {
      const destination = await validateHttpDestination(
        input,
        { allowHttp: false },
        controller.signal,
      );
      if (destinationRequiresLocalOptIn(destination)) {
        throw new RangeError(
          "Local and private destinations require explicit opt-in.",
        );
      }
      return destination;
    }
    if (input.length > 4096 || /[\u0000-\u001f\u007f]/u.test(input)) {
      throw new RangeError("The destination URL is invalid.");
    }
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new RangeError("The destination must use HTTP or HTTPS.");
    }
    if (url.username || url.password || input.includes("#")) {
      throw new RangeError(
        "Destination credentials and fragments are forbidden.",
      );
    }
    const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new RangeError("The destination port is invalid.");
    }
    const hostname = normalizedHostname(url.hostname);
    if (
      hostname.length === 0 ||
      hostname.length > 253 ||
      alwaysForbiddenHostnames.has(hostname)
    ) {
      throw new RangeError("The destination hostname is forbidden.");
    }
    const family = isIP(hostname);
    const addresses =
      family === 4 || family === 6
        ? [{ address: hostname, family } as const]
        : await defaultHostResolver(hostname, controller.signal);
    if (addresses.length === 0) {
      throw new RangeError("The destination did not resolve.");
    }
    const allPublic = addresses.every(({ address }) =>
      isPublicIpAddress(address),
    );
    const allLocal = addresses.every(({ address }) =>
      isExplicitlyAllowedLocalAddress(address),
    );
    if (!allPublic && !allLocal) {
      throw new RangeError(
        "The destination resolved to a prohibited address range.",
      );
    }
    if (url.protocol === "http:" && !allLocal) {
      throw new RangeError("Globally routable destinations require HTTPS.");
    }
    return Object.freeze({
      url,
      addresses: Object.freeze([...addresses]),
    });
  } finally {
    clearTimeout(timer);
  }
}
