import { readSdkJsonResponse } from "@zylith/sdk";
import { fetchWithTimeout } from "../../domain/runtimeHttp";

// market data comes only from zylith's same-origin proxy. the browser never
// contacts an exchange: upstream venues see zylith's egress address, not a
// trader's ip, origin or pair interest.

export const MARKET_DATA_BASE_PATH = "/market-data/v1";

export type VenueName = "Binance" | "Coinbase" | "Kraken" | "OKX";

export type VenueBbo = {
  venue: VenueName;
  bid: number;
  ask: number;
  observedAtUnixMs?: number;
};

export type MarketCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type MarketStats = {
  last: number;
  changePercent: number;
  high: number;
  low: number;
  quoteVolume: number;
};

export type MarketSummary = {
  bbos: VenueBbo[];
  stats: MarketStats | null;
};

const VENUES = new Set<VenueName>(["Binance", "Coinbase", "Kraken", "OKX"]);
const MARKET_HISTORY_TIMEOUT_MS = 10_000;
const MAX_HISTORY_CANDLES = 2_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_BBO_AGE_MS = 60_000;

function pairPath(baseAsset: string, quoteAsset: string) {
  return `${MARKET_DATA_BASE_PATH}/${encodeURIComponent(baseAsset)}/${encodeURIComponent(quoteAsset)}`;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseMarketCandle(value: unknown): MarketCandle | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const time = finiteNumber(record.time);
  const open = finiteNumber(record.open);
  const high = finiteNumber(record.high);
  const low = finiteNumber(record.low);
  const close = finiteNumber(record.close);
  if (time === null || open === null || high === null || low === null || close === null) return null;
  if (!Number.isSafeInteger(time) || time <= 0 || open <= 0 || close <= 0 || low <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) return null;
  return { time, open, high, low, close };
}

export function parseMarketSummary(value: unknown): MarketSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { bbos?: unknown; stats?: unknown };
  if (!Array.isArray(record.bbos)) return null;
  const seenVenues = new Set<VenueName>();
  const bbos = record.bbos.flatMap((entry): VenueBbo[] => {
    if (!entry || typeof entry !== "object") return [];
    const quote = entry as Record<string, unknown>;
    const bid = finiteNumber(quote.bid);
    const ask = finiteNumber(quote.ask);
    if (
      !VENUES.has(quote.venue as VenueName) ||
      seenVenues.has(quote.venue as VenueName) ||
      bid === null ||
      ask === null ||
      bid <= 0 ||
      ask < bid
    ) return [];
    const observedAt = finiteNumber(quote.observed_at_unix_ms);
    const observedAtUnixMs = observedAt !== null
      && Number.isSafeInteger(observedAt)
      && observedAt > 0
      && observedAt >= Date.now() - MAX_BBO_AGE_MS
      && observedAt <= Date.now() + MAX_CLOCK_SKEW_MS
      ? observedAt
      : undefined;
    seenVenues.add(quote.venue as VenueName);
    return [{ venue: quote.venue as VenueName, bid, ask, observedAtUnixMs }];
  });
  let stats: MarketStats | null = null;
  if (record.stats && typeof record.stats === "object") {
    const raw = record.stats as Record<string, unknown>;
    const last = finiteNumber(raw.last);
    const changePercent = finiteNumber(raw.change_percent);
    const high = finiteNumber(raw.high);
    const low = finiteNumber(raw.low);
    const quoteVolume = finiteNumber(raw.quote_volume);
    if (last !== null && changePercent !== null && high !== null && low !== null && quoteVolume !== null && last > 0 && low > 0 && high >= low && quoteVolume >= 0) {
      stats = { last, changePercent, high, low, quoteVolume };
    }
  }
  return { bbos, stats };
}

export async function fetchMarketCandles(
  baseAsset: string,
  quoteAsset: string,
  interval: string,
  signal: AbortSignal,
): Promise<MarketCandle[]> {
  const response = await fetchWithTimeout(
    `${pairPath(baseAsset, quoteAsset)}/candles/${encodeURIComponent(interval)}`,
    { signal, headers: { accept: "application/json" } },
    MARKET_HISTORY_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`market data returned ${response.status}`);
  const body = (await readSdkJsonResponse(response, {
    signal,
    timeoutMs: MARKET_HISTORY_TIMEOUT_MS,
    label: "Market candle response",
  })) as { candles?: unknown };
  if (!Array.isArray(body.candles) || body.candles.length > MAX_HISTORY_CANDLES) return [];
  const byTime = new Map<number, MarketCandle>();
  for (const value of body.candles) {
    const candle = parseMarketCandle(value);
    if (candle) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

/**
 * one server-sent-events stream per open chart carries both the shared venue
 * summary and live candles. eventsource reconnects on its own after drops.
 */
export function openMarketStream(
  baseAsset: string,
  quoteAsset: string,
  interval: string,
  handlers: {
    onSummary: (summary: MarketSummary) => void;
    onCandle: (candle: MarketCandle) => void;
  },
): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  const source = new EventSource(
    `${pairPath(baseAsset, quoteAsset)}/stream/${encodeURIComponent(interval)}`,
  );
  const parse = (event: Event) => {
    try {
      return JSON.parse(String((event as MessageEvent).data)) as unknown;
    } catch {
      return null;
    }
  };
  source.addEventListener("summary", (event) => {
    const summary = parseMarketSummary(parse(event));
    if (summary) handlers.onSummary(summary);
  });
  source.addEventListener("candle", (event) => {
    const candle = parseMarketCandle(parse(event));
    if (candle) handlers.onCandle(candle);
  });
  return () => source.close();
}
