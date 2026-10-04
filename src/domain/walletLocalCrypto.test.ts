import { describe, expect, it } from "vitest";
import {
  decryptLocalStore,
  decryptSeedWithWalletSignature,
  encryptLocalStore,
  encryptSeedWithWalletSignature,
  isWalletSignatureVaultRecord,
  isEncryptedLocalStoreRecord,
  stableJsonStringify,
  walletSignatureVaultAuthToken,
  walletSignatureVaultId,
  type WalletSignatureVaultContext,
} from "./walletLocalCrypto";

const seedHex = "11".repeat(32);
const signatureContext: WalletSignatureVaultContext = {
  signature: ["0x1", "0x2"],
  walletAddress: "0xabc",
  chainId: "0x534e5f5345504f4c4941",
  deploymentId: "0x123",
  origin: "https://app.zylith.fi",
  messageVersion: 2,
};

describe("walletLocalCrypto", () => {
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

  it("refuses to create a local store larger than the reader accepts", async () => {
    await expect(
      encryptLocalStore(
        { value: "a".repeat(4 * 1024 * 1024) },
        seedHex,
        "acct-a",
        "wallet-state",
      ),
    ).rejects.toThrow(/too large/i);
  });

  it("domain-separates vault encryption, lookup, and authorization", async () => {
    const vault = await encryptSeedWithWalletSignature(seedHex, signatureContext);
    const authToken = await walletSignatureVaultAuthToken(signatureContext);
    const vaultId = await walletSignatureVaultId(signatureContext);
    const expectedId = await sha256Hex(
      `zylith/wallet-signature-vault/id/v2:${authToken}`,
    );

    expect(vault.version).toBe(2);
    expect(vaultId).toBe(`0x${expectedId}`);
    await expect(
      decryptSeedWithWalletSignature(vault, signatureContext),
    ).resolves.toBe(seedHex);

    const exposedLookupKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(vaultId.slice(2)),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    await expect(
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(vault.nonce) },
        exposedLookupKey,
        base64ToBytes(vault.ciphertext),
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects partial wallet-signature vault records", () => {
    expect(
      isWalletSignatureVaultRecord({
        version: 2,
        kdf: "wallet-signature-sha256-v2",
      } as never),
    ).toBe(false);
    expect(
      isWalletSignatureVaultRecord({
        version: 2,
        kdf: "wallet-signature-sha256-v2",
        algorithm: "AES-GCM",
        wallet_address: "0xabc",
        chain_id: "0x534e5f5345504f4c4941",
        deployment_id: "0x123",
        origin: "https://app.zylith.fi",
        message_version: 2,
        nonce: "AA==",
        ciphertext: "AA==",
      } as never),
    ).toBe(false);
    expect(
      isWalletSignatureVaultRecord({
        version: 2,
        kdf: "wallet-signature-sha256-v2",
        algorithm: "AES-GCM",
        wallet_address: "0xabc",
        chain_id: "0x534e5f5345504f4c4941",
        deployment_id: "0x123",
        origin: "https://app.zylith.fi",
        message_version: 2,
        nonce: "AA==",
        ciphertext: "AA==",
        unsupported_passphrase_hint: "removed",
      } as never),
    ).toBe(false);
  });

  it("accepts only the one vault format and bounded ciphertext", () => {
    const vault = {
      version: 2,
      kdf: "wallet-signature-sha256-v2",
      algorithm: "AES-GCM",
      wallet_address: "0xabc",
      chain_id: "0x534e5f5345504f4c4941",
      deployment_id: "0x123",
      origin: "https://app.zylith.fi",
      message_version: 2,
      nonce: bytesToBase64(new Uint8Array(12)),
      ciphertext: bytesToBase64(new Uint8Array(80)),
    };
    expect(isWalletSignatureVaultRecord(vault as never)).toBe(true);
    expect(
      isWalletSignatureVaultRecord({ ...vault, message_version: 1 } as never),
    ).toBe(false);
    expect(
      isWalletSignatureVaultRecord({ ...vault, kdf: "wallet-signature-sha256-v1" } as never),
    ).toBe(false);
    expect(isWalletSignatureVaultRecord({ ...vault, nonce: "AA==" } as never)).toBe(false);
    expect(isWalletSignatureVaultRecord({ ...vault, ciphertext: "not-base64" } as never)).toBe(false);
    expect(isEncryptedLocalStoreRecord({
      version: 1,
      algorithm: "AES-GCM",
      nonce: vault.nonce,
      ciphertext: bytesToBase64(new Uint8Array(16)),
    })).toBe(true);
    expect(isEncryptedLocalStoreRecord({
      version: 1,
      algorithm: "AES-GCM",
      nonce: "AA==",
      ciphertext: bytesToBase64(new Uint8Array(16)),
    })).toBe(false);
  });

  it("rejects incomplete wallet-signature vault contexts", async () => {
    await expect(
      encryptSeedWithWalletSignature(seedHex, {
        ...signatureContext,
        signature: "",
      }),
    ).rejects.toThrow("Wallet signature vault context is incomplete");
    await expect(
      walletSignatureVaultAuthToken({
        ...signatureContext,
        deploymentId: "   ",
      }),
    ).rejects.toThrow("Wallet signature vault context is incomplete");
  });

  it("bounds wallet-provided signature structures", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.signature = cyclic;
    await expect(
      walletSignatureVaultAuthToken({ ...signatureContext, signature: cyclic }),
    ).rejects.toThrow("invalid signature");
    await expect(
      walletSignatureVaultAuthToken({
        ...signatureContext,
        signature: Array.from({ length: 17 }, (_, index) => `0x${index + 1}`),
      }),
    ).rejects.toThrow("invalid signature");
  });

  it("rejects wallet-signature vaults outside the original wallet and deployment domain", async () => {
    const vault = await encryptSeedWithWalletSignature(seedHex, signatureContext);
    await expect(
      decryptSeedWithWalletSignature(vault, {
        ...signatureContext,
        walletAddress: "0xdef",
      }),
    ).rejects.toThrow("Connected Starknet wallet does not match this wallet session");
    await expect(
      decryptSeedWithWalletSignature(vault, {
        ...signatureContext,
        chainId: "0x534e5f4d41494e",
      }),
    ).rejects.toThrow("Connected Starknet wallet does not match this wallet session");
    await expect(
      decryptSeedWithWalletSignature(vault, {
        ...signatureContext,
        deploymentId: "0x456",
      }),
    ).rejects.toThrow("Connected Starknet wallet does not match this wallet session");
    await expect(
      decryptSeedWithWalletSignature(vault, {
        ...signatureContext,
        origin: "https://evil.example",
      }),
    ).rejects.toThrow("Connected Starknet wallet does not match this wallet session");
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

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function hexToBytes(value: string) {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

function bytesToBase64(value: Uint8Array) {
  return btoa(String.fromCharCode(...value));
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
