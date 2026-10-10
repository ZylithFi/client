import { describe, expect, it } from "vitest";

import {
  ERROR_CATALOG,
  failureFromCode,
  failureText,
  markOperationSubmissionNotStarted,
  markOperationSubmissionRejected,
  markOperationSubmissionStarted,
  normalizeFailure,
  sanitizedDiagnosticReport,
  userFacingErrorMessage,
  type ErrorFamily,
} from "./userFacingErrors";

const EXPECTED_FAMILIES = new Set<ErrorFamily>([
  "wallet-access",
  "wallet-capability",
  "network-mismatch",
  "feature-availability",
  "reference-pricing",
  "validation",
  "balance",
  "privacy-safety",
  "transaction-outcome",
  "order-lifecycle",
  "withdrawal-state",
  "unexpected-application",
]);

describe("error catalog invariants", () => {
  it("uses exactly the twelve intended presentation families", () => {
    expect(new Set(Object.values(ERROR_CATALOG).map((entry) => entry.family))).toEqual(
      EXPECTED_FAMILIES
    );
  });

  it("gives every internal code complete user-safe presentation data", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(entry.title.trim()).not.toBe("");
      expect(typeof entry.message).toBe("string");
      expect(`${entry.title} ${entry.message}`).not.toMatch(
        /calldata|stack trace|resource_bounds|paymaster_address|proof facts|PROOF[0-9]|0x[0-9a-f]{20,}|\boperator\b|\brelay\b|\bprover\b|\bgateway\b|deployment manifest|private-request configuration|fee-token/i
      );
      if (entry.outcome === "unknown" || entry.outcome === "submitted") {
        expect(entry.retrySafe, code).toBe(false);
      }
    }
  });

  it("uses reusable UI copy templates instead of one presentation per code", () => {
    const codes = Object.keys(ERROR_CATALOG);
    const templates = new Set(Object.values(ERROR_CATALOG).map((entry) => entry.uiCopy));

    expect(codes).toHaveLength(64);
    expect(templates.size).toBeGreaterThanOrEqual(25);
    expect(templates.size).toBeLessThanOrEqual(35);
    expect(ERROR_CATALOG.WALLET_CONNECT_REQUIRED.uiCopy).toBe("wallet-connect");
    expect(ERROR_CATALOG.WALLET_CONNECTION_FAILED.uiCopy).toBe("wallet-connect-failed");
    expect(ERROR_CATALOG.WALLET_CONNECTION_TIMEOUT.uiCopy).toBe("wallet-connect-failed");
    expect(ERROR_CATALOG.SCREENING_UNAVAILABLE.uiCopy).toBe("feature-unavailable");
    expect(ERROR_CATALOG.PROOF_VERSION_INCOMPATIBLE.uiCopy).toBe("feature-unavailable");
    expect(ERROR_CATALOG.PRIVATE_REQUEST_CONFIGURATION_INCOMPATIBLE.uiCopy)
      .toBe("feature-unavailable");
    expect(ERROR_CATALOG.ORDER_NOT_OPEN.uiCopy).toBe("order-state-changed");
    expect(ERROR_CATALOG.CANCELLATION_CONFLICT.uiCopy).toBe("order-state-changed");
    for (const code of [
      "DEPOSIT_NOT_SUBMITTED",
      "TRANSACTION_NOT_SUBMITTED",
      "ORDER_SUBMISSION_FAILED",
      "CANCELLATION_FAILED",
      "WITHDRAWAL_NOT_SUBMITTED",
    ] as const) {
      expect(ERROR_CATALOG[code].uiCopy, code).toBe("operation-not-submitted");
    }
    expect(ERROR_CATALOG.ORDER_FAILED.uiCopy).toBe("action-rejected");
  });

  it("renders exact contextual balance, minimum, precision, and network guidance", () => {
    expect(failureFromCode("INSUFFICIENT_AVAILABLE_BALANCE", {
      asset: "USDC",
      availableAmount: "25",
      requiredAmount: "40",
      reservedAmount: "10",
    })).toMatchObject({
      title: "Insufficient USDC balance",
      message: "Available: 25 USDC. Required: 40 USDC. 10 USDC is reserved in open orders.",
    });
    expect(failureFromCode("BELOW_MINIMUM", {
      asset: "USDC",
      minimumAmount: "50",
    }).title).toBe("Minimum: 50 USDC");
    expect(failureFromCode("PRECISION_UNSUPPORTED", {
      asset: "USDC",
      precision: 6,
    }).message).toBe("USDC supports up to 6 decimal places.");
    expect(failureFromCode("NETWORK_MISMATCH", {
      networkName: "Starknet Mainnet",
    }).title).toBe("Switch to Starknet Mainnet");
  });

  it("renders operation-specific financial outcomes and the cancellation fill warning", () => {
    expect(failureFromCode("DEPOSIT_STATUS_UNKNOWN")).toMatchObject({
      title: "Checking deposit…",
      message: "Do not submit another deposit until its status is confirmed.",
      actionLabel: "Check status",
    });
    expect(failureFromCode("ORDER_SUBMISSION_FAILED")).toMatchObject({
      title: "Order wasn't submitted",
      message: "Review the order and try again.",
      actionLabel: "Try again",
    });
    expect(failureFromCode("CANCELLATION_PENDING")).toMatchObject({
      title: "Cancellation pending",
      message: "Your order may still fill until cancellation is confirmed.",
      actionLabel: "Check status",
    });
    expect(failureFromCode("WITHDRAWAL_FAILED")).toMatchObject({
      title: "Withdrawal failed",
      message: "Refresh your private balance before trying again.",
      actionLabel: "Refresh",
    });
    expect(failureFromCode("DEPOSIT_CREDIT_PENDING")).toMatchObject({
      title: "Updating private balance…",
      message: "Public funding is confirmed. Your private balance is still updating.",
    });
  });

  it("aligns wallet copy and action labels with the recovery that actually runs", () => {
    expect(failureFromCode("WALLET_CONNECT_REQUIRED")).toMatchObject({
      title: "Connect wallet",
      actionLabel: "Connect wallet",
    });
    expect(failureFromCode("WALLET_CONNECTION_FAILED")).toMatchObject({
      title: "Couldn't connect",
      recovery: "retry",
      actionLabel: "Try again",
    });
    expect(failureFromCode("WALLET_SIGNATURE_TIMEOUT")).toMatchObject({
      title: "Approval timed out",
      recovery: "retry",
      actionLabel: "Try again",
    });
    expect(failureFromCode("WALLET_PRIVATE_ACTION_UNSUPPORTED")).toMatchObject({
      title: "Unsupported wallet",
      actionLabel: "Change wallet",
    });
    expect(failureFromCode("WALLET_IDENTITY_CHANGED")).toMatchObject({
      title: "Wallet changed",
      recovery: "reconnect",
      actionLabel: "Switch back to wallet",
    });
    expect(failureFromCode("WALLET_NOT_ACTIVATED")).toMatchObject({
      title: "Activate your wallet",
      message: "Open your wallet and complete account activation, then try again.",
    });
  });

  it("keeps shared copy separate from code-specific recovery semantics", () => {
    expect(ERROR_CATALOG.WALLET_CONNECT_REQUIRED).toMatchObject({
      uiCopy: "wallet-connect",
      retrySafe: false,
      recovery: "reconnect",
    });
    expect(ERROR_CATALOG.WALLET_CONNECTION_FAILED).toMatchObject({
      uiCopy: "wallet-connect-failed",
      retrySafe: true,
      recovery: "retry",
    });
    expect(ERROR_CATALOG.DEPOSIT_STATUS_UNKNOWN).toMatchObject({
      uiCopy: "operation-status-unknown",
      retrySafe: false,
      recovery: "check-status",
    });
    expect(ERROR_CATALOG.TRANSACTION_STATUS_UNKNOWN.uiCopy)
      .toBe(ERROR_CATALOG.DEPOSIT_STATUS_UNKNOWN.uiCopy);
    expect(ERROR_CATALOG.OPERATOR_UNAVAILABLE).toMatchObject({
      recovery: "none",
      retrySafe: false,
    });
    expect(ERROR_CATALOG.RELAY_UNAVAILABLE).toMatchObject({
      recovery: "none",
      retrySafe: false,
    });
    expect(ERROR_CATALOG.DEPLOYMENT_UNAVAILABLE).toMatchObject({
      recovery: "none",
      retrySafe: false,
    });
  });

  it("overrides unsafe retry metadata for unknown and submitted outcomes", () => {
    const failure = failureFromCode("NETWORK_REQUEST_FAILED", {
      outcome: "unknown",
      presentation: "toast",
    });

    expect(failure.retrySafe).toBe(false);
    expect(failure.recovery).toBe("check-status");
    expect(failure.presentation).toBe("status-screen");
    expect(failure.title).toBe("Checking transaction…");
    expect(failure.message).not.toMatch(/try again/i);
  });

  it("does not let a callsite downgrade a blocking safety modal", () => {
    expect(failureFromCode("PRIVACY_SAFETY_BLOCK", {
      presentation: "status-screen",
    }).presentation).toBe("modal");
    expect(failureFromCode("PRIVATE_OPERATION_INVARIANT_FAILED", {
      presentation: "inline",
    }).presentation).toBe("modal");
  });
});

