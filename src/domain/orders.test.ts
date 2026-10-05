import { describe, expect, it } from "vitest";
import type { WalletOrder } from "@zylith/sdk";
import type { PairConfig } from "./deployment";
import { isOpenOrder, orderRows, orderStatusLabel } from "./orders";

const pair: PairConfig = {
  pair_id: "STRK/USDC",
  base_asset_id: "STRK",
  quote_asset_id: "USDC",
  min_order_amount: "1",
  min_order_quote_amount: "1",
  price_base_scale: "1000000000000000000",
  taker_fee_bps: 4,
  external_match_enabled: true,
  external_settlement_support_quote: "1",
  enabled: true,
};

const order: WalletOrder = {
  order_id: "0x1",
  pair: "STRK/USDC",
  side: "Sell",
  external: false,
  amount: "10000000000000000000",
  limit_price: "50000",
  expires_at_ms: 1,
  funding_asset: "STRK",
  funding_amount: "10000000000000000000",
  state: "live",
  filled_base: "4000000000000000000",
  filled_quote: "200000",
  fees: "80",
  submitted_at_ms: 1,
  updated_at_ms: 1,
  residual_recovery_available: true,
};

describe("order rows", () => {
  it("shows sizes, prices and fees in human units", () => {
    const [row] = orderRows([order], [pair], { STRK: 0.04 });
    expect(row).toMatchObject({ amount: "10", filled: "4", averagePrice: "0.05", fees: "0.00008 USDC", orderValue: "10 STRK", orderValueNumeric: 0.4, recoveryAvailable: true });
    expect(orderStatusLabel(row)).toBe("Partially filled");
    expect(isOpenOrder(row)).toBe(true);
    expect(isOpenOrder({ state: "expired" })).toBe(false);
    expect(orderRows([{ ...order, pair: "ETH/USDC" }], [pair])).toEqual([]);
    const [oversizedFunding] = orderRows([{ ...order, funding_amount: "50000000000000000000" }], [pair]);
    expect(oversizedFunding?.orderValue).toBe("10 STRK");
    const [buy] = orderRows([{ ...order, side: "Buy", funding_asset: "USDC", funding_amount: "900000" }], [pair]);
    expect(buy?.orderValue).toBe("0.5 USDC");
  });

  it("collapses internal admission states into user-facing statuses", () => {
    const [row] = orderRows([order], [pair]);
    expect(orderStatusLabel({ ...row, state: "submitting", filled: "0" })).toBe("Submitting");
    expect(orderStatusLabel({ ...row, state: "pending", filled: "0" })).toBe("Submitting");
    expect(orderStatusLabel({ ...row, state: "live", filled: "0" })).toBe("Open");
    expect(orderStatusLabel({ ...row, state: "live", filled: "1" })).toBe("Partially filled");
  });
});
