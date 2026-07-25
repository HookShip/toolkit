// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DisabledPayloadStorage,
  InMemoryPayloadStorage,
  type PayloadStorage,
} from "../src/index.js";

const NAMESPACE = "0123456789abcdef012345";
const STORE = "abcdef0123456789abcdef";
const PREFIX = "payloads/local/endpoint/";

function objectKey(suffix: string): string {
  return `${PREFIX}${suffix}`;
}

describe("in-memory payload storage backend", () => {
  it("advertises capture and cleanup capabilities", () => {
    const storage = new InMemoryPayloadStorage();
    expect(storage.capabilities).toEqual({ capture: true, cleanup: true });
  });

  it("stores, reads back, lists, and deletes an object", async () => {
    const storage: PayloadStorage = new InMemoryPayloadStorage();
    const key = objectKey("obj-1");
    await storage.put({
      objectKey: key,
      bytes: Buffer.from('{"ok":true}', "utf8"),
      contentType: "application/json",
      createdAt: "2026-07-16T08:00:00.000Z",
      expiresAt: "2026-07-16T09:00:00.000Z",
    });
    expect(await storage.exists(key)).toBe(true);
    expect([...(await storage.listObjectKeys(PREFIX, 100))]).toContain(key);
    const page = await storage.listObjects(PREFIX, 100);
    expect(page.items.some((object) => object.objectKey === key)).toBe(true);

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it("initializes and inspects a derived-bucket identity", async () => {
    const storage: PayloadStorage = new InMemoryPayloadStorage();
    await storage.initializeIdentity(NAMESPACE, STORE);
    const identity = await storage.inspectIdentity();
    expect(identity.bucketExists).toBe(true);
    expect(identity.namespace).toBe(NAMESPACE);
    expect(identity.storeId).toBe(STORE);
    await storage.ping();
    await storage.close();
  });
});

describe("disabled payload storage backend", () => {
  it("advertises no capture or cleanup capability", () => {
    const storage = new DisabledPayloadStorage();
    expect(storage.capabilities).toEqual({ capture: false, cleanup: false });
  });

  it("is inert: never persists, always reports empty, and closes cleanly", async () => {
    const storage: PayloadStorage = new DisabledPayloadStorage();
    await storage.ping();
    expect(await storage.exists(objectKey("missing"))).toBe(false);
    expect([...(await storage.listObjectKeys(PREFIX, 100))]).toEqual([]);
    const page = await storage.listObjects(PREFIX, 100);
    expect(page.items).toEqual([]);
    await storage.close();
  });
});
