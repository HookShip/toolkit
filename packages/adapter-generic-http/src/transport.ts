// SPDX-License-Identifier: Apache-2.0

import {
  request as httpRequest,
  validateHeaderName,
  validateHeaderValue,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import type { ResolvedAddress } from "./destination.js";

export interface HttpTransportRequest {
  readonly body?: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxResponseBodyBytes: number;
  readonly maxResponseHeaderBytes: number;
  readonly method: HttpMethod;
  readonly resolvedAddresses: readonly ResolvedAddress[];
  readonly signal: AbortSignal;
  readonly tls?: {
    readonly ca?: Buffer | string | readonly (Buffer | string)[];
    readonly servername?: string;
  };
  readonly url: URL;
}

export interface HttpTransportResponse {
  readonly body?: Uint8Array | string;
  readonly headers?: Readonly<Record<string, readonly string[] | string>>;
  readonly status: number;
}

export type HttpTransport = (
  request: HttpTransportRequest,
) => Promise<HttpTransportResponse>;

export type HttpMethod = "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";

export class HttpTransportInputError extends Error {
  readonly code = "transport.invalid_headers";

  constructor() {
    super("The HTTP transport headers are invalid.");
    this.name = "HttpTransportInputError";
  }
}

function validateTransportHeaders(
  headers: Readonly<Record<string, string>>,
): void {
  try {
    for (const [name, value] of Object.entries(headers)) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    }
  } catch {
    throw new HttpTransportInputError();
  }
}

function mutableCertificateAuthorities(
  value: Buffer | string | readonly (Buffer | string)[],
): Buffer | string | (Buffer | string)[] {
  return Array.isArray(value) ? [...value] : (value as Buffer | string);
}

function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback): void => {
    const requestedFamily =
      options.family === 4 || options.family === 6 ? options.family : undefined;
    const candidates =
      requestedFamily === undefined
        ? addresses
        : addresses.filter((entry) => entry.family === requestedFamily);
    const selected = candidates[0];
    if (selected === undefined) {
      const error = new Error(
        "No validated address matches the requested address family.",
      ) as NodeJS.ErrnoException;
      error.code = "EAI_NONAME";
      callback(error, "", 0);
      return;
    }
    if (options.all === true) {
      callback(
        null,
        candidates.map((entry) => ({
          address: entry.address,
          family: entry.family,
        })),
      );
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function normalizeResponseHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, readonly string[] | string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(headers).flatMap(([name, value]) =>
        value === undefined
          ? []
          : [[name.toLowerCase(), Array.isArray(value) ? [...value] : value]],
      ),
    ),
  );
}

export const nodeHttpTransport: HttpTransport = async (input) => {
  validateTransportHeaders(input.headers);
  return new Promise<HttpTransportResponse>((resolve, reject) => {
    const requestFunction =
      input.url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;

    const settleReject = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const request = requestFunction(
      input.url,
      {
        // A one-shot agent is mandatory: the global agent may reuse a socket
        // opened for an earlier DNS answer and bypass this request's pinned set.
        agent: false,
        headers: input.headers,
        lookup: pinnedLookup(input.resolvedAddresses),
        maxHeaderSize: input.maxResponseHeaderBytes,
        method: input.method,
        signal: input.signal,
        ...(input.url.protocol === "https:" && input.tls !== undefined
          ? {
              ...(input.tls.ca === undefined
                ? {}
                : {
                    ca: mutableCertificateAuthorities(input.tls.ca),
                  }),
              ...(input.tls.servername === undefined
                ? {}
                : { servername: input.tls.servername }),
            }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk, "utf8");
          size += bytes.byteLength;
          if (size > input.maxResponseBodyBytes) {
            response.destroy(
              new RangeError("The HTTP response body exceeded its limit."),
            );
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", settleReject);
        response.on("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(
            Object.freeze({
              status: response.statusCode ?? 0,
              headers: normalizeResponseHeaders(response.headers),
              body: Buffer.concat(chunks),
            }),
          );
        });
      },
    );
    request.on("error", settleReject);
    if (input.body !== undefined) {
      request.write(input.body);
    }
    request.end();
  });
};
