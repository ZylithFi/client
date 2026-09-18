import { useMemo, useState } from "react";
import type { LocalOrder } from "../../domain/orderLifecycle";
import { statusLabel } from "../../domain/orderLifecycle";
import { SlidersIcon } from "../components/Icons";

type Tab = "Open" | "Fills" | "History";
type SideFilter = "All" | "Buy" | "Sell";
const tabs: Tab[] = ["Open", "Fills", "History"];
const openStatuses = new Set(["queued", "in_batch", "proving", "settling", "settled_pending_output", "partial"]);
const fillStatuses = new Set(["filled", "partial"]);
const historyStatuses = new Set(["filled", "no_fill", "rolled", "cancelled", "failed", "proof_failed", "stalled"]);

function statusTone(status: LocalOrder["status"]) {
  if (status === "filled") return "success";
  if (status === "cancelled" || status === "rolled" || status === "no_fill") return "neutral";
  if (status === "failed" || status === "proof_failed" || status === "stalled") return "danger";
  return "blue";
}

function submittedAt(value: number) {
  return new Date(value).toLocaleString();
}

export function OrdersPage({
  orders,
  walletReady,
  onCancel,
  onConnectWallet,
}: {
  orders: LocalOrder[];
  walletReady: boolean;
  onCancel: (order: LocalOrder) => void;
  onConnectWallet: () => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("Open");
  const [sideFilter, setSideFilter] = useState<SideFilter>("All");
  const [showFilters, setShowFilters] = useState(false);
  const openOrders = useMemo(() => orders.filter((row) => openStatuses.has(row.status)), [orders]);
  const fills = useMemo(() => orders.filter((row) => fillStatuses.has(row.status)), [orders]);
  const history = useMemo(() => orders.filter((row) => historyStatuses.has(row.status)), [orders]);
  const source = activeTab === "Open" ? openOrders : activeTab === "Fills" ? fills : history;
  const visible = useMemo(
    () => source.filter((row) => sideFilter === "All" || row.side === sideFilter),
    [sideFilter, source],
  );

  function cycleSide() {
    setSideFilter(sideFilter === "All" ? "Buy" : sideFilter === "Buy" ? "Sell" : "All");
  }

  if (!walletReady) {
    return (
      <main className="page-content orders-page">
        <section className="page-hero compact-hero">
          <div><span className="page-kicker">PRIVATE ORDER FLOW</span><h1>Orders</h1><p>Your orders, fills, and history are only available after wallet connection.</p></div>
        </section>
        <section className="orders-workspace" aria-label="Order activity">
          <div className="orders-page-toolbar">
            <div className="page-tabs" role="tablist" aria-label="Order lifecycle">{tabs.map((tab) => <button key={tab} type="button" role="tab" aria-selected={tab === "Open"} className={tab === "Open" ? "active" : ""} disabled>{tab}</button>)}</div>
          </div>
          <div className="account-empty-state orders-empty-state"><strong>Connect wallet to view your orders.</strong><span>Open orders, fills, and completed order history will appear here.</span><button className="wallet-button" type="button" onClick={onConnectWallet}>Connect wallet</button></div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-content orders-page">
      <section className="page-hero compact-hero">
        <div><span className="page-kicker">PRIVATE ORDER FLOW</span><h1>Orders</h1><p>Open orders, execution fills, and completed order lifecycle events live together. Deposits and withdrawals remain under Assets.</p></div>
      </section>

      <section className="orders-workspace" aria-label="Order activity">
        <div className="orders-page-toolbar">
          <div className="page-tabs" role="tablist" aria-label="Order lifecycle">
            {tabs.map((tab) => {
              const count = tab === "Open" ? openOrders.length : tab === "Fills" ? fills.length : history.length;
              return <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>{tab}<span>{count}</span></button>;
            })}
          </div>
          <div className="orders-page-actions"><button type="button" className={showFilters ? "active-control" : ""} onClick={() => setShowFilters((value) => !value)}><SlidersIcon className="icon-15"/>Filters</button>{activeTab === "Open" && openOrders.length > 0 && <button type="button" className="danger-outline" onClick={() => openOrders.forEach(onCancel)}>Cancel all open orders</button>}</div>
        </div>

        {showFilters && <div className="orders-filter-bar"><span>Filter</span><button type="button" onClick={cycleSide}>Side: {sideFilter}</button>{sideFilter !== "All" && <button className="clear-filter" type="button" onClick={() => setSideFilter("All")}>Clear</button>}</div>}

        <div className="table-scroll orders-page-table-wrap">
          {activeTab === "Open" && (
            <table className="orders-page-table"><thead><tr><th>Status</th><th>Side</th><th>Pair</th><th>Order value</th><th>Size</th><th>Filled</th><th>Submitted</th><th/></tr></thead><tbody>{visible.length > 0 ? visible.map((row) => <tr key={row.ordRef}><td><span className={`status-chip ${statusTone(row.status)}`}><i/>{statusLabel(row.status)}</span></td><td><span className={row.side === "Buy" ? "positive" : "negative"}>{row.side}</span></td><td><strong>{row.pair}</strong></td><td>{row.fundingAmount ? `${row.fundingAmount} ${row.fundingAsset ?? ""}` : "-"}</td><td>{row.amount}</td><td>{row.filledAmount ?? "0"}</td><td className="muted">{submittedAt(row.submittedAt)}</td><td><button className="cancel-row" type="button" onClick={() => onCancel(row)}>Cancel</button></td></tr>) : <tr><td colSpan={8}><div className="table-empty">{walletReady ? openOrders.length === 0 ? "No open orders." : "No open orders match this filter." : "Connect wallet to view your orders."}</div></td></tr>}</tbody></table>
          )}

          {activeTab === "Fills" && (
            <table className="orders-page-table"><thead><tr><th>Side</th><th>Pair</th><th>Size</th><th>Fill price</th><th>Fee</th><th>Route</th><th>Time</th></tr></thead><tbody>{visible.length > 0 ? visible.map((row) => <tr key={row.ordRef}><td><span className={row.side === "Buy" ? "positive" : "negative"}>{row.side}</span></td><td><strong>{row.pair}</strong></td><td>{row.filledAmount ?? row.amount}</td><td><strong>{row.clearingPrice ?? "-"}</strong></td><td>-</td><td><span className={`route-chip ${row.externalMatch ? "" : "private"}`}>{row.externalMatch ? "Midpoint matcher" : "Private cross"}</span></td><td className="muted">{submittedAt(row.submittedAt)}</td></tr>) : <tr><td colSpan={7}><div className="table-empty">{walletReady ? "No fills match this filter." : "Connect wallet to view your fills."}</div></td></tr>}</tbody></table>
          )}

          {activeTab === "History" && (
            <table className="orders-page-table"><thead><tr><th>Status</th><th>Side</th><th>Pair</th><th>Order value</th><th>Size</th><th>Filled</th><th>Average fill</th><th>Time</th></tr></thead><tbody>{visible.length > 0 ? visible.map((row) => <tr key={row.ordRef}><td><span className={`status-chip ${statusTone(row.status)}`}><i/>{statusLabel(row.status)}</span></td><td><span className={row.side === "Buy" ? "positive" : "negative"}>{row.side}</span></td><td><strong>{row.pair}</strong></td><td>{row.fundingAmount ? `${row.fundingAmount} ${row.fundingAsset ?? ""}` : "-"}</td><td>{row.amount}</td><td>{row.filledAmount ?? "0"}</td><td>{row.clearingPrice ?? "-"}</td><td className="muted">{submittedAt(row.submittedAt)}</td></tr>) : <tr><td colSpan={8}><div className="table-empty">{walletReady ? "No order history matches this filter." : "Connect wallet to view your order history."}</div></td></tr>}</tbody></table>
          )}
        </div>
        <div className="orders-help-row"><span>Fill price is the actual execution price for that fill. Zylith does not show a duplicate “BBO midpoint vs. executed” comparison when the order crosses at midpoint.</span></div>
      </section>
    </main>
  );
}
