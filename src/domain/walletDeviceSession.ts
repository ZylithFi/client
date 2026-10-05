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

type WalletDeviceSessionRecord = {
  version: 1;
  algorithm: "AES-GCM";
  key_id: string;
  wallet_address: string;
  chain_id: string;
  deployment_id: string;
  origin: string;
  created_at_ms: number;
  expires_at_ms: number;
  nonce: string;
  ciphertext: string;
};

type WalletDeviceSessionManagerOptions = {
  storage: Storage;
  keyStore: WalletDeviceKeyStore;
  now?: () => number;
  ttlMs?: number;
};

export type WalletDeviceSessionManager = {
  hasRecord: (walletAddress: string) => boolean;
  expiresAt: (walletAddress: string) => number | null;
  seal: (seedHex: string, metadata: WalletDeviceSessionMetadata) => Promise<void>;
  open: (metadata: WalletDeviceSessionMetadata) => Promise<string | null>;
  revoke: (walletAddress: string) => Promise<void>;
};

const RECORD_PREFIX = "zylith.wallet.device-session.v1:";
const DEFAULT_DEVICE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_DEVICE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const AES_GCM_TAG_BYTES = 16;

export function createWalletDeviceSessionManager(
  options: WalletDeviceSessionManagerOptions,
): WalletDeviceSessionManager {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_DEVICE_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_DEVICE_SESSION_TTL_MS) {
    throw new Error("Wallet device session lifetime is invalid");
  }

  const recordKey = (walletAddress: string) =>
    `${RECORD_PREFIX}${normalizeMetadataText(walletAddress)}`;

  const read = (walletAddress: string): WalletDeviceSessionRecord | null => {
    try {
      const raw = options.storage.getItem(recordKey(walletAddress));
      if (!raw || raw.length > 2_048) return null;
      const parsed = JSON.parse(raw) as unknown;
      return validRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const revoke = async (walletAddress: string) => {
    const record = read(walletAddress);
    options.storage.removeItem(recordKey(walletAddress));
    if (record) await options.keyStore.delete(record.key_id).catch(() => undefined);
  };

  return {
    hasRecord(walletAddress) {
      const record = read(walletAddress);
      if (!record) return false;
      if (record.expires_at_ms > now()) return true;
      options.storage.removeItem(recordKey(walletAddress));
      void options.keyStore.delete(record.key_id).catch(() => undefined);
      return false;
    },

    expiresAt(walletAddress) {
      const record = read(walletAddress);
      return record?.expires_at_ms ?? null;
    },

    async seal(seedHex, metadata) {
      if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
        throw new Error("Wallet device session seed is invalid");
      }
      const normalized = normalizeMetadata(metadata);
      const createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new Error("Wallet device session clock is invalid");
      }
      const expiresAt = createdAt + ttlMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error("Wallet device session expiry is invalid");
      }
      const keyId = randomHex(16);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const plaintext = new TextEncoder().encode(seedHex);
      const recordBase = {
        version: 1 as const,
        algorithm: "AES-GCM" as const,
        key_id: keyId,
        wallet_address: normalized.walletAddress,
        chain_id: normalized.chainId,
        deployment_id: normalized.deploymentId,
        origin: normalized.origin,
        created_at_ms: createdAt,
        expires_at_ms: expiresAt,
      };
      let storedKey = false;
      try {
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: recordAad(recordBase),
          },
          key,
          plaintext,
        );
        const nextRecord: WalletDeviceSessionRecord = {
          ...recordBase,
          nonce: bytesToBase64(nonce),
          ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
        };
        const prior = read(normalized.walletAddress);
        await options.keyStore.put(keyId, key);
        storedKey = true;
        options.storage.setItem(
          recordKey(normalized.walletAddress),
          JSON.stringify(nextRecord),
        );
        if (prior && prior.key_id !== keyId) {
          await options.keyStore.delete(prior.key_id).catch(() => undefined);
        }
      } catch (error) {
        if (storedKey) {
          await options.keyStore.delete(keyId).catch(() => undefined);
        }
        throw error;
      } finally {
        plaintext.fill(0);
      }
    },

    async open(metadata) {
      const normalized = normalizeMetadata(metadata);
      const record = read(normalized.walletAddress);
      if (!record) return null;
      if (!recordMatches(record, normalized)) {
        await revoke(normalized.walletAddress);
        return null;
      }
      const currentTime = now();
      if (!Number.isSafeInteger(currentTime) || currentTime < record.created_at_ms) {
        await revoke(normalized.walletAddress);
        return null;
      }
      if (record.expires_at_ms <= currentTime) {
        await revoke(normalized.walletAddress);
        return null;
      }
      let key: CryptoKey | null;
      try {
        key = await options.keyStore.get(record.key_id);
      } catch {
        // a transient key-store failure (a blocked or busy database) is not proof the key is
        // gone. keep the session so the next attempt can open it.
        return null;
      }
      if (!key || key.extractable || key.algorithm.name !== "AES-GCM") {
        await revoke(normalized.walletAddress);
        return null;
      }
      try {
        const plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: base64ToBytes(record.nonce),
              additionalData: recordAad(record),
            },
            key,
            base64ToBytes(record.ciphertext),
          ),
        );
        try {
          const seedHex = new TextDecoder().decode(plaintext);
          if (/^[0-9a-fA-F]{64}$/.test(seedHex)) return seedHex;
          await revoke(normalized.walletAddress);
          return null;
        } finally {
          plaintext.fill(0);
        }
      } catch {
        await revoke(normalized.walletAddress);
        return null;
      }
    },

    revoke,
  };
}

