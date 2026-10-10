export type ErrorDomain =
  | "wallet"
  | "network"
  | "market"
  | "deposit"
  | "order"
  | "withdrawal"
  | "private-state"
  | "application";

export type ErrorFamily =
  | "wallet-access"
  | "wallet-capability"
  | "network-mismatch"
  | "feature-availability"
  | "reference-pricing"
  | "validation"
  | "balance"
  | "privacy-safety"
  | "transaction-outcome"
  | "order-lifecycle"
  | "withdrawal-state"
  | "unexpected-application";

export type OperationOutcome =
  | "not-submitted"
  | "submitted"
  | "confirmed"
  | "failed"
  | "unknown";

export type Recovery =
  | "retry"
  | "reconnect"
  | "switch-network"
  | "edit-input"
  | "refresh-state"
  | "check-status"
  | "contact-support"
  | "none";

export type ErrorPresentation =
  | "field"
  | "inline"
  | "toast"
  | "banner"
  | "modal"
  | "status-screen"
  | "fatal-screen";

export type ErrorSeverity = "informational" | "warning" | "error" | "critical";

export type FailureOperation =
  | "connect"
  | "authorize"
  | "deposit"
  | "order"
  | "cancel"
  | "withdrawal"
  | "claim"
  | "read"
  | "load";

export type ErrorCode = keyof typeof ERROR_CATALOG;

export type NormalizedFailure = {
  code: ErrorCode;
  family: ErrorFamily;
  domain: ErrorDomain;
  stage: string;
  outcome: OperationOutcome;
  recovery: Recovery;
  presentation: ErrorPresentation;
  retrySafe: boolean;
  severity: ErrorSeverity;
  uiCopy: UiCopyId;
  title: string;
  message: string;
  actionLabel?: string;
  correlationId?: string;
  operationId?: string;
};

export type FailureContext = {
  domain?: ErrorDomain;
  stage?: string;
  outcome?: OperationOutcome;
  presentation?: ErrorPresentation;
  operation?: FailureOperation;
  correlationId?: string;
  asset?: string;
  availableAmount?: string;
  requiredAmount?: string;
  reservedAmount?: string;
  minimumAmount?: string;
  precision?: number;
  networkName?: string;
  manualNetworkSwitch?: boolean;
  operationId?: string;
};

type CatalogEntry = {
  family: ErrorFamily;
  domain: ErrorDomain;
  outcome: OperationOutcome;
  recovery: Recovery;
  presentation: ErrorPresentation;
  retrySafe: boolean;
  severity: ErrorSeverity;
  uiCopy: UiCopyId;
  copyContext: CopyContext;
  title: string;
  message: string;
  actionLabel?: string;
};

type CopyContext = {
  label?: string;
  noun?: string;
  detail?: string;
  asset?: string;
  availableAmount?: string;
  requiredAmount?: string;
  reservedAmount?: string;
  minimumAmount?: string;
  precision?: number;
  networkName?: string;
  manualNetworkSwitch?: boolean;
  balanceKind?: "wallet" | "network-fee" | "private-fee" | "available";
};

const UI_COPY = {
  "wallet-connect": () => ({ title: "Connect wallet", message: "Open or unlock your Starknet wallet to continue." }),
  "wallet-connect-failed": () => ({ title: "Couldn't connect", message: "Open your wallet and try again." }),
  "wallet-authorization": () => ({ title: "Reconnect wallet", message: "Your private authorization is no longer available." }),
  "wallet-approval-timeout": () => ({ title: "Approval timed out", message: "No approval was received from your wallet." }),
  "request-cancelled": () => ({ title: "Cancelled", message: "No changes were made." }),
  "operation-status-unknown": ({ noun = "transaction" }: CopyContext) => ({
    title: `Checking ${noun}…`,
    message: `Do not submit another ${noun} until its status is confirmed.`,
  }),
  "wallet-changed": () => ({ title: "Wallet changed", message: "Switch back to the wallet that started this action. Status checks will continue." }),
  "wallet-activation": () => ({ title: "Activate your wallet", message: "Open your wallet and complete account activation, then try again." }),
  "wallet-unsupported": () => ({ title: "Unsupported wallet", message: "Choose a wallet that supports private transactions." }),
  "wallet-network-unavailable": () => ({ title: "Couldn't check network", message: "Open your wallet and try again." }),
  "network-mismatch": ({ networkName = "the configured Starknet network", manualNetworkSwitch = false }: CopyContext) => manualNetworkSwitch
    ? { title: "Switch network in your wallet", message: `Select ${networkName} to continue.` }
    : { title: `Switch to ${networkName}`, message: "Your wallet is connected to a different network." },
  "feature-unavailable": ({ label = "This feature", detail }: CopyContext) => ({
    title: `${label} unavailable`,
    message: detail ?? "",
  }),
  "price-unavailable": () => ({ title: "Price unavailable", message: "New orders are paused until current pricing is restored." }),
  "invalid-amount": () => ({ title: "Enter an amount", message: "Use an amount greater than zero." }),
  "amount-precision": ({ precision, asset }: CopyContext) => ({
    title: precision === undefined ? "Check decimal places" : `Maximum ${precision} decimal ${precision === 1 ? "place" : "places"}`,
    message: asset && precision !== undefined ? `${asset} supports up to ${precision} decimal ${precision === 1 ? "place" : "places"}.` : "Use fewer decimal places.",
  }),
  "amount-minimum": ({ asset, minimumAmount }: CopyContext) => ({
    title: minimumAmount && asset ? `Minimum: ${minimumAmount} ${asset}` : "Amount below minimum",
    message: minimumAmount && asset ? "Increase the amount to continue." : "Increase the amount to the market minimum.",
  }),
  "request-too-large": () => ({ title: "Request too large", message: "Reduce the request size and try again." }),
  "balance-required": ({ asset, availableAmount, requiredAmount, reservedAmount, balanceKind = "wallet" }: CopyContext) => {
    if (balanceKind === "network-fee") {
      return { title: `Not enough ${asset || "STRK"} for fees`, message: "Lower the amount or add funds to your wallet." };
    }
    if (balanceKind === "private-fee") {
      return { title: `Not enough private ${asset || "STRK"} for fees`, message: "Your available private balance cannot cover the fee." };
    }
    const namedAsset = asset || "balance";
    const amounts = availableAmount && requiredAmount
      ? `Available: ${availableAmount} ${namedAsset}. Required: ${requiredAmount} ${namedAsset}.`
      : balanceKind === "available"
        ? asset ? `Your available ${namedAsset} balance cannot cover this order.` : "Your available balance cannot cover this action."
        : asset ? `Your wallet does not have enough ${namedAsset}.` : "Your available balance cannot cover this action.";
    const reserved = reservedAmount && balanceKind === "available"
      ? ` ${reservedAmount} ${namedAsset} is reserved in open orders.`
      : "";
    return { title: asset ? `Insufficient ${namedAsset} balance` : "Insufficient balance", message: `${amounts}${reserved}` };
  },
  "privacy-block": () => ({ title: "This action cannot proceed safely", message: "Choose a different amount or try again later." }),
  "private-operation-stopped": () => ({ title: "Private activity paused", message: "Zylith could not verify the result. Check its status or contact support." }),
  "operation-prepare-failed": ({ noun = "transaction" }: CopyContext) => ({ title: `Couldn't prepare ${noun}`, message: "Review the details and try again." }),
  "operation-not-submitted": ({ label = "Transaction", noun = "transaction", detail }: CopyContext) => ({ title: `${label} wasn't submitted`, message: detail ?? `Review the ${noun} and try again.` }),
  "operation-pending": ({ label = "Transaction", noun = "transaction", detail }: CopyContext) => ({ title: `${label} pending`, message: detail ?? `Do not submit another ${noun} until its status is confirmed.` }),
  "operation-failed": ({ label = "Transaction", detail }: CopyContext) => ({ title: `${label} failed`, message: detail ?? "Refresh before trying again." }),
  "action-rejected": ({ label = "Order", noun = "order" }: CopyContext) => ({ title: `${label} rejected`, message: `Review the ${noun} before trying again.` }),
  "deposit-credit-pending": () => ({ title: "Updating private balance…", message: "Public funding is confirmed. Your private balance is still updating." }),
  "order-state-changed": () => ({ title: "Order status changed", message: "Refresh your orders to see its latest state." }),
  "cancellation-authorization": () => ({ title: "Cancellation needs authorization", message: "Reconnect your wallet to authorize this cancellation." }),
  "no-withdrawable-funds": () => ({ title: "No funds available to withdraw", message: "Your private balance has no currently withdrawable funds for this asset." }),
  "balance-changed": () => ({ title: "Balance changed", message: "The selected funds are no longer available. Refresh your private balance and select again." }),
  "private-balance-unavailable": () => ({ title: "Couldn't load private balance", message: "Your private balance is unavailable, not zero." }),
  "private-state-stopped": () => ({ title: "Private activity paused", message: "Your saved private activity could not be verified." }),
  "connection-problem": () => ({ title: "Connection problem", message: "Check your connection, wait a moment, then try again." }),
  "application-load-failed": () => ({ title: "Zylith could not load", message: "Reload the application. If the problem continues, copy the error report and contact support." }),
  "unexpected-failure": () => ({ title: "Something went wrong", message: "Zylith could not complete the request. Check its status before trying again." }),
} as const;

