import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportsScreen } from "./ReportsScreen";
import type { LocalOrder } from "../domain/orderLifecycle";

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
});
