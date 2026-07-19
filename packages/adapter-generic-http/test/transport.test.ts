// SPDX-License-Identifier: Apache-2.0

import {
  createServer as createHttpServer,
  type RequestListener,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Server, Socket } from "node:net";

import selfsigned from "selfsigned";
import { describe, expect, it } from "vitest";

import { nodeHttpTransport, type HttpTransportRequest } from "../src/index.js";

const testIdentity = await selfsigned.generate(
  [{ name: "commonName", value: "transport.test" }],
  {
    algorithm: "sha256",
    extensions: [
      { cA: false, name: "basicConstraints" },
      {
        digitalSignature: true,
        keyEncipherment: true,
        name: "keyUsage",
      },
      {
        altNames: [{ type: 2, value: "transport.test" }],
        name: "subjectAltName",
      },
    ],
    keySize: 2048,
  },
);
const certificate = testIdentity.cert;

type Protocol = "http" | "https";

interface TrackedServer {
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

function serverFor(
  protocol: Protocol,
  listener: RequestListener,
): TrackedServer {
  const server =
    protocol === "https"
      ? createHttpsServer(
          {
            cert: certificate,
            key: testIdentity.private,
          },
          listener,
        )
      : createHttpServer(listener);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return { server, sockets };
}

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once("error", fail);
    server.listen(
      {
        port,
        host,
        ...(host.includes(":") ? { ipv6Only: true } : {}),
      },
      () => {
        server.off("error", fail);
        resolve();
      },
    );
  });
  return (server.address() as AddressInfo).port;
}

async function close(tracked: TrackedServer): Promise<void> {
  for (const socket of tracked.sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => tracked.server.close(() => resolve()));
}

function request(
  protocol: Protocol,
  port: number,
  address: string,
  options: Partial<HttpTransportRequest> = {},
): HttpTransportRequest {
  return {
    url: new URL(`${protocol}://transport.test:${port}/`),
    method: "GET",
    headers: {},
    resolvedAddresses: [{ address, family: address.includes(":") ? 6 : 4 }],
    maxResponseBodyBytes: 16_384,
    maxResponseHeaderBytes: 16_384,
    signal: new AbortController().signal,
    ...(protocol === "https" ? { tls: { ca: certificate } } : {}),
    ...options,
  };
}

function body(response: Awaited<ReturnType<typeof nodeHttpTransport>>): string {
  return Buffer.from(response.body ?? []).toString("utf8");
}

describe("nodeHttpTransport socket pinning", () => {
  it("rejects invalid Node header characters before opening a socket", async () => {
    await expect(
      nodeHttpTransport(
        request("http", 1, "127.0.0.1", {
          headers: { "x-unicode": "注文" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "transport.invalid_headers",
    });
  });

  it.each(["http", "https"] as const)(
    "does not reuse a %s socket across different validated address sets",
    async (protocol) => {
      let firstRequests = 0;
      let secondRequests = 0;
      const first = serverFor(protocol, (_request, response) => {
        firstRequests += 1;
        response.writeHead(200, {
          connection: "keep-alive",
          "content-type": "text/plain",
        });
        response.end("first-address");
      });
      const second = serverFor(protocol, (_request, response) => {
        secondRequests += 1;
        response.writeHead(200, {
          connection: "keep-alive",
          "content-type": "text/plain",
        });
        response.end("second-address");
      });

      try {
        const port = await listen(first.server, 0, "127.0.0.1");
        await listen(second.server, port, "::1");

        const firstResponse = await nodeHttpTransport(
          request(protocol, port, "127.0.0.1"),
        );
        const secondResponse = await nodeHttpTransport(
          request(protocol, port, "::1"),
        );

        expect(body(firstResponse)).toBe("first-address");
        expect(body(secondResponse)).toBe("second-address");
        expect(firstRequests).toBe(1);
        expect(secondRequests).toBe(1);
      } finally {
        await Promise.all([close(first), close(second)]);
      }
    },
  );

  it("supports a normal pinned POST request", async () => {
    let received = "";
    const tracked = serverFor("http", (incoming, response) => {
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        received += chunk;
      });
      incoming.on("end", () => {
        response.writeHead(201, { "content-type": "text/plain" });
        response.end("created");
      });
    });
    try {
      const port = await listen(tracked.server, 0, "127.0.0.1");
      const response = await nodeHttpTransport(
        request("http", port, "127.0.0.1", {
          method: "POST",
          body: Buffer.from("bounded-body", "utf8"),
          headers: { "content-type": "text/plain" },
        }),
      );
      expect(response.status).toBe(201);
      expect(body(response)).toBe("created");
      expect(received).toBe("bounded-body");
    } finally {
      await close(tracked);
    }
  });

  it("aborts an in-flight one-shot connection", async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const tracked = serverFor("http", () => {
      requestStarted?.();
    });
    const controller = new AbortController();
    try {
      const port = await listen(tracked.server, 0, "127.0.0.1");
      const pending = nodeHttpTransport(
        request("http", port, "127.0.0.1", {
          signal: controller.signal,
        }),
      );
      await started;
      controller.abort(new DOMException("cancelled", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await close(tracked);
    }
  });

  it("returns redirects without following an unvalidated location", async () => {
    let redirectedRequests = 0;
    let port = 0;
    const redirect = serverFor("http", (incoming, response) => {
      if (incoming.url === "/redirect-target") {
        redirectedRequests += 1;
        response.end("must-not-be-reached");
        return;
      }
      response.writeHead(302, {
        location: `http://transport.test:${port}/redirect-target`,
      });
      response.end("redirect");
    });
    try {
      port = await listen(redirect.server, 0, "127.0.0.1");
      const response = await nodeHttpTransport(
        request("http", port, "127.0.0.1"),
      );
      expect(response.status).toBe(302);
      expect(body(response)).toBe("redirect");
      expect(redirectedRequests).toBe(0);
    } finally {
      await close(redirect);
    }
  });
});
