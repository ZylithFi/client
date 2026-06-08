import { Fragment, useState } from "react";
import {
  type LocalOrder,
  type LocalOrderStatus,
  statusLabel,
  statusTone,
} from "../domain/orderLifecycle";

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtAddr(s: string): string {
  if (!s || s.length < 10) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function OrdersScreen({
  orders,
  onCancel,
  walletReady,
}: {
  orders: LocalOrder[];
  onCancel: (o: LocalOrder) => void;
  walletReady: boolean;
}) {
  const [filter, setFilter] = useState<"active" | "history">("active");

  const activeStatuses: LocalOrderStatus[] = ["queued", "in_batch", "proving", "settling", "settled_pending_output"];
  const historyStatuses: LocalOrderStatus[] = ["filled", "partial", "no_fill", "rolled", "cancelled", "failed", "proof_failed", "stalled"];
  const displayed = filter === "active"
    ? orders.filter(o => activeStatuses.includes(o.status))
    : orders.filter(o => historyStatuses.includes(o.status));

  return (
    <div className="workspace-page">
      <div className="page-hd">
        <div className="page-title-block">
          <span className="page-title">ORDERS</span>
        </div>
      </div>

      {walletReady && (
        <div className="filters">
          <div className="filter-group">
            <div className="filter-chips">
              <button
                className={`filter-chip ${filter === "active" ? "on" : ""}`}
                onClick={() => setFilter("active")}
              >Active</button>
              <button
                className={`filter-chip ${filter === "history" ? "on" : ""}`}
                onClick={() => setFilter("history")}
              >History</button>
            </div>
          </div>
        </div>
      )}

      <div className="table-zone">
        {!walletReady ? (
          <div className="empty-zone">
            <div className="empty-mark">—</div>
            <div className="empty-body">Sign in to view your orders.</div>
          </div>
        ) : displayed.length === 0 ? (
          <div className="empty-zone">
            <div className="empty-mark">—</div>
            <div className="empty-body">
              Orders appear after you submit a trade.
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 2 }} />
                <th>Ref</th>
                <th>Pair</th>
                <th>Side</th>
                <th>Mode</th>
                <th>Amount</th>
                <th>Limit</th>
                <th>Clearing</th>
                <th>Status</th>
                <th>Time</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {displayed.map(order => (
                <Fragment key={order.ordRef}>
                  <tr>
                    <td className="side-bar-cell">
                      <span style={{ background: order.side === "Buy" ? "var(--z-buy)" : "var(--z-sell)" }} />
                    </td>
                    <td className="ref">{order.ordRef}</td>
                    <td>{order.pair}</td>
                    <td>
                      <span className={`side ${order.side === "Buy" ? "buy" : "sell"}`}>
                        {order.side}
                      </span>
                    </td>
                    <td>{order.wireMode}</td>
                    <td className="num">{order.amount}</td>
                    <td className="num">{order.limitPrice || "—"}</td>
                    <td className="num">{order.clearingPrice || "—"}</td>
                    <td>
                      <span className={`pill ${statusTone(order.status)}`}>{statusLabel(order.status)}</span>
                    </td>
                    <td>{fmtTime(order.submittedAt)}</td>
                    <td>
                      {["queued", "in_batch"].includes(order.status) && (
                        <button
                          style={{ fontSize: 10, color: "var(--z-status-danger)", letterSpacing: "0.06em" }}
                          onClick={() => onCancel(order)}
                        >Cancel</button>
                      )}
                    </td>
                  </tr>
                  {order.cancelTransactionHash && (
                    <tr key={`${order.ordRef}:cancel-anchor`} className="child-row">
                      <td className="side-bar-cell" />
                      <td className="ref">Cancel</td>
                      <td colSpan={8}>
                        Cancel anchored · {fmtAddr(order.cancelTransactionHash)}
                      </td>
                      <td />
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
