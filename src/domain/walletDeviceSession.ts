import { WALLET_KEY_SCHEDULE_VERSION, parseWalletJson } from "./walletVersion";
import {
  createBrowserWalletStorageLockManager,
  walletStorageLockName,
  type WalletStorageLockManager,
} from "./walletStorageLock";

export type WalletDeviceSessionMetadata = {
  walletAddress: string;
  chainId: string;
  deploymentId: string;
  origin: string;
};

export type WalletDeviceKeyStore = {
  get: (id: string) => Promise<CryptoKey | null>;
  put: (id: string, key: CryptoKey) => Promise<void>;
  delete: (id: string) => Promise<void>;
};

const AES_GCM_TAG_BYTES = 16;
const STARKNET_FIELD_MODULUS = BigInt(
  "0x0800000000000011000000000000000000000000000000000000000000000001",
);
const DEVICE_TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const DEVICE_TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  DEVICE_TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;
const DEVICE_TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  DEVICE_TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const DEVICE_TYPED_ARRAY_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  DEVICE_TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get;
const DEVICE_TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  DEVICE_TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const DEVICE_ARRAY_BUFFER_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

export const WALLET_DEVICE_SESSION_VERSION = 3 as const;
export const WALLET_DEVICE_SESSION_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const WALLET_DEVICE_SESSION_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const WALLET_DEVICE_SESSION_MAX_ORIGIN_LENGTH = 256;
const WORKER_RECORD_PREFIX = "zylith.wallet.device-session.v3:";
const LEGACY_DEVICE_KEY_DATABASE = "zylith-wallet-device-sessions-v1";
const LEGACY_DEVICE_KEY_STORE = "keys";
const OWNED_DEVICE_KEY_DATABASE = "zylith-wallet-device-sessions-v3";
const OWNED_DEVICE_KEY_STORE = "owned-keys";

export type WalletDeviceSessionErrorCode =
  | "DEVICE_SESSION_MISSING"
  | "DEVICE_SESSION_EXPIRED"
  | "DEVICE_SESSION_INVALID"
  | "DEVICE_SESSION_FAILED";

export class WalletDeviceSessionError extends Error {
  readonly code: WalletDeviceSessionErrorCode;

  constructor(code: WalletDeviceSessionErrorCode) {
    super(code);
    this.name = "WalletDeviceSessionError";
    this.code = code;
  }
}

export interface WalletDeviceWorkerContext extends WalletDeviceSessionMetadata {
  vaultDeploymentId: string;
  manifestIdentity: string;
  manifestVersion: string;
  expiresAtMs: number;
}

export interface WalletDeviceRecordSnapshot {
  raw: string;
  ownershipToken: string;
  expiresAtMs: number;
}

export interface WalletDeviceRecordDetails extends WalletDeviceRecordSnapshot {
  keyId: string;
  walletAddress: string;
  chainId: string;
  deploymentId: string;
  vaultDeploymentId: string;
  origin: string;
  manifestIdentity: string;
  manifestVersion: string;
  createdAtMs: number;
}

export interface WalletDeviceRecordStore {
  readRaw?(walletAddress: string): string | null;
  read(walletAddress: string): WalletDeviceRecordSnapshot | null;
  compareAndSwap(
    walletAddress: string,
    expectedRaw: string | null,
    nextRaw: string | null,
  ): Promise<boolean>;
  subscribe(walletAddress: string, listener: (raw: string | null) => void): () => void;
}

export interface WalletDeviceKeyOwner {
  recordId: string;
  keyId: string;
  walletAddress: string;
  chainId: string;
  deploymentId: string;
  vaultDeploymentId: string;
  origin: string;
  manifestIdentity: string;
  manifestVersion: string;
}

export interface WalletDeviceOwnedKeyStore {
  add(entry: { key: CryptoKey; owner: WalletDeviceKeyOwner }): Promise<void>;
  getOwned(owner: WalletDeviceKeyOwner): Promise<CryptoKey | null>;
  deleteOwned(owner: WalletDeviceKeyOwner): Promise<boolean>;
}

