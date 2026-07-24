// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  destinationRequiresLocalOptIn,
  resolveSafeDestination,
} from "../src/safe-destination.js";

describe("CLI destination policy contract", () => {
  it("permits public HTTPS without opt-in and reports local requirements", async () => {
    const destination = await resolveSafeDestination("https://8.8.8.8/", {
      allowLocalNetwork: false,
    });
    expect(destination.addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(destinationRequiresLocalOptIn(destination)).toBe(false);
  });

  it("flags localhost and private addresses as requiring opt-in", () => {
    expect(
      destinationRequiresLocalOptIn({
        url: new URL("http://localhost/"),
        addresses: [{ address: "93.184.216.34", family: 4 }],
      }),
    ).toBe(true);
    expect(
      destinationRequiresLocalOptIn({
        url: new URL("http://svc.example/"),
        addresses: [{ address: "10.0.0.5", family: 4 }],
      }),
    ).toBe(true);
    expect(
      destinationRequiresLocalOptIn({
        url: new URL("http://sub.localhost/"),
        addresses: [{ address: "93.184.216.34", family: 4 }],
      }),
    ).toBe(true);
  });

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
