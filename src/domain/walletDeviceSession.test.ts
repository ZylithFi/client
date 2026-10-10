import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WalletDeviceSessionError,
  createIndexedDbWalletDeviceKeyStore,
  createIndexedDbWalletDeviceOwnedKeyStore,
  createWalletDeviceRecordStore,
  createWalletDeviceWorkerService,
  type WalletDeviceKeyOwner,
  type WalletDeviceOwnedKeyStore,
  type WalletDeviceSessionMetadata,
} from "./walletDeviceSession";
import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { normalizeWalletWorkerContext } from "../workers/walletCryptoProtocol";
import type { WalletStorageLockManager } from "./walletStorageLock";

class MemoryKeyStore implements WalletDeviceOwnedKeyStore {
  readonly keys = new Map<string, CryptoKey>();
  readonly owners = new Map<string, WalletDeviceKeyOwner>();

  async get(id: string) {
    return this.keys.get(id) ?? null;
  }

  async put(id: string, key: CryptoKey) {
    this.keys.set(id, key);
  }

  async delete(id: string) {
    this.keys.delete(id);
    this.owners.delete(id);
  }

  async add(entry: { key: CryptoKey; owner: WalletDeviceKeyOwner }) {
    if (this.keys.has(entry.owner.keyId)) throw new Error("collision");
    this.keys.set(entry.owner.keyId, entry.key);
    this.owners.set(entry.owner.keyId, { ...entry.owner });
  }

  async getOwned(owner: WalletDeviceKeyOwner) {
    return this.ownerMatches(owner) ? this.keys.get(owner.keyId) ?? null : null;
  }

  async deleteOwned(owner: WalletDeviceKeyOwner) {
    if (!this.ownerMatches(owner)) return false;
    this.keys.delete(owner.keyId);
    this.owners.delete(owner.keyId);
    return true;
  }

  private ownerMatches(owner: WalletDeviceKeyOwner) {
    return JSON.stringify(this.owners.get(owner.keyId)) === JSON.stringify(owner);
  }
}

const metadata: WalletDeviceSessionMetadata = {
  walletAddress: "0xabc",
  chainId: "0x534e5f5345504f4c4941",
  deploymentId: "0x123",
  origin: "https://app.zylith.fi",
};

const workerMetadata = {
  ...metadata,
  vaultDeploymentId: "0x456",
  manifestIdentity: `sha256:${"ab".repeat(32)}`,
  manifestVersion: "1",
};

