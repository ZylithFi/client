import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { safeFromAtomicStr, toAtomicStr } from "../domain/assets";
import type { PublicSettlementTranscript } from "../domain/auctionEpoch";
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
import { settlementReadyAtMs } from "../domain/noteLifecycle";
import {
  runPrimaryActionOnEnter,
  shouldRunPrimaryActionForEnter,
} from "../domain/primaryEnter";
import { getPrivacyFundingStage } from "../domain/privacyFundingStage";
import type { WithdrawableNote } from "../domain/shieldedBalances";
import { userFacingErrorMessage } from "../domain/userFacingErrors";

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
  onStage?: (stage: string) => void,
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
  if (!ok) {
    ok = await runtime.createWalletWithWalletSignature(starknetAddress);
  }
  if (!ok || !runtime.isReady()) {
    throw new Error("Trading authorization failed. Retry in your wallet.");
  }
  return runtime;
}

function selectableWithdrawNotes(
  notes: WithdrawableNote[],
  asset: string,
  settlementTranscripts: Record<string, PublicSettlementTranscript>,
  claimDelaySeconds: number,
  now = Date.now(),
) {
  return notes
    .filter((n) => {
      const retryableStrk20Exit = Boolean(
        n.strk20_exit_commitment &&
          n.pending_withdrawal_tx &&
          !n.pending_strk20_open_note_tx
      );
      if (n.asset !== asset || n.locked || n.spent) return false;
      if (n.source !== "settlement_output") return false;
      if (retryableStrk20Exit) return true;
      if (n.pending_withdrawal_tx) return false;
      const readyAt = settlementReadyAtMs(
        n,
        settlementTranscripts,
        claimDelaySeconds
      );
      return readyAt !== null && now >= readyAt;
    })
    .sort((a, b) => {
      return (
        (settlementReadyAtMs(a, settlementTranscripts, claimDelaySeconds) ??
          0) -
        (settlementReadyAtMs(b, settlementTranscripts, claimDelaySeconds) ?? 0)
      );
    });
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
  const connectedVaultAuthMode =
    w?.vaultAuthMode?.(starknetAddress) ??
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
    if (
      !open ||
      !starknetAddress ||
      working ||
      runtimeStatus !== "ready"
    ) {
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
      if (addressHasVault) {
        const ok = await w.unlockWithWalletSignature(address);
        if (!ok) {
          await w.createWalletWithWalletSignature(address);
        }
      } else {
        await w.createWalletWithWalletSignature(address);
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
    return enablePrivateTradingForAddress(starknetAddress, { forceRetry: true });
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
              fontSize: 11,
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
                <span>
                  Install or open Ready X or Xverse, then scan again.
                </span>
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
              fontSize: 11,
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
    setFundingStage(walletReady && w?.isReady() ? "Preparing deposit" : "Authorizing trading");
    try {
      const authorizedRuntime = await ensureTradingAuthorized(
        starknetAddress,
        setFundingStage,
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
    <div className={`slide-panel ${open ? "open" : ""}`}>
      <div className="slide-hd">
        <span className="slide-title">Deposit</span>
        <button className="slide-close" onClick={onClose}>
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
        <div className="f-row">
          <label className="f-label">Amount</label>
          <div className="f-input-box">
            <input
              className="f-input"
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <select
              className="amount-asset-select"
              value={asset}
              onChange={(e) => changeAsset(e.target.value)}
            >
              {allAssets.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && (
          <div
            style={{
              fontSize: 11,
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
  defaultNoteCommitment,
  settlementTranscripts,
  claimDelaySeconds,
  allAssets,
  starknetAddress,
  walletReady,
  onOpenWallet,
  setSlideAsset,
}: {
  open: boolean;
  onClose: () => void;
  defaultAsset: string;
  defaultNoteCommitment?: string | null;
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  claimDelaySeconds: number;
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
      setSelectedNote(defaultNoteCommitment ?? "");
      setError("");
    }
  }, [open, defaultAsset, defaultNoteCommitment]);

  function changeAsset(a: string) {
    setAsset(a);
    setSlideAsset(a);
  }

  const w = walletRuntime();
  const notes = w?.getWithdrawableNotes() ?? [];
  const now = Date.now();
  const strk20WithdrawalAvailable = Boolean(w?.strk20WithdrawalAvailable?.());
  const assetNotes = selectableWithdrawNotes(
    notes,
    asset,
    settlementTranscripts,
    claimDelaySeconds,
    now,
  );
  const depositNotesNotWithdrawable = notes.filter(
    (n) =>
      n.asset === asset &&
      n.source !== "settlement_output" &&
      !n.spent &&
      !n.pending_withdrawal_tx
  );
  const selectedWithdrawNote =
    assetNotes.find((n) => n.note_commitment === selectedNote) ??
    assetNotes[0] ??
    null;
  const selectedIsRetry =
    Boolean(selectedWithdrawNote?.strk20_exit_commitment) &&
    Boolean(selectedWithdrawNote?.pending_withdrawal_tx) &&
    !selectedWithdrawNote?.pending_strk20_open_note_tx;

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
      if (!authorizedRuntime.strk20WithdrawalAvailable()) {
        setError("STRK20 withdrawals are not configured for this deployment.");
        return;
      }
      const availableNotes = selectableWithdrawNotes(
        authorizedRuntime.getWithdrawableNotes(),
        asset,
        settlementTranscripts,
        claimDelaySeconds,
      );
      const note =
        availableNotes.find((n) => n.note_commitment === selectedNote) ??
        availableNotes[0] ??
        null;
      if (!note) {
        setError(`No available ${asset} notes.`);
        return;
      }
      await authorizedRuntime.submitStrk20Withdrawal({
        note_commitment: note.note_commitment,
        batch_id: note.batch_id,
      });
      onClose();
    } catch (e) {
      setError(userFacingErrorMessage(e));
    } finally {
      setWorking(false);
    }
  }
  const privateSessionReady = Boolean(starknetAddress && walletReady);
  const withdrawEnabled = Boolean(
    !working &&
      (!starknetAddress ||
        (strk20WithdrawalAvailable &&
          (selectedWithdrawNote || !privateSessionReady)))
  );

  return (
    <div className={`slide-panel ${open ? "open" : ""}`}>
      <div className="slide-hd">
        <span className="slide-title">Withdraw</span>
        <button className="slide-close" onClick={onClose}>
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
          if (shouldRunPrimaryActionForEnter(event) && !privateSessionReady) {
            event.preventDefault();
            void handleWithdraw();
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
            <button
              type="button"
              className="slide-inline-action"
              onClick={onOpenWallet}
            >
              Connect wallet
            </button>
          </div>
        )}
        <div className="f-row">
          <label className="f-label">Asset</label>
          <div className="f-input-box">
            <select
              className="asset-select-input"
              value={asset}
              onChange={(e) => changeAsset(e.target.value)}
            >
              {allAssets.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--z-text-body)",
            marginBottom: 12,
          }}
        >
          {assetNotes.length > 0
            ? `${assetNotes.length} note${
                assetNotes.length !== 1 ? "s" : ""
              } available`
            : `No ${asset} notes`}
        </div>
        {depositNotesNotWithdrawable.length > 0 && (
          <div className="slide-note">
            {depositNotesNotWithdrawable.length} deposit note
            {depositNotesNotWithdrawable.length !== 1 ? "s are" : " is"}{" "}
            available but not directly withdrawable. Submit through settlement
            first, then withdraw the resulting settlement output.
          </div>
        )}
        {!strk20WithdrawalAvailable && (
          <div className="slide-note warn">
            STRK20 withdrawals are not configured for this deployment.
          </div>
        )}
        {assetNotes.length > 0 && (
          <div className="f-row">
            <label className="f-label">Note</label>
            <div className="note-select-list">
              {assetNotes.map((note) => (
                <button
                  key={note.note_commitment}
                  type="button"
                  className={`note-select-row ${
                    selectedWithdrawNote?.note_commitment ===
                    note.note_commitment
                      ? "on"
                      : ""
                  }`}
                  onClick={() => setSelectedNote(note.note_commitment)}
                >
                  <span>
                    {safeFromAtomicStr(note.amount, asset)} {asset}
                  </span>
                  <span>{fmtAddr(note.note_commitment)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {error && (
          <div
            style={{
              fontSize: 11,
              color: "var(--z-status-danger)",
              marginBottom: 8,
            }}
          >
            {error}
          </div>
        )}
        <button
          className="slide-submit"
          disabled={!withdrawEnabled}
          onClick={() => {
            void handleWithdraw();
          }}
        >
          {working
            ? privateSessionReady
              ? "Submitting…"
              : "Authorizing…"
            : !starknetAddress
            ? "Connect wallet to withdraw"
            : selectedIsRetry
            ? "Retry STRK20 note claim"
            : privateSessionReady
            ? "Withdraw to STRK20 note"
            : "Authorize withdrawals"}
        </button>
      </div>
    </div>
  );
}
