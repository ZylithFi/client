import { useEffect, useRef, useState } from "react";
import type { PairConfig } from "../../domain/tradeIntent";
import { ChevronDownIcon } from "./Icons";
import { TokenIcon } from "./TokenIcon";
import type { BinanceMarketStats } from "../lib/binanceMarket";
import { formatQuotedPrice } from "../lib/marketFormat";

function displayVolume(value: number | undefined) {
  if (!Number.isFinite(value) || !value || value < 0) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

const marketOrder = ["STRK/strkBTC", "STRK/USDC", "strkBTC/USDC", "strkBTC/ETH", "STRK/ETH"];

function menuMarkets(pairs: PairConfig[]) {
  const byId = new Map(pairs.map((candidate) => [candidate.pair_id, candidate]));
  return marketOrder.map((pairId) => byId.get(pairId) ?? {
    pair_id: pairId,
    base_asset_id: pairId.split("/")[0],
    quote_asset_id: pairId.split("/")[1],
    min_order_amount: "0",
    external_match_enabled: false,
    enabled: false,
  });
}

export function MarketHeader({
  pair,
  pairs,
  marketMidpoint,
  marketStats,
  onSelectPair,
}: {
  pair: PairConfig | null;
  pairs: PairConfig[];
  marketMidpoint: number;
  marketStats: BinanceMarketStats | null;
  onSelectPair: (pairId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement | null>(null);
  const base = pair?.base_asset_id ?? "STRK";
  const quote = pair?.quote_asset_id ?? "USDC";
  const markPrice = marketMidpoint || marketStats?.last;
  const markets = menuMarkets(pairs);

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!selectorRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  function selectPair(pairId: string) {
    onSelectPair(pairId);
    setOpen(false);
  }

  return (
    <section className="market-header" aria-label="Market summary">
      <div className="pair-select-wrap" ref={selectorRef}>
        <button
          className="pair-select"
          type="button"
          aria-label="Select market"
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="token-stack"><TokenIcon token={base} size={24}/><TokenIcon token={quote} size={16}/></span>
          <span className="pair-copy"><strong>{base} / {quote}</strong></span>
          <ChevronDownIcon className="icon-16" />
        </button>
        {open && (
          <div className="pair-menu" role="listbox" aria-label="Markets">
            {markets.map((candidate) => {
              const selected = candidate.pair_id === pair?.pair_id;
              const unavailable = !candidate.enabled;
              return (
                <button
                  key={candidate.pair_id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={selected ? "selected" : ""}
                  disabled={unavailable}
                  aria-disabled={unavailable}
                  onClick={() => !unavailable && selectPair(candidate.pair_id)}
                >
                  <span className="token-stack"><TokenIcon token={candidate.base_asset_id} size={25}/><TokenIcon token={candidate.quote_asset_id} size={16}/></span>
                  <span>{candidate.base_asset_id} / {candidate.quote_asset_id}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="market-stat market-price-stat"><span>Mark price</span><div><strong>{formatQuotedPrice(markPrice, quote)}</strong><em className="positive">Live</em></div></div>
      <div className="market-stat"><span>24h change</span><strong className={(marketStats?.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{marketStats ? `${marketStats.changePercent >= 0 ? "+" : ""}${marketStats.changePercent.toFixed(2)}%` : "-"}</strong></div>
      <div className="market-stat"><span>24h vol</span><strong>{displayVolume(marketStats?.quoteVolume)}</strong></div>
      <div className="market-stat"><span>24h high</span><strong>{formatQuotedPrice(marketStats?.high, quote)}</strong></div>
      <div className="market-stat"><span>24h low</span><strong>{formatQuotedPrice(marketStats?.low, quote)}</strong></div>
    </section>
  );
}
