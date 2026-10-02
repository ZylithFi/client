import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { safeFromAtomicStr, toAtomicStr } from "../domain/assets";
import {
  type RuntimeStatus,
  type StarknetWalletOption,
  connectStarknetProvider,
  clearSelectedStarknetProvider,
  disconnectStarknetProvider,
  discoverStarknetWalletsAsync,
  discoverStarknetWallets,
  fmtAddr,
  walletRuntimeLoadError,
  walletRuntime,
} from "../domain/browserWallet";
import {
  runPrimaryActionOnEnter,
  shouldRunPrimaryActionForEnter,
} from "../domain/primaryEnter";
import { getPrivacyFundingStage } from "../domain/privacyFundingStage";
import type { WithdrawableNote } from "@zylith/sdk";
import { userFacingErrorMessage } from "../domain/userFacingErrors";
import { ChevronDownIcon } from "../finalui/components/Icons";
import { TokenIcon } from "../finalui/components/TokenIcon";

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
  if (runtime.isReady()) return runtime;
  onStage?.("Authorizing trading");
  const mode = runtime.vaultAuthMode?.(starknetAddress) ?? "none";
  let ok =
    mode === "wallet-signature"
      ? await runtime.unlockWithWalletSignature(starknetAddress)
      : false;
  if (!ok && mode === "none") {
    ok = await runtime.createWalletWithWalletSignature(starknetAddress);
  }
  if (!ok || !runtime.isReady()) {
    throw new Error("Trading authorization failed. Retry in your wallet.");
  }
  return runtime;
}

