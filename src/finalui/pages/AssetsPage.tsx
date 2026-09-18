import { useMemo, useState } from "react";
import { safeFromAtomicStr } from "../../domain/assets";
import type { PendingDeposit, WalletBalance } from "../../domain/shieldedBalances";
import { TokenIcon } from "../components/TokenIcon";

type AssetFilter = "All" | string;
type TransferFilter = "All" | "Deposit" | "Withdrawal";
type StatusFilter = "All" | "Completed" | "Pending" | "Failed";

function TransferStatus({ status }: { status: "Completed" | "Pending" | "Failed" }) {
  const tone = status === "Completed" ? "success" : status === "Pending" ? "blue" : "danger";
  return <span className={`status-chip ${tone}`}><i/>{status}</span>;
}

function compactReference(value: string) {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
}

export function AssetsPage({
  allAssets,
  balances,
  pendingDeposits,
  walletReady,
  onConnectWallet,
  onDeposit,
  onWithdraw,
}: {
  allAssets: string[];
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  walletReady: boolean;
  onConnectWallet: () => void;
  onDeposit: (asset: string) => void;
  onWithdraw: (asset: string) => void;
}) {
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("All");
  const [typeFilter, setTypeFilter] = useState<TransferFilter>("All");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const assets = allAssets.length > 0 ? allAssets : ["STRK", "USDC"];
  const balanceRows = assets.map((asset) => {
    const balance = balances.find((entry) => entry.asset === asset);
    const availableAtomic = BigInt(balance?.available ?? "0");
    const lockedAtomic = BigInt(balance?.locked ?? "0");
    return {
      asset,
      available: safeFromAtomicStr(availableAtomic.toString(), asset, "0"),
      locked: safeFromAtomicStr(lockedAtomic.toString(), asset, "0"),
      total: safeFromAtomicStr((availableAtomic + lockedAtomic).toString(), asset, "0"),
    };
  });
  const transfers = pendingDeposits.map((deposit) => ({
    id: deposit.request_id ?? deposit.note_commitment,
    asset: deposit.asset,
    type: "Deposit" as const,
    amount: safeFromAtomicStr(deposit.amount, deposit.asset, "0"),
    status: deposit.failed ? "Failed" as const : deposit.confirmed ? "Completed" as const : "Pending" as const,
    reference: deposit.transaction_hash ?? deposit.request_id ?? deposit.note_commitment,
    time: deposit.requested_at_unix_ms
      ? new Date(deposit.requested_at_unix_ms).toLocaleString()
      : "-",
  }));
  const rows = useMemo(() => transfers.filter((row) =>
    (assetFilter === "All" || row.asset === assetFilter) &&
    (typeFilter === "All" || row.type === typeFilter) &&
    (statusFilter === "All" || row.status === statusFilter)
  ), [assetFilter, statusFilter, transfers, typeFilter]);

  function cycleAsset() {
    const values = ["All", ...assets];
    setAssetFilter(values[(values.indexOf(assetFilter) + 1) % values.length]);
  }
  function cycleType() {
    setTypeFilter(typeFilter === "All" ? "Deposit" : typeFilter === "Deposit" ? "Withdrawal" : "All");
  }
  function cycleStatus() {
    setStatusFilter(statusFilter === "All" ? "Completed" : statusFilter === "Completed" ? "Pending" : statusFilter === "Pending" ? "Failed" : "All");
  }
  function openTransfer(mode: "deposit" | "withdraw", asset = "USDC") {
    if (!walletReady) {
      onConnectWallet();
      return;
    }
    if (mode === "deposit") onDeposit(asset);
    else onWithdraw(asset);
  }

  if (!walletReady) {
    return (
      <main className="page-content assets-page">
        <section className="page-hero">
          <div><span className="page-kicker">PRIVATE BALANCES</span><h1>Assets</h1><p>Balances held inside Zylith remain private to your connected wallet.</p></div>
        </section>
        <section className="data-section asset-balance-section" aria-label="Private balances">
          <div className="section-meta-row"><div><span>Private balance</span><strong>-</strong></div><span className="privacy-copy">Connect to load private balances and in-flight amounts.</span></div>
          <div className="account-empty-state"><strong>Connect wallet to view your private balances.</strong><span>Your STRK and USDC balances will appear here after connection.</span><button className="wallet-button" type="button" onClick={onConnectWallet}>Connect wallet</button></div>
        </section>
        <section className="data-section transfer-section" aria-labelledby="transfer-history-title">
          <div className="section-title-row"><div><span className="page-kicker">MONEY MOVEMENT</span><h2 id="transfer-history-title">Transfer history</h2></div></div>
          <div className="account-empty-state compact"><strong>Connect wallet to view your transfer history.</strong><span>Deposits and withdrawals are private to your wallet session.</span></div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-content assets-page">
      <section className="page-hero">
        <div><span className="page-kicker">PRIVATE BALANCES</span><h1>Assets</h1><p>Balances held inside Zylith remain separate from your Starknet wallet. Money movement lives here; trading lifecycle lives under Orders.</p></div>
        <div className="page-actions"><button className="secondary-button" type="button" onClick={() => openTransfer("withdraw")}>Withdraw</button><button className="primary-small-button" type="button" onClick={() => openTransfer("deposit")}>Deposit</button></div>
      </section>

      <section className="data-section asset-balance-section" aria-label="Private balances">
        <div className="section-meta-row"><div><span>Private balance</span><strong>{walletReady ? `${balances.length} assets` : "Connect wallet"}</strong></div><span className="privacy-copy">Available and in-flight balances are separated so you can see what is currently tradable.</span></div>
        <div className="table-scroll">
          <table className="asset-table">
            <thead><tr><th>Token</th><th>Wallet</th><th>Available</th><th>In orders / settling</th><th>Private total</th><th>Value</th><th/></tr></thead>
            <tbody>{balanceRows.map((row) => <tr key={row.asset}><td><div className="token-cell"><TokenIcon token={row.asset} size={25}/><strong>{row.asset}</strong></div></td><td>-</td><td>{walletReady ? row.available : "-"}</td><td>{walletReady ? row.locked : "-"}</td><td><strong>{walletReady ? row.total : "-"}</strong></td><td>-</td><td><div className="row-actions"><button type="button" onClick={() => openTransfer("deposit", row.asset)}>Deposit</button><button type="button" onClick={() => openTransfer("withdraw", row.asset)}>Withdraw</button></div></td></tr>)}</tbody>
          </table>
        </div>
        <div className="asset-explainer"><span>ⓘ</span><p><strong>Wallet</strong> is your public Starknet balance. <strong>Private total</strong> is held inside Zylith; amounts committed to active orders appear under in orders / settling.</p></div>
      </section>

      <section className="data-section transfer-section" aria-labelledby="transfer-history-title">
        <div className="section-title-row"><div><span className="page-kicker">MONEY MOVEMENT</span><h2 id="transfer-history-title">Transfer history</h2></div><div className="filter-row"><span>Filters</span><button type="button" onClick={cycleStatus}>＋ Status: {statusFilter}</button><button type="button" onClick={cycleAsset}>＋ Asset: {assetFilter}</button><button type="button" onClick={cycleType}>＋ Type: {typeFilter}</button>{(statusFilter !== "All" || assetFilter !== "All" || typeFilter !== "All") && <button className="clear-filter" type="button" onClick={() => { setAssetFilter("All"); setTypeFilter("All"); setStatusFilter("All"); }}>Clear</button>}</div></div>
        <div className="table-scroll">
          <table className="transfer-table">
            <thead><tr><th>Status</th><th>Asset</th><th>Type</th><th>Amount</th><th>Value</th><th>Reference</th><th>Time</th></tr></thead>
            <tbody>{rows.length > 0 ? rows.map((row) => <tr key={row.id}><td><TransferStatus status={row.status}/></td><td><div className="token-cell"><TokenIcon token={row.asset} size={21}/><strong>{row.asset}</strong></div></td><td>{row.type}</td><td>{row.amount}</td><td>-</td><td className="mono muted">{compactReference(row.reference)}</td><td className="muted">{row.time}</td></tr>) : <tr><td colSpan={7}><div className="table-empty">{walletReady ? "No transfers match these filters." : "Connect wallet to view transfer history."}</div></td></tr>}</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
