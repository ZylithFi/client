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
  if (/wallet_addInvokeTransaction|contractAddress|contract_address|entrypoint|entry_point|invalid_union|invalid input/i.test(message)) {
    return "Wallet could not prepare the transaction. Please retry later.";
  }
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
    return "Network request failed. Check your connection and retry.";
  }
  if (/^coordinator\s+\d{3}$/i.test(message) || /coordinator .*urls are required/i.test(message)) {
    return "Coordinator is unavailable. Please retry later.";
  }
  if (/private ingress key registry pin mismatch/i.test(message)) {
    return "Private ingress key verification failed. Please retry later.";
  }
  if (/private ingress key registry is unavailable/i.test(message)) {
    return "Private ingress key registry is unavailable. Please retry later.";
  }
  if (/private ingress|prover|request failed with HTTP|target service is not configured/i.test(message)) {
    return "Private execution service is unavailable. Please retry later.";
  }
  if (/deployment\.json missing|deployment configuration/i.test(message)) {
    return "Deployment configuration is unavailable.";
  }
  if (/paymaster URL is not configured/i.test(message)) {
    return "Withdrawal relay is not configured.";
  }
  if (/RPC:/i.test(message)) {
    return "Starknet RPC returned an error. Please retry later.";
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
