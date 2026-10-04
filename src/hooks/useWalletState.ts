import { useSyncExternalStore } from "react";
import {
  type RuntimeStatus,
  subscribeWalletRuntime,
  walletRuntime,
  walletRuntimeStatus,
} from "../domain/browserWallet";

type WalletStateSnapshot = {
  starknetAddress: string | null;
  runtimeStatus: RuntimeStatus;
  walletReady: boolean;
  hasVault: boolean;
};

const cachedSnapshots = new Map<string, WalletStateSnapshot>();

export function useWalletState(starknetAddress: string | null): {
  runtimeStatus: RuntimeStatus;
  walletReady: boolean;
  hasVault: boolean;
} {
  return useSyncExternalStore(
    subscribeWalletRuntime,
    () => walletStateSnapshot(starknetAddress),
    () => walletStateSnapshot(starknetAddress),
  );
}

function walletStateSnapshot(starknetAddress: string | null) {
  const runtime = walletRuntime();
  const cacheKey = starknetAddress ?? "";
  const next: WalletStateSnapshot = {
    starknetAddress,
    runtimeStatus: walletRuntimeStatus(),
    walletReady: Boolean(runtime?.isReady(starknetAddress)),
    hasVault: Boolean(runtime?.hasVault(starknetAddress)),
  };
  const cachedSnapshot = cachedSnapshots.get(cacheKey);
  if (
    cachedSnapshot?.runtimeStatus === next.runtimeStatus &&
    cachedSnapshot.walletReady === next.walletReady &&
    cachedSnapshot.hasVault === next.hasVault
  ) {
    return cachedSnapshot;
  }
  cachedSnapshots.set(cacheKey, next);
  return next;
}
