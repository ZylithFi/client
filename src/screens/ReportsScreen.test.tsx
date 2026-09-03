import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { csvCell, ReportsScreen } from "./ReportsScreen";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";

function order(overrides: Partial<LocalOrder>): LocalOrder {
  return {
    ordRef: overrides.ordRef ?? "ORD-1001",
    orderCommitment: "0xorder",
    cancellationSecret: "0xcancel",
    batchId: "batch-1",
    epochId: 1,
    pair: overrides.pair ?? "STRK/USDC",
    side: overrides.side ?? "Buy",
    wireMode: overrides.wireMode ?? "Limit",
    amount: "10",
    limitPrice: overrides.limitPrice ?? "100",
    minFill: "",
    fillOrKill: false,
    status: overrides.status ?? "filled",
    submittedAt: overrides.submittedAt ?? Date.now(),
    clearingPrice: overrides.clearingPrice ?? "90",
    arrivalReferencePrice: overrides.arrivalReferencePrice,
    arrivalReferenceSource: overrides.arrivalReferenceSource,
    filledAmount: "10",
    strategyId: overrides.strategyId,
  };
}

function strategy(overrides: Partial<PrivateStrategySummary> = {}): PrivateStrategySummary {
  return {
    id: "strategy-1",
    mode: "TWAP",
    pair: "STRK/USDC",
    status: "active",
    total_amount: "10",
    remaining_amount: "0",
    child_amount: "10",
    limit_price: "100000000",
    max_children: 1,
    next_child_index: 2,
    start_epoch: 1,
    end_epoch: 1,
    submitted_children: [],
    ...overrides,
  };
}

describe("ReportsScreen", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows execution analytics instead of order status counters", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-13T00:00:00Z"));
    render(
      <ReportsScreen
        walletReady
        strategies={[]}
        orders={[
          order({ ordRef: "buy", side: "Buy", limitPrice: "100", clearingPrice: "90" }),
          order({ ordRef: "sell", side: "Sell", limitPrice: "100", clearingPrice: "110", arrivalReferencePrice: "105", arrivalReferenceSource: "last_clearing" }),
          order({ ordRef: "active", status: "in_batch", clearingPrice: undefined }),
        ]}
      />,
    );

    expect(screen.getByText("Fills")).toBeInTheDocument();
    expect(screen.getByText("Fill rate")).toBeInTheDocument();
    expect(screen.getByText("Avg headroom")).toBeInTheDocument();
    expect(screen.getByText("Best fill")).toBeInTheDocument();
    expect(screen.queryByText("Active orders")).not.toBeInTheDocument();
    expect(screen.queryByText("Stored orders")).not.toBeInTheDocument();
    expect(screen.getAllByText("+1000 bps").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Limit").length).toBeGreaterThan(0);
    expect(screen.queryByText("Shortfall")).not.toBeInTheDocument();
  });

  it("filters reports by period", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-13T00:00:00Z"));
    render(
      <ReportsScreen
        walletReady
        strategies={[]}
        orders={[
          order({ ordRef: "recent", pair: "STRK/USDC", submittedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }),
          order({ ordRef: "old", pair: "ETH/USDC", submittedAt: Date.now() - 20 * 24 * 60 * 60 * 1000 }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("STRK/USDC")).toBeInTheDocument();
    expect(within(table).queryByText("ETH/USDC")).not.toBeInTheDocument();
  });

  it("shows pending output reports before delayed artifacts publish", () => {
    render(
      <ReportsScreen
        walletReady
        strategies={[]}
        orders={[
          order({
            ordRef: "pending",
            status: "settled_pending_output",
            clearingPrice: undefined,
            filledAmount: undefined,
          }),
        ]}
      />,
    );

    expect(screen.getByText("Output reports pending. TCA appears after the private settlement report is available.")).toBeInTheDocument();
  });

  it("neutralizes spreadsheet formulas in CSV cells", () => {
    expect(csvCell("=HYPERLINK(\"https://example.test\")")).toBe(
      `"'=HYPERLINK(""https://example.test"")"`,
    );
    expect(csvCell(" +SUM(1,2)")).toBe(`"' +SUM(1,2)"`);
    expect(csvCell(12)).toBe("12");
  });

  it("renders malformed strategy limit prices without crashing", () => {
    render(
      <ReportsScreen
        walletReady
        strategies={[strategy({ limit_price: "bad-price" })]}
        orders={[order({
          ordRef: "strategy-fill",
          strategyId: "strategy-1",
          wireMode: "TWAP",
          limitPrice: "",
        })]}
      />,
    );

    expect(screen.getByText("Strategy analytics")).toBeInTheDocument();
    expect(screen.getByText(/90.*-/)).toBeInTheDocument();
  });
});
