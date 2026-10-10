import {
  isWalletSignatureVaultRecord,
  normalizeWalletSignatureVaultAddress,
  type WalletSignatureVaultRecord,
} from "./walletLocalCrypto";
import { WalletMigrationRequiredError, parseWalletJson } from "./walletVersion";
import {
  createBrowserWalletStorageLockManager,
  walletStorageLockName,
  type WalletStorageLockManager,
} from "./walletStorageLock";

const VAULT_STORAGE_PREFIX = "zylith.wallet.vault.v1:";
const MAX_VAULT_RECORD_CHARS = 4_096;
const VAULT_FIELDS = [
  "version",
  "key_schedule_version",
  "kdf",
  "algorithm",
  "wallet_address",
  "chain_id",
  "deployment_id",
  "origin",
  "message_version",
  "nonce",
  "ciphertext",
] as const;

export type WalletSignatureVaultStoreErrorCode =
  | "DATA_INVALID"
  | "STORAGE_FAILED";

export class WalletSignatureVaultStoreError extends Error {
  readonly code: WalletSignatureVaultStoreErrorCode;

  constructor(code: WalletSignatureVaultStoreErrorCode) {
    super(code);
    this.name = "WalletSignatureVaultStoreError";
    this.code = code;
  }
}

export interface WalletSignatureVaultSnapshot {
  raw: string;
  vault: WalletSignatureVaultRecord;
}

export interface WalletSignatureVaultStore {
  readRaw(walletAddress: string): string | null;
  read(walletAddress: string): WalletSignatureVaultSnapshot | null;
  publish(walletAddress: string, raw: string, isCurrent?: () => boolean): Promise<boolean>;
  subscribe(walletAddress: string, listener: (raw: string | null) => void): () => void;
}

interface WalletSignatureVaultStorageEventSource {
  addEventListener(type: "storage", listener: EventListener): void;
  removeEventListener(type: "storage", listener: EventListener): void;
}

export function walletSignatureVaultStorageKey(walletAddress: string): string {
  try {
    return `${VAULT_STORAGE_PREFIX}${normalizeWalletSignatureVaultAddress(walletAddress)}`;
  } catch {
    throw new WalletSignatureVaultStoreError("DATA_INVALID");
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function parseVault(raw: string, walletAddress: string): WalletSignatureVaultRecord {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_VAULT_RECORD_CHARS) {
    throw new WalletSignatureVaultStoreError("DATA_INVALID");
  }
  let publicParsed: unknown;
  try {
    publicParsed = JSON.parse(raw);
  } catch {
    throw new WalletSignatureVaultStoreError("DATA_INVALID");
  }
  const publicRecord = plainRecord(publicParsed);
  if (!publicRecord) throw new WalletSignatureVaultStoreError("DATA_INVALID");
  const publicKeys = Object.keys(publicRecord);
  if (publicKeys.length !== VAULT_FIELDS.length
    || publicKeys.some((key) => !(VAULT_FIELDS as readonly string[]).includes(key))
    || publicRecord.version !== 3
    || publicRecord.key_schedule_version !== 2
    || publicRecord.kdf !== "HKDF-SHA-256"
    || publicRecord.algorithm !== "AES-256-GCM"
    || publicRecord.message_version !== 2) {
    throw new WalletMigrationRequiredError();
  }
  let parsed: unknown;
  try {
    parsed = parseWalletJson(raw, ["version", "key_schedule_version", "message_version"]);
  } catch (error) {
    if (error instanceof WalletMigrationRequiredError) throw error;
    throw new WalletSignatureVaultStoreError("DATA_INVALID");
  }
  const record = plainRecord(parsed);
  if (!record) throw new WalletSignatureVaultStoreError("DATA_INVALID");
  const keys = Object.keys(record);
  if (keys.length !== VAULT_FIELDS.length
    || keys.some((key) => !(VAULT_FIELDS as readonly string[]).includes(key))
    || record.version !== 3
    || record.key_schedule_version !== 2
    || record.kdf !== "HKDF-SHA-256"
    || record.algorithm !== "AES-256-GCM"
    || record.message_version !== 2) {
    throw new WalletMigrationRequiredError();
  }
  if (!isWalletSignatureVaultRecord(record)) {
    throw new WalletSignatureVaultStoreError("DATA_INVALID");
  }
  if (record.wallet_address !== normalizeWalletSignatureVaultAddress(walletAddress)) {
    throw new WalletSignatureVaultStoreError("DATA_INVALID");
  }
  return record;
}

function defaultEventSource(): WalletSignatureVaultStorageEventSource | null {
  const candidate = globalThis as unknown as Partial<WalletSignatureVaultStorageEventSource>;
  return typeof candidate.addEventListener === "function"
    && typeof candidate.removeEventListener === "function"
    ? candidate as WalletSignatureVaultStorageEventSource
    : null;
}

export function createWalletSignatureVaultStore(
  storage: Storage,
  eventSource: WalletSignatureVaultStorageEventSource | null = defaultEventSource(),
  lockManager: WalletStorageLockManager = createBrowserWalletStorageLockManager(),
): WalletSignatureVaultStore {
  function readRaw(walletAddress: string): string | null {
    const key = walletSignatureVaultStorageKey(walletAddress);
    try {
      return storage.getItem(key);
    } catch {
      throw new WalletSignatureVaultStoreError("STORAGE_FAILED");
    }
  }

  return {
    readRaw,
    read(walletAddress) {
      const raw = readRaw(walletAddress);
      return raw === null ? null : { raw, vault: parseVault(raw, walletAddress) };
    },
    async publish(walletAddress, raw, isCurrent) {
      const canonicalWallet = normalizeVaultWallet(walletAddress);
      const key = walletSignatureVaultStorageKey(canonicalWallet);
      parseVault(raw, canonicalWallet);
      try {
        return await lockManager.requestExclusive(
          walletStorageLockName("signature-vault", canonicalWallet),
          async () => {
            if (isCurrent && !isCurrent()) return false;
            let current: string | null;
            try {
              current = storage.getItem(key);
            } catch {
              throw new WalletSignatureVaultStoreError("STORAGE_FAILED");
            }
            if (current !== null) return false;
            let mutationAttempted = false;
            try {
              mutationAttempted = true;
              storage.setItem(key, raw);
              return storage.getItem(key) === raw;
            } catch {
              if (mutationAttempted) {
                try {
                  if (storage.getItem(key) === raw) return true;
                } catch {
                  // the final publication state is unavailable
                }
              }
              throw new WalletSignatureVaultStoreError("STORAGE_FAILED");
            }
          },
        );
      } catch {
        throw new WalletSignatureVaultStoreError("STORAGE_FAILED");
      }
    },
    subscribe(walletAddress, listener) {
      const key = walletSignatureVaultStorageKey(walletAddress);
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
        throw new WalletSignatureVaultStoreError("STORAGE_FAILED");
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

function normalizeVaultWallet(walletAddress: string): string {
  try {
    return normalizeWalletSignatureVaultAddress(walletAddress);
  } catch {
    throw new WalletSignatureVaultStoreError("DATA_INVALID");
  }
}
