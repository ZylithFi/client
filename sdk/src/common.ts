export type OrderSide = "Buy" | "Sell";
export type StrategySide = "Bid" | "Ask" | "Both";
export type RelayMode = "SelfRelay" | "ZylithRelay";

const MIN_MANAGED_MAKER_CURVE_POINTS = 3;

export type PairConfig = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  min_order_amount: string;
  price_base_scale?: string;
  enabled: boolean;
};

export type BatchSummary = {
  batch_id: string;
  pair_id: string;
  epoch_id: number;
  close_time_unix_ms: number;
  status: "Open" | "Closed" | "Clearing" | "Settled" | "Cancelled" | "Proving" | "Settling";
  order_count_bucket: string;
};

export type TicketSubmitIntent = {
  pairId: string;
  side: OrderSide;
  shape: "limit" | "curve";
  stratKind: string;
  resting: boolean;
  amount: string;
  limitPrice: string;
  minFill: string;
  fillOrKill: boolean;
  curvePoints: Array<{ price: string; baseAmount: string }>;
  inventoryCap: string;
  durationHours: string;
  childSize: string;
  priceLimit: string;
  jitter: number;
  relayMode?: RelayMode;
  relayOperator?: "SelfHostedRelay" | "ZylithRelay";
};

export type WalletBalance = {
  asset: string;
  available: string;
  locked: string;
};

export type MakerBandAttribution = {
  version: number;
  pair_id: string;
  order_commitment: string;
  funding_note_ref: string;
  side: OrderSide;
  clearing_price: string;
  filled_base_amount: string;
  bands: Array<{
    band_index: number;
    band_price: string;
    band_base_amount: string;
    filled_base_amount: string;
  }>;
};

export type WithdrawableNote = {
  note_commitment: string;
  batch_id?: string;
  source: "deposit" | "settlement_output";
  asset: string;
  amount: string;
  locked: boolean;
  spent: boolean;
  pending_withdrawal_tx?: string;
  pending_strk20_open_note_tx?: string;
  strk20_exit_commitment?: string;
  strk20_open_note_id?: string;
  metadata_commitment: string;
  maker_attribution?: MakerBandAttribution;
};

export type LocalOrder = {
  ordRef: string;
  orderCommitment?: string;
  cancellationSecret?: string;
  batchId?: string;
  epochId?: number;
  pair: string;
  side: OrderSide;
  wireMode?: string;
  amount: string;
  filledAmount?: string;
  limitPrice?: string;
  clearingPrice?: string;
  minFill?: string;
  fillOrKill?: boolean;
  status: string;
  submittedAt?: number;
};

export type PrivateStrategySummary = {
  id: string;
  mode: string;
  pair: string;
  status: "active" | "delegated" | "pending_relay" | "paused" | string;
  total_amount?: string;
  remaining_amount?: string;
  child_amount?: string;
  max_children?: number;
  next_child_index?: number;
  start_epoch?: number;
  end_epoch?: number;
  submitted_children: Array<{
    parent_child_index?: number;
    batch_id?: string;
    epoch_id?: number;
    relay_status?: string;
    submitted_at_unix_ms?: number;
  }>;
};

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
  side: OrderSide;
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
  side: StrategySide;
  targetBaseRatio: number;
  targetBaseRatioMin?: number;
  targetBaseRatioMax?: number;
  baseSpreadBps: number;
  volatilityBps: number;
  inventorySkewBps: number;
  bandCount: number;
  maxEpochBase: number;
  minBandBase: number;
  maxExposureBase: number;
  relayMode: RelayMode;
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
  side: OrderSide;
  fairPrice: number;
  reservationPrice: number;
  spreadBps: number;
  inventorySkewBps: number;
  maxBaseAmount: number;
  points: Array<{ price: number; baseAmount: number }>;
  relayMode: RelayMode;
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
  sides: OrderSide[];
  maxEpochBase: number;
  maxPriceDeviationBps: number;
  expiresAt: number;
  relayModes: RelayMode[];
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

export type ManagedBacktestEpoch = {
  epochId: number;
  observedAt: number;
  observations: MarketObservation[];
  clearingPrice?: number;
  fillFractions?: Partial<Record<OrderSide, number>>;
  pending?: PendingExposure[];
};

export type ManagedBacktestEpochResult = {
  epochId: number;
  plan: ManagedCurvePlan;
  fills: Array<{
    side: OrderSide;
    baseAmount: number;
    quoteAmount: number;
    executionPrice: number;
  }>;
  baseBalance: number;
  quoteBalance: number;
  markedValueQuote: number;
};

