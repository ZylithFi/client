import { describe, expect, it } from "vitest";
import {
  decryptLocalStore,
  decryptSeed,
  encryptLocalStore,
  encryptSeed,
  stableJsonStringify,
} from "./walletLocalCrypto";

const seedHex = "11".repeat(32);

describe("walletLocalCrypto", () => {
  it("encrypts and decrypts wallet seeds with the passphrase", async () => {
    const vault = await encryptSeed(seedHex, "pass");

    await expect(decryptSeed(vault, "pass")).resolves.toBe(seedHex);
    await expect(decryptSeed(vault, "wrong")).rejects.toBeTruthy();
  });

  it("rejects decrypted seed payloads that are not seed hex", async () => {
    const vault = await encryptSeed("not-a-seed", "pass");

    await expect(decryptSeed(vault, "pass")).rejects.toThrow(
      "Zylith wallet decrypted to an invalid seed",
    );
  });

  it("binds encrypted local stores to account and label", async () => {
    const store = await encryptLocalStore(
      { orders: ["0xabc"], count: 1 },
      seedHex,
      "acct-a",
      "orders",
    );

    await expect(
      decryptLocalStore(store, seedHex, "acct-a", "orders"),
    ).resolves.toEqual({ orders: ["0xabc"], count: 1 });
    await expect(
      decryptLocalStore(store, seedHex, "acct-b", "orders"),
    ).rejects.toBeTruthy();
    await expect(
      decryptLocalStore(store, seedHex, "acct-a", "notes"),
    ).rejects.toBeTruthy();
  });

  it("canonicalizes JSON object keys and omits undefined object fields", () => {
    expect(stableJsonStringify({ b: 2, a: 1, missing: undefined })).toBe(
      '{"a":1,"b":2}',
    );
    expect(stableJsonStringify([{ b: 2, a: 1 }, undefined])).toBe(
      '[{"a":1,"b":2},null]',
    );
  });
});
