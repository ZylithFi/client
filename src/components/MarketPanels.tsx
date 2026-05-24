import { formatClearingPrice, headroomBpsValue } from "../domain/assets";
import type { BatchSummary, LastClearingPrice } from "../domain/auctionEpoch";
import type { LocalOrder } from "../domain/orderLifecycle";
import type { PairConfig } from "./OrderTicket";

export function PairList({
  pairs,
  activePairId,
  onSelect,
  batchByPair,
  lastClearingPrices,
}: {
  pairs: PairConfig[];
  activePairId: string;
  onSelect: (id: string) => void;
  batchByPair: Record<string, BatchSummary>;
  lastClearingPrices: Record<string, LastClearingPrice>;
}) {
  return (
    <div className="pair-list-col">
      <div className="pair-list-hd">PAIRS</div>
      <div className="pair-list-body">
        {pairs.length === 0 && (
          <div style={{ padding: "20px 16px", fontSize: 11, color: "var(--z-text-body)", letterSpacing: "0.08em" }}>
            —
          </div>
        )}
        {pairs.map(pair => {
          const batch = batchByPair[pair.pair_id];
          const lastClearing = lastClearingPrices[pair.pair_id] ?? null;
          return (
            <button
              type="button"
              key={pair.pair_id}
              className={`pair-row ${activePairId === pair.pair_id ? "is-active" : ""}`}
              onClick={() => onSelect(pair.pair_id)}
            >
              <div>
                <div className="pair-name">{pair.pair_id}</div>
                <div className="pair-sub">{batch ? `Epoch ${batch.epoch_id} · ${batch.status}` : "Waiting for epoch"}</div>
              </div>
              <div className="pair-meta">
                <div className="pair-price">{lastClearing ? formatClearingPrice(lastClearing, pair) : "—"}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PairHeader({
  pair,
  lastClearing,
}: {
  pair: PairConfig | null;
  lastClearing: LastClearingPrice | null;
}) {
  if (!pair) return <div className="tc-section" />;
  return (
    <div className="tc-section">
      <div className="pair-hd">
        <div>
          <div className="pair-hd-name">{pair.pair_id}</div>
        </div>
        <div>
          <div className="pair-hd-price">
            {lastClearing ? formatClearingPrice(lastClearing, pair) : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReportsStrip({
  orders,
  onOpenReports,
}: {
  orders: LocalOrder[];
  onOpenReports: () => void;
}) {
  const filled = orders.filter(order => order.status === "filled" || order.status === "partial");
  const headroomValues = filled
    .map(order => headroomBpsValue(order.side, order.limitPrice, order.clearingPrice ?? ""))
    .filter((value): value is number => value !== null);

  if (filled.length === 0) {
    return (
      <div className="tc-section reports-strip">
        <div className="reports-strip-title">Recent activity</div>
        <div className="reports-strip-row">
          <span style={{ fontSize: 11, color: "var(--z-text-body)" }}>No fills yet</span>
          <button className="reports-strip-link" onClick={onOpenReports}>View TCA →</button>
        </div>
      </div>
    );
  }

  const fillRate = orders.length > 0
    ? ((filled.length / orders.length) * 100).toFixed(1) + "%"
    : "—";
  const avgHeadroom = headroomValues.length > 0
    ? formatBps(headroomValues.reduce((sum, value) => sum + value, 0) / headroomValues.length)
    : "—";

  return (
    <div className="tc-section reports-strip">
      <div className="reports-strip-title">Recent activity</div>
      <div className="reports-strip-row">
        <div className="reports-strip-cell">
          <span className="reports-strip-lbl">Fills</span>
          <span className="reports-strip-val z-amt">{filled.length}</span>
        </div>
        <div className="reports-strip-cell">
          <span className="reports-strip-lbl">Fill rate</span>
          <span className="reports-strip-val z-amt">{fillRate}</span>
        </div>
        <div className="reports-strip-cell">
          <span className="reports-strip-lbl">Avg headroom</span>
          <span className="reports-strip-val z-amt">{avgHeadroom}</span>
        </div>
        <button className="reports-strip-link" onClick={onOpenReports}>View TCA →</button>
      </div>
    </div>
  );
}

function formatBps(value: number): string {
  const formatted = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${formatted} bps`;
}
