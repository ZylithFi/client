import { formatClearingPrice, fromAtomicStr } from "./assets";
import type { BatchSummary, PublicSettlementTranscript } from "./auctionEpoch";
import type { LiquidityBandPoint } from "./liquidityBands";
import type { LocalOrder, PrivateStrategySummary } from "./orderLifecycle";
import { orderLiquidityBandAttribution, orderLiquidityBandPoints, statusLabel, statusTone } from "./orderLifecycle";
import type { WalletBalance } from "./shieldedBalances";

type PairConfigLike = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
};

export type LiquidityPositionRecord = {
  id: string;
  pair: string;
  side: "Buy" | "Sell";
  sideLabel: "Bid" | "Ask";
  status: "Active" | "Pending" | "Paused" | "Expiring" | "Cancelled" | "Historical";
  points: LiquidityBandPoint[];
  submittedAt: number;
  endEpoch?: number;
  nextChildIndex?: number;
  maxChildren?: number;
  relatedOrders: LocalOrder[];
  strategy?: PrivateStrategySummary;
};

export type PositionEpochOutcome = {
  key: string;
  epoch: number;
  submittedAt: number;
  label: string;
  tone: string;
  detail: string;
  clearingPrice?: string;
  filledAmount?: string;
};

export type LiquidityAnalyticsEpoch = {
  epoch: number;
  barValue: number;
  fillRate: number;
  filled: number;
  total: number;
};

export type LiquidityAnalyticsChartMode = "notional" | "fills";

export function parseHuman(value?: string): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatHuman(value: number, suffix = ""): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  const formatted = value.toLocaleString("en-US", {
    maximumFractionDigits: value >= 100 ? 2 : 6,
  });
  return suffix ? `${formatted} ${suffix}` : formatted;
}

export function formatCompactHuman(value: number, suffix = ""): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  const formatted = new Intl.NumberFormat("en-US", {
    notation: value >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 100_000 ? 2 : value >= 100 ? 1 : 6,
  }).format(value);
  return suffix ? `${formatted} ${suffix}` : formatted;
}

export function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}%`;
}

export function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

export function formatBps(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const formatted = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${formatted} bps`;
}

