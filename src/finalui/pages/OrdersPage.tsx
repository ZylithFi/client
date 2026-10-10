import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { type OrderRow, hasPositiveAmount, isOpenOrder, orderStatusLabel, orderStatusTone } from "../../domain/orders";
import { SlidersIcon } from "../components/Icons";
import { FilterDropdown } from "../components/FilterDropdown";
import { FilledProgress, type OrderSortDirection, type OrderSortKey, SortableTableHeader, sortOrderRows } from "../components/OrderTableCells";
import { FailureNotice } from "../../components/FailureNotice";
import type { NormalizedFailure } from "../../domain/userFacingErrors";

type Tab = "Open" | "Fills" | "History";
type SideFilter = "All" | "Buy" | "Sell";
const tabs: Tab[] = ["Open", "Fills", "History"];
function submittedAt(value: number) {
  return Number.isSafeInteger(value) && value > 0
    ? new Date(value).toLocaleString()
    : "Unavailable";
}

export function OrdersPage({
  orders,
  walletConnected,
  walletReady,
  error,
  onCancel,
  onConnectWallet,
  onRefreshStatus,
  onSwitchNetwork,
  onContactSupport,
  onDismissError,
}: {
  orders: OrderRow[];
  walletConnected: boolean;
  walletReady: boolean;
  error?: NormalizedFailure | null;
  onCancel: (order: OrderRow) => Promise<void>;
  onConnectWallet: () => void;
  onRefreshStatus?: () => void | Promise<void>;
  onSwitchNetwork?: () => void | Promise<void>;
  onContactSupport?: () => void | Promise<void>;
  onDismissError?: () => void | Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("Open");
  const [sideFilter, setSideFilter] = useState<SideFilter>("All");
  const [sortKey, setSortKey] = useState<OrderSortKey | null>("time");
  const [sortDirection, setSortDirection] = useState<OrderSortDirection>("descending");
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());
  const cancellingRef = useRef(new Set<string>());
  const [cancellingAll, setCancellingAll] = useState(false);
  const cancellingAllRef = useRef(false);
  const openOrders = useMemo(() => orders.filter(isOpenOrder), [orders]);
  const fills = useMemo(
    () => orders.filter((row) => hasPositiveAmount(row.filled)),
    [orders],
  );
  const history = useMemo(() => orders.filter((row) => !isOpenOrder(row)), [orders]);
  const source = activeTab === "Open" ? openOrders : activeTab === "Fills" ? fills : history;
  const visible = useMemo(() => {
    const filtered = source.filter((row) => sideFilter === "All" || row.side === sideFilter);
    return sortOrderRows(filtered, sortKey, sortDirection);
  }, [sideFilter, sortDirection, sortKey, source]);

  function handleSort(nextKey: OrderSortKey) {
    if (nextKey === sortKey) {
      if (sortDirection === "descending") {
        setSortDirection("ascending");
      } else {
        setSortKey(null);
        setSortDirection("descending");
      }
      return;
    }
    setSortKey(nextKey);
    setSortDirection("descending");
  }

  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    setSortKey("time");
    setSortDirection("descending");
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tab: Tab) {
    const index = tabs.indexOf(tab);
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + direction + tabs.length) % tabs.length;
    handleTabChange(tabs[nextIndex]);
    document.getElementById(`orders-tab-${tabs[nextIndex].toLowerCase()}`)?.focus();
  }

  async function cancel(row: OrderRow) {
    if (cancellingRef.current.has(row.id)) return;
    cancellingRef.current.add(row.id);
    setCancellingIds(new Set(cancellingRef.current));
    try {
      await onCancel(row);
    } finally {
      cancellingRef.current.delete(row.id);
      setCancellingIds(new Set(cancellingRef.current));
    }
  }

  async function cancelAll() {
    if (cancellingAllRef.current) return;
    cancellingAllRef.current = true;
    setCancellingAll(true);
    try {
      for (const order of openOrders) await cancel(order);
    } finally {
      cancellingAllRef.current = false;
      setCancellingAll(false);
    }
  }

  const sortableHeaderProps = { activeKey: sortKey, direction: sortDirection, onSort: handleSort };

  if (!walletReady) {
    const action = walletConnected ? "Unlock private orders" : "Connect wallet";
    return (
      <main className="page-content orders-page">
        <section className="page-hero compact-hero">
          <div><h1>Orders</h1><p>Your open, filled, and past orders.</p></div>
        </section>
        <section className="orders-workspace" aria-label="Order activity">
          <div className="orders-page-toolbar">
            <div className="page-tabs" role="tablist" aria-label="Order lifecycle">{tabs.map((tab) => <button key={tab} type="button" role="tab" aria-selected={tab === "Open"} className={tab === "Open" ? "active" : ""} disabled>{tab}</button>)}</div>
          </div>
          <div className="account-empty-state orders-empty-state"><strong>{walletConnected ? "Unlock your private orders to continue." : "Connect wallet to view your orders."}</strong><button className="wallet-button" type="button" onClick={onConnectWallet}>{action}</button></div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-content orders-page">
      <section className="page-hero compact-hero">
        <div><h1>Orders</h1><p>Your open, filled, and past orders.</p></div>
      </section>

      <section className="orders-workspace" aria-label="Order activity">
        {error && (
          <FailureNotice
            failure={error}
            className="slide-inline-notice"
            actions={{
              reconnect: onConnectWallet,
              switchNetwork: onSwitchNetwork,
              refreshState: onRefreshStatus,
              checkStatus: onRefreshStatus,
              contactSupport: onContactSupport,
              dismiss: error.presentation === "toast" ? onDismissError : undefined,
            }}
          />
        )}
        <div className="orders-page-toolbar">
          <div className="page-tabs" role="tablist" aria-label="Order lifecycle">
            {tabs.map((tab) => {
              const count = tab === "Open" ? openOrders.length : tab === "Fills" ? fills.length : history.length;
              return <button key={tab} id={`orders-tab-${tab.toLowerCase()}`} type="button" role="tab" aria-controls={`orders-panel-${tab.toLowerCase()}`} aria-selected={activeTab === tab} tabIndex={activeTab === tab ? 0 : -1} className={activeTab === tab ? "active" : ""} onKeyDown={(event) => handleTabKeyDown(event, tab)} onClick={() => handleTabChange(tab)}>{tab}<span>{count}</span></button>;
            })}
          </div>
          <div className="orders-page-actions"><FilterDropdown label="Side" value={sideFilter} options={["All", "Buy", "Sell"]} onChange={(value) => setSideFilter(value as SideFilter)} triggerLabel="Filters" icon={<SlidersIcon className="icon-15" />} />{activeTab === "Open" && openOrders.length > 0 && <button type="button" className="danger-outline" disabled={cancellingAll} onClick={() => void cancelAll()}>{cancellingAll ? "Cancelling orders…" : "Cancel all open orders"}</button>}</div>
        </div>

        <div id={`orders-panel-${activeTab.toLowerCase()}`} className="table-scroll orders-page-table-wrap" role="tabpanel" aria-labelledby={`orders-tab-${activeTab.toLowerCase()}`}>
          {activeTab === "Open" && (
            <table className="orders-page-table open-orders-table"><thead><tr><th>Status</th><th>Side</th><th>Pair</th><SortableTableHeader className="numeric-cell" label="Order value" sortKey="orderValue" {...sortableHeaderProps}/><th className="numeric-cell">Size</th><th className="filled-cell"><span>Filled</span></th><SortableTableHeader className="time-cell" label="Time" sortKey="time" {...sortableHeaderProps}/><th/></tr></thead><tbody>{visible.length > 0 ? visible.map((row) => { const cancelling = cancellingIds.has(row.id); return <tr key={row.id}><td><span className={`status-chip ${orderStatusTone(row.state)}`}><i/>{cancelling ? "Cancelling" : orderStatusLabel(row)}</span></td><td><span className={row.side === "Buy" ? "positive" : "negative"}>{row.side}</span></td><td><strong>{row.pair}</strong></td><td className="numeric-cell">{row.orderValue}</td><td className="numeric-cell">{row.amount}</td><td className="filled-cell"><FilledProgress filled={row.filled} total={row.amount}/></td><td className="muted time-cell">{submittedAt(row.submittedAt)}</td><td><div className="row-actions">{row.state !== "cancelling" && row.state !== "submitting" && <button className="cancel-row" type="button" disabled={cancelling} onClick={() => void cancel(row)}>{cancelling ? "Cancelling…" : "Cancel"}</button>}</div></td></tr>; }) : <tr><td colSpan={8}><div className="table-empty">{walletReady ? openOrders.length === 0 ? "No open orders." : "No open orders match this filter." : "Connect wallet to view your orders."}</div></td></tr>}</tbody></table>
          )}

          {activeTab === "Fills" && (
            <table className="orders-page-table fills-table"><thead><tr><th>Side</th><th>Pair</th><th className="filled-cell"><span>Filled</span></th><th className="numeric-cell">Average price</th><th className="numeric-cell">Fee</th><th>Route</th><SortableTableHeader className="time-cell" label="Time" sortKey="time" {...sortableHeaderProps}/></tr></thead><tbody>{visible.length > 0 ? visible.map((row) => <tr key={row.id}><td><span className={row.side === "Buy" ? "positive" : "negative"}>{row.side}</span></td><td><strong>{row.pair}</strong></td><td className="filled-cell"><FilledProgress filled={row.filled} total={row.amount}/></td><td className="numeric-cell"><strong>{row.averagePrice}</strong></td><td className="numeric-cell">{row.fees}</td><td><span className={`route-chip ${row.external ? "" : "private"}`}>{row.external ? "Private + matcher" : "Private only"}</span></td><td className="muted time-cell">{submittedAt(row.submittedAt)}</td></tr>) : <tr><td colSpan={7}><div className="table-empty">{walletReady ? "No fills match this filter." : "Connect wallet to view your fills."}</div></td></tr>}</tbody></table>
          )}

          {activeTab === "History" && (
            <table className="orders-page-table order-history-table"><thead><tr><th>Status</th><th>Side</th><th>Pair</th><SortableTableHeader className="numeric-cell" label="Order value" sortKey="orderValue" {...sortableHeaderProps}/><th className="numeric-cell">Size</th><th className="filled-cell"><span>Filled</span></th><SortableTableHeader className="time-cell" label="Time" sortKey="time" {...sortableHeaderProps}/></tr></thead><tbody>{visible.length > 0 ? visible.map((row) => <tr key={row.id}><td><span className={`status-chip ${orderStatusTone(row.state)}`} title={row.error}><i/>{orderStatusLabel(row)}</span></td><td><span className={row.side === "Buy" ? "positive" : "negative"}>{row.side}</span></td><td><strong>{row.pair}</strong></td><td className="numeric-cell">{row.orderValue}</td><td className="numeric-cell">{row.amount}</td><td className="filled-cell"><FilledProgress filled={row.filled} total={row.amount}/></td><td className="muted time-cell">{submittedAt(row.submittedAt)}</td></tr>) : <tr><td colSpan={7}><div className="table-empty">{walletReady ? "No order history matches this filter." : "Connect wallet to view your order history."}</div></td></tr>}</tbody></table>
          )}
        </div>
      </section>

    </main>
  );
}
