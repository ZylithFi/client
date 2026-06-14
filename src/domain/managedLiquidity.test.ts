import { describe, expect, it } from "vitest";
import {
  authorizeDelegatedMakerCurve,
  buildInventorySnapshot,
  buildManagedCurvePlan,
  compileManagedCurveIntent,
  pendingExposureFromOrders,
  reconcileMakerPnl,
  selectFairPrice,
  type ManagedRiskPolicy,
  type ManagedStrategyConfig,
} from "./managedLiquidity";
import type { LocalOrder } from "./orderLifecycle";

const pair = {
  pair_id: "ETH/USDC",
  base_asset_id: "ETH",
  quote_asset_id: "USDC",
  min_order_amount: "0.01",
  enabled: true,
};

const risk: ManagedRiskPolicy = {
  minSpreadBps: 10,
  maxSpreadBps: 300,
  maxPriceDeviationBps: 500,
  maxEpochBase: 10,
  maxInventoryImbalanceBps: 9_500,
  allowBid: true,
  allowAsk: true,
};

const strategy: ManagedStrategyConfig = {
  pair: "ETH/USDC",
  side: "Both",
  targetBaseRatio: 0.5,
  baseSpreadBps: 40,
  volatilityBps: 20,
  inventorySkewBps: 100,
  bandCount: 3,
  maxEpochBase: 3,
  minBandBase: 0.25,
  maxExposureBase: 5,
  relayMode: "ZylithRelay",
  durationHours: 24,
};

describe("managed liquidity fair price engine", () => {
  it("rejects stale or divergent market data", () => {
    const now = 1_000_000;
    expect(selectFairPrice("ETH/USDC", [], {
      maxStalenessMs: 10_000,
      maxDivergenceBps: 50,
      minSources: 2,
    }, now).ok).toBe(false);

    const divergent = selectFairPrice("ETH/USDC", [
      { pair: "ETH/USDC", source: "dex-a", price: 1000, observedAt: now },
      { pair: "ETH/USDC", source: "dex-b", price: 1100, observedAt: now },
    ], {
      maxStalenessMs: 10_000,
      maxDivergenceBps: 50,
      minSources: 2,
    }, now);
    expect(divergent).toMatchObject({ ok: false, reason: "divergent" });

    const stale = selectFairPrice("ETH/USDC", [
      { pair: "ETH/USDC", source: "dex-a", price: 1000, observedAt: now - 20_000 },
      { pair: "ETH/USDC", source: "dex-b", price: 1001, observedAt: now },
    ], {
      maxStalenessMs: 10_000,
      maxDivergenceBps: 50,
      minSources: 2,
    }, now);
    expect(stale).toMatchObject({ ok: false, reason: "stale" });
  });

  it("selects the median fair price from fresh consistent sources", () => {
    const result = selectFairPrice("ETH/USDC", [
      { pair: "ETH/USDC", source: "dex-a", price: 1000, observedAt: 100 },
      { pair: "ETH/USDC", source: "dex-b", price: 1002, observedAt: 100 },
      { pair: "ETH/USDC", source: "oracle", price: 1001, observedAt: 100 },
    ], {
      maxStalenessMs: 10_000,
      maxDivergenceBps: 50,
      minSources: 2,
    }, 100);
    expect(result).toMatchObject({ ok: true, price: 1001 });
  });
});

