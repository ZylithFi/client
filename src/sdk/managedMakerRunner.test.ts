import { describe, expect, it, vi } from "vitest";
import { MarketDataEngine } from "../domain/marketData";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";
import type { WalletBalance } from "../domain/shieldedBalances";
import type { OfflineRenewalPackage } from "../offlineRenewalOperator";
import { ZylithMakerSdk, type MakerWalletRuntime } from "./maker";
import {
  ZylithManagedMakerRunner,
  type ManagedMakerRunnerRuntime,
  type ManagedMakerRunnerState,
  type ManagedMakerRunnerStrategy,
} from "./managedMakerRunner";
import { ZylithRelaySdk } from "./relay";

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
    expect(runner.telemetrySnapshot()).toMatchObject({
      submitted: 1,
      skipped: 1,
      failed: 0,
      lastSubmittedAt: 1_000,
      lastSkippedAt: 1_000,
    });
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

  it("retries the same epoch after a complete pre-exposure submission outage", async () => {
    let savedState: ManagedMakerRunnerState = { submittedEpochs: {}, failures: [] };
    let shouldFail = true;
    const submitPrivateOrder = vi.fn(async () => {
      if (shouldFail) throw new Error("prover unavailable before package creation");
      return { strategy_id: "strategy-recovered" };
    });
    const shared = {
      sdk: new ZylithMakerSdk(),
      runtime: runtime({ submitPrivateOrder }),
      marketData: consistentMarketData(),
      strategies: [baseStrategy],
      currentBatch: async () => openBatch(),
      now: () => 1_000,
      store: {
        loadState: () => savedState,
        saveState: (state: ManagedMakerRunnerState) => { savedState = state; },
      },
    };

    const failed = await new ZylithManagedMakerRunner(shared).runOnce();
    expect(failed.failed).toContainEqual(expect.objectContaining({
      reason: "prover unavailable before package creation",
    }));
    expect(savedState.submittedEpochs).toEqual({});

    shouldFail = false;
    const recovered = await new ZylithManagedMakerRunner(shared).runOnce();
    expect(recovered.submitted).toContainEqual(expect.objectContaining({
      batchId: "batch-1",
      curveCount: 1,
      strategyIds: ["strategy-recovered"],
    }));
    expect(submitPrivateOrder).toHaveBeenCalledTimes(2);
  });

  it("keeps a partial exposure marker when relay registration fails after package creation", async () => {
    let savedState: ManagedMakerRunnerState = { submittedEpochs: {}, failures: [] };
    const relay = new ZylithRelaySdk({
      relayUrl: "https://relay.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: "relay unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    });
    const submitPrivateOrder = vi.fn(async () => ({
      strategy_id: "strategy-relay-partial",
      offline_package: packageFixture(),
    }));
    const shared = {
      sdk: new ZylithMakerSdk({ relay }),
      runtime: runtime({ submitPrivateOrder }),
      marketData: consistentMarketData(),
      strategies: [{
        ...baseStrategy,
        strategy: { ...baseStrategy.strategy, relayMode: "ZylithRelay" as const },
      }],
      currentBatch: async () => openBatch(),
      now: () => 1_000,
      store: {
        loadState: () => savedState,
        saveState: (state: ManagedMakerRunnerState) => { savedState = state; },
      },
    };

    const failed = await new ZylithManagedMakerRunner(shared).runOnce();
    expect(failed.failed).toContainEqual(expect.objectContaining({
      reason: "relay registration failed: relay unavailable",
    }));
    expect(savedState.submittedEpochs["managed-eth-usdc:batch-1"]).toMatchObject({
      curveCount: 0,
      strategyIds: ["strategy-relay-partial"],
      packageIds: ["pkg"],
    });

    const restarted = await new ZylithManagedMakerRunner(shared).runOnce();
    expect(restarted.skipped).toContainEqual(expect.objectContaining({ reason: "epoch already submitted" }));
    expect(submitPrivateOrder).toHaveBeenCalledTimes(1);
  });

  it("survives runner restart and submits only the next batch", async () => {
    let savedState: ManagedMakerRunnerState = { submittedEpochs: {}, failures: [] };
    let batch = openBatch();
    const submittedBatches: string[] = [];
    const submitPrivateOrder = vi.fn(async () => {
      submittedBatches.push(batch.batch_id);
      return { strategy_id: `strategy-${submittedBatches.length}` };
    });
    const shared = {
      sdk: new ZylithMakerSdk(),
      runtime: runtime({ submitPrivateOrder }),
      marketData: consistentMarketData(),
      strategies: [baseStrategy],
      currentBatch: async () => batch,
      now: () => 1_000,
      store: {
        loadState: () => savedState,
        saveState: (state: ManagedMakerRunnerState) => { savedState = state; },
      },
    };

    const first = new ZylithManagedMakerRunner(shared);
    await expect(first.runOnce()).resolves.toMatchObject({
      submitted: [expect.objectContaining({ batchId: "batch-1", epochId: 1 })],
    });

    const restartedSameBatch = new ZylithManagedMakerRunner(shared);
    await expect(restartedSameBatch.runOnce()).resolves.toMatchObject({
      submitted: [],
      skipped: [expect.objectContaining({ reason: "epoch already submitted" })],
    });

    batch = { ...openBatch(), batch_id: "batch-2", epoch_id: 2 };
    const restartedNextBatch = new ZylithManagedMakerRunner(shared);
    await expect(restartedNextBatch.runOnce()).resolves.toMatchObject({
      submitted: [expect.objectContaining({ batchId: "batch-2", epochId: 2 })],
    });
    expect(submittedBatches).toEqual(["batch-1", "batch-2"]);
    expect(Object.keys(savedState.submittedEpochs).sort()).toEqual([
      "managed-eth-usdc:batch-1",
      "managed-eth-usdc:batch-2",
    ]);
  });

  it("runs a long soak across many epochs without duplicate submissions", async () => {
    let savedState: ManagedMakerRunnerState = { submittedEpochs: {}, failures: [] };
    let epoch = 1;
    const submittedBatches: string[] = [];
    const submitPrivateOrder = vi.fn(async () => {
      submittedBatches.push(`batch-${epoch}`);
      return { strategy_id: `strategy-${epoch}` };
    });
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: runtime({ submitPrivateOrder }),
      marketData: consistentMarketData(),
      strategies: [baseStrategy],
      currentBatch: async () => ({ ...openBatch(), batch_id: `batch-${epoch}`, epoch_id: epoch }),
      now: () => 1_000,
      store: {
        loadState: () => savedState,
        saveState: (state) => { savedState = state; },
      },
    });

    for (epoch = 1; epoch <= 96; epoch += 1) {
      const result = await runner.runOnce();
      expect(result.failed).toEqual([]);
      expect(result.submitted).toContainEqual(expect.objectContaining({
        batchId: `batch-${epoch}`,
        epochId: epoch,
        curveCount: 1,
      }));
      const duplicate = await runner.runOnce();
      expect(duplicate.submitted).toEqual([]);
      expect(duplicate.skipped).toContainEqual(expect.objectContaining({
        batchId: `batch-${epoch}`,
        reason: "epoch already submitted",
      }));
    }

    expect(submittedBatches).toHaveLength(96);
    expect(new Set(submittedBatches).size).toBe(96);
    expect(Object.keys(savedState.submittedEpochs)).toHaveLength(96);
  });

  it("submits independent strategies across multiple pairs and asset scales", async () => {
    const ethUsdc = baseStrategy;
    const strkEth: ManagedMakerRunnerStrategy = {
      ...baseStrategy,
      id: "managed-strk-eth",
      pair: {
        pair_id: "STRK/ETH",
        base_asset_id: "STRK",
        quote_asset_id: "ETH",
        min_order_amount: "1",
        enabled: true,
      },
      strategy: {
        ...baseStrategy.strategy,
        pair: "STRK/ETH",
        side: "Ask",
        maxEpochBase: 2,
        maxExposureBase: 2,
        minBandBase: 1,
      },
    };
    const wbtcStrkbtc: ManagedMakerRunnerStrategy = {
      ...baseStrategy,
      id: "managed-wbtc-strkbtc",
      pair: {
        pair_id: "WBTC/strkBTC",
        base_asset_id: "WBTC",
        quote_asset_id: "strkBTC",
        min_order_amount: "0.0001",
        enabled: true,
      },
      strategy: {
        ...baseStrategy.strategy,
        pair: "WBTC/strkBTC",
        side: "Both",
        maxEpochBase: 0.5,
        maxExposureBase: 0.5,
        minBandBase: 0.1,
      },
    };
    const submittedPairs: string[] = [];
    const submitPrivateOrder: MakerWalletRuntime["submitPrivateOrder"] = vi.fn(async (intent) => {
      submittedPairs.push(intent.pairId);
      return { strategy_id: `strategy-${intent.pairId}` };
    });
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: runtime({
        submitPrivateOrder,
        balances: [
          { asset: "ETH", available: "5000000000000000000", locked: "0" },
          { asset: "USDC", available: "5000000000", locked: "0" },
          { asset: "STRK", available: "10000000000000000000", locked: "0" },
          { asset: "WBTC", available: "200000000", locked: "0" },
          { asset: "strkBTC", available: "200000000", locked: "0" },
        ],
      }),
      marketData: pairMarketData({
        "ETH/USDC": 1000,
        "STRK/ETH": 0.0001,
        "WBTC/strkBTC": 1,
      }),
      strategies: [ethUsdc, strkEth, wbtcStrkbtc],
      currentBatch: async (strategyPair) => ({
        ...openBatch(),
        batch_id: `batch-${strategyPair.pair_id.toLowerCase().replace("/", "-")}-1`,
        pair_id: strategyPair.pair_id,
      }),
      now: () => 1_000,
    });

    const result = await runner.runOnce();
    expect(result.failed).toEqual([]);
    expect(result.submitted.map((entry) => entry.pair).sort()).toEqual([
      "ETH/USDC",
      "STRK/ETH",
      "WBTC/strkBTC",
    ]);
    expect(submittedPairs.sort()).toEqual([
      "ETH/USDC",
      "STRK/ETH",
      "WBTC/strkBTC",
      "WBTC/strkBTC",
    ]);
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

