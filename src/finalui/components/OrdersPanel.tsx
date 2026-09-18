import type { LocalOrder } from "../../domain/orderLifecycle";

const activeStatuses = new Set(["queued", "in_batch", "proving", "settling", "settled_pending_output", "partial"]);

function statusLabel(status: LocalOrder["status"]) {
  if (status === "partial") return "Partially filled";
  if (status === "queued") return "Queued";
  if (status === "in_batch") return "Crossing";
  if (status === "proving") return "Proving";
  if (status === "settling" || status === "settled_pending_output") return "Settling";
  return status.replaceAll("_", " ");
}

function submittedAt(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function OrdersPanel({
  orders,
  onViewAll,
}: {
  orders: LocalOrder[];
  onViewAll: () => void;
}) {
  const openOrders = orders.filter((order) => activeStatuses.has(order.status));

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
            <thead><tr><th>Pair</th><th>Side</th><th>Order value</th><th>Size</th><th>Filled</th><th>Status</th><th>Submitted</th></tr></thead>
            <tbody>{openOrders.map((row) => <tr key={row.ordRef}><td><strong>{row.pair}</strong></td><td><span className={row.side === "Buy" ? "positive" : "negative"}>{row.side}</span></td><td>{row.fundingAmount ? `${row.fundingAmount} ${row.fundingAsset ?? ""}` : "-"}</td><td>{row.amount}</td><td>{row.filledAmount ?? "0"}</td><td><span className="status-chip blue"><i/>{statusLabel(row.status)}</span></td><td className="muted">{submittedAt(row.submittedAt)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}
