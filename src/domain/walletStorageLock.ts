const LOCK_PREFIX = "zylith-wallet-storage:v1:";
const MAX_LOCK_NAME_CHARS = 160;

export type WalletStorageRecordKind = "device-session" | "signature-vault";

export interface WalletStorageLockManager {
  requestExclusive<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
}

interface BrowserLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T> | T,
  ): Promise<T>;
}

export function walletStorageLockName(
  kind: WalletStorageRecordKind,
  canonicalWalletAddress: string,
): string {
  const name = `${LOCK_PREFIX}${kind}:${canonicalWalletAddress}`;
  if (name.length > MAX_LOCK_NAME_CHARS) throw new Error("invalid wallet storage lock name");
  return name;
}

export function createBrowserWalletStorageLockManager(): WalletStorageLockManager {
  return {
    async requestExclusive<T>(name: string, callback: () => Promise<T> | T): Promise<T> {
      if (typeof name !== "string" || name.length === 0 || name.length > MAX_LOCK_NAME_CHARS) {
        throw new Error("wallet storage lock is invalid");
      }
      const candidate = globalThis.navigator as Navigator & { locks?: BrowserLockManager };
      const locks = candidate?.locks;
      if (!locks || typeof locks.request !== "function") {
        throw new Error("wallet storage lock is unavailable");
      }
      return locks.request(name, { mode: "exclusive" }, callback);
    },
  };
}