/** notes of `asset` that can start, or retry, a withdrawal: largest first. */
function selectableWithdrawNotes(notes: WithdrawableNote[], asset: string) {
  return notes
    .filter((note) => note.asset === asset && !note.spent && (!note.locked || note.exit_stage === "failed"))
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
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOnViewportChange = () => setOpen(false);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("focusin", closeOnOutsideFocus);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("focusin", closeOnOutsideFocus);
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
          role="listbox"
          aria-label="Assets"
          style={menuStyle}
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
  finalized: "Completing",
  claiming: "Completing",
  failed: "Failed",
};

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
  const [error, setError] = useState("");
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
  const scanGenerationRef = useRef(0);
  const walletScannerActiveRef = useRef(false);
  const autoPrivateSetupAttemptRef = useRef<string | null>(null);
  const w = walletRuntime();
  const connectedVaultAuthMode = w?.vaultAuthMode?.(starknetAddress) ??
    (starknetAddress && hasVault ? "wallet-signature" : "none");
  const connectedHasVault = connectedVaultAuthMode === "wallet-signature";

  async function refreshWalletOptions({
    showLoading = false,
  }: { showLoading?: boolean } = {}) {
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
      )
        setWalletScanState("complete");
    }
  }

  useEffect(() => {
    if (!open) return undefined;
    walletScannerActiveRef.current = true;
    setError("");
    setShowStarknetFirstHint(false);
    void refreshWalletOptions({ showLoading: true });
    const refresh = () => void refreshWalletOptions();
    const timer = window.setInterval(refresh, 2000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("starknet#initialized", refresh);
    return () => {
      walletScannerActiveRef.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("starknet#initialized", refresh);
    };
  }, [open, connectedVaultAuthMode]);

  useEffect(() => {
    if (!open || !starknetAddress) {
      autoPrivateSetupAttemptRef.current = null;
    }
  }, [open, starknetAddress]);

  useEffect(() => {
    if (!open || !starknetAddress || working || runtimeStatus !== "ready") {
      return;
    }
    void enablePrivateTradingForAddress(starknetAddress);
  }, [connectedHasVault, open, runtimeStatus, starknetAddress, working]);

  async function handleConnectStarknet(wallet: StarknetWalletOption) {
    setConnectingWalletId(wallet.id);
    setError("");
    try {
      const addr = await connectStarknetProvider(wallet.provider, wallet.id);
      if (addr) {
        setShowStarknetFirstHint(false);
        onStarknetConnected(addr);
        await enablePrivateTradingForAddress(addr);
      } else setError("Wallet did not return an account. Unlock it and retry.");
    } catch (e) {
      setError(userFacingErrorMessage(e, "Wallet connection failed."));
    } finally {
      setConnectingWalletId(null);
    }
  }

  function handleChangeStarknetWallet() {
    autoPrivateSetupAttemptRef.current = null;
    walletRuntime()?.lock();
    clearSelectedStarknetProvider();
    onStarknetDisconnected();
    void refreshWalletOptions({ showLoading: true });
    setError("");
  }

  function handleDisconnectStarknetWallet() {
    autoPrivateSetupAttemptRef.current = null;
    walletRuntime()?.lock();
    disconnectStarknetProvider();
    onStarknetDisconnected();
    void refreshWalletOptions({ showLoading: true });
    setError("");
  }

  async function enablePrivateTradingForAddress(
    address: string,
    { forceRetry = false }: { forceRetry?: boolean } = {}
  ) {
    if (!w) {
      setError("Private trading is still loading. Please retry later.");
      return;
    }
    if (w.isReady?.()) {
      onClose();
      return;
    }
    const addressVaultAuthMode = w.vaultAuthMode?.(address) ?? "none";
    const addressHasVault = addressVaultAuthMode === "wallet-signature";
    const attemptKey = `${address.toLowerCase()}:${
      addressHasVault ? addressVaultAuthMode : "new"
    }`;
    if (forceRetry) autoPrivateSetupAttemptRef.current = null;
    if (autoPrivateSetupAttemptRef.current === attemptKey) return;
    autoPrivateSetupAttemptRef.current = attemptKey;
    setWorking(true);
    setError("");
    let completed = false;
    try {
      let authorized = false;
      if (addressHasVault) {
        authorized = await w.unlockWithWalletSignature(address);
      } else {
        authorized = await w.createWalletWithWalletSignature(address);
      }
      if (!authorized || !w.isReady()) {
        throw new Error("Trading authorization failed. Retry in your wallet.");
      }
      completed = true;
      onClose();
    } catch (e) {
      setError(userFacingErrorMessage(e));
    } finally {
      if (!completed && autoPrivateSetupAttemptRef.current === attemptKey) {
        autoPrivateSetupAttemptRef.current = attemptKey;
      }
      setWorking(false);
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

  const divider = (
    <div
      style={{ margin: "16px 0", boxShadow: "inset 0 -1px 0 var(--z-border)" }}
    />
  );
  const hasStarknetAccount = Boolean(starknetAddress);
  const createEnabled = hasStarknetAccount && !working;
  const authorizeEnabled = hasStarknetAccount && !working;
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
    <div className={`slide-panel ${open ? "open" : ""}`}>
      <div className="slide-hd">
        <span className="slide-title">Connect Wallet</span>
        <button className="slide-close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="slide-body" onKeyDown={handlePrimaryEnter}>
        {!w && (
          <div
            style={{
              fontSize: 13,
              color: "var(--z-status-warn)",
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            {runtimeStatus === "loading"
              ? "Private trading loading…"
              : walletRuntimeLoadError()
              ? userFacingErrorMessage(
                  walletRuntimeLoadError(),
                  "Private trading failed to load."
                )
              : "Private trading failed to load."}
          </div>
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
                <span>Install or open Ready X or Xverse, then scan again.</span>
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

        {hasStarknetAccount && (
          <button
            className="slide-submit"
            disabled={!createEnabled}
            onClick={() => {
              if (requireStarknetFirst()) return;
              void handleEnablePrivateTrading();
            }}
          >
            {working
              ? "Authorizing…"
              : error
              ? "Retry authorization"
              : "Authorize trading"}
          </button>
        )}

        {error && (
          <div
            style={{
              fontSize: 13,
              color: "var(--z-status-danger)",
              marginTop: 10,
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
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
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [fundingStage, setFundingStage] = useState("");
  const wasOpenRef = useRef(false);
  const depositStartedAtRef = useRef(0);

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
      setAsset(
        allAssets.includes(defaultAsset)
          ? defaultAsset
          : allAssets[0] ?? defaultAsset
      );
      setAmount("");
      setError("");
    }
    wasOpenRef.current = open;
  }, [open, defaultAsset, allAssets]);

  function changeAsset(a: string) {
    setAsset(a);
    setSlideAsset(a);
  }

  async function handleDeposit() {
    const w = walletRuntime();
    if (!starknetAddress) {
      setError("");
      onOpenWallet();
      return;
    }
    if (!amount.trim()) {
      setError("Enter an amount");
      return;
    }
    const atomicAmount = toAtomicStr(amount, asset);
    if (atomicAmount === "0") {
      setError("Enter a valid amount.");
      return;
    }
    depositStartedAtRef.current = Date.now();
    setWorking(true);
    setError("");
    setFundingStage(
      walletReady && w?.isReady() ? "Preparing deposit" : "Authorizing trading"
    );
    try {
      const authorizedRuntime = await ensureTradingAuthorized(
        starknetAddress,
        setFundingStage
      );
      setFundingStage("Preparing deposit");
      await authorizedRuntime.submitDepositViaWallet(asset, atomicAmount);
      setAmount("");
      onClose();
    } catch (e) {
      setError(userFacingErrorMessage(e));
    } finally {
      setWorking(false);
    }
  }
  const depositEnabled = Boolean(
    !working && (!starknetAddress || amount.trim())
  );

  return (
    <div
      className={`slide-panel ${open ? "open" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Deposit"
    >
      <div className="slide-hd">
        <span className="slide-title">Deposit</span>
        <button className="slide-close" aria-label="Close deposit" onClick={onClose}>
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
              id="deposit-amount"
              className="f-input"
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
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
          <div
            style={{
              fontSize: 13,
              color: "var(--z-status-danger)",
              marginBottom: 8,
            }}
          >
            {error}
          </div>
        )}
        <button
          className="slide-submit"
          disabled={!depositEnabled}
          onClick={() => {
            void handleDeposit();
          }}
        >
          {working
            ? "Depositing…"
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
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) {
      setAsset(defaultAsset);
      setSelectedNote("");
      setError("");
    }
  }, [open, defaultAsset]);

  function changeAsset(a: string) {
    setAsset(a);
    setSlideAsset(a);
  }

  const w = walletRuntime();
  const notes = w?.isReady() ? w.getWithdrawableNotes() : [];
  const withdrawalAvailable = Boolean(w?.isReady() && w.withdrawalAvailable());
  const assetNotes = selectableWithdrawNotes(notes, asset);
  const inProgress = notes.filter((note) => note.asset === asset && note.exit_stage && note.exit_stage !== "failed" && !note.spent);
  const selectedWithdrawNote = assetNotes.find((n) => n.note_commitment === selectedNote) ?? assetNotes[0] ?? null;

  async function handleWithdraw() {
    if (!starknetAddress) {
      setError("");
      onOpenWallet();
      return;
    }
    setWorking(true);
    setError("");
    try {
      const authorizedRuntime = await ensureTradingAuthorized(starknetAddress);
      if (!authorizedRuntime.withdrawalAvailable()) {
        setError("Withdrawals are not configured for this deployment.");
        return;
      }
      const available = selectableWithdrawNotes(authorizedRuntime.getWithdrawableNotes(), asset);
      const note = available.find((n) => n.note_commitment === selectedNote) ?? available[0] ?? null;
      if (!note) {
        setError(`No available ${asset} notes.`);
        return;
      }
      await authorizedRuntime.withdraw(note.note_commitment);
      onClose();
    } catch (e) {
      setError(userFacingErrorMessage(e));
    } finally {
      setWorking(false);
    }
  }
  const privateSessionReady = Boolean(starknetAddress && walletReady);
  const withdrawEnabled = Boolean(!working && (!starknetAddress || !privateSessionReady || (withdrawalAvailable && selectedWithdrawNote)));

  return (
    <div
      className={`slide-panel ${open ? "open" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Withdraw"
    >
      <div className="slide-hd">
        <span className="slide-title">Withdraw</span>
        <button className="slide-close" aria-label="Close withdrawal" onClick={onClose}>
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
        {privateSessionReady && !withdrawalAvailable && <div className="slide-note warn">Withdrawals are not configured for this deployment.</div>}
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
                  onClick={() => setSelectedNote(note.note_commitment)}
                >
                  <strong>
                    {safeFromAtomicStr(note.amount, asset)} {asset}
                  </strong>
                  <span>{note.exit_stage === "failed" ? "Retry" : "Ready"}</span>
                </button>
              ))}
            </div>
          )}
          {privateSessionReady && assetNotes.length === 0 && <div className="funding-empty">No {asset} available to withdraw.</div>}
        </div>
        <div className="funding-helper">
          Withdrawals stay private and typically complete within a few minutes.
        </div>
        {error && <div style={{ fontSize: 13, color: "var(--z-status-danger)", marginBottom: 8 }}>{error}</div>}
        <button className="slide-submit" disabled={!withdrawEnabled} onClick={() => void handleWithdraw()}>
          {working
            ? privateSessionReady
              ? "Submitting…"
              : "Authorizing…"
            : !starknetAddress
              ? "Connect wallet to withdraw"
              : privateSessionReady && selectedWithdrawNote
                ? `Withdraw ${safeFromAtomicStr(selectedWithdrawNote.amount, asset)} ${asset}`
                : privateSessionReady
                  ? "Withdraw"
                  : "Authorize withdrawals"}
        </button>
        {inProgress.length > 0 && (
          <div className="withdraw-progress-section">
            <label className="f-label">In progress</label>
            {inProgress.map((note) => (
              <div key={note.note_commitment} className="withdraw-progress-row">
                <strong>{safeFromAtomicStr(note.amount, asset)} {asset}</strong>
                <span>{EXIT_STAGE_LABELS[note.exit_stage!]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
