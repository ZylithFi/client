import type { PublicSettlementTranscript } from "./auctionEpoch";
import {
  selectFairPrice,
  type FairPricePolicy,
  type FairPriceResult,
  type MarketObservation,
} from "./managedLiquidity";

export type MarketDataSource = {
  id: string;
  observe(pair: string, options?: { signal?: AbortSignal }): Promise<MarketObservation | null>;
};

export type MarketDataEngineOptions = {
  sources: MarketDataSource[];
  fairPricePolicy: FairPricePolicy;
  now?: () => number;
};

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
  const fetcher = options.fetchImpl ?? fetch;
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
  const fetcher = options.fetchImpl ?? fetch;
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

export function createLastClearingPriceSource(
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