export type ManagedBacktestResult = {
  pair: string;
  epochs: ManagedBacktestEpochResult[];
  finalBase: number;
  finalQuote: number;
  initialMarkedValueQuote: number;
  finalMarkedValueQuote: number;
  pnlQuote: number;
};

export type MarketDataSource = {
  id: string;
  observe(pair: string, options?: { signal?: AbortSignal }): Promise<MarketObservation | null>;
};

export type MarketDataEngineOptions = {
  sources: MarketDataSource[];
  fairPricePolicy: FairPricePolicy;
  now?: () => number;
};

export const DEFAULT_ASSET_DECIMALS: Record<string, number> = {
  STRK: 18,
  ETH: 18,
  USDC: 6,
  strkBTC: 8,
  WBTC: 8,
  USDT: 6,
};

let configuredAssetDecimals: Record<string, number> = { ...DEFAULT_ASSET_DECIMALS };

export function configureAssetDecimals(assets: Record<string, { decimals?: number }> | null | undefined): void {
  configuredAssetDecimals = { ...DEFAULT_ASSET_DECIMALS };
  for (const [assetId, metadata] of Object.entries(assets ?? {})) {
    if (typeof metadata.decimals === "number" && Number.isInteger(metadata.decimals) && metadata.decimals >= 0) {
      configuredAssetDecimals[assetId] = metadata.decimals;
    }
  }
}

export function assetDecimals(assetId: string): number {
  return configuredAssetDecimals[assetId] ?? DEFAULT_ASSET_DECIMALS[assetId] ?? 18;
}

export function toAtomicStr(human: string, assetId: string): string {
  const trimmed = human.trim();
  if (!trimmed || !/^\d*(\.\d*)?$/.test(trimmed) || trimmed === ".") return "0";
  const dec = assetDecimals(assetId);
  const [intPart = "0", fracPart = ""] = trimmed.split(".");
  const frac = fracPart.padEnd(dec, "0").slice(0, dec);
  return (BigInt(intPart || "0") * (10n ** BigInt(dec)) + BigInt(frac || "0")).toString();
}

export function toPriceAtomicStr(humanQuotePerBase: string, quoteAssetId: string): string {
  return toAtomicStr(humanQuotePerBase, quoteAssetId);
}

export function fromAtomicStr(atomic: string, assetId: string): string {
  if (!atomic || atomic === "0") return "0";
  const dec = assetDecimals(assetId);
  const n = BigInt(atomic);
  const d = 10n ** BigInt(dec);
  const int = n / d;
  const frac = n % d;
  if (frac === 0n) return int.toString();
  return `${int}.${frac.toString().padStart(dec, "0").replace(/0+$/, "")}`;
}

export function assetScale(assetId: string): bigint {
  return 10n ** BigInt(assetDecimals(assetId));
}

export class MarketDataEngine {
  private readonly sources: MarketDataSource[];
  private readonly fairPricePolicy: FairPricePolicy;
  private readonly now: () => number;

  constructor(options: MarketDataEngineOptions) {
    this.sources = options.sources;
    this.fairPricePolicy = options.fairPricePolicy;
    this.now = options.now ?? Date.now;
  }

  async observations(pair: string, options: { signal?: AbortSignal } = {}): Promise<MarketObservation[]> {
    const loaded = await Promise.allSettled(
      this.sources.map((source) => source.observe(pair, options))
    );
    return loaded
      .filter((entry): entry is PromiseFulfilledResult<MarketObservation | null> => entry.status === "fulfilled")
      .map((entry) => entry.value)
      .filter((entry): entry is MarketObservation => Boolean(entry));
  }

  async fairPrice(pair: string, options: { signal?: AbortSignal } = {}): Promise<FairPriceResult> {
    const observations = await this.observations(pair, options);
    return selectFairPrice(pair, observations, this.fairPricePolicy, this.now());
  }
}

export type HttpJsonPriceSourceOptions = {
  id: string;
  url: string | ((pair: string) => string);
  pricePath: string;
  observedAtPath?: string;
  pairPath?: string;
  headers?: Record<string, string>;
  priceScale?: number;
  fetchImpl?: typeof fetch;
};

