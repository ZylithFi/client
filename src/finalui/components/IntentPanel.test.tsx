import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairConfig } from "../../domain/tradeIntent";
import { configureAssetDecimals } from "../../domain/assets";
import type { DeploymentConfig } from "../../domain/deployment";
import { IntentPanel } from "./IntentPanel";

const pair: PairConfig = {
  pair_id: "STRK/USDC",
  base_asset_id: "STRK",
  quote_asset_id: "USDC",
  min_order_amount: "1",
  price_base_scale: "1000000000000000000",
  taker_fee_bps: 4,
  external_match_enabled: true,
  external_settlement_support_quote: "1",
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

beforeEach(() => {
  configureAssetDecimals({
    market_registry: {
      assets: [
        { asset_id: "STRK", decimals: 18 },
        { asset_id: "USDC", decimals: 6 },
      ],
    },
  } as unknown as DeploymentConfig);
});

afterEach(() => configureAssetDecimals(null));

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

    fireEvent.change(screen.getByLabelText("Trade amount"), {
      target: { value: "100" },
    });
    expect(screen.getByText("≈ 2,500")).toBeInTheDocument();
    expect(screen.getByLabelText("External matching")).not.toBeChecked();
    expect(screen.queryByText("Residual route")).not.toBeInTheDocument();
    expect(screen.queryByText("Unfilled amount")).not.toBeInTheDocument();
    expect(screen.getByText("Midpoint")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit order" }));
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "Buy",
        payAmount: "100",
        limitPrice: "0.05015",
        external: false,
      })
    );
  });

  it("opts into external matching only when the user checks the box", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
        hasPrivateBalance
        onSubmit={onSubmit}
      />
    );

    fireEvent.change(screen.getByLabelText("Trade amount"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByLabelText("External matching"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit order" }));
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        external: true,
      })
    );
  });

  it("disables external opt-in when the market has no matcher capability", () => {
    render(
      <IntentPanel
        {...commonProps}
        pair={{ ...pair, external_match_enabled: false }}
        walletReady={false}
      />
    );

    expect(screen.getByLabelText("External matching")).toBeDisabled();
    expect(screen.queryByText("Residual route")).not.toBeInTheDocument();
  });

  it("does not display a nonzero small receive amount as zero", () => {
    render(
      <IntentPanel
        {...commonProps}
        pair={{
          ...pair,
          pair_id: "STRK/ETH",
          quote_asset_id: "ETH",
        }}
        marketMidpoint={0.000015637}
        walletReady={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sell" }));

    expect(screen.getByText("≈ 0.000015637")).toBeInTheDocument();
  });
});
