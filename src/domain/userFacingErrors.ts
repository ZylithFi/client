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
  if (/wallet must be deployed before depositing/i.test(message)) {
    return "Connected wallet could not execute the funding transfer. Activate it in your Starknet wallet and retry.";
  }
  if (/PaymasterV2Error|Paymaster error\s*\d+|TRANSACTION_EXECUTION_ERROR/i.test(message)) {
    return "The connected wallet could not execute the funding transfer. Keep enough STRK in the wallet for network fees and retry.";
  }
  if (/does not match paymaster configuration|not allowlisted|not supported by paymaster/i.test(message)) {
    return "The app deployment configuration does not match the deposit relay. This deployment needs a configuration fix before deposits can work.";
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
  if (/HTTP 413|payload too large|request entity too large|content too large/i.test(message)) {
    return "Request is too large for the service. Choose a shorter window and retry.";
  }
  if (/private ingress key registry pin mismatch/i.test(message)) {
    return "Private execution key verification failed. Please retry later.";
  }
  if (/private ingress key registry is unavailable/i.test(message)) {
    return "Private execution keys are unavailable. Please retry later.";
  }
  if (/maker curve must contain at least|at least .*points|at least .*bands/i.test(message)) {
    return "Maker curves need at least three filled price bands.";
  }
  if (/maker curve .*spread|outer bands must span|price range/i.test(message)) {
    return "Curve bands are too tight for this pair. Widen the outer prices and retry.";
  }
  if (/maker curve band depth|band depth .*below|minimum band/i.test(message)) {
    return "Each curve band needs more depth for this pair.";
  }
  if (/Renewal relay request failed with HTTP 401|Unauthorized/i.test(message)) {
    return "Zylith relay could not verify this renewal package. Refresh, unlock, and retry.";
  }
  if (/Renewal relay request failed with HTTP 404/i.test(message)) {
    return "Zylith relay endpoint is unavailable. Refresh the app and retry.";
  }
  if (/Zylith relay endpoint is not configured|managed relay.*not configured/i.test(message)) {
    return "Zylith relay endpoint is unavailable. Refresh the app and retry.";
  }
  if (/Self-hosted relay endpoint is invalid or missing/i.test(message)) {
    return "Enter a valid self-hosted relay endpoint and retry.";
  }
  if (/Self-hosted relay request failed with HTTP 401|Self-hosted relay request failed.*Unauthorized/i.test(message)) {
    return "Self-hosted relay could not verify this renewal package. Check the relay configuration and retry.";
  }
  if (/Self-hosted relay request failed with HTTP 404/i.test(message)) {
    return "Self-hosted relay endpoint is unavailable. Check the endpoint and retry.";
  }
  if (/Self-hosted relay request failed.*accepts ZylithRelay|Self-hosted relay request failed.*got ZylithRelay|Self-hosted relay request failed.*got SelfRelay/i.test(message)) {
    return "Relay mode does not match the selected renewal operator. Check the relay configuration and retry.";
  }
  if (/Self-hosted relay request failed with HTTP 4\d\d|Self-hosted relay request failed/i.test(message)) {
    return "Self-hosted relay rejected this renewal package. Check the relay configuration and retry.";
  }
  if (/Renewal relay request failed.*exceeds slot limit/i.test(message)) {
    return "Renewal window is too large for the managed relay. Choose a shorter window and retry.";
  }
  if (/Renewal relay request failed.*Managed relay only accepts ZylithRelay packages|Renewal relay request failed.*got SelfRelay/i.test(message)) {
    return "Select Zylith relay as the renewal operator and retry.";
  }
  if (/Renewal relay request failed.*coordinator and prover URLs/i.test(message)) {
    return "Zylith relay is not configured correctly. Refresh the app and retry.";
  }
  if (/Renewal relay request failed.*slot_count|Renewal relay request failed.*epoch range|Renewal relay request failed.*Duplicate renewal slot/i.test(message)) {
    return "Renewal package could not be verified. Refresh, unlock, and retry.";
  }
  if (/Renewal relay request failed with HTTP 4\d\d|Renewal relay request failed/i.test(message)) {
    return "Zylith relay rejected this renewal package. Check the relay configuration and retry.";
  }
  if (/renewal-backed child|Zylith relay mode requires|renewal package|resting maker strategy/i.test(message)) {
    return "Maker curves need renewal enabled. Choose a renewal window and retry.";
  }
  if (/Cancellation witness/i.test(message)) {
    return "Curve cancellation is not ready yet. Wait for the latest settlement to sync, then retry.";
  }
  if (/maker curve order amount|curve envelope price|maker curve limit_price/i.test(message)) {
    return "Curve parameters are inconsistent. Check the band prices and depths, then retry.";
  }
  if (/\/api\/private\/orders failed with HTTP 400/i.test(message)) {
    return "Private order was rejected by validation. Check available notes and curve bands, then retry.";
  }
  if (/request to .* failed with HTTP 5\d\d|private ingress|prover|target service is not configured/i.test(message)) {
    return "Private execution service is unavailable. Please retry later.";
  }
  if (/deployment\.json missing|deployment configuration/i.test(message)) {
    return "Deployment configuration is unavailable.";
  }
  if (/paymaster URL is not configured|Transaction relay is not configured/i.test(message)) {
    return "Transaction relay is not configured.";
  }
  if (/RPC:|Starknet RPC/i.test(message)) {
    return "Starknet network returned an error. Please retry later.";
  }
  if (/auction window.*no longer open/i.test(message)) {
    return "Auction window rolled forward. Please retry if this persists.";
  }
  const noUnlockedFunding = message.match(/no unlocked ([A-Za-z0-9]+) (shielded )?note can fund this order/i);
  if (noUnlockedFunding) {
    const asset = noUnlockedFunding[1];
    return `No unlocked ${asset} note can fund this order. Cancel or edit existing curves if ${asset} is locked, or deposit more ${asset}.`;
  }
  if (/selected (shielded )?note is not withdrawable/i.test(message)) {
    return "Selected note is not withdrawable.";
  }
  if (/claim window is not open|claim window.*closed|CLAIM_WINDOW_CLOSED|claim delay/i.test(message)) {
    return "Withdrawal claim window is not open yet. Please retry after the claim delay.";
  }
  if (/no unlocked (shielded )?note is available to withdraw/i.test(message)) {
    return "No unlocked note is available to withdraw.";
  }
  if (/safety buffer/i.test(message)) {
    return "Auction window rolled forward. Please retry if this persists.";
  }
  if (isLowLevelPayload(message)) {
    return fallback;
  }
  return capitalizeFirst(message);
}