function pairMarketData(prices: Record<string, number>) {
  return new MarketDataEngine({
    sources: [
      {
        id: "a",
        observe: async (pairId) => ({ source: "a", pair: pairId, price: prices[pairId] ?? 1, observedAt: 1 }),
      },
      {
        id: "b",
        observe: async (pairId) => ({ source: "b", pair: pairId, price: (prices[pairId] ?? 1) * 1.0001, observedAt: 1 }),
      },
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
      { asset: "ETH", available: "5000000000000000000", locked: "0" },
      { asset: "USDC", available: "5000000000", locked: "0" },
    ],
    getOrders: () => overrides.orders ?? [],
    getPrivateStrategies: () => overrides.privateStrategies ?? [],
  };
}

function packageFixture(): OfflineRenewalPackage {
  return {
    version: 1,
    package_id: "pkg",
    package_commitment: "0xpkg",
    created_at_unix_ms: 1,
    pair: "ETH/USDC",
    start_epoch: 1,
    end_epoch: 2,
    slot_count: 1,
    relay_mode: "ZylithRelay",
    parent_cancel_authority: "0xparent",
    parent_cancel_marker: "0xcancel",
    relay_authorization: {
      signer_public_key: "0xparent",
      signature_r: "0xr",
      signature_s: "0xs",
    },
    relay_policy: {
      prover_url: "https://prover.example",
      coordinator_url: "https://coordinator.example",
      submission_safety_buffer_ms: 15_000,
      max_submission_delay_ms: 0,
    },
    slots: [],
  };
}
