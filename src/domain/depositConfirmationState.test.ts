import { describe, expect, it } from "vitest";
import {
  depositRecordMatchesConfirmedFunding,
  markDepositRecordFailed,
  markDepositRecordConfirmed,
  pendingDepositFailureReason,
  pendingDepositFundingCommitments,
  pendingDepositRecords,
  type DepositConfirmationRecord,
} from "./depositConfirmationState";

describe("depositConfirmationState", () => {
  it("selects only unconfirmed live deposit records", () => {
    const pending: DepositConfirmationRecord = {
      source: "deposit",
      funding_commitment: "0x1",
    };
    expect(
      pendingDepositRecords([
        pending,
        { source: "deposit", deposit_confirmed: true },
        { source: "deposit", spent: true },
        { source: "settlement_output" },
      ]),
    ).toEqual([pending]);
  });

  it("normalizes pending funding commitments", () => {
    expect(
      pendingDepositFundingCommitments([
        { source: "deposit", funding_commitment: "0x000a" },
        { source: "deposit", funding_commitment: "0" },
        { source: "deposit" },
      ]),
    ).toEqual(["0xa"]);
  });

  it("marks confirmed records without leaving failure state", () => {
    const record: DepositConfirmationRecord = {
      source: "deposit",
      pending_deposit_tx: "0xtx",
      deposit_failed: true,
      deposit_failure_reason: "previous failure",
    };
    markDepositRecordConfirmed(record);
    expect(record.deposit_confirmed).toBe(true);
    expect(record.pending_deposit_tx).toBeUndefined();
    expect(record.deposit_failed).toBeUndefined();
    expect(record.deposit_failure_reason).toBeUndefined();
  });

  it("marks failed records without clearing recovery transaction data", () => {
    const record: DepositConfirmationRecord = {
      source: "deposit",
      pending_deposit_tx: "0xtx",
      deposit_confirmed: true,
    };
    markDepositRecordFailed(record, "reverted");
    expect(record.deposit_confirmed).toBe(false);
    expect(record.deposit_failed).toBe(true);
    expect(record.deposit_failure_reason).toBe("reverted");
    expect(record.pending_deposit_tx).toBe("0xtx");
  });

  it("matches confirmed funding commitments after felt normalization", () => {
    expect(
      depositRecordMatchesConfirmedFunding(
        { source: "deposit", funding_commitment: "0x000a" },
        new Set(["0xa"]),
      ),
    ).toBe(true);
  });

  it("does not fail the currently in-flight deposit request", () => {
    expect(
      pendingDepositFailureReason({
        record: {
          source: "deposit",
          deposit_request_id: "request-1",
          deposit_requested_at_unix_ms: 0,
        },
        status: null,
        nowUnixMs: 60_000,
        inFlightRequestId: "request-1",
        failureGraceMs: 1,
        confirmedRegistrationGraceMs: 1,
      }),
    ).toBeNull();
  });

  it("returns failure reasons only after the relevant grace windows", () => {
    expect(
      pendingDepositFailureReason({
        record: { source: "deposit", deposit_requested_at_unix_ms: 0 },
        status: null,
        nowUnixMs: 10,
        inFlightRequestId: null,
        failureGraceMs: 11,
        confirmedRegistrationGraceMs: 20,
      }),
    ).toBeNull();
    expect(
      pendingDepositFailureReason({
        record: { source: "deposit", deposit_requested_at_unix_ms: 0 },
        status: null,
        nowUnixMs: 11,
        inFlightRequestId: null,
        failureGraceMs: 11,
        confirmedRegistrationGraceMs: 20,
      }),
    ).toBe("Deposit transaction was not submitted. Please retry the deposit.");
    expect(
      pendingDepositFailureReason({
        record: {
          source: "deposit",
          pending_deposit_tx: "0xtx",
          deposit_requested_at_unix_ms: 0,
        },
        status: { failed: false, notFound: true },
        nowUnixMs: 11,
        inFlightRequestId: null,
        failureGraceMs: 11,
        confirmedRegistrationGraceMs: 20,
      }),
    ).toBe("Deposit transaction was not found on Starknet.");
    expect(
      pendingDepositFailureReason({
        record: {
          source: "deposit",
          pending_deposit_tx: "0xtx",
          deposit_requested_at_unix_ms: 0,
        },
        status: { failed: false, notFound: false, confirmed: true },
        nowUnixMs: 20,
        inFlightRequestId: null,
        failureGraceMs: 11,
        confirmedRegistrationGraceMs: 20,
      }),
    ).toBe("Deposit transaction confirmed, but no Zylith note was registered.");
  });
});
