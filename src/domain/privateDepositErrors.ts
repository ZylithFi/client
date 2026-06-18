export const ETH_DEPOSIT_FEE_HEADROOM_ERROR =
  "ETH deposit amount leaves no room for the wallet transaction fee. Try a slightly smaller amount.";

export const ETH_DEPOSIT_FEE_HEADROOM_USER_MESSAGE =
  "ETH deposit amount leaves no room for the wallet fee. Try a slightly smaller amount.";

export const CONNECTED_WALLET_FUNDING_TRANSFER_FAILED_MESSAGE =
  "The connected wallet could not execute the funding transfer. Leave a small fee balance in the wallet and retry with a lower amount.";

export const STARKNET_FEE_BALANCE_MESSAGE =
  "Connected wallet does not have enough balance for Starknet network fees.";

export function privateDepositFundingFailureMessage(message: string): string | null {
  if (/ETH deposit amount leaves no room for the wallet transaction fee/i.test(message)) {
    return ETH_DEPOSIT_FEE_HEADROOM_USER_MESSAGE;
  }
  if (/PaymasterV2Error|Paymaster error\s*\d+|TRANSACTION_EXECUTION_ERROR/i.test(message)) {
    return CONNECTED_WALLET_FUNDING_TRANSFER_FAILED_MESSAGE;
  }
  if (/max fee|fee.*exceed|insufficient.*fee|not enough.*fee|actual fee/i.test(message)) {
    return STARKNET_FEE_BALANCE_MESSAGE;
  }
  return null;
}
