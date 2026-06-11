import { useEffect, useRef, useState } from "react";
import { type WalletBalance } from "../domain/shieldedBalances";
import {
  clearSelectedStarknetProvider,
  disconnectStarknetProvider,
  fmtAddr,
  walletRuntime,
} from "../domain/browserWallet";
import type { WithdrawalRoutePreference } from "../domain/userPreferences";

export type AppTab = "trade" | "orders" | "assets" | "reports";
export type Workspace = "taker" | "liquidity";
export type LiquidityTab = "curves" | "orders" | "inventory" | "analytics";

export function TopNav({
  workspace,
  tab,
  liquidityTab,
  setTab,
  setLiquidityTab,
  onBrandClick,
  onToggleLiquidity,
  activeOrderCount,
  claimableOutputCount,
  walletReady,
  withdrawalRoutePreference,
  setWithdrawalRoutePreference,
  starknetAddress,
  onOpenWallet,
  onDeposit,
  onWithdraw,
  onRecovery,
  onLock,
  onDisconnectWallet,
}: {
  workspace: Workspace;
  tab: AppTab;
  liquidityTab: LiquidityTab;
  setTab: (t: AppTab) => void;
  setLiquidityTab: (t: LiquidityTab) => void;
  onBrandClick: () => void;
  onToggleLiquidity: () => void;
  activeOrderCount: number;
  claimableOutputCount: number;
  walletReady: boolean;
  withdrawalRoutePreference: WithdrawalRoutePreference;
  setWithdrawalRoutePreference: (v: WithdrawalRoutePreference) => void;
  starknetAddress: string | null;
  onOpenWallet: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onRecovery: () => void;
  onLock: () => void;
  onDisconnectWallet: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const wallet = walletRuntime();
  const balances: WalletBalance[] = walletReady ? wallet?.getBalances() ?? [] : [];
  const btnLabel = starknetAddress
    ? walletReady ? fmtAddr(starknetAddress) : "UNLOCK ZYLITH WALLET"
    : "CONNECT WALLET";

  function handleWalletClick() {
    if (!starknetAddress || !walletReady) {
      setMenuOpen(false);
      onOpenWallet();
      return;
    }
    setMenuOpen(open => !open);
  }

  function handleDisconnectWallet() {
    disconnectStarknetProvider();
    setMenuOpen(false);
    onDisconnectWallet();
  }

  function handleSwitchWallet() {
    clearSelectedStarknetProvider();
    setMenuOpen(false);
    onDisconnectWallet();
    onOpenWallet();
  }

  return (
    <nav className="top-nav">
      <button type="button" className="nav-brand" onClick={onBrandClick} aria-label="Go to Trade">
        <img src="/zylith.png" alt="" aria-hidden="true" />
        <span>ZYLITH</span>
        {workspace === "liquidity" && (
          <span className="workspace-mode-pill">Liquidity</span>
        )}
      </button>

      <div className="nav-tabs">
        {workspace === "liquidity"
          ? (["curves", "orders", "inventory", "analytics"] as LiquidityTab[]).map(nextTab => (
              <button
                key={nextTab}
                className={`nav-tab ${liquidityTab === nextTab ? "on" : ""}`}
                onClick={() => setLiquidityTab(nextTab)}
              >
                {nextTab === "curves"
                    ? "Curves"
                    : nextTab === "orders"
                      ? "Orders"
                      : nextTab === "inventory"
                        ? "Inventory"
                        : "Analytics"}
              </button>
            ))
          : (["trade", "orders", "assets", "reports"] as AppTab[]).map(nextTab => (
              <button
                key={nextTab}
                className={`nav-tab ${tab === nextTab ? "on" : ""}`}
                onClick={() => setTab(nextTab)}
              >
                {nextTab === "trade"
                  ? "Trade"
                  : nextTab === "orders"
                    ? "Orders"
                    : nextTab === "assets"
                      ? "Assets"
                      : "TCA"}
                {nextTab === "orders" && activeOrderCount > 0 && (
                  <span className="tab-count">{activeOrderCount}</span>
                )}
              </button>
            ))}
      </div>

      <div className="wallet-area" ref={menuRef}>
        {workspace === "taker" && (
          <button
            type="button"
            className="liquidity-toggle"
            onClick={onToggleLiquidity}
          >
            <span>Liquidity</span>
            <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
              <path d="M3 3h6v6M9 3 3 9" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`wallet-btn ${!starknetAddress ? "connect-cta" : ""} ${starknetAddress && !walletReady ? "needs-unlock" : ""}`}
          onClick={handleWalletClick}
        >
          <span className="wallet-addr">{btnLabel}</span>
          {starknetAddress && walletReady && claimableOutputCount > 0 && (
            <span className="wallet-claim-badge" title={`${claimableOutputCount} output${claimableOutputCount === 1 ? "" : "s"} ready to withdraw`}>
              {claimableOutputCount}
            </span>
          )}
          {starknetAddress && <span className="wallet-caret">▾</span>}
        </button>

        {menuOpen && (
          <>
            <div className="wallet-menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="wallet-menu">
              <div className="wallet-menu-section">
                <div className="wallet-menu-header">
                  {starknetAddress ? (
                    <>
                      <div className="wallet-menu-eyebrow">Starknet · Sepolia</div>
                      <div className="wallet-menu-id">{fmtAddr(starknetAddress)}</div>
                      <div className="wallet-menu-bal">
                        {walletReady
                          ? `${balances.length} asset${balances.length !== 1 ? "s" : ""} · private`
                          : "Zylith wallet locked"}
                      </div>
                    </>
                  ) : (
                    <div className="wallet-menu-eyebrow" style={{ color: "var(--z-text-body)" }}>
                      No wallet connected
                    </div>
                  )}
                </div>
              </div>

              {starknetAddress && walletReady && (
                <div className="wallet-menu-section">
                  <button
                    className="wallet-menu-item"
                    onClick={() => { setMenuOpen(false); onRecovery(); }}
                  >
                    View recovery phrase
                  </button>
                  <div className="wallet-pref">
                    <div className="wallet-pref-head">
                      <span>Withdrawal note selection</span>
                    </div>
                    <div
                      className="wallet-pref-options"
                      style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
                      aria-label="Withdrawal note preference"
                    >
                      {([
                        ["privacy_window", "Oldest"],
                        ["immediate", "Largest"],
                      ] as Array<[WithdrawalRoutePreference, string]>).map(([option, label]) => (
                        <button
                          key={option}
                          type="button"
                          className={`wallet-pref-chip ${withdrawalRoutePreference === option ? "on" : ""}`}
                          onClick={() => setWithdrawalRoutePreference(option)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    className="wallet-menu-item"
                    onClick={() => { setMenuOpen(false); onDeposit(); }}
                  >
                    Deposit
                  </button>
                  <button
                    className="wallet-menu-item"
                    onClick={() => { setMenuOpen(false); onWithdraw(); }}
                  >
                    Withdraw
                  </button>
                  <button
                    className="wallet-menu-item"
                    onClick={handleSwitchWallet}
                  >
                    Switch wallet
                  </button>
                </div>
              )}

              {walletReady && (
                <div className="wallet-menu-section">
                  <button
                    className="wallet-menu-item danger"
                    onClick={() => { setMenuOpen(false); onLock(); }}
                  >
                    Lock Zylith wallet
                  </button>
                  {starknetAddress && (
                    <button
                      className="wallet-menu-item danger"
                      onClick={handleDisconnectWallet}
                    >
                      Disconnect wallet
                      <span className="wallet-disconnect-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false">
                          <path d="M6.2 3.2H3.8A1.8 1.8 0 0 0 2 5v6a1.8 1.8 0 0 0 1.8 1.8h2.4M9.6 5.1 12.5 8l-2.9 2.9M5.7 8h6.4" />
                        </svg>
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </nav>
  );
}
