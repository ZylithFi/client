import { type OrderRow, isOpenOrder, orderStatusLabel } from "../../domain/orders";

function submittedAt(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function OrdersPanel({ orders, onViewAll }: { orders: OrderRow[]; onViewAll: () => void }) {
  const openOrders = orders.filter(isOpenOrder);

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
            <thead><tr><th>Pair</th><th>Side</th><th>Funding</th><th>Size</th><th>Filled</th><th>Limit</th><th>Status</th><th>Submitted</th></tr></thead>
            <tbody>{openOrders.map((row) => <tr key={row.id}><td><strong>{row.pair}</strong></td><td><span className={row.side === "Buy" ? "positive" : "negative"}>{row.side}</span></td><td>{row.funding}</td><td>{row.amount}</td><td>{row.filled}</td><td>{row.limitPrice}</td><td><span className="status-chip blue"><i/>{orderStatusLabel(row)}</span></td><td className="muted">{submittedAt(row.submittedAt)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}
