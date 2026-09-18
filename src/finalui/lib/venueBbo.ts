export type VenueName = "Binance" | "Coinbase" | "Kraken" | "OKX";

export type VenueBbo = {
  venue: VenueName;
  bid: number;
  ask: number;
  observedAtUnixMs?: number;
};

type Book = { bid: number; ask: number };

const venueOrigins = {
  Coinbase: "https://api.exchange.coinbase.com",
  Kraken: "https://api.kraken.com",
} as const;
const okxOrigins = ["https://www.okx.com", "https://www.okx.cab"];

function assetSymbol(asset: string) {
  const normalized = asset.toUpperCase();
  return normalized === "STRKBTC" || normalized === "WBTC" ? "BTC" : normalized;
}

function validBook(bid: number, ask: number): Book | null {
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid
    ? { bid, ask }
    : null;
}

function ratioBook(base: Book, quote: Book): Book | null {
  return validBook(base.bid / quote.ask, base.ask / quote.bid);
}

async function fetchJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`market data returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function coinbaseProduct(product: string, signal: AbortSignal): Promise<Book | null> {
  const value = await fetchJson(`${venueOrigins.Coinbase}/products/${product}/ticker`, signal);
  if (!value || typeof value !== "object") return null;
  const ticker = value as { bid?: unknown; ask?: unknown };
  return validBook(Number(ticker.bid), Number(ticker.ask));
}

async function krakenPair(pair: string, signal: AbortSignal): Promise<Book | null> {
  const value = await fetchJson(`${venueOrigins.Kraken}/0/public/Ticker?pair=${encodeURIComponent(pair)}`, signal);
  if (!value || typeof value !== "object") return null;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  const ticker = Object.values(result as Record<string, unknown>)[0];
  if (!ticker || typeof ticker !== "object") return null;
  const book = ticker as { a?: unknown; b?: unknown };
  const ask = Array.isArray(book.a) ? Number(book.a[0]) : Number.NaN;
  const bid = Array.isArray(book.b) ? Number(book.b[0]) : Number.NaN;
  return validBook(bid, ask);
}

async function okxInstrument(instrument: string, signal: AbortSignal): Promise<Book | null> {
  for (const origin of okxOrigins) {
    try {
      const value = await fetchJson(`${origin}/api/v5/market/books?instId=${encodeURIComponent(instrument)}&sz=1`, AbortSignal.any([signal, AbortSignal.timeout(2_000)]));
      if (!value || typeof value !== "object") continue;
      const data = (value as { data?: unknown }).data;
      if (!Array.isArray(data) || data.length === 0 || !data[0] || typeof data[0] !== "object") continue;
      const book = data[0] as { bids?: unknown; asks?: unknown };
      const bid = Array.isArray(book.bids) && Array.isArray(book.bids[0]) ? Number(book.bids[0][0]) : Number.NaN;
      const ask = Array.isArray(book.asks) && Array.isArray(book.asks[0]) ? Number(book.asks[0][0]) : Number.NaN;
      const parsed = validBook(bid, ask);
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

async function syntheticBook(
  base: string,
  quote: string,
  load: (symbol: string, signal: AbortSignal) => Promise<Book | null>,
  separator: string,
  bridge: string,
  signal: AbortSignal,
) {
  const direct = await load(`${base}${separator}${quote}`, signal).catch(() => null);
  if (direct) return direct;
  const [baseBridge, quoteBridge] = await Promise.all([
    load(`${base}${separator}${bridge}`, signal).catch(() => null),
    quote === bridge ? Promise.resolve({ bid: 1, ask: 1 }) : load(`${quote}${separator}${bridge}`, signal).catch(() => null),
  ]);
  return baseBridge && quoteBridge ? ratioBook(baseBridge, quoteBridge) : null;
}

async function coinbaseBook(base: string, quote: string, signal: AbortSignal) {
  const direct = await coinbaseProduct(`${base}-${quote}`, signal).catch(() => null);
  if (direct) return direct;
  if (quote === "USDC") return coinbaseProduct(`${base}-USD`, signal).catch(() => null);
  return syntheticBook(base, quote, coinbaseProduct, "-", "USD", signal);
}

export async function fetchVenueBbos(
  baseAsset: string,
  quoteAsset: string,
  signal: AbortSignal,
  onUpdate?: (feed: VenueBbo) => void,
): Promise<VenueBbo[]> {
  const base = assetSymbol(baseAsset);
  const quote = assetSymbol(quoteAsset);
  const observedAtUnixMs = Date.now();
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  const requests: Array<[VenueName, Promise<Book | null>]> = [
    ["Coinbase", coinbaseBook(base, quote, requestSignal)],
    ["Kraken", syntheticBook(base === "BTC" ? "XBT" : base, quote === "BTC" ? "XBT" : quote, krakenPair, "", "USD", requestSignal)],
    ["OKX", syntheticBook(base, quote, okxInstrument, "-", "USDT", requestSignal)],
  ];
  return Promise.all(requests.map(async ([venue, request]) => {
    const book = await request.catch(() => null);
    const feed = { venue, bid: book?.bid ?? 0, ask: book?.ask ?? 0, observedAtUnixMs: book ? observedAtUnixMs : undefined };
    if (!signal.aborted) onUpdate?.(feed);
    return feed;
  }));
}
