import { describe, expect, it, vi } from "vitest";
import {
  MarketDataEngine,
  buildManagedCurvePlan,
  buildInventorySnapshot,
  configureAssetDecimals,
  createPairScopedPriceSource,
  createRatioPriceSource,
  createStarknetOraclePriceSource,
  type ManagedRiskPolicy,
  type ManagedStrategyConfig,
  type OfflineRenewalPackage,
  relayAuthorizationHeaders,
  ZylithMakerSdk,
  ZylithRelaySdk,
  ZylithTraderSdk,
  ZylithManagedMakerRunner,
  type ManagedMakerRunnerState,
} from "./index.js";

const pair = {
  pair_id: "ETH/USDC",
  base_asset_id: "ETH",
  quote_asset_id: "USDC",
  min_order_amount: "0.01",
  enabled: true,
};

const strategy: ManagedStrategyConfig = {
  pair: "ETH/USDC",
  side: "Both",
  targetBaseRatio: 0.5,
  targetBaseRatioMin: 0.3,
  targetBaseRatioMax: 0.5,
  baseSpreadBps: 40,
  volatilityBps: 20,
  inventorySkewBps: 100,
  bandCount: 3,
  maxEpochBase: 2,
  minBandBase: 0.1,
  maxExposureBase: 2,
  relayMode: "SelfRelay",
  durationHours: 1,
};

const risk: ManagedRiskPolicy = {
  minSpreadBps: 10,
  maxSpreadBps: 300,
  maxPriceDeviationBps: 500,
  maxEpochBase: 3,
  maxInventoryImbalanceBps: 1_000,
  allowBid: true,
  allowAsk: true,
};

describe("@zylith/sdk common", () => {
  it("derives a pair price from independently timestamped asset feeds", async () => {
    const source = createRatioPriceSource({
      id: "pragma-eth-usdc",
      pair: "ETH/USDC",
      numerator: {
        id: "pragma-eth-usd",
        observe: async () => ({ source: "pragma-eth-usd", pair: "ETH/USD", price: 2500, observedAt: 9_000 }),
      },
      denominator: {
        id: "pragma-usdc-usd",
        observe: async () => ({ source: "pragma-usdc-usd", pair: "USDC/USD", price: 1.001, observedAt: 8_000 }),
      },
    });

    await expect(source.observe("ETH/USDC")).resolves.toMatchObject({
      source: "pragma-eth-usdc",
      pair: "ETH/USDC",
      price: 2500 / 1.001,
      observedAt: 8_000,
    });
    await expect(source.observe("STRK/USDC")).resolves.toBeNull();
  });

  it("rejects stale-quality oracle responses with too few publishers", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: ["0x5f5e100", "0x8", "0x64", "0x1", "0x0", "0x0"],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const source = createStarknetOraclePriceSource({
      id: "pragma",
      rpcUrl: "https://rpc.example",
      contractAddress: "0xoracle",
      entrypoint: "0xselector",
      calldata: ["0x0", "0xpair"],
      decimalsIndex: 1,
      timestampIndex: 2,
      sourceCountIndex: 3,
      minSourceCount: 2,
      fetchImpl,
    });

    await expect(source.observe("ETH/USDC")).resolves.toBeNull();
  });

  it("does not query pair-scoped sources for unrelated markets", async () => {
    const observe = vi.fn(async (pairId: string) => ({
      source: "coinbase",
      pair: pairId,
      price: 2500,
      observedAt: 1,
    }));
    const source = createPairScopedPriceSource({ id: "coinbase", observe }, ["ETH/USDC"]);

    await expect(source.observe("STRK/USDC")).resolves.toBeNull();
    expect(observe).not.toHaveBeenCalled();
  });

  it("keeps only the imbalance-reducing side for base-heavy inventory", () => {
    const fairPrice = { ok: true as const, pair: "ETH/USDC", price: 1000, observedAt: 1, sources: ["oracle"], maxDivergenceBps: 0 };
    const inventory = buildInventorySnapshot(pair, [
      { asset: "ETH", available: "10", locked: "0" },
      { asset: "USDC", available: "100", locked: "0" },
    ], [], 1000);
    const plan = buildManagedCurvePlan({ pair, fairPrice, inventory, config: strategy, risk });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.clipped).toContain("bid-disabled-by-inventory");
    expect(plan.curves.map((curve) => curve.side)).toEqual(["Sell"]);
  });

  it("uses protocol pair-specific maker curve spread and band minimums", () => {
    const stablePair = {
      pair_id: "USDC/USDT",
      base_asset_id: "USDC",
      quote_asset_id: "USDT",
      min_order_amount: "1",
      enabled: true,
    };
    const fairPrice = { ok: true as const, pair: "USDC/USDT", price: 1, observedAt: 1, sources: ["oracle"], maxDivergenceBps: 0 };
    const inventory = buildInventorySnapshot(stablePair, [
      { asset: "USDC", available: "100", locked: "0" },
      { asset: "USDT", available: "100", locked: "0" },
    ], [], 1);
    const stableStrategy: ManagedStrategyConfig = {
      ...strategy,
      pair: "USDC/USDT",
      side: "Both",
      baseSpreadBps: 6,
      volatilityBps: 0,
      minBandBase: 0,
      maxEpochBase: 3,
      maxExposureBase: 3,
    };
    const stableRisk: ManagedRiskPolicy = { ...risk, minSpreadBps: 0, maxSpreadBps: 100 };

    expect(buildManagedCurvePlan({
      pair: stablePair,
      fairPrice,
      inventory,
      config: stableStrategy,
      risk: stableRisk,
    }).ok).toBe(true);

    expect(buildManagedCurvePlan({
      pair: stablePair,
      fairPrice,
      inventory,
      config: { ...stableStrategy, baseSpreadBps: 4 },
      risk: stableRisk,
    })).toMatchObject({ ok: false, reason: "maker curve spread is below protocol minimum" });
  });
});

