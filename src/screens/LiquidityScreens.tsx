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
import { userFacingErrorMessage } from "../domain/userFacingErrors";

type CurveSide = "bid" | "ask" | "two-sided";
type Period = "7d" | "30d" | "90d" | "all";
type LiquidityPageTab = "curves" | "orders" | "inventory" | "analytics";
type RenewalDurationPreset = "1" | "4" | "12" | "24" | "720" | "2160" | "continuous" | "custom";
const MIN_CURVE_BANDS = 3;
const LOCAL_BROWSER_MAX_RENEWAL_HOURS = 1;
const MAX_RELAY_RENEWAL_DAYS = 90;
const CONTINUOUS_ROLLING_WINDOW_HOURS = MAX_RELAY_RENEWAL_DAYS * 24;

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
  status: "Active" | "Paused" | "Expiring" | "Cancelled" | "Historical";
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
    if (strategy.status === "pending_relay") continue;
    const pair = pairs.find(candidate => candidate.pair_id === strategy.pair);
    const relatedOrders = orders.filter(order => order.strategyId === strategy.id);
    for (const order of relatedOrders) consumedOrderRefs.add(order.ordRef);
    const active = strategy.status === "active" || strategy.status === "delegated";
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
  return records.filter(record => record.status === "Active" || record.status === "Expiring" || record.status === "Paused");
}

function renewalPackageStatus(record: LiquidityCurveRecord): {
  label: string;
  detail: string;
  tone: "info" | "warn" | "good";
} {
  const strategy = record.strategy;
  const renewalPackage = strategy?.offline_package;
  if (!strategy || !renewalPackage) {
    return {
      label: "No package",
      detail: "Refresh to prepare the next renewal window.",
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
      label: "Package confirmed",
      detail: "Renewal root observed through a settled child.",
      tone: "good",
    };
  }
  if (hasSubmittedChild) {
    return {
      label: "Package pending",
      detail: "Child submitted; root confirmation waits for settlement.",
      tone: "info",
    };
  }
  return {
    label: "Package pending",
    detail: "Prepared locally; relay submission and child settlement confirm it.",
    tone: "warn",
  };
}

function renewalPackageSlotsRemaining(record: LiquidityCurveRecord): number {
  const renewalPackage = record.strategy?.offline_package;
  if (!record.strategy) return 0;
  if (!renewalPackage) {
    return Math.max(0, record.strategy.max_children - record.strategy.next_child_index + 1);
  }
  return record.strategy.submitted_children.filter(child =>
    child.epoch_id >= renewalPackage.start_epoch &&
    child.epoch_id <= renewalPackage.end_epoch &&
    child.submitted_at_unix_ms <= 0,
  ).length;
}

function sideFromCurveSide(side: Exclude<CurveSide, "two-sided">): "Buy" | "Sell" {
  return side === "bid" ? "Buy" : "Sell";
}

