import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { assetDecimals, safeFromAtomicStr, toAtomicStr } from "../domain/assets";
import {
  type RuntimeStatus,
  type StarknetWalletOption,
  connectStarknetProvider,
  clearSelectedStarknetProvider,
  disconnectStarknetProvider,
  discoverStarknetWalletsAsync,
  discoverStarknetWallets,
  fmtAddr,
  selectedStarknetProvider,
  walletRuntimeLoadError,
  walletRuntime,
} from "../domain/browserWallet";
import { requirePrivateStrk20Support } from "../domain/starknetWalletCapabilities";
import {
  runPrimaryActionOnEnter,
  shouldRunPrimaryActionForEnter,
} from "../domain/primaryEnter";
import { getPrivacyFundingStage } from "../domain/privacyFundingStage";
import type { WithdrawableNote } from "@zylith/sdk";
import {
  failureFromCode,
  normalizeFailure,
  sanitizedDiagnosticReport,
  type NormalizedFailure,
} from "../domain/userFacingErrors";
import { loadDeployment } from "../domain/deployment";
import { ensureWalletChain, preflightWalletAction } from "../wallet/starknetProvider";
import { FailureNotice } from "./FailureNotice";
import { ChevronDownIcon } from "../finalui/components/Icons";
import { TokenIcon } from "../finalui/components/TokenIcon";

async function switchSelectedWalletNetwork() {
  const provider = selectedStarknetProvider();
  if (!provider) throw new Error("Connect a Starknet wallet first.");
  return ensureWalletChain(provider, await loadDeployment());
}

async function preflightSelectedWalletAction(address: string) {
  const provider = selectedStarknetProvider();
  if (!provider) throw new Error("Connect a Starknet wallet first.");
  return preflightWalletAction(provider, await loadDeployment(), address);
}

async function copySupportDetails(failure: NormalizedFailure) {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
  await navigator.clipboard.writeText(sanitizedDiagnosticReport(failure));
}

export function privacyFundingStageLabel(stage: string) {
  const cleaned = stage
    .replace(/^setup:\s*/i, "")
    .replace(/^Private deposit\s*/i, "deposit ")
    .replace(/^Private withdrawal\s*/i, "withdrawal ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function currentPrivacyFundingStageLabel(sinceUnixMs = 0) {
  const snapshot = getPrivacyFundingStage(sinceUnixMs);
  if (!snapshot) return "";
  return privacyFundingStageLabel(snapshot.stage);
}

function useSlideDialog(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLDivElement | null>,
) {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.inert = !open;
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const siblings = panel.parentElement
      ? [...panel.parentElement.children].filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement
            && element !== panel
            && !element.classList.contains("slide-panel"),
        )
      : [];
    for (const sibling of siblings) sibling.inert = true;
    panel.focus({ preventScroll: true });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ), ...document.querySelectorAll<HTMLElement>(
        '[data-slide-dialog-portal] button:not([disabled]), [data-slide-dialog-portal] input:not([disabled]), [data-slide-dialog-portal] [href]',
      )].filter((element) => !element.hidden && !element.inert);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const sibling of siblings) sibling.inert = false;
      previousFocusRef.current?.focus({ preventScroll: true });
      previousFocusRef.current = null;
    };
  }, [open, panelRef]);
}

async function ensureTradingAuthorized(
  starknetAddress: string,
  onStage?: (stage: string) => void
) {
  const runtime = walletRuntime();
  if (!runtime) {
    throw new Error(
      walletRuntimeLoadError() ?? "Private trading failed to load."
    );
  }
  if (runtime.isReady(starknetAddress)) return runtime;
  onStage?.("Connecting wallet");
  const mode = runtime.vaultAuthMode?.(starknetAddress) ?? "none";
  const hasSignatureVault = runtime.hasVault?.(starknetAddress)
    ?? mode === "wallet-signature";
  let ok = mode === "device-session"
    ? await runtime.unlockWithDeviceSession(starknetAddress)
    : false;
  if (!ok && hasSignatureVault) {
    ok = await runtime.unlockWithWalletSignature(starknetAddress);
  }
  if (!ok && !hasSignatureVault) {
    ok = await runtime.createWalletWithWalletSignature(starknetAddress);
  }
  if (!ok || !runtime.isReady(starknetAddress)) {
    throw new Error("Trading authorization failed. Retry in your wallet.");
  }
  return runtime;
}

/** notes of `asset` that can start, or retry, a withdrawal: largest first. */
function selectableWithdrawNotes(notes: WithdrawableNote[], asset: string) {
  return notes
    .filter((note) =>
      note.asset === asset
      && /^\d+$/.test(note.amount)
      && !note.spent
      && (!note.locked || note.exit_stage === "failed")
    )
    .sort((left, right) => {
      const leftAmount = BigInt(left.amount);
      const rightAmount = BigInt(right.amount);
      if (leftAmount !== rightAmount) return leftAmount > rightAmount ? -1 : 1;
      return left.note_commitment.localeCompare(right.note_commitment);
    });
}

function TransferRoute({
  from,
  to,
}: {
  from: string;
  to: string;
}) {
  return (
    <div className="funding-route" aria-label={`${from} to ${to}`}>
      <div>
        <span>From</span>
        <strong>{from}</strong>
      </div>
      <i aria-hidden="true">→</i>
      <div>
        <span>To</span>
        <strong>{to}</strong>
      </div>
    </div>
  );
}

