import { describe, expect, it, vi } from "vitest";
import { createMakerWalletRuntimeAdapter, MakerCurveSubmissionError, ZylithMakerSdk, type RawMakerOrderDraft } from "./maker";
import { ZylithRelaySdk, type OfflineRenewalPackage } from "./relay";
import { ZylithTraderSdk, type TraderWalletRuntime } from "./trader";
import { MarketDataEngine } from "@zylith/sdk/common";

describe("ZylithTraderSdk", () => {
  it("submits orders through the wallet runtime and polls settlement", async () => {
    let proofPolls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/batches/current")) {
        return jsonResponse({ batch_id: "batch-1", pair_id: "ETH/USDC", epoch_id: 1, close_time_unix_ms: 2, status: "Open", order_count_bucket: "0-7" });
      }
      if (url.includes("/proof-jobs/batch-1")) {
        proofPolls += 1;
        return jsonResponse({ batch_id: "batch-1", state: proofPolls > 1 ? "confirmed-onchain" : "proving", failure: null });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const wallet: TraderWalletRuntime = {
      submitPrivateOrder: vi.fn(async () => ({ order_commitment: "0xorder", batch_id: "batch-1" })),
    };
    const sdk = new ZylithTraderSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl,
    });
    await expect(sdk.currentBatch("ETH/USDC")).resolves.toMatchObject({ batch_id: "batch-1" });
    await expect(sdk.submitPrivateOrder(wallet, intent())).resolves.toMatchObject({ order_commitment: "0xorder" });
    await expect(sdk.waitForSettlement("batch-1", { intervalMs: 1, timeoutMs: 100 })).resolves.toMatchObject({ state: "confirmed-onchain" });
  });

  it("withdraws runner settlement outputs without selecting deposit notes", async () => {
    const submitHostedWithdrawal = vi.fn(async () => ({ transaction_hash: "0xwithdraw" }));
    const wallet: TraderWalletRuntime = {
      submitPrivateOrder: vi.fn(async () => ({ order_commitment: "0xorder" })),
      submitHostedWithdrawal,
      getWithdrawableNotes: () => [
        {
          note_commitment: "0xdeposit",
          source: "deposit",
          asset: "STRK",
          amount: "1",
          locked: false,
          spent: false,
          metadata_commitment: "0xmeta1",
        },
        {
          note_commitment: "0xlocked",
          source: "settlement_output",
          asset: "STRK",
          amount: "1",
          locked: true,
          spent: false,
          metadata_commitment: "0xmeta2",
          maker_attribution: { version: 1, pair_id: "ETH/USDC", order_commitment: "0xorder", funding_note_ref: "0xfund", side: "Sell", clearing_price: "1000", filled_base_amount: "1", bands: [] },
        },
        {
          note_commitment: "0xsettlement",
          source: "settlement_output",
          asset: "STRK",
          amount: "1",
          locked: false,
          spent: false,
          metadata_commitment: "0xmeta3",
          maker_attribution: { version: 1, pair_id: "ETH/USDC", order_commitment: "0xorder", funding_note_ref: "0xfund", side: "Sell", clearing_price: "1000", filled_base_amount: "1", bands: [] },
        },
      ],
    };
    const sdk = new ZylithTraderSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    await expect(sdk.withdrawSettlementOutput(wallet, { pair: "ETH/USDC", asset: "STRK" })).resolves.toMatchObject({
      transaction_hash: "0xwithdraw",
    });
    expect(submitHostedWithdrawal).toHaveBeenCalledWith({
      note_commitment: "0xsettlement",
      asset: "STRK",
    });
  });
});

