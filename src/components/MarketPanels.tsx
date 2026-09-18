import { formatClearingPrice } from "../domain/assets";
import type { BatchSummary, LastClearingPrice } from "../domain/auctionEpoch";
import type { PairConfig, ReferencePriceSnapshot } from "./OrderTicket";

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
            -
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
                <div className="pair-price">{lastClearing ? formatClearingPrice(lastClearing, pair) : "-"}</div>
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
  referencePrice,
  lastClearing,
}: {
  pair: PairConfig | null;
  referencePrice: ReferencePriceSnapshot | null;
  lastClearing: LastClearingPrice | null;
}) {
  if (!pair) return <div className="tc-section" />;
  const historyPoints = midpointSparklinePoints(referencePrice, lastClearing, pair);
  return (
    <div className="tc-section">
      <div className="pair-hd">
        <div>
          <div className="pair-hd-name">{pair.pair_id}</div>
          <div className="pair-hd-source">
            Binance midpoint · CEX confirmed
            {referencePrice?.observedAtUnixMs
              ? ` · ${formatFreshness(referencePrice.observedAtUnixMs)}`
              : ""}
          </div>
        </div>
        <div className="pair-hd-market">
          <div className="pair-hd-price">
            {referencePrice?.displayPrice ?? "-"}
          </div>
          <svg className="pair-hd-chart" viewBox="0 0 120 32" aria-hidden="true">
            <polyline points={historyPoints} />
          </svg>
          <div className="pair-hd-secondary">
            Last private clearing {lastClearing ? formatClearingPrice(lastClearing, pair) : "-"}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatFreshness(observedAtUnixMs: number): string {
  const ageSeconds = Math.max(0, Math.round((Date.now() - observedAtUnixMs) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  return `${Math.floor(ageSeconds / 60)}m ago`;
}

function midpointSparklinePoints(
  referencePrice: ReferencePriceSnapshot | null,
  lastClearing: LastClearingPrice | null,
  pair: PairConfig,
): string {
  const values = [
    Number(lastClearing ? formatClearingPrice(lastClearing, pair) : NaN),
    Number(referencePrice?.displayPrice ?? NaN),
  ].filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return "0,24 120,24";
  if (values.length === 1) return "0,18 120,18";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || max || 1;
  return values
    .map((value, index) => {
      const x = index === 0 ? 0 : 120;
      const y = 26 - ((value - min) / span) * 20;
      return `${x},${Number.isFinite(y) ? y.toFixed(2) : "18"}`;
    })
    .join(" ");
}
