import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrdersScreen } from "./OrdersScreen";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";
import type { WithdrawableNote } from "../domain/shieldedBalances";

function order(overrides: Partial<LocalOrder> = {}): LocalOrder {
  return {
    ordRef: overrides.ordRef ?? "ORD-1001",
    orderCommitment: overrides.orderCommitment ?? "0xorder",
    cancellationSecret: overrides.cancellationSecret ?? "0xcancel",
    expectedOutputMetadataCommitment: overrides.expectedOutputMetadataCommitment,
    strategyId: overrides.strategyId,
    batchId: overrides.batchId ?? "batch-1",
    epochId: overrides.epochId ?? 10,
    pair: overrides.pair ?? "STRK/USDC",
    side: overrides.side ?? "Buy",
    wireMode: overrides.wireMode ?? "TWAP",
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

function strategy(overrides: Partial<PrivateStrategySummary> = {}): PrivateStrategySummary {
  return {
    id: overrides.id ?? "strategy-1",
    mode: overrides.mode ?? "TWAP",
    pair: overrides.pair ?? "STRK/USDC",
    status: overrides.status ?? "active",
    total_amount: overrides.total_amount ?? "100",
    remaining_amount: overrides.remaining_amount ?? "50",
    child_amount: overrides.child_amount ?? "10",
    max_children: overrides.max_children ?? 10,
    next_child_index: overrides.next_child_index ?? 3,
    start_epoch: overrides.start_epoch ?? 10,
    end_epoch: overrides.end_epoch ?? 20,
    parent_cancel_transaction_hash: overrides.parent_cancel_transaction_hash,
    submitted_children: overrides.submitted_children ?? [{
      parent_child_index: 1,
      batch_id: "batch-child-1",
      epoch_id: 11,
      order_commitment: "0x1234567890abcdef",
      expected_output_metadata_commitment: "0xchild-meta",
      submitted_at_unix_ms: 1_100,
    }],
  };
}

describe("OrdersScreen", () => {
  it("renders strategy children as compact rows with per-child lifecycle", () => {
    const onCancel = vi.fn();
    const output: WithdrawableNote = {
      note_commitment: "0xoutput123456",
      batch_id: "batch-child-1",
      source: "settlement_output",
      asset: "STRK",
      amount: "1000",
      locked: false,
      spent: false,
      metadata_commitment: "0xchild-meta",
    };

    render(
      <OrdersScreen
        walletReady
        orders={[order({ strategyId: "strategy-1" })]}
        strategies={[strategy()]}
        batches={[{
          batch_id: "batch-child-1",
          pair_id: "STRK/USDC",
          epoch_id: 11,
          close_time_unix_ms: 2_000,
          status: "Settled",
          order_count_bucket: "1-4",
        }]}
        settlementTranscripts={{
          "batch-child-1": {
            batch_id: "batch-child-1",
            pair_id: "STRK/USDC",
            batch_epoch: 11,
            clearing_price: "300",
          },
        }}
        withdrawableNotes={[output]}
        onCancel={onCancel}
      />,
    );

    const childRow = screen.getByText("01").closest(".strategy-child-timeline-row");
    expect(childRow).not.toBeNull();
    expect(within(childRow as HTMLElement).getByText("Filled")).toBeInTheDocument();
    expect(within(childRow as HTMLElement).getByText("Epoch 11")).toBeInTheDocument();
    expect(within(childRow as HTMLElement).getByText(/Order 0x1234/)).toBeInTheDocument();
    expect(within(childRow as HTMLElement).getByText(/Output 0xoutp/)).toBeInTheDocument();
  });
});