export function createHttpJsonPriceSource(options: HttpJsonPriceSourceOptions): MarketDataSource {
  const fetcher = options.fetchImpl ?? defaultFetch();
  return {
    id: options.id,
    async observe(pair, requestOptions) {
      const url = typeof options.url === "function" ? options.url(pair) : options.url;
      const response = await fetcher(url, {
        headers: { accept: "application/json", ...options.headers },
        signal: requestOptions?.signal,
      });
      if (!response.ok) throw new Error(`Market data source ${options.id} returned HTTP ${response.status}`);
      const body = await response.json();
      const sourcePair = options.pairPath ? String(readJsonPath(body, options.pairPath) ?? "") : pair;
      if (sourcePair && normalizePair(sourcePair) !== normalizePair(pair)) return null;
      const rawPrice = readJsonPath(body, options.pricePath);
      const price = numberValue(rawPrice) / (options.priceScale ?? 1);
      if (!Number.isFinite(price) || price <= 0) return null;
      const observedAtRaw = options.observedAtPath ? readJsonPath(body, options.observedAtPath) : undefined;
      return {
        source: options.id,
        pair,
        price,
        observedAt: normalizeTimestamp(observedAtRaw) ?? Date.now(),
      };
    },
  };
}

export type StarknetOraclePriceSourceOptions = {
  id: string;
  rpcUrl: string;
  contractAddress: string;
  entrypoint: string;
  calldata: string[] | ((pair: string) => string[]);
  priceScale: number;
  timestampIndex?: number;
  fetchImpl?: typeof fetch;
};

export function createStarknetOraclePriceSource(options: StarknetOraclePriceSourceOptions): MarketDataSource {
  const fetcher = options.fetchImpl ?? defaultFetch();
  return {
    id: options.id,
    async observe(pair, requestOptions) {
      const calldata = typeof options.calldata === "function" ? options.calldata(pair) : options.calldata;
      const response = await fetcher(options.rpcUrl, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "starknet_call",
          params: {
            request: {
              contract_address: options.contractAddress,
              entry_point_selector: options.entrypoint,
              calldata,
            },
            block_id: "latest",
          },
        }),
        signal: requestOptions?.signal,
      });
      if (!response.ok) throw new Error(`Oracle source ${options.id} returned HTTP ${response.status}`);
      const body = await response.json() as { result?: string[]; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? `Oracle source ${options.id} failed`);
      const result = body.result ?? [];
      const price = feltNumber(result[0]) / options.priceScale;
      if (!Number.isFinite(price) || price <= 0) return null;
      const timestampFelt = options.timestampIndex === undefined ? undefined : result[options.timestampIndex];
      return {
        source: options.id,
        pair,
        price,
        observedAt: normalizeTimestamp(timestampFelt === undefined ? undefined : feltNumber(timestampFelt)) ?? Date.now(),
      };
    },
  };
}

export type PublicSettlementTranscript = {
  batch_id: string;
  pair_id: string;
  batch_epoch: number;
  clearing_price: string | number;
  price_base_scale?: string | number;
  published_at_unix_ms?: number;
  settled_at_unix_ms?: number;
  loaded_at_unix_ms?: number;
};

