import { useEffect, useState } from "react";
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

function mergeCandle(current: MarketCandle[], incoming: MarketCandle) {
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
  orders: OrderRow[];
  online: boolean;
  onSelectPair: (pairId: string) => void;
  onOpenWallet: () => void;
  onDeposit: () => void;
  onSubmit: (intent: TicketSubmitIntent) => Promise<boolean | void>;
  onViewOrders: () => void;
}) {
  const [interval, setInterval] = useState<ChartInterval>("15m");
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [venueBbos, setVenueBbos] = useState<VenueBbo[]>([]);
  const [marketStats, setMarketStats] = useState<MarketStats | null>(null);
  const binanceFeed = venueBbos.find((feed) => feed.venue === "Binance");
  const binanceBbo = { bid: binanceFeed?.bid ?? 0, ask: binanceFeed?.ask ?? 0 };
  const signedMidpoint = Number(referencePrice?.displayPrice) || 0;
  const marketMidpoint = binanceBbo.bid > 0 && binanceBbo.ask > 0
    ? (binanceBbo.bid + binanceBbo.ask) / 2
    : signedMidpoint;

  useEffect(() => {
    setCandles([]);
    setCandlesLoading(true);
    if (!pair) return;
    const controller = new AbortController();
    const { base_asset_id: baseAsset, quote_asset_id: quoteAsset } = pair;

    async function loadHistory() {
      try {
        const history = await fetchMarketCandles(baseAsset, quoteAsset, interval, controller.signal);
        if (history.length > 0) setCandles(history.slice(-500));
      } catch {
        if (controller.signal.aborted) return;
      }
      setCandlesLoading(false);
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
    if (!pair) return;
    return openMarketStream(pair.base_asset_id, pair.quote_asset_id, interval, {
      onSummary: (summary) => {
        setVenueBbos(summary.bbos);
        setMarketStats(summary.stats);
      },
      onCandle: (candle) => setCandles((current) => mergeCandle(current, candle)),
    });
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
      <BboFeedBar feeds={venueBbos.length > 0 ? venueBbos : [
        { venue: "Binance", bid: 0, ask: 0 },
        { venue: "Coinbase", bid: 0, ask: 0 },
        { venue: "Kraken", bid: 0, ask: 0 },
        { venue: "OKX", bid: 0, ask: 0 },
      ]} />
      {!online && <div className="orders-help-row" role="alert">The operator is unreachable. New orders are temporarily disabled.</div>}
      <OrdersPanel orders={orders} onViewAll={onViewOrders} />
    </main>
  );
}
