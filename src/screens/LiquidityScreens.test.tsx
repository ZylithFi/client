import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PairConfig } from "../components/OrderTicket";
import type { PrivateStrategySummary } from "../domain/orderLifecycle";
import { LiquidityCurvesScreen, LiquidityWorkspace } from "./LiquidityScreens";

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
        balances={[{ asset: "USDC", available: "100000000", locked: "0" }]}
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

  it("explains when quote capital is locked in existing curves", () => {
    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[]}
        balances={[{ asset: "USDC", available: "0", locked: "2000000" }]}
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

    expect(screen.getByText(/USDC is locked in existing curves/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate bid curve" })).toBeDisabled();
  });

  it("blocks activation when funding preview cannot select notes", () => {
    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[]}
        balances={[{ asset: "USDC", available: "1000000", locked: "0" }]}
        pendingDeposits={[]}
        activePairId="ETH/USDC"
        setActivePairId={vi.fn()}
        walletReady
        submitting={false}
        submitError={null}
        onPreviewFunding={() => {
          throw new Error("No unlocked USDC note can fund this order");
        }}
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

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "2500" } });
    fireEvent.change(inputs[1], { target: { value: "3" } });
    fireEvent.change(inputs[2], { target: { value: "2505" } });
    fireEvent.change(inputs[3], { target: { value: "3" } });
    fireEvent.change(inputs[4], { target: { value: "2510" } });
    fireEvent.change(inputs[5], { target: { value: "3" } });

    expect(screen.getByText(/No unlocked USDC note can fund this order/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate bid curve" })).toBeDisabled();
  });

  it("allows a small USDC bid curve when preview can select the available quote note", async () => {
    const onSubmitCurve = vi.fn().mockResolvedValue(true);
    const onPreviewFunding = vi.fn(() => ({
      asset: "USDC",
      required: "45000",
      selected_total: "1170000",
      expected_change: "1125000",
      notes: [{
        note_commitment: "0xquote",
        asset: "USDC",
        amount: "1170000",
        source: "deposit" as const,
      }],
    }));

    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[]}
        balances={[{ asset: "USDC", available: "1170000", locked: "829668" }]}
        pendingDeposits={[]}
        activePairId="STRK/USDC"
        setActivePairId={vi.fn()}
        walletReady
        submitting={false}
        submitError={null}
        onPreviewFunding={onPreviewFunding}
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

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "0.01" } });
    fireEvent.change(inputs[1], { target: { value: "1" } });
    fireEvent.change(inputs[2], { target: { value: "0.015" } });
    fireEvent.change(inputs[3], { target: { value: "1" } });
    fireEvent.change(inputs[4], { target: { value: "0.02" } });
    fireEvent.change(inputs[5], { target: { value: "1" } });

    expect(screen.getByText("1.17 USDC")).toBeInTheDocument();
    expect(screen.queryByText(/No available USDC note/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate bid curve" })).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Activate bid curve" }));
    });

    expect(onPreviewFunding).toHaveBeenCalledWith(expect.objectContaining({
      pairId: "STRK/USDC",
      side: "Buy",
      relayMode: "ZylithRelay",
      curvePoints: [
        { price: "0.01", baseAmount: "1" },
        { price: "0.015", baseAmount: "1" },
        { price: "0.02", baseAmount: "1" },
      ],
    }));
    expect(onSubmitCurve).toHaveBeenCalledWith(expect.objectContaining({
      pairId: "STRK/USDC",
      side: "Buy",
      relayMode: "ZylithRelay",
      curvePoints: [
        { price: "0.01", baseAmount: "1" },
        { price: "0.015", baseAmount: "1" },
        { price: "0.02", baseAmount: "1" },
      ],
    }));
  });

  it("shows cancel with the active curve management actions", () => {
    const onCancelCurve = vi.fn();
    const record = {
      id: "curve-1",
      pair: "ETH/USDC",
      side: "Buy" as const,
      sideLabel: "Bid" as const,
      status: "Active" as const,
      points: [{ price: "2500", baseAmount: "1" }],
      submittedAt: Date.now(),
      relatedOrders: [],
    };

    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[record]}
        balances={[]}
        pendingDeposits={[]}
        activePairId="ETH/USDC"
        setActivePairId={vi.fn()}
        walletReady
        submitting={false}
        submitError={null}
        onSubmitCurve={vi.fn()}
        onCancelCurve={onCancelCurve}
        onEditCurve={vi.fn()}
        onPauseCurve={vi.fn()}
        onResumeCurve={vi.fn()}
        onDeposit={vi.fn()}
        editRecord={null}
        onEditConsumed={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancelCurve).toHaveBeenCalledWith(record);
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

  it("does not show locally prepared relay curves until relay registration is confirmed", () => {
    const pendingStrategy: PrivateStrategySummary = {
      id: "strategy-pending",
      mode: "Resting",
      pair: "STRK/USDC",
      side: "Buy",
      status: "pending_relay",
      total_amount: "3000000000000000000",
      remaining_amount: "3000000000000000000",
      child_amount: "3000000000000000000",
      limit_price: "20000000000000000",
      price_base_scale: "1000000000000000000",
      max_children: 960,
      next_child_index: 1,
      start_epoch: 10,
      end_epoch: 969,
      maker_curve_points: [
        { price: "10000000000000000", base_amount: "1000000000000000000" },
        { price: "15000000000000000", base_amount: "1000000000000000000" },
        { price: "20000000000000000", base_amount: "1000000000000000000" },
      ],
      submitted_children: [],
    };

    render(
      <LiquidityWorkspace
        tab="curves"
        pairs={pairs}
        activePairId="STRK/USDC"
        setActivePairId={vi.fn()}
        orders={[]}
        strategies={[pendingStrategy]}
        batches={[]}
        balances={[{ asset: "USDC", available: "1170000", locked: "0" }]}
        pendingDeposits={[]}
        withdrawableNotes={[]}
        settlementTranscripts={{}}
        walletReady
        submitting={false}
        submitError={null}
        onSubmitCurve={vi.fn()}
        onCancelOrder={vi.fn()}
        onCancelStrategy={vi.fn()}
        onPauseStrategy={vi.fn()}
        onResumeStrategy={vi.fn()}
        onRefreshStrategyPackage={vi.fn()}
        onDeposit={vi.fn()}
        onWithdraw={vi.fn()}
        onNavigateCurves={vi.fn()}
      />,
    );

    expect(screen.getByText("Active curves").closest(".liq-panel-hd")).toHaveTextContent("0 running");
    expect(screen.queryByText("STRK/USDC Bid")).not.toBeInTheDocument();
  });
});