interface WalletDeviceSessionRecordV3 {
  version: 3;
  key_schedule_version: 2;
  algorithm: "AES-GCM";
  record_id: string;
  key_id: string;
  wallet_address: string;
  chain_id: string;
  deployment_id: string;
  vault_deployment_id: string;
  origin: string;
  manifest_identity: string;
  manifest_version: string;
  created_at_ms: number;
  expires_at_ms: number;
  nonce: string;
  ciphertext: string;
}

export interface PreparedWalletDeviceSession extends WalletDeviceRecordSnapshot {
  keyId: string;
}

export interface WalletDeviceWorkerService {
  prepare(
    seed: Uint8Array,
    context: WalletDeviceWorkerContext,
    ttlMs?: number,
  ): Promise<PreparedWalletDeviceSession>;
  open(raw: string, context: WalletDeviceWorkerContext): Promise<Uint8Array>;
  discard(raw: string, ownershipToken: string): Promise<void>;
  retire(raw: string): Promise<void>;
}

export interface WalletDeviceWorkerServiceOptions {
  keyStore: WalletDeviceOwnedKeyStore;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  subtle?: SubtleCrypto;
}

export function createIndexedDbWalletDeviceKeyStore(): WalletDeviceKeyStore {
  const databaseName = LEGACY_DEVICE_KEY_DATABASE;
  const storeName = LEGACY_DEVICE_KEY_STORE;

  const openDatabase = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("Browser device-key storage is unavailable"));
        return;
      }
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Device-key database failed to open"));
      request.onblocked = () => reject(new Error("Device-key database is blocked"));
      request.onsuccess = () => resolve(request.result);
    });

  const transact = async <T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ) => {
    const database = await openDatabase();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        let result: T;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error ?? new Error("Device-key operation failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("Device-key transaction aborted"));
        transaction.onerror = () => reject(transaction.error ?? new Error("Device-key transaction failed"));
        transaction.oncomplete = () => resolve(result);
      });
    } finally {
      database.close();
    }
  };

  return {
    async get(id) {
      const result = await transact<unknown>("readonly", (store) => store.get(id));
      return isCryptoKey(result) ? result : null;
    },
    async put(id, key) {
      await transact<IDBValidKey>("readwrite", (store) => store.add(key, id));
    },
    async delete(id) {
      await transact<undefined>("readwrite", (store) => store.delete(id) as IDBRequest<undefined>);
    },
  };
}

export function createIndexedDbWalletDeviceOwnedKeyStore(): WalletDeviceOwnedKeyStore {
  const databaseName = OWNED_DEVICE_KEY_DATABASE;
  const storeName = OWNED_DEVICE_KEY_STORE;

  const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Browser device-key storage is unavailable"));
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onerror = () => reject(request.error ?? new Error("Device-key database failed to open"));
    request.onblocked = () => reject(new Error("Device-key database is blocked"));
    request.onsuccess = () => resolve(request.result);
  });

  async function transact<T>(mode: IDBTransactionMode, operation: (
    store: IDBObjectStore,
    resolveResult: (value: T) => void,
    rejectResult: (error: unknown) => void,
  ) => void): Promise<T> {
    const database = await openDatabase();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        let result: T;
        let resultReady = false;
        let operationError: unknown = null;
        const resolveResult = (value: T) => {
          result = value;
          resultReady = true;
        };
        const rejectResult = (error: unknown) => {
          operationError = error;
          try { transaction.abort(); } catch { /* the transaction already failed */ }
        };
        transaction.onabort = () => reject(
          operationError ?? transaction.error ?? new Error("Device-key transaction aborted"),
        );
        transaction.onerror = () => {
          operationError ??= transaction.error ?? new Error("Device-key transaction failed");
        };
        transaction.oncomplete = () => {
          if (operationError !== null) reject(operationError);
          else if (resultReady) resolve(result);
          else reject(new Error("Device-key transaction completed without a result"));
        };
        try {
          operation(transaction.objectStore(storeName), resolveResult, rejectResult);
        } catch (error) {
          rejectResult(error);
        }
      });
    } finally {
      database.close();
    }
  }

  return {
    async add(entry) {
      await transact<void>("readwrite", (store, done, failed) => {
        const request = store.add(entry, entry.owner.keyId);
        request.onsuccess = () => done(undefined);
        request.onerror = () => failed(request.error ?? new Error("Device-key insertion failed"));
      });
    },
    async getOwned(owner) {
      return transact<CryptoKey | null>("readonly", (store, done, failed) => {
        const request = store.get(owner.keyId);
        request.onsuccess = () => {
          const entry = request.result;
          done(validOwnedKeyEntry(entry) && ownersEqual(entry.owner, owner) ? entry.key : null);
        };
        request.onerror = () => failed(request.error ?? new Error("Device-key lookup failed"));
      });
    },
    async deleteOwned(owner) {
      return transact<boolean>("readwrite", (store, done, failed) => {
        const lookup = store.get(owner.keyId);
        lookup.onerror = () => failed(lookup.error ?? new Error("Device-key lookup failed"));
        lookup.onsuccess = () => {
          const entry = lookup.result;
          if (!validOwnedKeyEntry(entry) || !ownersEqual(entry.owner, owner)) {
            done(false);
            return;
          }
          const removal = store.delete(owner.keyId);
          removal.onsuccess = () => done(true);
          removal.onerror = () => failed(removal.error ?? new Error("Device-key deletion failed"));
        };
      });
    },
  };
}

