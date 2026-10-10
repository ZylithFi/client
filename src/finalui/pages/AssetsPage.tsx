import { useMemo, useState } from "react";
import { safeFromAtomicStr } from "../../domain/assets";
import type { WithdrawableNote } from "@zylith/sdk";
import type { PendingDeposit, WalletBalance } from "../../domain/shieldedBalances";
import { TokenIcon } from "../components/TokenIcon";
import { FilterDropdown } from "../components/FilterDropdown";
import { type OrderSortDirection, SortableTableHeader } from "../components/OrderTableCells";

type AssetFilter = "All" | string;
type TransferFilter = "All" | "Deposit" | "Withdrawal";
type StatusFilter = "All" | "Completed" | "Pending" | "Failed";
type TransferSortKey = "value" | "time";
type TransferRow = {
  id: string;
  asset: string;
  type: "Deposit" | "Withdrawal";
  amount: string;
  status: "Completed" | "Pending" | "Failed";
  timestamp: number | null;
  time: string;
  value: number | null;
  valueDisplay: string;
};

function TransferStatus({ status }: { status: "Completed" | "Pending" | "Failed" }) {
  const tone = status === "Completed" ? "success" : status === "Pending" ? "blue" : "danger";
  return <span className={`status-chip ${tone}`}><i/>{status}</span>;
}

