// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveSafeDestination } from "../../cli/src/destination.js";

describe("CLI destination policy contract", () => {
  it("cannot opt into Azure WireServer", async () => {
    for (const url of ["http://168.63.129.16/", "https://168.63.129.16/"]) {
      await expect(
        resolveSafeDestination(url, { allowLocalNetwork: true }),
      ).rejects.toThrow(/prohibited address range/iu);
    }
  });

  it("preserves explicit opt-in for ordinary private loopback targets", async () => {
    await expect(
      resolveSafeDestination("http://127.0.0.1:8080/", {
        allowLocalNetwork: true,
      }),
    ).resolves.toMatchObject({
      addresses: [{ address: "127.0.0.1", family: 4 }],
    });
    await expect(
      resolveSafeDestination("http://127.0.0.1:8080/", {
        allowLocalNetwork: false,
      }),
    ).rejects.toThrow();
  });

  it("does not allow local-network opt-in to enable public HTTP", async () => {
    await expect(
      resolveSafeDestination("http://8.8.8.8/", {
        allowLocalNetwork: true,
      }),
    ).rejects.toThrow(/require HTTPS/iu);
    await expect(
      resolveSafeDestination("https://8.8.8.8/", {
        allowLocalNetwork: true,
      }),
    ).resolves.toMatchObject({
      addresses: [{ address: "8.8.8.8", family: 4 }],
    });
  });
});