interface WalletDeviceStorageEventSource {
  addEventListener(type: "storage", listener: EventListener): void;
  removeEventListener(type: "storage", listener: EventListener): void;
}

export function createWalletDeviceRecordStore(
  storage: Storage,
  eventSource: WalletDeviceStorageEventSource | null = defaultStorageEventSource(),
  lockManager: WalletStorageLockManager = createBrowserWalletStorageLockManager(),
): WalletDeviceRecordStore {
  const locator = (walletAddress: string) => `${WORKER_RECORD_PREFIX}${canonicalDeviceWallet(walletAddress)}`;

  function readRaw(walletAddress: string) {
    try {
      return storage.getItem(locator(walletAddress));
    } catch {
      throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
    }
  }

  return {
    readRaw,
    read(walletAddress) {
      const raw = readRaw(walletAddress);
      if (raw === null) return null;
      const record = inspectWalletDeviceRecord(raw);
      if (record.walletAddress !== normalizeMetadataText(walletAddress)) {
        throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
      }
      return record;
    },

    async compareAndSwap(walletAddress, expectedRaw, nextRaw) {
      const canonicalWallet = canonicalDeviceWallet(walletAddress);
      const key = locator(canonicalWallet);
      if (nextRaw !== null) {
        const next = parseWorkerRecord(nextRaw);
        if (next.wallet_address !== canonicalWallet) {
          throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
        }
      }
      try {
        return await lockManager.requestExclusive(
          walletStorageLockName("device-session", canonicalWallet),
          async () => {
            let current: string | null;
            try {
              current = storage.getItem(key);
            } catch {
              throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
            }
            if (current !== expectedRaw) return false;
            let mutationAttempted = false;
            try {
              mutationAttempted = true;
              if (nextRaw === null) storage.removeItem(key);
              else storage.setItem(key, nextRaw);
              return storage.getItem(key) === nextRaw;
            } catch {
              if (mutationAttempted) {
                try {
                  if (storage.getItem(key) === nextRaw) return true;
                } catch {
                  // the final ownership state is unavailable
                }
              }
              throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
            }
          },
        );
      } catch (error) {
        if (error instanceof WalletDeviceSessionError) throw error;
        throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
      }
    },

    subscribe(walletAddress, listener) {
      const key = locator(walletAddress);
      if (eventSource === null) return () => undefined;
      let active = true;
      const onStorage = (event: Event) => {
        if (!active) return;
        const storageEvent = event as StorageEvent;
        if (storageEvent.key !== key && storageEvent.key !== null) return;
        if (storageEvent.storageArea !== null && storageEvent.storageArea !== storage) return;
        listener(storageEvent.key === null ? null : storageEvent.newValue);
      };
      try {
        eventSource.addEventListener("storage", onStorage);
      } catch {
        active = false;
        try {
          eventSource.removeEventListener("storage", onStorage);
        } catch {
          // cleanup is best effort after ambiguous listener installation
        }
        throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
      }
      return () => {
        if (!active) return;
        active = false;
        try {
          eventSource.removeEventListener("storage", onStorage);
        } catch {
          // disposal is idempotent and cannot restore an active listener
        }
      };
    },
  };
}

