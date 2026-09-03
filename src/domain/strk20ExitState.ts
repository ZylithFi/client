export type LocalNoteSpendState = {
  source?: "deposit" | "settlement_output";
  deposit_confirmed?: boolean;
  locked_by_order?: string;
  pending_consolidation?: unknown;
  pending_withdrawal_tx?: string;
  pending_strk20_open_note_tx?: string;
  strk20_exit_commitment?: string;
  strk20_open_note_id?: string;
  withdrawal_requested_at_unix_ms?: number;
  spent?: boolean;
};

export type TransactionReceiptState = {
  failed: boolean;
  notFound: boolean;
  confirmed?: boolean;
  reason?: string;
};

export function isSpendableLocalNote(record: LocalNoteSpendState) {
  return (
    record.spent !== true &&
    !record.pending_withdrawal_tx &&
    !record.pending_consolidation &&
    (record.source !== "deposit" || record.deposit_confirmed === true)
  );
}

export function isRetryableStrk20ExitClaim(record: LocalNoteSpendState) {
  return Boolean(
    record.source === "settlement_output" &&
      record.spent !== true &&
      record.pending_withdrawal_tx &&
      record.strk20_exit_commitment &&
      !record.pending_strk20_open_note_tx &&
      !record.pending_consolidation
  );
}

export function isWithdrawableNoteLocked(record: LocalNoteSpendState) {
  const retryableStrk20Exit = isRetryableStrk20ExitClaim(record);
  return Boolean(
    record.locked_by_order ||
      record.pending_consolidation ||
      (record.pending_withdrawal_tx && !retryableStrk20Exit) ||
      (record.source === "deposit" && record.deposit_confirmed !== true)
  );
}

export function applyStrk20ExitClaimReceipt(
  record: LocalNoteSpendState,
  status: TransactionReceiptState | null
) {
  if (
    !record.strk20_exit_commitment ||
    !record.pending_strk20_open_note_tx ||
    !status
  ) {
    return false;
  }
  if (status.confirmed && !status.failed) {
    record.locked_by_order = undefined;
    record.spent = true;
    record.pending_withdrawal_tx = undefined;
    record.pending_strk20_open_note_tx = undefined;
    record.withdrawal_requested_at_unix_ms = undefined;
    return true;
  }
  if (status.failed) {
    record.pending_strk20_open_note_tx = undefined;
    record.strk20_open_note_id = undefined;
    return true;
  }
  return false;
}

export function applyStrk20ExitStagingReceipt(
  record: LocalNoteSpendState,
  status: TransactionReceiptState | null
) {
  if (!record.strk20_exit_commitment || !record.pending_withdrawal_tx || !status) {
    return false;
  }
  if (status.failed) {
    record.locked_by_order = undefined;
    record.pending_withdrawal_tx = undefined;
    record.strk20_exit_commitment = undefined;
    record.withdrawal_requested_at_unix_ms = undefined;
    return true;
  }
  return false;
}
