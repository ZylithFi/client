import type { PairConfig, TicketSubmitIntent } from "../components/OrderTicket";
import type { LocalOrder, PrivateStrategySummary } from "./orderLifecycle";
import type { WalletBalance } from "./shieldedBalances";

export type MarketObservation = {
  source: string;
  pair: string;
  price: number;
  observedAt: number;
  confidenceBps?: number;
};

export type FairPricePolicy = {
  maxStalenessMs: number;
  maxDivergenceBps: number;
  minSources: number;
};

export type FairPriceResult =
  | {
      ok: true;
      pair: string;
      price: number;
      observedAt: number;
      sources: string[];
      maxDivergenceBps: number;
    }
  | {
      ok: false;
      pair: string;
      reason: "no_sources" | "stale" | "divergent";
      detail: string;
    };

export type PendingExposure = {
  pair: string;
  orderId: string;
  side: "Buy" | "Sell";
  baseAmount: number;
  quoteAmount: number;
  epochId?: number;
  status: "queued" | "submitted" | "settling";
};

export type ManagedInventorySnapshot = {
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  availableBase: number;
  availableQuote: number;
  lockedBase: number;
  lockedQuote: number;
  pendingBuyBase: number;
  pendingSellBase: number;
  pendingQuote: number;
  baseRatio: number;
};

export type ManagedStrategyConfig = {
  pair: string;
  side: "Bid" | "Ask" | "Both";
  targetBaseRatio: number;
  baseSpreadBps: number;
  volatilityBps: number;
  inventorySkewBps: number;
  bandCount: number;
  maxEpochBase: number;
  minBandBase: number;
  maxExposureBase: number;
  relayMode: "SelfRelay" | "ZylithRelay";
  durationHours: number;
};

export type ManagedRiskPolicy = {
  minSpreadBps: number;
  maxSpreadBps: number;
  maxPriceDeviationBps: number;
  maxEpochBase: number;
  maxInventoryImbalanceBps: number;
  allowBid: boolean;
  allowAsk: boolean;
};

export type ManagedCurveDraft = {
  pair: string;
  side: "Buy" | "Sell";
  fairPrice: number;
  reservationPrice: number;
  spreadBps: number;
  inventorySkewBps: number;
  maxBaseAmount: number;
  points: Array<{ price: number; baseAmount: number }>;
  relayMode: "SelfRelay" | "ZylithRelay";
  durationHours: number;
};

export type ManagedCurvePlan =
  | {
      ok: true;
      fairPrice: FairPriceResult & { ok: true };
      inventory: ManagedInventorySnapshot;
      curves: ManagedCurveDraft[];
      clipped: string[];
    }
  | {
      ok: false;
      reason: string;
      fairPrice?: FairPriceResult;
      inventory?: ManagedInventorySnapshot;
    };

export type DelegatedMakerPermission = {
  pairs: string[];
  sides: Array<"Buy" | "Sell">;
  maxEpochBase: number;
  maxPriceDeviationBps: number;
  expiresAt: number;
  relayModes: Array<"SelfRelay" | "ZylithRelay">;
};

export type DelegatedMakerAuthorization =
  | { ok: true; curve: ManagedCurveDraft }
  | { ok: false; reason: string };

export type MakerPnlSummary = {
  pair: string;
  filledChildren: number;
  noFillChildren: number;
  baseDelta: number;
  quoteDelta: number;
  quoteNotional: number;
  averageCaptureBps: number | null;
};

export type MakerOpsSnapshot = {
  activeStrategies: number;
  delegatedStrategies: number;
  pausedStrategies: number;
  awaitingWalletRefreshSlots: number;
  failedSlots: number;
  staleMarketPairs: string[];
  balances: WalletBalance[];
};

