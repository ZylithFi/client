import { Fragment, useEffect, useMemo, useState } from "react";
import { formatClearingPrice, fromAtomicStr } from "../domain/assets";
import type { BatchSummary, PublicSettlementTranscript } from "../domain/auctionEpoch";
import type { CurvePoint } from "../domain/makerCurves";
import { defaultCurveBands } from "../domain/makerCurves";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";
import { statusLabel, statusTone } from "../domain/orderLifecycle";
import type { PendingDeposit, WalletBalance, WithdrawableNote } from "../domain/shieldedBalances";
import type {
  FundingPreview,
  PairConfig,
  TicketSubmitIntent,
} from "../components/OrderTicket";
import { normalizeSelfRelayUrl } from "../domain/selfHostedRenewalRelay";
import { userFacingErrorMessage } from "../domain/userFacingErrors";

type CurveSide = "bid" | "ask";
type RelayOperator = "ZylithRelay" | "SelfHostedRelay" | "LocalBrowser";
type Period = "7d" | "30d" | "90d" | "all";
type LiquidityPageTab = "curves" | "orders" | "inventory" | "analytics";
type RenewalDurationPreset = "1" | "4" | "12" | "24" | "720" | "2160" | "continuous" | "custom";
const MIN_CURVE_BANDS = 3;
const LOCAL_BROWSER_MAX_RENEWAL_HOURS = 1;
const MAX_RELAY_RENEWAL_DAYS = 90;
const CONTINUOUS_ROLLING_WINDOW_HOURS = MAX_RELAY_RENEWAL_DAYS * 24;
const SELF_RELAY_ENDPOINT_KEY = "zylith.self-relay-endpoint.v1";

const RENEWAL_DURATION_OPTIONS: Array<{ value: RenewalDurationPreset; label: string; relayOnly?: boolean }> = [
  { value: "1", label: "1h" },
  { value: "4", label: "4h", relayOnly: true },
  { value: "12", label: "12h", relayOnly: true },
  { value: "24", label: "24h", relayOnly: true },
  { value: "720", label: "30d", relayOnly: true },
  { value: "2160", label: "90d", relayOnly: true },
  { value: "continuous", label: "Continuous", relayOnly: true },
  { value: "custom", label: "Custom", relayOnly: true },
];

type LiquidityCurveRecord = {
  id: string;
  pair: string;
  side: "Buy" | "Sell";
  sideLabel: "Bid" | "Ask";
  status: "Active" | "Pending" | "Paused" | "Expiring" | "Cancelled" | "Historical";
  points: CurvePoint[];
  submittedAt: number;
  endEpoch?: number;
  nextChildIndex?: number;
  maxChildren?: number;
  relatedOrders: LocalOrder[];
  strategy?: PrivateStrategySummary;
};

function liquidityPageTitle(tab: LiquidityPageTab): string {
  if (tab === "orders") return "ORDERS";
  if (tab === "inventory") return "INVENTORY";
  if (tab === "analytics") return "ANALYTICS";
  return "LIQUIDITY";
}

function parseHuman(value?: string): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatHuman(value: number, suffix = ""): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const formatted = value.toLocaleString("en-US", {
    maximumFractionDigits: value >= 100 ? 2 : 6,
  });
  return suffix ? `${formatted} ${suffix}` : formatted;
}

function formatCompactHuman(value: number, suffix = ""): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const formatted = new Intl.NumberFormat("en-US", {
    notation: value >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 100_000 ? 2 : value >= 100 ? 1 : 6,
  }).format(value);
  return suffix ? `${formatted} ${suffix}` : formatted;
}

function renewalHoursForPreset(preset: RenewalDurationPreset, customDays: string): number {
  if (preset === "continuous") return CONTINUOUS_ROLLING_WINDOW_HOURS;
  if (preset === "custom") {
    const parsed = Number(customDays);
    if (!Number.isFinite(parsed) || parsed <= 0) return 24;
    return Math.max(1, Math.min(MAX_RELAY_RENEWAL_DAYS, parsed)) * 24;
  }
  return Number(preset);
}

function renewalWindowLabel(preset: RenewalDurationPreset, hours: number): string {
  if (preset === "continuous") return "Continuous · 90d rolling package";
  if (hours >= 24) {
    const days = hours / 24;
    return `${days.toLocaleString("en-US", { maximumFractionDigits: 1 })}d package`;
  }
  return `${hours}h window`;
}

function relayModeForOperator(operator: RelayOperator): "SelfRelay" | "ZylithRelay" {
  return operator === "ZylithRelay" ? "ZylithRelay" : "SelfRelay";
}

function relayOperatorForMode(mode?: "SelfRelay" | "ZylithRelay"): RelayOperator {
  if (mode === "ZylithRelay") return "ZylithRelay";
  if (mode === "SelfRelay") return "SelfHostedRelay";
  return "LocalBrowser";
}