function safeAtomic(value: string | undefined) {
  return value && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function displayTimestamp(value: number | null) {
  return value !== null && Number.isSafeInteger(value) && value > 0
    ? new Date(value).toLocaleString()
    : "Pending";
}

export function AssetsPage({
  allAssets,
  defaultDepositAsset,
  balances,
  pendingDeposits,
  withdrawals,
  walletConnected,
  walletReady,
  assetUnitPrices,
  onConnectWallet,
  onDeposit,
  onWithdraw,
}: {
  allAssets: string[];
  defaultDepositAsset: string;
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  withdrawals: WithdrawableNote[];
  walletConnected: boolean;
  walletReady: boolean;
  assetUnitPrices: Record<string, number>;
  onConnectWallet: () => void;
  onDeposit: (asset: string) => void;
  onWithdraw: (asset: string) => void;
}) {
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("All");
  const [typeFilter, setTypeFilter] = useState<TransferFilter>("All");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [balanceValueSortDirection, setBalanceValueSortDirection] = useState<OrderSortDirection | null>(null);
  const [transferSortKey, setTransferSortKey] = useState<TransferSortKey | null>("time");
  const [transferSortDirection, setTransferSortDirection] = useState<OrderSortDirection>("descending");
  const assets = allAssets;
  const balanceRows = assets.map((asset) => {
    const balance = balances.find((entry) => entry.asset === asset);
    const availableAtomic = safeAtomic(balance?.available);
    const lockedAtomic = safeAtomic(balance?.locked);
    const total = safeFromAtomicStr((availableAtomic + lockedAtomic).toString(), asset, "0");
    const unitPrice = assetUnitPrices[asset];
    const valueNumeric = unitPrice === undefined ? null : Number(total.replaceAll(",", "")) * unitPrice;
    return {
      asset,
      available: safeFromAtomicStr(availableAtomic.toString(), asset, "0"),
      locked: safeFromAtomicStr(lockedAtomic.toString(), asset, "0"),
      total,
      value: valueNumeric === null || !Number.isFinite(valueNumeric)
        ? "Unavailable"
        : valueNumeric.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }),
      valueNumeric,
    };
  });
  const sortedBalanceRows = balanceValueSortDirection === null ? balanceRows : [...balanceRows].sort((left, right) => {
    if (left.valueNumeric === null && right.valueNumeric === null) return left.asset.localeCompare(right.asset);
    if (left.valueNumeric === null) return 1;
    if (right.valueNumeric === null) return -1;
    const result = left.valueNumeric - right.valueNumeric;
    return (balanceValueSortDirection === "ascending" ? result : -result) || left.asset.localeCompare(right.asset);
  });
  const transferValue = (asset: string, amount: string) => {
    const unitPrice = assetUnitPrices[asset];
    if (unitPrice === undefined) return { value: null, valueDisplay: "Unavailable" };
    const value = Number(amount.replaceAll(",", "")) * unitPrice;
    return Number.isFinite(value)
      ? { value, valueDisplay: value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }) }
      : { value: null, valueDisplay: "Unavailable" };
  };
  const transfers: TransferRow[] = pendingDeposits.map((deposit) => {
    const amount = safeFromAtomicStr(deposit.amount, deposit.asset, "0");
    const timestamp = deposit.requested_at_unix_ms ?? null;
    return {
      id: deposit.request_id ?? deposit.note_commitment,
      asset: deposit.asset,
      type: "Deposit" as const,
      amount,
      status: deposit.failed ? "Failed" as const : deposit.confirmed ? "Completed" as const : "Pending" as const,
      timestamp,
      time: displayTimestamp(timestamp),
      ...transferValue(deposit.asset, amount),
    };
  });
  transfers.push(...withdrawals.filter((note) => note.exit_stage).map((note) => {
    const amount = safeFromAtomicStr(note.amount, note.asset, "0");
    const timestamp = note.requested_at_unix_ms ?? null;
    return {
      id: note.note_commitment,
      asset: note.asset,
      type: "Withdrawal" as const,
      amount,
      status: note.exit_stage === "failed" ? "Failed" as const : note.spent ? "Completed" as const : "Pending" as const,
      timestamp,
      time: displayTimestamp(timestamp),
      ...transferValue(note.asset, amount),
    };
  }));
  const rows = useMemo(() => {
    const filtered = transfers.filter((row) =>
      (assetFilter === "All" || row.asset === assetFilter) &&
      (typeFilter === "All" || row.type === typeFilter) &&
      (statusFilter === "All" || row.status === statusFilter)
    );
    if (transferSortKey === null) return filtered;
    return [...filtered].sort((left, right) => {
      const leftValue = transferSortKey === "value" ? left.value : left.timestamp;
      const rightValue = transferSortKey === "value" ? right.value : right.timestamp;
      if (leftValue === null && rightValue === null) return left.id.localeCompare(right.id);
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      const result = leftValue - rightValue;
      return (transferSortDirection === "ascending" ? result : -result) || left.id.localeCompare(right.id);
    });
  }, [assetFilter, statusFilter, transferSortDirection, transferSortKey, transfers, typeFilter]);

  function handleTransferSort(nextKey: TransferSortKey) {
    if (nextKey !== transferSortKey) {
      setTransferSortKey(nextKey);
      setTransferSortDirection("descending");
    } else if (transferSortDirection === "descending") {
      setTransferSortDirection("ascending");
    } else {
      setTransferSortKey(null);
      setTransferSortDirection("descending");
    }
  }

  function handleBalanceValueSort() {
    setBalanceValueSortDirection((current) => current === null ? "descending" : current === "descending" ? "ascending" : null);
  }

  const transferSortProps = { activeKey: transferSortKey, direction: transferSortDirection, onSort: handleTransferSort };

  function openTransfer(mode: "deposit" | "withdraw", asset?: string) {
    const selectedAsset = asset ?? (mode === "deposit" ? defaultDepositAsset : assets[0]);
    if (!selectedAsset) return;
    if (!walletReady) {
      onConnectWallet();
      return;
    }
    if (mode === "deposit") onDeposit(selectedAsset);
    else onWithdraw(selectedAsset);
  }

  if (!walletReady) {
    const action = walletConnected ? "Unlock private balance" : "Connect wallet";
    return (
      <main className="page-content assets-page">
        <section className="page-hero">
          <div><h1>Assets</h1><p>Your balances and transfers inside Zylith.</p></div>
        </section>
        <section className="data-section asset-balance-section" aria-label="Private balances">
          <div className="section-meta-row"><strong>Private balance</strong><span>{action}</span></div>
          <div className="account-empty-state"><strong>{walletConnected ? "Unlock your private balance to continue." : "Connect wallet to view your private balances."}</strong><button className="wallet-button" type="button" onClick={onConnectWallet}>{action}</button></div>
        </section>
        <section className="data-section transfer-section" aria-labelledby="transfer-history-title">
          <div className="section-title-row"><div><h2 id="transfer-history-title">Transfer history</h2></div></div>
          <div className="account-empty-state compact"><strong>{walletConnected ? "Unlock your private balance to view transfer history." : "Connect wallet to view your transfer history."}</strong></div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-content assets-page">
      <section className="page-hero">
        <div><h1>Assets</h1><p>Your balances and transfers inside Zylith.</p></div>
        <div className="page-actions"><button className="secondary-button" type="button" onClick={() => openTransfer("withdraw")}>Withdraw</button><button className="primary-small-button" type="button" onClick={() => openTransfer("deposit")}>Deposit</button></div>
      </section>

      <section className="data-section asset-balance-section" aria-label="Private balances">
        <div className="section-meta-row"><strong>Private balance</strong></div>
        <div className="table-scroll">
          <table className="asset-table">
            <thead><tr><th>Asset</th><th className="numeric-cell">Available</th><th className="numeric-cell">In orders</th><th className="numeric-cell">Total</th><SortableTableHeader className="numeric-cell" label="Value" sortKey="value" activeKey={balanceValueSortDirection === null ? null : "value"} direction={balanceValueSortDirection ?? "descending"} onSort={handleBalanceValueSort}/></tr></thead>
            <tbody>{sortedBalanceRows.map((row) => <tr key={row.asset}><td><div className="token-cell"><TokenIcon token={row.asset} size={25}/><strong>{row.asset}</strong></div></td><td className="numeric-cell">{row.available}</td><td className="numeric-cell">{row.locked}</td><td className="numeric-cell"><strong>{row.total}</strong></td><td className="numeric-cell">{row.value}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="data-section transfer-section" aria-labelledby="transfer-history-title">
        <div className="section-title-row"><div><h2 id="transfer-history-title">Transfer history</h2></div><div className="filter-row"><span>Filters</span><FilterDropdown label="Status" value={statusFilter} options={["All", "Completed", "Pending", "Failed"]} onChange={(value) => setStatusFilter(value as StatusFilter)} /><FilterDropdown label="Asset" value={assetFilter} options={["All", ...assets]} onChange={setAssetFilter} /><FilterDropdown label="Type" value={typeFilter} options={["All", "Deposit", "Withdrawal"]} onChange={(value) => setTypeFilter(value as TransferFilter)} />{(statusFilter !== "All" || assetFilter !== "All" || typeFilter !== "All") && <button className="clear-filter" type="button" onClick={() => { setAssetFilter("All"); setTypeFilter("All"); setStatusFilter("All"); }}>Clear</button>}</div></div>
        <div className="table-scroll">
          <table className="transfer-table">
            <thead><tr><th>Status</th><th>Asset</th><th>Type</th><th className="numeric-cell">Amount</th><SortableTableHeader className="numeric-cell" label="Value" sortKey="value" {...transferSortProps}/><SortableTableHeader className="time-cell" label="Time" sortKey="time" {...transferSortProps}/><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{rows.length > 0 ? rows.map((row) => <tr key={row.id}><td><TransferStatus status={row.status}/></td><td><div className="token-cell"><TokenIcon token={row.asset} size={21}/><strong>{row.asset}</strong></div></td><td>{row.type}</td><td className="numeric-cell">{row.amount}</td><td className="numeric-cell">{row.valueDisplay}</td><td className="muted time-cell">{row.time}</td><td>{row.status === "Failed" && <button type="button" className="slide-inline-action" onClick={() => openTransfer(row.type === "Deposit" ? "deposit" : "withdraw", row.asset)}>Review</button>}</td></tr>) : <tr><td colSpan={7}><div className="table-empty">{walletReady ? "No transfers match these filters." : "Connect wallet to view transfer history."}</div></td></tr>}</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
