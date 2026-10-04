import { privateDepositFundingFailureMessage } from "../domain/privateDepositErrors";

export function summarizeFundingError(error: unknown): string {
  const message = unwrapJsonErrorBody(sanitizeRpcMessage(errorMessage(error)));
  if (!message) return "No error detail was returned.";
  if (/^Failed while /i.test(message)) {
    return message.slice(0, 360);
  }
  if (
    /does not match paymaster configuration|not allowlisted|not supported by paymaster/i.test(
      message
    )
  ) {
    return `Deposit relay rejected the request: ${message.slice(
      0,
      200
    )}. The app deployment configuration does not match the relay.`;
  }
  const fundingFailure = privateDepositFundingFailureMessage(message);
  if (fundingFailure) return fundingFailure;
  if (
    /Starknet RPC rejected proof-bearing invoke|Resources bounds/i.test(message) &&
    /exceed(?:s|ed)? balance|insufficient.*balance|balance.*insufficient/i.test(
      message
    )
  ) {
    return "Deposit relay does not have enough STRK to submit the proof-bearing transaction.";
  }
  if (/Transfer allowance exceeded/i.test(message)) {
    return "Token approval was lower than the required privacy-pool deposit amount.";
  }
  if (
    /insufficient.*balance|balance.*insufficient|exceed(?:s|ed)?.*balance|amount exceeds balance|not enough.*balance|u256_sub overflow/i.test(
      message
    )
  ) {
    return "Connected wallet does not have enough token balance for this deposit.";
  }
  if (/privacy replay protection/i.test(message)) {
    return message.slice(0, 280);
  }
  if (
    /entry point.*not found|entrypoint.*not found|invalid.*entrypoint/i.test(
      message
    )
  ) {
    return "Configured token contract does not expose the expected ERC-20 entrypoint.";
  }
  if (
    /contract.*not.*found|not deployed|ContractAddress.*not found/i.test(
      message
    )
  ) {
    return "Configured Starknet contract was not found on the selected network.";
  }
  if (/INVALID_SIG|INVALID_SIGNATURE/i.test(message)) {
    return "Private trading did not produce a valid privacy authorization signature.";
  }
  if (/NO_REPLAY_PROTECTION/i.test(message)) {
    return "Private deposits require a one-unit surplus note for replay protection.";
  }
  if (/Discovery service is not healthy/i.test(message)) {
    return "Private deposit service is unavailable.";
  }
  if (
    /SCREENING_REQUIRED|screening attestation|required screening/i.test(message)
  ) {
    return "Private deposit screening attestation is not configured.";
  }
  if (
    /Private deposit privacy warning|Starknet Privacy SDK privacy warning/i.test(
      message
    )
  ) {
    return message.slice(0, 280);
  }
  if (/Proving service error/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/Indexer API/i.test(message)) {
    return message.slice(0, 280);
  }
  if (
    /proof block number .* too recent|maximum allowed block number/i.test(
      message
    )
  ) {
    return "The privacy proof block is not old enough for the Starknet verifier yet.";
  }
  if (/PROOF_EXPIRED|proof expired|proof.*expired/i.test(message)) {
    return "The privacy proof expired before Starknet accepted it. Retrying with a fresher proof.";
  }
  if (
    /PROOF_VERSION_NOT_ALLOWED|proof version .* (?:is not allowed under this protocol version|is not accepted by this gateway)/i.test(
      message
    )
  ) {
    return "The privacy prover does not match the Starknet submission gateway's admitted proof version.";
  }
  if (
    /service busy|service is busy|proving service is at capacity|prover.*capacity|-32005/i.test(
      message
    )
  ) {
    return "Private proving service is busy. Please retry shortly.";
  }
  if (/proof facts|proofFacts/i.test(message)) {
    return "The proving service did not return valid proof facts.";
  }
  if (
    /signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted|request aborted/i.test(
      message
    )
  ) {
    return "A required service timed out. Please retry later.";
  }
  if (
    /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
      message
    )
  ) {
    return "A required network request failed.";
  }
  if (/HTTP\s+4\d\d/i.test(message)) {
    return "A required service rejected the request.";
  }
  if (/HTTP\s+5\d\d/i.test(message)) {
    return "A required service is unavailable.";
  }
  if (/RpcError|RPC:/i.test(message)) {
    const reason = starknetRpcReason(message);
    return reason
      ? `Starknet network rejected the wallet transaction: ${reason}`
      : "Starknet network rejected the wallet transaction during fee estimation.";
  }
  if (
    /paymaster/i.test(message) &&
    /reject|invalid|mismatch|not allowed/i.test(message)
  ) {
    return "The deposit relay rejected the authorization.";
  }
  if (message.length <= 180 && !/^[\[{]/.test(message)) return message;
  return "A required service returned an unreadable error.";
}

export function unwrapJsonErrorBody(message: string): string {
  const trimmed = message.trim();
  if (!/^\{/.test(trimmed) || trimmed.length > 16_384) return message;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["error", "message", "detail", "reason"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {}
  return message;
}

export function isWalletCallShapeError(error: unknown): boolean {
  const message = errorMessage(error);
  return /invalid_union|invalid input|contractAddress|contract_address|entrypoint|entry_point|array|calls/i.test(
    message
  );
}

export function isUserRejected(error: unknown): boolean {
  const message = errorMessage(error);
  return /user rejected|user denied|user abort|rejected by user|cancelled by user|canceled by user/i.test(
    message
  );
}

export function isWalletRequestUnavailableError(error: unknown): boolean {
  const message = errorMessage(error);
  return /method not found|not supported|unsupported|not implemented|unknown method|wallet_addInvokeTransaction/i.test(
    message
  );
}

export function isProofBlockTooRecent(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /proof block number .* too recent|maximum allowed block number|proof block is not old enough/i.test(
      message
    )
  );
}

export function isProofExpired(error: unknown): boolean {
  const message = errorMessage(error);
  return /PROOF_EXPIRED|proof expired|proof.*expired/i.test(message);
}

export function isProofProviderContractVisibilityLag(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /requested contract address .* is not deployed|contract.*not.*found|not deployed|class hash: 0x0{8,}/i.test(
      message
    )
  );
}

export function isProofProviderServiceBusy(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /service busy|service is busy|proving service is at capacity|prover.*capacity|-32005/i.test(
      message
    )
  );
}

