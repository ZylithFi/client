import { Fragment, useState } from "react";
import {
  type LocalOrder,
  type LocalOrderStatus,
  type PrivateStrategyChildSummary,
  type PrivateStrategySummary,
  sameFelt,
  statusLabel,
  statusTone,
} from "../domain/orderLifecycle";
import type { BatchSummary, PublicSettlementTranscript } from "../domain/auctionEpoch";
import type { WithdrawableNote } from "../domain/shieldedBalances";

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

type ChildLifecycle = {
  label: string;
  tone: string;
  outputRef?: string;
  detail: string;
};

function childLifecycle({
  child,
  strategy,
  batchStatus,
  settlementTranscripts,
  withdrawableNotes,
  latestEpoch,
}: {
  child: PrivateStrategyChildSummary;
  strategy: PrivateStrategySummary;
  batchStatus?: BatchSummary["status"];
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  withdrawableNotes: WithdrawableNote[];
  latestEpoch: number;
}): ChildLifecycle {
  const matchedOutput = child.expected_output_metadata_commitment
    ? withdrawableNotes.find(note =>
        note.source === "settlement_output" &&
        note.batch_id === child.batch_id &&
        sameFelt(note.metadata_commitment, child.expected_output_metadata_commitment),
      )
    : null;

  if (matchedOutput) {
    return { label: "Filled", tone: "good", outputRef: fmtAddr(matchedOutput.note_commitment), detail: "Output recognized" };
  }
  if (strategy.status === "cancelled") return { label: "Cancelled", tone: "danger", detail: "Parent cancelled" };
  if (settlementTranscripts[child.batch_id] && batchStatus === "Settled") {
    return { label: "No fill", tone: "warn", detail: "Batch settled without output" };
  }
  if (
    (batchStatus === "Closed" || batchStatus === "Proving" || batchStatus === "Clearing" || batchStatus === "Settling") &&
    latestEpoch > 0 &&
    latestEpoch - child.epoch_id >= 10
  ) {
    return { label: "Settlement blocked", tone: "danger", detail: "Proof or settlement did not finalize" };
  }
  if (batchStatus === "Settling") return { label: "Settling", tone: "info", detail: "Proof accepted; settlement pending" };
  if (batchStatus === "Closed") return { label: "Awaiting settlement", tone: "info", detail: "Batch closed" };
  if (batchStatus === "Proving" || batchStatus === "Clearing") {
    return { label: "Proving", tone: "info", detail: "Witness/proof in progress" };
  }
  if (batchStatus === "Open") {
    return { label: child.delegated ? "Delegated" : "In batch", tone: "info", detail: "Current epoch" };
  }
  return {
    label: child.delegated ? "Delegated" : "Submitted",
    tone: child.delegated ? "muted" : "info",
    detail: child.delegated ? "Offline renewal slot" : "Waiting for batch",
  };
}

export function OrdersScreen({
  orders,
  strategies,
  batches,
  settlementTranscripts,
  withdrawableNotes,
  onCancel,
  walletReady,
}: {
  orders: LocalOrder[];
  strategies: PrivateStrategySummary[];
  batches: BatchSummary[];
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  withdrawableNotes: WithdrawableNote[];
  onCancel: (o: LocalOrder) => void;
  walletReady: boolean;
}) {
  const [filter, setFilter] = useState<"active" | "history">("active");

  const activeStatuses: LocalOrderStatus[] = ["queued", "in_batch", "proving", "settling"];
  const historyStatuses: LocalOrderStatus[] = ["filled", "partial", "no_fill", "rolled", "cancelled", "failed", "settlement_blocked"];
  const displayed = filter === "active"
    ? orders.filter(o => activeStatuses.includes(o.status))
    : orders.filter(o => historyStatuses.includes(o.status));
  const strategyById = new Map(strategies.map(strategy => [strategy.id, strategy]));
  const batchStatusById = new Map(batches.map(batch => [batch.batch_id, batch.status]));
  const latestEpoch = batches.reduce((max, batch) => Math.max(max, batch.epoch_id ?? 0), 0);

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
              Orders appear after you submit your first trade.
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
                <th>Children</th>
                <th>Status</th>
                <th>Time</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {displayed.map(order => {
                const strategy = order.strategyId ? strategyById.get(order.strategyId) : null;
                const submittedChildren = strategy?.submitted_children.length ?? 0;
                const remainingChildren = strategy
                  ? Math.max(0, strategy.max_children - strategy.next_child_index + 1)
                  : 0;

                return (
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
                      <td className="num">{strategy ? `${submittedChildren}/${strategy.max_children} · ${remainingChildren} left` : "—"}</td>
                      <td>
                        <span className={`pill ${statusTone(order.status)}`}>{statusLabel(order.status)}</span>
                      </td>
                      <td>{fmtTime(order.submittedAt)}</td>
                      <td>
                        {(["queued", "in_batch"].includes(order.status) || strategy?.status === "active") && (
                          <button
                            style={{ fontSize: 10, color: "var(--z-status-danger)", letterSpacing: "0.06em" }}
                            onClick={() => onCancel(order)}
                          >Cancel</button>
                        )}
                      </td>
                    </tr>
                    {strategy && strategy.submitted_children.length > 0 && (
                      <tr className="strategy-detail-row">
                        <td className="side-bar-cell" />
                        <td colSpan={10}>
                          <div className="strategy-child-panel" aria-label="Strategy child orders">
                            <div className="strategy-child-panel-hd">
                              <span>Child execution</span>
                              <em>{submittedChildren}/{strategy.max_children} submitted · {remainingChildren} left</em>
                            </div>
                            {strategy.submitted_children.map(child => {
                              const lifecycle = childLifecycle({
                                child,
                                strategy,
                                batchStatus: batchStatusById.get(child.batch_id),
                                settlementTranscripts,
                                withdrawableNotes,
                                latestEpoch,
                              });
                              return (
                                <div key={`${order.ordRef}:${child.parent_child_index}`} className="strategy-child-timeline-row">
                                  <div className="strategy-child-step">
                                    <span>{String(child.parent_child_index).padStart(2, "0")}</span>
                                  </div>
                                  <div className="strategy-child-main">
                                    <div className="strategy-child-primary">
                                      <span className={`pill ${lifecycle.tone}`}>{lifecycle.label}</span>
                                      <span>Epoch {child.epoch_id}</span>
                                      <span>{fmtTime(child.submitted_at_unix_ms)}</span>
                                      <em>{lifecycle.detail}</em>
                                    </div>
                                    <div className="strategy-child-secondary">
                                      <span>Batch {fmtAddr(child.batch_id)}</span>
                                      <span>Order {fmtAddr(child.order_commitment || "—")}</span>
                                      <span>Output {lifecycle.outputRef ?? "—"}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                        <td />
                      </tr>
                    )}
                    {(strategy?.parent_cancel_transaction_hash || order.cancelTransactionHash) && (
                      <tr key={`${order.ordRef}:cancel-anchor`} className="child-row">
                        <td className="side-bar-cell" />
                        <td className="ref">Cancel</td>
                        <td colSpan={9}>
                          Parent cancel anchored · {fmtAddr(strategy?.parent_cancel_transaction_hash ?? order.cancelTransactionHash ?? "")}
                        </td>
                        <td />
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
