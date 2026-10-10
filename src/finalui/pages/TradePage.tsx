import { useEffect, useRef, useState } from "react";
import type { OrderRow } from "../../domain/orders";
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
import {
  fetchMarketCandles,
  openMarketStream,
  type MarketCandle,
  type MarketStats,
  type VenueBbo,
} from "../lib/marketData";
import { FailureNotice } from "../../components/FailureNotice";
import { failureFromCode, type NormalizedFailure } from "../../domain/userFacingErrors";

export function mergeMarketCandles(...collections: MarketCandle[][]) {
  const byTime = new Map<number, MarketCandle>();
  for (const collection of collections) {
    for (const candle of collection) byTime.set(candle.time, candle);
  }
  return [...byTime.values()]
    .sort((left, right) => left.time - right.time)
    .slice(-500);
}

export function TradePage({
  pairs,
  pair,
  referencePrice,
  balances,
  walletReady,
  submitting,
  submitError,
  orders,
  online,
  onSelectPair,
  onOpenWallet,
  onDeposit,
  onSubmit,
  onViewOrders,
  onRefreshStatus,
  onSwitchNetwork,
  onContactSupport,
  onDismissError,
}: {
  pairs: PairConfig[];
  pair: PairConfig | null;
  referencePrice: ReferencePriceSnapshot | null;
  balances: WalletBalance[];
  walletReady: boolean;
  submitting: boolean;
  submitError: NormalizedFailure | null;
  orders: OrderRow[];
  online: boolean;
  onSelectPair: (pairId: string) => void;
  onOpenWallet: () => void;
  onDeposit: (asset: string) => void;
  onSubmit: (intent: TicketSubmitIntent) => Promise<boolean | void>;
  onViewOrders: () => void;
  onRefreshStatus?: () => void | Promise<void>;
  onSwitchNetwork?: () => void | Promise<void>;
  onContactSupport?: () => void | Promise<void>;
  onDismissError?: () => void | Promise<void>;
}) {
  const [interval, setInterval] = useState<ChartInterval>("15m");
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [venueBbos, setVenueBbos] = useState<VenueBbo[]>([]);
  const [marketStats, setMarketStats] = useState<MarketStats | null>(null);
  const [marketClock, setMarketClock] = useState(() => Date.now());
  const marketGeneration = useRef(0);
  const binanceFeed = venueBbos.find((feed) => feed.venue === "Binance");
  const binanceBbo = { bid: binanceFeed?.bid ?? 0, ask: binanceFeed?.ask ?? 0 };
  const signedMidpoint = Number(referencePrice?.displayPrice) || 0;
  const marketDataLive = Boolean(
    binanceFeed?.observedAtUnixMs
    && marketClock - binanceFeed.observedAtUnixMs <= 15_000
    && marketClock - binanceFeed.observedAtUnixMs >= -60_000
  );
  const chartMidpoint = marketDataLive && binanceBbo.bid > 0 && binanceBbo.ask > 0
    ? (binanceBbo.bid + binanceBbo.ask) / 2
    : signedMidpoint;
  const syntheticReference = pair?.reference_price_methodology === "synthetic_cross_bbo_midpoint";

  useEffect(() => {
    const generation = ++marketGeneration.current;
    setCandles([]);
    setCandlesLoading(true);
    if (!pair) {
      setCandlesLoading(false);
      return;
    }
    const controller = new AbortController();
    const { base_asset_id: baseAsset, quote_asset_id: quoteAsset } = pair;
    let historyInFlight = false;

    async function loadHistory() {
      if (historyInFlight) return;
      historyInFlight = true;
      try {
        const history = await fetchMarketCandles(baseAsset, quoteAsset, interval, controller.signal);
        if (generation === marketGeneration.current && history.length > 0) {
          setCandles((current) => mergeMarketCandles(history, current));
        }
      } catch {
        if (controller.signal.aborted) return;
      } finally {
        historyInFlight = false;
        if (generation === marketGeneration.current) setCandlesLoading(false);
      }
    }

    void loadHistory();
    // history refresh fills any gap left by a stream reconnect.
    const historyTimer = window.setInterval(() => void loadHistory(), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(historyTimer);
    };
  }, [pair?.pair_id, interval]);

  useEffect(() => {
    setVenueBbos([]);
    setMarketStats(null);
  }, [pair?.pair_id]);

  useEffect(() => {
    const timer = window.setInterval(() => setMarketClock(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!pair) return;
    const generation = marketGeneration.current;
    return openMarketStream(pair.base_asset_id, pair.quote_asset_id, interval, {
      onSummary: (summary) => {
        if (generation !== marketGeneration.current) return;
        setVenueBbos(summary.bbos);
        setMarketStats(summary.stats);
      },
      onCandle: (candle) => {
        if (generation !== marketGeneration.current) return;
        setCandles((current) => mergeMarketCandles(current, [candle]));
      },
    });
  }, [pair?.pair_id, interval]);

  return (
    <main className="trade-page">
      <MarketHeader
        pair={pair}
        pairs={pairs}
        marketMidpoint={signedMidpoint}
        marketStats={marketStats}
        live={online && signedMidpoint > 0}
        onSelectPair={onSelectPair}
      />
      <div className="trading-grid">
        <PriceChart
          data={candles}
          activeInterval={interval}
          onIntervalChange={setInterval}
          bboMidpoint={chartMidpoint}
          baseAsset={pair?.base_asset_id ?? ""}
          quoteAsset={pair?.quote_asset_id ?? ""}
          loading={candlesLoading}
          syntheticReference={syntheticReference}
        />
        <IntentPanel
          pair={pair}
          balances={balances}
          referencePrice={referencePrice}
          online={online}
          walletReady={walletReady}
          submitting={submitting}
          submitError={submitError}
          onOpenWallet={onOpenWallet}
          onDeposit={onDeposit}
          onSubmit={onSubmit}
          onRefreshStatus={onRefreshStatus}
          onSwitchNetwork={onSwitchNetwork}
          onContactSupport={onContactSupport}
          onDismissError={onDismissError}
        />
      </div>
      <BboFeedBar feeds={venueBbos.length > 0 ? venueBbos : [
        { venue: "Binance", bid: 0, ask: 0 },
        { venue: "Coinbase", bid: 0, ask: 0 },
        { venue: "Kraken", bid: 0, ask: 0 },
        { venue: "OKX", bid: 0, ask: 0 },
      ]} />
      {!online && (
        <FailureNotice
          className="orders-help-row"
          failure={failureFromCode("REFERENCE_PRICE_UNAVAILABLE", {
            stage: "reference-price-poll",
            presentation: "inline",
          })}
        />
      )}
      <OrdersPanel orders={orders} onViewAll={onViewOrders} />
    </main>
  );
}
