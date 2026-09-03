export type WalletBalance = {
  asset: string;
  available: string;
  locked: string;
};

export type WithdrawableNote = {
  note_commitment: string;
  batch_id?: string;
  source: "deposit" | "settlement_output";
  asset: string;
  amount: string;
  locked: boolean;
  spent: boolean;
  pending_withdrawal_tx?: string;
  pending_strk20_open_note_tx?: string;
  strk20_exit_commitment?: string;
  strk20_open_note_id?: string;
  metadata_commitment: string;
  liquidity_provider_attribution?: LiquidityBandAttribution;
};

export type LiquidityBandAttribution = {
  version: number;
  pair_id: string;
  order_commitment: string;
  funding_note_ref: string;
  side: "Buy" | "Sell";
  clearing_price: string;
  filled_base_amount: string;
  bands: Array<{
    band_index: number;
    band_price: string;
    band_base_amount: string;
    filled_base_amount: string;
  }>;
};

export type PendingDeposit = {
  note_commitment: string;
  asset: string;
  amount: string;
  transaction_hash?: string;
  request_id?: string;
  requested_at_unix_ms?: number;
  confirmed: boolean;
  failed?: boolean;
  failure_reason?: string;
};