export function selectFairPrice(
  pair: string,
  observations: MarketObservation[],
  policy: FairPricePolicy,
  now = Date.now()
): FairPriceResult {
  const fresh = observations
    .filter((observation) => observation.pair === pair && observation.price > 0)
    .filter((observation) => now - observation.observedAt <= policy.maxStalenessMs);
  if (fresh.length === 0) {
    return { ok: false, pair, reason: "no_sources", detail: "No fresh reference prices are available." };
  }
  if (fresh.length < policy.minSources) {
    return { ok: false, pair, reason: "stale", detail: `Only ${fresh.length} fresh source(s) available.` };
  }
  const prices = fresh.map((observation) => observation.price).sort((a, b) => a - b);
  const median = prices.length % 2 === 1
    ? prices[Math.floor(prices.length / 2)]
    : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  const maxDivergenceBps = Math.max(
    ...fresh.map((observation) => Math.abs(bps(observation.price - median, median)))
  );
  if (maxDivergenceBps > policy.maxDivergenceBps) {
    return {
      ok: false,
      pair,
      reason: "divergent",
      detail: `Reference prices diverge by ${maxDivergenceBps.toFixed(1)} bps.`,
    };
  }
  return {
    ok: true,
    pair,
    price: median,
    observedAt: Math.max(...fresh.map((observation) => observation.observedAt)),
    sources: fresh.map((observation) => observation.source),
    maxDivergenceBps,
  };
}

export function pendingExposureFromOrders(orders: LocalOrder[]): PendingExposure[] {
  return orders
    .filter((order) => ["queued", "in_batch", "proving", "settling", "settled_pending_output"].includes(order.status))
    .map((order) => {
      const amount = numberValue(order.amount);
      const price = numberValue(order.limitPrice || order.clearingPrice);
      return {
        pair: order.pair,
        orderId: order.orderCommitment || order.ordRef,
        side: order.side,
        baseAmount: amount,
        quoteAmount: amount * price,
        epochId: order.epochId,
        status: order.status === "queued" ? "queued" : order.status === "settling" ? "settling" : "submitted",
      };
    });
}

export function buildInventorySnapshot(
  pair: PairConfig,
  balances: WalletBalance[],
  pending: PendingExposure[] = [],
  referencePrice?: number
): ManagedInventorySnapshot {
  const baseBalance = balances.find((balance) => balance.asset === pair.base_asset_id);
  const quoteBalance = balances.find((balance) => balance.asset === pair.quote_asset_id);
  const availableBase = numberValue(baseBalance?.available);
  const availableQuote = numberValue(quoteBalance?.available);
  const lockedBase = numberValue(baseBalance?.locked);
  const lockedQuote = numberValue(quoteBalance?.locked);
  const pairPending = pending.filter((exposure) => exposure.pair === pair.pair_id);
  const pendingBuyBase = pairPending
    .filter((exposure) => exposure.side === "Buy")
    .reduce((sum, exposure) => sum + exposure.baseAmount, 0);
  const pendingSellBase = pairPending
    .filter((exposure) => exposure.side === "Sell")
    .reduce((sum, exposure) => sum + exposure.baseAmount, 0);
  const pendingQuote = pairPending.reduce((sum, exposure) => sum + exposure.quoteAmount, 0);
  const totalBase = availableBase + lockedBase + pendingBuyBase - pendingSellBase;
  const totalQuoteAsBase = availableQuote > 0 && referencePrice && referencePrice > 0 ? availableQuote / referencePrice : 0;
  const denominator = totalBase + totalQuoteAsBase;
  return {
    pair: pair.pair_id,
    baseAsset: pair.base_asset_id,
    quoteAsset: pair.quote_asset_id,
    availableBase,
    availableQuote,
    lockedBase,
    lockedQuote,
    pendingBuyBase,
    pendingSellBase,
    pendingQuote,
    baseRatio: denominator > 0 ? totalBase / denominator : 0,
  };
}