export function isProofProviderTransientNetworkError(error: unknown): boolean {
  if (proofSubmissionStarted(error)) return false;
  const message = errorMessage(error);
  return (
    /signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted|request aborted|failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
      message
    )
  );
}

export function markProofSubmissionStarted(error: unknown): Error {
  if (proofSubmissionRejected(error)) {
    return error instanceof Error ? error : new Error(errorMessage(error));
  }
  const marked = new Error(errorMessage(error) || "Proof submission failed", {
    cause: error,
  });
  Object.defineProperty(marked, "zylithProofSubmissionStarted", {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return marked;
}

export function markProofSubmissionRejected(error: unknown): Error {
  const marked = new Error(errorMessage(error) || "Proof submission was rejected", {
    cause: error,
  });
  Object.defineProperty(marked, "zylithProofSubmissionRejected", {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return marked;
}

function proofSubmissionRejected(
  error: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): boolean {
  if (!error || seen.has(error) || depth > 8 || seen.size >= 32) return false;
  if (typeof error !== "object") return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  let rejected: unknown;
  let cause: unknown;
  try {
    rejected = record.zylithProofSubmissionRejected;
    cause = record.cause;
  } catch {
    return false;
  }
  return rejected === true || proofSubmissionRejected(cause, seen, depth + 1);
}

export function proofSubmissionStarted(
  error: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): boolean {
  if (!error || seen.has(error) || depth > 8 || seen.size >= 32) return false;
  if (typeof error !== "object") return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  let started: unknown;
  let cause: unknown;
  try {
    started = record.zylithProofSubmissionStarted;
    cause = record.cause;
  } catch {
    return false;
  }
  return started === true
    || proofSubmissionStarted(cause, seen, depth + 1);
}

export function errorMessage(error: unknown): string {
  const nested = nestedErrorMessages(error);
  if (nested.length > 0) return nested.join(" ");
  try {
    if (error instanceof Error) return error.message;
  } catch {}
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "";
  }
}

function nestedErrorMessages(
  error: unknown,
  seen = new Set<unknown>(),
  depth = 0,
  budget: { remaining: number } = { remaining: 64 },
): string[] {
  if (
    error === null ||
    error === undefined ||
    seen.has(error) ||
    depth > 8 ||
    budget.remaining <= 0
  ) return [];
  if (typeof error === "string") {
    return [decodeMaybeHexString(error.slice(0, 4_096))];
  }
  if (
    typeof error === "number" ||
    typeof error === "bigint" ||
    typeof error === "boolean"
  ) {
    return [String(error)];
  }
  let isError = false;
  try {
    isError = error instanceof Error;
  } catch {
    return [];
  }
  if (isError) {
    seen.add(error);
    budget.remaining -= 1;
    let message = "";
    let cause: unknown;
    try {
      const typedError = error as Error & { cause?: unknown };
      message = typedError.message;
      cause = typedError.cause;
    } catch {
      return [];
    }
    return [
      message.slice(0, 4_096),
      ...nestedErrorMessages(cause, seen, depth + 1, budget),
    ].filter(Boolean);
  }
  let isArray = false;
  try {
    isArray = Array.isArray(error);
  } catch {
    return [];
  }
  if (isArray) {
    seen.add(error);
    budget.remaining -= 1;
    return (error as unknown[])
      .slice(0, 32)
      .flatMap((item) => nestedErrorMessages(item, seen, depth + 1, budget));
  }
  if (typeof error !== "object") return [];

  seen.add(error);
  budget.remaining -= 1;
  const record = error as Record<string, unknown>;
  const messages: string[] = [];
  for (const key of [
    "message",
    "error",
    "execution_error",
    "revert_error",
    "failure_reason",
    "data",
    "details",
    "cause",
  ]) {
    let value: unknown;
    try {
      value = record[key];
    } catch {
      continue;
    }
    if (value !== undefined) {
      messages.push(...nestedErrorMessages(value, seen, depth + 1, budget));
    }
  }
  if (messages.length > 0) return dedupeMessages(messages);
  try {
    return [String(error)];
  } catch {
    return [];
  }
}

function dedupeMessages(messages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean)) {
    if (seen.has(message)) continue;
    seen.add(message);
    out.push(message);
  }
  return out;
}

export function decodeMaybeHexString(value: string): string {
  const trimmed = value.trim();
  if (
    !/^0x[0-9a-fA-F]+$/.test(trimmed) ||
    trimmed.length < 8 ||
    trimmed.length % 2 !== 0
  ) {
    return trimmed;
  }
  try {
    const bytes =
      trimmed
        .slice(2)
        .match(/../g)
        ?.map((chunk) => parseInt(chunk, 16)) ?? [];
    if (bytes.length === 0 || bytes.some((byte) => byte < 32 || byte > 126))
      return trimmed;
    return `${trimmed} ('${String.fromCharCode(...bytes)}')`;
  } catch {
    return trimmed;
  }
}

function decodeHexStringsInText(value: string): string {
  return value.replace(/0x[0-9a-fA-F]{8,}/g, (match) =>
    decodeMaybeHexString(match)
  );
}

export function sanitizeRpcMessage(value: string): string {
  return decodeHexStringsInText(value)
    .replace(/"calldata"\s*:\s*\[[^\]]*\]/g, '"calldata":[...]')
    .replace(/"signature"\s*:\s*\[[^\]]*\]/g, '"signature":[...]')
    .replace(/0x[0-9a-fA-F]{33,}/g, "<felt>")
    .replace(/\b[0-9]{32,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

export function starknetRpcReason(message: string): string | null {
  const quoted = message.match(/\('([^']{3,180})'\)/);
  if (quoted?.[1]) return quoted[1];
  const known = [
    /transfer amount exceeds balance/i,
    /insufficient balance/i,
    /u256_sub overflow/i,
    /transfer allowance exceeded/i,
    /invalid signature/i,
    /account validation failed/i,
    /class hash .* not declared/i,
    /contract .* not found/i,
    /entry point .* not found/i,
  ];
  for (const pattern of known) {
    const match = message.match(pattern);
    if (match?.[0]) return match[0];
  }
  return null;
}
