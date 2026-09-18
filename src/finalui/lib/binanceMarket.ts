export type BinanceBook = {
  bid: number;
  ask: number;
};

export type BinanceTicker = {
  last: number;
  previousClose: number;
  high: number;
  low: number;
  quoteVolume: number;
};

export type BinanceMarketStats = {
  last: number;
  changePercent: number;
  high: number;
  low: number;
  quoteVolume: number;
};

export type BinanceCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type BinanceMarket =
  | { kind: "direct"; symbol: string }
  | { kind: "ratio"; baseSymbol: string; quoteSymbol: string };

function normalizedAsset(asset: string) {
  if (asset === "strkBTC" || asset === "WBTC") return "BTC";
  return asset.toUpperCase();
}

export function binanceMarketForPair(baseAsset: string, quoteAsset: string): BinanceMarket {
  const base = normalizedAsset(baseAsset);
  const quote = normalizedAsset(quoteAsset);
  if (quote === "USDT") return { kind: "direct", symbol: `${base}${quote}` };
  return { kind: "ratio", baseSymbol: `${base}USDT`, quoteSymbol: `${quote}USDT` };
}

export function combineBinanceBooks(base: BinanceBook, quote?: BinanceBook): BinanceBook {
  if (!quote) return base;
  if (quote.bid <= 0 || quote.ask <= 0) return { bid: 0, ask: 0 };
  return {
    bid: base.bid / quote.ask,
    ask: base.ask / quote.bid,
  };
}

export function parseBinanceTicker(value: unknown): BinanceTicker | null {
  if (!value || typeof value !== "object") return null;
  const ticker = value as {
    lastPrice?: unknown;
    prevClosePrice?: unknown;
    highPrice?: unknown;
    lowPrice?: unknown;
    quoteVolume?: unknown;
  };
  const last = Number(ticker.lastPrice);
  const previousClose = Number(ticker.prevClosePrice);
  const high = Number(ticker.highPrice);
  const low = Number(ticker.lowPrice);
  const quoteVolume = Number(ticker.quoteVolume);
  if (
    !Number.isFinite(last) || last <= 0 ||
    !Number.isFinite(previousClose) || previousClose <= 0 ||
    !Number.isFinite(high) || high <= 0 ||
    !Number.isFinite(low) || low <= 0 ||
    !Number.isFinite(quoteVolume) || quoteVolume < 0
  ) return null;
  return { last, previousClose, high, low, quoteVolume };
}

export function combineBinanceTickers(
  base: BinanceTicker,
  quote?: BinanceTicker,
): BinanceMarketStats | null {
  if (!quote) {
    return {
      last: base.last,
      changePercent: ((base.last - base.previousClose) / base.previousClose) * 100,
      high: base.high,
      low: base.low,
      quoteVolume: base.quoteVolume,
    };
  }
  if (quote.last <= 0 || quote.previousClose <= 0 || quote.low <= 0 || quote.high <= 0) {
    return null;
  }
  const last = base.last / quote.last;
  const previousClose = base.previousClose / quote.previousClose;
  return {
    last,
    changePercent: ((last - previousClose) / previousClose) * 100,
    high: base.high / quote.low,
    low: base.low / quote.high,
    // the base symbol is denominated in USDT, making its quote volume the
    // closest available USD notional for a ratio market.
    quoteVolume: base.quoteVolume,
  };
}

export function parseBinanceKlines(value: unknown): BinanceCandle[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 5) return [];
    const time = Math.floor(Number(entry[0]) / 1_000);
    const open = Number(entry[1]);
    const high = Number(entry[2]);
    const low = Number(entry[3]);
    const close = Number(entry[4]);
    if (
      !Number.isFinite(time)
      || !Number.isFinite(open)
      || !Number.isFinite(high)
      || !Number.isFinite(low)
      || !Number.isFinite(close)
      || time <= 0
      || open <= 0
      || high < Math.max(open, close)
      || low > Math.min(open, close)
      || low <= 0
    ) return [];
    return [{ time, open, high, low, close }];
  });
}

export function combineBinanceKlines(baseValue: unknown, quoteValue?: unknown): BinanceCandle[] {
  const base = parseBinanceKlines(baseValue);
  if (quoteValue === undefined) return base;
  const quoteByTime = new Map(
    parseBinanceKlines(quoteValue).map((candle) => [candle.time, candle]),
  );
  return base.flatMap((candle) => {
    const quote = quoteByTime.get(candle.time);
    return quote
      ? [{
          time: candle.time,
          open: candle.open / quote.open,
          high: candle.high / quote.low,
          low: candle.low / quote.high,
          close: candle.close / quote.close,
        }]
      : [];
  });
}

export function parseBinanceKlineEvent(value: unknown): { symbol: string; candle: BinanceCandle } | null {
  if (!value || typeof value !== "object") return null;
  const root = value as { data?: unknown };
  const payload = root.data && typeof root.data === "object" ? root.data : value;
  const event = payload as { s?: unknown; k?: unknown };
  if (typeof event.s !== "string" || !event.k || typeof event.k !== "object") return null;
  const kline = event.k as { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown };
  const parsed = parseBinanceKlines([[
    kline.t,
    kline.o,
    kline.h,
    kline.l,
    kline.c,
  ]]);
  return parsed[0] ? { symbol: event.s.toUpperCase(), candle: parsed[0] } : null;
}

export function combineBinanceCandles(
  base: BinanceCandle,
  quote?: BinanceCandle,
): BinanceCandle | null {
  if (!quote) return base;
  if (base.time !== quote.time) return null;
  return {
    time: base.time,
    open: base.open / quote.open,
    high: base.high / quote.low,
    low: base.low / quote.high,
    close: base.close / quote.close,
  };
}
