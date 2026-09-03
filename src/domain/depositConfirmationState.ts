import { normalizeOptionalFelt } from "./felt";

export type DepositConfirmationRecord = {
  source?: "deposit" | "settlement_output";
  spent?: boolean;
  deposit_confirmed?: boolean;
  deposit_failed?: boolean;
  deposit_failure_reason?: string;
  funding_commitment?: string;
  pending_deposit_tx?: string;
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
  record.deposit_failed = undefined;
  record.deposit_failure_reason = undefined;
}

export function markDepositRecordFailed(
  record: DepositConfirmationRecord,
  reason: string,
) {
  record.deposit_confirmed = false;
  record.deposit_failed = true;
  record.deposit_failure_reason = reason;
}

export function pendingDepositFailureReason(input: {
  record: DepositConfirmationRecord;
  status: DepositReceiptState | null;
  nowUnixMs: number;
  inFlightRequestId: string | null;
  failureGraceMs: number;
  confirmedRegistrationGraceMs: number;
}): string | null {
  const ageMs =
    input.nowUnixMs -
    (input.record.deposit_requested_at_unix_ms ?? input.nowUnixMs);
  if (!input.record.pending_deposit_tx) {
    if (
      input.record.deposit_request_id &&
      input.record.deposit_request_id === input.inFlightRequestId
    ) {
      return null;
    }
    return ageMs >= input.failureGraceMs
      ? "Deposit transaction was not submitted. Please retry the deposit."
      : null;
  }
  if (input.status?.failed) {
    return input.status.reason ?? "Deposit transaction failed.";
  }
  if (input.status?.notFound && ageMs >= input.failureGraceMs) {
    return "Deposit transaction was not found on Starknet.";
  }
  if (
    input.status?.confirmed &&
    ageMs >= input.confirmedRegistrationGraceMs
  ) {
    return "Deposit transaction confirmed, but no Zylith note was registered.";
  }
  return null;
}
