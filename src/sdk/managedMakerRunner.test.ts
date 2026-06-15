import { describe, expect, it, vi } from "vitest";
import { MarketDataEngine } from "../domain/marketData";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";
import type { WalletBalance } from "../domain/shieldedBalances";
import { ZylithMakerSdk, type MakerWalletRuntime } from "./maker";
import {
  ZylithManagedMakerRunner,
  type ManagedMakerRunnerRuntime,
  type ManagedMakerRunnerState,
  type ManagedMakerRunnerStrategy,
} from "./managedMakerRunner";

const pair = {
  pair_id: "ETH/USDC",
  base_asset_id: "ETH",
  quote_asset_id: "USDC",
  min_order_amount: "0.01",
  enabled: true,
};

const baseStrategy: ManagedMakerRunnerStrategy = {
  id: "managed-eth-usdc",
  pair,
  strategy: {
    pair: "ETH/USDC",
    side: "Ask",
    targetBaseRatio: 0.5,
    baseSpreadBps: 30,
    volatilityBps: 10,
    inventorySkewBps: 50,
    bandCount: 2,
    maxEpochBase: 2,
    minBandBase: 0.1,
    maxExposureBase: 2,
    relayMode: "SelfRelay",
    durationHours: 1,
  },
  risk: {
    minSpreadBps: 10,
    maxSpreadBps: 200,
    maxPriceDeviationBps: 500,
    maxEpochBase: 3,
    maxInventoryImbalanceBps: 9_000,
    allowBid: true,
    allowAsk: true,
  },
};