describe("@zylith/sdk trader", () => {
  it("selects settlement outputs for withdrawal", async () => {
    const submitHostedWithdrawal = vi.fn(async () => ({ transaction_hash: "0xwithdraw" }));
    const sdk = new ZylithTraderSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(sdk.withdrawSettlementOutput({
      submitPrivateOrder: vi.fn(async () => ({})),
      submitHostedWithdrawal,
      getWithdrawableNotes: () => [
        { note_commitment: "0xdeposit", source: "deposit", asset: "STRK", amount: "1", locked: false, spent: false, metadata_commitment: "0x1" },
        { note_commitment: "0xsettlement", source: "settlement_output", asset: "STRK", amount: "1", locked: false, spent: false, metadata_commitment: "0x2" },
      ],
    })).resolves.toMatchObject({ transaction_hash: "0xwithdraw" });
    expect(submitHostedWithdrawal).toHaveBeenCalledWith({ note_commitment: "0xsettlement", asset: "STRK" });
  });
});

describe("@zylith/sdk relay", () => {
  it("builds package auth headers", () => {
    expect(relayAuthorizationHeaders(packageFixture())).toMatchObject({
      "x-zylith-relay-package-commitment": "0xpkg",
      "x-zylith-relay-parent-cancel-authority": "0xparent",
      "x-zylith-relay-signer": "0xparent",
    });
  });
});

