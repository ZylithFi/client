import { describe, expect, it, vi } from "vitest";
import {
  WalletSignatureVaultStoreError,
  createWalletSignatureVaultStore,
  walletSignatureVaultStorageKey,
} from "./walletSignatureVaultStore";
import { WalletMigrationRequiredError } from "./walletVersion";
import type { WalletStorageLockManager } from "./walletStorageLock";

const wallet = "0xabc";

function vaultRaw(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 3,
    key_schedule_version: 2,
    kdf: "HKDF-SHA-256",
    algorithm: "AES-256-GCM",
    wallet_address: wallet,
    chain_id: "0x1",
    deployment_id: "0x2",
    origin: "https://app.zylith.fi",
    message_version: 2,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ...overrides,
  });
}

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class EventSource {
  readonly listeners = new Set<EventListener>();
  addEventListener(_type: "storage", listener: EventListener) { this.listeners.add(listener); }
  removeEventListener(_type: "storage", listener: EventListener) { this.listeners.delete(listener); }
  emit(event: Partial<StorageEvent>) {
    for (const listener of this.listeners) listener(event as StorageEvent);
  }
}

class TestLockManager implements WalletStorageLockManager {
  readonly names: string[] = [];
  unavailable = false;
  fail = false;

  async requestExclusive<T>(name: string, callback: () => Promise<T> | T): Promise<T> {
    this.names.push(name);
    if (this.unavailable || this.fail) throw new Error("raw lock detail");
    return callback();
  }
}

