import { describe, expect, it, vi } from "vitest";
import { ZylithMakerSdk } from "./maker";
import { ZylithRelaySdk } from "./relay";
import { ZylithTraderSdk, type TraderWalletRuntime } from "./trader";
import type { OfflineRenewalPackage } from "../offlineRenewalOperator";

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
        { asset: "ETH", available: "5", locked: "0" },
        { asset: "USDC", available: "5000", locked: "0" },
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