export function buildManagedCurvePlan(input: {
  pair: PairConfig;
  fairPrice: FairPriceResult;
  inventory: ManagedInventorySnapshot;
  config: ManagedStrategyConfig;
  risk: ManagedRiskPolicy;
}): ManagedCurvePlan {
  if (!input.fairPrice.ok) {
    return { ok: false, reason: input.fairPrice.detail, fairPrice: input.fairPrice, inventory: input.inventory };
  }
  const fairPrice = input.fairPrice;
  const clipped: string[] = [];
  const spreadBps = clamp(
    input.config.baseSpreadBps + input.config.volatilityBps,
    input.risk.minSpreadBps,
    input.risk.maxSpreadBps
  );
  if (spreadBps !== input.config.baseSpreadBps + input.config.volatilityBps) clipped.push("spread");
  const imbalanceBps = (input.inventory.baseRatio - input.config.targetBaseRatio) * 10_000;
  if (Math.abs(imbalanceBps) > input.risk.maxInventoryImbalanceBps) {
    return {
      ok: false,
      reason: "inventory imbalance exceeds risk policy",
      fairPrice: input.fairPrice,
      inventory: input.inventory,
    };
  }
  const inventorySkewBps = clamp(
    (imbalanceBps / 10_000) * input.config.inventorySkewBps,
    -input.risk.maxPriceDeviationBps,
    input.risk.maxPriceDeviationBps
  );
  const reservationPrice = input.fairPrice.price * (1 - inventorySkewBps / 10_000);
  const maxBaseAmount = Math.min(input.config.maxEpochBase, input.risk.maxEpochBase, input.config.maxExposureBase);
  if (maxBaseAmount <= 0) return { ok: false, reason: "max epoch size is zero", fairPrice: input.fairPrice, inventory: input.inventory };
  const curves: ManagedCurveDraft[] = [];
  if ((input.config.side === "Bid" || input.config.side === "Both") && input.risk.allowBid) {
    curves.push(buildSideCurve({ ...input, fairPrice }, "Buy", reservationPrice, spreadBps, inventorySkewBps, maxBaseAmount));
  }
  if ((input.config.side === "Ask" || input.config.side === "Both") && input.risk.allowAsk) {
    curves.push(buildSideCurve({ ...input, fairPrice }, "Sell", reservationPrice, spreadBps, inventorySkewBps, maxBaseAmount));
  }
  if (curves.length === 0) return { ok: false, reason: "risk policy disables all sides", fairPrice: input.fairPrice, inventory: input.inventory };
  return { ok: true, fairPrice, inventory: input.inventory, curves, clipped };
}

export function authorizeDelegatedMakerCurve(
  curve: ManagedCurveDraft,
  fairPrice: number,
  permission: DelegatedMakerPermission,
  now = Date.now()
): DelegatedMakerAuthorization {
  if (now >= permission.expiresAt) return { ok: false, reason: "delegated maker permission expired" };
  if (!permission.pairs.includes(curve.pair)) return { ok: false, reason: "pair not delegated" };
  if (!permission.sides.includes(curve.side)) return { ok: false, reason: "side not delegated" };
  if (!permission.relayModes.includes(curve.relayMode)) return { ok: false, reason: "relay mode not delegated" };
  if (curve.maxBaseAmount > permission.maxEpochBase) return { ok: false, reason: "curve exceeds delegated epoch size" };
  const worstDeviation = Math.max(...curve.points.map((point) => Math.abs(bps(point.price - fairPrice, fairPrice))));
  if (worstDeviation > permission.maxPriceDeviationBps) return { ok: false, reason: "curve price outside delegated band" };
  return { ok: true, curve };
}

export function compileManagedCurveIntent(curve: ManagedCurveDraft): TicketSubmitIntent {
  return {
    shape: "curve",
    side: curve.side,
    pairId: curve.pair,
    amount: String(curve.maxBaseAmount),
    limitPrice: String(curve.reservationPrice),
    priceLimit: String(curve.reservationPrice),
    minFill: "0",
    fillOrKill: false,
    resting: true,
    stratKind: "Repeat",
    curvePoints: curve.points.map((point) => ({
      price: decimalString(point.price),
      baseAmount: decimalString(point.baseAmount),
    })),
    inventoryCap: decimalString(curve.maxBaseAmount),
    durationHours: String(curve.durationHours),
    childSize: decimalString(curve.maxBaseAmount),
    jitter: 0,
    relayMode: curve.relayMode,
    relayOperator: curve.relayMode === "ZylithRelay" ? "ZylithRelay" : "SelfHostedRelay",
  };
}

