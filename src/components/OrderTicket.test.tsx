import { act, fireEvent, render, screen } from "@testing-library/react";
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
  it("renders the logged-out connect prompt as the compact gate state", () => {
    render(
      <OrderTicket
        pair={pair}
        balances={[]}
        batchWindowMs={20_000}
        walletReady={false}
        hasPrivateBalance={false}
        submitting={false}
        submitError={null}
        onOpenWallet={vi.fn()}
        onDeposit={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("Connect wallet to start.").closest(".ticket-gate-zone")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Connect wallet/i })).toHaveClass("gate-primary");
  });

  it("keeps the taker ticket scoped to limit and program order entry", () => {
    render(
      <OrderTicket
        pair={pair}
        balances={[]}
        batchWindowMs={20_000}
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

  it("submits the taker order when pressing Enter in a text field", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <OrderTicket
        pair={pair}
        balances={[{ asset: "USDC", available: "100000000", locked: "0" }]}
        batchWindowMs={20_000}
        walletReady={true}
        hasPrivateBalance={true}
        submitting={false}
        submitError={null}
        onOpenWallet={vi.fn()}
        onDeposit={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "2" } });
    fireEvent.change(inputs[1], { target: { value: "0.10" } });

    await act(async () => {
      fireEvent.keyDown(inputs[1], { key: "Enter" });
    });

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      side: "Buy",
      shape: "limit",
      amount: "2",
      limitPrice: "0.10",
    }));
  });

  it("keeps quick-fill safe when local balance or pair scale is malformed", () => {
    render(
      <OrderTicket
        pair={{ ...pair, price_base_scale: "bad-scale" }}
        balances={[{ asset: "USDC", available: "bad-balance", locked: "-1" }]}
        batchWindowMs={20_000}
        walletReady={true}
        hasPrivateBalance={true}
        submitting={false}
        submitError={null}
        onOpenWallet={vi.fn()}
        onDeposit={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Max" })).toBeDisabled();
    expect(screen.getByText("- USDC available")).toBeInTheDocument();
  });
});