function canonicalDeviceWallet(walletAddress: string): string {
  const canonical = normalizeMetadataText(walletAddress);
  if (!isCanonicalNonzeroFelt(canonical)) {
    throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
  }
  return canonical;
}

export function inspectWalletDeviceRecord(raw: string): WalletDeviceRecordDetails {
  const record = parseWorkerRecord(raw);
  return {
    raw,
    ownershipToken: record.record_id,
    expiresAtMs: record.expires_at_ms,
    keyId: record.key_id,
    walletAddress: record.wallet_address,
    chainId: record.chain_id,
    deploymentId: record.deployment_id,
    vaultDeploymentId: record.vault_deployment_id,
    origin: record.origin,
    manifestIdentity: record.manifest_identity,
    manifestVersion: record.manifest_version,
    createdAtMs: record.created_at_ms,
  };
}

export function walletDeviceRecordMatchesContext(
  record: WalletDeviceRecordDetails,
  suppliedContext: WalletDeviceWorkerContext,
): boolean {
  let context: ReturnType<typeof normalizeWorkerContext>;
  try {
    context = normalizeWorkerContext(suppliedContext);
  } catch {
    return false;
  }
  return record.walletAddress === context.walletAddress
    && record.chainId === context.chainId
    && record.deploymentId === context.deploymentId
    && record.vaultDeploymentId === context.vaultDeploymentId
    && record.origin === context.origin
    && record.manifestIdentity === context.manifestIdentity
    && record.manifestVersion === context.manifestVersion
    && context.expiresAtMs > record.createdAtMs
    && context.expiresAtMs <= record.expiresAtMs;
}

function defaultStorageEventSource(): WalletDeviceStorageEventSource | null {
  const candidate = globalThis as unknown as Partial<WalletDeviceStorageEventSource>;
  return typeof candidate.addEventListener === "function" && typeof candidate.removeEventListener === "function"
    ? candidate as WalletDeviceStorageEventSource
    : null;
}

function ownerForRecord(record: WalletDeviceSessionRecordV3): WalletDeviceKeyOwner {
  return {
    recordId: record.record_id,
    keyId: record.key_id,
    walletAddress: record.wallet_address,
    chainId: record.chain_id,
    deploymentId: record.deployment_id,
    vaultDeploymentId: record.vault_deployment_id,
    origin: record.origin,
    manifestIdentity: record.manifest_identity,
    manifestVersion: record.manifest_version,
  };
}

function ownersEqual(left: WalletDeviceKeyOwner, right: WalletDeviceKeyOwner): boolean {
  return left.recordId === right.recordId
    && left.keyId === right.keyId
    && left.walletAddress === right.walletAddress
    && left.chainId === right.chainId
    && left.deploymentId === right.deploymentId
    && left.vaultDeploymentId === right.vaultDeploymentId
    && left.origin === right.origin
    && left.manifestIdentity === right.manifestIdentity
    && left.manifestVersion === right.manifestVersion;
}

function validOwnedKeyEntry(value: unknown): value is { key: CryptoKey; owner: WalletDeviceKeyOwner } {
  if (!isRecord(value) || !isCryptoKey(value.key) || !isRecord(value.owner)) return false;
  const owner = value.owner;
  const entryKeys = Object.keys(value);
  const fields = [
    "recordId", "keyId", "walletAddress", "chainId", "deploymentId", "origin",
    "vaultDeploymentId", "manifestIdentity", "manifestVersion",
  ];
  const keys = Object.keys(owner);
  return entryKeys.length === 2
    && entryKeys.every((field) => field === "key" || field === "owner")
    && keys.length === fields.length
    && keys.every((field) => fields.includes(field))
    && typeof owner.recordId === "string" && /^[0-9a-f]{32}$/.test(owner.recordId)
    && typeof owner.keyId === "string" && /^[0-9a-f]{32}$/.test(owner.keyId)
    && isCanonicalNonzeroFelt(owner.walletAddress)
    && isCanonicalNonzeroFelt(owner.chainId)
    && isCanonicalNonzeroFelt(owner.deploymentId)
    && isCanonicalNonzeroFelt(owner.vaultDeploymentId)
    && isCanonicalOrigin(owner.origin)
    && typeof owner.manifestIdentity === "string"
    && normalizeManifestIdentifier(owner.manifestIdentity) === owner.manifestIdentity
    && typeof owner.manifestVersion === "string"
    && normalizeManifestIdentifier(owner.manifestVersion) === owner.manifestVersion;
}

