import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PairConfig } from "../components/OrderTicket";
import { LiquidityCurvesScreen } from "./LiquidityScreens";

const pairs: PairConfig[] = [
  {
    pair_id: "STRK/USDC",
    base_asset_id: "STRK",
    quote_asset_id: "USDC",
    min_order_amount: "1",
    price_base_scale: "1000000000000000000",
    enabled: true,
  },
  {
    pair_id: "ETH/USDC",
    base_asset_id: "ETH",
    quote_asset_id: "USDC",
    min_order_amount: "1",
    price_base_scale: "1000000000000000000",
    enabled: true,
  },
];

describe("LiquidityCurvesScreen", () => {
  it("submits curves for the liquidity-selected pair, not the taker active pair", async () => {
    const onSubmitCurve = vi.fn().mockResolvedValue(true);
    const setActivePairId = vi.fn();

    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[]}
        balances={[]}
        activePairId="ETH/USDC"
        setActivePairId={setActivePairId}
        walletReady
        submitting={false}
        submitError={null}
        onSubmitCurve={onSubmitCurve}
        onCancelCurve={vi.fn()}
        onEditCurve={vi.fn()}
        onPauseCurve={vi.fn()}
        onResumeCurve={vi.fn()}
        editRecord={null}
        onEditConsumed={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox")).toHaveValue("ETH/USDC");

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "2500" } });
    fireEvent.change(inputs[1], { target: { value: "3" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Activate hidden bid curve" }));
    });

    expect(onSubmitCurve).toHaveBeenCalledWith(expect.objectContaining({
      pairId: "ETH/USDC",
      curvePoints: [{ price: "2500", baseAmount: "3" }],
    }));
    expect(setActivePairId).not.toHaveBeenCalled();
  });
});
