import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PairConfig } from "../../domain/tradeIntent";
import { ChevronDownIcon } from "./Icons";
import { TokenIcon } from "./TokenIcon";
import type { MarketStats } from "../lib/marketData";
import { formatQuotedPrice } from "../lib/marketFormat";

function displayVolume(value: number | undefined) {
  if (!Number.isFinite(value) || !value || value < 0) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

export function MarketHeader({
  pair,
  pairs,
  marketMidpoint,
  marketStats,
  live,
  onSelectPair,
}: {
  pair: PairConfig | null;
  pairs: PairConfig[];
  marketMidpoint: number;
  marketStats: MarketStats | null;
  live: boolean;
  onSelectPair: (pairId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const base = pair?.base_asset_id ?? "";
  const quote = pair?.quote_asset_id ?? "";
  const markPrice = marketMidpoint;

  function positionMenu() {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const width = Math.min(250, window.innerWidth - 24);
    setMenuStyle({
      left: Math.min(Math.max(12, trigger.left), window.innerWidth - width - 12),
      top: trigger.bottom + 6,
      width,
    });
  }

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!trigger || !menu) return;
    if (trigger.bottom + 6 + menu.height > window.innerHeight - 12) {
      setMenuStyle((current) => ({
        ...current,
        top: Math.max(12, trigger.top - menu.height - 6),
      }));
    }
  }, [open, pairs.length]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const selected = menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      (selected ?? menuRef.current?.querySelector<HTMLElement>("button:not([disabled])"))?.focus();
    });
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (!selectorRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    function closeOnOutsideFocus(event: FocusEvent) {
      const target = event.target as Node;
      if (!selectorRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    const closeOnViewportChange = () => setOpen(false);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("focusin", closeOnOutsideFocus);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("focusin", closeOnOutsideFocus);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [open]);

  function selectPair(pairId: string) {
    onSelectPair(pairId);
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <section className="market-header" aria-label="Market summary">
      <div className="pair-select-wrap" ref={selectorRef}>
        <button
          ref={triggerRef}
          className="pair-select"
          type="button"
          aria-label="Select market"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            if (!open) positionMenu();
            setOpen((current) => !current);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) positionMenu();
              setOpen(true);
            }
          }}
        >
          <span className="token-stack"><TokenIcon token={base} size={24}/><TokenIcon token={quote} size={16}/></span>
          <span className="pair-copy"><strong>{base} / {quote}</strong></span>
          <ChevronDownIcon className="icon-16" />
        </button>
        {open && createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="pair-menu portal"
            role="listbox"
            aria-label="Markets"
            style={menuStyle}
            onKeyDown={(event) => {
              const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              let next = index;
              if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
              else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = items.length - 1;
              else return;
              event.preventDefault();
              items[next]?.focus();
            }}
          >
            {pairs.map((candidate) => {
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
          </div>,
          document.body,
        )}
      </div>
      <div className="market-stat market-price-stat"><span>Mark price</span><div><strong>{formatQuotedPrice(markPrice, quote)}</strong><em className={live ? "positive" : "muted"}>{live ? "Live" : "Unavailable"}</em></div></div>
      <div className="market-stat"><span>24h change</span><strong className={(marketStats?.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{marketStats ? `${marketStats.changePercent >= 0 ? "+" : ""}${marketStats.changePercent.toFixed(2)}%` : "Unavailable"}</strong></div>
      <div className="market-stat"><span>24h vol</span><strong>{displayVolume(marketStats?.quoteVolume)}</strong></div>
      <div className="market-stat"><span>24h high</span><strong>{formatQuotedPrice(marketStats?.high, quote)}</strong></div>
      <div className="market-stat"><span>24h low</span><strong>{formatQuotedPrice(marketStats?.low, quote)}</strong></div>
    </section>
  );
}
