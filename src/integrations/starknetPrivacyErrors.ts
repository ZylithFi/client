import { privateDepositFundingFailureMessage } from "../domain/privateDepositErrors";

export function summarizeFundingError(error: unknown): string {
  const message = unwrapJsonErrorBody(sanitizeRpcMessage(errorMessage(error)));
  if (!message) return "No error detail was returned.";
  if (/^Failed while /i.test(message)) {
    return message.slice(0, 360);
  }
  if (/does not match paymaster configuration|not allowlisted|not supported by paymaster/i.test(message)) {
    return `Deposit relay rejected the request: ${message.slice(0, 200)}. The app deployment configuration does not match the relay.`;
  }
  const fundingFailure = privateDepositFundingFailureMessage(message);
  if (fundingFailure) return fundingFailure;
  if (/Transfer allowance exceeded/i.test(message)) {
    return "Token approval was lower than the required privacy-pool deposit amount.";
  }
  if (/insufficient.*balance|balance.*insufficient|exceeds.*balance|amount exceeds balance|not enough.*balance|u256_sub overflow/i.test(message)) {
    return "Connected wallet does not have enough token balance for this deposit.";
  }
  if (/privacy replay protection/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/entry point.*not found|entrypoint.*not found|invalid.*entrypoint/i.test(message)) {
    return "Configured token contract does not expose the expected ERC-20 entrypoint.";
  }
  if (/contract.*not.*found|not deployed|ContractAddress.*not found/i.test(message)) {
    return "Configured Starknet contract was not found on the selected network.";
  }
  if (/INVALID_SIG|INVALID_SIGNATURE/i.test(message)) {
    return "The embedded Zylith wallet did not produce a valid privacy authorization signature.";
  }
  if (/NO_REPLAY_PROTECTION/i.test(message)) {
    return "Private deposits require a one-unit surplus note for replay protection.";
  }
  if (/Discovery service is not healthy/i.test(message)) {
    return "Private deposit service is unavailable.";
  }
  if (/Private deposit privacy warning|Starknet Privacy SDK privacy warning/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/Proving service error/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/Indexer API/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/proof block number .* too recent|maximum allowed block number/i.test(message)) {
    return "The privacy proof block is not old enough for the Starknet verifier yet.";
  }
  if (/proof facts|proofFacts/i.test(message)) {
    return "The proving service did not return valid proof facts.";
  }
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
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
  if (/paymaster/i.test(message) && /reject|invalid|mismatch|not allowed/i.test(message)) {
    return "The deposit relay rejected the authorization.";
  }
  if (message.length <= 180 && !/^[\[{]/.test(message)) return message;
  return "A required service returned an unreadable error.";
}

export function unwrapJsonErrorBody(message: string): string {
  const trimmed = message.trim();
  if (!/^\{/.test(trimmed)) return message;
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
  return /invalid_union|invalid input|contractAddress|contract_address|entrypoint|entry_point|array|calls/i
    .test(message);
}

export function isUserRejected(error: unknown): boolean {
  const message = errorMessage(error);
  return /user rejected|user denied|user abort|rejected by user|cancelled by user|canceled by user/i
    .test(message);
}

export function isWalletRequestUnavailableError(error: unknown): boolean {
  const message = errorMessage(error);
  return /method not found|not supported|unsupported|not implemented|unknown method|wallet_addInvokeTransaction/i
    .test(message);
}

export function isProofBlockTooRecent(error: unknown): boolean {
  const message = errorMessage(error);
  if (
    /proof block number .* too recent|maximum allowed block number|proof block is not old enough/i
      .test(message)
  ) {
    return true;
  }
  if (error instanceof Error && "cause" in error) {
    return isProofBlockTooRecent((error as Error & { cause?: unknown }).cause);
  }
  if (error && typeof error === "object" && "cause" in error) {
    return isProofBlockTooRecent((error as { cause?: unknown }).cause);
  }
  return false;
}

export function isProofProviderContractVisibilityLag(error: unknown): boolean {
  const message = errorMessage(error);
  if (
    /requested contract address .* is not deployed|contract.*not.*found|not deployed|class hash: 0x0{8,}/i
      .test(message)
  ) {
    return true;
  }
  if (error instanceof Error && "cause" in error) {
    return isProofProviderContractVisibilityLag((error as Error & { cause?: unknown }).cause);
  }
  if (error && typeof error === "object" && "cause" in error) {
    return isProofProviderContractVisibilityLag((error as { cause?: unknown }).cause);
  }
  return false;
}

export function errorMessage(error: unknown): string {
  const nested = nestedErrorMessages(error);
  if (nested.length > 0) return nested.join(" ");
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function nestedErrorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  if (typeof error === "string") return [decodeMaybeHexString(error)];
  if (typeof error === "number" || typeof error === "bigint" || typeof error === "boolean") {
    return [String(error)];
  }
  if (error instanceof Error) {
    seen.add(error);
    return [
      error.message,
      ...nestedErrorMessages((error as Error & { cause?: unknown }).cause, seen),
    ].filter(Boolean);
  }
  if (Array.isArray(error)) {
    seen.add(error);
    return error.flatMap((item) => nestedErrorMessages(item, seen));
  }
  if (typeof error !== "object") return [];

  seen.add(error);
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
    if (key in record) messages.push(...nestedErrorMessages(record[key], seen));
  }
  if (messages.length > 0) return dedupeMessages(messages);
  try {
    return [JSON.stringify(error)];
  } catch {
    return [String(error)];
  }
}

function dedupeMessages(messages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages.map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    if (seen.has(message)) continue;
    seen.add(message);
    out.push(message);
  }
  return out;
}

export function decodeMaybeHexString(value: string): string {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed) || trimmed.length < 8 || trimmed.length % 2 !== 0) {
    return trimmed;
  }
  try {
    const bytes = trimmed
      .slice(2)
      .match(/../g)
      ?.map((chunk) => parseInt(chunk, 16)) ?? [];
    if (bytes.length === 0 || bytes.some((byte) => byte < 32 || byte > 126)) return trimmed;
    return `${trimmed} ('${String.fromCharCode(...bytes)}')`;
  } catch {
    return trimmed;
  }
}

function decodeHexStringsInText(value: string): string {
  return value.replace(/0x[0-9a-fA-F]{8,}/g, (match) => decodeMaybeHexString(match));
}

export function sanitizeRpcMessage(value: string): string {
  return decodeHexStringsInText(value)
    .replace(/"calldata"\s*:\s*\[[^\]]*\]/g, '"calldata":[...]')
    .replace(/"signature"\s*:\s*\[[^\]]*\]/g, '"signature":[...]')
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
