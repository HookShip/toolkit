// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

export interface JsonHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface JsonHttpRequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMilliseconds?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

export class HttpRequestOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("The HTTP request outcome could not be confirmed.", { cause });
    this.name = "HttpRequestOutcomeUnknownError";
  }
}

export class InsecureAuthenticatedTransportError extends RangeError {
  constructor() {
    super("Authenticated remote server URLs must use HTTPS.");
    this.name = "InsecureAuthenticatedTransportError";
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new RangeError("HTTP response exceeded its configured size limit.");
  }
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) {
      break;
    }
    size += part.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new RangeError("HTTP response exceeded its configured size limit.");
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[|\]$/gu, "")
    .toLowerCase()
    .replace(/\.$/u, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  const family = isIP(normalized);
  if (family === 6) {
    return normalized === "::1";
  }
  if (family === 4) {
    return normalized.split(".", 1)[0] === "127";
  }
  return false;
}

export function assertAuthenticatedServerTransport(url: string | URL): URL {
  const parsed = url instanceof URL ? url : new URL(url);
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new InsecureAuthenticatedTransportError();
  }
  return parsed;
}

function hasAuthorizationHeader(
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  return Object.keys(headers ?? {}).some(
    (name) => name.toLowerCase() === "authorization",
  );
}

export async function requestJson(
  url: string,
  options: JsonHttpRequestOptions = {},
): Promise<JsonHttpResponse> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError("Server URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new RangeError("Server URL must not contain embedded credentials.");
  }
  if (hasAuthorizationHeader(options.headers)) {
    assertAuthenticatedServerTransport(parsed);
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("HTTP request deadline exceeded.")),
    options.timeoutMilliseconds ?? 10_000,
  );
  timer.unref();
  try {
    try {
      const response = await (options.fetchImplementation ?? fetch)(parsed, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        redirect: "error",
        signal: controller.signal,
      });
      const bytes = await readBoundedResponse(
        response,
        options.maxResponseBytes ?? 4 * 1024 * 1024,
      );
      let body: unknown = null;
      if (bytes.byteLength > 0) {
        try {
          body = JSON.parse(bytes.toString("utf8")) as unknown;
        } catch {
          throw new SyntaxError("Server returned a non-JSON response.");
        }
      }
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      throw new HttpRequestOutcomeUnknownError(error);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function joinServerUrl(server: string, pathname: string): string {
  const base = new URL(server);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new RangeError("Server URL must use HTTP or HTTPS.");
  }
  if (base.username || base.password) {
    throw new RangeError("Server URL must not contain embedded credentials.");
  }
  return new URL(pathname, base).toString();
}
