import { normalizeOptionalFelt } from "./felt";

export type DepositConfirmationRecord = {
  source?: "deposit" | "settlement_output";
  spent?: boolean;
  deposit_confirmed?: boolean;
  deposit_failed?: boolean;
  deposit_failure_reason?: string;
  funding_commitment?: string;
  pending_deposit_tx?: string;
  public_transaction_confirmed?: boolean;
  deposit_request_id?: string;
  deposit_requested_at_unix_ms?: number;
};

export type DepositReceiptState = {
  failed: boolean;
  notFound: boolean;
  confirmed?: boolean;
  reason?: string;
};

export function pendingDepositRecords<T extends DepositConfirmationRecord>(
  records: T[],
): T[] {
  return records.filter(
    (record) =>
      record.source === "deposit" &&
      record.deposit_confirmed !== true &&
      !record.spent,
  );
}

export function pendingDepositFundingCommitments(
  records: DepositConfirmationRecord[],
) {
  return pendingDepositRecords(records)
    .map((record) => normalizeOptionalFelt(record.funding_commitment))
    .filter((commitment): commitment is string => Boolean(commitment));
}

export function depositRecordMatchesConfirmedFunding(
  record: DepositConfirmationRecord,
  confirmedFundingCommitments: Set<string>,
) {
  const fundingCommitment = normalizeOptionalFelt(record.funding_commitment);
  return Boolean(
    fundingCommitment && confirmedFundingCommitments.has(fundingCommitment),
  );
}

export function markDepositRecordConfirmed(record: DepositConfirmationRecord) {
  record.deposit_confirmed = true;
  record.pending_deposit_tx = undefined;
  record.public_transaction_confirmed = undefined;
  record.deposit_failed = undefined;
  record.deposit_failure_reason = undefined;
}

export function markDepositRecordFailed(
  record: DepositConfirmationRecord,
  reason: string,
) {
  record.deposit_confirmed = false;
  record.public_transaction_confirmed = undefined;
  record.deposit_failed = true;
  record.deposit_failure_reason = reason;
}

export function pendingDepositFailureReason(input: {
  record: DepositConfirmationRecord;
  status: DepositReceiptState | null;
}): string | null {
  // Missing acknowledgements, missing receipts, and confirmed public transfers without
  // private credit are all unresolved—not proof that replay is safe. Only an authoritative
  // failed receipt establishes that this particular transaction cannot later credit a note.
  if (!input.record.pending_deposit_tx) return null;
  if (input.status?.failed) {
    return input.status.reason ?? "Deposit transaction failed.";
  }
  return null;
}