function loadSelfRelayEndpoint(): string {
  try {
    return sessionStorage.getItem(SELF_RELAY_ENDPOINT_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistSelfRelayEndpoint(value: string): void {
  try {
    if (value.trim()) sessionStorage.setItem(SELF_RELAY_ENDPOINT_KEY, value.trim());
    else sessionStorage.removeItem(SELF_RELAY_ENDPOINT_KEY);
    localStorage.removeItem(SELF_RELAY_ENDPOINT_KEY);
  } catch {
    /* noop */
  }
}

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function formatBps(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const formatted = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${formatted} bps`;
}

function fmtTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtAddr(value?: string): string {
  if (!value) return "—";
  if (value.length < 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

function activeStatuses(order: LocalOrder): boolean {
  return ["queued", "in_batch", "proving", "settling", "settled_pending_output"].includes(order.status);
}

function terminalFill(order: LocalOrder): boolean {
  return order.status === "filled" || order.status === "partial";
}

function settlementConfirmed(order: LocalOrder): boolean {
  return order.status === "filled" || order.status === "partial" || order.status === "no_fill";
}

function orderDepth(order: LocalOrder): number {
  return parseHuman(order.amount);
}

function orderFilled(order: LocalOrder): number {
  if (!terminalFill(order)) return 0;
  return parseHuman(order.filledAmount ?? order.amount);
}

function curveFillRate(orders: LocalOrder[]): number {
  if (orders.length === 0) return 0;
  return (orders.filter(terminalFill).length / orders.length) * 100;
}

function averageCurveFillRate(records: LiquidityCurveRecord[]): string {
  const recordsWithOrders = records.filter(record => record.relatedOrders.length > 0);
  if (recordsWithOrders.length === 0) return "—";
  return formatPct(mean(recordsWithOrders.map(record => curveFillRate(record.relatedOrders))));
}

function depthFilled(orders: LocalOrder[]): number {
  return orders.reduce((sum, order) => sum + orderFilled(order), 0);
}

function weightedAverageClearing(orders: LocalOrder[]): string {
  let numerator = 0;
  let denominator = 0;
  for (const order of orders) {
    const price = parseHuman(order.clearingPrice);
    const size = orderFilled(order);
    if (price <= 0 || size <= 0) continue;
    numerator += price * size;
    denominator += size;
  }
  if (denominator <= 0) return "—";
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

function orderQuoteNotional(order: LocalOrder, transcript?: PublicSettlementTranscript): number {
  const filled = orderFilled(order);
  const clearing = orderClearingPrice(order, transcript);
  if (filled <= 0) return 0;
  if (clearing > 0) return filled * clearing;
  return 0;
}

function makerCaptureBps(order: LocalOrder): number | null {
  if (!terminalFill(order)) return null;
  const limit = parseHuman(order.limitPrice);
  const clearing = parseHuman(order.clearingPrice);
  if (limit <= 0 || clearing <= 0) return null;
  return order.side === "Buy"
    ? ((limit - clearing) / limit) * 10_000
    : ((clearing - limit) / limit) * 10_000;
}

function weightedMakerCaptureBps(orders: LocalOrder[]): number {
  let numerator = 0;
  let denominator = 0;
  for (const order of orders) {
    const capture = makerCaptureBps(order);
    const size = orderFilled(order);
    if (capture === null || size <= 0) continue;
    numerator += capture * size;
    denominator += size;
  }
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

function committedDepth(points: CurvePoint[], fallbackOrders: LocalOrder[]): number {
  const pointDepth = points.reduce((sum, point) => sum + parseHuman(point.baseAmount), 0);
  if (pointDepth > 0) return pointDepth;
  return fallbackOrders.reduce((sum, order) => sum + orderDepth(order), 0);
}

function curveBaseAsset(record: LiquidityCurveRecord): string {
  return record.pair.split("/")[0] ?? "";
}

function curveQuoteAsset(record: LiquidityCurveRecord): string {
  return record.pair.split("/")[1] ?? "";
}

function curveFundingAsset(record: LiquidityCurveRecord): string {
  return record.side === "Buy" ? curveQuoteAsset(record) : curveBaseAsset(record);
}

function balanceAmount(
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

function assetListText(assets: string[]) {
  if (assets.length <= 1) return assets[0] ?? "";
  return `${assets.slice(0, -1).join(", ")} and ${assets.at(-1)}`;
}

function curveLockedCapital(record: LiquidityCurveRecord): number {
  if (record.points.length === 0) {
    return record.relatedOrders.reduce((sum, order) => sum + parseHuman(order.fundingAmount ?? order.amount), 0);
  }
  if (record.side === "Sell") return committedDepth(record.points, record.relatedOrders);
  return record.points.reduce((sum, point) => sum + parseHuman(point.price) * parseHuman(point.baseAmount), 0);
}

function attributedBandFill(record: LiquidityCurveRecord, bandIndex: number): number | null {
  let sawAttribution = false;
  let filled = 0;
  const baseAsset = curveBaseAsset(record);
  for (const order of record.relatedOrders) {
    const attribution = order.makerBandAttribution;
    if (!attribution?.bands?.length) continue;
    sawAttribution = true;
    for (const band of attribution.bands) {
      if (band.band_index === bandIndex) {
        filled += parseHuman(fromAtomicStr(band.filled_base_amount, baseAsset));
      }
    }
  }
  return sawAttribution ? filled : null;
}

function displayedBandFill(record: LiquidityCurveRecord, bandIndex: number, fallbackRemaining: number): number {
  const exact = attributedBandFill(record, bandIndex);
  if (exact !== null) return exact;
  const depth = parseHuman(record.points[bandIndex]?.baseAmount);
  return Math.min(depth, fallbackRemaining);
}

function orderFundingExposure(order: LocalOrder, asset: string): number {
  if (order.fundingAsset === asset && order.fundingAmount) return parseHuman(order.fundingAmount);
  const [base, quote] = order.pair.split("/");
  if (order.side === "Sell" && base === asset) return parseHuman(order.amount);
  if (order.side === "Buy" && quote === asset) return parseHuman(order.amount) * parseHuman(order.limitPrice);
  return 0;
}

function strategyPoints(strategy: PrivateStrategySummary, pair: PairConfig | undefined): CurvePoint[] {
  if (!pair) return [];
  return (strategy.maker_curve_points ?? []).map(point => ({
    price: fromAtomicStr(point.price, pair.quote_asset_id),
    baseAmount: fromAtomicStr(point.base_amount, pair.base_asset_id),
  }));
}

function buildCurveRecords(
  orders: LocalOrder[],
  strategies: PrivateStrategySummary[],
  pairs: PairConfig[],
): LiquidityCurveRecord[] {
  const records: LiquidityCurveRecord[] = [];
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
    if (order.wireMode !== "Maker Curve" && order.wireMode !== "Resting") continue;
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
      points: order.makerCurvePoints ?? [{
        price: order.limitPrice || order.clearingPrice || "",
        baseAmount: order.amount,
      }],
      submittedAt: order.submittedAt,
      relatedOrders: [order],
    });
  }

  return records.sort((a, b) => {
    const statusRank = (record: LiquidityCurveRecord) => record.status === "Active" ? 0 : record.status === "Expiring" ? 1 : 2;
    return statusRank(a) - statusRank(b) || b.submittedAt - a.submittedAt;
  });
}

function activeCurveRecords(records: LiquidityCurveRecord[]): LiquidityCurveRecord[] {
  return records.filter(record =>
    record.status === "Active" ||
    record.status === "Pending" ||
    record.status === "Expiring" ||
    record.status === "Paused",
  );
}

function curveStatusPillTone(status: LiquidityCurveRecord["status"]): string {
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

type CurveEpochOutcome = {
  key: string;
  epoch: number;
  submittedAt: number;
  label: string;
  tone: string;
  detail: string;
  clearingPrice?: string;
  filledAmount?: string;
};

function curveEpochOutcomes(
  record: LiquidityCurveRecord,
  batchStatus: Map<string, BatchSummary["status"]>,
): CurveEpochOutcome[] {
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
        tone: makerOutcomeTone(label, related ? statusTone(related.status) : relayStatus.tone),
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
    tone: makerOutcomeTone(statusLabel(order.status), statusTone(order.status)),
    detail: `Batch ${fmtAddr(order.batchId)}`,
    clearingPrice: order.clearingPrice,
    filledAmount: order.filledAmount,
  }));
}

function makerOutcomeTone(label: string, fallbackTone: string): string {
  if (label === "Filled") return "good";
  if (label === "Partial") return "info";
  if (["In batch", "Proving", "Settling", "Queued"].includes(label)) return "warn";
  if (label === "No fill") return "muted";
  return fallbackTone;
}

function epochOutcomeWindow(outcomes: CurveEpochOutcome[], limit = 48): CurveEpochOutcome[] {
  const sorted = [...outcomes].sort((a, b) => a.epoch - b.epoch);
  if (sorted.length <= limit) return sorted;
  return sorted.slice(sorted.length - limit);
}

function latestEpochOutcomes(outcomes: CurveEpochOutcome[], limit = 12): CurveEpochOutcome[] {
  return [...outcomes]
    .sort((a, b) => b.epoch - a.epoch)
    .slice(0, limit)
    .reverse();
}

function curveDisplayRef(record: LiquidityCurveRecord): string {
  const source = record.strategy?.parent_order_commitment || record.id;
  if (!source) return "CRV";
  const compact = source
    .replace(/^strategy[-:]?/i, "")
    .replace(/^0x/i, "")
    .replace(/^0+/, "")
    .replace(/^demo[_-]?/i, "");
  const readable = compact.split(/[_:-]+/).filter(Boolean).slice(-2).join("-");
  if (/\b(parent|curve)\b/i.test(readable)) {
    return `CRV-${curveBaseAsset(record).replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8) || "MAKER"}`;
  }
  return `CRV-${(readable || compact).slice(0, 10).toUpperCase() || fmtAddr(source)}`;
}

function averageCurvePrice(record: LiquidityCurveRecord): string {
  const settled = weightedAverageClearing(record.relatedOrders);
  if (settled !== "—") return settled;
  const prices = record.points.map(point => parseHuman(point.price)).filter(value => value > 0);
  if (prices.length === 0) return "—";
  return mean(prices).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function CurveOutcomeCells({
  outcomes,
  limit = 48,
  future = 0,
}: {
  outcomes: CurveEpochOutcome[];
  limit?: number;
  future?: number;
}) {
  const sorted = [...outcomes].sort((a, b) => a.epoch - b.epoch);
  const visible = epochOutcomeWindow(outcomes, limit);
  const hidden = Math.max(0, sorted.length - visible.length);
  return (
    <span className="cor-strip" aria-label="Per-epoch fill outcomes">
      {visible.map(outcome => (
        <span
          key={outcome.key}
          className={`cor-cell ${outcome.tone}`}
          title={`Epoch ${outcome.epoch.toLocaleString("en-US")} · ${outcome.label}`}
          aria-label={`Epoch ${outcome.epoch}: ${outcome.label}`}
        />
      ))}
      {Array.from({ length: future }, (_, index) => (
        <span
          key={`future:${index}`}
          className="cor-cell future"
          aria-label="Future epoch pending"
        />
      ))}
      {hidden > 0 && <span className="cor-strip-more">+{hidden}</span>}
    </span>
  );
}

function renewalPackageStatus(record: LiquidityCurveRecord): {
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

function CurveChildTimeline({
  record,
  outcomes,
  submitted,
  scheduled,
  onCancelCurve,
}: {
  record: LiquidityCurveRecord;
  outcomes: CurveEpochOutcome[];
  submitted: number;
  scheduled: number;
  onCancelCurve: (record: LiquidityCurveRecord) => void;
}) {
  const visible = latestEpochOutcomes(outcomes, 8);
  const remaining = Math.max(0, scheduled - submitted);
  const tx = record.strategy?.parent_cancel_transaction_hash;
  const packageStatus = renewalPackageStatus(record);

  return (
    <tr className="strategy-detail-row liquidity-detail-row">
      <td className="side-bar-cell" />
      <td colSpan={10}>
        <div className="strategy-child-panel" aria-label="Curve child orders">
          <div className="strategy-child-panel-hd">
            <span>Child execution</span>
            <em>{submitted}/{scheduled} submitted · {remaining} left</em>
          </div>
          {record.strategy && (
            <div className="liq-renewal-root-row">
              <span>Renewal root</span>
              <strong className={`pill ${packageStatus.tone}`}>{packageStatus.label}</strong>
            </div>
          )}
          {tx && (
            <div className="liq-cancel-anchor">
              Cancel anchored · {fmtAddr(tx)}
            </div>
          )}
          {visible.length === 0 ? (
            <div className="strategy-child-empty">No child orders submitted yet.</div>
          ) : (
            visible.map((outcome, index) => (
              <div key={outcome.key} className="strategy-child-timeline-row">
                <div className="strategy-child-step">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </div>
                <div className="strategy-child-main">
                  <div className="strategy-child-primary">
                    <span className={`pill ${outcome.tone}`}>{outcome.label}</span>
                    <span>Epoch {outcome.epoch.toLocaleString("en-US")}</span>
                    <span>{fmtTime(outcome.submittedAt)}</span>
                  </div>
                  <div className="strategy-child-secondary">
                    <span>Clearing {outcome.clearingPrice ?? "—"}</span>
                    <span>Filled {outcome.filledAmount ?? "—"}</span>
                    <span>{outcome.detail}</span>
                  </div>
                </div>
              </div>
            ))
          )}
          {outcomes.length > visible.length && (
            <div className="strategy-child-timeline-row">
              <div className="strategy-child-step"><span>···</span></div>
              <div className="strategy-child-main">
                <div className="strategy-child-primary">
                  <span>{outcomes.length} submitted slices total</span>
                </div>
              </div>
            </div>
          )}
          {record.status !== "Cancelled" && (
            <div className="liq-parent-actions">
              <button className="table-action" onClick={() => onCancelCurve(record)}>Cancel parent</button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function sideFromCurveSide(side: CurveSide): "Buy" | "Sell" {
  return side === "bid" ? "Buy" : "Sell";
}

function curveCtaLabel(side: CurveSide): string {
  return side === "bid" ? "Activate bid curve" : "Activate ask curve";
}

function bandRowsFilled(points: CurvePoint[]): CurvePoint[] {
  return points.filter(point => point.price.trim() && point.baseAmount.trim());
}

function CurveBandEditor({
  title,
  quote,
  base,
  bands,
  onBands,
}: {
  title?: string;
  quote: string;
  base: string;
  bands: CurvePoint[];
  onBands: (points: CurvePoint[]) => void;
}) {
  function update(index: number, patch: Partial<CurvePoint>) {
    onBands(bands.map((band, i) => i === index ? { ...band, ...patch } : band));
  }

  return (
    <div className="liq-band-editor">
      {title && <div className="liq-band-title">{title}</div>}
      <table className="curve-table">
        <thead>
          <tr>
            <th className="curve-th">Price ({quote})</th>
            <th className="curve-th">Depth ({base})</th>
            <th className="curve-th" />
          </tr>
        </thead>
        <tbody>
          {bands.map((band, index) => (
            <tr className="curve-band-row" key={index}>
              <td className="curve-band-cell">
                <input
                  className="curve-band-input"
                  type="text"
                  inputMode="decimal"
                  placeholder={index === 0 ? "0.6800" : "0"}
                  value={band.price}
                  onChange={event => update(index, { price: event.target.value })}
                />
              </td>
              <td className="curve-band-cell">
                <input
                  className="curve-band-input"
                  type="text"
                  inputMode="decimal"
                  placeholder={index === 0 ? "10,000" : "0"}
                  value={band.baseAmount}
                  onChange={event => update(index, { baseAmount: event.target.value })}
                />
              </td>
              <td className="curve-band-cell">
                {bands.length > MIN_CURVE_BANDS && (
                  <button
                    className="curve-band-remove"
                    type="button"
                    aria-label="Remove curve band"
                    onClick={() => onBands(bands.filter((_, i) => i !== index))}
                  >
                    x
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {bands.length < 8 && (
        <button
          className="curve-add-link"
          type="button"
          onClick={() => onBands([...bands, { price: "", baseAmount: "" }])}
        >
          + Add band
        </button>
      )}
    </div>
  );
}

function CurvePreview({
  pair,
  side,
  bidBands,
  askBands,
  inventoryCap,
  renewing,
  renewalWindowHours,
  renewalWindowLabelText,
  relayMode,
  relayOperator,
  selfRelayUrl,
  onPreviewFunding,
}: {
  pair: PairConfig;
  side: CurveSide;
  bidBands: CurvePoint[];
  askBands: CurvePoint[];
  inventoryCap: string;
  renewing: boolean;
  renewalWindowHours: string;
  renewalWindowLabelText: string;
  relayMode: "SelfRelay" | "ZylithRelay";
  relayOperator: RelayOperator;
  selfRelayUrl?: string;
  onPreviewFunding?: (intent: TicketSubmitIntent) => FundingPreview | null;
}) {
  const activeBandSets = [side === "bid" ? bidBands : askBands];
  const filledBands = activeBandSets.flatMap(bandRowsFilled);
  const totalDepth = filledBands.reduce((sum, band) => sum + parseHuman(band.baseAmount), 0);
  const prices = filledBands.map(band => parseHuman(band.price)).filter(value => value > 0);
  const threshold = fromAtomicStr(pair.min_order_amount, pair.base_asset_id);
  const thresholdNumber = parseHuman(threshold);
  const eligible = totalDepth >= thresholdNumber && filledBands.length >= MIN_CURVE_BANDS;
  let preview: FundingPreview | null = null;
  let previewError: string | null = null;
  if (filledBands.length > 0 && onPreviewFunding) {
    try {
      preview = onPreviewFunding({
        pairId: pair.pair_id,
        side: sideFromCurveSide(side),
        shape: "curve",
        stratKind: "TWAP",
        resting: renewing,
        amount: "",
        limitPrice: "",
        minFill: "",
        fillOrKill: false,
        curvePoints: filledBands,
        inventoryCap,
        durationHours: renewalWindowHours,
        childSize: "",
        priceLimit: "",
        jitter: 0,
        relayMode: renewing ? relayMode : "SelfRelay",
        relayOperator: renewing ? relayOperator : "LocalBrowser",
        selfRelayUrl: relayOperator === "SelfHostedRelay" ? selfRelayUrl : undefined,
      });
    } catch (error) {
      previewError = userFacingErrorMessage(error, "Funding preview unavailable.");
    }
  }

  return (
    <div className="curve-preview">
      <div className="curve-preview-row">
        <span className="curve-preview-lbl">Total depth</span>
        <span className="curve-preview-val">{formatHuman(totalDepth, pair.base_asset_id)}</span>
      </div>
      <div className="curve-preview-row">
        <span className="curve-preview-lbl">Price range</span>
        <span className="curve-preview-val">
          {prices.length > 0
            ? `${Math.min(...prices).toLocaleString()}-${Math.max(...prices).toLocaleString()} ${pair.quote_asset_id}`
            : "—"}
        </span>
      </div>
      <div className="curve-preview-row">
        <span className="curve-preview-lbl">Renewal</span>
        <span className="curve-preview-val">{renewing ? renewalWindowLabelText : "Current epoch only"}</span>
      </div>
      <div className="curve-preview-row">
        <span className="curve-preview-lbl">Eligibility</span>
        <span
          className={`curve-preview-val ${eligible ? "good" : "warn"}`}
          title={eligible
            ? "Curve satisfies local maker quote constraints."
            : "Curve needs the required bands, spread, and funding before it can be submitted."}
        >
          {eligible ? "Quote eligible" : "Quote incomplete"}
        </span>
      </div>
      {preview && (
        <>
          <div className="curve-preview-row">
            <span className="curve-preview-lbl">Funding notes</span>
            <span className="curve-preview-val">{preview.notes.length}</span>
          </div>
          <div className="curve-preview-row">
            <span className="curve-preview-lbl">Locked capital</span>
            <span className="curve-preview-val">{fromAtomicStr(preview.selected_total, preview.asset)} {preview.asset}</span>
          </div>
        </>
      )}
      {previewError && <div className="wc-note warn">{previewError}</div>}
    </div>
  );
}

export function LiquidityCurvesScreen({
  pairs,
  records,
  balances,
  pendingDeposits,
  activePairId,
  setActivePairId,
  walletReady,
  submitting,
  submitError,
  onPreviewFunding,
  onSubmitCurve,
  onCancelCurve,
  onEditCurve,
  onPauseCurve,
  onResumeCurve,
  onDeposit,
  editRecord,
  onEditConsumed,
}: {
  pairs: PairConfig[];
  records: LiquidityCurveRecord[];
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  activePairId: string;
  setActivePairId: (pairId: string) => void;
  walletReady: boolean;
  submitting: boolean;
  submitError: string | null;
  onPreviewFunding?: (intent: TicketSubmitIntent) => FundingPreview | null;
  onSubmitCurve: (intent: TicketSubmitIntent) => Promise<boolean | void>;
  onCancelCurve: (record: LiquidityCurveRecord) => void;
  onEditCurve: (record: LiquidityCurveRecord) => void;
  onPauseCurve: (record: LiquidityCurveRecord) => void;
  onResumeCurve: (record: LiquidityCurveRecord) => void;
  onDeposit: (asset?: string) => void;
  editRecord: LiquidityCurveRecord | null;
  onEditConsumed: () => void;
}) {
  const selectedPair = pairs.find(pair => pair.pair_id === activePairId) ?? pairs[0] ?? null;
  const [side, setSide] = useState<CurveSide>("bid");
  const [bidBands, setBidBands] = useState<CurvePoint[]>(() => defaultCurveBands());
  const [askBands, setAskBands] = useState<CurvePoint[]>(() => defaultCurveBands());
  const [advanced, setAdvanced] = useState(false);
  const [inventoryCap, setInventoryCap] = useState("");
  const [renewing, setRenewing] = useState(true);
  const [renewalDuration, setRenewalDuration] = useState<RenewalDurationPreset>("1");
  const [customRenewalDays, setCustomRenewalDays] = useState("30");
  const [relayOperator, setRelayOperator] = useState<RelayOperator>("LocalBrowser");
  const [selfRelayEndpoint, setSelfRelayEndpoint] = useState(() => loadSelfRelayEndpoint());

  function prefillBuilder(record: LiquidityCurveRecord) {
    setActivePairId(record.pair);
    setSide(record.side === "Buy" ? "bid" : "ask");
    const nextBands = record.points.length > 0 ? record.points : defaultCurveBands();
    if (record.side === "Buy") setBidBands(nextBands);
    else setAskBands(nextBands);
    setRenewing(Boolean(record.strategy));
    if (record.strategy?.offline_package?.slot_count && record.strategy.offline_package.slot_count > 960) {
      const epochs = Math.max(1, record.strategy.offline_package.slot_count);
      if (epochs >= 86_400) setRenewalDuration("2160");
      else if (epochs >= 28_800) setRenewalDuration("720");
      else setRenewalDuration("24");
    }
    if (record.strategy?.maker_inventory_cap) {
      const pair = pairs.find(candidate => candidate.pair_id === record.pair);
      setInventoryCap(pair ? fromAtomicStr(record.strategy.maker_inventory_cap, pair.base_asset_id) : "");
    } else {
      setInventoryCap("");
    }
    setRelayOperator(relayOperatorForMode(record.strategy?.offline_package?.relay_mode));
  }

  useEffect(() => {
    if (!editRecord) return;
    prefillBuilder(editRecord);
    onEditConsumed();
  }, [editRecord, onEditConsumed]);

  if (!selectedPair) {
    return (
      <div className="workspace-page liquidity-page">
        <div className="page-hd"><span className="page-title">CURVES</span></div>
        <div className="empty-zone"><div className="empty-mark">—</div><div className="empty-body">No enabled pairs.</div></div>
      </div>
    );
  }

  const base = selectedPair.base_asset_id;
  const quote = selectedPair.quote_asset_id;
  const selectedPairRecords = records.filter(record => record.pair === selectedPair.pair_id);
  const selectedSideRecord = selectedPairRecords.find(record =>
    record.side === sideFromCurveSide(side)
  );
  const selectedPairClearing = selectedPairRecords
    .flatMap(record => record.relatedOrders)
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .find(order => order.clearingPrice)?.clearingPrice;
  useEffect(() => {
    if (selectedSideRecord || selectedPairRecords.length === 0) return;
    setSide(selectedPairRecords[0].side === "Buy" ? "bid" : "ask");
  }, [selectedPair.pair_id, selectedPairRecords.length, selectedSideRecord]);
  useEffect(() => {
    if (!selectedSideRecord || editRecord) return;
    const nextBands =
      selectedSideRecord.points.length > 0
        ? selectedSideRecord.points
        : defaultCurveBands();
    if (side === "bid") setBidBands(nextBands);
    else setAskBands(nextBands);
    setRenewing(Boolean(selectedSideRecord.strategy));
    setInventoryCap(
      selectedSideRecord.strategy?.maker_inventory_cap
        ? fromAtomicStr(
            selectedSideRecord.strategy.maker_inventory_cap,
            selectedPair.base_asset_id
          )
        : ""
    );
    setRelayOperator(
      relayOperatorForMode(selectedSideRecord.strategy?.offline_package?.relay_mode)
    );
  }, [editRecord, selectedPair.base_asset_id, selectedSideRecord?.id, side]);
  const builderInventoryAssets = Array.from(new Set([base, quote]));
  const neededInventoryAssets = side === "bid" ? [quote] : [base];
  const missingInventoryAssets = neededInventoryAssets.filter(asset =>
    balanceAmount(balances, asset, "available") <= 0n,
  );
  const lockedOnlyAssets = missingInventoryAssets.filter(asset =>
    balanceAmount(balances, asset, "locked") > 0n,
  );
  const missingInventoryText = `${assetListText(missingInventoryAssets)} ${missingInventoryAssets.length === 1 ? "note" : "notes"}`;
  const lockedAssetText = assetListText(lockedOnlyAssets);
  const fundingWarningText = lockedOnlyAssets.length > 0
    ? `${lockedAssetText} ${lockedOnlyAssets.length === 1 ? "is" : "are"} locked in existing curves. Cancel or edit a curve, or deposit more ${lockedAssetText}.`
    : `No available ${missingInventoryText} for this quote. Deposit before quoting liquidity.`;
  const sideBandSets: Array<[CurveSide, CurvePoint[]]> = [
    [side, side === "bid" ? bidBands : askBands],
  ];
  const renewalHours = renewalHoursForPreset(renewalDuration, customRenewalDays);
  const renewalLabel = renewalWindowLabel(renewalDuration, renewalHours);
  const relayMode = relayModeForOperator(relayOperator);
  const normalizedSelfRelayEndpoint = normalizeSelfRelayUrl(selfRelayEndpoint);
  const localRelayTooLong = renewing && relayOperator === "LocalBrowser" && renewalHours > LOCAL_BROWSER_MAX_RENEWAL_HOURS;
  const selfHostedRelayMissing = renewing && relayOperator === "SelfHostedRelay" && !normalizedSelfRelayEndpoint;
  const fundingPreviewErrors = sideBandSets
    .map(([curveSide, bands]) => {
      const filledBands = bandRowsFilled(bands);
      if (!walletReady || filledBands.length < MIN_CURVE_BANDS || !onPreviewFunding) return null;
      try {
        onPreviewFunding({
          pairId: selectedPair.pair_id,
          side: sideFromCurveSide(curveSide),
          shape: "curve",
          stratKind: "TWAP",
          resting: renewing,
          amount: "",
          limitPrice: "",
          minFill: "",
          fillOrKill: false,
          curvePoints: filledBands,
          inventoryCap,
          durationHours: renewalHours.toString(),
          childSize: "",
          priceLimit: "",
          jitter: 0,
          relayMode: renewing ? relayMode : "SelfRelay",
          relayOperator: renewing ? relayOperator : "LocalBrowser",
          selfRelayUrl: relayOperator === "SelfHostedRelay" ? normalizedSelfRelayEndpoint : undefined,
        });
        return null;
      } catch (error) {
        return userFacingErrorMessage(error, "Funding preview unavailable.");
      }
    })
    .filter((message): message is string => Boolean(message));
  const canSubmit = walletReady &&
    !submitting &&
    !localRelayTooLong &&
    !selfHostedRelayMissing &&
    missingInventoryAssets.length === 0 &&
    fundingPreviewErrors.length === 0 &&
    sideBandSets.every(([, bands]) => bandRowsFilled(bands).length >= MIN_CURVE_BANDS);

  async function submit() {
    for (const [curveSide, bands] of sideBandSets) {
      const ok = await onSubmitCurve({
        pairId: selectedPair.pair_id,
        side: sideFromCurveSide(curveSide),
        shape: "curve",
        stratKind: "TWAP",
        resting: renewing,
        amount: "",
        limitPrice: "",
        minFill: "",
        fillOrKill: false,
        curvePoints: bandRowsFilled(bands),
        inventoryCap,
        durationHours: renewalHours.toString(),
        childSize: "",
        priceLimit: "",
        jitter: 0,
        relayMode: renewing ? relayMode : "SelfRelay",
        relayOperator: renewing ? relayOperator : "LocalBrowser",
        selfRelayUrl: relayOperator === "SelfHostedRelay" ? normalizedSelfRelayEndpoint : undefined,
      });
      if (ok === false) return;
    }
    setInventoryCap("");
    if (normalizedSelfRelayEndpoint) persistSelfRelayEndpoint(normalizedSelfRelayEndpoint);
  }

  return (
    <div className="workspace-page liquidity-page">
      <div className="liq-pair-workspace">
        <aside className="liq-pair-rail">
          <div className="liq-pair-rail-hd">Markets</div>
          {pairs.map(pair => {
            const pairRecords = records.filter(record => record.pair === pair.pair_id);
            const livePairRecords = activeCurveRecords(pairRecords);
            const bidCount = livePairRecords.filter(record => record.side === "Buy").length;
            const askCount = livePairRecords.filter(record => record.side === "Sell").length;
            return (
              <button
                type="button"
                key={pair.pair_id}
                className={`liq-pair-row ${pair.pair_id === selectedPair.pair_id ? "on" : ""}`}
                onClick={() => setActivePairId(pair.pair_id)}
              >
                <span className="liq-pair-row-name">{pair.pair_id}</span>
                <span className="liq-pair-row-sides">
                  <em className={bidCount > 0 ? "bid" : ""}>{bidCount > 0 ? `Bid ${bidCount}` : "No bid"}</em>
                  <em className={askCount > 0 ? "ask" : ""}>{askCount > 0 ? `Ask ${askCount}` : "No ask"}</em>
                </span>
              </button>
            );
          })}
        </aside>

        <main className="liq-pair-main">
          <header className="liq-pair-head">
            <div className="liq-pair-head-id">
              <span className="liq-pair-head-name">{selectedPair.pair_id}</span>
              <span className="liq-pair-head-status">
                {selectedPairRecords.length === 0 ? (
                  <span className="pill muted">No active curve</span>
                ) : selectedPairRecords.map(record => (
                  <span className={`pill ${curveStatusPillTone(record.status)}`} key={record.id}>
                    {record.sideLabel} {record.status}
                  </span>
                ))}
              </span>
            </div>
            <span className="liq-pair-head-clearing">{selectedPairClearing ?? "—"}</span>
          </header>

          <section className="liq-builder">
          <div className="liq-panel-hd">
            <span>Quote liquidity</span>
          </div>

          <div className="liq-inventory-strip" aria-label="Liquidity inventory">
            {builderInventoryAssets.map(asset => {
              const balance = balances.find(entry => entry.asset === asset);
              const pending = pendingDeposits
                .filter(deposit => deposit.asset === asset && !deposit.confirmed && !deposit.failed)
                .reduce((sum, deposit) => sum + BigInt(deposit.amount), 0n);
              return (
                <div key={asset} className="liq-inventory-cell">
                  <span>{asset}</span>
                  <strong>{balance ? fromAtomicStr(balance.available, asset) : "—"}</strong>
                  <em>available</em>
                  {balance && BigInt(balance.locked) > 0n && (
                    <small>{fromAtomicStr(balance.locked, asset)} locked</small>
                  )}
                  {pending > 0n && (
                    <small>{fromAtomicStr(pending.toString(), asset)} pending</small>
                  )}
                </div>
              );
            })}
          </div>

          <div className="liq-side-segment" aria-label="Curve side">
            {([
              ["bid", "Bid Curve"],
              ["ask", "Ask Curve"],
            ] as Array<[CurveSide, string]>).map(([value, label]) => (
              <button key={value} className={side === value ? "on" : ""} onClick={() => setSide(value)}>{label}</button>
            ))}
          </div>
          {walletReady && missingInventoryAssets.length > 0 && (
            <div className="wc-note warn liq-funding-warning">
              <span>{fundingWarningText}</span>
              <button type="button" onClick={() => onDeposit(missingInventoryAssets[0])}>Deposit</button>
            </div>
          )}

          <CurveBandEditor
            title={`${side === "bid" ? "Bid" : "Ask"} bands`}
            quote={quote}
            base={base}
            bands={side === "bid" ? bidBands : askBands}
            onBands={side === "bid" ? setBidBands : setAskBands}
          />

          <button className="adv-toggle liq-adv" onClick={() => setAdvanced(value => !value)}>
            <span>Advanced</span>
            <strong>{advanced ? "⌃" : "⌄"}</strong>
          </button>
          {advanced && (
            <div className="liq-advanced-grid">
              <div className="curve-risk-field">
                <label className="f-label">Inventory cap</label>
                <div className="f-input-box" style={{ height: 34 }}>
                  <input className="f-input" type="text" inputMode="decimal" placeholder="0" value={inventoryCap} onChange={event => setInventoryCap(event.target.value)} />
                  <span className="f-unit">{base}</span>
                </div>
              </div>
              <div className="curve-risk-field">
                <label className="f-label">Renewal window</label>
                <select
                  className="liq-select compact"
                  value={renewalDuration}
                  onChange={event => setRenewalDuration(event.target.value as RenewalDurationPreset)}
                >
                  {RENEWAL_DURATION_OPTIONS.map(option => (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={relayOperator === "LocalBrowser" && option.relayOnly}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              {renewalDuration === "custom" && (
                <div className="curve-risk-field">
                  <label className="f-label">Custom days</label>
                  <div className="f-input-box" style={{ height: 34 }}>
                    <input
                      className="f-input"
                      type="text"
                      inputMode="decimal"
                      placeholder="30"
                      value={customRenewalDays}
                      onChange={event => setCustomRenewalDays(event.target.value)}
                    />
                    <span className="f-unit">days</span>
                  </div>
                </div>
              )}
              <div className="curve-risk-field">
                <label className="f-label">Renewal operator</label>
                <select
                  className="liq-select compact"
                  value={relayOperator}
                  onChange={event => {
                    const next = event.target.value as RelayOperator;
                    setRelayOperator(next);
                    if (next === "LocalBrowser" && renewalHours > LOCAL_BROWSER_MAX_RENEWAL_HOURS) {
                      setRenewalDuration("1");
                    }
                  }}
                >
                  <option value="ZylithRelay">Zylith Relay</option>
                  <option value="SelfHostedRelay">Self Relay</option>
                  <option value="LocalBrowser">Local browser</option>
                </select>
              </div>
              {relayOperator === "SelfHostedRelay" && (
                <div className="curve-risk-field liq-self-relay-field">
                  <label className="f-label">Self Relay endpoint</label>
                  <div className="f-input-box" style={{ height: 34 }}>
                    <input
                      className="f-input"
                      type="url"
                      placeholder="https://relay.example.com"
                      value={selfRelayEndpoint}
                      onChange={event => setSelfRelayEndpoint(event.target.value)}
                      onBlur={() => {
                        const normalized = normalizeSelfRelayUrl(selfRelayEndpoint);
                        if (normalized) {
                          setSelfRelayEndpoint(normalized);
                          persistSelfRelayEndpoint(normalized);
                        }
                      }}
                    />
                  </div>
                </div>
              )}
              <label className="f-check liq-renew-check">
                <input type="checkbox" checked={renewing} onChange={event => setRenewing(event.target.checked)} />
                Renew each epoch
              </label>
            </div>
          )}

          <CurvePreview
            pair={selectedPair}
            side={side}
            bidBands={bidBands}
            askBands={askBands}
            inventoryCap={inventoryCap}
            renewing={renewing}
            renewalWindowHours={renewalHours.toString()}
            renewalWindowLabelText={renewalLabel}
            relayMode={relayMode}
            relayOperator={relayOperator}
            selfRelayUrl={normalizedSelfRelayEndpoint}
            onPreviewFunding={onPreviewFunding}
          />
          {renewing && (localRelayTooLong || selfHostedRelayMissing) && (
            <div className={`wc-note ${localRelayTooLong || selfHostedRelayMissing ? "warn" : ""}`}>
              {relayOperator === "LocalBrowser"
                ? "Local browser renewal is capped at 1h and stops if this tab closes or the machine sleeps."
                : "Enter a valid HTTPS Self Relay endpoint before activating this curve."}
            </div>
          )}
          {submitError && <div className="wc-note warn">{submitError}</div>}
          <button className="submit-btn curve-cta" disabled={!canSubmit} onClick={() => { void submit(); }}>
            {submitting ? "Submitting..." : curveCtaLabel(side)}
          </button>
        </section>
        </main>

        <section className="liq-execution-rail liq-active-curves">
          <div className="liq-panel-hd">
            <span>Active curves</span>
            <em>{activeCurveRecords(records).length} running</em>
          </div>
          {activeCurveRecords(records).length === 0 ? (
            <div className="empty-zone liq-empty-zone">
              <div className="empty-mark">—</div>
            </div>
          ) : (
            activeCurveRecords(records).map(record => (
              <div className="liq-active-card" key={record.id}>
                <div className="liq-active-top">
                  <span>{record.pair}</span>
                  <span className={`side ${record.side === "Buy" ? "buy" : "sell"}`}>{record.sideLabel}</span>
                  <span className={`pill ${curveStatusPillTone(record.status)}`}>{record.status}</span>
                </div>
                <div className="liq-active-rate">{formatPct(curveFillRate(record.relatedOrders))}</div>
                <div className="liq-depth-bar">
                  <span style={{ width: `${Math.min(100, committedDepth(record.points, record.relatedOrders) > 0 ? (depthFilled(record.relatedOrders) / committedDepth(record.points, record.relatedOrders)) * 100 : 0)}%` }} />
                </div>
                <table className="data-table liq-band-table">
                  <thead>
                    <tr>
                      <th>Band</th>
                      <th>Depth</th>
                      <th>Filled</th>
                      <th>Fill rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let fallbackRemaining = depthFilled(record.relatedOrders);
                      return record.points.map((point, index) => {
                        const depth = parseHuman(point.baseAmount);
                        const filled = displayedBandFill(record, index, fallbackRemaining);
                        fallbackRemaining = Math.max(0, fallbackRemaining - filled);
                        return (
                          <tr key={`${record.id}:${index}`}>
                            <td className="num">{point.price}</td>
                            <td className="num">{point.baseAmount}</td>
                            <td className="num">{formatHuman(filled)}</td>
                            <td>
                              <div className="liq-mini-bar">
                                <span style={{ width: `${Math.min(100, depth > 0 ? (filled / depth) * 100 : 0)}%` }} />
                              </div>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
                <div className="liq-card-actions">
                  {record.strategy && (
                    record.status === "Paused"
                      ? <button type="button" onClick={() => onResumeCurve(record)}>Resume</button>
                      : <button type="button" onClick={() => onPauseCurve(record)}>Pause</button>
                  )}
                  <button type="button" onClick={() => onEditCurve(record)}>Edit</button>
                  <button type="button" className="danger" onClick={() => onCancelCurve(record)}>Cancel</button>
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

export function LiquidityOrdersScreen({
  records,
  batches,
  onCancelCurve,
}: {
  records: LiquidityCurveRecord[];
  batches: BatchSummary[];
  onCancelCurve: (record: LiquidityCurveRecord) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<"active" | "history">("active");
  const batchStatus = new Map(batches.map(batch => [batch.batch_id, batch.status]));
  const parents = records.filter(record => record.strategy || record.relatedOrders.length > 0);
  const displayedParents = filter === "active"
    ? parents.filter(record => activeCurveRecords([record]).length > 0)
    : parents.filter(record => activeCurveRecords([record]).length === 0);

  return (
    <div className="workspace-page liquidity-page">
      <div className="page-hd">
        <div className="page-title-block"><span className="page-title">ORDERS</span></div>
      </div>
      {parents.length > 0 && (
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
      <div className="liq-sections">
        {displayedParents.length === 0 ? (
          <div className="empty-zone">
            <div className="empty-mark">—</div>
            <div className="empty-body">
              {parents.length === 0
                ? "Child orders appear after a curve is activated."
                : filter === "active"
                  ? "No active maker orders."
                  : "No maker order history yet."}
            </div>
          </div>
        ) : (
          <div className="table-zone liquidity-orders-table-zone">
            <table className="data-table liquidity-orders-table">
              <thead>
                <tr>
                  <th style={{ width: 2 }} />
                  <th>Ref</th>
                  <th>Pair</th>
                  <th>Side</th>
                  <th>Bands</th>
                  <th>Depth</th>
                  <th>Avg price</th>
                  <th>Children</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th style={{ width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {displayedParents.map((record, index) => {
                  const expanded = open[record.id] ?? index === 0;
                  const outcomes = curveEpochOutcomes(record, batchStatus);
                  const submitted = outcomes.length;
                  const scheduled = Math.max(record.strategy?.max_children ?? record.maxChildren ?? submitted, submitted);
                  const remaining = Math.max(0, scheduled - submitted);
                  const depth = committedDepth(record.points, record.relatedOrders);
                  const bands = record.points.length || record.strategy?.maker_curve_points?.length || "—";
                  const toggle = () => setOpen(previous => ({ ...previous, [record.id]: !expanded }));
                  return (
                    <Fragment key={record.id}>
                      <tr
                        className={`parent-row liquidity-order-parent-row ${expanded ? "open" : ""}`}
                        onClick={toggle}
                      >
                        <td className="side-bar-cell">
                          <span style={{ background: record.side === "Buy" ? "var(--z-buy)" : "var(--z-sell)" }} />
                        </td>
                        <td className="ref">{curveDisplayRef(record)}</td>
                        <td>{record.pair}</td>
                        <td>
                          <span className={`side ${record.side === "Buy" ? "buy" : "sell"}`}>
                            {record.sideLabel}
                          </span>
                        </td>
                        <td className="num">{bands}</td>
                        <td className="num">{formatHuman(depth, curveBaseAsset(record))}</td>
                        <td className="num">{averageCurvePrice(record)}</td>
                        <td className="num">{submitted}/{scheduled} · {remaining} left</td>
                        <td><span className={`pill ${curveStatusPillTone(record.status)}`}>{record.status}</span></td>
                        <td>{fmtTime(record.submittedAt)}</td>
                        <td className="disclosure-cell">
                          <button
                            type="button"
                            className={`disclosure ${expanded ? "open" : "muted"}`}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "Collapse" : "Expand"} ${record.pair} curve child orders`}
                            onClick={event => {
                              event.stopPropagation();
                              toggle();
                            }}
                          >
                            ▾
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <CurveChildTimeline
                          record={record}
                          outcomes={outcomes}
                          submitted={submitted}
                          scheduled={scheduled}
                          onCancelCurve={onCancelCurve}
                        />
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function LiquidityInventoryScreen({
  records,
  balances,
  pendingDeposits,
  withdrawableNotes,
  activeEpochId,
  onDeposit,
  onWithdraw,
}: {
  records: LiquidityCurveRecord[];
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  withdrawableNotes: WithdrawableNote[];
  activeEpochId: number | null;
  onDeposit: (asset?: string) => void;
  onWithdraw: (asset?: string) => void;
}) {
  const activeRecords = activeCurveRecords(records);
  if (activeRecords.length === 0) {
    return (
      <div className="workspace-page liquidity-page">
        <div className="page-hd">
          <div className="page-title-block"><span className="page-title">INVENTORY</span></div>
        </div>
        <div className="table-zone">
          <div className="empty-zone">
            <div className="empty-mark">—</div>
            <div className="empty-body">Inventory tracking begins when you activate a curve.</div>
          </div>
        </div>
      </div>
    );
  }

  const assets = Array.from(new Set([
    ...balances.map(balance => balance.asset),
    ...pendingDeposits.map(deposit => deposit.asset),
    ...withdrawableNotes.map(note => note.asset),
    ...activeRecords.flatMap(record => record.pair.split("/")),
  ])).filter(Boolean);

  function lockedInCurves(asset: string): number {
    return activeRecords
      .filter(record => record.status === "Active" || record.status === "Expiring")
      .filter(record => curveFundingAsset(record) === asset)
      .reduce((sum, record) => sum + curveLockedCapital(record), 0);
  }

  return (
    <div className="workspace-page liquidity-page">
      <div className="page-hd">
        <div className="page-title-block"><span className="page-title">INVENTORY</span></div>
        <div className="page-actions">
          <button className="btn-ghost" onClick={() => onDeposit()}>Deposit</button>
          <button className="btn-ghost" onClick={() => onWithdraw()}>Withdraw</button>
        </div>
      </div>

      <div className="table-zone liq-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
                <th>Asset</th>
                <th>Available</th>
                <th>Locked in curves</th>
                <th>Observed capacity</th>
                <th>Current epoch exposure</th>
                <th>Current utilization</th>
            </tr>
          </thead>
          <tbody>
            {assets.map(asset => {
              const balance = balances.find(entry => entry.asset === asset);
              const locked = lockedInCurves(asset);
              const exposure = activeRecords
                .flatMap(record => record.relatedOrders)
                .filter(order => order.epochId === activeEpochId)
                .reduce((sum, order) => sum + orderFundingExposure(order, asset), 0);
              const cap = Math.max(locked, exposure);
              const pct = cap > 0 ? (exposure / cap) * 100 : 0;
              return (
                <tr key={asset}>
                  <td className="ref">{asset}</td>
                  <td className="num">{balance ? fromAtomicStr(balance.available, asset) : "—"}</td>
                  <td className="num">{formatHuman(locked)}</td>
                  <td className="num">{formatHuman(cap)}</td>
                  <td className="num">{formatHuman(exposure)}</td>
                  <td>
                    <div className={`liq-cap-bar ${pct > 85 ? "danger" : pct > 65 ? "warn" : ""}`}>
                      <span style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <section className="liq-section-spaced">
          <div className="asset-section-hd">
            <h2>Pair exposure</h2>
            <span>{activeRecords.length} curves</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th>Side</th>
                <th>Total depth</th>
                <th>Current epoch fill</th>
                <th>Committed depth</th>
                <th>Current utilization</th>
              </tr>
            </thead>
            <tbody>
              {activeRecords.map(record => {
                const total = committedDepth(record.points, record.relatedOrders);
                const current = record.relatedOrders.filter(order => order.epochId === activeEpochId).reduce((sum, order) => sum + orderFilled(order), 0);
                return (
                  <tr key={record.id}>
                    <td>{record.pair}</td>
                    <td><span className={`side ${record.side === "Buy" ? "buy" : "sell"}`}>{record.sideLabel}</span></td>
                    <td className="num">{formatHuman(total)}</td>
                    <td className="num">{formatHuman(current)}</td>
                    <td className="num">{formatHuman(total)}</td>
                    <td><div className="liq-cap-bar"><span style={{ width: `${Math.min(100, total > 0 ? (current / total) * 100 : 0)}%` }} /></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="liq-section-spaced">
          <div className="asset-section-hd">
            <h2>Locked notes</h2>
            <span>Capital fragmentation by curve</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Note size</th>
                <th>Asset</th>
                <th>Locked in</th>
                <th>Epoch locked</th>
              </tr>
            </thead>
            <tbody>
              {activeRecords.flatMap(record => record.relatedOrders.filter(activeStatuses).map(order => (
                <tr key={`${record.id}:${order.ordRef}`}>
                  <td className="num">{order.fundingAmount ?? order.amount}</td>
                  <td>{order.fundingAsset ?? (order.side === "Buy" ? order.pair.split("/")[1] : order.pair.split("/")[0])}</td>
                  <td>{record.pair} · {record.sideLabel}</td>
                  <td className="num">Epoch {order.epochId}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

type LiquidityAnalyticsEpoch = {
  epoch: number;
  barValue: number;
  fillRate: number;
  filled: number;
  total: number;
};

type LiquidityAnalyticsChartMode = "notional" | "fills";

function buildLiquidityEpochSeries(
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

function visibleLiquidityEpochSeries(series: LiquidityAnalyticsEpoch[], windowSize = 30): LiquidityAnalyticsEpoch[] {
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

function LiquidityEpochTrend({
  series,
  chartMode,
  quoteAsset,
}: {
  series: LiquidityAnalyticsEpoch[];
  chartMode: LiquidityAnalyticsChartMode;
  quoteAsset: string | null;
}) {
  const visible = series.slice(-30);
  const maxVisibleBar = Math.max(1, ...visible.map(point => point.barValue));
  const positiveBars = visible.map(point => point.barValue).filter(value => value > 0).sort((a, b) => a - b);
  const minPositiveBar = positiveBars[0] ?? 0;
  const highBarThreshold = positiveBars[Math.max(0, Math.floor(positiveBars.length * 0.8))] ?? Number.POSITIVE_INFINITY;
  const linePoints = visible.map((point, index) => {
    const x = ((index + 0.5) / visible.length) * 100;
    const y = 100 - point.fillRate;
    return `${x.toFixed(2)},${Math.max(0, Math.min(100, y)).toFixed(2)}`;
  }).join(" ");

  if (series.length === 0) {
    return (
      <div className="an-chart empty" aria-label="No epoch trend data">
        <span>—</span>
      </div>
    );
  }

  return (
    <div
      className="an-chart"
      aria-label={chartMode === "notional" ? "Matched volume columns and fill-rate line" : "Filled-child columns and fill-rate line"}
    >
      {visible.map(point => (
        <div
          key={point.epoch}
          className="an-col"
          title={chartMode === "notional"
            ? `Epoch ${point.epoch}: ${formatCompactHuman(point.barValue, quoteAsset ?? "")} matched · ${formatPct(point.fillRate)} fill`
            : `Epoch ${point.epoch}: ${point.filled}/${point.total} children filled · ${formatPct(point.fillRate)} fill`}
        >
          <div
            className={`an-col-bar ${point.fillRate >= 80 && maxVisibleBar > minPositiveBar && point.barValue >= highBarThreshold ? "hi" : ""}`}
            style={{ height: `${Math.max(2, (point.barValue / maxVisibleBar) * 100)}%` }}
          />
        </div>
      ))}
      <svg className="an-chart-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline
          points={linePoints}
          fill="none"
          stroke="var(--z-status-good)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
          opacity="0.85"
        />
      </svg>
    </div>
  );
}

function LiquidityUtilBars({ values }: { values: number[] }) {
  if (values.length === 0) return <span className="an-util empty">—</span>;
  return (
    <span className="an-util" aria-label="Band utilization">
      {values.map((value, index) => (
        <span className="an-util-bar" key={index}>
          <span style={{ height: `${Math.max(4, Math.min(100, value))}%` }} />
        </span>
      ))}
    </span>
  );
}

export function LiquidityAnalyticsScreen({
  records,
  settlementTranscripts,
}: {
  records: LiquidityCurveRecord[];
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
}) {
  const [period, setPeriod] = useState<Period>("30d");
  const cutoff = period === "all" ? 0 : Date.now() - ({ "7d": 7, "30d": 30, "90d": 90 }[period] * 24 * 60 * 60 * 1000);
  const periodRecords = records.map(record => ({
    ...record,
    relatedOrders: record.relatedOrders.filter(order => order.submittedAt >= cutoff),
  })).filter(record => record.relatedOrders.length > 0 || record.status !== "Historical");
  const activityRecords = periodRecords.map(record => ({
    ...record,
    relatedOrders: record.relatedOrders.filter(settlementConfirmed),
  })).filter(record => record.relatedOrders.length > 0);
  const epochRows = activityRecords.flatMap(record => record.relatedOrders.map(order => ({
    record,
    order,
    transcript: settlementTranscripts[order.batchId],
  })));
  const terminalOrders = epochRows.map(row => row.order);
  const quoteAssets = new Set(activityRecords.map(curveQuoteAsset).filter(Boolean));
  const quoteAsset = quoteAssets.size === 1 ? [...quoteAssets][0] : null;
  const chartMode: LiquidityAnalyticsChartMode = quoteAsset ? "notional" : "fills";
  const epochSeries = buildLiquidityEpochSeries(epochRows, chartMode);
  const chartSeries = visibleLiquidityEpochSeries(epochSeries);
  const matchedNotional = quoteAsset
    ? epochRows.reduce((sum, row) => sum + orderQuoteNotional(row.order, row.transcript), 0)
    : Number.NaN;
  const filledOrders = terminalOrders.filter(terminalFill).length;
  const blendedFillRate = terminalOrders.length > 0 ? (filledOrders / terminalOrders.length) * 100 : Number.NaN;
  const captureBps = weightedMakerCaptureBps(terminalOrders);
  const activeMarkets = new Set(activityRecords.map(record => record.pair)).size;
  const rolledPct = records.length > 0 ? (records.filter(record => record.strategy).length / records.length) * 100 : Number.NaN;
  const marketGroups = new Map<string, {
    pair: string;
    sides: Set<LiquidityCurveRecord["side"]>;
    orders: LocalOrder[];
    utilization: number[];
  }>();
  for (const record of activityRecords) {
    const filled = depthFilled(record.relatedOrders);
    let fallbackRemaining = filled;
    const utilization = record.points.map((point, index) => {
      const depth = parseHuman(point.baseAmount);
      const bandFilled = displayedBandFill(record, index, fallbackRemaining);
      fallbackRemaining = Math.max(0, fallbackRemaining - bandFilled);
      return depth > 0 ? Math.min(100, (bandFilled / depth) * 100) : 0;
    });
    const current = marketGroups.get(record.pair) ?? {
      pair: record.pair,
      sides: new Set<LiquidityCurveRecord["side"]>(),
      orders: [],
      utilization: [],
    };
    current.sides.add(record.side);
    current.orders.push(...record.relatedOrders);
    current.utilization.push(...utilization);
    marketGroups.set(record.pair, current);
  }
  const marketRows = [...marketGroups.values()].map(group => {
    const quote = group.pair.split("/")[1] ?? "";
    return {
      pair: group.pair,
      quote,
      sides: group.sides,
      fillRate: curveFillRate(group.orders),
      avgClearing: weightedAverageClearing(group.orders),
      capture: weightedMakerCaptureBps(group.orders),
      notional: group.orders.reduce((sum, order) => sum + orderQuoteNotional(order, settlementTranscripts[order.batchId]), 0),
      utilization: group.utilization.slice(0, 8),
    };
  }).sort((a, b) => b.notional - a.notional || a.pair.localeCompare(b.pair));
  const periodLabel = period === "all" ? "ALL" : period.toUpperCase();

  return (
    <div className="workspace-page liquidity-page">
      <div className="page-hd">
        <div className="page-title-block">
          <span className="page-eyebrow">Liquidity</span>
          <span className="page-title">ANALYTICS</span>
        </div>
        <div className="tca-filter">
          {(["7d", "30d", "90d", "all"] as Period[]).map(value => (
            <button key={value} className={`filter-chip ${period === value ? "on" : ""}`} onClick={() => setPeriod(value)}>
              {value === "all" ? "All" : value}
            </button>
          ))}
        </div>
      </div>

      {epochRows.length === 0 && (
        <div className="table-zone">
          <div className="empty-zone">
            <div className="empty-mark">—</div>
            <div className="empty-body">Analytics populate after curves have been active and children have settled.</div>
          </div>
        </div>
      )}

      {epochRows.length > 0 && (
        <>
          <div className="an-kpis">
            <div className="an-kpi">
              <span className="an-kpi-k">Volume matched</span>
              <strong className="an-kpi-v">{quoteAsset ? formatCompactHuman(matchedNotional, quoteAsset) : "By market"}</strong>
              <span className="an-kpi-d flat">{quoteAsset ? "Quote-notional estimate" : "Mixed quote assets"}</span>
            </div>
            <div className="an-kpi">
              <span className="an-kpi-k">Blended fill rate</span>
              <strong className="an-kpi-v">{formatPct(blendedFillRate)}</strong>
              <span className={filledOrders > 0 ? "an-kpi-d up" : "an-kpi-d flat"}>{filledOrders}/{terminalOrders.length} settled children</span>
            </div>
            <div className="an-kpi">
              <span className="an-kpi-k">Spread capture</span>
              <strong className="an-kpi-v">{formatBps(captureBps)}</strong>
              <span className={Number.isFinite(captureBps) && captureBps < 0 ? "an-kpi-d down" : "an-kpi-d up"}>Clearing vs maker limit</span>
            </div>
            <div className="an-kpi">
              <span className="an-kpi-k">Epochs cleared</span>
              <strong className="an-kpi-v">{epochSeries.length.toLocaleString("en-US")}</strong>
              <span className="an-kpi-d flat">· {periodLabel}</span>
            </div>
            <div className="an-kpi">
              <span className="an-kpi-k">Active markets</span>
              <strong className="an-kpi-v">{activeMarkets.toLocaleString("en-US")}</strong>
              <span className="an-kpi-d flat">· {formatPct(rolledPct)} renewed</span>
            </div>
          </div>

          <div className="an-body">
            <section className="an-chart-zone">
              <div className="an-sec-hd">
                <span>Execution over epochs</span>
                <div className="an-chart-legend" aria-hidden="true">
                  <span><i className="vol" />{chartMode === "notional" ? "Matched volume" : "Filled children"}</span>
                  <span><i className="fill" />Fill rate</span>
                </div>
              </div>
              <LiquidityEpochTrend series={chartSeries} chartMode={chartMode} quoteAsset={quoteAsset} />
              <div className="an-chart-axis">
                <span>{chartSeries[0] ? `Epoch ${chartSeries[0].epoch}` : "—"}</span>
                <span>{Math.min(30, chartSeries.length)} epochs</span>
                <span>{chartSeries.at(-1) ? `Epoch ${chartSeries.at(-1)?.epoch}` : "—"}</span>
              </div>
            </section>

            <aside className="an-side-zone">
              <div className="an-sec-hd">
                <span>Spread capture</span>
              </div>
              <strong className="an-cap-big">{formatBps(captureBps)}</strong>
              <p className="an-cap-sub">Weighted clearing improvement against maker limits across filled children.</p>
              <div className="an-cap-rows">
                <div className="an-cap-row"><span className="k">Volume matched</span><span className="v">{quoteAsset ? formatCompactHuman(matchedNotional, quoteAsset) : "By market"}</span></div>
                <div className="an-cap-row"><span className="k">Blended fill</span><span className="v">{formatPct(blendedFillRate)}</span></div>
                <div className="an-cap-row"><span className="k">Epochs</span><span className="v">{epochSeries.length.toLocaleString("en-US")}</span></div>
                <div className="an-cap-row"><span className="k">Rolled</span><span className="v">{formatPct(rolledPct)}</span></div>
              </div>
            </aside>
          </div>

          <section className="an-market-section">
            <div className="an-market-hd">
              <div className="an-sec-hd">
                <span>By market</span>
                <em>{marketRows.length} markets · {periodLabel}</em>
              </div>
            </div>
            <div className="an-markets">
              <div className="an-mkt-hdr" role="row">
                <span>Market</span>
                <span>Quoting</span>
                <span>Fill rate</span>
                <span>Volume</span>
                <span>Avg clearing</span>
                <span>Band util · capture</span>
              </div>
              {marketRows.map(({ pair, quote, sides, fillRate, notional, avgClearing, capture, utilization }) => (
                <div className="an-mkt-row" role="row" key={pair}>
                  <span className="an-mkt-name">{pair}</span>
                  <span className="an-mkt-sides">
                    {(["Buy", "Sell"] as const).map(side => (
                      <span
                        className={`pp-sidechip ${side === "Buy" ? "bid" : "ask"} ${sides.has(side) ? "" : "none"}`}
                        key={side}
                      >
                        {side === "Buy" ? "Bid" : "Ask"}
                      </span>
                    ))}
                  </span>
                  <span className="an-mkt-fill">
                    <strong className="pctv">{formatPct(fillRate)}</strong>
                    <span className="liq-mini-bar"><span style={{ width: `${Math.min(100, fillRate)}%` }} /></span>
                  </span>
                  <span className="an-mkt-num">{formatCompactHuman(notional, quote)}</span>
                  <span className="an-mkt-num">{avgClearing}</span>
                  <span className="an-mkt-tail">
                    <LiquidityUtilBars values={utilization} />
                    <strong className={`an-cap-bps ${Number.isFinite(capture) && capture >= 0 ? "pos" : "neg"}`}>{formatBps(capture)}</strong>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function LiquidityWorkspace({
  tab,
  pairs,
  activePairId,
  setActivePairId,
  orders,
  strategies,
  batches,
  balances,
  pendingDeposits,
  withdrawableNotes,
  settlementTranscripts,
  walletReady,
  submitting,
  submitError,
  onPreviewFunding,
  onSubmitCurve,
  onCancelOrder,
  onCancelStrategy,
  onPauseStrategy,
  onResumeStrategy,
  onDeposit,
  onWithdraw,
  onNavigateCurves,
}: {
  tab: LiquidityPageTab;
  pairs: PairConfig[];
  activePairId: string;
  setActivePairId: (pairId: string) => void;
  orders: LocalOrder[];
  strategies: PrivateStrategySummary[];
  batches: BatchSummary[];
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  withdrawableNotes: WithdrawableNote[];
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  walletReady: boolean;
  submitting: boolean;
  submitError: string | null;
  onPreviewFunding?: (intent: TicketSubmitIntent) => FundingPreview | null;
  onSubmitCurve: (intent: TicketSubmitIntent) => Promise<boolean | void>;
  onCancelOrder: (order: LocalOrder) => void;
  onCancelStrategy: (strategyId: string) => Promise<void>;
  onPauseStrategy: (strategyId: string) => Promise<void>;
  onResumeStrategy: (strategyId: string) => Promise<void>;
  onDeposit: (asset?: string) => void;
  onWithdraw: (asset?: string) => void;
  onNavigateCurves: () => void;
}) {
  const [editRecord, setEditRecord] = useState<LiquidityCurveRecord | null>(null);
  const records = useMemo(() => buildCurveRecords(orders, strategies, pairs), [orders, pairs, strategies]);
  const activeEpochId = batches.reduce<number | null>((latest, batch) => latest === null ? batch.epoch_id : Math.max(latest, batch.epoch_id), null);

  function cancelCurve(record: LiquidityCurveRecord) {
    if (record.strategy) {
      void onCancelStrategy(record.strategy.id);
      return;
    }
    const firstActive = record.relatedOrders.find(order => activeStatuses(order)) ?? record.relatedOrders[0];
    if (firstActive) onCancelOrder(firstActive);
  }

  async function pauseCurve(record: LiquidityCurveRecord) {
    if (!record.strategy) return;
    await onPauseStrategy(record.strategy.id);
  }

  async function resumeCurve(record: LiquidityCurveRecord) {
    if (!record.strategy) return;
    await onResumeStrategy(record.strategy.id);
  }

  function editCurve(record: LiquidityCurveRecord) {
    if (record.strategy && record.status !== "Paused") {
      void pauseCurve(record);
    }
    setEditRecord(record);
    onNavigateCurves();
  }

  if (!walletReady) {
    return (
      <div className="workspace-page liquidity-page">
        <div className="page-hd"><span className="page-title">{liquidityPageTitle(tab)}</span></div>
        <div className="table-zone">
          <div className="empty-zone">
            <div className="empty-mark">—</div>
            <div className="empty-body">Sign in to manage liquidity.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Fragment>
      {tab === "curves" && (
        <LiquidityCurvesScreen
          pairs={pairs}
          records={records}
          balances={balances}
          pendingDeposits={pendingDeposits}
          activePairId={activePairId}
          setActivePairId={setActivePairId}
          walletReady={walletReady}
          submitting={submitting}
          submitError={submitError}
          onPreviewFunding={onPreviewFunding}
          onSubmitCurve={onSubmitCurve}
          onCancelCurve={cancelCurve}
          onEditCurve={editCurve}
          onPauseCurve={record => { void pauseCurve(record); }}
          onResumeCurve={record => { void resumeCurve(record); }}
          onDeposit={onDeposit}
          editRecord={editRecord}
          onEditConsumed={() => setEditRecord(null)}
        />
      )}
      {tab === "orders" && (
        <LiquidityOrdersScreen
          records={records}
          batches={batches}
          onCancelCurve={cancelCurve}
        />
      )}
      {tab === "inventory" && (
        <LiquidityInventoryScreen
          records={records}
          balances={balances}
          pendingDeposits={pendingDeposits}
          withdrawableNotes={withdrawableNotes}
          activeEpochId={activeEpochId}
          onDeposit={onDeposit}
          onWithdraw={onWithdraw}
        />
      )}
      {tab === "analytics" && (
        <LiquidityAnalyticsScreen records={records} settlementTranscripts={settlementTranscripts} />
      )}
    </Fragment>
  );
}
