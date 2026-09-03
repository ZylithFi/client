import { describe, expect, it } from "vitest";
import {
  claimableOutputs,
  pendingWithdrawalOutputs,
  safeAtomicAmount,
  settlementReadyAtMs,
  sumByAsset,
} from "./noteLifecycle";
import type { WithdrawableNote } from "./shieldedBalances";
import type { PublicSettlementTranscript } from "./auctionEpoch";

function note(overrides: Partial<WithdrawableNote> = {}): WithdrawableNote {
  return {
    note_commitment: overrides.note_commitment ?? "0xnote",
    batch_id: overrides.batch_id ?? "batch-1",
    source: overrides.source ?? "settlement_output",
    asset: overrides.asset ?? "STRK",
    amount: overrides.amount ?? "1000",
    locked: overrides.locked ?? false,
    spent: overrides.spent ?? false,
    pending_withdrawal_tx: overrides.pending_withdrawal_tx,
    metadata_commitment: overrides.metadata_commitment ?? "0xmeta",
  };
}

describe("note lifecycle", () => {
  it("uses exact settlement timestamp before transcript load fallback", () => {
    const transcripts: Record<string, PublicSettlementTranscript> = {
      "batch-1": {
        batch_id: "batch-1",
        pair_id: "STRK/USDC",
        batch_epoch: 12,
        clearing_price: "300",
        settled_at_unix_ms: 1_000,
        loaded_at_unix_ms: 9_000,
      },
    };

    expect(settlementReadyAtMs(note(), transcripts, 30)).toBe(31_000);
  });

  it("does not surface already-submitted withdrawals as claimable", () => {
    const transcripts: Record<string, PublicSettlementTranscript> = {
      "batch-1": {
        batch_id: "batch-1",
        pair_id: "STRK/USDC",
        batch_epoch: 12,
        clearing_price: "300",
        settled_at_unix_ms: 1_000,
      },
    };
    const notes = [
      note({ note_commitment: "0xready" }),
      note({ note_commitment: "0xpending", pending_withdrawal_tx: "0xtx" }),
    ];

    expect(claimableOutputs(notes, transcripts, 30, 40_000).map(n => n.note_commitment))
      .toEqual(["0xready"]);
    expect(pendingWithdrawalOutputs(notes).map(n => n.note_commitment))
      .toEqual(["0xpending"]);
  });

  it("treats malformed or negative atomic amounts as zero in totals", () => {
    expect(safeAtomicAmount("bad")).toBe(0n);
    expect(safeAtomicAmount("-1")).toBe(0n);
    expect(safeAtomicAmount("5")).toBe(5n);
    expect(sumByAsset([
      { asset: "STRK", amount: "5" },
      { asset: "STRK", amount: "bad" },
      { asset: "STRK", amount: "-7" },
    ]).get("STRK")).toBe(5n);
  });
});