export function reconcileMakerPnl(pair: string, orders: LocalOrder[]): MakerPnlSummary {
  let filledChildren = 0;
  let noFillChildren = 0;
  let baseDelta = 0;
  let quoteDelta = 0;
  let quoteNotional = 0;
  let captureNumerator = 0;
  let captureDenominator = 0;
  for (const order of orders.filter((order) => order.pair === pair)) {
    if (order.status === "no_fill") {
      noFillChildren += 1;
      continue;
    }
    if (order.status !== "filled" && order.status !== "partial") continue;
    const filled = numberValue(order.filledAmount || order.amount);
    const clearing = numberValue(order.clearingPrice);
    if (filled <= 0 || clearing <= 0) continue;
    const notional = filled * clearing;
    filledChildren += 1;
    quoteNotional += notional;
    if (order.side === "Buy") {
      baseDelta += filled;
      quoteDelta -= notional;
    } else {
      baseDelta -= filled;
      quoteDelta += notional;
    }
    const capture = makerCaptureBps(order);
    if (capture !== null) {
      captureNumerator += capture * notional;
      captureDenominator += notional;
    }
  }
  return {
    pair,
    filledChildren,
    noFillChildren,
    baseDelta,
    quoteDelta,
    quoteNotional,
    averageCaptureBps: captureDenominator > 0 ? captureNumerator / captureDenominator : null,
  };
}

export function buildMakerOpsSnapshot(input: {
  strategies: PrivateStrategySummary[];
  orders: LocalOrder[];
  balances: WalletBalance[];
  fairPrices: FairPriceResult[];
}): MakerOpsSnapshot {
  const strategySlots = input.strategies.flatMap((strategy) => strategy.submitted_children);
  return {
    activeStrategies: input.strategies.filter((strategy) => ["active", "delegated", "pending_relay"].includes(strategy.status)).length,
    delegatedStrategies: input.strategies.filter((strategy) => strategy.status === "delegated").length,
    pausedStrategies: input.strategies.filter((strategy) => strategy.status === "paused").length,
    awaitingWalletRefreshSlots: strategySlots.filter((slot) => slot.relay_status === "awaiting_wallet_refresh").length,
    failedSlots: strategySlots.filter((slot) => slot.relay_status === "failed" || slot.relay_status === "missed").length,
    staleMarketPairs: input.fairPrices.filter((price) => !price.ok).map((price) => price.pair),
    balances: input.balances,
  };
}

function buildSideCurve(
  input: {
    pair: PairConfig;
    fairPrice: FairPriceResult & { ok: true };
    config: ManagedStrategyConfig;
  },
  side: "Buy" | "Sell",
  reservationPrice: number,
  spreadBps: number,
  inventorySkewBps: number,
  maxBaseAmount: number
): ManagedCurveDraft {
  const bandCount = Math.max(1, Math.floor(input.config.bandCount));
  const perBand = Math.max(input.config.minBandBase, maxBaseAmount / bandCount);
  const points = Array.from({ length: bandCount }, (_, index) => {
    const depthBps = (index / Math.max(1, bandCount - 1)) * spreadBps;
    const signedBps = side === "Buy"
      ? -(spreadBps / 2 + depthBps)
      : spreadBps / 2 + depthBps;
    return {
      price: reservationPrice * (1 + signedBps / 10_000),
      baseAmount: perBand,
    };
  });
  return {
    pair: input.pair.pair_id,
    side,
    fairPrice: input.fairPrice.price,
    reservationPrice,
    spreadBps,
    inventorySkewBps,
    maxBaseAmount: perBand * bandCount,
    points,
    relayMode: input.config.relayMode,
    durationHours: input.config.durationHours,
  };
}

function makerCaptureBps(order: LocalOrder): number | null {
  const limit = numberValue(order.limitPrice);
  const clearing = numberValue(order.clearingPrice);
  if (limit <= 0 || clearing <= 0) return null;
  return order.side === "Buy"
    ? ((limit - clearing) / limit) * 10_000
    : ((clearing - limit) / limit) * 10_000;
}

function bps(delta: number, base: number): number {
  return base > 0 ? (delta / base) * 10_000 : Number.POSITIVE_INFINITY;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function numberValue(value?: string | number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimalString(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 18,
  });
}
