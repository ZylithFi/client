import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PairConfig } from "../components/OrderTicket";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";
import { LiquidityAnalyticsScreen, LiquidityCurvesScreen, LiquidityWorkspace } from "./LiquidityScreens";

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

    expect(screen.getByRole("button", { name: /ETH\/USDCNo bidNo ask/i })).toHaveClass("on");

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
      relayMode: "SelfRelay",
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
      relayMode: "SelfRelay",
      curvePoints: [
        { price: "0.01", baseAmount: "1" },
        { price: "0.015", baseAmount: "1" },
        { price: "0.02", baseAmount: "1" },
      ],
    }));
    expect(onSubmitCurve).toHaveBeenCalledWith(expect.objectContaining({
      pairId: "STRK/USDC",
      side: "Buy",
      relayMode: "SelfRelay",
      curvePoints: [
        { price: "0.01", baseAmount: "1" },
        { price: "0.015", baseAmount: "1" },
        { price: "0.02", baseAmount: "1" },
      ],
    }));
  });

  it("submits the maker curve when pressing Enter in a band input", async () => {
    const onSubmitCurve = vi.fn().mockResolvedValue(true);
    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[]}
        balances={[{ asset: "USDC", available: "100000000", locked: "0" }]}
        pendingDeposits={[]}
        activePairId="STRK/USDC"
        setActivePairId={vi.fn()}
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

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "0.01" } });
    fireEvent.change(inputs[1], { target: { value: "1" } });
    fireEvent.change(inputs[2], { target: { value: "0.015" } });
    fireEvent.change(inputs[3], { target: { value: "1" } });
    fireEvent.change(inputs[4], { target: { value: "0.02" } });
    fireEvent.change(inputs[5], { target: { value: "1" } });

    await act(async () => {
      fireEvent.keyDown(inputs[5], { key: "Enter" });
    });

    expect(onSubmitCurve).toHaveBeenCalledWith(expect.objectContaining({
      pairId: "STRK/USDC",
      side: "Buy",
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

    expect(selects).toHaveLength(2);
    expect(selects[0]).not.toBeDisabled();
    expect(selects[1]).not.toBeDisabled();
    fireEvent.change(selects[0], { target: { value: "720" } });
    expect(selects[0]).toHaveValue("720");
    fireEvent.change(selects[1], { target: { value: "SelfHostedRelay" } });
    expect(selects[1]).toHaveValue("SelfHostedRelay");
    expect(selects[0]).toHaveValue("720");
    expect(screen.getByPlaceholderText("https://relay.example.com")).toBeInTheDocument();

    fireEvent.change(selects[1], { target: { value: "LocalBrowser" } });
    expect(selects[1]).toHaveValue("LocalBrowser");
    expect(selects[0]).toHaveValue("1");
  });

  it("submits self-hosted relay curves as SelfRelay packages with a relay endpoint", async () => {
    const onSubmitCurve = vi.fn().mockResolvedValue(true);
    render(
      <LiquidityCurvesScreen
        pairs={pairs}
        records={[]}
        balances={[{ asset: "USDC", available: "100000000", locked: "0" }]}
        pendingDeposits={[]}
        activePairId="STRK/USDC"
        setActivePairId={vi.fn()}
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

    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(selects[1], { target: { value: "SelfHostedRelay" } });
    fireEvent.change(screen.getByPlaceholderText("https://relay.example.com"), {
      target: { value: "https://maker-relay.example.com/" },
    });

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "0.01" } });
    fireEvent.change(inputs[1], { target: { value: "1" } });
    fireEvent.change(inputs[2], { target: { value: "0.015" } });
    fireEvent.change(inputs[3], { target: { value: "1" } });
    fireEvent.change(inputs[4], { target: { value: "0.02" } });
    fireEvent.change(inputs[5], { target: { value: "1" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Activate bid curve" }));
    });

    expect(onSubmitCurve).toHaveBeenCalledWith(expect.objectContaining({
      relayMode: "SelfRelay",
      relayOperator: "SelfHostedRelay",
      selfRelayUrl: "https://maker-relay.example.com",
    }));
  });

  it("keeps pending relay curves visible while relay registration catches up", () => {
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
        onDeposit={vi.fn()}
        onWithdraw={vi.fn()}
        onNavigateCurves={vi.fn()}
      />,
    );

    expect(screen.getByText("Active curves").closest(".liq-panel-hd")).toHaveTextContent("1 running");
    expect(screen.getAllByText("STRK/USDC").length).toBeGreaterThan(1);
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("rolls maker child orders into the orders table with a child execution timeline", () => {
    const strategy: PrivateStrategySummary = {
      id: "strategy-rollup",
      mode: "Resting",
      pair: "STRK/USDC",
      side: "Buy",
      status: "active",
      total_amount: "3000000000000000000",
      remaining_amount: "1000000000000000000",
      child_amount: "1000000000000000000",
      max_children: 3,
      next_child_index: 3,
      start_epoch: 10,
      end_epoch: 12,
      submitted_children: [
        {
          parent_child_index: 1,
          batch_id: "batch-10",
          epoch_id: 10,
          order_commitment: "0xchild10",
          submitted_at_unix_ms: 1_000,
        },
        {
          parent_child_index: 2,
          batch_id: "batch-11",
          epoch_id: 11,
          order_commitment: "0xchild11",
          submitted_at_unix_ms: 2_000,
        },
        {
          parent_child_index: 3,
          batch_id: "batch-12",
          epoch_id: 12,
          order_commitment: "0xchild12",
          submitted_at_unix_ms: 3_000,
        },
      ],
    };
    const orders: LocalOrder[] = [
      {
        ordRef: "STR-rollup-1",
        orderCommitment: "0xchild10",
        cancellationSecret: "0xcancel",
        strategyId: "strategy-rollup",
        batchId: "batch-10",
        epochId: 10,
        pair: "STRK/USDC",
        side: "Buy",
        wireMode: "Resting",
        amount: "1",
        limitPrice: "0.01",
        minFill: "",
        fillOrKill: false,
        status: "filled",
        submittedAt: 1_000,
        filledAmount: "1",
        clearingPrice: "0.01",
      },
      {
        ordRef: "STR-rollup-2",
        orderCommitment: "0xchild12",
        cancellationSecret: "0xcancel",
        strategyId: "strategy-rollup",
        batchId: "batch-12",
        epochId: 12,
        pair: "STRK/USDC",
        side: "Buy",
        wireMode: "Resting",
        amount: "1",
        limitPrice: "0.01",
        minFill: "",
        fillOrKill: false,
        status: "partial",
        submittedAt: 3_000,
        filledAmount: "0.4",
        clearingPrice: "0.01",
      },
    ];

    render(
      <LiquidityWorkspace
        tab="orders"
        pairs={pairs}
        activePairId="STRK/USDC"
        setActivePairId={vi.fn()}
        orders={orders}
        strategies={[strategy]}
        batches={[{
          batch_id: "batch-11",
          pair_id: "STRK/USDC",
          epoch_id: 11,
          close_time_unix_ms: 3_000,
          status: "Open",
          order_count_bucket: "1-4",
        }]}
        balances={[]}
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
        onDeposit={vi.fn()}
        onWithdraw={vi.fn()}
        onNavigateCurves={vi.fn()}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Ref" })).toBeInTheDocument();
    expect(screen.getByText("CRV-ROLLUP")).toBeInTheDocument();
    expect(screen.getByText("3/3 · 0 left")).toBeInTheDocument();
    expect(screen.queryByLabelText("Per-epoch fill outcomes")).not.toBeInTheDocument();

    const timeline = screen.getByLabelText("Curve child orders");
    expect(within(timeline).getByText("Child execution")).toBeInTheDocument();
    expect(within(timeline).getByText("3/3 submitted · 0 left")).toBeInTheDocument();
    expect(within(timeline).getByText("Renewal root")).toBeInTheDocument();
    expect(within(timeline).getByText("Epoch 10")).toBeInTheDocument();
    expect(within(timeline).getByText("Epoch 11")).toBeInTheDocument();
    expect(within(timeline).getByText("Epoch 12")).toBeInTheDocument();
    expect(within(timeline).getAllByText("Clearing 0.01")).toHaveLength(2);
    expect(within(timeline).getByText("Filled 0.4")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Collapse STRK\/USDC curve child orders/i }));
    expect(screen.queryByLabelText("Curve child orders")).not.toBeInTheDocument();
  });

  it("renders a maker-focused analytics board from settled child outcomes", () => {
    const now = Date.now();
    const records = [
      {
        id: "curve-analytics-bid",
        pair: "STRK/USDC",
        side: "Buy" as const,
        sideLabel: "Bid" as const,
        status: "Historical" as const,
        submittedAt: now - 12_000,
        points: [
          { price: "0.010", baseAmount: "100" },
          { price: "0.011", baseAmount: "100" },
          { price: "0.012", baseAmount: "100" },
        ],
        relatedOrders: [
          {
            ordRef: "STR-ana-1",
            orderCommitment: "0xana1",
            cancellationSecret: "0xcancel",
            batchId: "batch-101",
            epochId: 101,
            pair: "STRK/USDC",
            side: "Buy" as const,
            wireMode: "Resting" as const,
            amount: "100",
            limitPrice: "0.011",
            minFill: "",
            fillOrKill: false,
            status: "filled" as const,
            submittedAt: now - 10_000,
            filledAmount: "100",
            clearingPrice: "0.010",
          },
          {
            ordRef: "STR-ana-2",
            orderCommitment: "0xana2",
            cancellationSecret: "0xcancel",
            batchId: "batch-102",
            epochId: 102,
            pair: "STRK/USDC",
            side: "Buy" as const,
            wireMode: "Resting" as const,
            amount: "100",
            limitPrice: "0.011",
            minFill: "",
            fillOrKill: false,
            status: "partial" as const,
            submittedAt: now - 9_000,
            filledAmount: "25",
            clearingPrice: "0.0105",
          },
          {
            ordRef: "STR-ana-3",
            orderCommitment: "0xana3",
            cancellationSecret: "0xcancel",
            batchId: "batch-103",
            epochId: 103,
            pair: "STRK/USDC",
            side: "Buy" as const,
            wireMode: "Resting" as const,
            amount: "100",
            limitPrice: "0.011",
            minFill: "",
            fillOrKill: false,
            status: "no_fill" as const,
            submittedAt: now - 8_000,
          },
        ] satisfies LocalOrder[],
      },
    ];

    render(<LiquidityAnalyticsScreen records={records} settlementTranscripts={{}} />);

    expect(screen.getByText("ANALYTICS")).toBeInTheDocument();
    expect(screen.getByText("Execution over epochs")).toBeInTheDocument();
    expect(screen.getAllByText("Spread capture").length).toBeGreaterThan(0);
    expect(screen.getByText("By market")).toBeInTheDocument();
    expect(screen.getByText("Quote-notional estimate")).toBeInTheDocument();
    expect(screen.getByText("Clearing vs maker limit")).toBeInTheDocument();
    expect(screen.getAllByText("STRK/USDC").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bid").length).toBeGreaterThan(0);
    expect(screen.getByText("Matched volume")).toBeInTheDocument();
    expect(screen.getAllByText("Fill rate").length).toBeGreaterThan(0);
    expect(screen.queryByText("Epoch history")).not.toBeInTheDocument();
  });

  it("does not aggregate quote notional across mixed quote assets", () => {
    const now = Date.now();
    const baseOrder = {
      cancellationSecret: "0xcancel",
      wireMode: "Resting" as const,
      amount: "10",
      limitPrice: "1",
      minFill: "",
      fillOrKill: false,
      status: "filled" as const,
      submittedAt: now - 1_000,
      filledAmount: "10",
      clearingPrice: "1",
    };
    const records = [
      {
        id: "curve-mixed-usdc",
        pair: "STRK/USDC",
        side: "Buy" as const,
        sideLabel: "Bid" as const,
        status: "Historical" as const,
        submittedAt: now - 2_000,
        points: [{ price: "1", baseAmount: "10" }],
        relatedOrders: [{
          ...baseOrder,
          ordRef: "mixed-1",
          orderCommitment: "0xmixed1",
          batchId: "batch-mixed-1",
          epochId: 1,
          pair: "STRK/USDC",
          side: "Buy" as const,
        }] satisfies LocalOrder[],
      },
      {
        id: "curve-mixed-eth",
        pair: "STRK/ETH",
        side: "Sell" as const,
        sideLabel: "Ask" as const,
        status: "Historical" as const,
        submittedAt: now - 2_000,
        points: [{ price: "1", baseAmount: "10" }],
        relatedOrders: [{
          ...baseOrder,
          ordRef: "mixed-2",
          orderCommitment: "0xmixed2",
          batchId: "batch-mixed-2",
          epochId: 2,
          pair: "STRK/ETH",
          side: "Sell" as const,
        }] satisfies LocalOrder[],
      },
    ];

    render(<LiquidityAnalyticsScreen records={records} settlementTranscripts={{}} />);

    expect(screen.getByText("Mixed quote assets")).toBeInTheDocument();
    expect(screen.getByText("Filled children")).toBeInTheDocument();
    expect(screen.getAllByText("By market").length).toBeGreaterThan(0);
    expect(screen.getAllByText("10 USDC").length).toBeGreaterThan(0);
    expect(screen.getAllByText("10 ETH").length).toBeGreaterThan(0);
  });
});
