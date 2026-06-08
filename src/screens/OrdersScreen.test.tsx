import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrdersScreen } from "./OrdersScreen";
import type { LocalOrder } from "../domain/orderLifecycle";

function order(overrides: Partial<LocalOrder> = {}): LocalOrder {
  return {
    ordRef: overrides.ordRef ?? "ORD-1001",
    orderCommitment: overrides.orderCommitment ?? "0xorder",
    cancellationSecret: overrides.cancellationSecret ?? "0xcancel",
    batchId: overrides.batchId ?? "batch-1",
    epochId: overrides.epochId ?? 10,
    pair: overrides.pair ?? "STRK/USDC",
    side: overrides.side ?? "Buy",
    wireMode: overrides.wireMode ?? "Limit",
    amount: overrides.amount ?? "100",
    limitPrice: overrides.limitPrice ?? "0.30",
    minFill: overrides.minFill ?? "",
    fillOrKill: overrides.fillOrKill ?? false,
    status: overrides.status ?? "in_batch",
    submittedAt: overrides.submittedAt ?? 1_000,
    filledAmount: overrides.filledAmount,
    clearingPrice: overrides.clearingPrice,
    cancelTransactionHash: overrides.cancelTransactionHash,
  };
}

describe("OrdersScreen", () => {
  it("shows direct taker order fields without maker strategy concepts", () => {
    render(
      <OrdersScreen
        walletReady
        orders={[order()]}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("ORD-1001")).toBeInTheDocument();
    expect(screen.getAllByText("Limit")).toHaveLength(2);
    expect(screen.queryByText("Children")).not.toBeInTheDocument();
    expect(screen.queryByText("Child execution")).not.toBeInTheDocument();
  });

  it("shows direct taker history separately", () => {
    render(
      <OrdersScreen
        walletReady
        orders={[order({
          ordRef: "ORD-FILLED",
          status: "filled",
          clearingPrice: "0.29",
        })]}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByText("ORD-FILLED")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText("ORD-FILLED")).toBeInTheDocument();
    expect(screen.getByText("Filled")).toBeInTheDocument();
  });
});