describe("@zylith/sdk maker", () => {
  it("builds managed curves from market data and submits once per epoch", async () => {
    configureAssetDecimals({
      ETH: { decimals: 18 },
      USDC: { decimals: 6 },
    });
    const saved: { state: ManagedMakerRunnerState | null } = { state: null };
    const submitted: string[] = [];
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: {
        submitPrivateOrder: vi.fn(async (intent) => {
          submitted.push(intent.side);
          return { strategy_id: "strategy-1" };
        }),
        getBalances: () => [
          { asset: "ETH", available: "5000000000000000000", locked: "0" },
          { asset: "USDC", available: "5000000000", locked: "0" },
        ],
        getOrders: () => [],
      },
      marketData: new MarketDataEngine({
        sources: [
          { id: "a", observe: async (pairId) => ({ source: "a", pair: pairId, price: 1000, observedAt: 1 }) },
          { id: "b", observe: async (pairId) => ({ source: "b", pair: pairId, price: 1001, observedAt: 1 }) },
        ],
        fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 2 },
        now: () => 1,
      }),
      strategies: [{ id: "managed", pair, strategy, risk }],
      currentBatch: async () => ({ batch_id: "batch-1", pair_id: "ETH/USDC", epoch_id: 1, close_time_unix_ms: 60_000, status: "Open", order_count_bucket: "0-7" }),
      store: {
        loadState: () => saved.state,
        saveState: (state) => { saved.state = state; },
      },
      now: () => 1_000,
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      submitted: [expect.objectContaining({ batchId: "batch-1", curveCount: 2 })],
    });
    await expect(runner.runOnce()).resolves.toMatchObject({
      submitted: [],
      skipped: [expect.objectContaining({ reason: "epoch already submitted" })],
    });
    expect(submitted).toEqual(["Buy", "Sell"]);
    expect(runner.telemetrySnapshot()).toMatchObject({ submitted: 1, skipped: 1, failed: 0 });
  });

  it("does not submit funded strategies without quote-only authorization", async () => {
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: {
        getBalances: () => [
          { asset: "ETH", available: "5000000000000000000", locked: "0" },
          { asset: "USDC", available: "5000000000", locked: "0" },
        ],
        getOrders: () => [],
      },
      marketData: marketDataFixture(),
      strategies: [{ id: "managed", pair, strategy, risk }],
      currentBatch: async () => batchFixture(),
      now: () => 1_000,
      requireQuoteOnlyAuthorization: true,
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      submitted: [],
      skipped: [expect.objectContaining({ reason: "missing managed maker quote-only authorization" })],
    });
  });

  it("does not fall back to unrestricted wallet submission when a managed policy is configured", async () => {
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: {
        getBalances: () => [
          { asset: "ETH", available: "5000000000000000000", locked: "0" },
          { asset: "USDC", available: "5000000000", locked: "0" },
        ],
        getOrders: () => [],
      },
      marketData: marketDataFixture(),
      strategies: [{ id: "managed", pair, strategy, risk, managedMakerAuthorization: managedAuthorizationFixture() }],
      currentBatch: async () => batchFixture(),
      now: () => 1_000,
      requireQuoteOnlyAuthorization: true,
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      submitted: [],
      skipped: [expect.objectContaining({ reason: "runtime cannot submit delegated managed maker orders" })],
    });
  });

  it("uses delegated submission for policy-backed managed maker curves", async () => {
    const submitDelegatedPrivateOrder = vi.fn(async () => ({ strategy_id: "strategy-1" }));
    const auth = managedAuthorizationFixture();
    const runner = new ZylithManagedMakerRunner({
      sdk: new ZylithMakerSdk(),
      runtime: {
        submitDelegatedPrivateOrder,
        getBalances: () => [
          { asset: "ETH", available: "5000000000000000000", locked: "0" },
          { asset: "USDC", available: "5000000000", locked: "0" },
        ],
        getOrders: () => [],
      },
      marketData: marketDataFixture(),
      strategies: [{ id: "managed", pair, strategy, risk, managedMakerAuthorization: auth }],
      currentBatch: async () => batchFixture(),
      now: () => 1_000,
      requireQuoteOnlyAuthorization: true,
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      submitted: [expect.objectContaining({ batchId: "batch-1", curveCount: 2 })],
    });
    expect(submitDelegatedPrivateOrder).toHaveBeenCalledTimes(2);
    expect(submitDelegatedPrivateOrder.mock.calls[0]?.[1]).toEqual(auth);
  });

  it("marks relay outages after package creation as partial exposure", async () => {
    const relay = new ZylithRelaySdk({
      relayUrl: "https://relay.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: "relay unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    });
    const sdk = new ZylithMakerSdk({ relay });
    await expect(sdk.submitCurve({
      submitPrivateOrder: vi.fn(async () => ({ strategy_id: "strategy-1", offline_package: packageFixture() })),
    }, {
      pair: "ETH/USDC",
      side: "Sell",
      fairPrice: 1000,
      reservationPrice: 1000,
      spreadBps: 40,
      inventorySkewBps: 0,
      maxBaseAmount: 1,
      points: [
        { price: 1002, baseAmount: 0.33 },
        { price: 1005, baseAmount: 0.33 },
        { price: 1008, baseAmount: 0.34 },
      ],
      relayMode: "ZylithRelay",
      durationHours: 1,
    })).rejects.toMatchObject({
      name: "MakerCurveSubmissionError",
      partial: true,
      strategyId: "strategy-1",
      offlinePackage: expect.objectContaining({ package_id: "pkg" }),
    });
  });

  it("rejects direct invalid maker curves before wallet or relay submission", async () => {
    const submitPrivateOrder = vi.fn(async () => ({ strategy_id: "should-not-submit" }));
    const sdk = new ZylithMakerSdk();
    await expect(sdk.submitCurve({ submitPrivateOrder }, {
      pair: "ETH/USDC",
      side: "Buy",
      fairPrice: 1000,
      reservationPrice: 1000,
      spreadBps: 0,
      inventorySkewBps: 0,
      maxBaseAmount: 1,
      points: [{ price: 1000, baseAmount: 1 }],
      relayMode: "SelfRelay",
      durationHours: 1,
    })).rejects.toThrow(/at least 3 bands/);
    expect(submitPrivateOrder).not.toHaveBeenCalled();
  });
});

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

function batchFixture() {
  return {
    batch_id: "batch-1",
    pair_id: "ETH/USDC",
    epoch_id: 1,
    close_time_unix_ms: 60_000,
    status: "Open" as const,
    order_count_bucket: "0-7",
  };
}

function marketDataFixture() {
  return new MarketDataEngine({
    sources: [
      { id: "a", observe: async (pairId) => ({ source: "a", pair: pairId, price: 1000, observedAt: 1 }) },
      { id: "b", observe: async (pairId) => ({ source: "b", pair: pairId, price: 1001, observedAt: 1 }) },
    ],
    fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 2 },
    now: () => 1,
  });
}

function managedAuthorizationFixture() {
  return {
    policy: {
      version: 1,
      delegate_public_key: "0x123",
      pair_id: "ETH/USDC",
      allow_buy: true,
      allow_sell: true,
      max_epoch_base: "2000000000000000000",
      min_price: "900000000",
      max_price: "1100000000",
      valid_from_epoch: "1",
      valid_until_epoch: "5",
      relay_mode: "SelfRelay" as const,
      parent_order_commitment: "0x0",
      recipient_owner_public_key: "0xabc",
      recipient_spend_authority: "0xdef",
      recipient_withdraw_authority: "0x456",
      recipient_residual_withdraw_authority: "0x456",
      auditor_view_allowed: false,
      policy_nonce: "1",
    },
    owner_authorization: {
      signature_r: "0x1",
      signature_s: "0x2",
    },
  };
}