export type UiCopyId = keyof typeof UI_COPY;

function renderedCopy(uiCopy: UiCopyId, context: CopyContext = {}) {
  return UI_COPY[uiCopy](context);
}

export const ERROR_CATALOG = {
  WALLET_CONNECT_REQUIRED: entry("wallet-access", "wallet", "not-submitted", "reconnect", "inline", false, "warning", "wallet-connect", {}, "Connect wallet"),
  WALLET_CONNECTION_FAILED: entry("wallet-access", "wallet", "not-submitted", "retry", "inline", true, "error", "wallet-connect-failed"),
  WALLET_AUTHORIZATION_REQUIRED: entry("wallet-access", "wallet", "not-submitted", "reconnect", "inline", false, "warning", "wallet-authorization"),
  WALLET_REQUEST_CANCELLED: entry("wallet-access", "wallet", "not-submitted", "none", "toast", false, "informational", "request-cancelled"),
  WALLET_CONNECTION_TIMEOUT: entry("wallet-access", "wallet", "not-submitted", "retry", "inline", true, "error", "wallet-connect-failed"),
  WALLET_SIGNATURE_TIMEOUT: entry("wallet-access", "wallet", "not-submitted", "retry", "inline", true, "error", "wallet-approval-timeout"),
  WALLET_TRANSACTION_UNKNOWN: entry("transaction-outcome", "wallet", "unknown", "check-status", "status-screen", false, "warning", "operation-status-unknown", { noun: "transaction" }),
  WALLET_IDENTITY_CHANGED: entry("wallet-access", "wallet", "unknown", "reconnect", "status-screen", false, "critical", "wallet-changed", {}, "Switch back to wallet"),
  WALLET_SESSION_INVALID: entry("wallet-access", "wallet", "not-submitted", "reconnect", "inline", false, "error", "wallet-authorization"),
  WALLET_REQUEST_INVALID: entry("wallet-access", "wallet", "not-submitted", "retry", "inline", true, "error", "operation-prepare-failed", { noun: "transaction" }),
  WALLET_NOT_ACTIVATED: entry("wallet-access", "wallet", "not-submitted", "none", "inline", false, "warning", "wallet-activation"),
  WALLET_PRIVATE_ACTION_UNSUPPORTED: entry("wallet-capability", "wallet", "not-submitted", "reconnect", "inline", false, "error", "wallet-unsupported", {}, "Change wallet"),
  WALLET_NETWORK_UNAVAILABLE: entry("network-mismatch", "network", "not-submitted", "retry", "inline", true, "error", "wallet-network-unavailable"),
  NETWORK_MISMATCH: entry("network-mismatch", "network", "not-submitted", "switch-network", "inline", false, "warning", "network-mismatch"),
  CONTRACTS_UNAVAILABLE: entry("feature-availability", "network", "not-submitted", "none", "banner", false, "error", "feature-unavailable", { label: "Zylith" }),
  DEPLOYMENT_UNAVAILABLE: entry("feature-availability", "application", "not-submitted", "none", "banner", false, "error", "feature-unavailable", { label: "Zylith" }),
  TRADING_UNAVAILABLE: entry("feature-availability", "order", "not-submitted", "none", "banner", false, "error", "feature-unavailable", { label: "Trading" }),
  DEPOSIT_UNAVAILABLE: entry("feature-availability", "deposit", "not-submitted", "none", "banner", false, "error", "feature-unavailable", { label: "Deposits" }),
  WITHDRAWAL_UNAVAILABLE: entry("feature-availability", "withdrawal", "not-submitted", "none", "banner", false, "error", "feature-unavailable", { label: "Withdrawals" }),
  OPERATOR_UNAVAILABLE: entry("feature-availability", "application", "not-submitted", "none", "banner", false, "error", "feature-unavailable", { label: "Trading" }),
  RELAY_UNAVAILABLE: entry("feature-availability", "network", "not-submitted", "none", "inline", false, "error", "feature-unavailable", { label: "Deposits" }),
  REFERENCE_PRICE_UNAVAILABLE: entry("reference-pricing", "market", "not-submitted", "none", "inline", false, "warning", "price-unavailable"),
  INVALID_AMOUNT: entry("validation", "application", "not-submitted", "edit-input", "field", false, "warning", "invalid-amount"),
  PRECISION_UNSUPPORTED: entry("validation", "order", "not-submitted", "edit-input", "field", false, "warning", "amount-precision"),
  BELOW_MINIMUM: entry("validation", "order", "not-submitted", "edit-input", "field", false, "warning", "amount-minimum"),
  REQUEST_TOO_LARGE: entry("validation", "application", "not-submitted", "edit-input", "inline", false, "error", "request-too-large"),
  INSUFFICIENT_WALLET_BALANCE: entry("balance", "deposit", "not-submitted", "edit-input", "field", false, "warning", "balance-required", { balanceKind: "wallet" }),
  INSUFFICIENT_NETWORK_FEE_BALANCE: entry("balance", "deposit", "not-submitted", "edit-input", "field", false, "warning", "balance-required", { balanceKind: "network-fee" }),
  INSUFFICIENT_PRIVATE_FEE_BALANCE: entry("balance", "private-state", "not-submitted", "edit-input", "field", false, "warning", "balance-required", { balanceKind: "private-fee" }),
  INSUFFICIENT_AVAILABLE_BALANCE: entry("balance", "order", "not-submitted", "edit-input", "field", false, "warning", "balance-required", { balanceKind: "available" }),
  PRIVACY_SAFETY_BLOCK: entry("privacy-safety", "private-state", "not-submitted", "edit-input", "modal", false, "critical", "privacy-block"),
  SCREENING_UNAVAILABLE: entry("privacy-safety", "deposit", "not-submitted", "none", "banner", false, "critical", "feature-unavailable", { label: "Deposits" }),
  PROOF_VERSION_INCOMPATIBLE: entry("privacy-safety", "deposit", "not-submitted", "none", "banner", false, "critical", "feature-unavailable", { label: "Deposits" }),
  PRIVATE_REQUEST_CONFIGURATION_INCOMPATIBLE: entry("privacy-safety", "application", "not-submitted", "none", "banner", false, "critical", "feature-unavailable", { label: "Trading" }),
  PRIVATE_OPERATION_INVARIANT_FAILED: entry("privacy-safety", "private-state", "unknown", "contact-support", "modal", false, "critical", "private-operation-stopped"),
  DEPOSIT_NOT_SUBMITTED: entry("transaction-outcome", "deposit", "not-submitted", "retry", "status-screen", true, "error", "operation-not-submitted", { label: "Deposit", noun: "deposit" }),
  DEPOSIT_STATUS_UNKNOWN: entry("transaction-outcome", "deposit", "unknown", "check-status", "status-screen", false, "warning", "operation-status-unknown", { noun: "deposit" }),
  DEPOSIT_PENDING: entry("transaction-outcome", "deposit", "submitted", "check-status", "status-screen", false, "informational", "operation-pending", { label: "Deposit", noun: "deposit" }),
  DEPOSIT_FAILED: entry("transaction-outcome", "deposit", "failed", "refresh-state", "status-screen", false, "error", "operation-failed", { label: "Deposit", noun: "deposit", detail: "Refresh your balances before trying again." }),
  DEPOSIT_CREDIT_PENDING: entry("transaction-outcome", "deposit", "submitted", "check-status", "status-screen", false, "informational", "deposit-credit-pending"),
  TRANSACTION_NOT_SUBMITTED: entry("transaction-outcome", "network", "not-submitted", "retry", "status-screen", true, "error", "operation-not-submitted", { label: "Transaction", noun: "transaction" }),
  TRANSACTION_STATUS_UNKNOWN: entry("transaction-outcome", "network", "unknown", "check-status", "status-screen", false, "warning", "operation-status-unknown", { noun: "transaction" }),
  TRANSACTION_FAILED: entry("transaction-outcome", "network", "failed", "refresh-state", "status-screen", false, "error", "operation-failed", { label: "Transaction" }),
  ORDER_SUBMISSION_FAILED: entry("order-lifecycle", "order", "not-submitted", "retry", "inline", true, "error", "operation-not-submitted", { label: "Order", noun: "order", detail: "Review the order and try again." }),
  ORDER_ALREADY_IN_PROGRESS: entry("order-lifecycle", "order", "submitted", "check-status", "inline", false, "informational", "operation-pending", { label: "Order", noun: "order" }),
  ORDER_NOT_OPEN: entry("order-lifecycle", "order", "failed", "refresh-state", "inline", false, "warning", "order-state-changed"),
  ORDER_FAILED: entry("order-lifecycle", "order", "failed", "retry", "inline", true, "error", "action-rejected", { label: "Order", noun: "order" }),
  CANCELLATION_AUTHORIZATION_REQUIRED: entry("order-lifecycle", "order", "not-submitted", "reconnect", "inline", false, "warning", "cancellation-authorization"),
  CANCELLATION_PENDING: entry("order-lifecycle", "order", "submitted", "check-status", "inline", false, "informational", "operation-pending", { label: "Cancellation", noun: "cancellation", detail: "Your order may still fill until cancellation is confirmed." }),
  CANCELLATION_CONFLICT: entry("order-lifecycle", "order", "failed", "refresh-state", "inline", false, "warning", "order-state-changed"),
  CANCELLATION_FAILED: entry("order-lifecycle", "order", "not-submitted", "retry", "inline", true, "error", "operation-not-submitted", { label: "Cancellation", noun: "cancellation", detail: "Check that the order is still open, then try again." }),
  NO_WITHDRAWABLE_FUNDS: entry("withdrawal-state", "withdrawal", "not-submitted", "none", "inline", false, "informational", "no-withdrawable-funds"),
  WITHDRAWAL_BALANCE_CHANGED: entry("withdrawal-state", "withdrawal", "not-submitted", "refresh-state", "inline", false, "warning", "balance-changed"),
  WITHDRAWAL_NOT_SUBMITTED: entry("withdrawal-state", "withdrawal", "not-submitted", "retry", "status-screen", true, "error", "operation-not-submitted", { label: "Withdrawal", noun: "withdrawal" }),
  WITHDRAWAL_STATUS_UNKNOWN: entry("withdrawal-state", "withdrawal", "unknown", "check-status", "status-screen", false, "warning", "operation-status-unknown", { noun: "withdrawal" }),
  WITHDRAWAL_PENDING: entry("withdrawal-state", "withdrawal", "submitted", "check-status", "status-screen", false, "informational", "operation-pending", { label: "Withdrawal", noun: "withdrawal" }),
  WITHDRAWAL_FAILED: entry("withdrawal-state", "withdrawal", "failed", "refresh-state", "status-screen", false, "error", "operation-failed", { label: "Withdrawal", noun: "withdrawal", detail: "Refresh your private balance before trying again." }),
  PRIVATE_STATE_UNAVAILABLE: entry("feature-availability", "private-state", "unknown", "refresh-state", "inline", false, "error", "private-balance-unavailable"),
  PRIVATE_STATE_DAMAGED: entry("privacy-safety", "private-state", "unknown", "contact-support", "modal", false, "critical", "private-state-stopped"),
  PRIVATE_STATE_CONFLICT: entry("privacy-safety", "private-state", "unknown", "refresh-state", "modal", false, "critical", "private-state-stopped"),
  SERVICE_RATE_LIMITED: entry("feature-availability", "network", "not-submitted", "retry", "inline", true, "warning", "connection-problem"),
  NETWORK_REQUEST_FAILED: entry("feature-availability", "network", "not-submitted", "retry", "inline", true, "error", "connection-problem"),
  APPLICATION_LOAD_FAILED: entry("unexpected-application", "application", "not-submitted", "retry", "fatal-screen", true, "error", "application-load-failed"),
  UNEXPECTED_FAILURE: entry("unexpected-application", "application", "unknown", "contact-support", "inline", false, "error", "unexpected-failure"),
} as const satisfies Record<string, CatalogEntry>;

