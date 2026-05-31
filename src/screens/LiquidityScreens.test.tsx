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
        pendingDeposits={[]}
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
        onDeposit={vi.fn()}
        editRecord={null}
        onEditConsumed={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox")).toHaveValue("ETH/USDC");

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "2500" } });
    fireEvent.change(inputs[1], { target: { value: "3" } });
    fireEvent.change(inputs[2], { target: { value: "2505" } });
    fireEvent.change(inputs[3], { target: { value: "3" } });
    fireEvent.change(inputs[4], { target: { value: "2510" } });
    fireEvent.change(inputs[5], { target: { value: "3" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Activate bid curve" }));
    });

    expect(onSubmitCurve).toHaveBeenCalledWith(expect.objectContaining({
      pairId: "ETH/USDC",
      resting: true,
      relayMode: "ZylithRelay",
      curvePoints: [
        { price: "2500", baseAmount: "3" },
        { price: "2505", baseAmount: "3" },
        { price: "2510", baseAmount: "3" },
      ],
    }));
    expect(setActivePairId).not.toHaveBeenCalled();
  });

  it("shows selected-pair inventory beside the liquidity builder", () => {
    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[]}
        balances={[
          { asset: "ETH", available: "1000000000000000000", locked: "0" },
          { asset: "USDC", available: "2500000", locked: "500000" },
        ]}
        pendingDeposits={[{
          asset: "USDC",
          amount: "1000000",
          note_commitment: "0xpending",
          transaction_hash: "0xtx",
          confirmed: false,
        }]}
        activePairId="ETH/USDC"
        setActivePairId={vi.fn()}
        walletReady
        submitting={false}
        submitError={null}
        onSubmitCurve={vi.fn()}
        onCancelCurve={vi.fn()}
        onEditCurve={vi.fn()}
        onPauseCurve={vi.fn()}
        onResumeCurve={vi.fn()}
        onDeposit={vi.fn()}
        editRecord={null}
        onEditConsumed={vi.fn()}
      />,
    );

    const inventory = screen.getByLabelText("Liquidity inventory");
    expect(inventory).toHaveTextContent("ETH");
    expect(inventory).toHaveTextContent("1");
    expect(inventory).toHaveTextContent("USDC");
    expect(inventory).toHaveTextContent("2.5");
    expect(inventory).toHaveTextContent("0.5 locked");
    expect(inventory).toHaveTextContent("1 pending");
  });

  it("opens deposit for the missing liquidity funding asset", () => {
    const onDeposit = vi.fn();
    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[]}
        balances={[]}
        pendingDeposits={[]}
        activePairId="ETH/USDC"
        setActivePairId={vi.fn()}
        walletReady
        submitting={false}
        submitError={null}
        onSubmitCurve={vi.fn()}
        onCancelCurve={vi.fn()}
        onEditCurve={vi.fn()}
        onPauseCurve={vi.fn()}
        onResumeCurve={vi.fn()}
        onDeposit={onDeposit}
        editRecord={null}
        onEditConsumed={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));

    expect(onDeposit).toHaveBeenCalledWith("USDC");
  });

  it("keeps renewal controls active for maker curves by default", () => {
    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[]}
        balances={[]}
        pendingDeposits={[]}
        activePairId="ETH/USDC"
        setActivePairId={vi.fn()}
        walletReady
        submitting={false}
        submitError={null}
        onSubmitCurve={vi.fn()}
        onCancelCurve={vi.fn()}
        onEditCurve={vi.fn()}
        onPauseCurve={vi.fn()}
        onResumeCurve={vi.fn()}
        onDeposit={vi.fn()}
        editRecord={null}
        onEditConsumed={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Activate bid curve" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Activate hidden/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];

    expect(selects).toHaveLength(3);
    expect(selects[1]).not.toBeDisabled();
    expect(selects[2]).not.toBeDisabled();
    fireEvent.change(selects[1], { target: { value: "720" } });
    expect(selects[1]).toHaveValue("720");
    fireEvent.change(selects[2], { target: { value: "SelfRelay" } });
    expect(selects[2]).toHaveValue("SelfRelay");
    expect(selects[1]).toHaveValue("1");
  });
});
