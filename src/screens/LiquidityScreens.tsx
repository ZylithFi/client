import { Fragment, useEffect, useMemo, useState } from "react";
import { fromAtomicStr, safeFromAtomicStr } from "../domain/assets";
import type { BatchSummary, PublicSettlementTranscript } from "../domain/auctionEpoch";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";
import type { PendingDeposit, WalletBalance, WithdrawableNote } from "../domain/shieldedBalances";
import {
  buildLiquidityOpsSnapshot,
  buildPrivateLiquidityPositionPlan,
  type LiquidityPositionCurve,
  type LiquidityPositionPolicyKind,
  type PrivateLiquidityPositionOpenRequest,
} from "@zylith/sdk";
import type {
  PairConfig,
  TicketSubmitIntent,
} from "../components/OrderTicket";
import {
  activePositionRecords,
  activeStatuses,
  assetListText,
  averagePositionFillRate,
  averagePositionPrice,
  balanceAmount,
  buildPositionRecords,
  buildLiquidityEpochSeries,
  committedDepth,
  positionBaseAsset,
  positionDisplayRef,
  positionEpochOutcomes,
  positionFillRate,
  positionFundingAsset,
  positionLockedCapital,
  positionQuoteAsset,
  positionStatusPillTone,
  displayedBandFill,
  epochOutcomeWindow,
  formatBps,
  formatCompactHuman,
  formatHuman,
  formatPct,
  fmtAddr,
  fmtTime,
  latestEpochOutcomes,
  liquidityStrategyBandCount,
  liquidityStrategyInventoryCap,
  orderFilled,
  orderFundingExposure,
  orderQuoteNotional,
  parseHuman,
  renewalPackageStatus,
  settlementConfirmed,
  terminalFill,
  visibleLiquidityEpochSeries,
  weightedAverageClearing,
  weightedPositionCaptureBps,
  type PositionEpochOutcome,
  type LiquidityAnalyticsChartMode,
  type LiquidityAnalyticsEpoch,
  type LiquidityPositionRecord,
} from "../domain/liquidityRecords";
import { runPrimaryActionOnEnter } from "../domain/primaryEnter";
import { safeAtomicAmount } from "../domain/noteLifecycle";
import { userFacingErrorMessage } from "../domain/userFacingErrors";
type Period = "7d" | "30d" | "90d" | "all";
type LiquidityPageTab = "positions" | "orders" | "inventory" | "analytics";
type RenewalDurationPreset = "1" | "4" | "12" | "24" | "168" | "480" | "continuous" | "custom";
const MIN_POSITION_BANDS = 3;
const MAX_RELAY_RENEWAL_DAYS = 20;
const CONTINUOUS_ROLLING_WINDOW_HOURS = MAX_RELAY_RENEWAL_DAYS * 24;

const RENEWAL_DURATION_OPTIONS: Array<{ value: RenewalDurationPreset; label: string }> = [
  { value: "1", label: "1h" },
  { value: "4", label: "4h" },
  { value: "12", label: "12h" },
  { value: "24", label: "24h" },
  { value: "168", label: "7d" },
  { value: "480", label: "20d" },
  { value: "continuous", label: "Continuous" },
  { value: "custom", label: "Custom" },
];

function liquidityPageTitle(tab: LiquidityPageTab): string {
  if (tab === "orders") return "ORDERS";
  if (tab === "inventory") return "INVENTORY";
  if (tab === "analytics") return "ANALYTICS";
  return "LIQUIDITY";
}

function formatUnsignedBps(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const formatted = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} bps`;
}

function formatDailyTurnover(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const formatted = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted}x`;
}

function percentInputToBps(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(100, Math.max(0, parsed)) * 100);
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
  if (preset === "continuous") return "Continuous · 20d rolling package";
  if (hours >= 24) {
    const days = hours / 24;
    return `${days.toLocaleString("en-US", { maximumFractionDigits: 1 })}d package`;
  }
  return `${hours}h window`;
}

function positionPreviewIntent(
  pair: PairConfig,
  curve: LiquidityPositionCurve,
  durationHours: number,
): TicketSubmitIntent {
  const envelopePrice = curve.side === "Buy"
    ? curve.points[curve.points.length - 1]?.price
    : curve.points[0]?.price;
  return {
    pairId: pair.pair_id,
    side: curve.side,
    shape: "curve",
    stratKind: "TWAP",
    resting: true,
    amount: curve.totalBaseAmount,
    limitPrice: envelopePrice ?? "",
    minFill: "",
    fillOrKill: false,
    curvePoints: curve.points,
    inventoryCap: curve.totalBaseAmount,
    durationHours: String(durationHours),
    childSize: "",
    priceLimit: "",
    jitter: 0,
    relayMode: "SelfRelay",
    relayOperator: "SelfHostedRelay",
  };
}