export function createWalletDeviceWorkerService(
  options: WalletDeviceWorkerServiceOptions,
): WalletDeviceWorkerService {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  const subtle = options.subtle ?? crypto.subtle;

  function readNow() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
    }
    return value;
  }

  function randomIdentifier() {
    const bytes = exactRandomBytes(16);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  function exactRandomBytes(length: number): Uint8Array<ArrayBuffer> {
    let bytes: Uint8Array;
    try {
      bytes = randomBytes(length);
    } catch {
      throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
    }
    const inspected = inspectWorkerSeed(bytes);
    if (
      !inspected
      || inspected.byteOffset !== 0
      || inspected.byteLength !== length
      || inspected.bufferLength !== length
    ) {
      throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
    }
    return bytes as Uint8Array<ArrayBuffer>;
  }

  async function deleteOwned(owner: WalletDeviceKeyOwner) {
    try {
      return await options.keyStore.deleteOwned(owner);
    } catch {
      throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
    }
  }

  async function invalidate(record: WalletDeviceSessionRecordV3, code: WalletDeviceSessionErrorCode): Promise<never> {
    await deleteOwned(ownerForRecord(record));
    throw new WalletDeviceSessionError(code);
  }

  return {
    async prepare(seed, suppliedContext, ttlMs = WALLET_DEVICE_SESSION_DEFAULT_TTL_MS) {
      const inspectedSeed = inspectWorkerSeed(seed);
      if (
        !inspectedSeed
        || inspectedSeed.byteOffset !== 0
        || inspectedSeed.byteLength !== 32
        || inspectedSeed.bufferLength !== 32
      ) {
        throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
      }
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > WALLET_DEVICE_SESSION_MAX_TTL_MS) {
        throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
      }
      const context = normalizeWorkerContext(suppliedContext);
      const createdAt = readNow();
      const expiresAt = createdAt + ttlMs;
      if (
        !Number.isSafeInteger(expiresAt)
        || context.expiresAtMs <= createdAt
        || context.expiresAtMs > expiresAt
      ) {
        throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
      }
      const recordId = randomIdentifier();
      const keyId = randomIdentifier();
      const nonce = exactRandomBytes(12);
      let key: CryptoKey;
      try {
        key = await subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ) as CryptoKey;
      } catch {
        throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
      }
      if (!validWorkerKey(key, "encrypt")) {
        throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
      }
      const base = {
        version: WALLET_DEVICE_SESSION_VERSION,
        key_schedule_version: WALLET_KEY_SCHEDULE_VERSION,
        algorithm: "AES-GCM" as const,
        record_id: recordId,
        key_id: keyId,
        wallet_address: context.walletAddress,
        chain_id: context.chainId,
        deployment_id: context.deploymentId,
        vault_deployment_id: context.vaultDeploymentId,
        origin: context.origin,
        manifest_identity: context.manifestIdentity,
        manifest_version: context.manifestVersion,
        created_at_ms: createdAt,
        expires_at_ms: expiresAt,
      };
      const owner = ownerForRecord(base as WalletDeviceSessionRecordV3);
      let putAttempted = false;
      try {
        const ciphertext = new Uint8Array(await subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: workerRecordAad(base) },
          key,
          inspectedSeed.buffer,
        ));
        if (ciphertext.byteLength !== 32 + AES_GCM_TAG_BYTES) {
          throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
        }
        putAttempted = true;
        await options.keyStore.add({ key, owner });
        const completedAt = readNow();
        if (
          completedAt < createdAt
          || completedAt >= expiresAt
          || completedAt >= context.expiresAtMs
        ) {
          throw new WalletDeviceSessionError("DEVICE_SESSION_EXPIRED");
        }
        const raw = JSON.stringify({
          ...base,
          nonce: bytesToBase64(nonce),
          ciphertext: bytesToBase64(ciphertext),
        } satisfies WalletDeviceSessionRecordV3);
        return { raw, ownershipToken: recordId, expiresAtMs: expiresAt, keyId };
      } catch (error) {
        if (putAttempted) {
          try {
            await options.keyStore.deleteOwned(owner);
          } catch {
            throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
          }
        }
        if (error instanceof WalletDeviceSessionError) throw error;
        throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
      }
    },

    async open(raw, suppliedContext) {
      let record: WalletDeviceSessionRecordV3;
      try {
        record = parseWorkerRecord(raw);
      } catch {
        const cleanupOwner = invalidRecordCleanupOwner(raw, suppliedContext);
        if (cleanupOwner !== null) await deleteOwned(cleanupOwner);
        throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
      }
      let context: ReturnType<typeof normalizeWorkerContext>;
      try {
        context = normalizeWorkerContext(suppliedContext);
      } catch {
        return invalidate(record, "DEVICE_SESSION_INVALID");
      }
      if (!workerRecordMatches(record, context) || context.expiresAtMs > record.expires_at_ms) {
        return invalidate(record, "DEVICE_SESSION_INVALID");
      }
      const current = readNow();
      if (current < record.created_at_ms || current >= record.expires_at_ms) {
        return invalidate(record, "DEVICE_SESSION_EXPIRED");
      }
      let key: CryptoKey | null;
      try {
        key = await options.keyStore.getOwned(ownerForRecord(record));
      } catch {
        throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
      }
      if (!key || !validWorkerKey(key, "decrypt")) {
        return invalidate(record, "DEVICE_SESSION_INVALID");
      }
      let plaintext: Uint8Array;
      try {
        plaintext = new Uint8Array(await subtle.decrypt(
          {
            name: "AES-GCM",
            iv: base64ToBytes(record.nonce),
            additionalData: workerRecordAad(record),
          },
          key,
          base64ToBytes(record.ciphertext),
        ));
      } catch {
        return invalidate(record, "DEVICE_SESSION_INVALID");
      }
      if (plaintext.byteLength !== 32) {
        plaintext.fill(0);
        return invalidate(record, "DEVICE_SESSION_INVALID");
      }
      try {
        const after = readNow();
        if (after < record.created_at_ms || after >= record.expires_at_ms) {
          plaintext.fill(0);
          return invalidate(record, "DEVICE_SESSION_EXPIRED");
        }
        return plaintext;
      } catch (error) {
        plaintext.fill(0);
        if (error instanceof WalletDeviceSessionError) throw error;
        throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
      }
    },

    async discard(raw, ownershipToken) {
      const record = parseWorkerRecord(raw);
      if (record.record_id !== ownershipToken) {
        throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
      }
      await deleteOwned(ownerForRecord(record));
    },

    async retire(raw) {
      const record = parseWorkerRecord(raw);
      await deleteOwned(ownerForRecord(record));
    },
  };
}