describe("ZylithMakerSdk", () => {
  it("builds curves and registers managed relay packages", async () => {
    const relayFetch = vi.fn(async () => jsonResponse({
      package_id: "pkg",
      package_commitment: "0xpkg",
      pair: "ETH/USDC",
      start_epoch: 1,
      end_epoch: 2,
      slot_count: 1,
      relay_mode: "ZylithRelay",
      pending_slots: 1,
      submitted_slots: 0,
      failed_slots: 0,
      updated_at_unix_ms: 1,
    })) as unknown as typeof fetch;
    const relay = new ZylithRelaySdk({ relayUrl: "https://relay.example", fetchImpl: relayFetch });
    const sdk = new ZylithMakerSdk({ relay });
    const plan = sdk.buildCurves({
      pair: {
        pair_id: "ETH/USDC",
        base_asset_id: "ETH",
        quote_asset_id: "USDC",
        min_order_amount: "0.01",
        enabled: true,
      },
      balances: [
        { asset: "ETH", available: "5000000000000000000", locked: "0" },
        { asset: "USDC", available: "5000000000", locked: "0" },
      ],
      orders: [],
      marketObservations: [
        { pair: "ETH/USDC", source: "a", price: 1000, observedAt: 100 },
        { pair: "ETH/USDC", source: "b", price: 1001, observedAt: 100 },
      ],
      fairPricePolicy: { maxStalenessMs: 1000, maxDivergenceBps: 50, minSources: 2 },
      strategy: {
        pair: "ETH/USDC",
        side: "Ask",
        targetBaseRatio: 0.5,
        baseSpreadBps: 30,
        volatilityBps: 10,
        inventorySkewBps: 50,
        bandCount: 3,
        maxEpochBase: 3,
        minBandBase: 0.1,
        maxExposureBase: 3,
        relayMode: "ZylithRelay",
        durationHours: 24,
      },
      risk: {
        minSpreadBps: 10,
        maxSpreadBps: 200,
        maxPriceDeviationBps: 500,
        maxEpochBase: 5,
        maxInventoryImbalanceBps: 9000,
        allowBid: true,
        allowAsk: true,
      },
      now: 100,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const wallet = {
      submitPrivateOrder: vi.fn(async () => ({ offline_package: packageFixture(), strategy_id: "strategy-1" })),
      markPrivateStrategyRelayRegistered: vi.fn(async () => true),
    };
    const result = await sdk.submitCurve(wallet, plan.curves[0]);
    expect(result.relayStatus).toMatchObject({ package_id: "pkg" });
    expect(wallet.markPrivateStrategyRelayRegistered).toHaveBeenCalledWith("strategy-1");
  });

  it("marks relay registration outages as partial maker exposure", async () => {
    const relay = new ZylithRelaySdk({
      relayUrl: "https://relay.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: "relay unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    });
    const sdk = new ZylithMakerSdk({ relay });
    const wallet = {
      submitPrivateOrder: vi.fn(async () => ({ offline_package: packageFixture(), strategy_id: "strategy-1" })),
    };

    await expect(sdk.submitCurve(wallet, managedCurve())).rejects.toMatchObject({
      name: "MakerCurveSubmissionError",
      partial: true,
      strategyId: "strategy-1",
      offlinePackage: expect.objectContaining({ package_id: "pkg" }),
    } satisfies Partial<MakerCurveSubmissionError>);
  });

  it("builds managed curves from a market data engine", async () => {
    const sdk = new ZylithMakerSdk();
    const marketData = new MarketDataEngine({
      sources: [
        { id: "a", observe: async (pair) => ({ source: "a", pair, price: 1000, observedAt: 100 }) },
        { id: "b", observe: async (pair) => ({ source: "b", pair, price: 1001, observedAt: 100 }) },
      ],
      fairPricePolicy: { maxStalenessMs: 1000, maxDivergenceBps: 50, minSources: 2 },
      now: () => 100,
    });
    const plan = await sdk.buildCurvesFromMarketData({
      pair: {
        pair_id: "ETH/USDC",
        base_asset_id: "ETH",
        quote_asset_id: "USDC",
        min_order_amount: "0.01",
        enabled: true,
      },
      balances: [
        { asset: "ETH", available: "5000000000000000000", locked: "0" },
        { asset: "USDC", available: "5000000000", locked: "0" },
      ],
      orders: [],
      marketData,
      strategy: {
        pair: "ETH/USDC",
        side: "Ask",
        targetBaseRatio: 0.5,
        baseSpreadBps: 30,
        volatilityBps: 10,
        inventorySkewBps: 50,
        bandCount: 3,
        maxEpochBase: 3,
        minBandBase: 0.1,
        maxExposureBase: 3,
        relayMode: "ZylithRelay",
        durationHours: 24,
      },
      risk: {
        minSpreadBps: 10,
        maxSpreadBps: 200,
        maxPriceDeviationBps: 500,
        maxEpochBase: 5,
        maxInventoryImbalanceBps: 9000,
        allowBid: true,
        allowAsk: true,
      },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.fairPrice.price).toBe(1000.5);
    expect(plan.curves).toHaveLength(1);
  });

  it("normalizes raw wallet balances before compiling managed curve sizes", async () => {
    const sdk = new ZylithMakerSdk();
    const plan = sdk.buildCurves({
      pair: {
        pair_id: "ETH/USDC",
        base_asset_id: "ETH",
        quote_asset_id: "USDC",
        min_order_amount: "0.01",
        enabled: true,
      },
      balances: [
        { asset: "ETH", available: "2000000000000000000", locked: "0" },
        { asset: "USDC", available: "1000000000", locked: "0" },
      ],
      orders: [],
      marketObservations: [
        { pair: "ETH/USDC", source: "a", price: 1000, observedAt: 100 },
        { pair: "ETH/USDC", source: "b", price: 1000, observedAt: 100 },
      ],
      fairPricePolicy: { maxStalenessMs: 1000, maxDivergenceBps: 50, minSources: 2 },
      strategy: {
        pair: "ETH/USDC",
        side: "Both",
        targetBaseRatio: 0.5,
        baseSpreadBps: 30,
        volatilityBps: 10,
        inventorySkewBps: 50,
        bandCount: 3,
        maxEpochBase: 5,
        minBandBase: 0.1,
        maxExposureBase: 5,
        relayMode: "SelfRelay",
        durationHours: 1,
      },
      risk: {
        minSpreadBps: 10,
        maxSpreadBps: 200,
        maxPriceDeviationBps: 500,
        maxEpochBase: 5,
        maxInventoryImbalanceBps: 9000,
        allowBid: true,
        allowAsk: true,
      },
      now: 100,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.inventory.availableBase).toBe(2);
    expect(plan.inventory.availableQuote).toBe(1000);
    expect(plan.curves.find((curve) => curve.side === "Sell")?.maxBaseAmount).toBeLessThanOrEqual(2);
    expect(plan.curves.find((curve) => curve.side === "Buy")?.maxBaseAmount).toBeLessThanOrEqual(1);
  });

  it("adapts managed curve intents to the raw wallet runtime submission shape", async () => {
    const submitted: RawMakerOrderDraft[] = [];
    const rawRuntime = {
      submitPrivateOrder: vi.fn(async (draft: RawMakerOrderDraft) => {
        submitted.push(draft);
        return { strategy_id: "strategy-1" };
      }),
    };
    const adapter = createMakerWalletRuntimeAdapter({
      runtime: rawRuntime,
      pairForIntent: () => ({
        pair_id: "ETH/USDC",
        base_asset_id: "ETH",
        quote_asset_id: "USDC",
        min_order_amount: "0.01",
        enabled: true,
      }),
      currentBatch: async () => ({
        batch_id: "batch-1",
        pair_id: "ETH/USDC",
        epoch_id: 1,
        close_time_unix_ms: 60_000,
        status: "Open",
        order_count_bucket: "0-7",
      }),
      batchWindowMs: 90_000,
    });

    await expect(adapter.submitPrivateOrder({
      pairId: "ETH/USDC",
      side: "Buy",
      shape: "curve",
      stratKind: "Repeat",
      resting: true,
      amount: "1",
      limitPrice: "",
      minFill: "0",
      fillOrKill: false,
      curvePoints: [
        { price: "990", baseAmount: "0.33" },
        { price: "1000", baseAmount: "0.33" },
        { price: "1010", baseAmount: "0.34" },
      ],
      inventoryCap: "1",
      durationHours: "1",
      childSize: "1",
      priceLimit: "",
      jitter: 0,
      relayMode: "ZylithRelay",
      relayOperator: "ZylithRelay",
    })).resolves.toMatchObject({ strategy_id: "strategy-1" });

    expect(submitted).toEqual([expect.objectContaining({
      pair: "ETH/USDC",
      side: "Buy",
      mode: "Resting",
      amount: "1000000000000000000",
      limitPrice: "1010000000",
      minFill: "0",
      batchId: "batch-1",
      durationBatches: 40,
      childAmount: "1000000000000000000",
      makerInventoryCap: "1000000000000000000",
      offlineDelegation: true,
      relayMode: "ZylithRelay",
    })]);
    expect(submitted[0].makerCurvePoints).toEqual([
      { price: "990000000", baseAmount: "330000000000000000" },
      { price: "1000000000", baseAmount: "330000000000000000" },
      { price: "1010000000", baseAmount: "340000000000000000" },
    ]);
  });
});

function intent() {
  return {
    pairId: "ETH/USDC",
    side: "Buy" as const,
    shape: "limit" as const,
    stratKind: "TWAP" as const,
    resting: false,
    amount: "1",
    limitPrice: "1000",
    minFill: "0",
    fillOrKill: false,
    curvePoints: [],
    inventoryCap: "",
    durationHours: "",
    childSize: "",
    priceLimit: "",
    jitter: 0,
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

function managedCurve() {
  return {
    pair: "ETH/USDC",
    side: "Sell" as const,
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
    relayMode: "ZylithRelay" as const,
    durationHours: 1,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