describe("managed liquidity inventory and strategy engine", () => {
  it("counts pending order exposure before generating a curve", () => {
    const pendingOrder = order({ side: "Buy", amount: "1", limitPrice: "1000", status: "in_batch" });
    const pending = pendingExposureFromOrders([pendingOrder]);
    const inventory = buildInventorySnapshot(pair, [
      { asset: "ETH", available: "4", locked: "1" },
      { asset: "USDC", available: "5000", locked: "0" },
    ], pending, 1000);
    expect(inventory.pendingBuyBase).toBe(1);
    expect(inventory.pendingQuote).toBe(1000);
    expect(inventory.baseRatio).toBeGreaterThan(0.49);
  });

  it("builds bid and ask curves inside the risk envelope", () => {
    const fairPrice = selectFairPrice("ETH/USDC", [
      { pair: "ETH/USDC", source: "dex-a", price: 1000, observedAt: 100 },
      { pair: "ETH/USDC", source: "dex-b", price: 1001, observedAt: 100 },
    ], {
      maxStalenessMs: 10_000,
      maxDivergenceBps: 50,
      minSources: 2,
    }, 100);
    const inventory = buildInventorySnapshot(pair, [
      { asset: "ETH", available: "5", locked: "0" },
      { asset: "USDC", available: "5000", locked: "0" },
    ], [], 1000);
    const plan = buildManagedCurvePlan({ pair, fairPrice, inventory, config: strategy, risk });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.curves).toHaveLength(2);
    expect(plan.curves.every((curve) => curve.points.length === 3)).toBe(true);
    expect(plan.curves.find((curve) => curve.side === "Buy")?.points[0].price).toBeLessThan(1001);
    expect(plan.curves.find((curve) => curve.side === "Sell")?.points[0].price).toBeGreaterThan(999);
  });

  it("rejects curves when inventory imbalance exceeds policy", () => {
    const fairPrice = { ok: true as const, pair: "ETH/USDC", price: 1000, observedAt: 1, sources: ["oracle"], maxDivergenceBps: 0 };
    const inventory = buildInventorySnapshot(pair, [
      { asset: "ETH", available: "20", locked: "0" },
      { asset: "USDC", available: "0", locked: "0" },
    ], [], 1000);
    const plan = buildManagedCurvePlan({
      pair,
      fairPrice,
      inventory,
      config: strategy,
      risk: { ...risk, maxInventoryImbalanceBps: 1_000 },
    });
    expect(plan).toMatchObject({ ok: false, reason: "inventory imbalance exceeds risk policy" });
  });

  it("requires delegated signer permissions to match pair side size and price band", () => {
    const fairPrice = { ok: true as const, pair: "ETH/USDC", price: 1000, observedAt: 1, sources: ["oracle"], maxDivergenceBps: 0 };
    const inventory = buildInventorySnapshot(pair, [
      { asset: "ETH", available: "5", locked: "0" },
      { asset: "USDC", available: "5000", locked: "0" },
    ], [], 1000);
    const plan = buildManagedCurvePlan({ pair, fairPrice, inventory, config: strategy, risk });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const curve = plan.curves[0];
    expect(authorizeDelegatedMakerCurve(curve, 1000, {
      pairs: ["ETH/USDC"],
      sides: [curve.side],
      maxEpochBase: 3,
      maxPriceDeviationBps: 500,
      expiresAt: 10_000,
      relayModes: ["ZylithRelay"],
    }, 1)).toMatchObject({ ok: true });
    expect(authorizeDelegatedMakerCurve(curve, 1000, {
      pairs: ["STRK/USDC"],
      sides: [curve.side],
      maxEpochBase: 3,
      maxPriceDeviationBps: 500,
      expiresAt: 10_000,
      relayModes: ["ZylithRelay"],
    }, 1)).toMatchObject({ ok: false, reason: "pair not delegated" });
  });

  it("compiles a managed curve into the existing order ticket shape", () => {
    const fairPrice = { ok: true as const, pair: "ETH/USDC", price: 1000, observedAt: 1, sources: ["oracle"], maxDivergenceBps: 0 };
    const inventory = buildInventorySnapshot(pair, [
      { asset: "ETH", available: "5", locked: "0" },
      { asset: "USDC", available: "5000", locked: "0" },
    ], [], 1000);
    const plan = buildManagedCurvePlan({ pair, fairPrice, inventory, config: strategy, risk });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const intent = compileManagedCurveIntent(plan.curves[0]);
    expect(intent).toMatchObject({
      shape: "curve",
      resting: true,
      relayMode: "ZylithRelay",
      relayOperator: "ZylithRelay",
    });
    expect(intent.curvePoints).toHaveLength(3);
  });
});

describe("managed liquidity reconciliation", () => {
  it("computes maker PnL from settled child orders", () => {
    const pnl = reconcileMakerPnl("ETH/USDC", [
      order({ side: "Sell", amount: "1", filledAmount: "1", limitPrice: "1000", clearingPrice: "1010", status: "filled" }),
      order({ side: "Buy", amount: "0.5", filledAmount: "0.5", limitPrice: "990", clearingPrice: "980", status: "filled" }),
      order({ side: "Sell", amount: "1", limitPrice: "1100", status: "no_fill" }),
    ]);
    expect(pnl.filledChildren).toBe(2);
    expect(pnl.noFillChildren).toBe(1);
    expect(pnl.baseDelta).toBe(-0.5);
    expect(pnl.quoteDelta).toBe(520);
    expect(pnl.averageCaptureBps).toBeGreaterThan(90);
  });
});

function order(overrides: Partial<LocalOrder>): LocalOrder {
  return {
    ordRef: "ORD",
    orderCommitment: "0xorder",
    cancellationSecret: "secret",
    batchId: "batch",
    epochId: 1,
    pair: "ETH/USDC",
    side: "Buy",
    wireMode: "Resting",
    amount: "1",
    limitPrice: "1000",
    minFill: "0",
    fillOrKill: false,
    status: "queued",
    submittedAt: 1,
    ...overrides,
  };
}