export function createLastClearingAnalyticsSource(
  id: string,
  transcripts: Record<string, PublicSettlementTranscript>,
  now: () => number = Date.now
): MarketDataSource {
  return {
    id,
    async observe(pair) {
      const latest = Object.values(transcripts)
        .filter((transcript) => transcript.pair_id === pair)
        .sort((left, right) => right.batch_epoch - left.batch_epoch)[0];
      if (!latest) return null;
      const price = numberValue(latest.clearing_price) / numberValue(latest.price_base_scale ?? 1);
      if (!Number.isFinite(price) || price <= 0) return null;
      return {
        source: id,
        pair,
        price,
        observedAt: latest.settled_at_unix_ms ?? latest.published_at_unix_ms ?? latest.loaded_at_unix_ms ?? now(),
      };
    },
  };
}

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
      const amount = numericValue(order.amount);
      const price = numericValue(order.limitPrice || order.clearingPrice);
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
  const availableBase = numericValue(baseBalance?.available);
  const availableQuote = numericValue(quoteBalance?.available);
  const lockedBase = numericValue(baseBalance?.locked);
  const lockedQuote = numericValue(quoteBalance?.locked);
  const pairPending = pending.filter((exposure) => exposure.pair === pair.pair_id);
  const pendingBuyBase = pairPending
    .filter((exposure) => exposure.side === "Buy")
    .reduce((sum, exposure) => sum + exposure.baseAmount, 0);
  const pendingSellBase = pairPending
    .filter((exposure) => exposure.side === "Sell")
    .reduce((sum, exposure) => sum + exposure.baseAmount, 0);
  const pendingQuote = pairPending
    .filter((exposure) => exposure.side === "Buy")
    .reduce((sum, exposure) => sum + exposure.quoteAmount, 0);
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
  const target = targetBand(input.config);
  const spreadBps = clamp(
    input.config.baseSpreadBps + input.config.volatilityBps,
    input.risk.minSpreadBps,
    input.risk.maxSpreadBps
  );
  if (Math.floor(input.config.bandCount) < MIN_MANAGED_MAKER_CURVE_POINTS) {
    return { ok: false, reason: "maker curve requires at least 3 bands", fairPrice: input.fairPrice, inventory: input.inventory };
  }
  if (spreadBps < makerCurveMinSpreadBps(input.pair.pair_id)) {
    return { ok: false, reason: "maker curve spread is below protocol minimum", fairPrice: input.fairPrice, inventory: input.inventory };
  }
  if (spreadBps !== input.config.baseSpreadBps + input.config.volatilityBps) clipped.push("spread");
  const imbalanceRatio = inventoryImbalanceRatio(input.inventory.baseRatio, target);
  const imbalanceBps = imbalanceRatio * 10_000;
  const forceAskOnly = imbalanceBps > input.risk.maxInventoryImbalanceBps;
  const forceBidOnly = imbalanceBps < -input.risk.maxInventoryImbalanceBps;
  if (forceAskOnly) clipped.push("bid-disabled-by-inventory");
  if (forceBidOnly) clipped.push("ask-disabled-by-inventory");
  const inventorySkewBps = clamp(
    imbalanceRatio * input.config.inventorySkewBps,
    -input.risk.maxPriceDeviationBps,
    input.risk.maxPriceDeviationBps
  );
  const reservationPrice = input.fairPrice.price * (1 - inventorySkewBps / 10_000);
  const maxBaseAmount = Math.min(input.config.maxEpochBase, input.risk.maxEpochBase, input.config.maxExposureBase);
  if (maxBaseAmount <= 0) return { ok: false, reason: "max epoch size is zero", fairPrice: input.fairPrice, inventory: input.inventory };
  const curves: ManagedCurveDraft[] = [];
  if (!forceAskOnly && (input.config.side === "Bid" || input.config.side === "Both") && input.risk.allowBid) {
    const quoteCapacity = Math.max(0, input.inventory.availableQuote - input.inventory.pendingQuote);
    const capacityPrice = Math.max(reservationPrice, input.fairPrice.price);
    const quoteCapacityBase = capacityPrice > 0 ? quoteCapacity / capacityPrice : 0;
    const buyBaseAmount = Math.min(maxBaseAmount, quoteCapacityBase);
    const curve = buildSideCurve({ ...input, fairPrice }, "Buy", reservationPrice, spreadBps, inventorySkewBps, buyBaseAmount);
    if (curve) curves.push(curve);
  }
  if (!forceBidOnly && (input.config.side === "Ask" || input.config.side === "Both") && input.risk.allowAsk) {
    const baseCapacity = Math.max(0, input.inventory.availableBase - input.inventory.pendingSellBase);
    const sellBaseAmount = Math.min(maxBaseAmount, baseCapacity);
    const curve = buildSideCurve({ ...input, fairPrice }, "Sell", reservationPrice, spreadBps, inventorySkewBps, sellBaseAmount);
    if (curve) curves.push(curve);
  }
  if (curves.length === 0) return { ok: false, reason: "insufficient inventory for generated sides", fairPrice: input.fairPrice, inventory: input.inventory };
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
  const invalid = validateManagedCurveDraft(curve);
  if (invalid) throw new Error(invalid);
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

