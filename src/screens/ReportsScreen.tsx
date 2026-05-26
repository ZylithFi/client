import { useState } from "react";
import {
  formatHeadroomBps,
  fromAtomicStr,
  headroomBpsValue,
} from "../domain/assets";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";

type Period = "all" | "7d" | "30d";

type MakerBandRow = {
  key: string;
  pair: string;
  side: LocalOrder["side"];
  band: string;
  submittedOrders: number;
  filledOrders: number;
  depth: number;
  filledDepth: number;
  epochs: Map<number, { depth: number; filledDepth: number }>;
  renewalSubmitted: number;
  renewalFilled: number;
  headroom: number[];
  inventoryDelta: number;
  clearingPrices: string[];
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function csvCell(value: string | number | undefined): string {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function parseHuman(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatHuman(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: value >= 100 ? 2 : 6,
  });
}

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatSignedNumber(value: number, suffix = ""): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const formatted = abs >= 100
    ? abs.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : abs.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}${suffix}`;
}

function formatPricePath(values: string[]): string {
  if (values.length === 0) return "—";
  const recent = values.slice(-4);
  return recent.join(" · ");
}

function formatStrategyLimitPrice(strategy: PrivateStrategySummary): string {
  if (!strategy.limit_price) return "—";
  const quote = strategy.pair.split("/")[1];
  if (!quote) return strategy.limit_price;
  return fromAtomicStr(strategy.limit_price, quote);
}

function allocateMakerFill(order: LocalOrder, points: Array<{ price: string; baseAmount: string }>): number[] {
  const allocation = points.map(() => 0);
  let remaining = parseHuman(order.filledAmount);
  if (remaining <= 0) return allocation;

  const clearing = parseHuman(order.clearingPrice);
  const ranked = points
    .map((point, index) => ({
      index,
      price: parseHuman(point.price),
      depth: parseHuman(point.baseAmount),
    }))
    .filter(point => point.depth > 0)
    .filter(point => {
      if (clearing <= 0 || point.price <= 0) return true;
      return order.side === "Sell" ? point.price <= clearing : point.price >= clearing;
    })
    .sort((a, b) => {
      if (order.side === "Sell") return a.price - b.price;
      return b.price - a.price;
    });

  for (const point of ranked) {
    if (remaining <= 0) break;
    const fill = Math.min(point.depth, remaining);
    allocation[point.index] = fill;
    remaining -= fill;
  }
  return allocation;
}

function fromAtomicOrRaw(value: string, asset?: string): string {
  if (!asset) return value;
  try {
    return fromAtomicStr(value, asset);
  } catch {
    return value;
  }
}

function fallbackMakerPoints(order: LocalOrder): Array<{ price: string; baseAmount: string; bandIndex?: number }> {
  if (order.makerCurvePoints && order.makerCurvePoints.length > 0) return order.makerCurvePoints;
  return [{
    price: order.limitPrice || order.clearingPrice || "Curve",
    baseAmount: order.amount,
  }];
}

function makerPointsWithFill(
  order: LocalOrder,
): {
  points: Array<{ price: string; baseAmount: string; bandIndex?: number }>;
  fillAllocation: number[];
} {
  const attribution = order.makerBandAttribution;
  if (attribution?.bands?.length) {
    const [baseAsset, quoteAsset] = order.pair.split("/");
    const sortedBands = [...attribution.bands].sort((a, b) => a.band_index - b.band_index);
    return {
      points: sortedBands.map(band => ({
        price: fromAtomicOrRaw(band.band_price, quoteAsset),
        baseAmount: fromAtomicOrRaw(band.band_base_amount, baseAsset),
        bandIndex: band.band_index,
      })),
      fillAllocation: sortedBands.map(band => parseHuman(fromAtomicOrRaw(band.filled_base_amount, baseAsset))),
    };
  }
  const points = fallbackMakerPoints(order);
  return { points, fillAllocation: allocateMakerFill(order, points) };
}

function makerBandRows(orders: LocalOrder[]): MakerBandRow[] {
  const rows = new Map<string, MakerBandRow>();
  for (const order of orders) {
    const { points, fillAllocation } = makerPointsWithFill(order);
    const orderFilled = order.status === "filled" || order.status === "partial";
    const headroom = headroomBpsValue(order.side, order.limitPrice, order.clearingPrice ?? "");

    points.forEach((point, index) => {
      const band = point.price || "Curve";
      const key = `${order.pair}:${order.side}:${point.bandIndex ?? band}`;
      const row = rows.get(key) ?? {
        key,
        pair: order.pair,
        side: order.side,
        band,
        submittedOrders: 0,
        filledOrders: 0,
        depth: 0,
        filledDepth: 0,
        epochs: new Map<number, { depth: number; filledDepth: number }>(),
        renewalSubmitted: 0,
        renewalFilled: 0,
        headroom: [],
        inventoryDelta: 0,
        clearingPrices: [],
      };
      const depth = parseHuman(point.baseAmount);
      const filledDepth = fillAllocation[index] ?? 0;
      row.submittedOrders += 1;
      row.depth += depth;
      row.filledDepth += filledDepth;
      if (filledDepth > 0) row.filledOrders += 1;
      if (order.wireMode === "Resting") {
        row.renewalSubmitted += 1;
        if (orderFilled) row.renewalFilled += 1;
      }
      if (headroom !== null && filledDepth > 0) row.headroom.push(headroom);
      if (filledDepth > 0) {
        if (order.clearingPrice) row.clearingPrices.push(order.clearingPrice);
        row.inventoryDelta += order.side === "Buy" ? filledDepth : -filledDepth;
      }
      const epoch = row.epochs.get(order.epochId) ?? { depth: 0, filledDepth: 0 };
      epoch.depth += depth;
      epoch.filledDepth += filledDepth;
      row.epochs.set(order.epochId, epoch);
      rows.set(key, row);
    });
  }
  return Array.from(rows.values()).sort((a, b) => a.pair.localeCompare(b.pair) || a.band.localeCompare(b.band));
}

function epochUtilization(row: MakerBandRow): string {
  const epochs = Array.from(row.epochs.entries())
    .sort(([a], [b]) => b - a)
    .slice(0, 4)
    .reverse();
  if (epochs.length === 0) return "—";
  return epochs
    .map(([epoch, stats]) => {
      const pct = stats.depth > 0 ? (stats.filledDepth / stats.depth) * 100 : 0;
      return `#${epoch} ${pct.toFixed(0)}%`;
    })
    .join(" · ");
}

