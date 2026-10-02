import type { OrderState, WalletOrder } from "@zylith/sdk";
import { formatPrice, fromAtomicStr } from "./assets";
import type { PairConfig } from "./deployment";

/** an order as the tables show it, in human units. */
export type OrderRow = {
  id: string;
  pair: string;
  side: WalletOrder["side"];
  state: OrderState;
  external: boolean;
  amount: string;
  filled: string;
  orderValue: string;
  orderValueNumeric: number | null;
  averagePrice: string;
  fees: string;
  submittedAt: number;
  recoveryAvailable: boolean;
  error?: string;
};

export const OPEN_ORDER_STATES = new Set<OrderState>(["submitting", "pending", "live", "cancelling"]);

export function isOpenOrder(row: { state: OrderState }) {
  return OPEN_ORDER_STATES.has(row.state);
}

export function orderStatusLabel(row: OrderRow) {
  if (row.state === "live" && row.filled !== "0") return "Partially filled";
  const labels: Record<OrderState, string> = {
    submitting: "Submitting",
    pending: "Submitting",
    live: "Open",
    cancelling: "Cancelling",
    filled: "Filled",
    cancelled: "Cancelled",
    expired: "Expired",
    failed: "Failed",
  };
  return labels[row.state];
}

export function orderStatusTone(state: OrderState) {
  if (state === "filled") return "success";
  if (state === "cancelled" || state === "expired") return "neutral";
  if (state === "failed") return "danger";
  return "blue";
}

export function orderRows(orders: WalletOrder[], pairs: PairConfig[], assetUnitPrices: Record<string, number> = {}): OrderRow[] {
  return orders.flatMap((order) => {
    const pair = pairs.find((candidate) => candidate.pair_id === order.pair);
    if (!pair) return [];
    const filledBase = BigInt(order.filled_base);
    const average =
      filledBase > 0n ? formatPrice(((BigInt(order.filled_quote) * BigInt(pair.price_base_scale)) / filledBase).toString(), pair) : "Not filled";
    const proceedsAsset = order.side === "Sell" ? pair.quote_asset_id : pair.base_asset_id;
    const orderValueAmount = fromAtomicStr(order.funding_amount, order.funding_asset);
    const unitPrice = assetUnitPrices[order.funding_asset];
    const orderValueNumeric = unitPrice === undefined ? null : Number(orderValueAmount.replaceAll(",", "")) * unitPrice;
    return [
      {
        id: order.order_id,
        pair: order.pair,
        side: order.side,
        state: order.state,
        external: order.external,
        amount: fromAtomicStr(order.amount, pair.base_asset_id),
        filled: fromAtomicStr(order.filled_base, pair.base_asset_id),
        orderValue: `${orderValueAmount} ${order.funding_asset}`,
        orderValueNumeric: orderValueNumeric !== null && Number.isFinite(orderValueNumeric) ? orderValueNumeric : null,
        averagePrice: average,
        fees: order.fees === "0" ? "None" : `${fromAtomicStr(order.fees, proceedsAsset)} ${proceedsAsset}`,
        submittedAt: order.submitted_at_ms,
        recoveryAvailable: order.residual_recovery_available === true,
        error: order.last_error,
      },
    ];
  });
}