describe("normalizeFailure", () => {
  it.each([
    ["Wallet did not return an account", { operation: "connect" }, "WALLET_CONNECT_REQUIRED"],
    ["Wallet connection failed", { operation: "connect" }, "WALLET_CONNECTION_FAILED"],
    ["INVALID_SIGNATURE", { operation: "authorize" }, "WALLET_SESSION_INVALID"],
    ["Wallet signature request timed out", { operation: "authorize" }, "WALLET_SIGNATURE_TIMEOUT"],
    ["The selected wallet does not support private STRK20 actions.", { operation: "deposit" }, "WALLET_PRIVATE_ACTION_UNSUPPORTED"],
    ["Wrong Starknet network", { operation: "deposit" }, "NETWORK_MISMATCH"],
    ["Requested contract address 0x1 is not deployed", { operation: "deposit" }, "CONTRACTS_UNAVAILABLE"],
    ["Deployment manifest is missing required data", { operation: "load" }, "DEPLOYMENT_UNAVAILABLE"],
    ["Target service is not configured", { operation: "deposit" }, "DEPOSIT_UNAVAILABLE"],
    ["Reference price is unavailable", { operation: "order" }, "REFERENCE_PRICE_UNAVAILABLE"],
    ["Enter a valid amount", { operation: "deposit" }, "INVALID_AMOUNT"],
    ["STRK supports at most 18 decimal places", { operation: "order" }, "PRECISION_UNSUPPORTED"],
    ["Order is below the pair's minimum size", { operation: "order" }, "BELOW_MINIMUM"],
    ["Connected wallet balance is below the amount", { operation: "deposit" }, "INSUFFICIENT_WALLET_BALANCE"],
    ["Depositing the fee token would leave no room for the wallet transaction fee", { operation: "deposit" }, "INSUFFICIENT_NETWORK_FEE_BALANCE"],
    ["Actual fee exceeds balance", { operation: "deposit" }, "INSUFFICIENT_NETWORK_FEE_BALANCE"],
    ["INSUFFICIENT_PRIVATE_BALANCE", { operation: "withdrawal" }, "INSUFFICIENT_PRIVATE_FEE_BALANCE"],
    ["Private deposit privacy warning: USER_LINKAGE", { operation: "deposit" }, "PRIVACY_SAFETY_BLOCK"],
    ["Private deposit proof failed: SCREENING_REQUIRED", { operation: "deposit" }, "SCREENING_UNAVAILABLE"],
    ["PROOF_VERSION_NOT_ALLOWED", { operation: "deposit" }, "PROOF_VERSION_INCOMPATIBLE"],
    ["Transfer allowance exceeded", { operation: "deposit" }, "DEPOSIT_STATUS_UNKNOWN"],
    ["Proof submission failed", { operation: "deposit" }, "DEPOSIT_STATUS_UNKNOWN"],
    ["Transaction relay did not return a transaction hash", { operation: "deposit" }, "DEPOSIT_STATUS_UNKNOWN"],
    ["Starknet RPC request failed", { operation: "deposit" }, "DEPOSIT_STATUS_UNKNOWN"],
    ["No available USDC balance can fund this order", { operation: "order", domain: "order" }, "INSUFFICIENT_AVAILABLE_BALANCE"],
    ["Order details are invalid", { operation: "order", outcome: "not-submitted" }, "ORDER_SUBMISSION_FAILED"],
    ["Reconnect and authorize your wallet before cancelling this order", { operation: "cancel" }, "CANCELLATION_AUTHORIZATION_REQUIRED"],
    ["The order is not open", { operation: "cancel" }, "ORDER_NOT_OPEN"],
    ["Withdrawals are not configured for this deployment", { operation: "withdrawal" }, "WITHDRAWAL_UNAVAILABLE"],
    ["Selected note is not withdrawable", { operation: "withdrawal" }, "WITHDRAWAL_BALANCE_CHANGED"],
    ["No available note can be withdrawn", { operation: "withdrawal" }, "NO_WITHDRAWABLE_FUNDS"],
  ] as const)("maps catalog source %s", (message, context, code) => {
    expect(normalizeFailure(new Error(message), context).code).toBe(code);
  });

  it("treats user rejection as neutral cancellation with no retry instruction", () => {
    expect(normalizeFailure(new Error("User rejected the request"), {
      operation: "authorize",
    })).toMatchObject({
      code: "WALLET_REQUEST_CANCELLED",
      severity: "informational",
      outcome: "not-submitted",
      recovery: "none",
      retrySafe: false,
    });
  });

  it("distinguishes connection, signature, and transaction timeouts", () => {
    expect(normalizeFailure(new Error("Starknet wallet request timed out"), {
      operation: "connect",
    }).code).toBe("WALLET_CONNECTION_TIMEOUT");
    expect(normalizeFailure(new Error("Wallet signature request timed out"), {
      operation: "authorize",
    }).code).toBe("WALLET_SIGNATURE_TIMEOUT");

    const transaction = normalizeFailure(
      new Error("Starknet wallet transaction timed out"),
      { operation: "deposit", domain: "deposit" }
    );
    expect(transaction).toMatchObject({
      code: "DEPOSIT_STATUS_UNKNOWN",
      outcome: "unknown",
      recovery: "check-status",
      retrySafe: false,
    });
  });

  it("never treats an ambiguous state-changing network failure as safe to retry", () => {
    for (const operation of ["deposit", "order", "cancel", "withdrawal"] as const) {
      const failure = normalizeFailure(new Error("fetch failed"), { operation });
      expect(failure.retrySafe, operation).toBe(false);
      expect(failure.recovery, operation).toBe("check-status");
      expect(["unknown", "submitted"]).toContain(failure.outcome);
    }
  });

  it("allows a fresh order only after authoritative rejection", () => {
    expect(normalizeFailure(
      markOperationSubmissionRejected(new Error("operator rejected request")),
      { operation: "order" }
    )).toMatchObject({
      code: "ORDER_FAILED",
      outcome: "failed",
      recovery: "retry",
      retrySafe: true,
    });
  });

  it("allows retry for a failed read-only network request", () => {
    expect(normalizeFailure(new Error("fetch failed"), {
      operation: "read",
    })).toMatchObject({
      code: "NETWORK_REQUEST_FAILED",
      outcome: "not-submitted",
      recovery: "retry",
      retrySafe: true,
    });
  });

  it("fails closed on proof-version and screening incompatibility", () => {
    expect(normalizeFailure(new Error(
      "Invalid proof facts: Proof version 88314448135728 (PROOF0) is not allowed under this protocol version."
    ), { operation: "deposit" })).toMatchObject({
      code: "PROOF_VERSION_INCOMPATIBLE",
      severity: "critical",
      retrySafe: false,
      outcome: "not-submitted",
    });
    expect(normalizeFailure(new Error(
      "Private deposit proof failed: Execution reverted: SCREENING_REQUIRED"
    ), { operation: "deposit" }).code).toBe("SCREENING_UNAVAILABLE");
  });

  it("distinguishes public, private-fee, and available-order balances", () => {
    expect(normalizeFailure(new Error("balance insufficient"), {
      operation: "deposit",
      domain: "deposit",
    }).code).toBe("INSUFFICIENT_WALLET_BALANCE");
    expect(normalizeFailure(new Error("INSUFFICIENT_PRIVATE_BALANCE"), {
      operation: "withdrawal",
    }).code).toBe("INSUFFICIENT_PRIVATE_FEE_BALANCE");
    expect(normalizeFailure(new Error("No available USDC balance can fund this order"), {
      operation: "order",
      domain: "order",
      asset: "USDC",
    }).code).toBe("INSUFFICIENT_AVAILABLE_BALANCE");
  });

  it("maps a changed wallet to reconciliation instead of replay", () => {
    const failure = normalizeFailure(
      new Error("Connected Starknet wallet changed during the private withdrawal."),
      { operation: "withdrawal" }
    );

    expect(failure).toMatchObject({
      code: "WALLET_IDENTITY_CHANGED",
      outcome: "unknown",
      recovery: "reconnect",
      retrySafe: false,
      severity: "critical",
    });
  });

  it.each([
    ["Connected Starknet wallet chain does not match the deployment network.", "NETWORK_MISMATCH"],
    ["The operator's execution keys do not match this deployment. Private requests are disabled.", "PRIVATE_REQUEST_CONFIGURATION_INCOMPATIBLE"],
    ["The encrypted local wallet state is damaged and no valid recovery snapshot was available.", "PRIVATE_STATE_DAMAGED"],
    ["Backed-up note data conflicts with local note data.", "PRIVATE_STATE_CONFLICT"],
    ["The wallet produced an inconsistent withdrawal request.", "PRIVATE_OPERATION_INVARIANT_FAILED"],
    ["A deposit is already in progress.", "DEPOSIT_STATUS_UNKNOWN"],
    ["This withdrawal is already being received.", "WITHDRAWAL_PENDING"],
    ["This withdrawal is no longer available.", "WITHDRAWAL_BALANCE_CHANGED"],
    ["An order submission is already in progress.", "ORDER_ALREADY_IN_PROGRESS"],
  ])("maps runtime invariant %s to %s", (message, code) => {
    expect(normalizeFailure(new Error(message), {
      operation: "deposit",
    }).code).toBe(code);
  });

  it("uses explicit proof submission markers before interpreting text", () => {
    const unknown = Object.assign(new Error("opaque failure"), {
      zylithProofSubmissionStarted: true,
    });
    const rejected = Object.assign(new Error("opaque failure"), {
      zylithProofSubmissionStarted: true,
      zylithProofSubmissionRejected: true,
    });

    expect(normalizeFailure(unknown, { operation: "deposit" })).toMatchObject({
      code: "DEPOSIT_STATUS_UNKNOWN",
      outcome: "unknown",
      retrySafe: false,
    });
    expect(normalizeFailure(rejected, { operation: "deposit" })).toMatchObject({
      code: "DEPOSIT_STATUS_UNKNOWN",
      outcome: "unknown",
      retrySafe: false,
    });

    const misleadingRejected = Object.assign(new Error("User rejected the request"), {
      zylithProofSubmissionStarted: true,
      zylithProofSubmissionRejected: true,
    });
    expect(normalizeFailure(misleadingRejected, { operation: "withdrawal" })).toMatchObject({
      code: "WITHDRAWAL_STATUS_UNKNOWN",
      outcome: "unknown",
      severity: "warning",
      retrySafe: false,
    });

    expect(normalizeFailure(
      markOperationSubmissionRejected(new Error("opaque operator detail")),
      { operation: "cancel", outcome: "not-submitted" }
    )).toMatchObject({
      code: "CANCELLATION_CONFLICT",
      outcome: "failed",
      retrySafe: false,
    });

    const wrappedStarted = new Error("User rejected the request", {
      cause: unknown,
    });
    expect(normalizeFailure(wrappedStarted, { operation: "deposit" })).toMatchObject({
      code: "DEPOSIT_STATUS_UNKNOWN",
      outcome: "unknown",
      recovery: "check-status",
      retrySafe: false,
    });

    expect(normalizeFailure(
      markOperationSubmissionStarted(new Error("User rejected the request")),
      { operation: "deposit", outcome: "not-submitted" }
    )).toMatchObject({
      code: "DEPOSIT_STATUS_UNKNOWN",
      outcome: "unknown",
      recovery: "check-status",
      retrySafe: false,
    });
  });

  it("uses retry only when a boundary explicitly proves submission never started", () => {
    expect(normalizeFailure(
      markOperationSubmissionNotStarted(new Error("preflight rejected")),
      { operation: "withdrawal" },
    )).toMatchObject({
      code: "WITHDRAWAL_NOT_SUBMITTED",
      outcome: "not-submitted",
      recovery: "retry",
      retrySafe: true,
    });

    expect(normalizeFailure(new Error("rate limited"), {
      operation: "withdrawal",
    })).toMatchObject({
      code: "WITHDRAWAL_STATUS_UNKNOWN",
      outcome: "unknown",
      recovery: "check-status",
      retrySafe: false,
    });
  });

  it("distinguishes a withdrawal proven not submitted from a pending withdrawal", () => {
    expect(normalizeFailure(new Error("opaque preflight failure"), {
      operation: "withdrawal",
      outcome: "not-submitted",
    })).toMatchObject({
      code: "WITHDRAWAL_NOT_SUBMITTED",
      outcome: "not-submitted",
      recovery: "retry",
      retrySafe: true,
    });

    expect(normalizeFailure(new Error("opaque acknowledgement failure"), {
      operation: "withdrawal",
      outcome: "unknown",
    })).toMatchObject({
      code: "WITHDRAWAL_STATUS_UNKNOWN",
      outcome: "unknown",
      recovery: "check-status",
      retrySafe: false,
    });
  });

  it("does not describe an unknown withdrawal result as submitted", () => {
    const failure = normalizeFailure(new Error("gateway response was lost"), {
      operation: "withdrawal",
    });

    expect(failure.code).toBe("WITHDRAWAL_STATUS_UNKNOWN");
    expect(failure.outcome).toBe("unknown");
    expect(failure.retrySafe).toBe(false);
    expect(failure.message).not.toMatch(/has been submitted/i);
  });

  it("classifies private STRK fee shortages as private fee balance errors", () => {
    const failure = normalizeFailure(
      new Error("Your private STRK balance does not cover the STRK20 withdrawal fee."),
      { operation: "withdrawal" }
    );

    expect(failure.code).toBe("INSUFFICIENT_PRIVATE_FEE_BALANCE");
    expect(failure.outcome).toBe("not-submitted");
  });

  it("classifies known invalid deposit amounts as field validation", () => {
    const failure = normalizeFailure(new Error("Deposit amount must be greater than zero"), {
      operation: "deposit",
    });

    expect(failure.code).toBe("INVALID_AMOUNT");
    expect(failure.presentation).toBe("field");
    expect(failure.outcome).toBe("not-submitted");
  });

  it("distinguishes an unreadable wallet network from a wrong network", () => {
    expect(normalizeFailure(
      new Error("Connected Starknet wallet did not report its network."),
      { operation: "deposit" }
    )).toMatchObject({
      code: "WALLET_NETWORK_UNAVAILABLE",
      outcome: "not-submitted",
      recovery: "retry",
    });
    expect(normalizeFailure(
      new Error("Wrong Starknet network. Switch networks."),
      { operation: "deposit" }
    ).code).toBe("NETWORK_MISMATCH");
  });

  it("treats malformed private balances as invariant failures, never zero balances", () => {
    for (const message of [
      "The wallet returned a malformed private balance response.",
      "The wallet returned a malformed private balance.",
      "The wallet returned duplicate private balances for one token.",
      "The wallet produced a duplicate private-note nullifier.",
    ]) {
      expect(normalizeFailure(new Error(message), { operation: "deposit" })).toMatchObject({
        code: "PRIVATE_OPERATION_INVARIANT_FAILED",
        outcome: "unknown",
        retrySafe: false,
        severity: "critical",
      });
    }
  });

  it("classifies stored-state corruption separately from live-operation invariants", () => {
    expect(normalizeFailure(
      new Error("The stored wallet state contains duplicate notes."),
      { operation: "authorize" }
    ).code).toBe("PRIVATE_STATE_DAMAGED");
    expect(normalizeFailure(
      new Error("A funding note is assigned to conflicting orders."),
      { operation: "order" }
    ).code).toBe("PRIVATE_OPERATION_INVARIANT_FAILED");
  });

  it("recognizes deployment and reference-price validation variants", () => {
    expect(normalizeFailure(
      new Error("Deployment manifest market registry hash mismatch"),
      { operation: "load" }
    ).code).toBe("DEPLOYMENT_UNAVAILABLE");
    expect(normalizeFailure(
      new Error("The reference-price batch is stale or malformed."),
      { operation: "read" }
    ).code).toBe("REFERENCE_PRICE_UNAVAILABLE");
  });

  it("scopes a failed private runtime to the affected feature", () => {
    const error = new Error("Private trading failed to load.");
    expect(normalizeFailure(error, { operation: "deposit" }).code).toBe("DEPOSIT_UNAVAILABLE");
    expect(normalizeFailure(error, { operation: "withdrawal" }).code).toBe("WITHDRAWAL_UNAVAILABLE");
    expect(normalizeFailure(error, { operation: "order" }).code).toBe("TRADING_UNAVAILABLE");
    expect(normalizeFailure(error, { operation: "load" }).code).toBe("APPLICATION_LOAD_FAILED");
  });

  it("maps locked and changed wallet sessions to their distinct recovery states", () => {
    expect(normalizeFailure(
      new Error("Unlock your Starknet wallet and retry."),
      { operation: "deposit" }
    ).code).toBe("WALLET_CONNECT_REQUIRED");
    expect(normalizeFailure(
      new Error("Wallet session changed. Retry."),
      { operation: "deposit" }
    ).code).toBe("WALLET_IDENTITY_CHANGED");
  });

  it("marks operation outcomes without depending on mutable provider errors", () => {
    const frozen = Object.freeze(new TypeError("frozen provider failure"));
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(normalizeFailure(markOperationSubmissionStarted(frozen), {
      operation: "order",
      outcome: "not-submitted",
    })).toMatchObject({
      code: "TRANSACTION_STATUS_UNKNOWN",
      outcome: "unknown",
      retrySafe: false,
      title: "Checking order…",
    });
    expect(() => markOperationSubmissionRejected(proxy)).not.toThrow();
  });

  it("handles bounded nested, cyclic, throwing, and revoked provider values", () => {
    expect(normalizeFailure({ error: { detail: { message: "user rejected" } } }).code)
      .toBe("WALLET_REQUEST_CANCELLED");

    const cyclic: Record<string, unknown> = {};
    cyclic.error = cyclic;
    expect(normalizeFailure(cyclic).code).toBe("UNEXPECTED_FAILURE");

    const throwing = Object.defineProperty({}, "message", {
      get: () => { throw new Error("secret getter detail"); },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(normalizeFailure(throwing).code).toBe("UNEXPECTED_FAILURE");
    expect(normalizeFailure(proxy).code).toBe("UNEXPECTED_FAILURE");
  });

  it("does not expose unknown provider errors or field elements", () => {
    const secret = "wallet returned secret 0x1234567890abcdef1234567890abcdef1234567890abcdef";
    const failure = normalizeFailure(new Error(secret));

    expect(failure.code).toBe("UNEXPECTED_FAILURE");
    expect(failureText(failure)).not.toContain("wallet returned secret");
    expect(failureText(failure)).not.toContain("0x1234");
  });

  it("drops oversized provider messages instead of parsing or exposing them", () => {
    const oversized = `secret:${"x".repeat(20_000)}`;
    const failure = normalizeFailure(new Error(oversized));

    expect(failure.code).toBe("UNEXPECTED_FAILURE");
    expect(failureText(failure)).not.toContain("secret:");
  });

  it("keeps the compatibility adapter safe for persisted strings", () => {
    expect(userFacingErrorMessage(new Error("user rejected"))).toBe(
      "Cancelled. No changes were made."
    );
    expect(userFacingErrorMessage(new Error("unmapped secret detail"), "Safe fallback"))
      .toBe("Safe fallback");
  });
});

describe("sanitizedDiagnosticReport", () => {
  it("contains only allowlisted metadata and never includes raw exceptions", () => {
    const rawSecret = "private-order=buy-1000; signature=0xdeadbeef";
    const failure = normalizeFailure(new Error(rawSecret), {
      operation: "load",
      stage: "bootstrap",
      correlationId: "trace-safe-123",
    });
    const report = sanitizedDiagnosticReport(failure, {
      appVersion: "1.2.3",
      network: "mainnet",
      operation: "application-load",
    });

    expect(JSON.parse(report)).toEqual({
      code: "APPLICATION_LOAD_FAILED",
      domain: "application",
      stage: "bootstrap",
      outcome: "not-submitted",
      recovery: "retry",
      retrySafe: true,
      correlationId: "trace-safe-123",
      appVersion: "1.2.3",
      network: "mainnet",
      operation: "application-load",
    });
    expect(report).not.toContain(rawSecret);
    expect(report).not.toContain("signature");
  });

  it("omits diagnostic metadata that could carry arbitrary private text", () => {
    const failure = failureFromCode("APPLICATION_LOAD_FAILED", {
      stage: "private order: buy 1000",
      correlationId: "trace\nsecret",
    });
    const report = sanitizedDiagnosticReport(failure, {
      appVersion: "version secret words",
      network: "mainnet",
      operation: "deposit\nprivate-note",
    });

    expect(JSON.parse(report)).toEqual({
      code: "APPLICATION_LOAD_FAILED",
      domain: "application",
      stage: "unspecified",
      outcome: "not-submitted",
      recovery: "retry",
      retrySafe: true,
      network: "mainnet",
    });
  });
});
