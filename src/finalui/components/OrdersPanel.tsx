import { useMemo, useState } from "react";
import { type OrderRow, isOpenOrder, orderStatusLabel } from "../../domain/orders";
import { FilledProgress, type OrderSortDirection, type OrderSortKey, SortableTableHeader, sortOrderRows } from "./OrderTableCells";

function submittedAt(value: number) {
  return new Date(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function OrdersPanel({ orders, onViewAll }: { orders: OrderRow[]; onViewAll: () => void }) {
  const [sortKey, setSortKey] = useState<OrderSortKey | null>("time");
  const [sortDirection, setSortDirection] = useState<OrderSortDirection>("descending");
  const openOrders = useMemo(() => sortOrderRows(orders.filter(isOpenOrder), sortKey, sortDirection), [orders, sortDirection, sortKey]);

  function handleSort(nextKey: OrderSortKey) {
    if (nextKey !== sortKey) {
      setSortKey(nextKey);
      setSortDirection("descending");
    } else if (sortDirection === "descending") {
      setSortDirection("ascending");
    } else {
      setSortKey(null);
      setSortDirection("descending");
    }
  }

  const sortableHeaderProps = { activeKey: sortKey, direction: sortDirection, onSort: handleSort };

  return (
    <section className="orders-panel trade-orders-panel" aria-label="Open orders">
      <div className="orders-toolbar">
        <div className="orders-tray-title"><strong>Open orders</strong><span>{openOrders.length}</span></div>
        <button className="text-link" type="button" onClick={onViewAll}>View all orders <span aria-hidden="true">↗</span></button>
      </div>
      <div className="table-scroll">
        {openOrders.length === 0 ? (
          <div className="table-empty">No open orders.</div>
        ) : (
          <table className="trade-order-table">
            <thead><tr><th>Pair</th><th>Side</th><SortableTableHeader className="numeric-cell" label="Order value" sortKey="orderValue" {...sortableHeaderProps}/><th className="numeric-cell">Size</th><th className="filled-cell"><span>Filled</span></th><th>Status</th><SortableTableHeader className="time-cell" label="Time" sortKey="time" {...sortableHeaderProps}/></tr></thead>
            <tbody>{openOrders.map((row) => <tr key={row.id}><td><strong>{row.pair}</strong></td><td><span className={row.side === "Buy" ? "positive" : "negative"}>{row.side}</span></td><td className="numeric-cell">{row.orderValue}</td><td className="numeric-cell">{row.amount}</td><td className="filled-cell"><FilledProgress filled={row.filled} total={row.amount}/></td><td><span className="status-chip blue"><i/>{orderStatusLabel(row)}</span></td><td className="muted time-cell">{submittedAt(row.submittedAt)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}
