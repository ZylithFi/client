import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PairConfig } from "../../domain/tradeIntent";
import { IntentPanel } from "./IntentPanel";

const pair: PairConfig = {
  pair_id: "STRK/USDC",
  base_asset_id: "STRK",
  quote_asset_id: "USDC",
  min_order_amount: "1",
  price_base_scale: "1000000000000000000",
  external_match_enabled: true,
  enabled: true,
};

const commonProps = {
  pair,
  balances: [],
  referencePrice: {
    displayPrice: "0.05",
    midpointPrice: "50000",
    priceBaseScale: "1000000000000000000",
    observedAtUnixMs: Date.now(),
  },
  marketMidpoint: 0.04,
  hasPrivateBalance: false,
  submitting: false,
  submitError: null,
  onOpenWallet: vi.fn(),
  onDeposit: vi.fn(),
  onSubmit: vi.fn(),
};

describe("IntentPanel", () => {
  it("keeps the full sizing form visible while private balance controls are gated", () => {
    render(<IntentPanel {...commonProps} walletReady={false} />);

    expect(screen.getByText("Connect to view balance")).toBeInTheDocument();
    expect(screen.getByLabelText("Trade amount")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "25%" })).toBeDisabled();
  });

  it("uses the signed reference for protection while keeping direct bbo sizing indicative", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
        hasPrivateBalance
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Trade amount"), { target: { value: "100" } });
    expect(screen.getByText("2,500")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit order" }));
    });

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      amount: "2500",
      limitPrice: "0.05015",
    }));
  });
});
