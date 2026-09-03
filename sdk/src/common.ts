export type OrderSide = "Buy" | "Sell";
export type RelayMode = "SelfRelay" | "ZylithRelay";

export const DEFAULT_SDK_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SDK_RESPONSE_MAX_BYTES = 1_048_576;
export const DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES = 65_536;
export const MAX_MARKET_OBSERVATION_FUTURE_SKEW_MS = 60_000;

export type PairConfig = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  min_order_amount: string;
  price_base_scale?: string;
  taker_fee_bps?: number;
  relay_fee_bps?: number;
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

const BATCH_SUMMARY_STATUSES = new Set<BatchSummary["status"]>([
  "Open",
  "Closed",
  "Clearing",
  "Settled",
  "Cancelled",
  "Proving",
  "Settling",
]);

export function parseBatchSummary(value: unknown, label = "Coordinator batch response"): BatchSummary {
  const record = sdkObjectRecord(value, label);
  const status = sdkRequiredString(record.status, "batch status");
  if (!BATCH_SUMMARY_STATUSES.has(status as BatchSummary["status"])) {
    throw new Error("Coordinator returned an invalid batch status");
  }
  return {
    batch_id: sdkRequiredString(record.batch_id, "batch id"),
    pair_id: sdkRequiredString(record.pair_id, "pair id"),
    epoch_id: sdkNonNegativeSafeInteger(record.epoch_id, "batch epoch"),
    close_time_unix_ms: sdkNonNegativeSafeInteger(record.close_time_unix_ms, "batch close time"),
    status: status as BatchSummary["status"],
    order_count_bucket: sdkRequiredString(record.order_count_bucket, "order count bucket"),
  };
}

function sdkObjectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sdkRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}

function sdkNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}

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

