function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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
    /invalid_union|invalid_type|zod|calldata|resource_bounds|execution_error/i.test(message)
  );
}

function privateDepositErrorMessage(message: string): string | null {
  if (/Connect a Starknet wallet before (using Starknet Privacy funding|funding the privacy signer|depositing)/i.test(message)) {
    return "Connect a Starknet wallet before depositing.";
  }
  if (/(Private deposit|Starknet Privacy) funding is not fully configured|(Private deposit|Starknet Privacy) .*URLs are required|signer warmup is not configured|proof signer deployment is not configured|paymaster is required|paymaster is not configured|deposit relay is not configured/i.test(message)) {
    return "Private deposits are not available in this deployment. Refresh the app and retry.";
  }
  if (/discovery service is unavailable|Discovery service is not healthy|discovery health check failed/i.test(message)) {
    return "Private deposit service is unavailable. Please retry later.";
  }
  if (/Connected Starknet wallet changed/i.test(message)) {
    return "Connected wallet changed during deposit. Reconnect the wallet you started with and retry.";
  }
  if (/insufficient.*balance|balance.*insufficient|exceeds.*balance|amount exceeds balance|not enough.*balance|u256_sub overflow|Connected wallet balance is below/i.test(message)) {
    return "Connected wallet does not have enough balance for this deposit.";
  }
  if (/max fee|fee.*exceed|insufficient.*fee|not enough.*fee|actual fee/i.test(message)) {
    return "Connected wallet does not have enough STRK for network fees.";
  }
  if (/Transfer allowance exceeded|approval|allowance/i.test(message)) {
    return "Deposit approval failed. Please retry later.";
  }
  if (/NO_REPLAY_PROTECTION|replay protection|one-unit surplus/i.test(message)) {
    return "Deposit amount is too close to the wallet balance. Try a slightly smaller amount.";
  }
  if (/privacy warning|SDK privacy warning|USER_LINKAGE/i.test(message)) {
    return "This deposit would weaken privacy. Use a different amount or retry later.";
  }
  if (/proof generation failed|proof submission failed|private deposit proof failed|prover did not return proof facts|Proving service error|proof facts/i.test(message)) {
    return "Private deposit proof failed. Please retry later.";
  }
  if (/paymaster submission failed|paymaster rejected|paymaster did not return|funding embedded signer|signer setup failed|funding setup failed/i.test(message)) {
    return "Private deposit transaction failed. Please retry later.";
  }
  if (/(Private deposit|Starknet Privacy) .+ failed|privacy signer|proof signer|privacy-pool|bridge withdrawal/i.test(message)) {
    return "Private deposit failed. Please retry later.";
  }
  return null;
}

export function userFacingErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Please retry later.",
): string {
  const raw = rawErrorMessage(error);
  const message = raw.trim();
  if (!message) return fallback;

  if (/user rejected|user denied|user abort|rejected by user|cancelled by user|canceled by user/i.test(message)) {
    return "Request cancelled in wallet.";
  }
  if (/too many requests|onfinality|rate limit|-32029|tip statistics|starting block number/i.test(message)) {
    return "Wallet could not prepare the transaction. Please retry later.";
  }
  if (/requested contract address .*not deployed|contract_not_found|contract address .*is not deployed/i.test(message)) {
    return "Zylith contracts are unavailable on the selected wallet network. Select Starknet Sepolia and retry.";
  }
  if (/wrong starknet network/i.test(message)) {
    return capitalizeFirst(message);
  }
  const privateDepositMessage = privateDepositErrorMessage(message);
  if (privateDepositMessage) return privateDepositMessage;
  if (/wallet_addInvokeTransaction|contractAddress|contract_address|entrypoint|entry_point|invalid_union|invalid input/i.test(message)) {
    return "Wallet could not prepare the transaction. Please retry later.";
  }
  if (/INVALID_SIG|INVALID_SIGNATURE/i.test(message)) {
    return "Embedded Zylith wallet authorization failed. Lock and unlock your Zylith wallet, then retry.";
  }
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
    return "Network request failed. Check your connection and retry.";
  }
  if (/^coordinator\s+\d{3}$/i.test(message) || /coordinator .*urls are required/i.test(message)) {
    return "Coordinator is unavailable. Please retry later.";
  }
  if (/private ingress key registry pin mismatch/i.test(message)) {
    return "Private execution key verification failed. Please retry later.";
  }
  if (/private ingress key registry is unavailable/i.test(message)) {
    return "Private execution keys are unavailable. Please retry later.";
  }
  if (/\/api\/private\/orders failed with HTTP 400/i.test(message)) {
    return "Private order was rejected. Refresh the app, unlock Zylith wallet, and submit again.";
  }
  if (/request to .* failed with HTTP 5\d\d|private ingress|prover|target service is not configured/i.test(message)) {
    return "Private execution service is unavailable. Please retry later.";
  }
  if (/deployment\.json missing|deployment configuration/i.test(message)) {
    return "Deployment configuration is unavailable.";
  }
  if (/paymaster URL is not configured/i.test(message)) {
    return "Withdrawal relay is not configured.";
  }
  if (/RPC:|Starknet RPC/i.test(message)) {
    return "Starknet network returned an error. Please retry later.";
  }
  if (/no unlocked ([A-Za-z0-9]+) (shielded )?note can fund this order/i.test(message)) {
    return capitalizeFirst(message) + (/[.!?]$/.test(message) ? "" : ".");
  }
  if (/selected (shielded )?note is not withdrawable/i.test(message)) {
    return "Selected note is not withdrawable.";
  }
  if (/no unlocked (shielded )?note is available to withdraw/i.test(message)) {
    return "No unlocked note is available to withdraw.";
  }
  if (/safety buffer/i.test(message)) {
    return "Batch is inside the submission safety buffer. Wait for the next epoch.";
  }
  if (isLowLevelPayload(message)) {
    return fallback;
  }
  return capitalizeFirst(message);
}
