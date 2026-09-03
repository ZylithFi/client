import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RightColumn } from "./RightColumn";
import type { LocalOrder } from "../domain/orderLifecycle";
import type { WithdrawableNote } from "../domain/shieldedBalances";

function activeOrder(overrides: Partial<LocalOrder> = {}): LocalOrder {
  return {
    ordRef: overrides.ordRef ?? "ORD-1001",
    orderCommitment: overrides.orderCommitment ?? "0xorder",
    cancellationSecret: overrides.cancellationSecret ?? "0xcancel",
    batchId: overrides.batchId ?? "batch-1",
    epochId: overrides.epochId ?? 1,
    pair: overrides.pair ?? "STRK/USDC",
    side: overrides.side ?? "Buy",
    wireMode: overrides.wireMode ?? "Limit",
    amount: overrides.amount ?? "10",
    limitPrice: overrides.limitPrice ?? "0.05",
    minFill: overrides.minFill ?? "",
    fillOrKill: overrides.fillOrKill ?? false,
    status: overrides.status ?? "in_batch",
    submittedAt: overrides.submittedAt ?? 1_000,
  };
}

describe("RightColumn", () => {
  it("opens deposit and withdraw directly for a connected wallet before authorization", () => {
    const setOpenSlide = vi.fn();

    render(
      <RightColumn
        activeBatch={null}
        activePairId="STRK/USDC"
        settlementTranscripts={{}}
        online
        allAssets={["STRK", "USDC"]}
        pairs={[{
          pair_id: "STRK/USDC",
          base_asset_id: "STRK",
          quote_asset_id: "USDC",
        }]}
        balances={[]}
        pendingDeposits={[]}
        withdrawableNotes={[]}
        claimDelaySeconds={0}
        walletReady={false}
        starknetAddress="0xabc"
        activeOrders={[]}
        setOpenSlide={setOpenSlide}
        allOrders={[]}
        onCancelOrder={vi.fn()}
        onClaimNote={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));

    expect(setOpenSlide).toHaveBeenNthCalledWith(1, "deposit");
    expect(setOpenSlide).toHaveBeenNthCalledWith(2, "withdraw");
  });

  it("keeps withdrawable notes compact and below active orders", () => {
    const note: WithdrawableNote = {
      note_commitment: "0xnote123456",
      batch_id: "batch-1",
      source: "settlement_output",
      asset: "USDC",
      amount: "1000000",
      locked: false,
      spent: false,
      metadata_commitment: "0xmeta",
    };

    render(
      <RightColumn
        activeBatch={null}
        activePairId="STRK/USDC"
        settlementTranscripts={{
          "batch-1": {
            batch_id: "batch-1",
            pair_id: "STRK/USDC",
            batch_epoch: 1,
            clearing_price: "50000000000000000",
            settled_at_unix_ms: Date.now() - 1_000,
          },
        }}
        online
        allAssets={["STRK", "USDC"]}
        pairs={[{
          pair_id: "STRK/USDC",
          base_asset_id: "STRK",
          quote_asset_id: "USDC",
        }]}
        balances={[]}
        pendingDeposits={[]}
        withdrawableNotes={[note]}
        claimDelaySeconds={0}
        walletReady
        starknetAddress="0xabc"
        activeOrders={[activeOrder()]}
        setOpenSlide={vi.fn()}
        allOrders={[activeOrder()]}
        onCancelOrder={vi.fn()}
        onClaimNote={vi.fn()}
      />,
    );

    const activeHeading = screen.getByText("Active");
    const notesToggle = screen.getByRole("button", { name: /Notes/i });
    expect(
      activeHeading.compareDocumentPosition(notesToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText(/outputs ready to withdraw/i)).not.toBeInTheDocument();

    fireEvent.click(notesToggle);

    const claimSection = notesToggle.closest(".claim-section");
    expect(claimSection).not.toBeNull();
    expect(within(claimSection as HTMLElement).getByText("USDC")).toBeInTheDocument();
    expect(within(claimSection as HTMLElement).getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("shows current-pair assets without crowding the active order list with unrelated balances", () => {
    render(
      <RightColumn
        activeBatch={null}
        activePairId="STRK/USDC"
        settlementTranscripts={{}}
        online
        allAssets={["STRK", "USDC", "ETH"]}
        pairs={[{
          pair_id: "STRK/USDC",
          base_asset_id: "STRK",
          quote_asset_id: "USDC",
        }]}
        balances={[
          { asset: "STRK", available: "1000000000000000000", locked: "0" },
          { asset: "USDC", available: "1000000", locked: "0" },
          { asset: "ETH", available: "2000000000000000000", locked: "0" },
        ]}
        pendingDeposits={[]}
        withdrawableNotes={[]}
        claimDelaySeconds={0}
        walletReady
        starknetAddress="0xabc"
        activeOrders={[activeOrder()]}
        setOpenSlide={vi.fn()}
        allOrders={[activeOrder()]}
        onCancelOrder={vi.fn()}
        onClaimNote={vi.fn()}
      />,
    );

    const assetsSection = screen.getByText("Assets").closest(".right-section");
    expect(assetsSection).not.toBeNull();
    expect(within(assetsSection as HTMLElement).getByText("STRK")).toBeInTheDocument();
    expect(within(assetsSection as HTMLElement).getByText("USDC")).toBeInTheDocument();
    expect(within(assetsSection as HTMLElement).queryByText("ETH")).not.toBeInTheDocument();
  });
});