export function fmtTime(ts: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtAddr(value?: string): string {
  if (!value) return "-";
  if (value.length < 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

export function activeStatuses(order: LocalOrder): boolean {
  return ["queued", "in_batch", "proving", "settling", "settled_pending_output"].includes(order.status);
}

export function terminalFill(order: LocalOrder): boolean {
  return order.status === "filled" || order.status === "partial";
}

export function settlementConfirmed(order: LocalOrder): boolean {
  return order.status === "filled" || order.status === "partial" || order.status === "no_fill";
}

export function orderDepth(order: LocalOrder): number {
  return parseHuman(order.amount);
}

export function orderFilled(order: LocalOrder): number {
  if (!terminalFill(order)) return 0;
  return parseHuman(order.filledAmount ?? order.amount);
}

export function positionFillRate(orders: LocalOrder[]): number {
  if (orders.length === 0) return 0;
  return (orders.filter(terminalFill).length / orders.length) * 100;
}

export function averagePositionFillRate(records: LiquidityPositionRecord[]): string {
  const recordsWithOrders = records.filter(record => record.relatedOrders.length > 0);
  if (recordsWithOrders.length === 0) return "-";
  return formatPct(mean(recordsWithOrders.map(record => positionFillRate(record.relatedOrders))));
}

export function depthFilled(orders: LocalOrder[]): number {
  return orders.reduce((sum, order) => sum + orderFilled(order), 0);
}

export function weightedAverageClearing(orders: LocalOrder[]): string {
  let numerator = 0;
  let denominator = 0;
  for (const order of orders) {
    const price = parseHuman(order.clearingPrice);
    const size = orderFilled(order);
    if (price <= 0 || size <= 0) continue;
    numerator += price * size;
    denominator += size;
  }
  if (denominator <= 0) return "-";
  return (numerator / denominator).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function orderClearingPrice(order: LocalOrder, transcript?: PublicSettlementTranscript): number {
  const local = parseHuman(order.clearingPrice);
  if (local > 0) return local;
  if (!transcript) return 0;
  return parseHuman(formatClearingPrice({
    batchId: transcript.batch_id,
    epochId: transcript.batch_epoch,
    clearingPrice: String(transcript.clearing_price),
    priceBaseScale: transcript.price_base_scale ? String(transcript.price_base_scale) : undefined,
  }, {
    base_asset_id: order.pair.split("/")[0],
    quote_asset_id: order.pair.split("/")[1],
  }));
}

export function orderQuoteNotional(order: LocalOrder, transcript?: PublicSettlementTranscript): number {
  const filled = orderFilled(order);
  const clearing = orderClearingPrice(order, transcript);
  if (filled <= 0) return 0;
  if (clearing > 0) return filled * clearing;
  return 0;
}

function positionCaptureBps(order: LocalOrder): number | null {
  if (!terminalFill(order)) return null;
  const limit = parseHuman(order.limitPrice);
  const clearing = parseHuman(order.clearingPrice);
  if (limit <= 0 || clearing <= 0) return null;
  return order.side === "Buy"
    ? ((limit - clearing) / limit) * 10_000
    : ((clearing - limit) / limit) * 10_000;
}

export function weightedPositionCaptureBps(orders: LocalOrder[]): number {
  let numerator = 0;
  let denominator = 0;
  for (const order of orders) {
    const capture = positionCaptureBps(order);
    const size = orderFilled(order);
    if (capture === null || size <= 0) continue;
    numerator += capture * size;
    denominator += size;
  }
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

export function committedDepth(points: LiquidityBandPoint[], fallbackOrders: LocalOrder[]): number {
  const pointDepth = points.reduce((sum, point) => sum + parseHuman(point.baseAmount), 0);
  if (pointDepth > 0) return pointDepth;
  return fallbackOrders.reduce((sum, order) => sum + orderDepth(order), 0);
}

export function positionBaseAsset(record: LiquidityPositionRecord): string {
  return record.pair.split("/")[0] ?? "";
}

export function positionQuoteAsset(record: LiquidityPositionRecord): string {
  return record.pair.split("/")[1] ?? "";
}

export function positionFundingAsset(record: LiquidityPositionRecord): string {
  return record.side === "Buy" ? positionQuoteAsset(record) : positionBaseAsset(record);
}

export function liquidityStrategyInventoryCap(strategy?: PrivateStrategySummary): string | undefined {
  return strategy?.liquidity_inventory_cap;
}

export function liquidityStrategyBandCount(strategy?: PrivateStrategySummary): number | undefined {
  return strategy?.liquidity_curve_points?.length;
}

export function balanceAmount(
  balances: WalletBalance[],
  asset: string,
  field: "available" | "locked",
): bigint {
  const balance = balances.find(entry => entry.asset === asset);
  if (!balance) return 0n;
  try {
    return BigInt(balance[field]);
  } catch {
    return 0n;
  }
}

export function assetListText(assets: string[]) {
  if (assets.length <= 1) return assets[0] ?? "";
  return `${assets.slice(0, -1).join(", ")} and ${assets.at(-1)}`;
}

export function positionLockedCapital(record: LiquidityPositionRecord): number {
  if (record.points.length === 0) {
    return record.relatedOrders.reduce((sum, order) => sum + parseHuman(order.fundingAmount ?? order.amount), 0);
  }
  if (record.side === "Sell") return committedDepth(record.points, record.relatedOrders);
  return record.points.reduce((sum, point) => sum + parseHuman(point.price) * parseHuman(point.baseAmount), 0);
}

export function attributedBandFill(record: LiquidityPositionRecord, bandIndex: number): number | null {
  let sawAttribution = false;
  let filled = 0;
  const baseAsset = positionBaseAsset(record);
  for (const order of record.relatedOrders) {
    const attribution = orderLiquidityBandAttribution(order);
    if (!attribution?.bands?.length) continue;
    sawAttribution = true;
    for (const band of attribution.bands) {
      if (band.band_index === bandIndex) {
        try {
          filled += parseHuman(fromAtomicStr(band.filled_base_amount, baseAsset));
        } catch {
          continue;
        }
      }
    }
  }
  return sawAttribution ? filled : null;
}

export function displayedBandFill(record: LiquidityPositionRecord, bandIndex: number): number {
  const exact = attributedBandFill(record, bandIndex);
  if (exact !== null) return exact;
  return 0;
}

export function orderFundingExposure(order: LocalOrder, asset: string): number {
  if (order.fundingAsset === asset && order.fundingAmount) return parseHuman(order.fundingAmount);
  const [base, quote] = order.pair.split("/");
  if (order.side === "Sell" && base === asset) return parseHuman(order.amount);
  if (order.side === "Buy" && quote === asset) return parseHuman(order.amount) * parseHuman(order.limitPrice);
  return 0;
}

function strategyPoints(strategy: PrivateStrategySummary, pair: PairConfigLike | undefined): LiquidityBandPoint[] {
  if (!pair) return [];
  const points: LiquidityBandPoint[] = [];
  for (const point of strategy.liquidity_curve_points ?? []) {
    try {
      points.push({
        price: fromAtomicStr(point.price, pair.quote_asset_id),
        baseAmount: fromAtomicStr(point.base_amount, pair.base_asset_id),
      });
    } catch {
      continue;
    }
  }
  return points;
}

export function buildPositionRecords(
  orders: LocalOrder[],
  strategies: PrivateStrategySummary[],
  pairs: PairConfigLike[],
): LiquidityPositionRecord[] {
  const records: LiquidityPositionRecord[] = [];
  const consumedOrderRefs = new Set<string>();

  for (const strategy of strategies.filter(strategy => strategy.mode === "Resting")) {
    const pair = pairs.find(candidate => candidate.pair_id === strategy.pair);
    const relatedOrders = orders.filter(order => order.strategyId === strategy.id && order.orderCommitment);
    for (const order of relatedOrders) consumedOrderRefs.add(order.ordRef);
    const active = strategy.status === "active" || strategy.status === "delegated" || strategy.status === "pending_relay";
    const expiring = active && strategy.max_children - strategy.next_child_index + 1 <= 8;
    records.push({
      id: strategy.id,
      pair: strategy.pair,
      side: strategy.side ?? "Buy",
      sideLabel: (strategy.side ?? "Buy") === "Buy" ? "Bid" : "Ask",
      status: strategy.status === "cancelled"
        ? "Cancelled"
        : strategy.status === "paused"
          ? "Paused"
          : strategy.status === "pending_relay"
            ? "Pending"
            : expiring
              ? "Expiring"
              : active
                ? "Active"
                : "Historical",
      points: strategyPoints(strategy, pair),
      submittedAt: relatedOrders[0]?.submittedAt ?? Date.now(),
      endEpoch: strategy.end_epoch,
      nextChildIndex: strategy.next_child_index,
      maxChildren: strategy.max_children,
      relatedOrders,
      strategy,
    });
  }

  for (const order of orders) {
    if (consumedOrderRefs.has(order.ordRef)) continue;
    if (order.wireMode !== "Liquidity Position" && order.wireMode !== "Resting") continue;
    records.push({
      id: order.ordRef,
      pair: order.pair,
      side: order.side,
      sideLabel: order.side === "Buy" ? "Bid" : "Ask",
      status: activeStatuses(order)
        ? "Active"
        : order.status === "cancelled"
          ? "Cancelled"
          : "Historical",
      points: orderLiquidityBandPoints(order) ?? [{
        price: order.limitPrice || order.clearingPrice || "",
        baseAmount: order.amount,
      }],
      submittedAt: order.submittedAt,
      relatedOrders: [order],
    });
  }

  return records.sort((a, b) => {
    const statusRank = (record: LiquidityPositionRecord) => record.status === "Active" ? 0 : record.status === "Expiring" ? 1 : 2;
    return statusRank(a) - statusRank(b) || b.submittedAt - a.submittedAt;
  });
}

export function activePositionRecords(records: LiquidityPositionRecord[]): LiquidityPositionRecord[] {
  return records.filter(record =>
    record.status === "Active" ||
    record.status === "Pending" ||
    record.status === "Expiring" ||
    record.status === "Paused",
  );
}

export function positionStatusPillTone(status: LiquidityPositionRecord["status"]): string {
  if (status === "Active") return "good";
  if (status === "Pending") return "info";
  if (status === "Expiring") return "warn";
  if (status === "Cancelled") return "danger";
  return "muted";
}

function relayChildStatusDisplay(
  child: { order_commitment?: string; relay_status?: string; relay_detail?: string },
  fallback?: string,
): { label: string; tone: string } {
  switch (child.relay_status) {
    case "submitted":
    case "already_submitted":
    case "not_due":
      return { label: "Queued", tone: "info" };
    case "awaiting_settlement":
      return { label: "Awaiting settlement", tone: "info" };
    case "awaiting_wallet_refresh":
      return { label: "Refresh needed", tone: "warn" };
    case "batch_not_open":
      return { label: "Batch closed", tone: "warn" };
    case "safety_buffer":
      return { label: "Safety buffer", tone: "warn" };
    case "missed":
      return { label: "Missed", tone: "warn" };
    case "failed":
      return { label: "Relay failed", tone: "danger" };
    default:
      return { label: fallback ?? "Queued", tone: "info" };
  }
}

export function liquidityOutcomeTone(label: string, fallbackTone: string): string {
  if (label === "Filled") return "good";
  if (label === "Partial") return "info";
  if (["In batch", "Proving", "Settling", "Queued"].includes(label)) return "warn";
  if (label === "No fill") return "muted";
  return fallbackTone;
}

export function positionEpochOutcomes(
  record: LiquidityPositionRecord,
  batchStatus: Map<string, BatchSummary["status"]>,
): PositionEpochOutcome[] {
  const children = record.strategy?.submitted_children ?? [];
  if (children.length > 0) {
    return children.map(child => {
      const related = record.relatedOrders.find(order =>
        order.batchId === child.batch_id || order.orderCommitment === child.order_commitment,
      );
      const relayStatus = relayChildStatusDisplay(child, batchStatus.get(child.batch_id));
      const label = related ? statusLabel(related.status) : relayStatus.label;
      return {
        key: `${record.id}:child:${child.parent_child_index}`,
        epoch: child.epoch_id,
        submittedAt: child.submitted_at_unix_ms,
        label,
        tone: liquidityOutcomeTone(label, related ? statusTone(related.status) : relayStatus.tone),
        detail: related?.batchId ? `Batch ${fmtAddr(related.batchId)}` : child.relay_detail || relayStatus.label,
        clearingPrice: related?.clearingPrice,
        filledAmount: related?.filledAmount,
      };
    });
  }
  return record.relatedOrders.map((order, index) => ({
    key: `${record.id}:order:${order.ordRef || index}`,
    epoch: order.epochId,
    submittedAt: order.submittedAt,
    label: statusLabel(order.status),
    tone: liquidityOutcomeTone(statusLabel(order.status), statusTone(order.status)),
    detail: `Batch ${fmtAddr(order.batchId)}`,
    clearingPrice: order.clearingPrice,
    filledAmount: order.filledAmount,
  }));
}

export function epochOutcomeWindow(outcomes: PositionEpochOutcome[], limit = 48): PositionEpochOutcome[] {
  const sorted = [...outcomes].sort((a, b) => a.epoch - b.epoch);
  if (sorted.length <= limit) return sorted;
  return sorted.slice(sorted.length - limit);
}

export function latestEpochOutcomes(outcomes: PositionEpochOutcome[], limit = 12): PositionEpochOutcome[] {
  return [...outcomes]
    .sort((a, b) => b.epoch - a.epoch)
    .slice(0, limit)
    .reverse();
}

export function positionDisplayRef(record: LiquidityPositionRecord): string {
  const source = record.strategy?.parent_order_commitment || record.id;
  if (!source) return "LP";
  const compact = source
    .replace(/^strategy[-:]?/i, "")
    .replace(/^0x/i, "")
    .replace(/^0+/, "");
  const readable = compact.split(/[_:-]+/).filter(Boolean).slice(-2).join("-");
  if (/\b(parent|curve)\b/i.test(readable)) {
    return `LP-${positionBaseAsset(record).replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8) || "LIQ"}`;
  }
  return `LP-${(readable || compact).slice(0, 10).toUpperCase() || fmtAddr(source)}`;
}

export function averagePositionPrice(record: LiquidityPositionRecord): string {
  const settled = weightedAverageClearing(record.relatedOrders);
  if (settled !== "-") return settled;
  const prices = record.points.map(point => parseHuman(point.price)).filter(value => value > 0);
  if (prices.length === 0) return "-";
  return mean(prices).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function renewalPackageStatus(record: LiquidityPositionRecord): {
  label: string;
  tone: "info" | "warn" | "good";
} {
  const strategy = record.strategy;
  const renewalPackage = strategy?.offline_package;
  if (!strategy || !renewalPackage) {
    return {
      label: "Missing",
      tone: "warn",
    };
  }
  const packageChildren = strategy.submitted_children.filter(child =>
    child.epoch_id >= renewalPackage.start_epoch && child.epoch_id <= renewalPackage.end_epoch,
  );
  const hasSubmittedChild = packageChildren.some(child => child.submitted_at_unix_ms > 0);
  const hasSettledChild = packageChildren.some(child =>
    record.relatedOrders.some(order =>
      (order.orderCommitment === child.order_commitment || order.batchId === child.batch_id) &&
      settlementConfirmed(order),
    ),
  );
  if (hasSettledChild) {
    return {
      label: "Confirmed",
      tone: "good",
    };
  }
  if (hasSubmittedChild) {
    return {
      label: "Pending",
      tone: "info",
    };
  }
  return {
    label: "Unconfirmed",
    tone: "warn",
  };
}

export function buildLiquidityEpochSeries(
  rows: Array<{ order: LocalOrder; transcript?: PublicSettlementTranscript }>,
  chartMode: LiquidityAnalyticsChartMode,
): LiquidityAnalyticsEpoch[] {
  const grouped = new Map<number, { barValue: number; filled: number; total: number }>();
  for (const { order, transcript } of rows) {
    const epoch = order.epochId || 0;
    const current = grouped.get(epoch) ?? { barValue: 0, filled: 0, total: 0 };
    const filled = terminalFill(order) ? 1 : 0;
    current.barValue += chartMode === "notional" ? orderQuoteNotional(order, transcript) : filled;
    current.filled += filled;
    current.total += 1;
    grouped.set(epoch, current);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([epoch, value]) => ({
      epoch,
      barValue: value.barValue,
      filled: value.filled,
      total: value.total,
      fillRate: value.total > 0 ? (value.filled / value.total) * 100 : 0,
    }));
}

export function visibleLiquidityEpochSeries(series: LiquidityAnalyticsEpoch[], windowSize = 30): LiquidityAnalyticsEpoch[] {
  if (series.length === 0) return [];
  const byEpoch = new Map(series.map(point => [point.epoch, point]));
  const end = series.at(-1)?.epoch ?? series[series.length - 1].epoch;
  const first = series[0]?.epoch ?? end;
  const start = Math.max(first, end - windowSize + 1);
  const visible: LiquidityAnalyticsEpoch[] = [];
  for (let epoch = start; epoch <= end; epoch += 1) {
    visible.push(byEpoch.get(epoch) ?? {
      epoch,
      barValue: 0,
      fillRate: 0,
      filled: 0,
      total: 0,
    });
  }
  return visible;
}