function weightedAverageClearing(orders: LocalOrder[]): string {
  let numerator = 0;
  let denominator = 0;
  for (const order of orders) {
    const price = parseHuman(order.clearingPrice);
    const size = parseHuman(order.filledAmount ?? order.amount);
    if (price <= 0 || size <= 0) continue;
    numerator += price * size;
    denominator += size;
  }
  if (denominator <= 0) return "—";
  return (numerator / denominator).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatNextChild(
  strategy: PrivateStrategySummary,
  activeEpochId: number | null,
  batchWindowMs: number | null,
): string {
  if (strategy.status === "completed" || strategy.status === "cancelled" || strategy.next_child_index > strategy.max_children) {
    return "—";
  }
  const nextEpoch = strategy.start_epoch + strategy.next_child_index - 1;
  if (activeEpochId === null || !batchWindowMs) return `Epoch ${nextEpoch}`;
  const epochsAway = Math.max(0, nextEpoch - activeEpochId);
  const minutesAway = Math.round((epochsAway * batchWindowMs) / 60_000);
  return minutesAway > 0 ? `Epoch ${nextEpoch} · ~${minutesAway}m` : `Epoch ${nextEpoch} · next`;
}

export function ReportsScreen({
  orders,
  strategies,
  walletReady,
  activeEpochId,
  batchWindowMs,
}: {
  orders: LocalOrder[];
  strategies: PrivateStrategySummary[];
  walletReady: boolean;
  activeEpochId?: number | null;
  batchWindowMs?: number | null;
}) {
  const [period, setPeriod] = useState<Period>("all");
  const cutoff = period === "all"
    ? 0
    : Date.now() - (period === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000;
  const allFilled = orders.filter(order => order.status === "filled" || order.status === "partial");
  const periodOrders = orders.filter(order => period === "all" || order.submittedAt >= cutoff);
  const filled = periodOrders.filter(order => order.status === "filled" || order.status === "partial");
  const headroomValues = filled
    .map(order => headroomBpsValue(order.side, order.limitPrice, order.clearingPrice ?? ""))
    .filter((value): value is number => value !== null);
  const avgHeadroom = headroomValues.length > 0
    ? formatBps(mean(headroomValues))
    : "—";
  const bestFill = headroomValues.length > 0
    ? formatBps(Math.max(...headroomValues))
    : "—";
  const fillRate = periodOrders.length > 0
    ? formatPct((filled.length / periodOrders.length) * 100)
    : "—";
  const makerOrders = periodOrders.filter(order => order.wireMode === "Maker Curve" || order.wireMode === "Resting");
  const makerRows = makerBandRows(makerOrders);
  const strategyRows = strategies.map(strategy => {
    const related = periodOrders.filter(order => order.strategyId === strategy.id);
    const fills = related.filter(order => order.status === "filled" || order.status === "partial");
    const target = related.reduce((sum, order) => sum + parseHuman(order.amount), 0);
    const filledAmount = fills.reduce((sum, order) => sum + parseHuman(order.filledAmount ?? order.amount), 0);
    const submittedChildren = strategy.submitted_children.length;
    const remainingChildren = Math.max(0, strategy.max_children - strategy.next_child_index + 1);
    const expectedChildren = activeEpochId === null || activeEpochId === undefined
      ? submittedChildren
      : Math.min(
          strategy.max_children,
          Math.max(0, activeEpochId - strategy.start_epoch + 1),
        );
    const schedule = strategy.max_children > 0 ? (submittedChildren / strategy.max_children) * 100 : 0;
    const scheduleAdherence = expectedChildren > 0 ? (submittedChildren / expectedChildren) * 100 : 100;
    const targetPrice = related.find(order => order.limitPrice)?.limitPrice ??
      formatStrategyLimitPrice(strategy);
    const displayMode = related.find(order => order.wireMode !== "Limit" && order.wireMode !== "Maker Curve")?.wireMode ?? strategy.mode;
    const displayPair = related.find(order => order.pair)?.pair ?? strategy.pair;
    const vwap = weightedAverageClearing(fills);
    const fillRate = related.length > 0 ? (fills.length / related.length) * 100 : 0;
    return {
      strategy,
      displayMode,
      displayPair,
      submittedChildren,
      remainingChildren,
      schedule,
      expectedChildren,
      scheduleAdherence,
      fills: fills.length,
      noFills: related.filter(order => order.status === "no_fill").length,
      filledAmount,
      target,
      clearingPath: formatPricePath(fills.map(order => order.clearingPrice ?? "").filter(Boolean)),
      vwap,
      fillRate,
      targetPrice,
      nextChild: formatNextChild(strategy, activeEpochId ?? null, batchWindowMs ?? null),
    };
  });

  function exportCsv() {
    const rows = [
      [
        "record_type",
        "pair",
        "side",
        "mode",
        "amount",
        "limit_price",
        "arrival_clearing_price",
        "clearing_price",
        "headroom_bps",
        "submitted_at",
        "band",
        "total_depth",
        "filled_depth",
        "utilization_pct",
        "inventory_delta",
        "clearing_path",
        "strategy_id",
        "children",
        "schedule_pct",
        "schedule_adherence_pct",
        "vwap",
        "fill_rate_pct",
        "next_child",
      ],
      ...filled.map(order => [
        "fill",
        order.pair,
        order.side,
        order.wireMode,
        order.filledAmount ?? order.amount,
        order.limitPrice,
        order.arrivalReferencePrice ?? "",
        order.clearingPrice ?? "",
        formatHeadroomBps(order.side, order.limitPrice, order.clearingPrice ?? ""),
        new Date(order.submittedAt).toISOString(),
        "", "", "", "", "", "", "", "", "", "", "", "", "",
      ]),
      ...makerRows.map(row => {
        const utilization = row.depth > 0 ? (row.filledDepth / row.depth) * 100 : 0;
        return [
          "maker_band",
          row.pair,
          row.side,
          "Maker Curve",
          "",
          "",
          "",
          row.headroom.length > 0 ? formatBps(mean(row.headroom)) : "",
          "",
          "",
          row.band,
          formatHuman(row.depth),
          formatHuman(row.filledDepth),
          utilization.toFixed(1),
          formatSignedNumber(row.inventoryDelta),
          formatPricePath(row.clearingPrices),
          "", "", "", "", "", "", "",
        ];
      }),
      ...strategyRows.map(row => [
        "strategy",
        row.displayPair,
        row.strategy.side ?? "",
        row.displayMode,
        formatHuman(row.filledAmount),
        "",
        "",
        "",
        "",
        "", "", "", "", "", "",
        row.clearingPath,
        row.strategy.id,
        `${row.submittedChildren}/${row.strategy.max_children}`,
        row.schedule.toFixed(1),
        row.scheduleAdherence.toFixed(1),
        row.vwap,
        row.fillRate.toFixed(1),
        row.nextChild,
      ]),
    ];
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `zylith-tca-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="workspace-page tca-page">
      <div className="page-hd">
        <div className="page-title-block">
          <span className="page-title">TCA</span>
        </div>
        {filled.length > 0 && (
          <div className="page-actions">
            <button className="btn-ghost" onClick={exportCsv}>Export CSV</button>
          </div>
        )}
      </div>

      {!walletReady ? (
        <div className="table-zone">
          <div className="empty-zone">
            <div className="empty-mark">—</div>
            <div className="empty-body">Sign in to view TCA.</div>
          </div>
        </div>
      ) : allFilled.length === 0 ? (
        <div className="table-zone">
          <div className="empty-zone">
            <div className="empty-mark">—</div>
            <div className="empty-body">
              No fills yet. TCA appears after your first filled order.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="tca-stat-row">
            <div className="tca-stat-cells">
              <div className="tca-stat-cell">
                <div className="kpi-lbl">Fills</div>
                <div className="kpi-val z-amt">{filled.length}</div>
              </div>
              <div className="tca-stat-cell">
                <div className="kpi-lbl">Fill rate</div>
                <div className="kpi-val z-amt">{fillRate}</div>
              </div>
              <div className="tca-stat-cell">
                <div className="kpi-lbl">Avg headroom</div>
                <div className="kpi-val z-amt">{avgHeadroom}</div>
              </div>
              <div className="tca-stat-cell">
                <div className="kpi-lbl">Best fill</div>
                <div className="kpi-val z-amt">{bestFill}</div>
              </div>
            </div>
            <div className="tca-filter">
              {([
                ["all", "All"],
                ["7d", "7d"],
                ["30d", "30d"],
              ] as Array<[Period, string]>).map(([value, label]) => (
                <button
                  key={value}
                  className={`filter-chip ${period === value ? "on" : ""}`}
                  onClick={() => setPeriod(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="tca-divider" />

          {filled.length === 0 ? (
            <div className="table-zone tca-table-zone">
              <div className="empty-zone">
                <div className="empty-mark">—</div>
                <div className="empty-body">No fills in the selected period.</div>
              </div>
            </div>
          ) : (
            <div className="table-zone tca-table-zone">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Pair</th>
                    <th>Side</th>
                    <th>Mode</th>
                    <th>Amount</th>
                    <th>Limit</th>
                    <th>Clearing</th>
                    <th>Headroom</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {filled.map(order => (
                    <tr key={order.ordRef}>
                      <td>{order.pair}</td>
                      <td>
                        <span className={`side ${order.side === "Buy" ? "buy" : "sell"}`}>
                          {order.side}
                        </span>
                      </td>
                      <td>{order.wireMode}</td>
                      <td className="num">{order.filledAmount ?? order.amount}</td>
                      <td className="num">{order.limitPrice || "—"}</td>
                      <td className="num">{order.clearingPrice ?? "—"}</td>
                      <td className="num">{formatHeadroomBps(order.side, order.limitPrice, order.clearingPrice ?? "")}</td>
                      <td>{fmtTime(order.submittedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {makerRows.length > 0 && (
            <div className="tca-section">
              <div className="tca-section-hd">
                <span>Maker analytics</span>
                <em>Per-band depth, utilization, clearing path, and renewal effectiveness from locally recognized fills.</em>
              </div>
              <div className="table-zone compact-table">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Pair</th>
                      <th>Band</th>
                      <th>Curves</th>
                      <th>Total depth</th>
                      <th>Filled depth</th>
                      <th>Utilization</th>
                      <th>Epochs</th>
                      <th>Renewal</th>
                      <th>Clearing path</th>
                      <th>Inventory Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {makerRows.map(row => {
                      const utilization = row.depth > 0 ? (row.filledDepth / row.depth) * 100 : 0;
                      const renewal = row.renewalSubmitted > 0
                        ? `${row.renewalFilled}/${row.renewalSubmitted}`
                        : "—";
                      return (
                        <tr key={row.key}>
                          <td>{row.pair}</td>
                          <td className="num">
                            <span className={`side ${row.side === "Buy" ? "buy" : "sell"}`}>
                              {row.side === "Buy" ? "Bid" : "Ask"}
                            </span>{" "}
                            {row.band}
                          </td>
                          <td className="num">{row.filledOrders}/{row.submittedOrders}</td>
                          <td className="num">{formatHuman(row.depth)}</td>
                          <td className="num">{formatHuman(row.filledDepth)}</td>
                          <td className="num">{formatPct(utilization)}</td>
                          <td className="num tca-muted-cell">{epochUtilization(row)}</td>
                          <td className="num">{renewal}</td>
                          <td className="num tca-muted-cell">{formatPricePath(row.clearingPrices)}</td>
                          <td className="num">{formatSignedNumber(row.inventoryDelta)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {strategyRows.length > 0 && (
            <div className="tca-section">
              <div className="tca-section-hd">
                <span>Strategy analytics</span>
                <em>Child progress, schedule adherence, clearing path, and achieved price.</em>
              </div>
              <div className="table-zone compact-table">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th>Pair</th>
                      <th>Status</th>
                      <th>Children</th>
                      <th>Filled / target</th>
                      <th>Schedule</th>
                      <th>Clearing path</th>
                      <th>VWAP / target</th>
                      <th>Fill rate</th>
                      <th>Next child</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strategyRows.map(row => (
                      <tr key={row.strategy.id}>
                        <td>{row.displayMode}</td>
                        <td>{row.displayPair}</td>
                        <td>{row.strategy.status}</td>
                        <td className="num">
                          <span className="tca-child-primary">{row.submittedChildren}/{row.strategy.max_children}</span>
                          <span className="tca-child-secondary">{row.remainingChildren} left</span>
                        </td>
                        <td className="num">{formatHuman(row.filledAmount)} / {formatHuman(row.target)}</td>
                        <td className="num">
                          <span className="tca-child-primary">{formatPct(row.schedule)}</span>
                          <span className="tca-child-secondary">{formatPct(row.scheduleAdherence)} vs due</span>
                        </td>
                        <td className="num tca-muted-cell">{row.clearingPath}</td>
                        <td className="num">{row.vwap} / {row.targetPrice}</td>
                        <td className="num">{formatPct(row.fillRate)}</td>
                        <td className="num tca-muted-cell">{row.nextChild}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatBps(value: number): string {
  const formatted = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${formatted} bps`;
}