function AssetPicker({
  value,
  options,
  onChange,
  compact = false,
  active = true,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  compact?: boolean;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  function positionMenu() {
    const trigger = rootRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const menuWidth = compact ? 174 : trigger.width;
    const left = Math.min(
      Math.max(12, trigger.right - menuWidth),
      window.innerWidth - menuWidth - 12
    );
    setMenuStyle({
      left,
      top: trigger.bottom + 7,
      width: menuWidth,
    });
  }

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    const trigger = rootRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!trigger || !menu) return;
    if (trigger.bottom + 7 + menu.height > window.innerHeight - 12) {
      setMenuStyle((current) => ({
        ...current,
        top: Math.max(12, trigger.top - menu.height - 7),
      }));
    }
  }, [compact, open, options.length]);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const selected = menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      (selected ?? menuRef.current?.querySelector<HTMLElement>("button"))?.focus();
    });
    const closeOnOutside = (event: Event) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const closeOnViewportChange = () => setOpen(false);
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("focusin", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("focusin", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [open]);

  return (
    <div
      className={`funding-asset-picker ${compact ? "compact" : ""}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        className="funding-asset-trigger"
        type="button"
        role="combobox"
        aria-label="Asset"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        value={value}
        onClick={() => {
          if (!open) positionMenu();
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) positionMenu();
            setOpen(true);
          }
        }}
      >
        <TokenIcon token={value} size={20} />
        <strong>{value}</strong>
        <ChevronDownIcon className="icon-14" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className="funding-asset-menu portal"
          data-slide-dialog-portal="true"
          role="listbox"
          aria-label="Assets"
          style={menuStyle}
          onKeyDown={(event) => {
            const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            let next = index;
            if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
            else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = items.length - 1;
            else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
              return;
            } else return;
            event.preventDefault();
            items[next]?.focus();
          }}
        >
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === value}
              className={option === value ? "selected" : ""}
              onClick={() => {
                onChange(option);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <TokenIcon token={option} size={20} />
              <strong>{option}</strong>
              <span aria-hidden="true">{option === value ? "✓" : ""}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

const EXIT_STAGE_LABELS: Record<NonNullable<WithdrawableNote["exit_stage"]>, string> = {
  requested: "Submitted",
  proving: "Preparing",
  maturing: "Processing",
  finalized: "Ready",
  claiming: "Receiving",
  failed: "Failed",
};

function failureBlocksFinancialAction(failure: NormalizedFailure | null) {
  if (!failure) return false;
  if (failure.outcome === "unknown" || failure.outcome === "submitted" || failure.outcome === "failed") {
    return true;
  }
  if (failure.recovery === "refresh-state" || failure.recovery === "check-status" || failure.recovery === "contact-support") {
    return true;
  }
  return failure.recovery === "none" && failure.severity !== "informational";
}

export function WalletSlide({
  open,
  onClose,
  runtimeStatus,
  hasVault,
  starknetAddress,
  onStarknetConnected,
  onStarknetDisconnected,
}: {
  open: boolean;
  onClose: () => void;
  runtimeStatus: RuntimeStatus;
  hasVault: boolean;
  starknetAddress: string | null;
  onStarknetConnected: (addr: string) => void;
  onStarknetDisconnected: () => void;
}) {
  const [error, setError] = useState<NormalizedFailure | null>(null);
  const [working, setWorking] = useState(false);
  const [connectingWalletId, setConnectingWalletId] = useState<string | null>(
    null
  );
  const [walletOptions, setWalletOptions] = useState<StarknetWalletOption[]>(
    []
  );
  const [walletScanState, setWalletScanState] = useState<
    "idle" | "scanning" | "complete"
  >("idle");
  const [showStarknetFirstHint, setShowStarknetFirstHint] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scanGenerationRef = useRef(0);
  const walletScannerActiveRef = useRef(false);
  const walletScanInFlightRef = useRef<Promise<void> | null>(null);
  const autoPrivateSetupAttemptRef = useRef<string | null>(null);
  const authorizationGenerationRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const w = walletRuntime();
  const connectedVaultAuthMode = w?.vaultAuthMode?.(starknetAddress) ??
    (starknetAddress && hasVault ? "wallet-signature" : "none");
  const connectedHasVault = connectedVaultAuthMode !== "none";
  const runtimeFailure = !w && runtimeStatus !== "loading"
    ? normalizeFailure(walletRuntimeLoadError(), {
        domain: "application",
        operation: "load",
        stage: "private-runtime-load",
        presentation: "inline",
      })
    : null;
  useSlideDialog(open, onClose, panelRef);

  async function refreshWalletOptions({
    showLoading = false,
  }: { showLoading?: boolean } = {}) {
    if (walletScanInFlightRef.current) return walletScanInFlightRef.current;
    const scan = (async () => {
      const scanGeneration = scanGenerationRef.current + 1;
      scanGenerationRef.current = scanGeneration;
      if (showLoading) setWalletScanState("scanning");
      const immediateOptions = discoverStarknetWallets();
      if (walletScannerActiveRef.current) {
        setWalletOptions(immediateOptions);
        if (immediateOptions.length > 0) setWalletScanState("complete");
      }
      try {
        const options = await discoverStarknetWalletsAsync();
        if (scanGenerationRef.current !== scanGeneration) return;
        if (!walletScannerActiveRef.current) return;
        setWalletOptions(options);
      } finally {
        if (
          walletScannerActiveRef.current &&
          scanGenerationRef.current === scanGeneration
        ) setWalletScanState("complete");
      }
    })();
    walletScanInFlightRef.current = scan;
    try {
      await scan;
    } finally {
      if (walletScanInFlightRef.current === scan) walletScanInFlightRef.current = null;
    }
  }

  useEffect(() => {
    if (!open) return undefined;
    walletScannerActiveRef.current = true;
    setError(null);
    setShowStarknetFirstHint(false);
    void refreshWalletOptions({ showLoading: true });
    const refresh = () => void refreshWalletOptions();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("starknet#initialized", refresh);
    return () => {
      walletScannerActiveRef.current = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("starknet#initialized", refresh);
    };
  }, [open, connectedVaultAuthMode]);

  useEffect(() => {
    if (!open || !starknetAddress) {
      autoPrivateSetupAttemptRef.current = null;
      authorizationGenerationRef.current += 1;
      if (!open) {
        setWorking(false);
        setConnectingWalletId(null);
      }
    }
  }, [open, starknetAddress]);

  async function handleConnectStarknet(wallet: StarknetWalletOption) {
    const connectionGeneration = ++authorizationGenerationRef.current;
    setConnectingWalletId(wallet.id);
    setError(null);
    try {
      const addr = await connectStarknetProvider(wallet.provider, wallet.id);
      if (
        authorizationGenerationRef.current !== connectionGeneration
        || !openRef.current
      ) return;
      if (addr) {
        setShowStarknetFirstHint(false);
        onStarknetConnected(addr);
        setConnectingWalletId(null);
      } else setError(failureFromCode("WALLET_CONNECT_REQUIRED", {
        stage: "wallet-connect",
      }));
    } catch (e) {
      if (authorizationGenerationRef.current === connectionGeneration) {
        setError(normalizeFailure(e, {
          domain: "wallet",
          operation: "connect",
          stage: "wallet-connect",
          presentation: "inline",
        }));
      }
    } finally {
      if (authorizationGenerationRef.current === connectionGeneration) {
        setConnectingWalletId(null);
      }
    }
  }

  function handleChangeStarknetWallet() {
    autoPrivateSetupAttemptRef.current = null;
    authorizationGenerationRef.current += 1;
    setWorking(false);
    setConnectingWalletId(null);
    walletRuntime()?.suspend?.();
    clearSelectedStarknetProvider();
    onStarknetDisconnected();
    void refreshWalletOptions({ showLoading: true });
    setError(null);
  }

  function handleDisconnectStarknetWallet() {
    autoPrivateSetupAttemptRef.current = null;
    authorizationGenerationRef.current += 1;
    setWorking(false);
    setConnectingWalletId(null);
    walletRuntime()?.lock();
    disconnectStarknetProvider();
    onStarknetDisconnected();
    void refreshWalletOptions({ showLoading: true });
    setError(null);
  }

  async function enablePrivateTradingForAddress(
    address: string,
    { forceRetry = false }: { forceRetry?: boolean } = {}
  ) {
    if (!w) {
      setError(failureFromCode("TRADING_UNAVAILABLE", {
        stage: "private-runtime-load",
        presentation: "inline",
      }));
      return;
    }
    if (w.isReady?.(address)) {
      if (openRef.current) onClose();
      return;
    }
    const addressVaultAuthMode = w.vaultAuthMode?.(address) ?? "none";
    const addressHasVault = addressVaultAuthMode !== "none";
    const addressHasSignatureVault = w.hasVault?.(address)
      ?? addressVaultAuthMode === "wallet-signature";
    const attemptKey = `${address.toLowerCase()}:${
      addressHasVault ? addressVaultAuthMode : "new"
    }`;
    if (forceRetry) autoPrivateSetupAttemptRef.current = null;
    if (autoPrivateSetupAttemptRef.current === attemptKey) return;
    autoPrivateSetupAttemptRef.current = attemptKey;
    const authorizationGeneration = ++authorizationGenerationRef.current;
    setWorking(true);
    setError(null);
    let completed = false;
    try {
      const networkReadiness = await preflightSelectedWalletAction(address);
      if (networkReadiness === "switched") {
        if (w.isReady?.(address)) await w.refresh();
        return;
      }
      let authorized = false;
      if (addressVaultAuthMode === "device-session") {
        authorized = await w.unlockWithDeviceSession(address);
      }
      if (!authorized && addressHasSignatureVault) {
        authorized = await w.unlockWithWalletSignature(address);
      }
      if (!authorized && !addressHasSignatureVault) {
        authorized = await w.createWalletWithWalletSignature(address);
      }
      if (!authorized || !w.isReady(address)) {
        throw new Error("Trading authorization failed. Retry in your wallet.");
      }
      if (
        autoPrivateSetupAttemptRef.current !== attemptKey
        || authorizationGenerationRef.current !== authorizationGeneration
      ) return;
      completed = true;
      if (openRef.current) onClose();
    } catch (e) {
      if (
        autoPrivateSetupAttemptRef.current === attemptKey
        && authorizationGenerationRef.current === authorizationGeneration
      ) {
        setError(normalizeFailure(e, {
          domain: "wallet",
          operation: "authorize",
          stage: "private-authorization",
          presentation: "inline",
        }));
      }
    } finally {
      if (
        autoPrivateSetupAttemptRef.current === attemptKey
        && authorizationGenerationRef.current === authorizationGeneration
      ) {
        if (!completed) autoPrivateSetupAttemptRef.current = attemptKey;
        setWorking(false);
      }
    }
  }

  async function handleEnablePrivateTrading() {
    if (!starknetAddress) {
      setShowStarknetFirstHint(true);
      return;
    }
    return enablePrivateTradingForAddress(starknetAddress, {
      forceRetry: true,
    });
  }

  async function handleSwitchNetwork() {
    try {
      await switchSelectedWalletNetwork();
      setError(null);
      await refreshWalletStatus();
    } catch (switchError) {
      setError(normalizeFailure(switchError, {
        domain: "network",
        operation: "read",
        stage: "wallet-network-switch",
        presentation: "inline",
      }));
    }
  }

  async function refreshWalletStatus() {
    const runtime = walletRuntime();
    if (!runtime) {
      setError(failureFromCode("TRADING_UNAVAILABLE", {
        stage: "wallet-refresh",
        presentation: "inline",
      }));
      return;
    }
    try {
      await runtime.refresh();
    } catch (refreshError) {
      setError(normalizeFailure(refreshError, {
        domain: "wallet",
        operation: "read",
        stage: "wallet-refresh",
        presentation: "inline",
      }));
    }
  }

  const divider = (
    <div
      style={{ margin: "16px 0", boxShadow: "inset 0 -1px 0 var(--z-border)" }}
    />
  );
  const hasStarknetAccount = Boolean(starknetAddress);
  const privateSetupBlocked = failureBlocksFinancialAction(error);
  const createEnabled = hasStarknetAccount && !working && !privateSetupBlocked;
  const authorizeEnabled = hasStarknetAccount && !working && !privateSetupBlocked;
  const handlePrimaryEnter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!hasStarknetAccount && shouldRunPrimaryActionForEnter(event)) {
      event.preventDefault();
      setShowStarknetFirstHint(true);
      return;
    }
    runPrimaryActionOnEnter(event, authorizeEnabled, () => {
      void handleEnablePrivateTrading();
    });
  };

  function requireStarknetFirst() {
    if (hasStarknetAccount) return false;
    setShowStarknetFirstHint(true);
    return true;
  }

  return (
    <div
      ref={panelRef}
      className={`slide-panel ${open ? "open" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Connect wallet"
      aria-hidden={!open}
      tabIndex={-1}
    >
      <div className="slide-hd">
        <span className="slide-title">Connect Wallet</span>
        <button type="button" className="slide-close" aria-label="Close wallet" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="slide-body" onKeyDown={handlePrimaryEnter}>
        {!w && runtimeStatus === "loading" && (
          <div
            style={{
              fontSize: 13,
              color: "var(--z-status-warn)",
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            Private trading loading…
          </div>
        )}
        {runtimeFailure && (
          <FailureNotice
            failure={runtimeFailure}
            className="slide-inline-notice"
            actions={{ retry: () => window.location.reload() }}
          />
        )}

        <div className="f-label" style={{ marginBottom: 10 }}>
          Starknet account
        </div>
        {starknetAddress ? (
          <div className="wallet-connected-box">
            <div className="wallet-connected-row">
              <span className="wallet-connected-dot" />
              <span className="wallet-connected-address">
                {fmtAddr(starknetAddress)}
              </span>
              <span className="wallet-connected-status">Connected</span>
            </div>
            <div className="wallet-connected-actions">
              <button type="button" onClick={handleChangeStarknetWallet}>
                Change wallet
              </button>
              <button type="button" onClick={handleDisconnectStarknetWallet}>
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <>
            {walletScanState === "scanning" ? (
              <div className="wallet-empty">
                <strong>Scanning wallets</strong>
                <span>Open your Starknet wallet extension.</span>
              </div>
            ) : walletOptions.length > 0 ? (
              <div className="wallet-choice-list">
                {walletOptions.map((wallet) => (
                  <button
                    key={wallet.id}
                    type="button"
                    className="wallet-choice-row"
                    disabled={Boolean(connectingWalletId)}
                    onClick={() => {
                      void handleConnectStarknet(wallet);
                    }}
                  >
                    <span className="wallet-choice-mark" />
                    <span className="wallet-choice-copy">
                      <strong>{wallet.name}</strong>
                    </span>
                    <em>
                      {connectingWalletId === wallet.id
                        ? "Connecting"
                        : "Connect"}
                    </em>
                  </button>
                ))}
              </div>
            ) : (
              <div className="wallet-empty">
                <strong>No Starknet wallet found</strong>
                <span>Open Xverse or another compatible Starknet wallet, then scan again.</span>
                <button
                  type="button"
                  className="wallet-recover-link compact"
                  onClick={() => {
                    void refreshWalletOptions({ showLoading: true });
                  }}
                >
                  Scan wallets
                </button>
              </div>
            )}
          </>
        )}

        {hasStarknetAccount && divider}

        {showStarknetFirstHint && !hasStarknetAccount && (
          <div className="slide-note warn">
            Connect a Starknet wallet first.
          </div>
        )}

        {hasStarknetAccount && !error && (
          <button
            className="slide-submit"
            type="button"
            disabled={!createEnabled}
            onClick={() => {
              if (requireStarknetFirst()) return;
              void handleEnablePrivateTrading();
            }}
          >
            {working
              ? "Connecting…"
              : privateSetupBlocked
              ? "Private trading unavailable"
              : connectedHasVault
                ? "Unlock private balance"
                : "Enable private trading"}
          </button>
        )}

        {error && (
          <FailureNotice
            failure={error}
            className="slide-inline-notice"
            actions={{
              retry: handleEnablePrivateTrading,
              reconnect: error.code === "WALLET_PRIVATE_ACTION_UNSUPPORTED"
                ? handleChangeStarknetWallet
                : starknetAddress
                  ? handleEnablePrivateTrading
                  : () => refreshWalletOptions({ showLoading: true }),
              switchNetwork: handleSwitchNetwork,
              refreshState: refreshWalletStatus,
              checkStatus: refreshWalletStatus,
              contactSupport: () => copySupportDetails(error),
              dismiss: error.presentation === "toast" ? () => setError(null) : undefined,
            }}
          />
        )}
      </div>
    </div>
  );
}

export function DepositSlide({
  open,
  onClose,
  defaultAsset,
  allAssets,
  starknetAddress,
  walletReady,
  onOpenWallet,
  setSlideAsset,
}: {
  open: boolean;
  onClose: () => void;
  defaultAsset: string;
  allAssets: string[];
  starknetAddress: string | null;
  walletReady: boolean;
  onOpenWallet: () => void;
  setSlideAsset: (v: string) => void;
}) {
  const [asset, setAsset] = useState(defaultAsset);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<NormalizedFailure | null>(null);
  const [working, setWorking] = useState(false);
  const [fundingStage, setFundingStage] = useState("");
  const [privateApiSupported, setPrivateApiSupported] = useState<boolean | null>(null);
  const amountInputRef = useRef<HTMLInputElement | null>(null);
  const blockedDepositInputRef = useRef<string | null>(null);
  const depositReconciliationObservedRef = useRef(false);
  const wasOpenRef = useRef(false);
  const depositStartedAtRef = useRef(0);
  const operationInFlightRef = useRef(false);
  const openRef = useRef(open);
  const openGenerationRef = useRef(0);
  const previousOpenRef = useRef(open);
  if (open !== previousOpenRef.current) {
    previousOpenRef.current = open;
    openGenerationRef.current += 1;
  }
  openRef.current = open;
  const panelRef = useRef<HTMLDivElement | null>(null);
  useSlideDialog(open, onClose, panelRef);

  useEffect(() => {
    if (!working) {
      setFundingStage("");
      return;
    }
    const update = () => {
      const label = currentPrivacyFundingStageLabel(
        depositStartedAtRef.current
      );
      if (label) setFundingStage(label);
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [working]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      depositReconciliationObservedRef.current = false;
      blockedDepositInputRef.current = null;
      setAsset(
        allAssets.includes(defaultAsset)
          ? defaultAsset
          : allAssets[0] ?? defaultAsset
      );
      setAmount("");
      setError(null);
    }
    wasOpenRef.current = open;
  }, [open, defaultAsset, allAssets]);

  useEffect(() => {
    let cancelled = false;
    setPrivateApiSupported(null);
    if (!open || !starknetAddress) return () => { cancelled = true; };
    const provider = selectedStarknetProvider();
    if (!provider) return () => { cancelled = true; };
    void requirePrivateStrk20Support(provider).then(() => {
      if (!cancelled) setPrivateApiSupported(true);
    }).catch((capabilityError) => {
      if (!cancelled) {
        setPrivateApiSupported(false);
        setError(normalizeFailure(capabilityError, {
          domain: "wallet",
          operation: "deposit",
          stage: "deposit-capability",
          presentation: "inline",
        }));
      }
    });
    return () => { cancelled = true; };
  }, [open, starknetAddress]);

  function changeAsset(a: string) {
    setAsset(a);
    setSlideAsset(a);
    if (error?.recovery === "edit-input") setError(null);
  }

  async function handleDeposit() {
    if (operationInFlightRef.current) return;
    const openGeneration = openGenerationRef.current;
    const w = walletRuntime();
    if (!starknetAddress) {
      setError(null);
      onOpenWallet();
      return;
    }
    if (!amount.trim()) {
      setError(failureFromCode("INVALID_AMOUNT", {
        domain: "deposit",
        stage: "deposit-amount",
        presentation: "field",
      }));
      return;
    }
    const fractionalDigits = amount.split(".")[1]?.length ?? 0;
    let supportedDecimals: number | undefined;
    try {
      supportedDecimals = assetDecimals(asset);
    } catch {
      supportedDecimals = undefined;
    }
    if (supportedDecimals !== undefined && fractionalDigits > supportedDecimals) {
      setError(failureFromCode("PRECISION_UNSUPPORTED", {
        domain: "deposit",
        stage: "deposit-amount",
        presentation: "field",
        asset,
        precision: supportedDecimals,
      }));
      return;
    }
    let atomicAmount: string;
    try {
      atomicAmount = toAtomicStr(amount, asset);
    } catch (parseError) {
      setError(failureFromCode("INVALID_AMOUNT", {
        domain: "deposit",
        stage: "deposit-amount",
        presentation: "field",
      }));
      return;
    }
    if (atomicAmount === "0") {
      setError(failureFromCode("INVALID_AMOUNT", {
        domain: "deposit",
        stage: "deposit-amount",
        presentation: "field",
      }));
      return;
    }
    operationInFlightRef.current = true;
    depositStartedAtRef.current = Date.now();
    setWorking(true);
    setError(null);
    setFundingStage(
      walletReady && w?.isReady(starknetAddress) ? "Preparing deposit" : "Connecting wallet"
    );
    const updateStage = (stage: string) => {
      if (openGenerationRef.current === openGeneration) setFundingStage(stage);
    };
    let submissionAttempted = false;
    try {
      const networkReadiness = await preflightSelectedWalletAction(starknetAddress);
      if (networkReadiness === "switched") {
        updateStage("");
        if (w?.isReady(starknetAddress)) await w.refresh();
        return;
      }
      const authorizedRuntime = await ensureTradingAuthorized(
        starknetAddress,
        updateStage
      );
      updateStage("Preparing deposit");
      submissionAttempted = true;
      await authorizedRuntime.submitDepositViaWallet(asset, atomicAmount);
      if (openGenerationRef.current === openGeneration) {
        setAmount("");
        if (openRef.current) onClose();
      }
    } catch (e) {
      if (openGenerationRef.current === openGeneration) {
        const failure = normalizeFailure(e, {
          domain: "deposit",
          operation: "deposit",
          outcome: submissionAttempted ? "unknown" : "not-submitted",
          stage: "deposit-submission",
          presentation: "status-screen",
          asset,
          requiredAmount: amount,
        });
        if (failure.code === "PRIVACY_SAFETY_BLOCK") {
          blockedDepositInputRef.current = `${asset}:${amount}`;
        }
        setError(failure);
      }
    } finally {
      operationInFlightRef.current = false;
      setWorking(false);
    }
  }
  const unresolvedDeposit = walletReady
    ? walletRuntime()?.getPendingDeposits?.().find(
        (deposit) => !deposit.confirmed && !deposit.failed
      ) ?? null
    : null;
  const awaitingDepositStatus = Boolean(
    unresolvedDeposit
    || (error && !error.retrySafe && ["unknown", "submitted"].includes(error.outcome))
  );
  useEffect(() => {
    if (unresolvedDeposit) {
      depositReconciliationObservedRef.current = true;
    } else if (
      !working
      && depositReconciliationObservedRef.current
      && error
      && ["unknown", "submitted"].includes(error.outcome)
    ) {
      depositReconciliationObservedRef.current = false;
      setError(null);
    }
  }, [error, unresolvedDeposit, working]);
  const depositBlockedByFailure = failureBlocksFinancialAction(error);
  const depositEnabled = Boolean(
    !working
      && !awaitingDepositStatus
      && !depositBlockedByFailure
      && blockedDepositInputRef.current !== `${asset}:${amount}`
      && (!starknetAddress || (privateApiSupported !== false && amount.trim()))
  );

  async function refreshDepositStatus() {
    const runtime = walletRuntime();
    if (!runtime) {
      setError(failureFromCode("DEPOSIT_UNAVAILABLE", {
        stage: "deposit-reconciliation",
        presentation: "banner",
      }));
      return;
    }
    try {
      await runtime.refresh();
    } catch (refreshError) {
      setError(normalizeFailure(refreshError, {
        domain: "deposit",
        operation: "read",
        stage: "deposit-reconciliation",
        presentation: "inline",
      }));
    }
  }

  async function switchDepositNetwork() {
    try {
      await switchSelectedWalletNetwork();
      setError(null);
      await refreshDepositStatus();
    } catch (switchError) {
      setError(normalizeFailure(switchError, {
        domain: "network",
        operation: "read",
        stage: "wallet-network-switch",
        presentation: "inline",
      }));
    }
  }

  return (
    <div
      ref={panelRef}
      className={`slide-panel ${open ? "open" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Deposit"
      aria-hidden={!open}
      tabIndex={-1}
    >
      <div className="slide-hd">
        <span className="slide-title">Deposit</span>
        <button type="button" className="slide-close" aria-label="Close deposit" onClick={onClose}>
          ×
        </button>
      </div>
      <div
        className="slide-body"
        onKeyDown={(event) => {
          if (shouldRunPrimaryActionForEnter(event)) {
            if (!starknetAddress) {
              event.preventDefault();
              onOpenWallet();
              return;
            }
          }
          runPrimaryActionOnEnter(event, depositEnabled, () => {
            void handleDeposit();
          });
        }}
      >
        {!starknetAddress && (
          <div className="slide-inline-notice">
            <span>Connect a Starknet wallet to deposit.</span>
            <button
              type="button"
              className="slide-inline-action"
              onClick={onOpenWallet}
            >
              Connect wallet
            </button>
          </div>
        )}
        <TransferRoute from="Starknet wallet" to="Zylith balance" />
        <div className="f-row">
          <label className="f-label" htmlFor="deposit-amount">Amount</label>
          <div className="f-input-box">
            <input
              ref={amountInputRef}
              id="deposit-amount"
              className="f-input"
              type="text"
              inputMode="decimal"
              maxLength={64}
              placeholder="0"
              value={amount}
              aria-invalid={error?.presentation === "field" || undefined}
              aria-describedby={error?.presentation === "field" ? "deposit-amount-error" : undefined}
              onChange={(event) => {
                const next = event.target.value;
                if (next === "" || (next.length <= 64 && /^\d+(?:\.\d*)?$/.test(next))) {
                  setAmount(next);
                  if (error?.recovery === "edit-input") setError(null);
                }
              }}
            />
            <AssetPicker
              value={asset}
              options={allAssets}
              onChange={changeAsset}
              compact
              active={open}
            />
          </div>
        </div>
        <div className="funding-helper">
          Deposits stay private and are available after confirmation.
        </div>
        {error && (
          <FailureNotice
            id={error.presentation === "field" ? "deposit-amount-error" : undefined}
            failure={error}
            className="slide-inline-notice"
            actions={{
              reconnect: onOpenWallet,
              switchNetwork: switchDepositNetwork,
              editInput: error.presentation === "modal" ? () => {
                setError(null);
                window.requestAnimationFrame(() => amountInputRef.current?.focus());
              } : undefined,
              refreshState: refreshDepositStatus,
              checkStatus: refreshDepositStatus,
              contactSupport: () => copySupportDetails(error),
              dismiss: error.presentation === "toast" || error.code === "PRIVACY_SAFETY_BLOCK"
                ? () => {
                    setError(null);
                    window.requestAnimationFrame(() => amountInputRef.current?.focus());
                  }
                : undefined,
            }}
          />
        )}
        {!error && unresolvedDeposit && (
          <FailureNotice
            className="slide-inline-notice"
            failure={failureFromCode(
              unresolvedDeposit.public_transaction_confirmed
                ? "DEPOSIT_CREDIT_PENDING"
                : "DEPOSIT_PENDING",
              {
              stage: "deposit-reconciliation",
              presentation: "status-screen",
              },
            )}
            actions={{ checkStatus: refreshDepositStatus }}
          />
        )}
        <button
          className="slide-submit"
          type="button"
          disabled={!depositEnabled}
          onClick={() => {
            void handleDeposit();
          }}
        >
          {working
            ? "Depositing…"
            : awaitingDepositStatus
            ? "Checking deposit status"
            : error?.retrySafe
            ? "Try deposit again"
            : depositBlockedByFailure
            ? "Deposit unavailable"
            : starknetAddress
            ? `Deposit ${asset}`
            : "Connect wallet to deposit"}
        </button>
        {working && fundingStage && (
          <div className="slide-note" style={{ marginTop: 10 }}>
            {fundingStage}
          </div>
        )}
      </div>
    </div>
  );
}

export function WithdrawSlide({
  open,
  onClose,
  defaultAsset,
  allAssets,
  starknetAddress,
  walletReady,
  onOpenWallet,
  setSlideAsset,
}: {
  open: boolean;
  onClose: () => void;
  defaultAsset: string;
  allAssets: string[];
  starknetAddress: string | null;
  walletReady: boolean;
  onOpenWallet: () => void;
  setSlideAsset: (v: string) => void;
}) {
  const [asset, setAsset] = useState(defaultAsset);
  const [selectedNote, setSelectedNote] = useState("");
  const [error, setError] = useState<NormalizedFailure | null>(null);
  const [working, setWorking] = useState(false);
  const [privateApiSupported, setPrivateApiSupported] = useState<boolean | null>(null);
  const withdrawalReconciliationObservedRef = useRef(false);
  const withdrawalReconciliationNoteRef = useRef<string | null>(null);
  const operationInFlightRef = useRef(false);
  const openRef = useRef(open);
  const openGenerationRef = useRef(0);
  const previousOpenRef = useRef(open);
  if (open !== previousOpenRef.current) {
    previousOpenRef.current = open;
    openGenerationRef.current += 1;
  }
  openRef.current = open;
  const panelRef = useRef<HTMLDivElement | null>(null);
  useSlideDialog(open, onClose, panelRef);

  useEffect(() => {
    if (open) {
      withdrawalReconciliationObservedRef.current = false;
      withdrawalReconciliationNoteRef.current = null;
      setAsset(defaultAsset);
      setSelectedNote("");
      setError(null);
    }
  }, [open, defaultAsset]);

  useEffect(() => {
    let cancelled = false;
    setPrivateApiSupported(null);
    if (!open || !starknetAddress) return () => { cancelled = true; };
    const provider = selectedStarknetProvider();
    if (!provider) return () => { cancelled = true; };
    void requirePrivateStrk20Support(provider).then(() => {
      if (!cancelled) setPrivateApiSupported(true);
    }).catch((capabilityError) => {
      if (!cancelled) {
        setPrivateApiSupported(false);
        setError(normalizeFailure(capabilityError, {
          domain: "wallet",
          operation: "withdrawal",
          stage: "withdrawal-capability",
          presentation: "inline",
        }));
      }
    });
    return () => { cancelled = true; };
  }, [open, starknetAddress]);

  function changeAsset(a: string) {
    setAsset(a);
    setSlideAsset(a);
    setError(null);
  }

  const w = walletRuntime();
  const notes = w?.isReady(starknetAddress) ? w.getWithdrawableNotes() : [];
  const withdrawalAvailable = Boolean(w?.isReady(starknetAddress) && w.withdrawalAvailable());
  const assetNotes = selectableWithdrawNotes(notes, asset);
  const inProgress = notes.filter((note) => note.asset === asset && note.exit_stage && note.exit_stage !== "failed" && !note.spent);
  const selectedWithdrawNote = assetNotes.find((n) => n.note_commitment === selectedNote) ?? assetNotes[0] ?? null;

  async function handleWithdraw() {
    if (operationInFlightRef.current) return;
    const openGeneration = openGenerationRef.current;
    const requestedNoteCommitment = selectedWithdrawNote?.note_commitment ?? null;
    const wasAuthorized = Boolean(w?.isReady(starknetAddress));
    if (!starknetAddress) {
      setError(null);
      onOpenWallet();
      return;
    }
    operationInFlightRef.current = true;
    setWorking(true);
    setError(null);
    let submissionAttempted = false;
    try {
      const networkReadiness = await preflightSelectedWalletAction(starknetAddress);
      if (networkReadiness === "switched") {
        if (w?.isReady(starknetAddress)) await w.refresh();
        return;
      }
      const authorizedRuntime = await ensureTradingAuthorized(starknetAddress);
      if (!wasAuthorized) return;
      if (!authorizedRuntime.withdrawalAvailable()) {
        if (openGenerationRef.current === openGeneration) {
          setError(failureFromCode("WITHDRAWAL_UNAVAILABLE", {
            stage: "withdrawal-availability",
            presentation: "inline",
          }));
        }
        return;
      }
      const available = selectableWithdrawNotes(authorizedRuntime.getWithdrawableNotes(), asset);
      const note = requestedNoteCommitment
        ? available.find((candidate) => candidate.note_commitment === requestedNoteCommitment) ?? null
        : available[0] ?? null;
      if (!note) {
        if (openGenerationRef.current === openGeneration) {
          setError(failureFromCode(
            requestedNoteCommitment
              ? "WITHDRAWAL_BALANCE_CHANGED"
              : "NO_WITHDRAWABLE_FUNDS",
            {
              stage: "withdrawal-note-selection",
              presentation: "inline",
            }
          ));
        }
        return;
      }
      submissionAttempted = true;
      await authorizedRuntime.withdraw(note.note_commitment);
      if (openRef.current && openGenerationRef.current === openGeneration) onClose();
    } catch (e) {
      if (openGenerationRef.current === openGeneration) {
        const failure = normalizeFailure(e, {
          domain: "withdrawal",
          operation: "withdrawal",
          outcome: submissionAttempted ? "unknown" : "not-submitted",
          stage: "withdrawal-submission",
          presentation: "status-screen",
        });
        if (["unknown", "submitted"].includes(failure.outcome)) {
          withdrawalReconciliationNoteRef.current = requestedNoteCommitment;
        }
        setError(failure);
      }
    } finally {
      operationInFlightRef.current = false;
      setWorking(false);
    }
  }

  async function handleReceive(note: WithdrawableNote) {
    if (operationInFlightRef.current || !starknetAddress) return;
    operationInFlightRef.current = true;
    setWorking(true);
    setError(null);
    let submissionAttempted = false;
    try {
      const networkReadiness = await preflightSelectedWalletAction(starknetAddress);
      if (networkReadiness === "switched") {
        if (w?.isReady(starknetAddress)) await w.refresh();
        return;
      }
      const authorizedRuntime = await ensureTradingAuthorized(starknetAddress);
      submissionAttempted = true;
      await authorizedRuntime.claimWithdrawal(note.note_commitment);
    } catch (e) {
      const failure = normalizeFailure(e, {
        domain: "withdrawal",
        operation: "claim",
        outcome: submissionAttempted ? "unknown" : "not-submitted",
        stage: "withdrawal-claim",
        presentation: "status-screen",
      });
      if (["unknown", "submitted"].includes(failure.outcome)) {
        withdrawalReconciliationNoteRef.current = note.note_commitment;
      }
      setError(failure);
    } finally {
      operationInFlightRef.current = false;
      setWorking(false);
    }
  }
  const privateSessionReady = Boolean(starknetAddress && walletReady);
  const reconciliationNote = withdrawalReconciliationNoteRef.current;
  const withdrawalReconciliationPending = Boolean(
    reconciliationNote
    && notes.some((note) =>
      note.note_commitment === reconciliationNote
      && !note.spent
      && (
        note.exit_stage === "requested"
        || note.exit_stage === "proving"
        || note.exit_stage === "maturing"
        || note.exit_stage === "claiming"
      )
    )
  );
  useEffect(() => {
    if (withdrawalReconciliationPending) {
      withdrawalReconciliationObservedRef.current = true;
    } else if (
      !working
      && withdrawalReconciliationObservedRef.current
      && error
      && ["unknown", "submitted"].includes(error.outcome)
    ) {
      withdrawalReconciliationObservedRef.current = false;
      withdrawalReconciliationNoteRef.current = null;
      setError(null);
    }
  }, [error, withdrawalReconciliationPending, working]);
  const withdrawalBlockedByFailure = failureBlocksFinancialAction(error);
  const withdrawEnabled = Boolean(
    !working
      && !withdrawalBlockedByFailure
      && (!starknetAddress
        || !privateSessionReady
        || (privateApiSupported !== false && withdrawalAvailable && selectedWithdrawNote))
  );

  async function refreshWithdrawalStatus() {
    const runtime = walletRuntime();
    if (!runtime) {
      setError(failureFromCode("WITHDRAWAL_UNAVAILABLE", {
        stage: "withdrawal-reconciliation",
        presentation: "banner",
      }));
      return;
    }
    try {
      await runtime.refresh();
    } catch (refreshError) {
      setError(normalizeFailure(refreshError, {
        domain: "withdrawal",
        operation: "read",
        stage: "withdrawal-reconciliation",
        presentation: "inline",
      }));
    }
  }

  async function switchWithdrawalNetwork() {
    try {
      await switchSelectedWalletNetwork();
      setError(null);
      await refreshWithdrawalStatus();
    } catch (switchError) {
      setError(normalizeFailure(switchError, {
        domain: "network",
        operation: "read",
        stage: "wallet-network-switch",
        presentation: "inline",
      }));
    }
  }

  return (
    <div
      ref={panelRef}
      className={`slide-panel ${open ? "open" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Withdraw"
      aria-hidden={!open}
      tabIndex={-1}
    >
      <div className="slide-hd">
        <span className="slide-title">Withdraw</span>
        <button type="button" className="slide-close" aria-label="Close withdrawal" onClick={onClose}>
          ×
        </button>
      </div>
      <div
        className="slide-body"
        onKeyDown={(event) => {
          if (shouldRunPrimaryActionForEnter(event) && !starknetAddress) {
            event.preventDefault();
            onOpenWallet();
            return;
          }
          runPrimaryActionOnEnter(event, withdrawEnabled, () => {
            void handleWithdraw();
          });
        }}
      >
        {!starknetAddress && (
          <div className="slide-inline-notice">
            <span>Connect a Starknet wallet to withdraw.</span>
            <button type="button" className="slide-inline-action" onClick={onOpenWallet}>
              Connect wallet
            </button>
          </div>
        )}
        <TransferRoute from="Zylith balance" to="Private Starknet balance" />
        {privateSessionReady && !withdrawalAvailable && (
          <FailureNotice
            className="slide-note warn"
            failure={failureFromCode("WITHDRAWAL_UNAVAILABLE", {
              stage: "withdrawal-availability",
              presentation: "inline",
            })}
          />
        )}
        <div className="f-row">
          <div className="funding-field-head">
            <label className="f-label">Choose amount</label>
            <AssetPicker
              value={asset}
              options={allAssets}
              onChange={changeAsset}
              compact
              active={open}
            />
          </div>
          {assetNotes.length > 0 && (
            <div className="note-select-list">
              {assetNotes.map((note) => (
                <button
                  key={note.note_commitment}
                  type="button"
                  className={`note-select-row ${selectedWithdrawNote?.note_commitment === note.note_commitment ? "on" : ""}`}
                  aria-pressed={selectedWithdrawNote?.note_commitment === note.note_commitment}
                  onClick={() => {
                    setSelectedNote(note.note_commitment);
                    if (error?.recovery === "edit-input" || error?.recovery === "refresh-state") {
                      setError(null);
                    }
                  }}
                >
                  <strong>
                    {safeFromAtomicStr(note.amount, asset)} {asset}
                  </strong>
                  <span>{note.exit_stage === "failed" ? "Retry" : "Ready"}</span>
                </button>
              ))}
            </div>
          )}
          {privateSessionReady && assetNotes.length === 0 && (
            <FailureNotice
              className="funding-empty"
              failure={failureFromCode("NO_WITHDRAWABLE_FUNDS", {
                stage: "withdrawal-note-selection",
                presentation: "inline",
              })}
            />
          )}
        </div>
        <div className="funding-helper">
          Withdrawals stay private and typically complete within a few minutes.
        </div>
        {error && (
          <FailureNotice
            failure={error}
            className="slide-inline-notice"
            actions={{
              reconnect: onOpenWallet,
              switchNetwork: switchWithdrawalNetwork,
              refreshState: refreshWithdrawalStatus,
              checkStatus: refreshWithdrawalStatus,
              contactSupport: () => copySupportDetails(error),
              dismiss: error.presentation === "toast" ? () => setError(null) : undefined,
            }}
          />
        )}
        <button type="button" className="slide-submit" disabled={!withdrawEnabled} onClick={() => void handleWithdraw()}>
          {working
            ? privateSessionReady
              ? "Submitting…"
              : "Authorizing…"
            : withdrawalBlockedByFailure
              ? "Withdrawal unavailable"
            : error?.retrySafe
              ? "Try withdrawal again"
            : !starknetAddress
              ? "Connect wallet to withdraw"
              : privateSessionReady && selectedWithdrawNote
                ? `Withdraw ${safeFromAtomicStr(selectedWithdrawNote.amount, asset)} ${asset}`
                : privateSessionReady
                  ? "Withdraw"
                  : "Unlock private balance"}
        </button>
        {inProgress.length > 0 && (
          <div className="withdraw-progress-section">
            <label className="f-label">In progress</label>
            {inProgress.map((note) => (
              <div key={note.note_commitment} className="withdraw-progress-row">
                <strong>{safeFromAtomicStr(note.amount, asset)} {asset}</strong>
                <span>{EXIT_STAGE_LABELS[note.exit_stage!]}</span>
                {note.exit_stage === "finalized" && (
                  <button
                    type="button"
                    className="slide-inline-action"
                    disabled={working || withdrawalBlockedByFailure}
                    onClick={() => void handleReceive(note)}
                  >
                    Receive privately
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
