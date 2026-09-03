import { describe, expect, it } from "vitest";
import {
  applyStrk20ExitClaimReceipt,
  applyStrk20ExitStagingReceipt,
  isRetryableStrk20ExitClaim,
  isSpendableLocalNote,
  isWithdrawableNoteLocked,
  type LocalNoteSpendState,
} from "./strk20ExitState";

describe("strk20ExitState", () => {
  it("keeps deposits unspendable until confirmation", () => {
    expect(isSpendableLocalNote({ source: "deposit" })).toBe(false);
    expect(
      isSpendableLocalNote({ source: "deposit", deposit_confirmed: true })
    ).toBe(true);
  });

  it("never treats spent notes as spendable", () => {
    expect(
      isSpendableLocalNote({
        source: "settlement_output",
        spent: true,
      })
    ).toBe(false);
    expect(
      isSpendableLocalNote({
        source: "deposit",
        deposit_confirmed: true,
        spent: true,
      })
    ).toBe(false);
  });

  it("treats staged exits without a claim tx as retryable", () => {
    const record: LocalNoteSpendState = {
      source: "settlement_output",
      pending_withdrawal_tx: "0xstage",
      strk20_exit_commitment: "0xexit",
    };
    expect(isRetryableStrk20ExitClaim(record)).toBe(true);
    expect(isWithdrawableNoteLocked(record)).toBe(false);
  });

  it("does not treat an in-flight STRK20 claim as retryable", () => {
    const record: LocalNoteSpendState = {
      source: "settlement_output",
      pending_withdrawal_tx: "0xstage",
      pending_strk20_open_note_tx: "0xclaim",
      strk20_exit_commitment: "0xexit",
    };
    expect(isRetryableStrk20ExitClaim(record)).toBe(false);
    expect(isWithdrawableNoteLocked(record)).toBe(true);
  });

  it("does not treat spent STRK20 exits as retryable", () => {
    const record: LocalNoteSpendState = {
      source: "settlement_output",
      spent: true,
      pending_withdrawal_tx: "0xstage",
      strk20_exit_commitment: "0xexit",
    };

    expect(isRetryableStrk20ExitClaim(record)).toBe(false);
    expect(isWithdrawableNoteLocked(record)).toBe(true);
  });

  it("marks a claimed STRK20 exit spent only after a confirmed successful receipt", () => {
    const record: LocalNoteSpendState = {
      locked_by_order: "order",
      pending_withdrawal_tx: "0xstage",
      pending_strk20_open_note_tx: "0xclaim",
      strk20_exit_commitment: "0xexit",
      strk20_open_note_id: "0xopen",
      withdrawal_requested_at_unix_ms: 123,
    };

    expect(
      applyStrk20ExitClaimReceipt(record, {
        failed: false,
        notFound: false,
        confirmed: true,
      })
    ).toBe(true);
    expect(record.spent).toBe(true);
    expect(record.locked_by_order).toBeUndefined();
    expect(record.pending_withdrawal_tx).toBeUndefined();
    expect(record.pending_strk20_open_note_tx).toBeUndefined();
    expect(record.strk20_open_note_id).toBe("0xopen");
  });

  it("clears only the failed claim tx and open-note id after a failed claim", () => {
    const record: LocalNoteSpendState = {
      pending_withdrawal_tx: "0xstage",
      pending_strk20_open_note_tx: "0xclaim",
      strk20_exit_commitment: "0xexit",
      strk20_open_note_id: "0xopen",
    };

    expect(
      applyStrk20ExitClaimReceipt(record, {
        failed: true,
        notFound: false,
        confirmed: true,
        reason: "reverted",
      })
    ).toBe(true);
    expect(record.spent).toBeUndefined();
    expect(record.pending_withdrawal_tx).toBe("0xstage");
    expect(record.pending_strk20_open_note_tx).toBeUndefined();
    expect(record.strk20_open_note_id).toBeUndefined();
  });

  it("ignores missing and pending receipts", () => {
    const record: LocalNoteSpendState = {
      pending_withdrawal_tx: "0xstage",
      pending_strk20_open_note_tx: "0xclaim",
      strk20_exit_commitment: "0xexit",
    };

    expect(applyStrk20ExitClaimReceipt(record, null)).toBe(false);
    expect(
      applyStrk20ExitClaimReceipt(record, {
        failed: false,
        notFound: false,
      })
    ).toBe(false);
    expect(record.pending_strk20_open_note_tx).toBe("0xclaim");
  });

  it("clears failed staging state so an output can be restaged", () => {
    const record: LocalNoteSpendState = {
      locked_by_order: "withdrawal:0xexit",
      pending_withdrawal_tx: "0xstage",
      strk20_exit_commitment: "0xexit",
      withdrawal_requested_at_unix_ms: 123,
    };

    expect(
      applyStrk20ExitStagingReceipt(record, {
        failed: true,
        notFound: false,
        confirmed: true,
        reason: "reverted",
      })
    ).toBe(true);
    expect(record.spent).toBeUndefined();
    expect(record.locked_by_order).toBeUndefined();
    expect(record.pending_withdrawal_tx).toBeUndefined();
    expect(record.strk20_exit_commitment).toBeUndefined();
    expect(record.withdrawal_requested_at_unix_ms).toBeUndefined();
  });

  it("keeps successful staged exits retryable for STRK20 claim", () => {
    const record: LocalNoteSpendState = {
      source: "settlement_output",
      pending_withdrawal_tx: "0xstage",
      strk20_exit_commitment: "0xexit",
    };

    expect(
      applyStrk20ExitStagingReceipt(record, {
        failed: false,
        notFound: false,
        confirmed: true,
      })
    ).toBe(false);
    expect(record.pending_withdrawal_tx).toBe("0xstage");
    expect(record.strk20_exit_commitment).toBe("0xexit");
    expect(isRetryableStrk20ExitClaim(record)).toBe(true);
  });
});