export function validateManagedCurveDraft(curve: ManagedCurveDraft): string | null {
  if (curve.points.length < MIN_MANAGED_MAKER_CURVE_POINTS) {
    return "maker curve requires at least 3 bands";
  }
  let previousPrice = 0;
  for (const point of curve.points) {
    if (!Number.isFinite(point.price) || !Number.isFinite(point.baseAmount) || point.price <= 0 || point.baseAmount <= 0) {
      return "maker curve prices and base amounts must be positive";
    }
    if (point.price <= previousPrice) return "maker curve points must be strictly increasing by price";
    previousPrice = point.price;
  }
  const first = curve.points[0]?.price ?? 0;
  const last = curve.points[curve.points.length - 1]?.price ?? 0;
  const outerSpreadBps = first > 0 ? ((last - first) / first) * 10_000 : 0;
  if (outerSpreadBps < makerCurveMinSpreadBps(curve.pair)) {
    return "maker curve spread is below protocol minimum";
  }
  return null;
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
    const filled = numericValue(order.filledAmount || order.amount);
    const clearing = numericValue(order.clearingPrice);
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

export function backtestManagedStrategy(input: {
  pair: PairConfig;
  initialBase: number;
  initialQuote: number;
  fairPricePolicy: FairPricePolicy;
  strategy: ManagedStrategyConfig;
  risk: ManagedRiskPolicy;
  epochs: ManagedBacktestEpoch[];
}): ManagedBacktestResult {
  let base = Math.max(0, input.initialBase);
  let quote = Math.max(0, input.initialQuote);
  const initialPrice = firstUsablePrice(input.pair.pair_id, input.epochs, input.fairPricePolicy)
    ?? input.epochs.find((epoch) => epoch.clearingPrice && epoch.clearingPrice > 0)?.clearingPrice
    ?? 0;
  const initialMarkedValueQuote = quote + base * initialPrice;
  const epochs: ManagedBacktestEpochResult[] = [];
  let lastMarkPrice = initialPrice;

  for (const epoch of input.epochs) {
    const fairPrice = selectFairPrice(
      input.pair.pair_id,
      epoch.observations,
      input.fairPricePolicy,
      epoch.observedAt
    );
    if (fairPrice.ok) lastMarkPrice = fairPrice.price;
    const inventory = buildInventorySnapshot(
      input.pair,
      [
        { asset: input.pair.base_asset_id, available: String(base), locked: "0" },
        { asset: input.pair.quote_asset_id, available: String(quote), locked: "0" },
      ],
      epoch.pending ?? [],
      fairPrice.ok ? fairPrice.price : lastMarkPrice
    );
    const plan = buildManagedCurvePlan({
      pair: input.pair,
      fairPrice,
      inventory,
      config: input.strategy,
      risk: input.risk,
    });
    const fills: ManagedBacktestEpochResult["fills"] = [];
    if (plan.ok) {
      for (const curve of plan.curves) {
        const fillFraction = clamp(epoch.fillFractions?.[curve.side] ?? 0, 0, 1);
        const fillBase = totalCurveBase(curve) * fillFraction;
        if (fillBase <= 0) continue;
        const executionPrice = epoch.clearingPrice && epoch.clearingPrice > 0
          ? epoch.clearingPrice
          : weightedCurvePrice(curve);
        if (curve.side === "Buy") {
          const affordableBase = executionPrice > 0 ? Math.min(fillBase, quote / executionPrice) : 0;
          if (affordableBase <= 0) continue;
          base += affordableBase;
          quote -= affordableBase * executionPrice;
          fills.push({ side: "Buy", baseAmount: affordableBase, quoteAmount: affordableBase * executionPrice, executionPrice });
        } else {
          const sellBase = Math.min(fillBase, base);
          if (sellBase <= 0) continue;
          base -= sellBase;
          quote += sellBase * executionPrice;
          fills.push({ side: "Sell", baseAmount: sellBase, quoteAmount: sellBase * executionPrice, executionPrice });
        }
      }
    }
    epochs.push({
      epochId: epoch.epochId,
      plan,
      fills,
      baseBalance: base,
      quoteBalance: quote,
      markedValueQuote: quote + base * lastMarkPrice,
    });
  }

  const finalMarkedValueQuote = quote + base * lastMarkPrice;
  return {
    pair: input.pair.pair_id,
    epochs,
    finalBase: base,
    finalQuote: quote,
    initialMarkedValueQuote,
    finalMarkedValueQuote,
    pnlQuote: finalMarkedValueQuote - initialMarkedValueQuote,
  };
}

export function readJsonPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function buildSideCurve(
  input: {
    pair: PairConfig;
    fairPrice: FairPriceResult & { ok: true };
    config: ManagedStrategyConfig;
  },
  side: OrderSide,
  reservationPrice: number,
  spreadBps: number,
  inventorySkewBps: number,
  maxBaseAmount: number
): ManagedCurveDraft | null {
  if (!Number.isFinite(maxBaseAmount) || maxBaseAmount <= 0) return null;
  const requestedBandCount = Math.max(MIN_MANAGED_MAKER_CURVE_POINTS, Math.floor(input.config.bandCount));
  const minBandBase = Math.max(makerCurveMinBandBaseAmount(input.pair.pair_id), input.config.minBandBase);
  const bandCount = minBandBase > 0
    ? Math.min(requestedBandCount, Math.floor(maxBaseAmount / minBandBase))
    : requestedBandCount;
  if (bandCount < MIN_MANAGED_MAKER_CURVE_POINTS) return null;
  const perBand = maxBaseAmount / bandCount;
  if (minBandBase > 0 && perBand < minBandBase) return null;
  const points = Array.from({ length: bandCount }, (_, index) => {
    const depthBps = (index / Math.max(1, bandCount - 1)) * spreadBps;
    const signedBps = side === "Buy"
      ? -(spreadBps / 2 + (spreadBps - depthBps))
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
    maxBaseAmount,
    points,
    relayMode: input.config.relayMode,
    durationHours: input.config.durationHours,
  };
}

function makerCaptureBps(order: LocalOrder): number | null {
  const limit = numericValue(order.limitPrice);
  const clearing = numericValue(order.clearingPrice);
  if (limit <= 0 || clearing <= 0) return null;
  return order.side === "Buy"
    ? ((limit - clearing) / limit) * 10_000
    : ((clearing - limit) / limit) * 10_000;
}

function targetBand(config: ManagedStrategyConfig): { min: number; max: number; mid: number } {
  const min = typeof config.targetBaseRatioMin === "number" && Number.isFinite(config.targetBaseRatioMin)
    ? clamp(config.targetBaseRatioMin, 0, 1)
    : undefined;
  const max = typeof config.targetBaseRatioMax === "number" && Number.isFinite(config.targetBaseRatioMax)
    ? clamp(config.targetBaseRatioMax, 0, 1)
    : undefined;
  if (min !== undefined && max !== undefined && min <= max) return { min, max, mid: (min + max) / 2 };
  const point = clamp(config.targetBaseRatio, 0, 1);
  return { min: point, max: point, mid: point };
}

function inventoryImbalanceRatio(baseRatio: number, target: { min: number; max: number; mid: number }): number {
  if (baseRatio < target.min) return baseRatio - target.min;
  if (baseRatio > target.max) return baseRatio - target.max;
  return 0;
}

function totalCurveBase(curve: ManagedCurveDraft): number {
  return curve.points.reduce((sum, point) => sum + point.baseAmount, 0);
}

function weightedCurvePrice(curve: ManagedCurveDraft): number {
  const total = totalCurveBase(curve);
  if (total <= 0) return curve.reservationPrice;
  return curve.points.reduce((sum, point) => sum + point.price * point.baseAmount, 0) / total;
}

function firstUsablePrice(
  pair: string,
  epochs: ManagedBacktestEpoch[],
  policy: FairPricePolicy
): number | null {
  for (const epoch of epochs) {
    const fairPrice = selectFairPrice(pair, epoch.observations, policy, epoch.observedAt);
    if (fairPrice.ok) return fairPrice.price;
  }
  return null;
}

function makerCurveMinBandBaseAmount(pairId: string): number {
  if (pairId === "ETH/USDC") return 0.001;
  if (pairId === "strkBTC/USDC" || pairId === "WBTC/strkBTC") return 0.001;
  if (pairId === "USDC/USDT") return 1;
  if (pairId === "STRK/USDC" || pairId === "STRK/ETH" || pairId === "STRK/strkBTC") return 1;
  return 0;
}

function makerCurveMinSpreadBps(pairId: string): number {
  if (pairId === "USDC/USDT") return 5;
  if (pairId === "WBTC/strkBTC") return 10;
  return 20;
}

function bps(delta: number, base: number): number {
  return base > 0 ? (delta / base) * 10_000 : Number.POSITIVE_INFINITY;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function numericValue(value?: string | number): number {
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

function normalizePair(pair: string): string {
  return pair.replace(/[-_]/g, "/").toUpperCase();
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value.replace(/,/g, ""));
  return Number.NaN;
}

function normalizeTimestamp(value: unknown): number | undefined {
  const parsed = numberValue(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function feltNumber(value: string | undefined): number {
  if (!value) return Number.NaN;
  try {
    return Number(BigInt(value));
  } catch {
    return Number.NaN;
  }
}

function defaultFetch(): typeof fetch {
  return fetch.bind(globalThis);
}
