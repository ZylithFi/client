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

let cachedSnapshot: WalletStateSnapshot | null = null;

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
  const next: WalletStateSnapshot = {
    starknetAddress,
    runtimeStatus: walletRuntimeStatus(),
    walletReady: Boolean(runtime?.isReady()),
    hasVault: Boolean(runtime?.hasVault(starknetAddress)),
  };
  if (
    cachedSnapshot &&
    cachedSnapshot.starknetAddress === next.starknetAddress &&
    cachedSnapshot.runtimeStatus === next.runtimeStatus &&
    cachedSnapshot.walletReady === next.walletReady &&
    cachedSnapshot.hasVault === next.hasVault
  ) {
    return cachedSnapshot;
  }
  cachedSnapshot = next;
  return next;
}