function curveCtaLabel(side: CurveSide): string {
  if (side === "bid") return "Activate bid curve";
  if (side === "ask") return "Activate ask curve";
  return "Activate two-sided curve";
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
  onPreviewFunding?: (intent: TicketSubmitIntent) => FundingPreview | null;
}) {
  const activeBandSets = side === "two-sided"
    ? [bidBands, askBands]
    : [side === "bid" ? bidBands : askBands];
  const filledBands = activeBandSets.flatMap(bandRowsFilled);
  const totalDepth = filledBands.reduce((sum, band) => sum + parseHuman(band.baseAmount), 0);
  const prices = filledBands.map(band => parseHuman(band.price)).filter(value => value > 0);
  const threshold = fromAtomicStr(pair.min_order_amount, pair.base_asset_id);
  const thresholdNumber = parseHuman(threshold);
  const eligible = totalDepth >= thresholdNumber && filledBands.length >= MIN_CURVE_BANDS;
  let preview: FundingPreview | null = null;
  let previewError: string | null = null;
  if (filledBands.length > 0 && side !== "two-sided" && onPreviewFunding) {
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
            ? "Batch has enough participation to protect privacy."
            : "Waiting for more participants before this batch can clear privately."}
        >
          {eligible ? "Privacy gate passing" : "Privacy gate pending"}
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
  const [renewalDuration, setRenewalDuration] = useState<RenewalDurationPreset>("24");
  const [customRenewalDays, setCustomRenewalDays] = useState("30");
  const [relayMode, setRelayMode] = useState<"SelfRelay" | "ZylithRelay">("ZylithRelay");

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
    setRelayMode(record.strategy?.offline_package?.relay_mode ?? "ZylithRelay");
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
  const builderInventoryAssets = Array.from(new Set([base, quote]));
  const neededInventoryAssets = side === "bid" ? [quote] : side === "ask" ? [base] : [base, quote];
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
  const sideBandSets: Array<[Exclude<CurveSide, "two-sided">, CurvePoint[]]> = side === "two-sided"
    ? [
        ["bid", bidBands],
        ["ask", askBands],
      ]
    : [[side, side === "bid" ? bidBands : askBands] as [Exclude<CurveSide, "two-sided">, CurvePoint[]]];
  const renewalHours = renewalHoursForPreset(renewalDuration, customRenewalDays);
  const renewalLabel = renewalWindowLabel(renewalDuration, renewalHours);
  const localRelayTooLong = renewing && relayMode === "SelfRelay" && renewalHours > LOCAL_BROWSER_MAX_RENEWAL_HOURS;
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
      });
      if (ok === false) return;
    }
    setInventoryCap("");
  }

  return (
    <div className="workspace-page liquidity-page">
      <div className="page-hd">
        <div className="page-title-block">
          <span className="page-title">CURVES</span>
        </div>
      </div>

      <div className="liq-curves-grid">
        <section className="liq-builder">
          <div className="liq-panel-hd">
            <span>Quote liquidity</span>
          </div>

          <label className="f-label">Pair</label>
          <select className="liq-select" value={selectedPair.pair_id} onChange={event => setActivePairId(event.target.value)}>
            {pairs.map(pair => <option value={pair.pair_id} key={pair.pair_id}>{pair.pair_id}</option>)}
          </select>

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
              ["two-sided", "Two-sided"],
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

          {side === "two-sided" ? (
            <>
              <CurveBandEditor title="Bid bands" quote={quote} base={base} bands={bidBands} onBands={setBidBands} />
              <CurveBandEditor title="Ask bands" quote={quote} base={base} bands={askBands} onBands={setAskBands} />
            </>
          ) : (
            <CurveBandEditor quote={quote} base={base} bands={side === "bid" ? bidBands : askBands} onBands={side === "bid" ? setBidBands : setAskBands} />
          )}

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
                      disabled={relayMode === "SelfRelay" && option.relayOnly}
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
                  value={relayMode}
                  onChange={event => {
                    const next = event.target.value as "SelfRelay" | "ZylithRelay";
                    setRelayMode(next);
                    if (next === "SelfRelay" && renewalHours > LOCAL_BROWSER_MAX_RENEWAL_HOURS) {
                      setRenewalDuration("1");
                    }
                  }}
                >
                  <option value="ZylithRelay">Zylith relay</option>
                  <option value="SelfRelay">Local browser</option>
                </select>
              </div>
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
            onPreviewFunding={onPreviewFunding}
          />
          {renewing && (
            <div className={`wc-note ${localRelayTooLong ? "warn" : ""}`}>
              {relayMode === "SelfRelay"
                ? "Local browser renewal is capped at 1h and stops if this tab closes or the machine sleeps."
                : renewalDuration === "continuous"
                  ? "Continuous uses rolling 90d relay packages. Refresh before expiry to extend the curve."
                  : "Zylith relay submits pre-authorized child slots for the selected window. Cancel invalidates unused slots on-chain."}
            </div>
          )}
          {side === "two-sided" && fundingPreviewErrors[0] && (
            <div className="wc-note warn">{fundingPreviewErrors[0]}</div>
          )}
          {submitError && <div className="wc-note warn">{submitError}</div>}
          <button className="submit-btn curve-cta" disabled={!canSubmit} onClick={() => { void submit(); }}>
            {submitting ? "Submitting..." : curveCtaLabel(side)}
          </button>
        </section>

        <section className="liq-active-curves">
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
                  <span className={`pill ${record.status === "Expiring" ? "warn" : record.status === "Paused" ? "muted" : "good"}`}>{record.status}</span>
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
  onRefreshPackage,
}: {
  records: LiquidityCurveRecord[];
  batches: BatchSummary[];
  onCancelCurve: (record: LiquidityCurveRecord) => void;
  onRefreshPackage: (record: LiquidityCurveRecord) => void;
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
        ) : displayedParents.map(record => {
          const expanded = open[record.id] ?? true;
          const children = record.strategy?.submitted_children ?? [];
          const filled = record.relatedOrders.filter(terminalFill).length;
          const submittedChildren = children.filter(child => child.submitted_at_unix_ms > 0).length;
          const submitted = Math.max(submittedChildren, record.relatedOrders.length);
          const tx = record.strategy?.parent_cancel_transaction_hash;
          const packageStatus = renewalPackageStatus(record);
          const slotsRemaining = renewalPackageSlotsRemaining(record);
          return (
            <section className="liq-parent-section" key={record.id}>
              <button className="liq-parent-head" onClick={() => setOpen(previous => ({ ...previous, [record.id]: !expanded }))}>
                <span>{record.pair}</span>
                <em>{record.sideLabel} · {record.status}</em>
                <strong>{submitted}/{Math.max(children.length, submitted)} submitted · {filled} fills · {submitted > 0 ? formatPct((filled / submitted) * 100) : "—"}</strong>
              </button>
              {tx && (
                <div className="liq-cancel-anchor">
                  Cancelled — on-chain marker confirmed · tx {fmtAddr(tx)}
                </div>
              )}
              {record.strategy && !tx && (
                <div className="liq-package-row">
                  <span>Offline renewal package</span>
                  <em>
                    <strong className={`pill ${packageStatus.tone}`}>{packageStatus.label}</strong>
                    {slotsRemaining} prepared slots remaining · expires epoch {record.strategy.offline_package?.end_epoch ?? record.strategy.end_epoch}
                    <small>{packageStatus.detail}</small>
                  </em>
                  <button type="button" onClick={() => onRefreshPackage(record)}>Refresh package</button>
                </div>
              )}
              {expanded && (
                <div className="table-zone compact-table">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Epoch</th>
                        <th>Submitted</th>
                        <th>Fill status</th>
                        <th>Clearing price</th>
                        <th>Amount filled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(children.length > 0 ? children : record.relatedOrders.map((order, index) => ({
                        parent_child_index: index + 1,
                        batch_id: order.batchId,
                        epoch_id: order.epochId,
                        submitted_at_unix_ms: order.submittedAt,
                        order_commitment: order.orderCommitment,
                      }))).map(child => {
                        const related = record.relatedOrders.find(order => order.batchId === child.batch_id || order.orderCommitment === child.order_commitment);
                        const label = related ? statusLabel(related.status) : batchStatus.get(child.batch_id) ?? "Queued";
                        const tone = related ? statusTone(related.status) : "info";
                        return (
                          <tr key={`${record.id}:${child.parent_child_index}`}>
                            <td className="num">Epoch {child.epoch_id}</td>
                            <td>{fmtTime(child.submitted_at_unix_ms)}</td>
                            <td><span className={`pill ${tone}`}>{label}</span></td>
                            <td className="num">{related?.clearingPrice ?? "—"}</td>
                            <td className="num">{related?.filledAmount ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {record.status !== "Cancelled" && (
                <div className="liq-parent-actions">
                  <button className="table-action" onClick={() => onCancelCurve(record)}>Cancel parent</button>
                </div>
              )}
            </section>
          );
        })}
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

  return (
    <div className="workspace-page liquidity-page">
      <div className="page-hd">
        <div className="page-title-block"><span className="page-title">ANALYTICS</span></div>
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
      <div className="liq-analytics-list">
        {activityRecords.map(record => {
          const total = committedDepth(record.points, record.relatedOrders);
          const filled = depthFilled(record.relatedOrders);
          return (
            <section className="liq-analytics-card" key={record.id}>
              <div className="liq-active-top">
                <span>{record.pair}</span>
                <span className={`side ${record.side === "Buy" ? "buy" : "sell"}`}>{record.sideLabel}</span>
                <span>{record.status}</span>
              </div>
              <div className="liq-analytics-stats">
                <div><span>Total depth</span><strong>{formatHuman(total)}</strong></div>
                <div><span>Volume matched</span><strong>{formatHuman(filled)}</strong></div>
                <div><span>Fill rate</span><strong>{formatPct(curveFillRate(record.relatedOrders))}</strong></div>
                <div><span>Avg clearing</span><strong>{weightedAverageClearing(record.relatedOrders)}</strong></div>
              </div>
              <div className="liq-band-utilization">
                {(() => {
                  let fallbackRemaining = filled;
                  return record.points.map((point, index) => {
                  const depth = parseHuman(point.baseAmount);
                  const bandFilled = displayedBandFill(record, index, fallbackRemaining);
                  fallbackRemaining = Math.max(0, fallbackRemaining - bandFilled);
                  const utilization = depth > 0 ? Math.min(100, (bandFilled / depth) * 100) : 0;
                  return (
                    <div key={index}>
                      <span>{point.price}</span>
                      <div className="liq-depth-bar"><span style={{ width: `${utilization}%` }} /></div>
                      <em>{formatPct(utilization)}</em>
                    </div>
                  );
                  });
                })()}
              </div>
            </section>
          );
        })}
      </div>

      <section className="liq-section-spaced">
        <div className="asset-section-hd">
          <h2>Epoch history</h2>
          <span>{epochRows.length} rows</span>
        </div>
        <div className="table-zone compact-table liq-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Epoch</th>
                <th>Pair</th>
                <th>Side</th>
                <th>Children</th>
                <th>Volume matched</th>
                <th>Avg clearing price</th>
                <th>Fill rate</th>
                <th>Gate status</th>
              </tr>
            </thead>
            <tbody>
              {epochRows.map(({ record, order, transcript }) => (
                <tr key={`${record.id}:${order.ordRef}`}>
                  <td className="num">Epoch {order.epochId}</td>
                  <td>{record.pair}</td>
                  <td><span className={`side ${record.side === "Buy" ? "buy" : "sell"}`}>{record.sideLabel}</span></td>
                  <td className="num">1</td>
                  <td className="num">{order.filledAmount ?? "—"}</td>
                  <td className="num">{order.clearingPrice ?? (transcript ? formatClearingPrice({
                    batchId: transcript.batch_id,
                    epochId: transcript.batch_epoch,
                    clearingPrice: String(transcript.clearing_price),
                    priceBaseScale: transcript.price_base_scale ? String(transcript.price_base_scale) : undefined,
                  }, {
                    base_asset_id: order.pair.split("/")[0],
                    quote_asset_id: order.pair.split("/")[1],
                  }) : "—")}</td>
                  <td className="num">{terminalFill(order) ? "100.0%" : order.status === "no_fill" ? "0.0%" : "—"}</td>
                  <td><span className={`pill ${statusTone(order.status)}`}>{statusLabel(order.status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="liq-health-grid">
        <div>
          <span>Curve fill rate</span>
          <strong>{averageCurveFillRate(activityRecords)}</strong>
          <em>Computed from locally recognized maker child orders in the selected period.</em>
        </div>
        <div>
          <span>Renewal utilization</span>
          <strong>{records.length > 0 ? formatPct(records.filter(record => record.strategy).length / records.length * 100) : "—"}</strong>
          <em>Low utilization means renewal packages are expiring or curves are frequently paused.</em>
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
  onRefreshStrategyPackage,
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
  onRefreshStrategyPackage: (strategyId: string) => Promise<void>;
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

  async function refreshPackage(record: LiquidityCurveRecord) {
    if (!record.strategy) return;
    await onRefreshStrategyPackage(record.strategy.id);
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
          onRefreshPackage={record => { void refreshPackage(record); }}
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