describe("wallet signature vault store", () => {
  it("uses the existing exact canonical wallet locator", () => {
    expect(walletSignatureVaultStorageKey("0x000ABC")).toBe("zylith.wallet.vault.v1:0xabc");
    expect(() => walletSignatureVaultStorageKey("0x0")).toThrow(
      new WalletSignatureVaultStoreError("DATA_INVALID"),
    );
  });

  it("strictly reads one duplicate-safe v3 record bound to its locator", () => {
    const storage = new MemoryStorage();
    const store = createWalletSignatureVaultStore(storage, null);
    storage.setItem(walletSignatureVaultStorageKey(wallet), vaultRaw());
    expect(store.readRaw(wallet)).toBe(vaultRaw());
    expect(store.read(wallet)).toMatchObject({ raw: vaultRaw(), vault: { wallet_address: wallet } });

    storage.setItem(walletSignatureVaultStorageKey(wallet), vaultRaw({ wallet_address: "0xdef" }));
    expect(() => store.read(wallet)).toThrow(new WalletSignatureVaultStoreError("DATA_INVALID"));
  });

  it("uses the canonical migration error for incompatible or duplicate version-bearing data", () => {
    const storage = new MemoryStorage();
    const store = createWalletSignatureVaultStore(storage, null);
    for (const incompatible of [
      vaultRaw({ version: 2 }),
      vaultRaw({ key_schedule_version: 1 }),
      vaultRaw({ kdf: "old" }),
      vaultRaw({ extra: true }),
    ]) {
      storage.setItem(walletSignatureVaultStorageKey(wallet), incompatible);
      expect(() => store.read(wallet)).toThrow(WalletMigrationRequiredError);
    }
    for (const incompatible of [
      vaultRaw().replace("{", '{"version":3,'),
      vaultRaw().replace("{", '{"message_version":2,'),
    ]) {
      storage.setItem(walletSignatureVaultStorageKey(wallet), incompatible);
      expect(() => store.read(wallet)).toThrow(WalletMigrationRequiredError);
    }
    for (const invalid of ["{", "null", vaultRaw({ nonce: "bad" })]) {
      storage.setItem(walletSignatureVaultStorageKey(wallet), invalid);
      expect(() => store.read(wallet)).toThrow(new WalletSignatureVaultStoreError("DATA_INVALID"));
    }
  });

  it("publishes once under the canonical per-record lock and cannot overwrite or delete", async () => {
    const storage = new MemoryStorage();
    const locks = new TestLockManager();
    const store = createWalletSignatureVaultStore(storage, null, locks);
    const first = vaultRaw();
    const second = vaultRaw({ nonce: "AQEBAQEBAQEBAQEB" });
    await expect(store.publish(wallet, first)).resolves.toBe(true);
    await expect(store.publish(wallet, second)).resolves.toBe(false);
    expect(store.readRaw(wallet)).toBe(first);
    expect(locks.names).toEqual([
      "zylith-wallet-storage:v1:signature-vault:0xabc",
      "zylith-wallet-storage:v1:signature-vault:0xabc",
    ]);
    await expect(store.publish(wallet, vaultRaw({ wallet_address: "0xdef" }))).rejects.toEqual(
      new WalletSignatureVaultStoreError("DATA_INVALID"),
    );
    expect(store.readRaw(wallet)).toBe(first);
  });

  it("checks runtime ownership inside the storage lock before publishing", async () => {
    const storage = new MemoryStorage();
    const store = createWalletSignatureVaultStore(storage, null, new TestLockManager());
    const isCurrent = vi.fn(() => false);

    await expect(store.publish(wallet, vaultRaw(), isCurrent)).resolves.toBe(false);
    expect(isCurrent).toHaveBeenCalledTimes(1);
    expect(store.readRaw(wallet)).toBeNull();
  });

  it("rereads side-effect-then-throw writes only after a mutation was attempted", async () => {
    class AmbiguousStorage extends MemoryStorage {
      throwAfterSet = true;
      override setItem(key: string, value: string) {
        super.setItem(key, value);
        if (this.throwAfterSet) throw new Error("quota detail");
      }
    }
    const storage = new AmbiguousStorage();
    const store = createWalletSignatureVaultStore(storage, null, new TestLockManager());
    const raw = vaultRaw();
    await expect(store.publish(wallet, raw)).resolves.toBe(true);
    expect(store.readRaw(wallet)).toBe(raw);
  });

  it("never treats an initial read failure as a successful publication", async () => {
    class InitialReadFailureStorage extends MemoryStorage {
      fail = true;
      override getItem(key: string) {
        if (this.fail) {
          this.fail = false;
          super.setItem(key, vaultRaw());
          throw new Error("raw initial read detail");
        }
        return super.getItem(key);
      }
    }
    const storage = new InitialReadFailureStorage();
    const store = createWalletSignatureVaultStore(storage, null, new TestLockManager());
    await expect(store.publish(wallet, vaultRaw())).rejects.toEqual(
      new WalletSignatureVaultStoreError("STORAGE_FAILED"),
    );
  });

  it("uses only fixed store errors for invalid locators and storage failures", async () => {
    class FailingStorage extends MemoryStorage {
      override getItem(_key: string): string | null { throw new Error("raw storage detail"); }
    }
    const store = createWalletSignatureVaultStore(new FailingStorage(), null);
    for (const operation of [
      () => store.readRaw("0x0"),
      () => store.read("not-a-wallet"),
      () => store.subscribe("0x0", () => undefined),
    ]) {
      expect(operation).toThrow(new WalletSignatureVaultStoreError("DATA_INVALID"));
    }
    await expect(store.publish("0x0", vaultRaw())).rejects.toEqual(
      new WalletSignatureVaultStoreError("DATA_INVALID"),
    );
    await expect(store.publish(wallet, null as unknown as string)).rejects.toEqual(
      new WalletSignatureVaultStoreError("DATA_INVALID"),
    );
    expect(() => store.readRaw(wallet)).toThrow(
      new WalletSignatureVaultStoreError("STORAGE_FAILED"),
    );
  });

  it("sanitizes listener installation failure and leaves no installed listener", () => {
    const storage = new MemoryStorage();
    const events = {
      addEventListener() { throw new Error("raw event source detail"); },
      removeEventListener() { throw new Error("unused"); },
    };
    const store = createWalletSignatureVaultStore(storage, events);
    expect(() => store.subscribe(wallet, () => undefined)).toThrow(
      new WalletSignatureVaultStoreError("STORAGE_FAILED"),
    );
  });

  it("attempts listener cleanup when installation mutates and then throws", () => {
    const storage = new MemoryStorage();
    const listeners = new Set<EventListener>();
    const events = {
      addEventListener(_type: "storage", listener: EventListener) {
        listeners.add(listener);
        throw new Error("raw add detail");
      },
      removeEventListener(_type: "storage", listener: EventListener) {
        listeners.delete(listener);
      },
    };
    const store = createWalletSignatureVaultStore(storage, events);
    expect(() => store.subscribe(wallet, () => undefined)).toThrow(
      new WalletSignatureVaultStoreError("STORAGE_FAILED"),
    );
    expect(listeners.size).toBe(0);
  });

  it("fails closed when the production lock seam is unavailable or rejects", async () => {
    const storage = new MemoryStorage();
    const locks = new TestLockManager();
    const store = createWalletSignatureVaultStore(storage, null, locks);
    locks.unavailable = true;
    await expect(store.publish(wallet, vaultRaw())).rejects.toEqual(
      new WalletSignatureVaultStoreError("STORAGE_FAILED"),
    );
    expect(store.readRaw(wallet)).toBeNull();
  });

  it("serializes cooperating-tab publication so exactly one write-once vault wins", async () => {
    const storage = new MemoryStorage();
    const first = createWalletSignatureVaultStore(storage);
    const second = createWalletSignatureVaultStore(storage);
    const rawA = vaultRaw();
    const rawB = vaultRaw({ nonce: "AQEBAQEBAQEBAQEB" });

    const outcomes = await Promise.all([
      first.publish(wallet, rawA),
      second.publish(wallet, rawB),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect([rawA, rawB]).toContain(first.readRaw(wallet));
  });

  it("subscribes only to the exact key and storage and disposes idempotently", () => {
    const storage = new MemoryStorage();
    const other = new MemoryStorage();
    const events = new EventSource();
    const store = createWalletSignatureVaultStore(storage, events);
    const seen: Array<string | null> = [];
    const unsubscribe = store.subscribe(wallet, (raw) => seen.push(raw));
    events.emit({ key: "other", newValue: "ignored", storageArea: storage });
    events.emit({ key: walletSignatureVaultStorageKey(wallet), newValue: vaultRaw(), storageArea: other });
    events.emit({ key: walletSignatureVaultStorageKey(wallet), newValue: vaultRaw(), storageArea: storage });
    events.emit({ key: null, newValue: null, storageArea: storage });
    unsubscribe();
    unsubscribe();
    events.emit({ key: null, newValue: null, storageArea: storage });
    expect(seen).toEqual([vaultRaw(), null]);
    expect(events.listeners.size).toBe(0);
  });
});
