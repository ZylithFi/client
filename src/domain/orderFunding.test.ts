import { describe, expect, it } from "vitest";
import { activeOrderFundingTotals, orderFundingAmountAtomic } from "./orderFunding";
import type { LocalOrder } from "./orderLifecycle";

function order(patch: Partial<LocalOrder> = {}): LocalOrder {
  return {
    ordRef: "ORD-1",
    orderCommitment: "0xorder",
    cancellationSecret: "0xcancel",
    batchId: "batch-1",
    epochId: 1,
    pair: "ETH/USDC",
    side: "Buy",
    wireMode: "Limit",
    amount: "1",
    limitPrice: "2000",
    minFill: "0",
    fillOrKill: false,
    status: "in_batch",
    submittedAt: 1,
    ...patch,
  };
}

describe("order funding display helpers", () => {
  it("fails closed instead of throwing on malformed pair price scale", () => {
    const pairs = [{
      pair_id: "ETH/USDC",
      base_asset_id: "ETH",
      quote_asset_id: "USDC",
      price_base_scale: "bad-scale",
    }];

    expect(orderFundingAmountAtomic(order(), pairs)).toBe(0n);
    expect(activeOrderFundingTotals([order()], pairs).get("USDC")).toBe(0n);
  });

  it("fails closed instead of throwing on malformed local order amounts", () => {
    const pairs = [{
      pair_id: "ETH/USDC",
      base_asset_id: "ETH",
      quote_asset_id: "USDC",
      price_base_scale: "1000000000000000000",
    }];

    expect(orderFundingAmountAtomic(order({ fundingAmount: "bad" }), pairs)).toBe(0n);
    expect(orderFundingAmountAtomic(order({ amount: "bad" }), pairs)).toBe(0n);
    expect(orderFundingAmountAtomic(order({ limitPrice: "bad" }), pairs)).toBe(0n);
    expect(activeOrderFundingTotals([
      order({ fundingAmount: "bad" }),
      order({ amount: "bad" }),
    ], pairs).get("USDC")).toBe(0n);
  });
});
