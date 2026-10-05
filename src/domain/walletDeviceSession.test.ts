import { describe, expect, it } from "vitest";
import {
  createWalletDeviceSessionManager,
  type WalletDeviceKeyStore,
  type WalletDeviceSessionMetadata,
} from "./walletDeviceSession";

class MemoryKeyStore implements WalletDeviceKeyStore {
  readonly keys = new Map<string, CryptoKey>();

  async get(id: string) {
    return this.keys.get(id) ?? null;
  }

  async put(id: string, key: CryptoKey) {
    this.keys.set(id, key);
  }

  async delete(id: string) {
    this.keys.delete(id);
  }
}

const metadata: WalletDeviceSessionMetadata = {
  walletAddress: "0xabc",
  chainId: "0x534e5f5345504f4c4941",
  deploymentId: "0x123",
  origin: "https://app.zylith.fi",
};

describe("wallet device session", () => {
  it("opens the private seed after a reload without exporting the device key", async () => {
    const storage = new MapStorage();
    const keyStore = new MemoryKeyStore();
    const manager = createWalletDeviceSessionManager({
      storage,
      keyStore,
      now: () => 1_000,
      ttlMs: 10_000,
    });

    await manager.seal("11".repeat(32), metadata);
    const reloaded = createWalletDeviceSessionManager({
      storage,
      keyStore,
      now: () => 2_000,
      ttlMs: 10_000,
    });

    await expect(reloaded.open(metadata)).resolves.toBe("11".repeat(32));
    const [key] = [...keyStore.keys.values()];
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeTruthy();
  });

  it("fails closed for another wallet, chain, deployment, or origin", async () => {
    const storage = new MapStorage();
    const keyStore = new MemoryKeyStore();
    const manager = createWalletDeviceSessionManager({ storage, keyStore });
    await manager.seal("22".repeat(32), metadata);

    for (const changed of [
      { walletAddress: "0xdef" },
      { chainId: "0x1" },
      { deploymentId: "0x456" },
      { origin: "https://evil.example" },
    ]) {
      await expect(manager.open({ ...metadata, ...changed })).resolves.toBeNull();
    }
  });

  it("revokes a remembered session when its deployment identity changes", async () => {
    const storage = new MapStorage();
    const keyStore = new MemoryKeyStore();
    const manager = createWalletDeviceSessionManager({ storage, keyStore });
    await manager.seal("23".repeat(32), metadata);

    await expect(manager.open({ ...metadata, deploymentId: "0x456" })).resolves.toBeNull();
    expect(manager.hasRecord(metadata.walletAddress)).toBe(false);
    expect(keyStore.keys.size).toBe(0);
  });

  it("expires and revokes the device session", async () => {
    let now = 1_000;
    const storage = new MapStorage();
    const keyStore = new MemoryKeyStore();
    const manager = createWalletDeviceSessionManager({
      storage,
      keyStore,
      now: () => now,
      ttlMs: 1_000,
    });
    await manager.seal("33".repeat(32), metadata);
    expect(manager.hasRecord(metadata.walletAddress)).toBe(true);

    now = 2_001;
    await expect(manager.open(metadata)).resolves.toBeNull();
    expect(manager.hasRecord(metadata.walletAddress)).toBe(false);
    expect(keyStore.keys.size).toBe(0);
  });

  it("explicit revocation removes both the record and key", async () => {
    const storage = new MapStorage();
    const keyStore = new MemoryKeyStore();
    const manager = createWalletDeviceSessionManager({ storage, keyStore });
    await manager.seal("44".repeat(32), metadata);

    await manager.revoke(metadata.walletAddress);

    expect(manager.hasRecord(metadata.walletAddress)).toBe(false);
    expect(keyStore.keys.size).toBe(0);
    await expect(manager.open(metadata)).resolves.toBeNull();
  });

  it("revokes a session whose authenticated ciphertext is corrupted", async () => {
    const storage = new MapStorage();
    const keyStore = new MemoryKeyStore();
    const manager = createWalletDeviceSessionManager({ storage, keyStore });
    await manager.seal("55".repeat(32), metadata);
    const recordKey = storage.key(0)!;
    const record = JSON.parse(storage.getItem(recordKey)!) as { ciphertext: string };
    record.ciphertext = `${record.ciphertext[0] === "A" ? "B" : "A"}${record.ciphertext.slice(1)}`;
    storage.setItem(recordKey, JSON.stringify(record));

    await expect(manager.open(metadata)).resolves.toBeNull();
    expect(manager.hasRecord(metadata.walletAddress)).toBe(false);
    expect(keyStore.keys.size).toBe(0);
  });
});

class MapStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
