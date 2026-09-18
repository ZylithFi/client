import { useEffect, useState } from "react";
import type { LocalOrder } from "../../domain/orderLifecycle";
import type { WalletBalance } from "../../domain/shieldedBalances";
import type {
  PairConfig,
  ReferencePriceSnapshot,
  TicketSubmitIntent,
} from "../../domain/tradeIntent";
import { BboFeedBar } from "../components/BboFeedBar";
import { IntentPanel } from "../components/IntentPanel";
import { MarketHeader } from "../components/MarketHeader";
import { OrdersPanel } from "../components/OrdersPanel";
import { PriceChart, type ChartInterval } from "../components/PriceChart";
import { fetchVenueBbos, type VenueBbo } from "../lib/venueBbo";
import {
  binanceMarketForPair,
  combineBinanceCandles,
  combineBinanceBooks,
  combineBinanceKlines,
  combineBinanceTickers,
  parseBinanceKlineEvent,
  parseBinanceTicker,
  type BinanceCandle,
  type BinanceBook,
  type BinanceMarketStats,
} from "../lib/binanceMarket";

const binanceApiOrigins = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
];
const binanceStreamOrigins = [
  "wss://data-stream.binance.vision",
  "wss://stream.binance.com:443",
  "wss://stream.binance.com:9443",
];