describe("ZylithManagedMakerRunner", () => {
  it("builds and submits an authorized curve once per epoch", async () => {
    const submittedIntents: unknown[] = [];
    let savedState: ManagedMakerRunnerState | null = null;
    const events: unknown[] = [];
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: runtime({
        submitPrivateOrder: vi.fn(async (intent) => {
          submittedIntents.push(intent);
          return { strategy_id: `strategy-${submittedIntents.length}` };
        }),
      }),
      marketData: consistentMarketData(),
      strategies: [baseStrategy],
      currentBatch: async () => openBatch(),
      now: () => 1_000,
      store: {
        loadState: () => savedState,
        saveState: (state) => { savedState = state; },
      },
      onEvent: (event) => events.push(event),
    });

    const first = await runner.runOnce();
    expect(first.submitted).toHaveLength(1);
    expect(submittedIntents).toHaveLength(1);
    expect(first.submitted[0]).toMatchObject({
      strategyId: "managed-eth-usdc",
      batchId: "batch-1",
      epochId: 1,
      curveCount: 1,
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "submitted", batchId: "batch-1" }));

    const second = await runner.runOnce();
    expect(second.submitted).toHaveLength(0);
    expect(second.skipped).toContainEqual(expect.objectContaining({ reason: "epoch already submitted" }));
    expect(submittedIntents).toHaveLength(1);
  });

  it("halts before submission when market data is stale or divergent", async () => {
    const submitPrivateOrder = vi.fn();
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: runtime({ submitPrivateOrder }),
      marketData: new MarketDataEngine({
        sources: [
          { id: "a", observe: async (pairId) => ({ source: "a", pair: pairId, price: 1000, observedAt: 1 }) },
          { id: "b", observe: async (pairId) => ({ source: "b", pair: pairId, price: 1100, observedAt: 1 }) },
        ],
        fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 2 },
        now: () => 1,
      }),
      strategies: [baseStrategy],
      currentBatch: async () => openBatch(),
      now: () => 1_000,
    });

    const result = await runner.runOnce();
    expect(result.submitted).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/diverge/i);
    expect(submitPrivateOrder).not.toHaveBeenCalled();
  });

  it("does not submit inside the epoch safety buffer", async () => {
    const submitPrivateOrder = vi.fn();
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: runtime({ submitPrivateOrder }),
      marketData: consistentMarketData(),
      strategies: [baseStrategy],
      currentBatch: async () => ({ ...openBatch(), close_time_unix_ms: 11_000 }),
      now: () => 1_000,
      submissionSafetyBufferMs: 15_000,
    });

    const result = await runner.runOnce();
    expect(result.skipped).toContainEqual(expect.objectContaining({ reason: "inside submission safety buffer" }));
    expect(submitPrivateOrder).not.toHaveBeenCalled();
  });

  it("requires delegated permissions to authorize generated curves", async () => {
    const submitPrivateOrder = vi.fn();
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: runtime({ submitPrivateOrder }),
      marketData: consistentMarketData(),
      strategies: [{
        ...baseStrategy,
        permission: {
          pairs: ["ETH/USDC"],
          sides: ["Buy"],
          maxEpochBase: 2,
          maxPriceDeviationBps: 500,
          expiresAt: 10_000,
          relayModes: ["SelfRelay"],
        },
      }],
      currentBatch: async () => openBatch(),
      now: () => 1_000,
    });

    const result = await runner.runOnce();
    expect(result.skipped).toContainEqual(expect.objectContaining({
      reason: "delegated permission rejects all curves",
    }));
    expect(submitPrivateOrder).not.toHaveBeenCalled();
  });

  it("submits both sides when strategy and risk allow bid and ask", async () => {
    const submittedSides: string[] = [];
    const submitPrivateOrder: MakerWalletRuntime["submitPrivateOrder"] = vi.fn(async (intent) => {
      submittedSides.push(intent.side);
      return { strategy_id: "strategy" };
    });
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: runtime({ submitPrivateOrder }),
      marketData: consistentMarketData(),
      strategies: [{
        ...baseStrategy,
        strategy: { ...baseStrategy.strategy, side: "Both" },
      }],
      currentBatch: async () => openBatch(),
      now: () => 1_000,
    });

    const result = await runner.runOnce();
    expect(result.submitted).toContainEqual(expect.objectContaining({ curveCount: 2 }));
    expect(submitPrivateOrder).toHaveBeenCalledTimes(2);
    expect(submittedSides).toEqual(["Buy", "Sell"]);
  });

  it("persists an epoch marker before external submission to prevent duplicate exposure after partial failure", async () => {
    let savedState: ManagedMakerRunnerState = { submittedEpochs: {}, failures: [] };
    const submitPrivateOrder = vi.fn(async () => {
      if (submitPrivateOrder.mock.calls.length === 2) throw new Error("relay unavailable after first curve");
      return { strategy_id: "strategy-1" };
    });
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: runtime({ submitPrivateOrder }),
      marketData: consistentMarketData(),
      strategies: [{
        ...baseStrategy,
        strategy: { ...baseStrategy.strategy, side: "Both" },
      }],
      currentBatch: async () => openBatch(),
      now: () => 1_000,
      store: {
        loadState: () => savedState,
        saveState: (state) => { savedState = state; },
      },
    });

    const first = await runner.runOnce();
    expect(first.failed).toContainEqual(expect.objectContaining({ reason: "relay unavailable after first curve" }));
    expect(savedState.submittedEpochs["managed-eth-usdc:batch-1"]).toMatchObject({
      curveCount: 1,
      strategyIds: ["strategy-1"],
    });

    const second = await runner.runOnce();
    expect(second.skipped).toContainEqual(expect.objectContaining({ reason: "epoch already submitted" }));
    expect(submitPrivateOrder).toHaveBeenCalledTimes(2);
  });

  it("builds an ops snapshot from runtime strategies balances and fair-price state", async () => {
    const privateStrategy: PrivateStrategySummary = {
      id: "strategy-1",
      mode: "Repeat",
      pair: "ETH/USDC",
      status: "delegated",
      total_amount: "1",
      remaining_amount: "1",
      child_amount: "1",
      max_children: 1,
      next_child_index: 1,
      start_epoch: 1,
      end_epoch: 2,
      submitted_children: [{
        parent_child_index: 1,
        batch_id: "batch-1",
        epoch_id: 1,
        relay_status: "awaiting_wallet_refresh",
        submitted_at_unix_ms: 1,
      }],
    };
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: runtime({ privateStrategies: [privateStrategy] }),
      marketData: consistentMarketData(),
      strategies: [baseStrategy],
      currentBatch: async () => openBatch(),
      now: () => 1_000,
    });

    await expect(runner.opsSnapshot()).resolves.toMatchObject({
      activeStrategies: 1,
      delegatedStrategies: 1,
      awaitingWalletRefreshSlots: 1,
      staleMarketPairs: [],
    });
  });
});

function consistentMarketData() {
  return new MarketDataEngine({
    sources: [
      { id: "a", observe: async (pairId) => ({ source: "a", pair: pairId, price: 1000, observedAt: 1 }) },
      { id: "b", observe: async (pairId) => ({ source: "b", pair: pairId, price: 1001, observedAt: 1 }) },
    ],
    fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 2 },
    now: () => 1,
  });
}

function openBatch() {
  return {
    batch_id: "batch-1",
    pair_id: "ETH/USDC",
    epoch_id: 1,
    close_time_unix_ms: 60_000,
    status: "Open" as const,
    order_count_bucket: "0-7",
  };
}

function runtime(overrides: {
  submitPrivateOrder?: MakerWalletRuntime["submitPrivateOrder"];
  privateStrategies?: PrivateStrategySummary[];
  orders?: LocalOrder[];
  balances?: WalletBalance[];
} = {}): ManagedMakerRunnerRuntime {
  return {
    submitPrivateOrder: overrides.submitPrivateOrder ?? vi.fn(async () => ({ strategy_id: "strategy-1" })),
    getBalances: () => overrides.balances ?? [
      { asset: "ETH", available: "5", locked: "0" },
      { asset: "USDC", available: "5000", locked: "0" },
    ],
    getOrders: () => overrides.orders ?? [],
    getPrivateStrategies: () => overrides.privateStrategies ?? [],
  };
}
