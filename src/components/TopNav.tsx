import { useEffect, useRef, useState } from "react";
import { type WalletBalance } from "../domain/shieldedBalances";
import {
  clearSelectedStarknetProvider,
  disconnectStarknetProvider,
  fmtAddr,
  walletRuntime,
} from "../domain/browserWallet";
import {
  LIQUIDITY_TABS,
  TAKER_TABS,
  type AppTab,
  type LiquidityTab,
  type Workspace,
} from "../domain/appRoutes";

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
  starknetAddress,
  onOpenWallet,
  onDeposit,
  onWithdraw,
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
  starknetAddress: string | null;
  onOpenWallet: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
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
  const balances: WalletBalance[] = walletReady
    ? wallet?.getBalances() ?? []
    : [];
  const btnLabel = starknetAddress ? fmtAddr(starknetAddress) : "CONNECT WALLET";

  function handleWalletClick() {
    if (!starknetAddress || !walletReady) {
      setMenuOpen(false);
      onOpenWallet();
      return;
    }
    setMenuOpen((open) => !open);
  }

  function handleDisconnectWallet() {
    onLock();
    disconnectStarknetProvider();
    setMenuOpen(false);
    onDisconnectWallet();
  }

  function handleSwitchWallet() {
    onLock();
    clearSelectedStarknetProvider();
    setMenuOpen(false);
    onDisconnectWallet();
    onOpenWallet();
  }

  return (
    <nav className="top-nav">
      <button
        type="button"
        className="nav-brand"
        onClick={onBrandClick}
        aria-label="Go to Trade"
      >
        <img src="/zylith.png" alt="" aria-hidden="true" />
        <span>ZYLITH</span>
        {workspace === "liquidity" && (
          <span className="workspace-mode-pill">Liquidity</span>
        )}
      </button>

      <div className="nav-tabs">
        {workspace === "liquidity"
          ? LIQUIDITY_TABS.map((nextTab) => (
              <button
                key={nextTab}
                className={`nav-tab ${liquidityTab === nextTab ? "on" : ""}`}
                onClick={() => setLiquidityTab(nextTab)}
              >
                {nextTab === "positions"
                  ? "Positions"
                  : nextTab === "orders"
                  ? "Orders"
                  : nextTab === "inventory"
                  ? "Inventory"
                  : "Analytics"}
              </button>
            ))
          : TAKER_TABS.map((nextTab) => (
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
          className={`wallet-btn ${!starknetAddress ? "connect-cta" : ""} ${
            starknetAddress && !walletReady ? "needs-auth" : ""
          }`}
          onClick={handleWalletClick}
        >
          <span className="wallet-addr">{btnLabel}</span>
          {starknetAddress && walletReady && claimableOutputCount > 0 && (
            <span
              className="wallet-claim-badge"
              title={`${claimableOutputCount} output${
                claimableOutputCount === 1 ? "" : "s"
              } ready to withdraw`}
            >
              {claimableOutputCount}
            </span>
          )}
          {starknetAddress && <span className="wallet-caret">▾</span>}
        </button>

        {menuOpen && (
          <>
            <div
              className="wallet-menu-backdrop"
              onClick={() => setMenuOpen(false)}
            />
            <div className="wallet-menu">
              <div className="wallet-menu-section">
                <div className="wallet-menu-header">
                  {starknetAddress ? (
                    <>
                      <div className="wallet-menu-eyebrow">
                        Starknet · Sepolia
                      </div>
                      <div className="wallet-menu-id">
                        {fmtAddr(starknetAddress)}
                      </div>
                      <div className="wallet-menu-bal">
                        {walletReady
                          ? `${balances.length} asset${
                              balances.length !== 1 ? "s" : ""
                            } · private`
                          : "Authorization required"}
                      </div>
                    </>
                  ) : (
                    <div
                      className="wallet-menu-eyebrow"
                      style={{ color: "var(--z-text-body)" }}
                    >
                      No wallet connected
                    </div>
                  )}
                </div>
              </div>

              {starknetAddress && walletReady && (
                <div className="wallet-menu-section">
                  <button
                    className="wallet-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onDeposit();
                    }}
                  >
                    Deposit
                  </button>
                  <button
                    className="wallet-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onWithdraw();
                    }}
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

              {walletReady && starknetAddress && (
                <div className="wallet-menu-section">
                  <button
                    className="wallet-menu-item danger"
                    onClick={handleDisconnectWallet}
                  >
                    Disconnect wallet
                    <span
                      className="wallet-disconnect-icon"
                      aria-hidden="true"
                    >
                      <svg viewBox="0 0 16 16" focusable="false">
                        <path d="M6.2 3.2H3.8A1.8 1.8 0 0 0 2 5v6a1.8 1.8 0 0 0 1.8 1.8h2.4M9.6 5.1 12.5 8l-2.9 2.9M5.7 8h6.4" />
                      </svg>
                    </span>
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </nav>
  );
}
