import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PairConfig } from "../../domain/tradeIntent";
import { MarketHeader } from "./MarketHeader";

const pairs: PairConfig[] = [
  {
    pair_id: "STRK/USDC",
    base_asset_id: "STRK",
    quote_asset_id: "USDC",
  min_order_amount: "1",
  min_order_quote_amount: "1",
    price_base_scale: "1000000000000000000",
    taker_fee_bps: 2,
    external_match_enabled: true,
    external_settlement_support_quote: "1",
    enabled: true,
  },
  {
    pair_id: "ETH/USDC",
    base_asset_id: "ETH",
    quote_asset_id: "USDC",
  min_order_amount: "1",
  min_order_quote_amount: "1",
    price_base_scale: "1000000000000000000",
    taker_fee_bps: 2,
    external_match_enabled: true,
    external_settlement_support_quote: "1",
    enabled: true,
  },
];

describe("MarketHeader", () => {
  it("renders the market menu outside the scrolling header", () => {
    render(
      <MarketHeader
        pair={pairs[0]}
        pairs={pairs}
        marketMidpoint={0.05}
        marketStats={null}
        live
        onSelectPair={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select market" }));

    const menu = screen.getByRole("listbox", { name: "Markets" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveClass("portal");
  });

  it("supports keyboard selection and restores focus", () => {
    const onSelectPair = vi.fn();
    render(
      <MarketHeader
        pair={pairs[0]}
        pairs={pairs}
        marketMidpoint={0.05}
        marketStats={null}
        live
        onSelectPair={onSelectPair}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Select market" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "ETH / USDC" }));

    expect(onSelectPair).toHaveBeenCalledWith("ETH/USDC");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox", { name: "Markets" })).not.toBeInTheDocument();
  });
});