export function createIndexedDbWalletDeviceKeyStore(): WalletDeviceKeyStore {
  const databaseName = "zylith-wallet-device-sessions-v1";
  const storeName = "keys";

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
      await transact<IDBValidKey>("readwrite", (store) => store.put(key, id));
    },
    async delete(id) {
      await transact<undefined>("readwrite", (store) => store.delete(id) as IDBRequest<undefined>);
    },
  };
}

function recordAad(record: Omit<WalletDeviceSessionRecord, "nonce" | "ciphertext">) {
  return new TextEncoder().encode([
    "zylith/wallet-device-session/v1",
    record.key_id,
    record.wallet_address,
    record.chain_id,
    record.deployment_id,
    record.origin,
    String(record.created_at_ms),
    String(record.expires_at_ms),
  ].join("\n"));
}

function normalizeMetadata(metadata: WalletDeviceSessionMetadata) {
  const normalized = {
    walletAddress: normalizeMetadataText(metadata.walletAddress),
    chainId: normalizeMetadataText(metadata.chainId),
    deploymentId: normalizeMetadataText(metadata.deploymentId),
    origin: metadata.origin.trim().toLowerCase(),
  };
  if (
    !normalized.walletAddress ||
    !normalized.chainId ||
    !normalized.deploymentId ||
    !normalized.origin
  ) {
    throw new Error("Wallet device session metadata is incomplete");
  }
  return normalized;
}

function normalizeMetadataText(value: string) {
  return value.trim().toLowerCase();
}

function recordMatches(
  record: WalletDeviceSessionRecord,
  metadata: ReturnType<typeof normalizeMetadata>,
) {
  return record.wallet_address === metadata.walletAddress &&
    record.chain_id === metadata.chainId &&
    record.deployment_id === metadata.deploymentId &&
    record.origin === metadata.origin;
}

function validRecord(value: unknown): value is WalletDeviceSessionRecord {
  if (!isRecord(value)) return false;
  const createdAt = value.created_at_ms;
  const expiresAt = value.expires_at_ms;
  const keys = Object.keys(value);
  if (
    keys.length !== 11 ||
    keys.some((key) => ![
      "version",
      "algorithm",
      "key_id",
      "wallet_address",
      "chain_id",
      "deployment_id",
      "origin",
      "created_at_ms",
      "expires_at_ms",
      "nonce",
      "ciphertext",
    ].includes(key))
  ) return false;
  return value.version === 1 &&
    value.algorithm === "AES-GCM" &&
    typeof value.key_id === "string" && /^[0-9a-f]{32}$/.test(value.key_id) &&
    typeof value.wallet_address === "string" && value.wallet_address.length <= 80 &&
    typeof value.chain_id === "string" && value.chain_id.length <= 80 &&
    typeof value.deployment_id === "string" && value.deployment_id.length <= 80 &&
    typeof value.origin === "string" && value.origin.length <= 256 &&
    typeof createdAt === "number" && Number.isSafeInteger(createdAt) && createdAt >= 0 &&
    typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > createdAt &&
    expiresAt - createdAt <= MAX_DEVICE_SESSION_TTL_MS &&
    validBase64Bytes(value.nonce, 12) &&
    validBase64Bytes(value.ciphertext, 64 + AES_GCM_TAG_BYTES);
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
    return atob(value).length === bytes;
  } catch {
    return false;
  }
}