export function normalizeWalletDeviceOrigin(value: unknown): string {
  if (typeof value !== "string") throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.origin.length === 0
      || parsed.origin.length > WALLET_DEVICE_SESSION_MAX_ORIGIN_LENGTH
    ) {
      throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
    }
    return parsed.origin;
  } catch (error) {
    if (error instanceof WalletDeviceSessionError) throw error;
    throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
  }
}

function normalizeMetadataText(value: string) {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function validBase64Bytes(value: unknown, bytes: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(bytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) return false;
  try {
    const binary = atob(value);
    return binary.length === bytes && btoa(binary) === value;
  } catch {
    return false;
  }
}

function normalizeMetadata(metadata: WalletDeviceSessionMetadata) {
  const normalized = {
    walletAddress: normalizeMetadataText(metadata.walletAddress),
    chainId: normalizeMetadataText(metadata.chainId),
    deploymentId: normalizeMetadataText(metadata.deploymentId),
    origin: metadata.origin.trim().toLowerCase(),
  };
  if (
    !normalized.walletAddress
    || !normalized.chainId
    || !normalized.deploymentId
    || !normalized.origin
  ) {
    throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
  }
  return normalized;
}

function normalizeWorkerContext(context: WalletDeviceWorkerContext) {
  try {
    const metadata = {
      ...normalizeMetadata(context),
      vaultDeploymentId: normalizeMetadataText(context.vaultDeploymentId),
      origin: normalizeWalletDeviceOrigin(context.origin),
    };
    if (
      !isCanonicalNonzeroFelt(metadata.walletAddress)
      || !isCanonicalNonzeroFelt(metadata.chainId)
      || !isCanonicalNonzeroFelt(metadata.deploymentId)
      || !isCanonicalNonzeroFelt(metadata.vaultDeploymentId)
      || !isCanonicalOrigin(metadata.origin)
    ) {
      throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
    }
    const manifestIdentity = normalizeManifestIdentifier(context.manifestIdentity);
    const manifestVersion = normalizeManifestIdentifier(context.manifestVersion);
    if (!Number.isSafeInteger(context.expiresAtMs) || context.expiresAtMs <= 0) {
      throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
    }
    return { ...metadata, manifestIdentity, manifestVersion, expiresAtMs: context.expiresAtMs };
  } catch (error) {
    if (error instanceof WalletDeviceSessionError) throw error;
    throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
  }
}

function parseWorkerRecord(raw: string): WalletDeviceSessionRecordV3 {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) {
    throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = parseWalletJson(raw, ["version", "created_at_ms", "expires_at_ms"]);
  } catch {
    throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
  }
  if (!validWorkerRecord(parsed)) {
    throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
  }
  return parsed;
}

