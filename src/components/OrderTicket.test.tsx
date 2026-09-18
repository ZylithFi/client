import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrderTicket, type PairConfig } from "./OrderTicket";

const pair: PairConfig = {
  pair_id: "STRK/USDC",
  base_asset_id: "STRK",
  quote_asset_id: "USDC",
  min_order_amount: "1",
  price_base_scale: "1000000000000000000",
  external_match_enabled: true,
  enabled: true,
};

const referencePrice = {
  displayPrice: "0.1",
  midpointPrice: "100000",
  priceBaseScale: "1000000000000000000",
  observedAtUnixMs: Date.now(),
};

describe("OrderTicket", () => {
  it("renders the logged-out connect prompt as the compact gate state", () => {
    render(
      <OrderTicket
        pair={pair}
        balances={[]}
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

  it("keeps the taker ticket scoped to midpoint swap entry", () => {
    render(
      <OrderTicket
        pair={pair}
        balances={[]}
        referencePrice={referencePrice}
        walletReady={true}
        hasPrivateBalance={true}
        submitting={false}
        submitError={null}
        onOpenWallet={vi.fn()}
        onDeposit={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("Midpoint")).toBeInTheDocument();
    expect(screen.getByText("0.1")).toBeInTheDocument();
    expect(screen.getByText("Price protection")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Match residual" })).toBeInTheDocument();
  });

  it("submits the taker order when pressing Enter in a text field", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <OrderTicket
        pair={pair}
        balances={[{ asset: "USDC", available: "100000000", locked: "0" }]}
        referencePrice={referencePrice}
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

    await act(async () => {
      fireEvent.keyDown(inputs[0], { key: "Enter" });
    });

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      side: "Buy",
      shape: "limit",
      amount: "2",
      limitPrice: "0.1003",
      executionPreference: "PrivateThenExternal",
      keepTryingPrivate: false,
    }));
  });

  it("can submit a private-only order that keeps retrying across auctions", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <OrderTicket
        pair={pair}
        balances={[{ asset: "USDC", available: "100000000", locked: "0" }]}
        referencePrice={referencePrice}
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
    fireEvent.click(screen.getByRole("button", { name: "Private only" }));
    fireEvent.click(screen.getByLabelText("Keep trying privately"));
    fireEvent.click(screen.getByRole("button", { name: "12h" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy order" }));
    });

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      executionPreference: "PrivateOnly",
      keepTryingPrivate: true,
      retryHours: "12",
    }));
  });

  it("fails closed to private-only when the pair has no external matcher", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <OrderTicket
        pair={{ ...pair, external_match_enabled: false }}
        balances={[{ asset: "USDC", available: "100000000", locked: "0" }]}
        referencePrice={referencePrice}
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
    expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Buy order" }));
    });

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      executionPreference: "PrivateOnly",
    }));
  });

  it("keeps quick-fill safe when local balance or pair scale is malformed", () => {
    render(
      <OrderTicket
        pair={{ ...pair, price_base_scale: "bad-scale" }}
        balances={[{ asset: "USDC", available: "bad-balance", locked: "-1" }]}
        referencePrice={referencePrice}
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