export type LiquidityBandAttribution = {
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
  liquidity_provider_attribution?: LiquidityBandAttribution;
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

export type LiquidityInventorySnapshot = {
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

export type LiquidityOpsSnapshot = {
  activeStrategies: number;
  delegatedStrategies: number;
  pausedStrategies: number;
  awaitingWalletRefreshSlots: number;
  failedSlots: number;
  staleMarketPairs: string[];
  balances: WalletBalance[];
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
    if (
      typeof metadata.decimals === "number" &&
      Number.isInteger(metadata.decimals) &&
      metadata.decimals >= 0 &&
      metadata.decimals <= 255
    ) {
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
  if (!/^\d+$/.test(atomic)) throw new Error(`Invalid atomic amount for ${assetId}`);
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
    if (!Array.isArray(options.sources) || options.sources.length === 0) {
      throw new Error("Market data engine requires at least one source");
    }
    validateFairPricePolicy(options.fairPricePolicy);
    const sourceIds = new Set<string>();
    for (const source of options.sources) {
      if (!source || typeof source !== "object" || typeof source.observe !== "function") {
        throw new Error("Market data source is invalid");
      }
      if (typeof source.id !== "string") {
        throw new Error("Market data source id is required");
      }
      const sourceId = source.id.trim().toLowerCase();
      if (!sourceId) throw new Error("Market data source id is required");
      if (sourceIds.has(sourceId)) throw new Error(`Duplicate market data source id: ${source.id}`);
      sourceIds.add(sourceId);
    }
    if (options.fairPricePolicy.minSources > sourceIds.size) {
      throw new Error("Fair price minimum source count exceeds configured sources");
    }
    this.sources = [...options.sources];
    this.fairPricePolicy = { ...options.fairPricePolicy };
    this.now = options.now ?? Date.now;
  }

  async observations(pair: string, options: { signal?: AbortSignal } = {}): Promise<MarketObservation[]> {
    const loaded = await Promise.all(
      this.sources.map((source) => observeMarketSource(source, pair, options))
    );
    return loaded
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
      const serviceUrl = normalizeSdkServiceUrl(url, `market data source ${options.id}`);
      let response: Response;
      try {
        response = await fetchWithSdkTimeout(fetcher, serviceUrl, {
          headers: { accept: "application/json", ...options.headers },
          signal: requestOptions?.signal,
        });
      } catch (error) {
        if (requestOptions?.signal?.aborted) throw error;
        if (isTransientFetchError(error)) return null;
        throw error;
      }
      if (!response.ok) {
        if (isTransientHttpStatus(response.status)) return null;
        throw new Error(`Market data source ${options.id} returned HTTP ${response.status}`);
      }
      const body = await readSdkJsonResponse(response, {
        signal: requestOptions?.signal,
        label: `Market data source ${options.id}`,
      });
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
  priceScale?: number;
  decimalsIndex?: number;
  timestampIndex?: number;
  sourceCountIndex?: number;
  minSourceCount?: number;
  fetchImpl?: typeof fetch;
};

export function createStarknetOraclePriceSource(options: StarknetOraclePriceSourceOptions): MarketDataSource {
  const fetcher = options.fetchImpl ?? defaultFetch();
  const rpcUrl = normalizeSdkServiceUrl(options.rpcUrl, `oracle source ${options.id} RPC URL`);
  return {
    id: options.id,
    async observe(pair, requestOptions) {
      const calldata = typeof options.calldata === "function" ? options.calldata(pair) : options.calldata;
      let response: Response;
      try {
        response = await fetchWithSdkTimeout(fetcher, rpcUrl, {
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
      } catch (error) {
        if (requestOptions?.signal?.aborted) throw error;
        if (isTransientFetchError(error)) return null;
        throw error;
      }
      if (!response.ok) {
        if (isTransientHttpStatus(response.status)) return null;
        throw new Error(`Oracle source ${options.id} returned HTTP ${response.status}`);
      }
      const body = await readSdkJsonResponse(response, {
        signal: requestOptions?.signal,
        label: `Oracle source ${options.id}`,
      }) as { result?: string[]; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? `Oracle source ${options.id} failed`);
      const result = body.result ?? [];
      const decimals = options.decimalsIndex === undefined
        ? undefined
        : feltNumber(result[options.decimalsIndex]);
      const priceScale = options.priceScale
        ?? (Number.isSafeInteger(decimals) && decimals !== undefined && decimals >= 0
          ? 10 ** decimals
          : undefined);
      if (!priceScale || !Number.isFinite(priceScale) || priceScale <= 0) {
        throw new Error(`Oracle source ${options.id} did not return a valid price scale`);
      }
      if (options.sourceCountIndex !== undefined && options.minSourceCount !== undefined) {
        const sourceCount = feltNumber(result[options.sourceCountIndex]);
        if (!Number.isSafeInteger(sourceCount) || sourceCount < options.minSourceCount) return null;
      }
      const price = feltNumber(result[0]) / priceScale;
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

export type RatioPriceSourceOptions = {
  id: string;
  pair: string;
  numeratorPair: string;
  denominatorPair: string;
  numerator: MarketDataSource;
  denominator: MarketDataSource;
};

export function createRatioPriceSource(options: RatioPriceSourceOptions): MarketDataSource {
  return {
    id: options.id,
    async observe(pair, requestOptions) {
      if (normalizePair(pair) !== normalizePair(options.pair)) return null;
      const [numerator, denominator] = await Promise.all([
        observeMarketSource(options.numerator, options.numeratorPair, requestOptions),
        observeMarketSource(options.denominator, options.denominatorPair, requestOptions),
      ]);
      if (!numerator || !denominator || denominator.price <= 0) return null;
      const price = numerator.price / denominator.price;
      if (!Number.isFinite(price) || price <= 0) return null;
      return {
        source: options.id,
        pair,
        price,
        observedAt: Math.min(numerator.observedAt, denominator.observedAt),
        confidenceBps: Math.max(numerator.confidenceBps ?? 0, denominator.confidenceBps ?? 0),
      };
    },
  };
}

export function createPairScopedPriceSource(
  source: MarketDataSource,
  pairs: string[],
): MarketDataSource {
  const allowed = new Set(pairs.map(normalizePair));
  return {
    id: source.id,
    observe(pair, options) {
      if (!allowed.has(normalizePair(pair))) return Promise.resolve(null);
      return source.observe(pair, options);
    },
  };
}

export function selectFairPrice(
  pair: string,
  observations: MarketObservation[],
  policy: FairPricePolicy,
  now = Date.now()
): FairPriceResult {
  validateFairPricePolicy(policy);
  const targetPair = normalizePair(pair);
  const fresh = observations
    .filter((observation) => normalizePair(observation.pair) === targetPair && observation.price > 0)
    .filter((observation) =>
      observation.observedAt <= now + MAX_MARKET_OBSERVATION_FUTURE_SKEW_MS &&
      now - observation.observedAt <= policy.maxStalenessMs
    );
  const uniqueFresh = uniqueObservationsBySource(fresh);
  if (uniqueFresh.length === 0) {
    return { ok: false, pair, reason: "no_sources", detail: "No fresh reference prices are available." };
  }
  if (uniqueFresh.length < policy.minSources) {
    return { ok: false, pair, reason: "stale", detail: `Only ${uniqueFresh.length} fresh source(s) available.` };
  }
  const prices = uniqueFresh.map((observation) => observation.price).sort((a, b) => a - b);
  const median = prices.length % 2 === 1
    ? prices[Math.floor(prices.length / 2)]
    : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  const maxDivergenceBps = Math.max(
    ...uniqueFresh.map((observation) => Math.abs(bps(observation.price - median, median)))
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
    observedAt: Math.max(...uniqueFresh.map((observation) => observation.observedAt)),
    sources: uniqueFresh.map((observation) => observation.source),
    maxDivergenceBps,
  };
}

export function pendingExposureFromOrders(orders: LocalOrder[]): PendingExposure[] {
  return orders
    .filter((order) => ["queued", "in_batch", "proving", "settling", "settled_pending_output"].includes(order.status))
    .map((order) => {
      const amount = nonNegativeNumericValue(order.amount);
      const price = nonNegativeNumericValue(order.limitPrice || order.clearingPrice);
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

function uniqueObservationsBySource(observations: MarketObservation[]): MarketObservation[] {
  const bySource = new Map<string, MarketObservation>();
  for (const observation of observations) {
    const key = observation.source.trim().toLowerCase();
    if (!key) continue;
    const existing = bySource.get(key);
    if (!existing || observation.observedAt >= existing.observedAt) {
      bySource.set(key, observation);
    }
  }
  return [...bySource.values()];
}

export function buildInventorySnapshot(
  pair: PairConfig,
  balances: WalletBalance[],
  pending: PendingExposure[] = [],
  referencePrice?: number
): LiquidityInventorySnapshot {
  const baseBalance = balances.find((balance) => balance.asset === pair.base_asset_id);
  const quoteBalance = balances.find((balance) => balance.asset === pair.quote_asset_id);
  const availableBase = nonNegativeNumericValue(baseBalance?.available);
  const availableQuote = nonNegativeNumericValue(quoteBalance?.available);
  const lockedBase = nonNegativeNumericValue(baseBalance?.locked);
  const lockedQuote = nonNegativeNumericValue(quoteBalance?.locked);
  const pairPending = pending.filter((exposure) => exposure.pair === pair.pair_id);
  const pendingBuyBase = pairPending
    .filter((exposure) => exposure.side === "Buy")
    .reduce((sum, exposure) => sum + Math.max(0, exposure.baseAmount), 0);
  const pendingSellBase = pairPending
    .filter((exposure) => exposure.side === "Sell")
    .reduce((sum, exposure) => sum + Math.max(0, exposure.baseAmount), 0);
  const pendingQuote = pairPending
    .filter((exposure) => exposure.side === "Buy")
    .reduce((sum, exposure) => sum + Math.max(0, exposure.quoteAmount), 0);
  const projectedBase = Math.max(0, availableBase + lockedBase + pendingBuyBase - pendingSellBase);
  const projectedQuote = Math.max(0, availableQuote + lockedQuote - pendingQuote);
  const totalQuoteAsBase = projectedQuote > 0 && referencePrice && referencePrice > 0 ? projectedQuote / referencePrice : 0;
  const denominator = projectedBase + totalQuoteAsBase;
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
    baseRatio: denominator > 0 ? projectedBase / denominator : 0,
  };
}

export function buildLiquidityOpsSnapshot(input: {
  strategies: PrivateStrategySummary[];
  orders: LocalOrder[];
  balances: WalletBalance[];
  fairPrices: FairPriceResult[];
}): LiquidityOpsSnapshot {
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

function bps(delta: number, base: number): number {
  return base > 0 ? (delta / base) * 10_000 : Number.POSITIVE_INFINITY;
}

function numericValue(value?: string | number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeNumericValue(value?: string | number): number {
  return Math.max(0, numericValue(value));
}

function normalizePair(pair: string): string {
  return pair.replace(/[-_]/g, "/").toUpperCase();
}

function isNonZeroHexFelt(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) return false;
  return BigInt(trimmed) !== 0n;
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

async function observeMarketSource(
  source: MarketDataSource,
  pair: string,
  options?: { signal?: AbortSignal }
): Promise<MarketObservation | null> {
  try {
    const observation = await abortable(
      source.observe(pair, options),
      options?.signal,
      "Zylith SDK market data request aborted"
    );
    return observation === null ? null : validateMarketObservation(observation, source.id);
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    if (isTransientMarketSourceError(error)) return null;
    throw error;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error(message));
  let rejectAbort: ((error: Error) => void) | undefined;
  const abortPromise = new Promise<T>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort?.(new Error(message));
  signal.addEventListener("abort", abort, { once: true });
  return Promise.race([promise, abortPromise]).finally(() => {
    signal.removeEventListener("abort", abort);
  });
}

function defaultFetch(): typeof fetch {
  return fetch.bind(globalThis);
}

export async function fetchWithSdkTimeout(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_SDK_REQUEST_TIMEOUT_MS
): Promise<Response> {
  if (init.signal?.aborted) {
    throw new Error("Zylith SDK request aborted");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetcher(input, init);
  }
  const controller = new AbortController();
  const sourceSignal = init.signal;
  let timedOut = false;
  let sourceAborted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const abortPromise = new Promise<Response>((_, reject) => {
    rejectAbort = reject;
  });
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
      reject(new Error("Zylith SDK request timed out"));
    }, timeoutMs);
  });
  const forwardAbort = () => {
    sourceAborted = true;
    controller.abort(sourceSignal?.reason ?? new DOMException("Request aborted", "AbortError"));
    rejectAbort?.(new Error("Zylith SDK request aborted"));
  };
  if (sourceSignal?.aborted) {
    forwardAbort();
  } else {
    sourceSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  try {
    return await Promise.race([
      fetcher(input, { ...init, signal: controller.signal }),
      timeoutPromise,
      abortPromise,
    ]);
  } catch (error) {
    if (timedOut) throw new Error("Zylith SDK request timed out");
    if (sourceAborted) throw new Error("Zylith SDK request aborted");
    if (isTransientFetchError(error)) throw new Error("Network request failed. Check your connection and retry.");
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", forwardAbort);
  }
}

export type SdkResponseReadOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  label?: string;
};

export async function readSdkJsonResponse(
  response: Response,
  options: SdkResponseReadOptions = {}
): Promise<unknown> {
  const label = options.label ?? "SDK response";
  const text = await readSdkResponseText(response, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function readSdkResponseText(
  response: Response,
  options: SdkResponseReadOptions = {}
): Promise<string> {
  const label = options.label ?? "SDK response";
  const maxBytes = positiveResponseLimit(options.maxBytes ?? DEFAULT_SDK_RESPONSE_MAX_BYTES);
  const timeoutMs = positiveResponseLimit(options.timeoutMs ?? DEFAULT_SDK_REQUEST_TIMEOUT_MS);
  if (options.signal?.aborted) throw new Error("Zylith SDK request aborted");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`${label} exceeded the ${maxBytes}-byte response limit`);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let aborted = false;
  let rejectInterruption: ((error: Error) => void) | undefined;
  const interruption = new Promise<never>((_, reject) => {
    rejectInterruption = reject;
  });
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  const abort = () => {
    aborted = true;
    cancelReader();
    rejectInterruption?.(new Error("Zylith SDK request aborted"));
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  timeout = setTimeout(() => {
    timedOut = true;
    cancelReader();
    rejectInterruption?.(new Error(`${label} body timed out`));
  }, timeoutMs);

  try {
    while (true) {
      const result = await Promise.race([reader.read(), interruption]);
      if (result.done) {
        if (aborted) throw new Error("Zylith SDK request aborted");
        if (timedOut) throw new Error(`${label} body timed out`);
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        cancelReader();
        throw new Error(`${label} exceeded the ${maxBytes}-byte response limit`);
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (aborted) throw new Error("Zylith SDK request aborted");
    if (timedOut) throw new Error(`${label} body timed out`);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {
      cancelReader();
    }
  }
}

export function normalizeSdkServiceUrl(value: string, label = "service URL"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.protocol === "https:") return stripTrailingSlash(parsed.toString());
  if (parsed.protocol === "http:" && isLocalDevelopmentHost(parsed.hostname)) {
    return stripTrailingSlash(parsed.toString());
  }
  throw new Error(`${label} must use HTTPS; HTTP is allowed only for localhost development`);
}

function positiveResponseLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("SDK response limits must be positive safe integers");
  }
  return value;
}

export function sanitizeSdkErrorMessage(value: unknown, fallback = "Zylith SDK request failed"): string {
  const raw = rawErrorMessage(value, fallback);
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  return trimmed
    .replace(/"calldata"\s*:\s*\[[^\]]*\]/gi, '"calldata":[...]')
    .replace(/"signature"\s*:\s*\[[^\]]*\]/gi, '"signature":[...]')
    .replace(/"private[^"]*"\s*:\s*"[^"]*"/gi, '"private":"<redacted>"')
    .replace(/0x[0-9a-fA-F]{33,}/g, "<felt>")
    .replace(/\b[0-9]{32,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}

function rawErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") {
    const parsed = parseJsonError(value);
    return parsed ?? value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["error", "detail", "message", "reason"]) {
      const entry = record[key];
      if (typeof entry === "string" && entry.trim()) return entry;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parseJsonError(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    for (const key of ["error", "detail", "message", "reason"]) {
      const entry = parsed[key];
      if (typeof entry === "string" && entry.trim()) return entry;
    }
  } catch {
    return null;
  }
  return null;
}

function isTransientFetchError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const name = error instanceof Error ? error.name : "";
  return (
    /AbortError|TimeoutError/i.test(name) ||
    /signal is aborted|aborted without reason|operation was aborted|timed out|request aborted|network request failed|failed to fetch|networkerror|load failed|fetch failed/i.test(
      message
    )
  );
}

function isTransientMarketSourceError(error: unknown): boolean {
  if (isTransientFetchError(error)) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\bHTTP\s+(408|429|5\d\d)\b|rate.?limit|temporar/i.test(message);
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function validateFairPricePolicy(policy: FairPricePolicy): void {
  if (!Number.isFinite(policy.maxStalenessMs) || policy.maxStalenessMs <= 0) {
    throw new Error("Fair price max staleness must be positive");
  }
  if (!Number.isFinite(policy.maxDivergenceBps) || policy.maxDivergenceBps < 0) {
    throw new Error("Fair price max divergence must be non-negative");
  }
  if (!Number.isSafeInteger(policy.minSources) || policy.minSources <= 0) {
    throw new Error("Fair price minimum source count must be a positive integer");
  }
}

function validateMarketObservation(observation: MarketObservation, expectedSourceId: string): MarketObservation {
  if (!observation || typeof observation !== "object") {
    throw new Error(`Market data source ${expectedSourceId} returned an invalid observation`);
  }
  if (
    typeof observation.source !== "string" ||
    observation.source.trim().toLowerCase() !== expectedSourceId.trim().toLowerCase()
  ) {
    throw new Error(`Market data source ${expectedSourceId} returned a mismatched source id`);
  }
  if (typeof observation.pair !== "string" || !observation.pair.trim()) {
    throw new Error(`Market data source ${expectedSourceId} returned an invalid pair`);
  }
  if (!Number.isFinite(observation.price) || observation.price <= 0) {
    throw new Error(`Market data source ${expectedSourceId} returned an invalid price`);
  }
  if (!Number.isFinite(observation.observedAt) || observation.observedAt <= 0) {
    throw new Error(`Market data source ${expectedSourceId} returned an invalid timestamp`);
  }
  if (
    observation.confidenceBps !== undefined &&
    (!Number.isFinite(observation.confidenceBps) || observation.confidenceBps < 0)
  ) {
    throw new Error(`Market data source ${expectedSourceId} returned invalid confidence`);
  }
  return { ...observation };
}
