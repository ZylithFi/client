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
  metadata_commitment: string;
};

export type PendingDeposit = {
  note_commitment: string;
  asset: string;
  amount: string;
  transaction_hash?: string;
  confirmed: boolean;
  failed?: boolean;
  failure_reason?: string;
};
