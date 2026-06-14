import { describe, expect, it, vi } from "vitest";
import {
  MarketDataEngine,
  buildManagedCurvePlan,
  buildInventorySnapshot,
  configureAssetDecimals,
  type ManagedRiskPolicy,
  type ManagedStrategyConfig,
  type OfflineRenewalPackage,
  relayAuthorizationHeaders,
  ZylithMakerSdk,
  ZylithRelaySdk,
  ZylithTraderSdk,
  ZylithManagedMakerRunner,
  type ManagedMakerRunnerState,
} from "./index";

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
  bandCount: 2,
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
      points: [{ price: 1002, baseAmount: 1 }],
      relayMode: "ZylithRelay",
      durationHours: 1,
    })).rejects.toMatchObject({
      name: "MakerCurveSubmissionError",
      partial: true,
      strategyId: "strategy-1",
      offlinePackage: expect.objectContaining({ package_id: "pkg" }),
    });
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
