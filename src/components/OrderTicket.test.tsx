import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrderTicket, type PairConfig } from "./OrderTicket";

const pair: PairConfig = {
  pair_id: "STRK/USDC",
  base_asset_id: "STRK",
  quote_asset_id: "USDC",
  min_order_amount: "1",
  price_base_scale: "1000000000000000000",
  enabled: true,
};

describe("OrderTicket", () => {
  it("keeps the taker ticket scoped to limit and program order entry", () => {
    render(
      <OrderTicket
        pair={pair}
        balances={[]}
        batchWindowMs={90_000}
        walletReady={true}
        hasPrivateBalance={true}
        submitting={false}
        submitError={null}
        onOpenWallet={vi.fn()}
        onDeposit={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Limit/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Program/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Curve/ })).not.toBeInTheDocument();
  });
});