function pause() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function originOfLength(length: number) {
  const hostLength = length - "https://".length;
  const labels: string[] = [];
  let remaining = hostLength;
  while (remaining > 0) {
    const separator = labels.length === 0 ? 0 : 1;
    const labelLength = Math.min(60, remaining - separator);
    if (labelLength <= 0) throw new Error("invalid test origin length");
    labels.push("a".repeat(labelLength));
    remaining -= labelLength + separator;
  }
  return `https://${labels.join(".")}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("worker-owned wallet device session v3", () => {
  it("normalizes origin before applying the shared exact 256-character bound", async () => {
    const keyStore = new MemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore, now: () => 1_000 });
    const canonical = originOfLength(256);
    const accepted = { ...workerMetadata, origin: `${canonical} `, expiresAtMs: 2_000 };
    const rejected = { ...workerMetadata, origin: originOfLength(257), expiresAtMs: 2_000 };

    expect(normalizeWalletWorkerContext(accepted).origin).toBe(canonical);
    expect(() => normalizeWalletWorkerContext(rejected)).toThrow();
    const prepared = await service.prepare(new Uint8Array(32).fill(1), accepted, 10_000);
    await expect(service.open(prepared.raw, accepted)).resolves.toEqual(new Uint8Array(32).fill(1));
    await expect(service.prepare(new Uint8Array(32).fill(2), rejected, 10_000)).rejects.toMatchObject({
      code: "DEVICE_SESSION_INVALID",
    });
  });

  it("keeps legacy v2 keys physically isolated from owned v3 keys", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const legacyKeys = createIndexedDbWalletDeviceKeyStore();
    const ownedKeys = createIndexedDbWalletDeviceOwnedKeyStore();
    const service = createWalletDeviceWorkerService({
      keyStore: ownedKeys,
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const context = { ...workerMetadata, expiresAtMs: 2_000 };
    const prepared = await service.prepare(new Uint8Array(32).fill(5), context, 1_000);
    const legacyKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await legacyKeys.put(prepared.keyId, legacyKey);
    await legacyKeys.delete(prepared.keyId);

    await expect(service.open(prepared.raw, context)).resolves.toEqual(new Uint8Array(32).fill(5));
    await expect(factory.databases()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "zylith-wallet-device-sessions-v1" }),
      expect.objectContaining({ name: "zylith-wallet-device-sessions-v3" }),
    ]));
  });

  it("persists structured-cloned owned keys and rejects collisions without replacing the owner", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    let collisionAborted = false;
    const originalTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const opened = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
      if (args[1] === "readwrite") {
        collisionAborted = false;
        opened.addEventListener("abort", () => { collisionAborted = true; });
      }
      return opened;
    });
    const keyStore = createIndexedDbWalletDeviceOwnedKeyStore();
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const owner: WalletDeviceKeyOwner = {
      recordId: "11".repeat(16),
      keyId: "22".repeat(16),
      walletAddress: "0xabc",
      chainId: "0x123",
      deploymentId: "0x456",
      vaultDeploymentId: "0x789",
      origin: "https://app.zylith.fi",
      manifestIdentity: `sha256:${"ab".repeat(32)}`,
      manifestVersion: "1",
    };
    const originalOwner = { ...owner };
    await keyStore.add({ key, owner });
    owner.recordId = "33".repeat(16);

    const loaded = await keyStore.getOwned(originalOwner);
    expect(loaded).not.toBeNull();
    await expect(crypto.subtle.exportKey("raw", loaded!)).rejects.toThrow();

    const collidingOwner = { ...originalOwner, recordId: "44".repeat(16) };
    await expect(keyStore.add({ key, owner: collidingOwner })).rejects.toThrow();
    expect(collisionAborted).toBe(true);
    expect(await keyStore.getOwned(originalOwner)).not.toBeNull();
    expect(await keyStore.getOwned(collidingOwner)).toBeNull();
  });

  it("conditionally deletes atomically and resolves writes only after transaction completion", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    let lastWriteCompleted = false;
    const originalTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const opened = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
      if (args[1] === "readwrite") {
        lastWriteCompleted = false;
        opened.addEventListener("complete", () => { lastWriteCompleted = true; });
      }
      return opened;
    });
    const keyStore = createIndexedDbWalletDeviceOwnedKeyStore();
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const owner: WalletDeviceKeyOwner = {
      recordId: "55".repeat(16),
      keyId: "66".repeat(16),
      walletAddress: "0xabc",
      chainId: "0x123",
      deploymentId: "0x456",
      vaultDeploymentId: "0x789",
      origin: "https://app.zylith.fi",
      manifestIdentity: `sha256:${"ab".repeat(32)}`,
      manifestVersion: "1",
    };

    await keyStore.add({ key, owner });
    expect(lastWriteCompleted).toBe(true);
    expect(await keyStore.deleteOwned({ ...owner, recordId: "77".repeat(16) })).toBe(false);
    expect(lastWriteCompleted).toBe(true);
    expect(await keyStore.getOwned(owner)).not.toBeNull();
    expect(await keyStore.deleteOwned(owner)).toBe(true);
    expect(lastWriteCompleted).toBe(true);
    expect(await keyStore.getOwned(owner)).toBeNull();
  });

  it("encrypts exactly 32 seed bytes under a nonextractable worker key and opens them without a seed string", async () => {
    const keyStore = new MemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore,
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const seed = new Uint8Array(32).fill(0x5a);
    const prepared = await service.prepare(seed, { ...workerMetadata, expiresAtMs: 2_000 }, 10_000);
    expect(prepared.raw).not.toContain("5a".repeat(32));
    expect(JSON.parse(prepared.raw)).toMatchObject({ version: 3, created_at_ms: 1_000, expires_at_ms: 11_000 });
    const [key] = [...keyStore.keys.values()];
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeTruthy();
    const record = JSON.parse(prepared.raw);
    const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const aad = new TextEncoder().encode([
      "zylith/wallet-device-session/v3",
      "3",
      "2",
      "AES-GCM",
      record.record_id,
      record.key_id,
      "0xabc",
      metadata.chainId,
      "0x123",
      workerMetadata.vaultDeploymentId,
      metadata.origin,
      workerMetadata.manifestIdentity,
      workerMetadata.manifestVersion,
      "1000",
      "11000",
    ].join("\n"));
    expect(new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: decode(record.nonce),
      additionalData: aad,
    }, key, decode(record.ciphertext)))).toEqual(seed);
    const opened = await service.open(prepared.raw, { ...workerMetadata, expiresAtMs: 2_000 });
    expect(opened).toEqual(seed);
    opened.fill(0);
  });

  it("authenticates every context field and deletes only the presented generation", async () => {
    const keyStore = new MemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore,
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const first = await service.prepare(new Uint8Array(32).fill(1), { ...workerMetadata, expiresAtMs: 2_000 }, 10_000);
    const second = await service.prepare(new Uint8Array(32).fill(2), { ...workerMetadata, expiresAtMs: 2_000 }, 10_000);
    await expect(service.open(first.raw, { ...workerMetadata, deploymentId: "0x456", expiresAtMs: 2_000 })).rejects.toMatchObject({
      code: "DEVICE_SESSION_INVALID",
    });
    expect(keyStore.keys.has(first.keyId)).toBe(false);
    expect(keyStore.keys.has(second.keyId)).toBe(true);
    const opened = await service.open(second.raw, { ...workerMetadata, expiresAtMs: 2_000 });
    expect(opened).toEqual(new Uint8Array(32).fill(2));
    opened.fill(0);
  });

  it("never loads or deletes another record's key through an altered key id", async () => {
    const keyStore = new MemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore,
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const first = await service.prepare(new Uint8Array(32).fill(1), { ...workerMetadata, expiresAtMs: 2_000 }, 10_000);
    const second = await service.prepare(new Uint8Array(32).fill(2), { ...workerMetadata, expiresAtMs: 2_000 }, 10_000);
    const altered = JSON.parse(first.raw);
    altered.key_id = second.keyId;
    const alteredRaw = JSON.stringify(altered);

    await expect(service.open(alteredRaw, { ...workerMetadata, expiresAtMs: 2_000 })).rejects.toMatchObject({
      code: "DEVICE_SESSION_INVALID",
    });
    await expect(service.retire(alteredRaw)).resolves.toBeUndefined();
    expect(keyStore.keys.has(first.keyId)).toBe(true);
    expect(keyStore.keys.has(second.keyId)).toBe(true);
    const opened = await service.open(second.raw, { ...workerMetadata, expiresAtMs: 2_000 });
    expect(opened).toEqual(new Uint8Array(32).fill(2));
    opened.fill(0);
  });

  it("preserves a concurrent key-id owner when collision cleanup cannot prove ownership", async () => {
    const keyStore = new MemoryKeyStore();
    const values = [1, 2, 3, 4, 2, 5];
    const service = createWalletDeviceWorkerService({
      keyStore,
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(values.shift() ?? 9),
    });
    const first = await service.prepare(new Uint8Array(32).fill(1), { ...workerMetadata, expiresAtMs: 2_000 }, 10_000);

    await expect(service.prepare(
      new Uint8Array(32).fill(2),
      { ...workerMetadata, expiresAtMs: 2_000 },
      10_000,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(keyStore.keys.size).toBe(1);
    expect(keyStore.keys.has(first.keyId)).toBe(true);
    const opened = await service.open(first.raw, { ...workerMetadata, expiresAtMs: 2_000 });
    expect(opened).toEqual(new Uint8Array(32).fill(1));
    opened.fill(0);
  });

  it("keeps the record retryable on transient key-store failure but revokes expiry and corruption", async () => {
    let clock = 1_000;
    const keyStore = new MemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore,
      now: () => clock,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const transient = await service.prepare(new Uint8Array(32).fill(3), { ...workerMetadata, expiresAtMs: 1_500 }, 1_000);
    const get = keyStore.getOwned.bind(keyStore);
    keyStore.getOwned = async () => { throw new Error("raw idb failure must not escape"); };
    await expect(service.open(transient.raw, { ...workerMetadata, expiresAtMs: 1_500 })).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(keyStore.keys.has(transient.keyId)).toBe(true);
    keyStore.getOwned = get;
    clock = 2_000;
    await expect(service.open(transient.raw, { ...workerMetadata, expiresAtMs: 1_500 })).rejects.toMatchObject({ code: "DEVICE_SESSION_EXPIRED" });
    expect(keyStore.keys.has(transient.keyId)).toBe(false);

    clock = 1_000;
    const corrupted = await service.prepare(new Uint8Array(32).fill(4), { ...workerMetadata, expiresAtMs: 1_500 }, 1_000);
    const parsed = JSON.parse(corrupted.raw);
    parsed.ciphertext = `${parsed.ciphertext[0] === "A" ? "B" : "A"}${parsed.ciphertext.slice(1)}`;
    await expect(service.open(JSON.stringify(parsed), { ...workerMetadata, expiresAtMs: 1_500 })).rejects.toMatchObject({ code: "DEVICE_SESSION_INVALID" });
    expect(keyStore.keys.has(corrupted.keyId)).toBe(false);
  });

  it("uses exact record ownership so a stale revoke cannot delete a replacement", async () => {
    const storage = new MapStorage();
    const records = createWalletDeviceRecordStore(storage);
    const make = (id: string) => JSON.stringify({
      version: 3,
      key_schedule_version: 2,
      algorithm: "AES-GCM",
      record_id: id.repeat(32),
      key_id: id.repeat(32),
      wallet_address: "0xabc",
      chain_id: metadata.chainId,
      deployment_id: metadata.deploymentId,
      vault_deployment_id: workerMetadata.vaultDeploymentId,
      origin: metadata.origin,
      manifest_identity: workerMetadata.manifestIdentity,
      manifest_version: workerMetadata.manifestVersion,
      created_at_ms: 1_000,
      expires_at_ms: 2_000,
      nonce: btoa(String.fromCharCode(...new Uint8Array(12))),
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(48))),
    });
    const first = make("1");
    const second = make("2");
    await expect(records.compareAndSwap("0xabc", null, first)).resolves.toBe(true);
    await expect(records.compareAndSwap("0xabc", first, second)).resolves.toBe(true);
    await expect(records.compareAndSwap("0xabc", first, null)).resolves.toBe(false);
    expect(records.read("0xabc")?.raw).toBe(second);
  });

  it("serializes cooperating-tab record mutations so only one absent-owner publication wins", async () => {
    const storage = new MapStorage();
    const recordsA = createWalletDeviceRecordStore(storage);
    const recordsB = createWalletDeviceRecordStore(storage);
    const service = createWalletDeviceWorkerService({ keyStore: new MemoryKeyStore(), now: () => 1_000 });
    const first = await service.prepare(new Uint8Array(32).fill(1), { ...workerMetadata, expiresAtMs: 2_000 });
    const second = await service.prepare(new Uint8Array(32).fill(2), { ...workerMetadata, expiresAtMs: 2_000 });

    const outcomes = await Promise.all([
      recordsA.compareAndSwap("0xabc", null, first.raw),
      recordsB.compareAndSwap("0xabc", null, second.raw),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect([first.raw, second.raw]).toContain(recordsA.readRaw?.("0xabc"));
  });

  it("fails closed without mutating when the device record lock cannot be acquired", async () => {
    const storage = new MapStorage();
    const unavailable: WalletStorageLockManager = {
      async requestExclusive() { throw new Error("raw lock detail"); },
    };
    const records = createWalletDeviceRecordStore(storage, null, unavailable);
    const service = createWalletDeviceWorkerService({ keyStore: new MemoryKeyStore(), now: () => 1_000 });
    const prepared = await service.prepare(new Uint8Array(32).fill(3), { ...workerMetadata, expiresAtMs: 2_000 });

    await expect(records.compareAndSwap("0xabc", null, prepared.raw)).rejects.toEqual(
      new WalletDeviceSessionError("DEVICE_SESSION_FAILED"),
    );
    expect(records.readRaw?.("0xabc")).toBeNull();
  });

  it("recognizes a record publication that persisted before storage reported failure", async () => {
    const storage = new MapStorage();
    const records = createWalletDeviceRecordStore(storage);
    const raw = JSON.stringify({
      version: 3,
      key_schedule_version: 2,
      algorithm: "AES-GCM",
      record_id: "1".repeat(32),
      key_id: "2".repeat(32),
      wallet_address: "0xabc",
      chain_id: metadata.chainId,
      deployment_id: metadata.deploymentId,
      vault_deployment_id: workerMetadata.vaultDeploymentId,
      origin: metadata.origin,
      manifest_identity: workerMetadata.manifestIdentity,
      manifest_version: workerMetadata.manifestVersion,
      created_at_ms: 1_000,
      expires_at_ms: 2_000,
      nonce: btoa(String.fromCharCode(...new Uint8Array(12))),
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(48))),
    });
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      setItem(key, value);
      throw new Error("ambiguous local storage diagnostic");
    });

    await expect(records.compareAndSwap("0xabc", null, raw)).resolves.toBe(true);
    expect(records.read("0xabc")?.raw).toBe(raw);
  });

  it("maps only the exact wallet storage event into record invalidation notifications", () => {
    const storage = new MapStorage();
    const events = new EventTarget();
    const records = createWalletDeviceRecordStore(storage, events);
    const observed: Array<string | null> = [];
    const unsubscribe = records.subscribe("0xabc", (raw) => observed.push(raw));
    const key = "zylith.wallet.device-session.v3:0xabc";

    events.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "ignored" }));
    events.dispatchEvent(new StorageEvent("storage", { key, newValue: "replacement" }));
    unsubscribe();
    events.dispatchEvent(new StorageEvent("storage", { key, newValue: null }));

    expect(observed).toEqual(["replacement"]);
  });

  it.each(["noncanonical integer", "duplicate field", "extra field", "noncanonical base64"])(
    "rejects a v3 record with %s",
    async (kind) => {
      const keyStore = new MemoryKeyStore();
      const service = createWalletDeviceWorkerService({ keyStore, now: () => 1_000 });
      const prepared = await service.prepare(
        new Uint8Array(32).fill(6),
        { ...workerMetadata, expiresAtMs: 2_000 },
        10_000,
      );
      const parsed = JSON.parse(prepared.raw);
      let raw = prepared.raw;
      if (kind === "noncanonical integer") raw = raw.replace('"version":3', '"version":3.0');
      else if (kind === "duplicate field") raw = raw.replace("{", `{"key_\\u0069d":"${parsed.key_id}",`);
      else if (kind === "extra field") raw = JSON.stringify({ ...parsed, extra: true });
      else {
        parsed.nonce = parsed.nonce.slice(0, -1);
        raw = JSON.stringify(parsed);
      }
      const storage = new MapStorage();
      storage.setItem("zylith.wallet.device-session.v3:0xabc", raw);
      const records = createWalletDeviceRecordStore(storage);

      expect(() => records.read("0xabc")).toThrow(WalletDeviceSessionError);
      expect(storage.getItem("zylith.wallet.device-session.v3:0xabc")).toBe(raw);
      expect(keyStore.keys.has(prepared.keyId)).toBe(true);
    },
  );

  it("returns only fixed errors from the worker cryptography boundary", async () => {
    const keyStore = new MemoryKeyStore();
    keyStore.getOwned = async () => { throw new Error("secret raw idb diagnostic"); };
    const service = createWalletDeviceWorkerService({ keyStore, now: () => 1_000 });
    await expect(service.open("not-json secret", { ...workerMetadata, expiresAtMs: 2_000 })).rejects.toEqual(
      new WalletDeviceSessionError("DEVICE_SESSION_INVALID"),
    );
  });

  it("cleans a key-store write that persisted before reporting failure", async () => {
    const keyStore = new MemoryKeyStore();
    const add = keyStore.add.bind(keyStore);
    keyStore.add = async (entry) => {
      await add(entry);
      throw new Error("ambiguous idb commit diagnostic");
    };
    const service = createWalletDeviceWorkerService({
      keyStore,
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(length),
    });
    await expect(service.prepare(new Uint8Array(32).fill(7), { ...workerMetadata, expiresAtMs: 2_000 }, 10_000)).rejects.toMatchObject({
      code: "DEVICE_SESSION_FAILED",
    });
    expect(keyStore.keys.size).toBe(0);
  });

  it("rejects a generated device key with any usage beyond encrypt and decrypt", async () => {
    const keyStore = new MemoryKeyStore();
    const generated = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt", "wrapKey"],
    );
    const subtle = {
      generateKey: async () => generated,
      encrypt: crypto.subtle.encrypt.bind(crypto.subtle),
    } as unknown as SubtleCrypto;
    const service = createWalletDeviceWorkerService({ keyStore, subtle, now: () => 1_000 });

    await expect(service.prepare(
      new Uint8Array(32).fill(8),
      { ...workerMetadata, expiresAtMs: 2_000 },
      10_000,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(keyStore.keys.size).toBe(0);
  });

  it("deletes a stored key that no longer has the exact AES-GCM key contract", async () => {
    const keyStore = new MemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore, now: () => 1_000 });
    const prepared = await service.prepare(
      new Uint8Array(32).fill(8),
      { ...workerMetadata, expiresAtMs: 2_000 },
      10_000,
    );
    keyStore.keys.set(prepared.keyId, await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    ));

    await expect(service.open(
      prepared.raw,
      { ...workerMetadata, expiresAtMs: 2_000 },
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_INVALID" });
    expect(keyStore.keys.size).toBe(0);
  });

  it("binds the remembered ciphertext to the exact manifest identity and version", async () => {
    const keyStore = new MemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore,
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const workerContext = {
      ...workerMetadata,
      manifestIdentity: `sha256:${"ab".repeat(32)}`,
      manifestVersion: "1",
      expiresAtMs: 2_000,
    };
    const prepared = await service.prepare(new Uint8Array(32).fill(9), workerContext, 10_000);

    await expect(service.open(prepared.raw, {
      ...workerContext,
      manifestVersion: "4",
    })).rejects.toMatchObject({ code: "DEVICE_SESSION_INVALID" });
    expect(keyStore.keys.size).toBe(0);
  });

  it("wipes decrypted seed bytes when the post-decryption clock check fails", async () => {
    const keyStore = new MemoryKeyStore();
    let opening = false;
    let openingReads = 0;
    const service = createWalletDeviceWorkerService({
      keyStore,
      now: () => {
        if (opening && ++openingReads === 2) return Number.NaN;
        return 1_000;
      },
    });
    const prepared = await service.prepare(
      new Uint8Array(32).fill(0x6a),
      { ...workerMetadata, expiresAtMs: 2_000 },
      10_000,
    );
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let decrypted: Uint8Array | null = null;
    vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
      const output = await decrypt(...args);
      decrypted = new Uint8Array(output);
      return output;
    });
    opening = true;

    await expect(service.open(
      prepared.raw,
      { ...workerMetadata, expiresAtMs: 2_000 },
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(decrypted).toEqual(new Uint8Array(32));
    expect(keyStore.keys.has(prepared.keyId)).toBe(true);
  });

  it.each([999, 2_000])("removes a prepared key if the clock becomes invalid (%s) during key persistence", async (invalidClock) => {
    let clock = 1_000;
    const keyStore = new MemoryKeyStore();
    const add = keyStore.add.bind(keyStore);
    keyStore.add = async (entry) => {
      await add(entry);
      clock = invalidClock;
    };
    const service = createWalletDeviceWorkerService({ keyStore, now: () => clock });

    await expect(service.prepare(
      new Uint8Array(32).fill(4),
      { ...workerMetadata, expiresAtMs: 2_000 },
      1_000,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_EXPIRED" });
    expect(keyStore.keys.size).toBe(0);
  });

  it("rejects random identifiers and nonces backed by oversized buffers", async () => {
    const keyStore = new MemoryKeyStore();
    const service = createWalletDeviceWorkerService({
      keyStore,
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(new ArrayBuffer(length + 1), 0, length),
    });

    await expect(service.prepare(
      new Uint8Array(32).fill(4),
      { ...workerMetadata, expiresAtMs: 2_000 },
      1_000,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
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