function PositionOutcomeCells({
  outcomes,
  limit = 48,
  future = 0,
}: {
  outcomes: PositionEpochOutcome[];
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

function PositionChildTimeline({
  record,
  outcomes,
  submitted,
  scheduled,
  onCancelPosition,
}: {
  record: LiquidityPositionRecord;
  outcomes: PositionEpochOutcome[];
  submitted: number;
  scheduled: number;
  onCancelPosition: (record: LiquidityPositionRecord) => void;
}) {
  const visible = latestEpochOutcomes(outcomes, 8);
  const remaining = Math.max(0, scheduled - submitted);
  const tx = record.strategy?.parent_cancel_transaction_hash;
  const packageStatus = renewalPackageStatus(record);

  return (
    <tr className="strategy-detail-row liquidity-detail-row">
      <td className="side-bar-cell" />
      <td colSpan={10}>
        <div className="strategy-child-panel" aria-label="Position child orders">
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
                    <span>Clearing {outcome.clearingPrice ?? "-"}</span>
                    <span>Filled {outcome.filledAmount ?? "-"}</span>
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
              <button className="table-action" onClick={() => onCancelPosition(record)}>Cancel position</button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function PositionPreview({
  pair,
  previewIntents,
  renewalWindowLabelText,
}: {
  pair: PairConfig;
  previewIntents?: TicketSubmitIntent[];
  renewalWindowLabelText: string;
}) {
  const activeIntents = previewIntents ?? [];
  const activeBandSets = activeIntents.map(intent =>
    intent.curvePoints.filter(point => point.price.trim() && point.baseAmount.trim())
  );
  const filledBands = activeBandSets.flat();
  const totalDepth = filledBands.reduce((sum, band) => sum + parseHuman(band.baseAmount), 0);
  const prices = filledBands.map(band => parseHuman(band.price)).filter(value => value > 0);
  const threshold = fromAtomicStr(pair.min_order_amount, pair.base_asset_id);
  const thresholdNumber = parseHuman(threshold);
  const eligible = totalDepth >= thresholdNumber &&
    activeBandSets.length > 0 &&
    activeBandSets.every(bands => bands.length >= MIN_POSITION_BANDS);
  const sides = Array.from(new Set(activeIntents.map(intent => intent.side)));

  return (
    <div className="curve-preview">
      <div className="curve-preview-row">
        <span className="curve-preview-lbl">Total depth</span>
        <span className="curve-preview-val">{formatHuman(totalDepth, pair.base_asset_id)}</span>
      </div>
      <div className="curve-preview-row">
        <span className="curve-preview-lbl">Sides</span>
        <span className="curve-preview-val">{sides.join(" + ")}</span>
      </div>
      <div className="curve-preview-row">
        <span className="curve-preview-lbl">Price range</span>
        <span className="curve-preview-val">
          {prices.length > 0
            ? `${Math.min(...prices).toLocaleString()}-${Math.max(...prices).toLocaleString()} ${pair.quote_asset_id}`
            : "-"}
        </span>
      </div>
      <div className="curve-preview-row">
        <span className="curve-preview-lbl">Duration</span>
        <span className="curve-preview-val">{renewalWindowLabelText}</span>
      </div>
      <div className="curve-preview-row">
        <span className="curve-preview-lbl">Eligibility</span>
        <span
          className={`curve-preview-val ${eligible ? "good" : "warn"}`}
          title={eligible
            ? "Position slice satisfies local liquidity constraints."
            : "Position needs reserves, range, and funding before it can be opened."}
        >
          {eligible ? "Position eligible" : "Position incomplete"}
        </span>
      </div>
    </div>
  );
}

export function LiquidityPositionsScreen({
  pairs,
  records,
  balances,
  pendingDeposits,
  activePairId,
  setActivePairId,
  walletReady,
  submitting,
  submitError,
  onOpenPosition,
  onCancelPosition,
  onEditPosition,
  onPausePosition,
  onResumePosition,
  onDeposit,
  editRecord,
  onEditConsumed,
}: {
  pairs: PairConfig[];
  records: LiquidityPositionRecord[];
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  activePairId: string;
  setActivePairId: (pairId: string) => void;
  walletReady: boolean;
  submitting: boolean;
  submitError: string | null;
  onOpenPosition?: (request: PrivateLiquidityPositionOpenRequest) => Promise<boolean | void>;
  onCancelPosition: (record: LiquidityPositionRecord) => void;
  onEditPosition: (record: LiquidityPositionRecord) => void;
  onPausePosition: (record: LiquidityPositionRecord) => void;
  onResumePosition: (record: LiquidityPositionRecord) => void;
  onDeposit: (asset?: string) => void;
  editRecord: LiquidityPositionRecord | null;
  onEditConsumed: () => void;
}) {
  const selectedPair = pairs.find(pair => pair.pair_id === activePairId) ?? pairs[0] ?? null;
  const [advanced, setAdvanced] = useState(false);
  const [inventoryCap, setInventoryCap] = useState("");
  const [renewalDuration, setRenewalDuration] = useState<RenewalDurationPreset>("1");
  const [customRenewalDays, setCustomRenewalDays] = useState("20");
  const [positionBaseAmount, setPositionBaseAmount] = useState("");
  const [positionQuoteAmount, setPositionQuoteAmount] = useState("");
  const [positionCurrentPrice, setPositionCurrentPrice] = useState("");
  const [positionMinPrice, setPositionMinPrice] = useState("");
  const [positionMaxPrice, setPositionMaxPrice] = useState("");
  const [positionMinEdgeBps, setPositionMinEdgeBps] = useState("3");
  const [positionTargetAprPct, setPositionTargetAprPct] = useState("15");
  const [positionExpectedDailyVolume, setPositionExpectedDailyVolume] = useState("");
  const [positionPolicyKind, setPositionPolicyKind] = useState<LiquidityPositionPolicyKind>("StaticRange");
  const [positionTargetBaseRatioPct, setPositionTargetBaseRatioPct] = useState("50");
  const [positionInventorySkewBps, setPositionInventorySkewBps] = useState("100");
  const [positionMaxPriceDeviationBps, setPositionMaxPriceDeviationBps] = useState("500");

  function prefillBuilder(record: LiquidityPositionRecord) {
    setActivePairId(record.pair);
    if (record.strategy?.offline_package?.slot_count && record.strategy.offline_package.slot_count > 960) {
      const epochs = Math.max(1, record.strategy.offline_package.slot_count);
      if (epochs >= 86_400) setRenewalDuration("480");
      else if (epochs >= 30_240) setRenewalDuration("168");
      else setRenewalDuration("24");
    }
    const existingInventoryCap = liquidityStrategyInventoryCap(record.strategy);
    if (existingInventoryCap) {
      const pair = pairs.find(candidate => candidate.pair_id === record.pair);
      setInventoryCap(pair ? fromAtomicStr(existingInventoryCap, pair.base_asset_id) : "");
    } else {
      setInventoryCap("");
    }
  }

  useEffect(() => {
    if (!editRecord) return;
    prefillBuilder(editRecord);
    onEditConsumed();
  }, [editRecord, onEditConsumed]);

  if (!selectedPair) {
    return (
      <div className="workspace-page liquidity-page">
        <div className="page-hd"><span className="page-title">POSITIONS</span></div>
        <div className="empty-zone"><div className="empty-mark">-</div><div className="empty-body">No enabled pairs.</div></div>
      </div>
    );
  }

  const base = selectedPair.base_asset_id;
  const quote = selectedPair.quote_asset_id;
  const selectedPairRecords = records.filter(record => record.pair === selectedPair.pair_id);
  const selectedPairClearing = selectedPairRecords
    .flatMap(record => record.relatedOrders)
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .find(order => order.clearingPrice)?.clearingPrice;
  const renewalHours = renewalHoursForPreset(renewalDuration, customRenewalDays);
  const renewalLabel = renewalWindowLabel(renewalDuration, renewalHours);
  const positionInputTouched = [
    positionBaseAmount,
    positionQuoteAmount,
    positionCurrentPrice,
    positionMinPrice,
    positionMaxPrice,
  ].some(value => value.trim());
  const inferredCurrentPrice = positionCurrentPrice.trim() || selectedPairClearing || "";
  const positionPlanState = useMemo(() => {
    const hasReserve = positionBaseAmount.trim() || positionQuoteAmount.trim();
    if (!positionInputTouched || !hasReserve || !inferredCurrentPrice.trim() || !positionMinPrice.trim() || !positionMaxPrice.trim()) {
      return { plan: null, error: null };
    }
    try {
      return {
        plan: buildPrivateLiquidityPositionPlan({
          pair: selectedPair,
          baseAmount: positionBaseAmount || "0",
          quoteAmount: positionQuoteAmount || "0",
          currentPrice: inferredCurrentPrice,
          minPrice: positionMinPrice,
          maxPrice: positionMaxPrice,
          minEdgeBps: positionMinEdgeBps.trim() ? Number(positionMinEdgeBps) : undefined,
          targetAprPct: positionTargetAprPct.trim() ? Number(positionTargetAprPct) : undefined,
          expectedDailyVolume: positionExpectedDailyVolume || undefined,
          protocolFeeBps: selectedPair.taker_fee_bps,
          maxFillBasePerBatch: inventoryCap || undefined,
          policyKind: positionPolicyKind,
          targetBaseRatioBps: positionPolicyKind === "InventorySkewed"
            ? percentInputToBps(positionTargetBaseRatioPct, 5_000)
            : undefined,
          inventorySkewBps: positionPolicyKind === "InventorySkewed"
            ? Number(positionInventorySkewBps)
            : undefined,
          maxPriceDeviationBps: positionPolicyKind === "InventorySkewed"
            ? Number(positionMaxPriceDeviationBps)
            : undefined,
          bandCount: 5,
          durationHours: renewalHours,
          rotationBps: 50,
          privacyMode: "RotatingPrivate",
          backing: "PrivateReserve",
        }),
        error: null,
      };
    } catch (error) {
      return {
        plan: null,
        error: userFacingErrorMessage(error, "Position configuration is invalid."),
      };
    }
  }, [
    inferredCurrentPrice,
    inventoryCap,
    positionBaseAmount,
    positionExpectedDailyVolume,
    positionMinEdgeBps,
    positionTargetAprPct,
    positionInputTouched,
    positionMaxPrice,
    positionMinPrice,
    positionInventorySkewBps,
    positionMaxPriceDeviationBps,
    positionPolicyKind,
    positionQuoteAmount,
    positionTargetBaseRatioPct,
    renewalHours,
    selectedPair,
  ]);
  const positionPreviewIntents: TicketSubmitIntent[] = [
    positionPlanState.plan?.bidCurve,
    positionPlanState.plan?.askCurve,
  ]
    .filter((curve): curve is LiquidityPositionCurve => Boolean(curve))
    .map(curve => positionPreviewIntent(selectedPair, curve, renewalHours));
  const previewIntents = positionPreviewIntents;
  const builderInventoryAssets = Array.from(new Set([base, quote]));
  const neededInventoryAssets = positionInputTouched
    ? [
        positionPlanState.plan && BigInt(positionPlanState.plan.openPosition.baseReserveAtomic) > 0n ? base : null,
        positionPlanState.plan && BigInt(positionPlanState.plan.openPosition.quoteReserveAtomic) > 0n ? quote : null,
      ].filter((asset): asset is string => Boolean(asset))
    : [];
  const missingInventoryAssets = neededInventoryAssets.filter(asset =>
    balanceAmount(balances, asset, "available") <= 0n,
  );
  const lockedOnlyAssets = missingInventoryAssets.filter(asset =>
    balanceAmount(balances, asset, "locked") > 0n,
  );
  const missingInventoryText = `${assetListText(missingInventoryAssets)} ${missingInventoryAssets.length === 1 ? "note" : "notes"}`;
  const lockedAssetText = assetListText(lockedOnlyAssets);
  const fundingWarningText = lockedOnlyAssets.length > 0
    ? positionInputTouched
      ? `${lockedAssetText} ${lockedOnlyAssets.length === 1 ? "is" : "are"} locked in existing positions. Close or edit a position, or deposit more ${lockedAssetText}.`
      : `${lockedAssetText} ${lockedOnlyAssets.length === 1 ? "is" : "are"} locked in existing positions. Close or edit a position, or deposit more ${lockedAssetText}.`
    : positionInputTouched
      ? `No available ${missingInventoryText} for this position. Deposit before providing liquidity.`
      : `No available ${missingInventoryText} for this quote. Deposit before quoting liquidity.`;
  const canSubmit = walletReady &&
    !submitting &&
    missingInventoryAssets.length === 0 &&
    Boolean(positionPlanState.plan && onOpenPosition);

  async function submit() {
    if (!positionPlanState.plan || !onOpenPosition) return;
    const ok = await onOpenPosition(positionPlanState.plan.openPosition);
    if (ok === false) return;
    setPositionBaseAmount("");
    setPositionQuoteAmount("");
    setInventoryCap("");
  }

  return (
    <div className="workspace-page liquidity-page">
      <div className="liq-pair-workspace">
        <aside className="liq-pair-rail">
          <div className="liq-pair-rail-hd">Markets</div>
          {pairs.map(pair => {
            const pairRecords = records.filter(record => record.pair === pair.pair_id);
            const livePairRecords = activePositionRecords(pairRecords);
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
                  <span className="pill muted">No active position</span>
                ) : selectedPairRecords.map(record => (
                  <span className={`pill ${positionStatusPillTone(record.status)}`} key={record.id}>
                    {record.sideLabel} {record.status}
                  </span>
                ))}
              </span>
            </div>
            <span className="liq-pair-head-clearing">{selectedPairClearing ?? "-"}</span>
          </header>

          <section
            className="liq-builder"
            onKeyDown={event => {
              runPrimaryActionOnEnter(event, canSubmit, () => { void submit(); });
            }}
          >
          <div className="liq-panel-hd">
            <span>Create position</span>
          </div>

          <div className="liq-inventory-strip" aria-label="Liquidity inventory">
            {builderInventoryAssets.map(asset => {
              const balance = balances.find(entry => entry.asset === asset);
              const pending = pendingDeposits
                .filter(deposit => deposit.asset === asset && !deposit.confirmed && !deposit.failed)
                .reduce((sum, deposit) => sum + safeAtomicAmount(deposit.amount), 0n);
              const locked = balance ? safeAtomicAmount(balance.locked) : 0n;
              return (
                <div key={asset} className="liq-inventory-cell">
                  <span>{asset}</span>
                  <strong>{balance ? safeFromAtomicStr(balance.available, asset) : "-"}</strong>
                  <em>available</em>
                  {locked > 0n && (
                    <small>{safeFromAtomicStr(locked, asset)} locked</small>
                  )}
                  {pending > 0n && (
                    <small>{safeFromAtomicStr(pending, asset)} pending</small>
                  )}
                </div>
              );
            })}
          </div>

          <div className="position-config-grid" aria-label="Position configuration">
            <div className="curve-risk-field">
              <label className="f-label">{base}</label>
              <div className="f-input-box" style={{ height: 36 }}>
                <input
                  className="f-input"
                  type="number"
                  inputMode="decimal"
                  placeholder="0"
                  value={positionBaseAmount}
                  onChange={event => setPositionBaseAmount(event.target.value)}
                />
                <span className="f-unit">{base}</span>
              </div>
            </div>
            <div className="curve-risk-field">
              <label className="f-label">{quote}</label>
              <div className="f-input-box" style={{ height: 36 }}>
                <input
                  className="f-input"
                  type="number"
                  inputMode="decimal"
                  placeholder="0"
                  value={positionQuoteAmount}
                  onChange={event => setPositionQuoteAmount(event.target.value)}
                />
                <span className="f-unit">{quote}</span>
              </div>
            </div>
            <div className="curve-risk-field">
              <label className="f-label">Reference price</label>
              <div className="f-input-box" style={{ height: 36 }}>
                <input
                  className="f-input"
                  type="number"
                  inputMode="decimal"
                  placeholder={selectedPairClearing ?? "0"}
                  value={positionCurrentPrice}
                  onChange={event => setPositionCurrentPrice(event.target.value)}
                />
                <span className="f-unit">{quote}</span>
              </div>
            </div>
            <div className="curve-risk-field">
              <label className="f-label">Min edge</label>
              <div className="f-input-box" style={{ height: 36 }}>
                <input
                  className="f-input"
                  type="number"
                  inputMode="numeric"
                  placeholder="8"
                  value={positionMinEdgeBps}
                  onChange={event => setPositionMinEdgeBps(event.target.value)}
                />
                <span className="f-unit">bps</span>
              </div>
            </div>
            <div className="curve-risk-field">
              <label className="f-label">Min price</label>
              <div className="f-input-box" style={{ height: 36 }}>
                <input
                  className="f-input"
                  type="number"
                  inputMode="decimal"
                  placeholder="0"
                  value={positionMinPrice}
                  onChange={event => setPositionMinPrice(event.target.value)}
                />
                <span className="f-unit">{quote}</span>
              </div>
            </div>
            <div className="curve-risk-field">
              <label className="f-label">Max price</label>
              <div className="f-input-box" style={{ height: 36 }}>
                <input
                  className="f-input"
                  type="number"
                  inputMode="decimal"
                  placeholder="0"
                  value={positionMaxPrice}
                  onChange={event => setPositionMaxPrice(event.target.value)}
                />
                <span className="f-unit">{quote}</span>
              </div>
            </div>
          </div>

          <div className="position-config-grid position-return-grid" aria-label="Return model">
            <div className="curve-risk-field">
              <label className="f-label">Target gross yield</label>
              <div className="f-input-box" style={{ height: 36 }}>
                <input
                  className="f-input"
                  type="number"
                  inputMode="decimal"
                  placeholder="15"
                  value={positionTargetAprPct}
                  onChange={event => setPositionTargetAprPct(event.target.value)}
                />
                <span className="f-unit">%</span>
              </div>
            </div>
            <div className="curve-risk-field">
              <label className="f-label">Daily filled volume</label>
              <div className="f-input-box" style={{ height: 36 }}>
                <input
                  className="f-input"
                  type="number"
                  inputMode="decimal"
                  placeholder="optional"
                  value={positionExpectedDailyVolume}
                  onChange={event => setPositionExpectedDailyVolume(event.target.value)}
                />
                <span className="f-unit">{quote}</span>
              </div>
            </div>
          </div>

          {(positionPlanState.plan || positionPlanState.error) && (
            <div className="position-metrics-row">
              {positionPlanState.plan && (
                <>
                  <div>
                    <span>Capital</span>
                    <strong>{formatCompactHuman(positionPlanState.plan.metrics.quoteValue, quote)}</strong>
                  </div>
                  <div>
                    <span>Indicative fill yield</span>
                    <strong>{formatPct(positionPlanState.plan.metrics.rewards.projectedAprPct ?? Number.NaN)}</strong>
                  </div>
                  <div>
                    <span>Daily volume needed</span>
                    <strong>{formatCompactHuman(positionPlanState.plan.metrics.rewards.requiredDailyVolume ?? Number.NaN, quote)}</strong>
                  </div>
                  <div>
                    <span>Daily turnover needed</span>
                    <strong>{formatDailyTurnover(positionPlanState.plan.metrics.rewards.requiredDailyTurnover)}</strong>
                  </div>
                  <div>
                    <span>Effective ref</span>
                    <strong>{formatHuman(positionPlanState.plan.metrics.effectiveReferencePrice, quote)}</strong>
                  </div>
                  <div>
                    <span>LP edge</span>
                    <strong>{formatUnsignedBps(positionPlanState.plan.metrics.rewards.estimatedEdgeBps)}</strong>
                  </div>
                  <div>
                    <span>LP rebate</span>
                    <strong>{formatUnsignedBps(positionPlanState.plan.metrics.rewards.estimatedRebateBps)}</strong>
                  </div>
                  <div>
                    <span>Net LP return</span>
                    <strong>{formatUnsignedBps(positionPlanState.plan.metrics.rewards.netLpEdgeBps)}</strong>
                  </div>
                </>
              )}
              {positionPlanState.error && <div className="wc-note warn">{positionPlanState.error}</div>}
            </div>
          )}
          {positionPlanState.plan?.warnings.map(warning => (
            <div className="wc-note warn" key={warning}>{warning}</div>
          ))}
          {positionInputTouched && positionPlanState.plan && !onOpenPosition && (
            <div className="wc-note warn">Private position opening is not enabled in this wallet build yet.</div>
          )}

          {walletReady && missingInventoryAssets.length > 0 && (
            <div className="wc-note warn liq-funding-warning">
              <span>{fundingWarningText}</span>
              <button type="button" onClick={() => onDeposit(missingInventoryAssets[0])}>Deposit</button>
            </div>
          )}

          <button className="adv-toggle liq-adv" onClick={() => setAdvanced(value => !value)}>
            <span>Advanced</span>
            <strong>{advanced ? "⌃" : "⌄"}</strong>
          </button>
          {advanced && (
            <div className="liq-advanced-grid">
              <div className="curve-risk-field">
                <label className="f-label">Policy</label>
                <select
                  className="liq-select compact"
                  value={positionPolicyKind}
                  onChange={event => setPositionPolicyKind(event.target.value as LiquidityPositionPolicyKind)}
                >
                  <option value="StaticRange">Static range</option>
                  <option value="InventorySkewed">Inventory skewed</option>
                </select>
              </div>
              <div className="curve-risk-field">
                <label className="f-label">Max fill/batch</label>
                <div className="f-input-box" style={{ height: 34 }}>
                  <input className="f-input" type="text" inputMode="decimal" placeholder="0" value={inventoryCap} onChange={event => setInventoryCap(event.target.value)} />
                  <span className="f-unit">{base}</span>
                </div>
              </div>
              {positionPolicyKind === "InventorySkewed" && (
                <>
                  <div className="curve-risk-field">
                    <label className="f-label">Target base</label>
                    <div className="f-input-box" style={{ height: 34 }}>
                      <input
                        className="f-input"
                        type="number"
                        inputMode="decimal"
                        placeholder="50"
                        value={positionTargetBaseRatioPct}
                        onChange={event => setPositionTargetBaseRatioPct(event.target.value)}
                      />
                      <span className="f-unit">%</span>
                    </div>
                  </div>
                  <div className="curve-risk-field">
                    <label className="f-label">Inventory skew</label>
                    <div className="f-input-box" style={{ height: 34 }}>
                      <input
                        className="f-input"
                        type="number"
                        inputMode="numeric"
                        placeholder="100"
                        value={positionInventorySkewBps}
                        onChange={event => setPositionInventorySkewBps(event.target.value)}
                      />
                      <span className="f-unit">bps</span>
                    </div>
                  </div>
                  <div className="curve-risk-field">
                    <label className="f-label">Max skew</label>
                    <div className="f-input-box" style={{ height: 34 }}>
                      <input
                        className="f-input"
                        type="number"
                        inputMode="numeric"
                        placeholder="500"
                        value={positionMaxPriceDeviationBps}
                        onChange={event => setPositionMaxPriceDeviationBps(event.target.value)}
                      />
                      <span className="f-unit">bps</span>
                    </div>
                  </div>
                </>
              )}
              <div className="curve-risk-field">
                <label className="f-label">Position duration</label>
                <select
                  className="liq-select compact"
                  value={renewalDuration}
                  onChange={event => setRenewalDuration(event.target.value as RenewalDurationPreset)}
                >
                  {RENEWAL_DURATION_OPTIONS.map(option => (
                    <option
                      key={option.value}
                      value={option.value}
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
            </div>
          )}

          <PositionPreview
            pair={selectedPair}
            previewIntents={previewIntents}
            renewalWindowLabelText={renewalLabel}
          />
          {submitError && <div className="wc-note warn">{submitError}</div>}
          <button className="submit-btn curve-cta" disabled={!canSubmit} onClick={() => { void submit(); }}>
            {submitting ? "Submitting..." : "Create position"}
          </button>
        </section>
        </main>

        <section className="liq-execution-rail liq-active-positions">
          <div className="liq-panel-hd">
            <span>Active positions</span>
            <em>{activePositionRecords(records).length} running</em>
          </div>
          {activePositionRecords(records).length === 0 ? (
            <div className="empty-zone liq-empty-zone">
              <div className="empty-mark">-</div>
            </div>
          ) : (
            activePositionRecords(records).map(record => {
              const bands = record.points.map((point, index) => {
                const depth = parseHuman(point.baseAmount);
                const filled = displayedBandFill(record, index);
                return { point, depth, filled };
              });
              const maxDepth = Math.max(1, ...bands.map(band => band.depth));
              const sideTone = record.side === "Buy" ? "bid" : "ask";
              return (
                <div className="liq-active-card liq-active-ladder-card" key={record.id}>
                  <div className="liq-active-top">
                    <span>{record.pair}</span>
                    <span className={`side ${record.side === "Buy" ? "buy" : "sell"}`}>{record.sideLabel}</span>
                    <span className={`pill ${positionStatusPillTone(record.status)}`}>{record.status}</span>
                    <span className="liq-active-rate">{formatPct(positionFillRate(record.relatedOrders))}</span>
                  </div>
                  <div className="liq-active-ladder">
                    {bands.map(({ point, depth, filled }, index) => {
                      const depthWidth = Math.min(100, depth > 0 ? (depth / maxDepth) * 100 : 0);
                      const fillWidth = Math.min(100, filled > 0 ? (filled / maxDepth) * 100 : 0);
                      return (
                        <div className="liq-active-ladder-row" key={`${record.id}:${index}`}>
                          <span className="liq-active-price">{point.price}</span>
                          <span className="liq-active-track">
                            <span className={`liq-active-depth ${sideTone}`} style={{ width: `${depthWidth}%` }} />
                            <span className={`liq-active-fill ${sideTone}`} style={{ width: `${fillWidth}%` }} />
                          </span>
                          <span className="liq-active-depth-value">{point.baseAmount}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="liq-card-actions">
                    {record.strategy && (
                      record.status === "Paused"
                        ? <button type="button" onClick={() => onResumePosition(record)}>Resume</button>
                        : <button type="button" onClick={() => onPausePosition(record)}>Pause</button>
                    )}
                    <button type="button" onClick={() => onEditPosition(record)}>Edit</button>
                    <button type="button" className="danger" onClick={() => onCancelPosition(record)}>Cancel</button>
                  </div>
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}

export function LiquidityOrdersScreen({
  records,
  batches,
  onCancelPosition,
}: {
  records: LiquidityPositionRecord[];
  batches: BatchSummary[];
  onCancelPosition: (record: LiquidityPositionRecord) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<"active" | "history">("active");
  const batchStatus = new Map(batches.map(batch => [batch.batch_id, batch.status]));
  const parents = records.filter(record => record.strategy || record.relatedOrders.length > 0);
  const displayedParents = filter === "active"
    ? parents.filter(record => activePositionRecords([record]).length > 0)
    : parents.filter(record => activePositionRecords([record]).length === 0);

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
            <div className="empty-mark">-</div>
            <div className="empty-body">
              {parents.length === 0
                ? "Child orders appear after a position is activated."
                : filter === "active"
                  ? "No active position slices."
                  : "No position slice history yet."}
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
                  const outcomes = positionEpochOutcomes(record, batchStatus);
                  const submitted = outcomes.length;
                  const scheduled = Math.max(record.strategy?.max_children ?? record.maxChildren ?? submitted, submitted);
                  const remaining = Math.max(0, scheduled - submitted);
                  const depth = committedDepth(record.points, record.relatedOrders);
                  const bands = record.points.length || liquidityStrategyBandCount(record.strategy) || "-";
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
                        <td className="ref">{positionDisplayRef(record)}</td>
                        <td>{record.pair}</td>
                        <td>
                          <span className={`side ${record.side === "Buy" ? "buy" : "sell"}`}>
                            {record.sideLabel}
                          </span>
                        </td>
                        <td className="num">{bands}</td>
                        <td className="num">{formatHuman(depth, positionBaseAsset(record))}</td>
                        <td className="num">{averagePositionPrice(record)}</td>
                        <td className="num">{submitted}/{scheduled} · {remaining} left</td>
                        <td><span className={`pill ${positionStatusPillTone(record.status)}`}>{record.status}</span></td>
                        <td>{fmtTime(record.submittedAt)}</td>
                        <td className="disclosure-cell">
                          <button
                            type="button"
                            className={`disclosure ${expanded ? "open" : "muted"}`}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "Collapse" : "Expand"} ${record.pair} position child orders`}
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
                        <PositionChildTimeline
                          record={record}
                          outcomes={outcomes}
                          submitted={submitted}
                          scheduled={scheduled}
                          onCancelPosition={onCancelPosition}
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
  records: LiquidityPositionRecord[];
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  withdrawableNotes: WithdrawableNote[];
  activeEpochId: number | null;
  onDeposit: (asset?: string) => void;
  onWithdraw: (asset?: string) => void;
}) {
  const activeRecords = activePositionRecords(records);
  if (activeRecords.length === 0) {
    return (
      <div className="workspace-page liquidity-page">
        <div className="page-hd">
          <div className="page-title-block"><span className="page-title">INVENTORY</span></div>
        </div>
        <div className="table-zone">
          <div className="empty-zone">
            <div className="empty-mark">-</div>
            <div className="empty-body">Inventory tracking begins when you open a position.</div>
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

  function lockedInPositions(asset: string): number {
    return activeRecords
      .filter(record => record.status === "Active" || record.status === "Expiring")
      .filter(record => positionFundingAsset(record) === asset)
      .reduce((sum, record) => sum + positionLockedCapital(record), 0);
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
                <th>Locked in positions</th>
                <th>Observed capacity</th>
                <th>Current epoch exposure</th>
                <th>Current utilization</th>
            </tr>
          </thead>
          <tbody>
            {assets.map(asset => {
              const balance = balances.find(entry => entry.asset === asset);
              const locked = lockedInPositions(asset);
              const exposure = activeRecords
                .flatMap(record => record.relatedOrders)
                .filter(order => order.epochId === activeEpochId)
                .reduce((sum, order) => sum + orderFundingExposure(order, asset), 0);
              const cap = Math.max(locked, exposure);
              const pct = cap > 0 ? (exposure / cap) * 100 : 0;
              return (
                <tr key={asset}>
                  <td className="ref">{asset}</td>
                  <td className="num">{balance ? safeFromAtomicStr(balance.available, asset) : "-"}</td>
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
            <span>{activeRecords.length} positions</span>
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
            <span>Capital fragmentation by position</span>
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
        <span>-</span>
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
  if (values.length === 0) return <span className="an-util empty">-</span>;
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
  strategies = [],
  balances = [],
}: {
  records: LiquidityPositionRecord[];
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  strategies?: PrivateStrategySummary[];
  balances?: WalletBalance[];
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
  const quoteAssets = new Set(activityRecords.map(positionQuoteAsset).filter(Boolean));
  const quoteAsset = quoteAssets.size === 1 ? [...quoteAssets][0] : null;
  const chartMode: LiquidityAnalyticsChartMode = quoteAsset ? "notional" : "fills";
  const epochSeries = buildLiquidityEpochSeries(epochRows, chartMode);
  const chartSeries = visibleLiquidityEpochSeries(epochSeries);
  const matchedNotional = quoteAsset
    ? epochRows.reduce((sum, row) => sum + orderQuoteNotional(row.order, row.transcript), 0)
    : Number.NaN;
  const filledOrders = terminalOrders.filter(terminalFill).length;
  const blendedFillRate = terminalOrders.length > 0 ? (filledOrders / terminalOrders.length) * 100 : Number.NaN;
  const captureBps = weightedPositionCaptureBps(terminalOrders);
  const activeMarkets = new Set(activityRecords.map(record => record.pair)).size;
  const rolledPct = records.length > 0 ? (records.filter(record => record.strategy).length / records.length) * 100 : Number.NaN;
  const opsSnapshot = buildLiquidityOpsSnapshot({
    strategies,
    orders: records.flatMap(record => record.relatedOrders),
    balances,
    fairPrices: [],
  });
  const marketGroups = new Map<string, {
    pair: string;
    sides: Set<LiquidityPositionRecord["side"]>;
    orders: LocalOrder[];
    utilization: number[];
  }>();
  for (const record of activityRecords) {
    const utilization = record.points.map((point, index) => {
      const depth = parseHuman(point.baseAmount);
      const bandFilled = displayedBandFill(record, index);
      return depth > 0 ? Math.min(100, (bandFilled / depth) * 100) : 0;
    });
    const current = marketGroups.get(record.pair) ?? {
      pair: record.pair,
      sides: new Set<LiquidityPositionRecord["side"]>(),
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
      fillRate: positionFillRate(group.orders),
      avgClearing: weightedAverageClearing(group.orders),
      capture: weightedPositionCaptureBps(group.orders),
      notional: group.orders.reduce((sum, order) => sum + orderQuoteNotional(order, settlementTranscripts[order.batchId]), 0),
      utilization: group.utilization.slice(0, 8),
    };
  }).sort((a, b) => b.notional - a.notional || a.pair.localeCompare(b.pair));
  const periodLabel = period === "all" ? "ALL" : period.toUpperCase();

  return (
    <div className="workspace-page liquidity-page">
      <div className="page-hd">
        <div className="page-title-block">
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
            <div className="empty-mark">-</div>
            <div className="empty-body">Analytics populate after positions have been active and children have settled.</div>
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
              <span className={Number.isFinite(captureBps) && captureBps < 0 ? "an-kpi-d down" : "an-kpi-d up"}>Clearing vs position limit</span>
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
                <span>{chartSeries[0] ? `Epoch ${chartSeries[0].epoch}` : "-"}</span>
                <span>{Math.min(30, chartSeries.length)} epochs</span>
                <span>{chartSeries.at(-1) ? `Epoch ${chartSeries.at(-1)?.epoch}` : "-"}</span>
              </div>
            </section>

            <aside className="an-side-zone">
              <div className="an-sec-hd">
                <span>Spread capture</span>
              </div>
              <strong className="an-cap-big">{formatBps(captureBps)}</strong>
              <p className="an-cap-sub">Weighted clearing improvement against position limits across filled slices.</p>
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

          <section className="an-market-section">
            <div className="an-market-hd">
              <div className="an-sec-hd">
                <span>Liquidity ops</span>
                <em>Position health and relay attention</em>
              </div>
            </div>
            <div className="an-markets">
              <div className="an-mkt-hdr" role="row">
                <span>Area</span>
                <span>Active</span>
                <span>Delegated</span>
                <span>Paused</span>
                <span>Needs refresh</span>
                <span>Failures</span>
              </div>
              <div className="an-mkt-row" role="row">
                <span className="an-mkt-name">Position slices</span>
                <span className="an-mkt-num">{opsSnapshot.activeStrategies.toLocaleString("en-US")}</span>
                <span className="an-mkt-num">{opsSnapshot.delegatedStrategies.toLocaleString("en-US")}</span>
                <span className="an-mkt-num">{opsSnapshot.pausedStrategies.toLocaleString("en-US")}</span>
                <span className="an-mkt-num">{opsSnapshot.awaitingWalletRefreshSlots.toLocaleString("en-US")}</span>
                <span className={`an-cap-bps ${opsSnapshot.failedSlots > 0 ? "neg" : "pos"}`}>{opsSnapshot.failedSlots.toLocaleString("en-US")}</span>
              </div>
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
  onOpenPosition,
  onCancelOrder,
  onCancelStrategy,
  onPauseStrategy,
  onResumeStrategy,
  onDeposit,
  onWithdraw,
  onNavigatePositions,
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
  onOpenPosition?: (request: PrivateLiquidityPositionOpenRequest) => Promise<boolean | void>;
  onCancelOrder: (order: LocalOrder) => void;
  onCancelStrategy: (strategyId: string) => Promise<void>;
  onPauseStrategy: (strategyId: string) => Promise<void>;
  onResumeStrategy: (strategyId: string) => Promise<void>;
  onDeposit: (asset?: string) => void;
  onWithdraw: (asset?: string) => void;
  onNavigatePositions: () => void;
}) {
  const [editRecord, setEditRecord] = useState<LiquidityPositionRecord | null>(null);
  const records = useMemo(() => buildPositionRecords(orders, strategies, pairs), [orders, pairs, strategies]);
  const activeEpochId = batches.reduce<number | null>((latest, batch) => latest === null ? batch.epoch_id : Math.max(latest, batch.epoch_id), null);

  function cancelPosition(record: LiquidityPositionRecord) {
    if (record.strategy) {
      void onCancelStrategy(record.strategy.id);
      return;
    }
    const firstActive = record.relatedOrders.find(order => activeStatuses(order)) ?? record.relatedOrders[0];
    if (firstActive) onCancelOrder(firstActive);
  }

  async function pausePosition(record: LiquidityPositionRecord) {
    if (!record.strategy) return;
    await onPauseStrategy(record.strategy.id);
  }

  async function resumePosition(record: LiquidityPositionRecord) {
    if (!record.strategy) return;
    await onResumeStrategy(record.strategy.id);
  }

  function editPosition(record: LiquidityPositionRecord) {
    if (record.strategy && record.status !== "Paused") {
      void pausePosition(record);
    }
    setEditRecord(record);
    onNavigatePositions();
  }

  if (!walletReady) {
    return (
      <div className="workspace-page liquidity-page">
        <div className="page-hd"><span className="page-title">{liquidityPageTitle(tab)}</span></div>
        <div className="table-zone">
          <div className="empty-zone">
            <div className="empty-mark">-</div>
            <div className="empty-body">Connect wallet to manage liquidity.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Fragment>
      {tab === "positions" && (
        <LiquidityPositionsScreen
          pairs={pairs}
          records={records}
          balances={balances}
          pendingDeposits={pendingDeposits}
          activePairId={activePairId}
          setActivePairId={setActivePairId}
          walletReady={walletReady}
          submitting={submitting}
          submitError={submitError}
          onOpenPosition={onOpenPosition}
          onCancelPosition={cancelPosition}
          onEditPosition={editPosition}
          onPausePosition={record => { void pausePosition(record); }}
          onResumePosition={record => { void resumePosition(record); }}
          onDeposit={onDeposit}
          editRecord={editRecord}
          onEditConsumed={() => setEditRecord(null)}
        />
      )}
      {tab === "orders" && (
        <LiquidityOrdersScreen
          records={records}
          batches={batches}
          onCancelPosition={cancelPosition}
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
        <LiquidityAnalyticsScreen
          records={records}
          settlementTranscripts={settlementTranscripts}
          strategies={strategies}
          balances={balances}
        />
      )}
    </Fragment>
  );
}
