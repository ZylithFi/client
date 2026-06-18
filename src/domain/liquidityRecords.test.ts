import { describe, expect, it } from "vitest";
import type { LocalOrder, PrivateStrategySummary } from "./orderLifecycle";
import {
  activeCurveRecords,
  buildCurveRecords,
  buildLiquidityEpochSeries,
  curveEpochOutcomes,
  curveLockedCapital,
  orderQuoteNotional,
  visibleLiquidityEpochSeries,
} from "./liquidityRecords";

const pair = {
  pair_id: "ETH/USDC",
  base_asset_id: "ETH",
  quote_asset_id: "USDC",
};

function order(patch: Partial<LocalOrder> = {}): LocalOrder {
  return {
    ordRef: "ord-1",
    orderCommitment: "0xorder",
    cancellationSecret: "0xcancel",
    batchId: "batch-1",
    epochId: 10,
    pair: "ETH/USDC",
    side: "Sell",
    wireMode: "Maker Curve",
    amount: "2",
    limitPrice: "1800",
    minFill: "0",
    fillOrKill: false,
    status: "queued",
    submittedAt: 1_700_000_000_000,
    ...patch,
  };
}

function strategy(patch: Partial<PrivateStrategySummary> = {}): PrivateStrategySummary {
  return {
    id: "strategy-1",
    mode: "Resting",
    pair: "ETH/USDC",
    side: "Sell",
    status: "active",
    total_amount: "2",
    remaining_amount: "2",
    child_amount: "1",
    max_children: 12,
    next_child_index: 7,
    start_epoch: 10,
    end_epoch: 21,
    maker_curve_points: [
      { price: "1800000000", base_amount: "1000000000000000000" },
      { price: "1900000000", base_amount: "1000000000000000000" },
    ],
    submitted_children: [],
    ...patch,
  };
}

describe("liquidityRecords", () => {
  it("groups resting strategy children under one active curve record", () => {
    const child = order({
      ordRef: "child-1",
      strategyId: "strategy-1",
      orderCommitment: "0xchild",
      status: "filled",
      filledAmount: "1",
      clearingPrice: "1810",
    });
    const stray = order({ ordRef: "stray", orderCommitment: "0xstray" });

    const records = buildCurveRecords([child, stray], [strategy()], [pair]);
    const strategyRecord = records.find(record => record.id === "strategy-1");
    const strayRecord = records.find(record => record.id === "stray");

    expect(records).toHaveLength(2);
    expect(strategyRecord).toMatchObject({
      id: "strategy-1",
      pair: "ETH/USDC",
      sideLabel: "Ask",
      status: "Expiring",
    });
    expect(strategyRecord?.relatedOrders).toEqual([child]);
    expect(strayRecord).toMatchObject({ id: "stray", status: "Active" });
  });

  it("calculates locked capital by side and filters active records", () => {
    const [sellRecord] = buildCurveRecords([], [strategy()], [pair]);
    const [buyRecord] = buildCurveRecords([], [strategy({ side: "Buy" })], [pair]);

    expect(curveLockedCapital(sellRecord)).toBe(2);
    expect(curveLockedCapital(buyRecord)).toBe(3700);
    expect(activeCurveRecords([sellRecord, { ...sellRecord, status: "Historical" }])).toHaveLength(1);
  });

  it("uses local clearing prices for quote notional and epoch analytics", () => {
    const filled = order({
      status: "filled",
      filledAmount: "2",
      clearingPrice: "1810",
    });
    const noFill = order({
      ordRef: "no-fill",
      status: "no_fill",
      epochId: 12,
    });

    expect(orderQuoteNotional(filled)).toBe(3620);
    expect(orderQuoteNotional(noFill)).toBe(0);

    const series = buildLiquidityEpochSeries([{ order: filled }, { order: noFill }], "fills");
    expect(series).toEqual([
      { epoch: 10, barValue: 1, filled: 1, total: 1, fillRate: 100 },
      { epoch: 12, barValue: 0, filled: 0, total: 1, fillRate: 0 },
    ]);
    expect(visibleLiquidityEpochSeries(series, 4).map(point => point.epoch)).toEqual([10, 11, 12]);
  });

  it("maps relay child outcomes to related settled orders when available", () => {
    const related = order({
      strategyId: "strategy-1",
      orderCommitment: "0xchild-1",
      status: "partial",
      filledAmount: "0.8",
      clearingPrice: "1811",
    });
    const [record] = buildCurveRecords([related], [strategy({
      submitted_children: [{
        parent_child_index: 1,
        batch_id: "batch-1",
        epoch_id: 10,
        order_commitment: "0xchild-1",
        relay_status: "awaiting_settlement",
        submitted_at_unix_ms: 1_700_000_001_000,
      }],
    })], [pair]);

    expect(curveEpochOutcomes(record, new Map())).toEqual([expect.objectContaining({
      key: "strategy-1:child:1",
      label: "Partial",
      tone: "info",
      clearingPrice: "1811",
      filledAmount: "0.8",
    })]);
  });
});