async function fetchBinanceJson(
  origin: string,
  path: string,
  symbol: string,
  signal: AbortSignal,
) {
  const response = await fetch(`${origin}${path}${encodeURIComponent(symbol)}`, { signal });
  if (!response.ok) throw new Error(`Binance returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

function parseBook(value: unknown): BinanceBook | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { bidPrice?: unknown; askPrice?: unknown };
  const bid = Number(record.bidPrice);
  const ask = Number(record.askPrice);
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid
    ? { bid, ask }
    : null;
}

function mergeCandle(current: BinanceCandle[], incoming: BinanceCandle) {
  const last = current.at(-1);
  if (!last) return [incoming];
  if (incoming.time < last.time) return current;
  if (incoming.time === last.time) return [...current.slice(0, -1), incoming];
  return [...current, incoming].slice(-500);
}

export function TradePage({
  pairs,
  pair,
  referencePrice,
  balances,
  walletReady,
  hasPrivateBalance,
  submitting,
  submitError,
  orders,
  online,
  onSelectPair,
  onOpenWallet,
  onDeposit,
  onSubmit,
  onViewOrders,
}: {
  pairs: PairConfig[];
  pair: PairConfig | null;
  referencePrice: ReferencePriceSnapshot | null;
  balances: WalletBalance[];
  walletReady: boolean;
  hasPrivateBalance: boolean;
  submitting: boolean;
  submitError: string | null;
  orders: LocalOrder[];
  online: boolean;
  onSelectPair: (pairId: string) => void;
  onOpenWallet: () => void;
  onDeposit: () => void;
  onSubmit: (intent: TicketSubmitIntent) => Promise<boolean | void>;
  onViewOrders: () => void;
}) {
  const [interval, setInterval] = useState<ChartInterval>("15m");
  const [candles, setCandles] = useState<BinanceCandle[]>([]);
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [binanceBbo, setBinanceBbo] = useState({ bid: 0, ask: 0 });
  const [marketStats, setMarketStats] = useState<BinanceMarketStats | null>(null);
  const [binanceObservedAt, setBinanceObservedAt] = useState<number>();
  const [venueBbos, setVenueBbos] = useState<VenueBbo[]>([]);
  const signedMidpoint = Number(referencePrice?.displayPrice) || 0;
  const marketMidpoint = binanceBbo.bid > 0 && binanceBbo.ask > 0
    ? (binanceBbo.bid + binanceBbo.ask) / 2
    : signedMidpoint;

  useEffect(() => {
    setBinanceBbo({ bid: 0, ask: 0 });
    setMarketStats(null);
    setBinanceObservedAt(undefined);
    if (!pair) return;
    const market = binanceMarketForPair(pair.base_asset_id, pair.quote_asset_id);
    const controller = new AbortController();

    async function loadBbo() {
      for (const origin of binanceApiOrigins) {
        try {
          const path = "/api/v3/ticker/bookTicker?symbol=";
          const base = parseBook(await fetchBinanceJson(
            origin,
            path,
            market.kind === "direct" ? market.symbol : market.baseSymbol,
            controller.signal,
          ));
          const quote = market.kind === "ratio"
            ? parseBook(await fetchBinanceJson(origin, path, market.quoteSymbol, controller.signal))
            : undefined;
          if (!base || (market.kind === "ratio" && !quote)) continue;
          const combined = combineBinanceBooks(base, quote ?? undefined);
          if (combined.bid > 0 && combined.ask >= combined.bid) {
            setBinanceBbo(combined);
            setBinanceObservedAt(Date.now());
          }
          const tickerPath = "/api/v3/ticker/24hr?symbol=";
          const baseTicker = parseBinanceTicker(await fetchBinanceJson(
            origin,
            tickerPath,
            market.kind === "direct" ? market.symbol : market.baseSymbol,
            controller.signal,
          ));
          const quoteTicker = market.kind === "ratio"
            ? parseBinanceTicker(await fetchBinanceJson(origin, tickerPath, market.quoteSymbol, controller.signal)) ?? undefined
            : undefined;
          const stats = baseTicker && (market.kind === "direct" || quoteTicker)
            ? combineBinanceTickers(baseTicker, quoteTicker)
            : null;
          if (stats) setMarketStats(stats);
          if (combined.bid > 0 && combined.ask >= combined.bid && stats) return;
        } catch {
          if (controller.signal.aborted) return;
        }
      }
    }

    void loadBbo();
    const timer = window.setInterval(() => {
      void loadBbo();
    }, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [pair?.pair_id]);

  useEffect(() => {
    if (!pair) {
      setVenueBbos([]);
      return;
    }
    const selectedPair = pair;
    const controller = new AbortController();
    async function loadVenueBbos() {
      setVenueBbos([]);
      const nonBinance = await fetchVenueBbos(
        selectedPair.base_asset_id,
        selectedPair.quote_asset_id,
        controller.signal,
        (feed) => setVenueBbos((current) => [...current.filter((item) => item.venue !== feed.venue), feed]),
      ).catch(() => []);
      if (controller.signal.aborted) return;
      setVenueBbos(nonBinance);
    }
    void loadVenueBbos();
    const timer = window.setInterval(() => void loadVenueBbos(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [pair?.pair_id]);

  useEffect(() => {
    setCandles([]);
    setCandlesLoading(true);
    if (!pair) return;
    const market = binanceMarketForPair(pair.base_asset_id, pair.quote_asset_id);
    const controller = new AbortController();
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let reconnectDelay = 1_000;
    let streamOriginIndex = 0;
    const liveCandles = new Map<string, BinanceCandle>();

    async function loadHistory() {
      for (const origin of binanceApiOrigins) {
        try {
          const path = `/api/v3/klines?interval=${interval}&limit=500&symbol=`;
          const baseValue = await fetchBinanceJson(
            origin,
            path,
            market.kind === "direct" ? market.symbol : market.baseSymbol,
            controller.signal,
          );
          const quoteValue = market.kind === "ratio"
            ? await fetchBinanceJson(origin, path, market.quoteSymbol, controller.signal)
            : undefined;
          const next = combineBinanceKlines(baseValue, quoteValue);
          if (next.length > 0) {
            setCandles(next.slice(-500));
            setCandlesLoading(false);
            return;
          }
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      setCandlesLoading(false);
    }

    function publishLiveCandle(symbol: string, candle: BinanceCandle) {
      if (market.kind === "direct") {
        if (symbol === market.symbol) setCandles((current) => mergeCandle(current, candle));
        return;
      }
      liveCandles.set(symbol, candle);
      const base = liveCandles.get(market.baseSymbol);
      const quote = liveCandles.get(market.quoteSymbol);
      if (!base || !quote) return;
      const combined = combineBinanceCandles(base, quote);
      if (combined) setCandles((current) => mergeCandle(current, combined));
    }

    function connectStream() {
      if (stopped) return;
      const symbols = market.kind === "direct"
        ? [market.symbol]
        : [market.baseSymbol, market.quoteSymbol];
      const streams = symbols.map((symbol) => `${symbol.toLowerCase()}@kline_${interval}`).join("/");
      socket = new WebSocket(`${binanceStreamOrigins[streamOriginIndex]}/stream?streams=${streams}`);
      socket.onopen = () => {
        reconnectDelay = 1_000;
      };
      socket.onmessage = (event) => {
        try {
          const update = parseBinanceKlineEvent(JSON.parse(String(event.data)));
          if (update) publishLiveCandle(update.symbol, update.candle);
        } catch {
          return;
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        streamOriginIndex = (streamOriginIndex + 1) % binanceStreamOrigins.length;
        reconnectTimer = window.setTimeout(connectStream, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      };
      socket.onerror = () => socket?.close();
    }

    void loadHistory();
    connectStream();
    const historyTimer = window.setInterval(() => void loadHistory(), 60_000);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(historyTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [pair?.pair_id, interval]);

  return (
    <main className="trade-page">
      <MarketHeader
        pair={pair}
        pairs={pairs}
        marketMidpoint={marketMidpoint}
        marketStats={marketStats}
        onSelectPair={onSelectPair}
      />
      <div className="trading-grid">
        <PriceChart
          data={candles}
          activeInterval={interval}
          onIntervalChange={setInterval}
          bboMidpoint={marketMidpoint}
          baseAsset={pair?.base_asset_id ?? "STRK"}
          quoteAsset={pair?.quote_asset_id ?? "USDC"}
          loading={candlesLoading}
        />
        <IntentPanel
          pair={pair}
          balances={balances}
          referencePrice={referencePrice}
          marketMidpoint={marketMidpoint}
          walletReady={walletReady}
          hasPrivateBalance={hasPrivateBalance}
          submitting={submitting}
          submitError={submitError}
          onOpenWallet={onOpenWallet}
          onDeposit={onDeposit}
          onSubmit={onSubmit}
        />
      </div>
      <BboFeedBar feeds={[
        { venue: "Binance", bid: binanceBbo.bid, ask: binanceBbo.ask, observedAtUnixMs: binanceObservedAt },
        ...venueBbos,
      ]} />
      {!online && <div className="orders-help-row" role="alert">Coordinator unavailable. New orders are temporarily disabled.</div>}
      <OrdersPanel orders={orders} onViewAll={onViewOrders} />
    </main>
  );
}