function entry(
  family: ErrorFamily,
  domain: ErrorDomain,
  outcome: OperationOutcome,
  recovery: Recovery,
  presentation: ErrorPresentation,
  retrySafe: boolean,
  severity: ErrorSeverity,
  uiCopy: UiCopyId,
  copyContext: CopyContext = {},
  actionLabel?: string,
): CatalogEntry {
  return {
    family,
    domain,
    outcome,
    recovery,
    presentation,
    retrySafe,
    severity,
    uiCopy,
    copyContext,
    ...(actionLabel ? { actionLabel } : {}),
    ...renderedCopy(uiCopy, copyContext),
  };
}

const MAX_STRUCTURED_ERROR_DEPTH = 8;
const MAX_STRUCTURED_ERROR_NODES = 32;
const MAX_STRUCTURED_ERROR_JSON_LENGTH = 16_384;

type StructuredErrorTraversal = {
  remainingNodes: number;
  seen: WeakSet<object>;
};

function structuredErrorMessage(
  error: unknown,
  depth = 0,
  traversal: StructuredErrorTraversal = {
    remainingNodes: MAX_STRUCTURED_ERROR_NODES,
    seen: new WeakSet<object>(),
  }
): string | null {
  if (depth > MAX_STRUCTURED_ERROR_DEPTH || traversal.remainingNodes <= 0) return null;
  try {
    if (error instanceof Error) return structuredErrorMessage(error.message, depth + 1, traversal);
  } catch {
    return null;
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (!trimmed || trimmed.length > MAX_STRUCTURED_ERROR_JSON_LENGTH) return null;
    if (!/^[\[{]/.test(trimmed)) return trimmed;
    try {
      return structuredErrorMessage(JSON.parse(trimmed), depth + 1, traversal);
    } catch {
      return trimmed;
    }
  }
  if (!error || typeof error !== "object") return null;
  if (traversal.seen.has(error)) return null;
  traversal.seen.add(error);
  traversal.remainingNodes -= 1;
  const record = error as Record<string, unknown>;
  for (const key of ["error", "detail", "message", "reason"]) {
    let value: unknown;
    try {
      value = record[key];
    } catch {
      continue;
    }
    const nested = structuredErrorMessage(value, depth + 1, traversal);
    if (nested) return nested;
  }
  return null;
}

function rawErrorMessage(error: unknown): string {
  try {
    return structuredErrorMessage(error) ?? "";
  } catch {
    return "";
  }
}

function inferredOutcome(context: FailureContext): OperationOutcome {
  if (context.outcome) return context.outcome;
  switch (context.operation) {
    case "deposit":
    case "order":
    case "cancel":
    case "withdrawal":
    case "claim":
      return "unknown";
    case "connect":
    case "authorize":
    case "read":
    case "load":
      return "not-submitted";
    default:
      return "unknown";
  }
}

function transactionCode(context: FailureContext, outcome: OperationOutcome): ErrorCode {
  if (context.operation === "deposit") {
    if (outcome === "not-submitted") return "DEPOSIT_NOT_SUBMITTED";
    if (outcome === "failed") return "DEPOSIT_FAILED";
    return "DEPOSIT_STATUS_UNKNOWN";
  }
  if (context.operation === "order") {
    if (outcome === "not-submitted") return "ORDER_SUBMISSION_FAILED";
    if (outcome === "failed") return "ORDER_FAILED";
    return "TRANSACTION_STATUS_UNKNOWN";
  }
  if (context.operation === "cancel") {
    if (outcome === "not-submitted") return "CANCELLATION_FAILED";
    if (outcome === "failed") return "CANCELLATION_CONFLICT";
    return "CANCELLATION_PENDING";
  }
  if (context.operation === "withdrawal" || context.operation === "claim") {
    if (outcome === "not-submitted") return "WITHDRAWAL_NOT_SUBMITTED";
    if (outcome === "failed") return "WITHDRAWAL_FAILED";
    if (outcome === "submitted") return "WITHDRAWAL_PENDING";
    return "WITHDRAWAL_STATUS_UNKNOWN";
  }
  if (outcome === "not-submitted") return "TRANSACTION_NOT_SUBMITTED";
  if (outcome === "failed") return "TRANSACTION_FAILED";
  return "TRANSACTION_STATUS_UNKNOWN";
}

function safeDisplayToken(value: string | undefined, maxLength = 32): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= maxLength && /^[A-Za-z0-9.,_+%:/ -]+$/.test(normalized)
    ? normalized
    : undefined;
}

export function failureFromCode(code: ErrorCode, context: FailureContext = {}): NormalizedFailure {
  const definition = ERROR_CATALOG[code];
  const correlationId = safeDiagnosticValue(context.correlationId);
  const outcome = context.outcome ?? definition.outcome;
  let recovery = definition.recovery;
  let retrySafe = definition.retrySafe;
  let presentation = definition.presentation === "modal" || definition.presentation === "fatal-screen"
    ? definition.presentation
    : context.presentation ?? definition.presentation;
  let uiCopy = definition.uiCopy;

  if (code === "NETWORK_MISMATCH" && context.manualNetworkSwitch) {
    recovery = "none";
  }

  if (outcome === "unknown" || outcome === "submitted") {
    retrySafe = false;
    if (recovery === "retry") recovery = "check-status";
    if (presentation === "field" || presentation === "toast") presentation = "status-screen";
    if (definition.outcome !== "unknown" && definition.outcome !== "submitted") {
      uiCopy = outcome === "submitted" ? "operation-pending" : "operation-status-unknown";
    }
  } else if (outcome === "failed" && definition.outcome !== "failed") {
    retrySafe = false;
    if (recovery === "retry") recovery = "refresh-state";
    uiCopy = "operation-failed";
  } else if (outcome === "confirmed") {
    retrySafe = false;
    recovery = "none";
  }

  const copy = renderedCopy(uiCopy, {
    ...definition.copyContext,
    ...(context.operation === "order" ? { noun: "order", label: "Order" } : {}),
    ...(context.operation === "cancel" ? { noun: "cancellation", label: "Cancellation" } : {}),
    ...(context.operation === "deposit" ? { noun: "deposit", label: "Deposit" } : {}),
    ...(context.operation === "withdrawal" || context.operation === "claim"
      ? { noun: "withdrawal", label: "Withdrawal" }
      : {}),
    ...(safeDisplayToken(context.asset, 24) ? { asset: safeDisplayToken(context.asset, 24) } : {}),
    ...(safeDisplayToken(context.availableAmount) ? { availableAmount: safeDisplayToken(context.availableAmount) } : {}),
    ...(safeDisplayToken(context.requiredAmount) ? { requiredAmount: safeDisplayToken(context.requiredAmount) } : {}),
    ...(safeDisplayToken(context.reservedAmount) ? { reservedAmount: safeDisplayToken(context.reservedAmount) } : {}),
    ...(safeDisplayToken(context.minimumAmount) ? { minimumAmount: safeDisplayToken(context.minimumAmount) } : {}),
    ...(Number.isSafeInteger(context.precision) && context.precision! >= 0 && context.precision! <= 255
      ? { precision: context.precision }
      : {}),
    ...(safeDisplayToken(context.networkName, 48) ? { networkName: safeDisplayToken(context.networkName, 48) } : {}),
    ...(context.manualNetworkSwitch ? { manualNetworkSwitch: true } : {}),
  });
  const defaultActionLabels: Partial<Record<Recovery, string>> = {
    retry: "Try again",
    reconnect: "Reconnect wallet",
    "switch-network": "Switch network",
    "edit-input": "Edit amount",
    "refresh-state": "Refresh",
    "check-status": "Check status",
    "contact-support": "Copy support details",
  };
  const actionLabel = recovery === definition.recovery
    ? definition.actionLabel ?? defaultActionLabels[recovery]
    : defaultActionLabels[recovery];

  return {
    code,
    family: definition.family,
    domain: context.domain ?? definition.domain,
    stage: context.stage ?? "unspecified",
    outcome,
    recovery,
    presentation,
    retrySafe,
    severity: definition.severity,
    uiCopy,
    title: copy.title,
    message: copy.message,
    ...(actionLabel ? { actionLabel } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(safeDiagnosticValue(context.operationId) ? { operationId: safeDiagnosticValue(context.operationId) } : {}),
  };
}

function hasErrorMarker(
  error: unknown,
  key:
    | "zylithOperationSubmissionStarted"
    | "zylithOperationSubmissionRejected"
    | "zylithOperationSubmissionNotStarted"
    | "zylithProofSubmissionStarted"
    | "zylithProofSubmissionRejected",
  seen = new Set<unknown>(),
  depth = 0
): boolean {
  if (!error || typeof error !== "object" || seen.has(error) || depth > 8 || seen.size >= 32) {
    return false;
  }
  seen.add(error);
  try {
    const record = error as Record<string, unknown>;
    return record[key] === true || hasErrorMarker(record.cause, key, seen, depth + 1);
  } catch {
    return false;
  }
}

/**
 * Carries an authoritative negative acknowledgement across async/UI boundaries.
 * The marker is intentionally non-enumerable so it cannot leak through ordinary
 * serialization, while `cause` retains the original error for internal logs.
 */
export function markOperationSubmissionRejected(error: unknown): Error {
  return markOperationOutcome(
    error,
    "zylithOperationSubmissionRejected",
    "Operation submission was rejected"
  );
}

/** Carries proof that an operation failed before its execution boundary and is safe to replay. */
export function markOperationSubmissionNotStarted(error: unknown): Error {
  return markOperationOutcome(
    error,
    "zylithOperationSubmissionNotStarted",
    "Operation submission was not started"
  );
}

/** Marks a submission whose acknowledgement is ambiguous and therefore unsafe to replay. */
export function markOperationSubmissionStarted(error: unknown): Error {
  return markOperationOutcome(
    error,
    "zylithOperationSubmissionStarted",
    "Operation submission result is unknown"
  );
}

function markOperationOutcome(
  error: unknown,
  key:
    | "zylithOperationSubmissionStarted"
    | "zylithOperationSubmissionRejected"
    | "zylithOperationSubmissionNotStarted",
  fallbackMessage: string
): Error {
  let marked: Error;
  try {
    marked = error instanceof Error
      ? error
      : new Error(rawErrorMessage(error) || fallbackMessage, { cause: error });
    Object.defineProperty(marked, key, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    return marked;
  } catch {
    marked = new Error(rawErrorMessage(error) || fallbackMessage, { cause: error });
    Object.defineProperty(marked, key, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    return marked;
  }
}

export function normalizeFailure(error: unknown, context: FailureContext = {}): NormalizedFailure {
  const message = rawErrorMessage(error);
  const lower = message.toLowerCase();
  const submissionStarted = hasErrorMarker(error, "zylithOperationSubmissionStarted")
    || hasErrorMarker(error, "zylithProofSubmissionStarted");
  const definitiveRejection = hasErrorMarker(error, "zylithOperationSubmissionRejected");
  const definitiveNotStarted = hasErrorMarker(error, "zylithOperationSubmissionNotStarted")
    || hasErrorMarker(error, "zylithProofSubmissionRejected");
  const manualNetworkSwitch = (() => {
    try {
      if (!error || typeof error !== "object") return null;
      const record = error as Record<string, unknown>;
      if (record.name !== "WalletNetworkSwitchUnsupportedError") return null;
      return typeof record.networkName === "string" ? record.networkName : undefined;
    } catch {
      return null;
    }
  })();
  let outcome = inferredOutcome(context);
  if (definitiveRejection) outcome = "failed";
  else if (submissionStarted) outcome = "unknown";
  else if (definitiveNotStarted) outcome = "not-submitted";

  const build = (code: ErrorCode, extra: FailureContext = {}) => {
    const requestedOutcome = definitiveRejection
      ? "failed"
      : submissionStarted
      ? "unknown"
      : definitiveNotStarted
      ? "not-submitted"
      : extra.outcome ?? outcome;
    return failureFromCode(code, {
      ...context,
      ...extra,
      outcome: requestedOutcome,
    });
  };

  if (definitiveRejection && context.operation) {
    return build(transactionCode(context, "failed"), { outcome: "failed" });
  }
  if (submissionStarted) {
    return build(transactionCode(context, "unknown"), { outcome: "unknown" });
  }
  if (definitiveNotStarted && context.operation) {
    return build(transactionCode(context, "not-submitted"), { outcome: "not-submitted" });
  }

  if (manualNetworkSwitch !== null) {
    return build("NETWORK_MISMATCH", {
      outcome: "not-submitted",
      manualNetworkSwitch: true,
      ...(manualNetworkSwitch ? { networkName: manualNetworkSwitch } : {}),
    });
  }

  if (/user rejected|user denied|user abort|rejected by user|cancelled by user|canceled by user/.test(lower)) {
    return build("WALLET_REQUEST_CANCELLED", { outcome: "not-submitted", presentation: "toast" });
  }
  if (/connected starknet wallet changed|account changed during|wallet changed during/.test(lower)) {
    return build("WALLET_IDENTITY_CHANGED");
  }
  if (/wallet session changed/.test(lower)) {
    return build("WALLET_IDENTITY_CHANGED");
  }
  if (/invalid_sig|invalid_signature|wallet session already exists|does not match this wallet session|invalid wallet session context|wallet session is already open|connected starknet wallet returned an invalid signature/.test(lower)) {
    return build("WALLET_SESSION_INVALID", { outcome: "not-submitted" });
  }
  if (context.operation === "cancel" && /reconnect and authorize|authorization.*cancel/.test(lower)) {
    return build("CANCELLATION_AUTHORIZATION_REQUIRED", { outcome: "not-submitted" });
  }
  if (/trading authorization failed|private trading authorization failed|private withdrawal authorization failed|reconnect and authorize/.test(lower)) {
    return build("WALLET_AUTHORIZATION_REQUIRED", { outcome: "not-submitted" });
  }
  if (/wallet session (?:expired|is locked|context changed)|remembered wallet session (?:is unavailable|expired|is invalid|failed)|session_(?:expired|locked|mismatch)/.test(lower)) {
    return build("WALLET_AUTHORIZATION_REQUIRED", { outcome: "not-submitted" });
  }
  if (/wallet (?:data )?migration (?:is )?required|wallet signature vault is invalid|invalid wallet seed transfer|(?:private|local wallet|stored wallet) state.*(?:corrupt|damaged|malformed)|damaged local wallet state|authentication failed.*state/.test(lower)) {
    return build("PRIVATE_STATE_DAMAGED", { outcome: "unknown" });
  }
  if (/wallet security worker (?:failed|timed out|is unavailable)|wallet signature vault (?:operation |cryptography )?failed/.test(lower)) {
    return build("PRIVATE_STATE_UNAVAILABLE", { outcome: "unknown" });
  }
  if (/(?:recovery snapshot|backed-up|private state).*conflict|conflicting private state|event histories diverge/.test(lower)) {
    return build("PRIVATE_STATE_CONFLICT", { outcome: "unknown" });
  }
  if (/does not support.*strk20|unsupported.*private (?:action|transaction)|private action.*unsupported|malformed capability information/.test(lower)) {
    return build("WALLET_PRIVATE_ACTION_UNSUPPORTED", { outcome: "not-submitted" });
  }
  if (/connect a starknet wallet|wallet did not return an account|no connected wallet|unlock your starknet wallet/.test(lower)) {
    return build("WALLET_CONNECT_REQUIRED", { outcome: "not-submitted" });
  }
  if (/wallet did not report its network|could not read.*wallet network/.test(lower)) {
    return build("WALLET_NETWORK_UNAVAILABLE", { outcome: "not-submitted" });
  }
  if (/wrong starknet network|network mismatch|chain id mismatch|wallet chain (?:changed|does not match)/.test(lower)) {
    return build("NETWORK_MISMATCH", { outcome: "not-submitted" });
  }
  if (/execution keys do not match|pins no execution keys|private requests are disabled/.test(lower)) {
    return build("PRIVATE_REQUEST_CONFIGURATION_INCOMPATIBLE", { outcome: "not-submitted" });
  }
  if (/private trading failed to load|private trading runtime.*(?:failed|unavailable)|zylith could not load/.test(lower)) {
    if (context.operation === "deposit") return build("DEPOSIT_UNAVAILABLE", { outcome: "not-submitted" });
    if (context.operation === "withdrawal" || context.operation === "claim") {
      return build("WITHDRAWAL_UNAVAILABLE", { outcome: "not-submitted" });
    }
    if (context.operation === "load") {
      return build("APPLICATION_LOAD_FAILED", { outcome: "not-submitted", presentation: "fatal-screen" });
    }
    return build("TRADING_UNAVAILABLE", { outcome: "not-submitted" });
  }
  if (/requested contract address .*not deployed|contract_not_found|contract address .*is not deployed/.test(lower)) {
    return build("CONTRACTS_UNAVAILABLE", { outcome: "not-submitted" });
  }
  if (/wallet signature request timed out/.test(lower)) {
    return build("WALLET_SIGNATURE_TIMEOUT", { outcome: "not-submitted" });
  }
  if (/starknet wallet request timed out/.test(lower)) {
    return build("WALLET_CONNECTION_TIMEOUT", { outcome: "not-submitted" });
  }
  if (/starknet wallet transaction timed out/.test(lower)) {
    return build(context.operation ? transactionCode(context, "unknown") : "WALLET_TRANSACTION_UNKNOWN", { outcome: "unknown" });
  }
  if (/not activated yet|counterfactual.*account/.test(lower)) {
    return build("WALLET_NOT_ACTIVATED", { outcome: "not-submitted" });
  }
  if (/wallet_addinvoketransaction|invalid_union|invalid input|calldata/.test(lower)) {
    return build("WALLET_REQUEST_INVALID", { outcome: "not-submitted" });
  }
  if (/proof_version_not_allowed|proof version .*not allowed|proof version .*not accepted|incompatible with the current starknet protocol/.test(lower)) {
    return build("PROOF_VERSION_INCOMPATIBLE", { outcome: "not-submitted" });
  }
  if (/screening_required|screening attestation|required screening/.test(lower)) {
    return build("SCREENING_UNAVAILABLE", { outcome: "not-submitted" });
  }
  if (/privacy warning|user_linkage|would weaken privacy/.test(lower)) {
    return build("PRIVACY_SAFETY_BLOCK", { outcome: "not-submitted" });
  }
  if (/insufficient_private_balance|shielded balance.*fee|private (?:fee|strk) balance.*(?:fee|cover)|private.*fee-token balance/.test(lower)) {
    return build("INSUFFICIENT_PRIVATE_FEE_BALANCE", { outcome: "not-submitted" });
  }
  if (/proof-bearing invoke/.test(lower) && /resource.?bounds.*exceed.*balance/.test(lower)) {
    return build("DEPOSIT_UNAVAILABLE", { outcome: "not-submitted", domain: "deposit" });
  }
  if (/deposit relay.*(?:not enough|underfunded|configuration|rejected)|deployment configuration.*deposit relay|private deposit service is unavailable/.test(lower)) {
    return build("DEPOSIT_UNAVAILABLE", { outcome: "not-submitted", domain: "deposit" });
  }
  if (/no replay protection|one-unit surplus|leave no room.*(?:fee|gas)|leave no fee-token balance|fee-token balance for the wallet fee|too close to the wallet balance/.test(lower)) {
    return build("INSUFFICIENT_NETWORK_FEE_BALANCE", { outcome: "not-submitted" });
  }
  if (/max fee|fee.*exceed|insufficient.*fee|not enough.*fee|not have enough.*fee|actual fee/.test(lower)) {
    return build("INSUFFICIENT_NETWORK_FEE_BALANCE", { outcome: "not-submitted" });
  }
  if (/insufficient.*balance|balance.*insufficient|exceeds? balance|amount exceeds balance|not enough.*balance|u256_sub overflow|wallet balance is below/.test(lower)) {
    const code = context.domain === "order" ? "INSUFFICIENT_AVAILABLE_BALANCE" : "INSUFFICIENT_WALLET_BALANCE";
    return build(code, { outcome: "not-submitted" });
  }
  if (/no (?:unlocked|available) [a-z0-9]+ (?:balance|(?:shielded )?note) can fund this order/.test(lower)) {
    return build("INSUFFICIENT_AVAILABLE_BALANCE", { outcome: "not-submitted", domain: "order" });
  }
  if (/selected (?:shielded )?note is not withdrawable|selected note no longer available|note.*already.*(?:spent|consumed)/.test(lower)) {
    return build("WITHDRAWAL_BALANCE_CHANGED", { outcome: "not-submitted", domain: "withdrawal" });
  }
  if (/note cannot be withdrawn|withdrawal is no longer available/.test(lower)) {
    return build("WITHDRAWAL_BALANCE_CHANGED", { outcome: "not-submitted", domain: "withdrawal" });
  }
  if (/withdrawal is already (?:in progress|being received)|withdrawal is not ready to receive/.test(lower)) {
    return build("WITHDRAWAL_PENDING", { outcome: "submitted", domain: "withdrawal" });
  }
  if (/no (?:unlocked (?:shielded )?note is available to withdraw|available note can be withdrawn|withdrawable.*note)/.test(lower)) {
    return build("NO_WITHDRAWABLE_FUNDS", { outcome: "not-submitted", domain: "withdrawal" });
  }
  if (/payload too large|request entity too large|content too large|http 413/.test(lower)) {
    return build("REQUEST_TOO_LARGE", { outcome: "not-submitted" });
  }
  if (/enter a valid amount|amount (?:is invalid|must be greater than zero)|amount.*outside the supported range|atomic amount is invalid|amount is too large/.test(lower)) {
    return build("INVALID_AMOUNT", { outcome: "not-submitted", presentation: "field" });
  }
  if (/supports at most .* decimal places|precision.*not supported/.test(lower)) {
    return build("PRECISION_UNSUPPORTED", { outcome: "not-submitted", presentation: "field" });
  }
  if (/below .* minimum|minimum order/.test(lower)) {
    return build("BELOW_MINIMUM", { outcome: "not-submitted", presentation: "field" });
  }
  if (/too many requests|rate limit|request limit reached|service is busy|proving service is (?:busy|at capacity)|-32029|-32005|tip statistics|starting block number/.test(lower)) {
    if (context.operation && !["connect", "authorize", "read", "load"].includes(context.operation)) {
      return build(transactionCode(context, outcome), { outcome });
    }
    return build("SERVICE_RATE_LIMITED", { outcome: "not-submitted" });
  }
  if (/deployment\.json missing|deployment configuration|deployment manifest|manifest.*missing|configured service url/.test(lower)) {
    return build("DEPLOYMENT_UNAVAILABLE", { outcome: "not-submitted" });
  }
  if (/not fully configured|urls are required|not configured|does not match .*configuration|not allowlisted|not supported by paymaster/.test(lower)) {
    if (context.operation === "withdrawal" || context.operation === "claim") return build("WITHDRAWAL_UNAVAILABLE", { outcome: "not-submitted" });
    if (context.operation === "deposit" || /deposit|funding|paymaster|proof signer|screening/.test(lower)) return build("DEPOSIT_UNAVAILABLE", { outcome: "not-submitted" });
    if (context.operation === "order" || context.operation === "cancel") return build("TRADING_UNAVAILABLE", { outcome: "not-submitted" });
    return build("OPERATOR_UNAVAILABLE", { outcome: "not-submitted" });
  }
  if (/reference[ -]price|price feed|stale price/.test(lower)) {
    return build("REFERENCE_PRICE_UNAVAILABLE", { outcome: "not-submitted", domain: "market" });
  }
  if (/deposit is already in progress/.test(lower)) {
    return build("DEPOSIT_STATUS_UNKNOWN", { outcome: "submitted", domain: "deposit" });
  }
  if (/wallet (?:produced|returned) (?:a |an )?(?:malformed|inconsistent|duplicate) (?:private request|private note|private-note nullifier|private balance(?: response)?|private balances|deposit plan|deposit note|private order|withdrawal request|recovery snapshot)|operator returned (?:a )?malformed (?:exchange status|private status|order status|order event|withdrawal status)|chain indexer returned malformed deposit status/.test(lower)) {
    return build("PRIVATE_OPERATION_INVARIANT_FAILED", { outcome: "unknown" });
  }
  if (/wallet returned (?:a )?(?:claim for another privacy pool|malformed recovered outputs|malformed residual authorities)|funding note is assigned to conflicting orders|note is locked by conflicting orders|residual leg is missing its exit authority/.test(lower)) {
    return build("PRIVATE_OPERATION_INVARIANT_FAILED", { outcome: "unknown" });
  }
  if (/stored wallet state contains|stored residual authority is malformed|backed-up order accounting regressed/.test(lower)) {
    return build("PRIVATE_STATE_DAMAGED", { outcome: "unknown" });
  }
  if (/signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted|request aborted/.test(lower)) {
    if (context.operation === "connect") return build("WALLET_CONNECTION_TIMEOUT", { outcome: "not-submitted" });
    if (context.operation === "authorize") return build("WALLET_SIGNATURE_TIMEOUT", { outcome: "not-submitted" });
    if (context.operation === "read" || context.operation === "load") return build("NETWORK_REQUEST_FAILED", { outcome: "not-submitted" });
    return context.operation
      ? build(transactionCode(context, outcome), { outcome })
      : build("NETWORK_REQUEST_FAILED", { outcome: "not-submitted" });
  }
  if (/transaction relay did not return|relay request failed|submission failed|proof submission failed|paymaster submission failed/.test(lower)) {
    return build(transactionCode(context, outcome), { outcome });
  }
  if (/connected wallet could not execute the funding transfer/.test(lower)) {
    return build("DEPOSIT_FAILED", { outcome: "failed", domain: "deposit" });
  }
  if (/transaction execution error|execution reverted|transaction failed|receipt.*reverted|definitively rejected/.test(lower)) {
    return build(transactionCode(context, "failed"), { outcome: "failed" });
  }
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed|rpc:|starknet rpc|http 5\d\d/.test(lower)) {
    if (context.operation && !["connect", "authorize", "read", "load"].includes(context.operation)) {
      return build(transactionCode(context, outcome), { outcome });
    }
    return build("NETWORK_REQUEST_FAILED", { outcome: "not-submitted" });
  }
  if (/order cancellation.*already.*in progress/.test(lower)) return build("CANCELLATION_PENDING", { outcome: "submitted" });
  if (/order submission.*already.*in progress/.test(lower)) return build("ORDER_ALREADY_IN_PROGRESS", { outcome: "submitted" });
  if (/order.*already.*(?:submitting|in progress)/.test(lower)) return build("ORDER_ALREADY_IN_PROGRESS");
  if (/order.*(?:not open|already filled|already settled|already cancelled)/.test(lower)) return build("ORDER_NOT_OPEN", { outcome: "failed" });
  if (context.operation === "load") return build("APPLICATION_LOAD_FAILED", { outcome: "not-submitted", presentation: "fatal-screen" });
  if (context.operation === "connect") return build("WALLET_CONNECTION_FAILED", { outcome: "not-submitted" });
  if (context.operation === "authorize") return build("WALLET_AUTHORIZATION_REQUIRED", { outcome: "not-submitted" });
  if (context.operation === "read") return build("NETWORK_REQUEST_FAILED", { outcome: "not-submitted" });
  if (context.operation) return build(transactionCode(context, outcome), { outcome });
  return build("UNEXPECTED_FAILURE", { outcome });
}

export function failureText(failure: NormalizedFailure): string {
  return failure.message ? `${failure.title}. ${failure.message}` : failure.title;
}

/** Compatibility adapter for persisted string fields. New UI should retain NormalizedFailure. */
export function userFacingErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Check the operation status before trying again.",
  context: FailureContext = {}
): string {
  const failure = normalizeFailure(error, context);
  if (failure.code === "UNEXPECTED_FAILURE" && fallback.trim()) return fallback;
  return failureText(failure);
}

export type DiagnosticContext = {
  appVersion?: string;
  network?: string;
  operation?: string;
};

function safeDiagnosticValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9._:/-]{1,128}$/.test(normalized)
    ? normalized
    : undefined;
}

export function sanitizedDiagnosticReport(
  failure: NormalizedFailure,
  context: DiagnosticContext = {}
): string {
  const report: Record<string, string | boolean> = {
    code: failure.code,
    domain: failure.domain,
    stage: safeDiagnosticValue(failure.stage) ?? "unspecified",
    outcome: failure.outcome,
    recovery: failure.recovery,
    retrySafe: failure.retrySafe,
  };
  const correlationId = safeDiagnosticValue(failure.correlationId);
  const appVersion = safeDiagnosticValue(context.appVersion);
  const network = safeDiagnosticValue(context.network);
  const operation = safeDiagnosticValue(context.operation);
  if (correlationId) report.correlationId = correlationId;
  if (appVersion) report.appVersion = appVersion;
  if (network) report.network = network;
  if (operation) report.operation = operation;
  return JSON.stringify(report, null, 2);
}
