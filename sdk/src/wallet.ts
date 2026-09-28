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
};
