import { privateDepositFundingFailureMessage } from "./privateDepositErrors";

function rawErrorMessage(error: unknown): string {
  const structured = structuredErrorMessage(error);
  if (structured) return structured;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function structuredErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return structuredErrorMessage(error.message);
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
    try {
      return structuredErrorMessage(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  for (const key of ["error", "detail", "message", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    const nested = structuredErrorMessage(value);
    if (nested) return nested;
  }
  return null;
}

function capitalizeFirst(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "";
  return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function isLowLevelPayload(message: string): boolean {
  return (
    message.length > 240 ||
    /^[\[{]/.test(message.trim()) ||
    /invalid_union|invalid_type|zod|calldata|resource_bounds|execution_error/i.test(
      message
    )
  );
}

function redactPublicErrorDetails(message: string): string {
  return message
    .replace(/0x[0-9a-fA-F]{33,}/g, "<felt>")
    .replace(/\b[0-9]{32,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

function privateDepositErrorMessage(message: string): string | null {
  if (
    /Connect a Starknet wallet before (using Starknet Privacy funding|funding the privacy signer|depositing)/i.test(
      message
    )
  ) {
    return "Connect a Starknet wallet before depositing.";
  }
  if (
    /(Private deposit|Starknet Privacy) funding is not fully configured|(Private deposit|Starknet Privacy) .*URLs are required|signer warmup is not configured|proof signer deployment is not configured|paymaster is required|paymaster is not configured|deposit relay is not configured/i.test(
      message
    )
  ) {
    return "Private deposits are not available in this deployment. Refresh the app and retry.";
  }
  if (
    /discovery service is unavailable|Discovery service is not healthy|discovery health check failed/i.test(
      message
    )
  ) {
    return "Private deposit service is unavailable. Please retry later.";
  }
  if (/Connected Starknet wallet changed/i.test(message)) {
    return "Connected wallet changed during deposit. Reconnect the wallet you started with and retry.";
  }
  if (
    /signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted|request aborted/i.test(
      message
    ) &&
    /private deposit|starknet privacy|deposit proof|deposit service|funding deposit/i.test(
      message
    )
  ) {
    return "Private deposit service timed out. Please retry later.";
  }
  const fundingFailure = privateDepositFundingFailureMessage(message);
  if (fundingFailure) return fundingFailure;
  if (
    /does not match paymaster configuration|not allowlisted|not supported by paymaster/i.test(
      message
    )
  ) {
    return "The app deployment configuration does not match the deposit relay. This deployment needs a configuration fix before deposits can work.";
  }
  if (
    /Starknet RPC rejected proof-bearing invoke|Resources bounds/i.test(
      message
    ) &&
    /exceed(?:s|ed)? balance|insufficient.*balance|balance.*insufficient/i.test(
      message
    )
  ) {
    return "Deposit relay is temporarily underfunded. Please retry later.";
  }
  if (
    /insufficient.*balance|balance.*insufficient|exceed(?:s|ed)?.*balance|amount exceeds balance|not enough.*balance|u256_sub overflow|Connected wallet balance is below/i.test(
      message
    )
  ) {
    return "Connected wallet does not have enough balance for this deposit.";
  }
  if (/Transfer allowance exceeded|approval|allowance/i.test(message)) {
    return "Deposit approval failed. Please retry later.";
  }
  if (
    /NO_REPLAY_PROTECTION|replay protection|one-unit surplus/i.test(message)
  ) {
    return "Deposit amount is too close to the wallet balance. Try a slightly smaller amount.";
  }
  if (/privacy warning|SDK privacy warning|USER_LINKAGE/i.test(message)) {
    return "This action would weaken privacy. Use a different amount or retry later.";
  }
  if (
    /SCREENING_REQUIRED|screening attestation|required screening/i.test(message)
  ) {
    return "Private deposits are temporarily unavailable while screening is configured.";
  }
  if (
    /PROOF_VERSION_NOT_ALLOWED|proof version .* (?:is not allowed under this protocol version|is not accepted by this gateway)|privacy prover is incompatible with the current Starknet protocol/i.test(
      message
    )
  ) {
    return "Private deposits are temporarily unavailable because the privacy prover and Starknet submission gateway use different proof versions.";
  }
  if (
    /proof generation failed|proof submission failed|private deposit proof failed|prover did not return proof facts|Proving service error|proof facts/i.test(
      message
    )
  ) {
    return "Private deposit proof failed. Please retry later.";
  }
  if (
    /paymaster submission failed|paymaster rejected|paymaster did not return|funding deposit session|signer setup failed|funding setup failed/i.test(
      message
    )
  ) {
    return "Private deposit transaction failed. Please retry later.";
  }
  if (
    /(Private deposit|Starknet Privacy) .+ failed|privacy signer|proof signer|privacy-pool|bridge withdrawal/i.test(
      message
    )
  ) {
    return "Private deposit failed. Please retry later.";
  }
  return null;
}

export function userFacingErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Please retry later."
): string {
  const raw = rawErrorMessage(error);
  const message = raw.trim();
  if (!message) return fallback;

  if (
    /user rejected|user denied|user abort|rejected by user|cancelled by user|canceled by user/i.test(
      message
    )
  ) {
    return "Request cancelled in wallet.";
  }
  if (
    /too many requests|onfinality|rate limit|-32029|tip statistics|starting block number/i.test(
      message
    )
  ) {
    return "Wallet could not prepare the transaction. Please retry later.";
  }
  if (
    /requested contract address .*not deployed|contract_not_found|contract address .*is not deployed/i.test(
      message
    )
  ) {
    return "Zylith contracts are unavailable on the selected wallet network. Switch to Starknet Sepolia and retry.";
  }
  if (/wrong starknet network/i.test(message)) {
    return capitalizeFirst(message);
  }
  const privateDepositMessage = privateDepositErrorMessage(message);
  if (privateDepositMessage) return privateDepositMessage;
  if (
    /transaction relay .*timed out|transaction relay did not return|private relay request failed|transaction relay request failed/i.test(
      message
    )
  ) {
    return "Transaction relay is unavailable. Please retry later.";
  }
  if (
    /wallet_addInvokeTransaction|contractAddress|contract_address|entrypoint|entry_point|invalid_union|invalid input/i.test(
      message
    )
  ) {
    return "Wallet could not prepare the transaction. Please retry later.";
  }
  if (/INVALID_SIG|INVALID_SIGNATURE/i.test(message)) {
    return "Private trading authorization failed. Lock and reconnect your wallet, then retry.";
  }
  if (
    /wallet session already exists|does not match this wallet session/i.test(
      message
    )
  ) {
    return "Private trading authorization failed. Lock and reconnect your wallet, then retry.";
  }
  if (/starknet wallet request timed out/i.test(message)) {
    return "Wallet connection timed out. Open or unlock your Starknet wallet and retry.";
  }
  if (/wallet signature request timed out/i.test(message)) {
    return "Wallet signature timed out. Open your Starknet wallet and retry.";
  }
  if (/starknet wallet transaction timed out/i.test(message)) {
    return "Wallet transaction timed out. Open your Starknet wallet and retry.";
  }
  if (
    /signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted|request aborted/i.test(
      message
    )
  ) {
    return "Request timed out. Please retry later.";
  }
  if (
    /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
      message
    )
  ) {
    return "Network request failed. Check your connection and retry.";
  }
  if (
    /HTTP 413|payload too large|request entity too large|content too large/i.test(
      message
    )
  ) {
    return "Request is too large for the service.";
  }
  if (
    /request to .* failed with HTTP 5\d\d|failed with HTTP 5\d\d|target service is not configured/i.test(
      message
    )
  ) {
    return "The Zylith operator is unavailable. Please retry later.";
  }
  if (/deployment\.json missing|deployment configuration/i.test(message)) {
    return "Deployment configuration is unavailable.";
  }
  if (
    /paymaster URL is not configured|Transaction relay is not configured/i.test(
      message
    )
  ) {
    return "Transaction relay is not configured.";
  }
  if (/RPC:|Starknet RPC/i.test(message)) {
    return "Starknet network returned an error. Please retry later.";
  }
  const noUnlockedFunding = message.match(
    /no (?:unlocked|available) ([A-Za-z0-9]+) (?:balance|(?:shielded )?note) can fund this order/i
  );
  if (noUnlockedFunding) {
    const asset = noUnlockedFunding[1];
    return `No available ${asset} balance can fund this order. Cancel or edit existing orders if ${asset} is reserved, or deposit more ${asset}.`;
  }
  if (/selected (shielded )?note is not withdrawable/i.test(message)) {
    return "Selected note is not withdrawable.";
  }
  if (
    /no (?:unlocked (shielded )?note is available to withdraw|available note can be withdrawn)/i.test(
      message
    )
  ) {
    return "No available note can be withdrawn.";
  }
  if (isLowLevelPayload(message)) {
    return fallback;
  }
  return capitalizeFirst(redactPublicErrorDetails(message));
}
