import type { WalletBalance, WithdrawableNote } from "./common.js";

export type OrderSide = "Buy" | "Sell";

/** a persistent limit order: it rests across epochs until filled, cancelled or expired. */
export type OrderDraft = {
  /** the pair's manifest name, such as strk/usdc. */
  pair: string;
  side: OrderSide;
  /** base amount in atoms. */
  amount: string;
  /** quote atoms per the pair's price base scale of base atoms. */
  limitPrice: string;
  /** whether a residual may fill against ekubo after the internal cross. */
  external: boolean;
  /** absolute expiry; the wallet's default when omitted. */
  expiresAtMs?: number;
};

export type OrderState = "submitting" | "pending" | "live" | "cancelling" | "filled" | "cancelled" | "expired" | "failed";

export type WalletOrder = {
  order_id: string;
  pair: string;
  side: OrderSide;
  external: boolean;
  amount: string;
  limit_price: string;
  expires_at_ms: number;
  funding_asset: string;
  funding_amount: string;
  state: OrderState;
  filled_base: string;
  filled_quote: string;
  fees: string;
  submitted_at_ms: number;
  updated_at_ms: number;
  last_error?: string;
  /** true when the wallet holds the latest nullifiable residual-order authority. */
  residual_recovery_available?: boolean;
};

/** a complete, deterministic residual-recovery statement ready for any compatible prover. */
export type ResidualRecoveryPreparation = {
  order_id: string;
  residual_seq: number;
  note_root: string;
  nullifier: string;
  statement_commitment: string;
  input_asset_id: string;
  input_amount: string;
  output_asset_id: string;
  output_amount: string;
  fee_amount: string;
  witness: string[];
  recovery_calldata: string[];
  proof_program_call: {
    contract_address: string;
    entrypoint: "compile_residual_recovery_proof";
    calldata: string[];
  };
  settlement_call: {
    contract_address: string;
    entrypoint: "request_residual_recovery";
    calldata: string[];
  };
  input_exit_commitment: string | null;
  output_exit_commitment: string | null;
};

export type ResidualRecoverySubmission = {
  nullifier: string;
  transaction_hash: string | null;
  already_requested: boolean;
};

export type ResidualRecoveryFinalization = {
  nullifier: string;
  transaction_hash: string | null;
  already_final: boolean;
  matures_at: number;
};

export type ResidualRecoveryClaim = {
  input_transaction_hash: string | null;
  output_transaction_hash: string | null;
};

/** what a trading program needs from a zylith wallet. */
export type TraderWalletRuntime = {
  submitOrder: (draft: OrderDraft) => Promise<{ order_id: string }>;
  cancelOrder: (orderId: string) => Promise<void>;
  getOrders: () => WalletOrder[];
  getBalances: () => WalletBalance[];
  refresh: () => Promise<void>;
  getWithdrawableNotes?: () => WithdrawableNote[];
  withdraw?: (noteCommitment: string) => Promise<unknown>;
  prepareResidualRecovery?: (orderId: string) => Promise<ResidualRecoveryPreparation>;
  submitResidualRecovery?: (orderId: string) => Promise<ResidualRecoverySubmission>;
  freezeResidualRecoveryCapacity?: (orderId: string) => Promise<unknown>;
  finalizeResidualRecovery?: (orderId: string) => Promise<ResidualRecoveryFinalization>;
  claimResidualRecovery?: (orderId: string) => Promise<ResidualRecoveryClaim>;
};
