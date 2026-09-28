export type WalletBalance = {
  asset: string;
  available: string;
  locked: string;
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