function validWorkerRecord(value: unknown): value is WalletDeviceSessionRecordV3 {
  if (!isRecord(value)) return false;
  const fields = [
    "version",
    "key_schedule_version",
    "algorithm",
    "record_id",
    "key_id",
    "wallet_address",
    "chain_id",
    "deployment_id",
    "vault_deployment_id",
    "origin",
    "manifest_identity",
    "manifest_version",
    "created_at_ms",
    "expires_at_ms",
    "nonce",
    "ciphertext",
  ];
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) return false;
  const createdAt = value.created_at_ms;
  const expiresAt = value.expires_at_ms;
  return value.version === WALLET_DEVICE_SESSION_VERSION
    && value.key_schedule_version === WALLET_KEY_SCHEDULE_VERSION
    && value.algorithm === "AES-GCM"
    && typeof value.record_id === "string" && /^[0-9a-f]{32}$/.test(value.record_id)
    && typeof value.key_id === "string" && /^[0-9a-f]{32}$/.test(value.key_id)
    && isCanonicalNonzeroFelt(value.wallet_address)
    && isCanonicalNonzeroFelt(value.chain_id)
    && isCanonicalNonzeroFelt(value.deployment_id)
    && isCanonicalNonzeroFelt(value.vault_deployment_id)
    && isCanonicalOrigin(value.origin)
    && typeof value.manifest_identity === "string" && normalizeManifestIdentifier(value.manifest_identity) === value.manifest_identity
    && typeof value.manifest_version === "string" && normalizeManifestIdentifier(value.manifest_version) === value.manifest_version
    && typeof createdAt === "number" && Number.isSafeInteger(createdAt) && createdAt >= 0
    && typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > createdAt
    && expiresAt - createdAt <= WALLET_DEVICE_SESSION_MAX_TTL_MS
    && validBase64Bytes(value.nonce, 12)
    && validBase64Bytes(value.ciphertext, 32 + AES_GCM_TAG_BYTES);
}

function workerRecordAad(
  record: Omit<WalletDeviceSessionRecordV3, "nonce" | "ciphertext">,
) {
  return new TextEncoder().encode([
    "zylith/wallet-device-session/v3",
    String(record.version),
    String(record.key_schedule_version),
    record.algorithm,
    record.record_id,
    record.key_id,
    record.wallet_address,
    record.chain_id,
    record.deployment_id,
    record.vault_deployment_id,
    record.origin,
    record.manifest_identity,
    record.manifest_version,
    String(record.created_at_ms),
    String(record.expires_at_ms),
  ].join("\n"));
}

function workerRecordMatches(
  record: WalletDeviceSessionRecordV3,
  context: ReturnType<typeof normalizeWorkerContext>,
) {
  return record.wallet_address === context.walletAddress
    && record.chain_id === context.chainId
    && record.deployment_id === context.deploymentId
    && record.vault_deployment_id === context.vaultDeploymentId
    && record.origin === context.origin
    && record.manifest_identity === context.manifestIdentity
    && record.manifest_version === context.manifestVersion;
}

function normalizeManifestIdentifier(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/.test(value)
  ) {
    throw new WalletDeviceSessionError("DEVICE_SESSION_INVALID");
  }
  return value;
}

