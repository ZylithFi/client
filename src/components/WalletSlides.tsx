import { useEffect, useRef, useState } from "react";
import { fromAtomicStr, toAtomicStr } from "../domain/assets";
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
  walletRuntime,
} from "../domain/browserWallet";
import { settlementReadyAtMs } from "../domain/noteLifecycle";
import { userFacingErrorMessage } from "../domain/userFacingErrors";
import type { WithdrawalRoutePreference } from "../domain/userPreferences";

type PrivacyFundingStageSnapshot = {
  stage?: unknown;
  at?: unknown;
};

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
  const snapshot = (globalThis as typeof globalThis & {
    __zylithPrivacyFundingStage?: PrivacyFundingStageSnapshot;
  }).__zylithPrivacyFundingStage;
  if (typeof snapshot?.stage !== "string") return "";
  if (
    sinceUnixMs > 0 &&
    (typeof snapshot.at !== "number" || snapshot.at < sinceUnixMs)
  ) {
    return "";
  }
  return privacyFundingStageLabel(snapshot.stage);
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
  const [privKeyTab, setPrivKeyTab] = useState<"create" | "import" | "unlock">(
    hasVault ? "unlock" : "create",
  );
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [phrase, setPhrase] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [connectingWalletId, setConnectingWalletId] = useState<string | null>(null);
  const [walletOptions, setWalletOptions] = useState<StarknetWalletOption[]>([]);
  const [walletScanState, setWalletScanState] = useState<"idle" | "scanning" | "complete">("idle");
  const scanGenerationRef = useRef(0);

  async function refreshWalletOptions({ showLoading = false }: { showLoading?: boolean } = {}) {
    const scanGeneration = scanGenerationRef.current + 1;
    scanGenerationRef.current = scanGeneration;
    if (showLoading) setWalletScanState("scanning");
    const immediateOptions = discoverStarknetWallets();
    setWalletOptions(immediateOptions);
    if (immediateOptions.length > 0) setWalletScanState("complete");
    try {
      const options = await discoverStarknetWalletsAsync();
      if (scanGenerationRef.current !== scanGeneration) return;
      setWalletOptions(options);
    } finally {
      if (scanGenerationRef.current === scanGeneration) setWalletScanState("complete");
    }
  }

  useEffect(() => {
    if (open) {
      setPrivKeyTab(hasVault ? "unlock" : "create");
      setPassphrase("");
      setPhrase("");
      setMnemonic("");
      setError("");
      void refreshWalletOptions({ showLoading: true });
    }
  }, [open, hasVault]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const refreshWalletOptions = () => {
      void discoverStarknetWalletsAsync()
        .then(options => {
          if (!cancelled) setWalletOptions(options);
          if (!cancelled) setWalletScanState("complete");
        })
        .catch(() => {
          if (!cancelled) setWalletScanState("complete");
        });
    };
    refreshWalletOptions();
    const timer = window.setInterval(refreshWalletOptions, 2000);
    window.addEventListener("focus", refreshWalletOptions);
    document.addEventListener("visibilitychange", refreshWalletOptions);
    window.addEventListener("starknet#initialized", refreshWalletOptions);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWalletOptions);
      document.removeEventListener("visibilitychange", refreshWalletOptions);
      window.removeEventListener("starknet#initialized", refreshWalletOptions);
    };
  }, [open]);

  const w = walletRuntime();

  async function handleConnectStarknet(wallet: StarknetWalletOption) {
    setConnectingWalletId(wallet.id);
    setError("");
    try {
      const addr = await connectStarknetProvider(wallet.provider, wallet.id);
      if (addr) onStarknetConnected(addr);
      else setError("Wallet did not return an account. Unlock it and retry.");
    } catch (e) {
      setError(userFacingErrorMessage(e, "Wallet connection failed."));
    } finally {
      setConnectingWalletId(null);
    }
  }

  function handleChangeStarknetWallet() {
    clearSelectedStarknetProvider();
    onStarknetDisconnected();
    void refreshWalletOptions({ showLoading: true });
    setError("");
  }

  function handleDisconnectStarknetWallet() {
    disconnectStarknetProvider();
    onStarknetDisconnected();
    void refreshWalletOptions({ showLoading: true });
    setError("");
  }

  async function handleCreate() {
    if (!w) { setError("Zylith wallet is still loading. Please retry later."); return; }
    if (!passphrase) { setError("Enter a passphrase"); return; }
    if (passphrase !== passphraseConfirm) { setError("Passphrases do not match."); return; }
    setWorking(true);
    setError("");
    try {
      if (hasVault && w.replaceWithNewWallet) {
        await w.replaceWithNewWallet(passphrase);
      } else {
        await w.createWallet(passphrase);
      }
      setMnemonic(await w.exportRecoverySeed(passphrase));
    } catch (e) {
      setError(userFacingErrorMessage(e));
    } finally {
      setWorking(false);
    }
  }

  async function handleImport() {
    if (!w) { setError("Zylith wallet is still loading. Please retry later."); return; }
    if (!phrase.trim()) { setError("Enter your recovery phrase"); return; }
    if (!passphrase) { setError("Enter a passphrase"); return; }
    if (passphrase !== passphraseConfirm) { setError("Passphrases do not match."); return; }
    setWorking(true);
    setError("");
    try {
      if (hasVault && w.replaceRecoverySeed) {
        await w.replaceRecoverySeed(phrase.trim(), passphrase);
      } else {
        await w.importRecoverySeed(phrase.trim(), passphrase);
      }
      onClose();
    } catch (e) {
      setError(userFacingErrorMessage(e));
    } finally {
      setWorking(false);
    }
  }

  async function handleUnlock() {
    if (!w) { setError("Zylith wallet is still loading. Please retry later."); return; }
    if (!passphrase) { setError("Enter your passphrase"); return; }
    setWorking(true);
    setError("");
    try {
      const ok = await w.unlockWithPassphrase(passphrase);
      if (ok) onClose();
      else setError("Incorrect passphrase. If this browser has an old local wallet, recover with your Zylith phrase.");
    } catch (e) {
      setError(userFacingErrorMessage(e));
    } finally {
      setWorking(false);
    }
  }

  const divider = (
    <div style={{ margin: "16px 0", boxShadow: "inset 0 -1px 0 var(--z-border)" }} />
  );

  return (
    <div className={`slide-panel ${open ? "open" : ""}`}>
      <div className="slide-hd">
        <span className="slide-title">Connect Wallet</span>
        <button className="slide-close" onClick={onClose}>×</button>
      </div>
      <div className="slide-body">
        {!w && (
          <div style={{ fontSize: 11, color: "var(--z-status-warn)", marginBottom: 12, lineHeight: 1.5 }}>
            {runtimeStatus === "loading"
              ? "Wallet runtime loading…"
              : window.zylithWalletLoadError
                ? userFacingErrorMessage(window.zylithWalletLoadError, "Zylith wallet runtime failed to load.")
                : "Zylith wallet runtime failed to load."}
          </div>
        )}

        <div className="f-label" style={{ marginBottom: 6 }}>Starknet account</div>
        <div style={{ fontSize: 11, color: "var(--z-text-body)", lineHeight: 1.5, marginBottom: 10 }}>
          Ready X or Xverse — used for deposits and withdrawals.
        </div>
        {starknetAddress ? (
          <div className="wallet-connected-box">
            <div className="wallet-connected-row">
              <span className="wallet-connected-dot" />
              <span className="wallet-connected-address">{fmtAddr(starknetAddress)}</span>
              <span className="wallet-connected-status">Connected</span>
            </div>
            <div className="wallet-connected-actions">
              <button type="button" onClick={handleChangeStarknetWallet}>Change wallet</button>
              <button type="button" onClick={handleDisconnectStarknetWallet}>Disconnect</button>
            </div>
          </div>
        ) : (
          <>
            {walletScanState === "scanning" ? (
              <div className="wallet-empty">
                <strong>Scanning wallets</strong>
                <span>Confirm your Starknet wallet extension is unlocked.</span>
              </div>
            ) : walletOptions.length > 0 ? (
              <div className="wallet-choice-list">
                {walletOptions.map(wallet => (
                  <button
                    key={wallet.id}
                    type="button"
                    className="wallet-choice-row"
                    disabled={Boolean(connectingWalletId)}
                    onClick={() => { void handleConnectStarknet(wallet); }}
                  >
                    <span className="wallet-choice-mark" />
                    <span className="wallet-choice-copy">
                      <strong>{wallet.name}</strong>
                      <small>{wallet.id}</small>
                    </span>
                    <em>{connectingWalletId === wallet.id ? "Connecting" : "Connect"}</em>
                  </button>
                ))}
              </div>
            ) : (
              <div className="wallet-empty">
                <strong>No Starknet wallet found</strong>
                <span>Install or unlock Ready X or Xverse, then scan again.</span>
                <button
                  type="button"
                  className="wallet-recover-link compact"
                  onClick={() => { void refreshWalletOptions({ showLoading: true }); }}
                >
                  Scan wallets
                </button>
              </div>
            )}
          </>
        )}

        {divider}

        {!hasVault && (
          <div style={{ display: "flex", gap: 0, marginBottom: 14, height: 30 }}>
            <button
              className={`f-select-opt ${privKeyTab === "create" ? "on" : ""}`}
              style={{ flex: 1 }}
              onClick={() => setPrivKeyTab("create")}
            >New</button>
            <button
              className={`f-select-opt ${privKeyTab === "import" ? "on" : ""}`}
              style={{ flex: 1 }}
              onClick={() => setPrivKeyTab("import")}
            >Import</button>
          </div>
        )}

        {hasVault && privKeyTab === "unlock" && (
          <>
            <div className="slide-note">
              This unlocks the same Zylith wallet used across Trade and Liquidity.
            </div>
            <button
              type="button"
              className="wallet-recover-link"
              onClick={() => {
                setPrivKeyTab("import");
                setError("");
                setPassphrase("");
                setPassphraseConfirm("");
              }}
            >
              Recover with Zylith phrase
            </button>
            <button
              type="button"
              className="wallet-recover-link compact"
              onClick={() => {
                setPrivKeyTab("create");
                setError("");
                setPassphrase("");
                setPassphraseConfirm("");
              }}
            >
              Reset local wallet
            </button>
          </>
        )}

        {privKeyTab === "create" && !mnemonic && (
          <>
            {hasVault && (
              <div className="slide-note warn">
                This replaces the local Zylith wallet in this browser. Keep the old recovery phrase if you need the old notes or history.
              </div>
            )}
            <div className="f-row">
              <label className="f-label">Encryption passphrase</label>
              <div className="f-input-box">
                <input
                  className="f-input"
                  type="password"
                  placeholder={hasVault ? "Choose a new passphrase" : "Choose a passphrase"}
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                />
              </div>
            </div>
            <div className="f-row">
              <label className="f-label">Confirm passphrase</label>
              <div className="f-input-box">
                <input
                  className="f-input"
                  type="password"
                  placeholder="Re-enter passphrase"
                  value={passphraseConfirm}
                  onChange={e => setPassphraseConfirm(e.target.value)}
                />
              </div>
            </div>
            <div className="slide-note">
              This passphrase encrypts the local Zylith seed in this browser.
            </div>
            <button
              className="slide-submit"
              disabled={!passphrase || !passphraseConfirm || working || !w}
              onClick={() => { void handleCreate(); }}
            >
              {working ? "Creating…" : hasVault ? "Replace with new Zylith wallet" : "Create Zylith wallet"}
            </button>
            {hasVault && (
              <button
                type="button"
                className="wallet-recover-link"
                onClick={() => {
                  setPrivKeyTab("unlock");
                  setError("");
                  setPassphrase("");
                  setPassphraseConfirm("");
                }}
              >
                Back to passphrase unlock
              </button>
            )}
          </>
        )}

        {privKeyTab === "create" && mnemonic && (
          <>
            <div className="f-label" style={{ marginBottom: 6 }}>Recovery phrase</div>
            <div style={{
              background: "var(--z-app-elevated-solid)",
              boxShadow: "inset 0 0 0 1px var(--z-border)",
              borderRadius: 1, padding: "10px 12px",
              fontSize: 11, lineHeight: 1.8,
              color: "var(--z-text-strong)",
              marginBottom: 10, wordBreak: "break-word",
              fontFamily: "var(--z-font-mono)",
            }}>
              {mnemonic}
            </div>
            <div style={{ fontSize: 11, color: "var(--z-status-warn)", marginBottom: 12, lineHeight: 1.5 }}>
              Save this. It is the only way to recover your private order history and note balances.
            </div>
            <button className="slide-submit" onClick={onClose}>
              Saved — continue
            </button>
          </>
        )}

        {privKeyTab === "import" && (
          <>
            <div className="f-row">
              <label className="f-label">Recovery phrase or seed hex</label>
              <textarea
                style={{
                  width: "100%", background: "var(--z-app-elevated-solid)",
                  boxShadow: "inset 0 0 0 1px var(--z-border)",
                  borderRadius: 1, padding: "8px 10px", fontSize: 11,
                  color: "var(--z-text-strong)", fontFamily: "var(--z-font-mono)",
                  resize: "vertical", minHeight: 80, outline: "none", border: "none",
                }}
                placeholder="24-word phrase or 64-char hex seed…"
                value={phrase}
                onChange={e => setPhrase(e.target.value)}
              />
            </div>
            <div className="f-row">
              <label className="f-label">Passphrase</label>
              <div className="f-input-box">
                <input
                  className="f-input"
                  type="password"
                  placeholder="Choose a passphrase"
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                />
              </div>
            </div>
            <div className="f-row">
              <label className="f-label">Confirm passphrase</label>
              <div className="f-input-box">
                <input
                  className="f-input"
                  type="password"
                  placeholder="Re-enter passphrase"
                  value={passphraseConfirm}
                  onChange={e => setPassphraseConfirm(e.target.value)}
                />
              </div>
            </div>
            <div className="slide-note">
              This passphrase encrypts the recovered Zylith seed locally.
            </div>
            <button
              className="slide-submit"
              disabled={!phrase.trim() || !passphrase || !passphraseConfirm || working || !w}
              onClick={() => { void handleImport(); }}
            >
              {working ? "Importing…" : hasVault ? "Replace local Zylith wallet" : "Import Zylith wallet"}
            </button>
            {hasVault && (
              <button
                type="button"
                className="wallet-recover-link"
                onClick={() => {
                  setPrivKeyTab("unlock");
                  setError("");
                  setPhrase("");
                  setPassphrase("");
                  setPassphraseConfirm("");
                }}
              >
                Back to passphrase unlock
              </button>
            )}
          </>
        )}

        {privKeyTab === "unlock" && (
          <>
            <div className="f-row">
              <label className="f-label">Passphrase</label>
              <div className="f-input-box">
                <input
                  className="f-input"
                  type="password"
                  placeholder="Enter your passphrase"
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") void handleUnlock(); }}
                />
              </div>
            </div>
            <button
              className="slide-submit"
              disabled={!passphrase || working || !w}
              onClick={() => { void handleUnlock(); }}
            >
              {working ? "Unlocking…" : "Unlock Zylith wallet"}
            </button>
          </>
        )}

        {error && (
          <div style={{ fontSize: 11, color: "var(--z-status-danger)", marginTop: 10, lineHeight: 1.5 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

export function RecoverySlide({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) {
      setPassphrase("");
      setMnemonic("");
      setError("");
      setWorking(false);
    }
  }, [open]);

  async function handleReveal() {
    const w = walletRuntime();
    if (!w || !w.isReady()) { setError("Unlock Zylith wallet first."); return; }
    if (!passphrase) { setError("Enter your passphrase"); return; }
    setWorking(true);
    setError("");
    try {
      setMnemonic(await w.exportRecoverySeed(passphrase));
    } catch (e) {
      setError(userFacingErrorMessage(e));
    } finally {
      setWorking(false);
    }
  }

  async function handleCopy() {
    if (!mnemonic) return;
    await navigator.clipboard?.writeText(mnemonic).catch(() => undefined);
  }

  const words = mnemonic.trim().split(/\s+/).filter(Boolean);

  return (
    <div className={`slide-panel ${open ? "open" : ""}`}>
      <div className="slide-hd">
        <span className="slide-title">Recovery Phrase</span>
        <button className="slide-close" onClick={onClose}>×</button>
      </div>
      <div className="slide-body">
        <div style={{ fontSize: 11, color: "var(--z-text-body)", lineHeight: 1.5, marginBottom: 14 }}>
          Re-enter your Zylith wallet passphrase to reveal the recovery phrase.
        </div>
        <div className="f-row">
          <label className="f-label">Passphrase</label>
          <div className="f-input-box">
            <input
              className="f-input"
              type="password"
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") void handleReveal(); }}
            />
          </div>
        </div>
        {error && (
          <div style={{ fontSize: 11, color: "var(--z-status-danger)", marginBottom: 8 }}>{error}</div>
        )}
        <button
          className="slide-submit"
          disabled={!passphrase || working}
          onClick={() => { void handleReveal(); }}
        >
          {working ? "Checking…" : "Reveal phrase"}
        </button>
        {mnemonic && (
          <>
            <div className="recovery-grid">
              {words.map((word, index) => (
                <div key={`${word}-${index}`} className="recovery-word">
                  <span>{index + 1}</span>
                  <strong>{word}</strong>
                </div>
              ))}
            </div>
            <div className="recovery-meta">{words.length} words</div>
            <button className="btn-ghost recovery-copy" onClick={() => { void handleCopy(); }}>
              Copy phrase
            </button>
          </>
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
  onOpenWallet,
  setSlideAsset,
}: {
  open: boolean;
  onClose: () => void;
  defaultAsset: string;
  allAssets: string[];
  starknetAddress: string | null;
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
      const label = currentPrivacyFundingStageLabel(depositStartedAtRef.current);
      if (label) setFundingStage(label);
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [working]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setAsset(allAssets.includes(defaultAsset) ? defaultAsset : allAssets[0] ?? defaultAsset);
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
    if (!w || !w.isReady()) { setError("Unlock Zylith wallet first."); return; }
    if (!starknetAddress) { setError("Connect a Starknet wallet before depositing."); return; }
    if (!amount.trim()) { setError("Enter an amount"); return; }
    const atomicAmount = toAtomicStr(amount, asset);
    if (atomicAmount === "0") { setError("Enter a valid amount."); return; }
    depositStartedAtRef.current = Date.now();
    setWorking(true);
    setError("");
    setFundingStage("Preparing private deposit");
    try {
      await w.submitDepositViaWallet(asset, atomicAmount);
      setAmount("");
      onClose();
    } catch (e) {
      setError(userFacingErrorMessage(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className={`slide-panel ${open ? "open" : ""}`}>
      <div className="slide-hd">
        <span className="slide-title">Deposit</span>
        <button className="slide-close" onClick={onClose}>×</button>
      </div>
      <div className="slide-body">
        {!starknetAddress && (
          <div className="slide-inline-notice">
            <span>Connect a Starknet wallet to deposit.</span>
            <button type="button" className="slide-inline-action" onClick={onOpenWallet}>
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
              onChange={e => setAmount(e.target.value)}
            />
            <select
              className="amount-asset-select"
              value={asset}
              onChange={e => changeAsset(e.target.value)}
            >
              {allAssets.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        </div>
        {error && (
          <div style={{ fontSize: 11, color: "var(--z-status-danger)", marginBottom: 8 }}>{error}</div>
        )}
        <button
          className="slide-submit"
          disabled={!starknetAddress || !amount.trim() || working}
          onClick={() => { void handleDeposit(); }}
        >
          {working ? "Depositing…" : starknetAddress ? `Deposit ${asset}` : "Connect wallet first"}
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
  withdrawalRoutePreference,
  allAssets,
  setSlideAsset,
}: {
  open: boolean;
  onClose: () => void;
  defaultAsset: string;
  defaultNoteCommitment?: string | null;
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  claimDelaySeconds: number;
  withdrawalRoutePreference: WithdrawalRoutePreference;
  allAssets: string[];
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
  const hostedWithdrawalAvailable = Boolean(w?.hostedWithdrawalAvailable?.());
  const assetNotes = notes.filter(n => {
    const retryableStrk20Exit = Boolean(
      n.strk20_exit_commitment &&
      n.pending_withdrawal_tx &&
      !n.pending_strk20_open_note_tx
    );
    if (n.asset !== asset || n.locked || n.spent) return false;
    if (n.source !== "settlement_output") return false;
    if (retryableStrk20Exit) return true;
    if (n.pending_withdrawal_tx) return false;
    const readyAt = settlementReadyAtMs(n, settlementTranscripts, claimDelaySeconds);
    return readyAt !== null && now >= readyAt;
  }).sort((a, b) => {
    if (withdrawalRoutePreference === "privacy_window") {
      return (settlementReadyAtMs(a, settlementTranscripts, claimDelaySeconds) ?? 0)
        - (settlementReadyAtMs(b, settlementTranscripts, claimDelaySeconds) ?? 0);
    }
    const amountA = BigInt(a.amount);
    const amountB = BigInt(b.amount);
    return amountA === amountB ? 0 : amountA > amountB ? -1 : 1;
  });
  const depositNotesNotWithdrawable = notes.filter(n =>
    n.asset === asset &&
    n.source !== "settlement_output" &&
    !n.spent &&
    !n.pending_withdrawal_tx
  );
  const selectedWithdrawNote = assetNotes.find(n => n.note_commitment === selectedNote) ?? assetNotes[0] ?? null;
  const selectedIsRetry =
    Boolean(selectedWithdrawNote?.strk20_exit_commitment) &&
    Boolean(selectedWithdrawNote?.pending_withdrawal_tx) &&
    !selectedWithdrawNote?.pending_strk20_open_note_tx;

  async function handleWithdraw() {
    if (!w || !w.isReady()) { setError("Unlock Zylith wallet first."); return; }
    if (!hostedWithdrawalAvailable) { setError("Withdrawals are not enabled for this deployment."); return; }
    if (!selectedWithdrawNote) { setError(`No available ${asset} notes.`); return; }
    setWorking(true);
    setError("");
    try {
      const note = selectedWithdrawNote;
      await w.submitHostedWithdrawal({
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

  return (
    <div className={`slide-panel ${open ? "open" : ""}`}>
      <div className="slide-hd">
        <span className="slide-title">Withdraw</span>
        <button className="slide-close" onClick={onClose}>×</button>
      </div>
      <div className="slide-body">
        <div className="f-row">
          <label className="f-label">Asset</label>
          <div className="f-input-box">
            <select
              className="asset-select-input"
              value={asset}
              onChange={e => changeAsset(e.target.value)}
            >
              {allAssets.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--z-text-body)", marginBottom: 12 }}>
          {assetNotes.length > 0
            ? `${assetNotes.length} note${assetNotes.length !== 1 ? "s" : ""} available`
            : `No ${asset} notes`}
          {assetNotes.length > 0 && (
            <>
              {" · "}
              {withdrawalRoutePreference === "privacy_window"
                ? "oldest claim-ready note selected first"
                : "largest claim-ready note selected first"}
            </>
          )}
        </div>
        {depositNotesNotWithdrawable.length > 0 && (
          <div className="slide-note">
            {depositNotesNotWithdrawable.length} deposit note{depositNotesNotWithdrawable.length !== 1 ? "s are" : " is"} available in the private wallet but not directly withdrawable. Submit through settlement first, then withdraw the resulting settlement output.
          </div>
        )}
        {!hostedWithdrawalAvailable && (
          <div className="slide-note warn">
            Withdrawals are not enabled for this deployment.
          </div>
        )}
        {assetNotes.length > 0 && (
          <div className="f-row">
            <label className="f-label">Note</label>
            <div className="note-select-list">
              {assetNotes.map(note => (
                <button
                  key={note.note_commitment}
                  type="button"
                  className={`note-select-row ${selectedWithdrawNote?.note_commitment === note.note_commitment ? "on" : ""}`}
                  onClick={() => setSelectedNote(note.note_commitment)}
                >
                  <span>{fromAtomicStr(note.amount, asset)} {asset}</span>
                  <span>{fmtAddr(note.note_commitment)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {error && (
          <div style={{ fontSize: 11, color: "var(--z-status-danger)", marginBottom: 8 }}>{error}</div>
        )}
        <button
          className="slide-submit"
          disabled={!hostedWithdrawalAvailable || !selectedWithdrawNote || working}
          onClick={() => { void handleWithdraw(); }}
        >
          {working ? "Submitting…" : selectedIsRetry ? "Retry STRK20 note claim" : "Withdraw to STRK20 note"}
        </button>
      </div>
    </div>
  );
}
