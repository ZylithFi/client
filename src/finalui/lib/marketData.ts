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
  if (time <= 0 || low <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) return null;
  return { time, open, high, low, close };
}

export function parseMarketSummary(value: unknown): MarketSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { bbos?: unknown; stats?: unknown };
  if (!Array.isArray(record.bbos)) return null;
  const bbos = record.bbos.flatMap((entry): VenueBbo[] => {
    if (!entry || typeof entry !== "object") return [];
    const quote = entry as Record<string, unknown>;
    const bid = finiteNumber(quote.bid);
    const ask = finiteNumber(quote.ask);
    if (
      !VENUES.has(quote.venue as VenueName) ||
      bid === null ||
      ask === null ||
      bid <= 0 ||
      ask < bid
    ) return [];
    const observedAtUnixMs = finiteNumber(quote.observed_at_unix_ms) ?? undefined;
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
    if (last !== null && changePercent !== null && high !== null && low !== null && quoteVolume !== null) {
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
  const response = await fetch(
    `${pairPath(baseAsset, quoteAsset)}/candles/${encodeURIComponent(interval)}`,
    { signal, headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`market data returned ${response.status}`);
  const body = (await response.json()) as { candles?: unknown };
  return Array.isArray(body.candles)
    ? body.candles.flatMap((candle) => {
        const parsed = parseMarketCandle(candle);
        return parsed ? [parsed] : [];
      })
    : [];
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
