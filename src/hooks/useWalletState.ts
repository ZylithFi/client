import { useEffect, useState } from "react";
import {
  type RuntimeStatus,
  walletRuntime,
  walletRuntimeStatus,
} from "../domain/browserWallet";

export function useWalletState(): {
  runtimeStatus: RuntimeStatus;
  walletReady: boolean;
  hasVault: boolean;
} {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(() =>
    walletRuntimeStatus()
  );
  const [walletReady, setWalletReady] = useState(() =>
    Boolean(window.zylithWallet?.isReady())
  );
  const [hasVault, setHasVault] = useState(() =>
    Boolean(window.zylithWallet?.hasVault())
  );

  useEffect(() => {
    function onReady() {
      setRuntimeStatus(walletRuntimeStatus());
    }
    window.addEventListener("zylith-wallet-runtime-ready", onReady);
    return () =>
      window.removeEventListener("zylith-wallet-runtime-ready", onReady);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const runtime = walletRuntime();
      setRuntimeStatus(walletRuntimeStatus());
      setWalletReady(Boolean(runtime?.isReady()));
      setHasVault(Boolean(runtime?.hasVault()));
    }, 800);
    return () => clearInterval(timer);
  }, []);

  return { runtimeStatus, walletReady, hasVault };
}