function isCanonicalNonzeroFelt(value: unknown): value is string {
  if (typeof value !== "string" || !/^0x[1-9a-f][0-9a-f]*$/.test(value)) return false;
  try {
    return BigInt(value) < STARKNET_FIELD_MODULUS;
  } catch {
    return false;
  }
}

function isCanonicalOrigin(value: unknown): value is string {
  try {
    return normalizeWalletDeviceOrigin(value) === value;
  } catch {
    return false;
  }
}

function validWorkerKey(key: CryptoKey, requiredUsage: KeyUsage) {
  try {
    const algorithm = key.algorithm as AesKeyAlgorithm;
    return key.extractable === false
      && algorithm.name === "AES-GCM"
      && algorithm.length === 256
      && key.type === "secret"
      && key.usages.length === 2
      && key.usages.includes("encrypt")
      && key.usages.includes("decrypt")
      && key.usages.includes(requiredUsage);
  } catch {
    return false;
  }
}

function invalidRecordCleanupOwner(
  raw: string,
  suppliedContext: WalletDeviceWorkerContext,
): WalletDeviceKeyOwner | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) return null;
  let value: unknown;
  let context: ReturnType<typeof normalizeWorkerContext>;
  try {
    value = parseWalletJson(raw, ["version", "created_at_ms", "expires_at_ms"]);
    context = normalizeWorkerContext(suppliedContext);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const owner: WalletDeviceKeyOwner = {
    recordId: value.record_id as string,
    keyId: value.key_id as string,
    walletAddress: value.wallet_address as string,
    chainId: value.chain_id as string,
    deploymentId: value.deployment_id as string,
    vaultDeploymentId: value.vault_deployment_id as string,
    origin: value.origin as string,
    manifestIdentity: value.manifest_identity as string,
    manifestVersion: value.manifest_version as string,
  };
  try {
    if (
      value.version !== WALLET_DEVICE_SESSION_VERSION
    || value.key_schedule_version !== WALLET_KEY_SCHEDULE_VERSION
    || value.algorithm !== "AES-GCM"
    || typeof owner.recordId !== "string" || !/^[0-9a-f]{32}$/.test(owner.recordId)
    || typeof owner.keyId !== "string" || !/^[0-9a-f]{32}$/.test(owner.keyId)
    || !isCanonicalNonzeroFelt(owner.walletAddress)
    || !isCanonicalNonzeroFelt(owner.chainId)
    || !isCanonicalNonzeroFelt(owner.deploymentId)
    || !isCanonicalNonzeroFelt(owner.vaultDeploymentId)
    || !isCanonicalOrigin(owner.origin)
    || typeof owner.manifestIdentity !== "string"
    || normalizeManifestIdentifier(owner.manifestIdentity) !== owner.manifestIdentity
    || typeof owner.manifestVersion !== "string"
    || normalizeManifestIdentifier(owner.manifestVersion) !== owner.manifestVersion
    || owner.walletAddress !== context.walletAddress
    || owner.chainId !== context.chainId
    || owner.deploymentId !== context.deploymentId
    || owner.vaultDeploymentId !== context.vaultDeploymentId
    || owner.origin !== context.origin
    || owner.manifestIdentity !== context.manifestIdentity
    || owner.manifestVersion !== context.manifestVersion
    ) return null;
  } catch {
    return null;
  }
  return owner;
}

function inspectWorkerSeed(value: unknown): {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
  bufferLength: number;
} | null {
  if (!ArrayBuffer.isView(value)) return null;
  try {
    if (DEVICE_TYPED_ARRAY_TAG_GETTER?.call(value) !== "Uint8Array") return null;
    const buffer = DEVICE_TYPED_ARRAY_BUFFER_GETTER?.call(value) as unknown;
    const bufferLength = DEVICE_ARRAY_BUFFER_LENGTH_GETTER?.call(buffer) as unknown;
    if (typeof bufferLength !== "number") return null;
    return {
      buffer: buffer as ArrayBuffer,
      byteOffset: DEVICE_TYPED_ARRAY_OFFSET_GETTER?.call(value) as number,
      byteLength: DEVICE_TYPED_ARRAY_LENGTH_GETTER?.call(value) as number,
      bufferLength,
    };
  } catch {
    return null;
  }
}
