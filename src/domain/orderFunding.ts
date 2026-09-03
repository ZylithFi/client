import { assetScale, toAtomicStr } from "./assets";
import type { LocalOrder } from "./orderLifecycle";

export type OrderFundingPair = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  price_base_scale?: string;
};

const ACTIVE_ORDER_STATUSES = new Set(["queued", "in_batch", "proving", "settling", "settled_pending_output"]);

export function orderFundingAsset(order: LocalOrder, pairs: OrderFundingPair[]): string {
  if (order.fundingAsset) return order.fundingAsset;
  const pair = pairs.find(entry => entry.pair_id === order.pair);
  if (!pair) return order.pair.split("/")[0] ?? "-";
  return order.side === "Buy" ? pair.quote_asset_id : pair.base_asset_id;
}

export function orderFundingAmountAtomic(order: LocalOrder, pairs: OrderFundingPair[]): bigint {
  const asset = orderFundingAsset(order, pairs);
  if (order.fundingAmount) return parseHumanAtomicAmount(order.fundingAmount, asset);
  const pair = pairs.find(entry => entry.pair_id === order.pair);
  if (!pair || order.side === "Sell" || !order.limitPrice) {
    return parseHumanAtomicAmount(order.amount, asset);
  }
  const amountAtomic = parseHumanAtomicAmount(order.amount, pair.base_asset_id);
  const priceAtomic = parseHumanAtomicAmount(order.limitPrice, pair.quote_asset_id);
  const priceBaseScale = parsePositiveBigInt(pair.price_base_scale ?? assetScale(pair.base_asset_id).toString());
  if (priceBaseScale === null) return 0n;
  return (amountAtomic * priceAtomic) / priceBaseScale;
}

function parseHumanAtomicAmount(value: string, assetId: string): bigint {
  try {
    const parsed = BigInt(toAtomicStr(value, assetId));
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function parsePositiveBigInt(value: string): bigint | null {
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function activeOrderFundingTotals(
  orders: LocalOrder[],
  pairs: OrderFundingPair[],
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const order of orders) {
    if (!ACTIVE_ORDER_STATUSES.has(order.status)) continue;
    const asset = orderFundingAsset(order, pairs);
    totals.set(asset, (totals.get(asset) ?? 0n) + orderFundingAmountAtomic(order, pairs));
  }
  return totals;
}
