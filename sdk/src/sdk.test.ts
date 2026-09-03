import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInventorySnapshot,
  configureAssetDecimals,
  createHttpJsonPriceSource,
  createPairScopedPriceSource,
  createRatioPriceSource,
  createStarknetOraclePriceSource,
  normalizeSdkServiceUrl,
  readSdkJsonResponse,
  readSdkResponseText,
  sanitizeSdkErrorMessage,
  selectFairPrice,
  MarketDataEngine,
} from "./common.js";
import {
  buildPrivateLiquidityPositionCloseAuthorizationRequest,
  buildPrivateLiquidityPositionOpenAuthorizationRequest,
  buildPrivateLiquidityPositionPlan,
  buildPrivateLiquidityPositionReconfigureAuthorizationRequest,
} from "./liquidity.js";
import {
  relayAccessHeaders,
  ZylithSdk,
} from "./index.js";
import { type OfflineRenewalPackage, ZylithRelaySdk } from "./relay.js";

const pair = {
  pair_id: "ETH/USDC",
  base_asset_id: "ETH",
  quote_asset_id: "USDC",
  min_order_amount: "0.01",
  enabled: true,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("private liquidity positions", () => {
  it("compiles an Ekubo-style two-sided range into a private position open request", () => {
    const plan = buildPrivateLiquidityPositionPlan({
      pair,
      baseAmount: "2",
      quoteAmount: "5000",
      currentPrice: "2500",
      minPrice: "2250",
      maxPrice: "2750",
      bandCount: 5,
      durationHours: 24,
      rotationBps: 75,
    });

    expect(plan.position).toMatchObject({
      pairId: "ETH/USDC",
      backing: "PrivateReserve",
      privacyMode: "RotatingPrivate",
      status: "Opening",
      bandCount: 5,
      durationHours: 24,
      rotationBps: 75,
    });
    expect(plan.bidCurve?.side).toBe("Buy");
    expect(plan.askCurve?.side).toBe("Sell");
    expect(plan.openPosition).toMatchObject({
      kind: "OpenPrivateLiquidityPosition",
      pairId: "ETH/USDC",
      baseReserveAtomic: "2000000000000000000",
      quoteReserveAtomic: "5000000000",
      priceLowerBoundAtomic: "2250000000",
      priceUpperBoundAtomic: "2750000000",
      maxFillBasePerBatchAtomic: "2108607670163778351",
      durationHours: 24,
      privacyMode: "RotatingPrivate",
    });
    expect(plan.openPosition.curvePolicy).toMatchObject({
      kind: "StaticRange",
      bandCount: 5,
      spreadBps: 8,
    });
    expect(plan.bidCurve?.points).toHaveLength(5);
    expect(plan.askCurve?.points).toHaveLength(5);
    expect(plan.metrics.capitalEfficiency).toBeGreaterThan(1);
  });

  it("caps per-batch base exposure before compiling curve intents", () => {
    const plan = buildPrivateLiquidityPositionPlan({
      pair,
      baseAmount: "10",
      quoteAmount: "0",
      currentPrice: "2500",
      minPrice: "2400",
      maxPrice: "2600",
      spreadBps: 10,
      maxFillBasePerBatch: "1.5",
      bandCount: 3,
    });

    expect(plan.openPosition.maxFillBasePerBatchAtomic).toBe("1500000000000000000");
    expect(plan.askCurve?.totalBaseAmount).toBe("1.5");
    expect(Number(plan.askCurve?.points[0]?.baseAmount ?? "0")).toBeCloseTo(0.5);
  });

  it("preserves base-asset atomic precision when splitting curve bands", () => {
    const plan = buildPrivateLiquidityPositionPlan({
      pair,
      baseAmount: "0.000000000000000003",
      quoteAmount: "0",
      currentPrice: "2500",
      minPrice: "2400",
      maxPrice: "2600",
      spreadBps: 10,
      bandCount: 3,
    });

    expect(plan.askCurve?.totalBaseAmount).toBe("0.000000000000000003");
    expect(plan.askCurve?.points.map((point) => point.baseAmount)).toEqual([
      "0.000000000000000001",
      "0.000000000000000001",
      "0.000000000000000001",
    ]);
  });

  it("expresses oracle-skewed private LP policy parameters", () => {
    const plan = buildPrivateLiquidityPositionPlan({
      pair,
      baseAmount: "3",
      quoteAmount: "4000",
      currentPrice: "2500",
      minPrice: "2250",
      maxPrice: "2750",
      spreadBps: 15,
      targetBaseRatioBps: 4500,
      inventorySkewBps: 120,
      maxPriceDeviationBps: 300,
      policyKind: "InventorySkewed",
      oracleId: "pragma:ETH/USD",
      maxOracleStalenessMs: 30_000,
      maxOracleDivergenceBps: 75,
    });

    expect(plan.position).toMatchObject({
      policyKind: "InventorySkewed",
      spreadBps: 15,
      targetBaseRatioBps: 4500,
      inventorySkewBps: 120,
      maxPriceDeviationBps: 300,
      oracleGuard: {
        oracleId: "pragma:ETH/USD",
        maxStalenessMs: 30_000,
        maxDivergenceBps: 75,
      },
    });
    expect(plan.openPosition.curvePolicy).toMatchObject({
      kind: "InventorySkewed",
      spreadBps: 15,
      targetBaseRatioBps: 4500,
      inventorySkewBps: 120,
      maxPriceDeviationBps: 300,
    });
    expect(plan.openPosition.oracleGuard).toEqual(plan.position.oracleGuard);
  });

  it("projects LP rewards from edge, protocol-funded rebate, and daily turnover", () => {
    const plan = buildPrivateLiquidityPositionPlan({
      pair: { ...pair, taker_fee_bps: 4 },
      baseAmount: "20",
      quoteAmount: "50000",
      currentPrice: "2500",
      minPrice: "2300",
      maxPrice: "2700",
      minEdgeBps: 3,
      targetAprPct: 15,
      expectedDailyVolume: "100000",
    });

    expect(plan.openPosition.curvePolicy.spreadBps).toBe(6);
    expect(plan.metrics.quoteValue).toBe(100000);
    expect(plan.metrics.rewards).toMatchObject({
      protocolFeeBps: 4,
      maxRebateBps: 1.5,
      estimatedEdgeBps: 3,
      estimatedRebateBps: 1.5,
      netLpEdgeBps: 4.5,
      expectedDailyVolume: 100000,
      expectedDailyTurnover: 1,
      projectedAprPct: 16.425,
      targetAprPct: 15,
      requiredDailyTurnover: 0.9132,
      requiredDailyVolume: 91324.2009,
    });
  });

  it("uses inventory skew to derive the effective reference used for LP bands", () => {
    const plan = buildPrivateLiquidityPositionPlan({
      pair,
      baseAmount: "20",
      quoteAmount: "0",
      currentPrice: "2500",
      minPrice: "2300",
      maxPrice: "2700",
      minEdgeBps: 3,
      policyKind: "InventorySkewed",
      targetBaseRatioBps: 5000,
      inventorySkewBps: 100,
      maxPriceDeviationBps: 500,
    });

    expect(plan.metrics.effectiveReferencePrice).toBe(2487.5);
    expect(plan.openPosition.curvePolicy).toMatchObject({
      kind: "InventorySkewed",
      targetBaseRatioBps: 5000,
      inventorySkewBps: 100,
      maxPriceDeviationBps: 500,
    });
    expect(plan.bidCurve).toBeUndefined();
    expect(plan.askCurve?.points[0]?.price).toBe("2488.24625");
  });

  it("uses tighter rebate bands for stable and conversion positions", () => {
    const stablePair = {
      pair_id: "USDC/USDT",
      base_asset_id: "USDC",
      quote_asset_id: "USDT",
      min_order_amount: "1",
      enabled: true,
      taker_fee_bps: 1,
    };
    const plan = buildPrivateLiquidityPositionPlan({
      pair: stablePair,
      baseAmount: "50000",
      quoteAmount: "50000",
      currentPrice: "1",
      minPrice: "0.999",
      maxPrice: "1.001",
      minEdgeBps: 0.6,
      targetAprPct: 8,
      expectedDailyVolume: "500000",
    });

    expect(plan.openPosition.curvePolicy.spreadBps).toBe(1);
    expect(plan.metrics.rewards).toMatchObject({
      protocolFeeBps: 1,
      maxRebateBps: 0.4,
      fullRebateEdgeBps: 0.4,
      zeroRebateEdgeBps: 1.2,
      estimatedEdgeBps: 0.6,
      estimatedRebateBps: 0.3,
      netLpEdgeBps: 0.9,
      expectedDailyTurnover: 5,
      projectedAprPct: 16.425,
      requiredDailyTurnover: 2.4353,
      requiredDailyVolume: 243531.2024,
    });
  });

  it("builds wallet authorization requests for the private LP lifecycle", () => {
    expect(buildPrivateLiquidityPositionOpenAuthorizationRequest({
      seedHex: "11".repeat(32),
      positionId: "0x123",
      outputPositionCommitment: "0xabc",
      epoch: 7n,
    })).toEqual({
      seed_hex: "11".repeat(32),
      position_id: "0x123",
      prior_position_commitment: undefined,
      output_position_commitment: "0xabc",
      epoch: "7",
      base_amount: "0",
      quote_amount: "0",
    });

    expect(buildPrivateLiquidityPositionReconfigureAuthorizationRequest({
      seedHex: "11".repeat(32),
      positionId: "0x123",
      priorPositionCommitment: "0xaaa",
      outputPositionCommitment: "0xbbb",
      epoch: "8",
    })).toMatchObject({
      prior_position_commitment: "0xaaa",
      output_position_commitment: "0xbbb",
      epoch: "8",
      base_amount: "0",
      quote_amount: "0",
    });

    expect(buildPrivateLiquidityPositionCloseAuthorizationRequest({
      seedHex: "11".repeat(32),
      positionId: "0x123",
      priorPositionCommitment: "0xaaa",
      epoch: 10,
      baseAmountAtomic: 1_000,
      quoteAmountAtomic: 2_000,
    })).toMatchObject({
      prior_position_commitment: "0xaaa",
      output_position_commitment: undefined,
      epoch: "10",
      base_amount: "1000",
      quote_amount: "2000",
    });

  });

  it("surfaces privacy warnings for static positions", () => {
    const plan = buildPrivateLiquidityPositionPlan({
      pair,
      baseAmount: "0",
      quoteAmount: "1000",
      currentPrice: "2500",
      minPrice: "2000",
      maxPrice: "3000",
      spreadBps: 20,
      privacyMode: "StaticPrivate",
    });

    expect(plan.warnings.join(" ")).toMatch(/fingerprinting/i);
  });
});

describe("@zylith/sdk common", () => {
  it("rejects invalid market data policies before querying sources", () => {
    const source = { id: "source", observe: async () => null };
    expect(() => new MarketDataEngine({
      sources: [],
      fairPricePolicy: { maxStalenessMs: 1, maxDivergenceBps: 1, minSources: 1 },
    })).toThrow(/at least one source/);
    expect(() => new MarketDataEngine({
      sources: [source],
      fairPricePolicy: { maxStalenessMs: 0, maxDivergenceBps: 1, minSources: 1 },
    })).toThrow(/max staleness/);
    expect(() => new MarketDataEngine({
      sources: [source],
      fairPricePolicy: { maxStalenessMs: 1, maxDivergenceBps: -1, minSources: 1 },
    })).toThrow(/max divergence/);
    expect(() => new MarketDataEngine({
      sources: [source],
      fairPricePolicy: { maxStalenessMs: 1, maxDivergenceBps: 1, minSources: 0 },
    })).toThrow(/minimum source count/);
    expect(() => new MarketDataEngine({
      sources: [source, { ...source, id: "SOURCE" }],
      fairPricePolicy: { maxStalenessMs: 1, maxDivergenceBps: 1, minSources: 1 },
    })).toThrow(/Duplicate market data source id/);
    expect(() => new MarketDataEngine({
      sources: [source],
      fairPricePolicy: { maxStalenessMs: 1, maxDivergenceBps: 1, minSources: 2 },
    })).toThrow(/minimum source count exceeds configured sources/);
    expect(() => new MarketDataEngine({
      sources: [{ id: "broken" } as never],
      fairPricePolicy: { maxStalenessMs: 1, maxDivergenceBps: 1, minSources: 1 },
    })).toThrow(/source is invalid/);
  });

  it("rejects custom market observations with a mismatched source identity", async () => {
    const marketData = new MarketDataEngine({
      sources: [{
        id: "source-a",
        observe: async (pairId) => ({ source: "source-b", pair: pairId, price: 1, observedAt: 1 }),
      }],
      fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 1 },
      now: () => 1,
    });

    await expect(marketData.fairPrice("ETH/USDC")).rejects.toThrow(/mismatched source id/);
  });

  it("propagates caller cancellation instead of converting it to a missing market price", async () => {
    const controller = new AbortController();
    const marketData = new MarketDataEngine({
      sources: [{
        id: "source",
        observe: async (_pairId, options) => new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        }),
      }],
      fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 1 },
    });

    const attempt = marketData.fairPrice("ETH/USDC", { signal: controller.signal });
    controller.abort();
    await expect(attempt).rejects.toThrow(/aborted/i);
  });

  it("aborts custom market sources that ignore caller cancellation", async () => {
    const controller = new AbortController();
    const marketData = new MarketDataEngine({
      sources: [{
        id: "source",
        observe: async () => new Promise<never>(() => undefined),
      }],
      fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 1 },
    });

    const attempt = marketData.fairPrice("ETH/USDC", { signal: controller.signal });
    controller.abort();
    await expect(attempt).rejects.toThrow("Zylith SDK market data request aborted");
  });

  it("rejects public cleartext service URLs while allowing local development URLs", () => {
    expect(normalizeSdkServiceUrl("https://api.zylith.fi/prover/", "proverUrl")).toBe("https://api.zylith.fi/prover");
    expect(normalizeSdkServiceUrl("http://localhost:3000/prover/", "proverUrl")).toBe("http://localhost:3000/prover");
    expect(normalizeSdkServiceUrl("http://127.0.0.1:3000/prover", "proverUrl")).toBe("http://127.0.0.1:3000/prover");
    expect(() => normalizeSdkServiceUrl("http://35.192.48.142:8080", "proverUrl")).toThrow(/must use HTTPS/);
    expect(() => normalizeSdkServiceUrl("not-a-url", "proverUrl")).toThrow(/absolute URL/);
  });

  it("redacts sensitive payload material from SDK error messages", () => {
    const message = sanitizeSdkErrorMessage(
      'relay rejected calldata {"calldata":["0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"],"signature":["0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"],"private_note":"secret material","decimal":"1234567890123456789012345678901234567890"}'
    );

    expect(message).toContain("relay rejected calldata");
    expect(message).toContain('"calldata":[...]');
    expect(message).toContain('"signature":[...]');
    expect(message).toContain('"private":"<redacted>"');
    expect(message).toContain("<number>");
    expect(message).not.toContain("1234567890abcdef");
    expect(message).not.toContain("secret material");
  });

  it("rejects oversized service responses before parsing them", async () => {
    const response = new Response(JSON.stringify({ value: "x".repeat(64) }), {
      headers: { "content-type": "application/json" },
    });

    await expect(readSdkJsonResponse(response, {
      maxBytes: 16,
      label: "Test response",
    })).rejects.toThrow(/response limit/);
  });

  it("times out a service response whose body never completes", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    }));

    await expect(readSdkResponseText(response, {
      timeoutMs: 10,
      label: "Stalled response",
    })).rejects.toThrow(/body timed out/);
  });

  it("rejects public cleartext URLs in trader, relay, and market data clients", async () => {
    expect(() => new ZylithSdk({
      coordinatorUrl: "http://35.192.48.142:8080",
      proverUrl: "https://api.zylith.fi/prover",
    })).toThrow(/coordinatorUrl must use HTTPS/);
    expect(() => new ZylithSdk({ relayUrl: "http://35.192.48.142:8080" })).toThrow(/relayUrl must use HTTPS/);

    const market = createHttpJsonPriceSource({
      id: "bad-price",
      url: "http://35.192.48.142:8080/price",
      pricePath: "$.price",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(market.observe("ETH/USDC")).rejects.toThrow(/market data source bad-price must use HTTPS/);

    expect(() => createStarknetOraclePriceSource({
      id: "bad-oracle",
      rpcUrl: "http://35.192.48.142:9545",
      contractAddress: "0xoracle",
      entrypoint: "0xselector",
      calldata: [],
      priceScale: 1,
    })).toThrow(/oracle source bad-oracle RPC URL must use HTTPS/);
  });

  it("derives a pair price from independently timestamped asset feeds", async () => {
    const observedPairs: string[] = [];
    const source = createRatioPriceSource({
      id: "pragma-eth-usdc",
      pair: "ETH/USDC",
      numeratorPair: "ETH/USD",
      denominatorPair: "USDC/USD",
      numerator: {
        id: "pragma-eth-usd",
        observe: async (pairId) => {
          observedPairs.push(pairId);
          return { source: "pragma-eth-usd", pair: pairId, price: 2500, observedAt: 9_000 };
        },
      },
      denominator: {
        id: "pragma-usdc-usd",
        observe: async (pairId) => {
          observedPairs.push(pairId);
          return { source: "pragma-usdc-usd", pair: pairId, price: 1.001, observedAt: 8_000 };
        },
      },
    });

    await expect(source.observe("ETH/USDC")).resolves.toMatchObject({
      source: "pragma-eth-usdc",
      pair: "ETH/USDC",
      price: 2500 / 1.001,
      observedAt: 8_000,
    });
    expect(observedPairs).toEqual(["ETH/USD", "USDC/USD"]);
    await expect(source.observe("STRK/USDC")).resolves.toBeNull();
  });

  it("treats transient market-source failures as unavailable observations", async () => {
    const source = createHttpJsonPriceSource({
      id: "coinbase",
      url: "https://prices.example/eth-usdc",
      pricePath: "$.price",
      fetchImpl: vi.fn(async () => {
        throw new Error("Signal is aborted without reason");
      }) as unknown as typeof fetch,
    });

    await expect(source.observe("ETH/USDC")).resolves.toBeNull();
  });

  it("treats transient market-source HTTP failures as unavailable observations", async () => {
    const marketData = new MarketDataEngine({
      sources: [
        createHttpJsonPriceSource({
          id: "coinbase",
          url: "https://prices.example/eth-usdc",
          pricePath: "$.price",
          fetchImpl: vi.fn(async () => new Response("temporarily unavailable", { status: 503 })) as unknown as typeof fetch,
        }),
        { id: "a", observe: async (pairId) => ({ source: "a", pair: pairId, price: 1000, observedAt: 1 }) },
        { id: "b", observe: async (pairId) => ({ source: "b", pair: pairId, price: 1001, observedAt: 1 }) },
      ],
      fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 2 },
      now: () => 1,
    });

    await expect(marketData.fairPrice("ETH/USDC")).resolves.toMatchObject({
      ok: true,
      price: 1000.5,
      sources: ["a", "b"],
    });
  });

  it("treats transient custom market-source failures as unavailable observations", async () => {
    const marketData = new MarketDataEngine({
      sources: [
        {
          id: "custom-abort",
          observe: async () => {
            throw new DOMException("aborted", "AbortError");
          },
        },
        { id: "a", observe: async (pairId) => ({ source: "a", pair: pairId, price: 1000, observedAt: 1 }) },
        { id: "b", observe: async (pairId) => ({ source: "b", pair: pairId, price: 1001, observedAt: 1 }) },
      ],
      fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 2 },
      now: () => 1,
    });

    await expect(marketData.fairPrice("ETH/USDC")).resolves.toMatchObject({
      ok: true,
      price: 1000.5,
      sources: ["a", "b"],
    });
  });

  it("surfaces market source configuration errors instead of treating them as no-price", async () => {
    const marketData = new MarketDataEngine({
      sources: [createHttpJsonPriceSource({
        id: "bad-price",
        url: "http://35.192.48.142:8080/price",
        pricePath: "$.price",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      })],
      fairPricePolicy: { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 1 },
      now: () => 1,
    });

    await expect(marketData.fairPrice("ETH/USDC")).rejects.toThrow(/market data source bad-price must use HTTPS/);
  });

  it("treats stalled market-source fetches as unavailable observations", async () => {
    vi.useFakeTimers();
    const source = createHttpJsonPriceSource({
      id: "coinbase",
      url: "https://prices.example/eth-usdc",
      pricePath: "$.price",
      fetchImpl: vi.fn(() => new Promise(() => undefined)) as unknown as typeof fetch,
    });

    const attempt = source.observe("ETH/USDC");
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(attempt).resolves.toBeNull();
  });

  it("does not throw when one ratio source is transiently unavailable", async () => {
    const source = createRatioPriceSource({
      id: "eth-usdc",
      pair: "ETH/USDC",
      numeratorPair: "ETH/USD",
      denominatorPair: "USDC/USD",
      numerator: {
        id: "eth-usd",
        observe: async () => {
          throw new Error("failed to fetch");
        },
      },
      denominator: {
        id: "usdc-usd",
        observe: async () => ({ source: "usdc-usd", pair: "USDC/USD", price: 1, observedAt: 1 }),
      },
    });

    await expect(source.observe("ETH/USDC")).resolves.toBeNull();
  });

  it("does not mask non-transient ratio source configuration errors", async () => {
    const source = createRatioPriceSource({
      id: "eth-usdc",
      pair: "ETH/USDC",
      numeratorPair: "ETH/USD",
      denominatorPair: "USDC/USD",
      numerator: createHttpJsonPriceSource({
        id: "bad-price",
        url: "http://35.192.48.142:8080/price",
        pricePath: "$.price",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
      denominator: {
        id: "usdc-usd",
        observe: async () => ({ source: "usdc-usd", pair: "USDC/USD", price: 1, observedAt: 1 }),
      },
    });

    await expect(source.observe("ETH/USDC")).rejects.toThrow(/market data source bad-price must use HTTPS/);
  });

  it("rejects malformed child observations before deriving ratio prices", async () => {
    const source = createRatioPriceSource({
      id: "eth-usdc",
      pair: "ETH/USDC",
      numeratorPair: "ETH/USD",
      denominatorPair: "USDC/USD",
      numerator: {
        id: "eth-usd",
        observe: async (pairId) => ({ source: "spoofed", pair: pairId, price: 2500, observedAt: 1 }),
      },
      denominator: {
        id: "usdc-usd",
        observe: async (pairId) => ({ source: "usdc-usd", pair: pairId, price: 1, observedAt: 1 }),
      },
    });

    await expect(source.observe("ETH/USDC")).rejects.toThrow(/mismatched source id/);
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

  it("normalizes pair ids before selecting liquidity-position fair prices", () => {
    expect(selectFairPrice(
      "ETH/USDC",
      [
        { source: "pragma", pair: "eth/usdc", price: 1000, observedAt: 1_000 },
        { source: "coinbase", pair: "ETH/USDC", price: 1001, observedAt: 1_000 },
      ],
      { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 2 },
      2_000,
    )).toMatchObject({ ok: true, price: 1000.5 });
  });

  it("rejects market observations that are too far in the future", () => {
    expect(selectFairPrice(
      "ETH/USDC",
      [
        { source: "oracle-a", pair: "ETH/USDC", price: 1000, observedAt: 1_000_000 },
        { source: "oracle-b", pair: "ETH/USDC", price: 1001, observedAt: 1_000_000 },
      ],
      { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 2 },
      2_000,
    )).toMatchObject({ ok: false, reason: "no_sources" });
  });

  it("requires distinct reference sources for liquidity-position fair prices", () => {
    expect(selectFairPrice(
      "ETH/USDC",
      [
        { source: "coinbase", pair: "ETH/USDC", price: 1000, observedAt: 1_000 },
        { source: "coinbase", pair: "ETH/USDC", price: 1001, observedAt: 2_000 },
      ],
      { maxStalenessMs: 10_000, maxDivergenceBps: 50, minSources: 2 },
      2_000,
    )).toMatchObject({ ok: false, reason: "stale" });
  });

  it("does not let malformed negative balances create quote capacity", () => {
    const inventory = buildInventorySnapshot(pair, [
      { asset: "ETH", available: "-10", locked: "-1" },
      { asset: "USDC", available: "-5000", locked: "-1" },
    ], [
      { pair: "ETH/USDC", orderId: "bad-buy", side: "Buy", baseAmount: -5, quoteAmount: -5000, status: "queued" },
      { pair: "ETH/USDC", orderId: "bad-sell", side: "Sell", baseAmount: -5, quoteAmount: 0, status: "queued" },
    ], 1000);

    expect(inventory).toMatchObject({
      availableBase: 0,
      availableQuote: 0,
      lockedBase: 0,
      lockedQuote: 0,
      pendingBuyBase: 0,
      pendingSellBase: 0,
      pendingQuote: 0,
      baseRatio: 0,
    });
  });

  it("includes unrelated locked quote in liquidity-position inventory value", () => {
    const inventory = buildInventorySnapshot(pair, [
      { asset: "ETH", available: "1", locked: "0" },
      { asset: "USDC", available: "0", locked: "1000" },
    ], [], 1000);

    expect(inventory.baseRatio).toBe(0.5);
  });

  it("does not double-count quote locked for pending buy exposure", () => {
    const inventory = buildInventorySnapshot(pair, [
      { asset: "ETH", available: "1", locked: "0" },
      { asset: "USDC", available: "0", locked: "1000" },
    ], [
      { pair: "ETH/USDC", orderId: "pending-buy", side: "Buy", baseAmount: 1, quoteAmount: 1000, status: "submitted" },
    ], 1000);

    expect(inventory.baseRatio).toBe(1);
  });

});

describe("@zylith/sdk trader", () => {
  it("rejects coordinator batches for a different pair", async () => {
    const sdk = new ZylithSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ...batchFixture(),
        pair_id: "STRK/USDC",
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });

    await expect(sdk.submittableBatch("ETH/USDC")).rejects.toThrow(/wrong pair/);
  });

  it("rejects malformed coordinator batch responses", async () => {
    const sdk = new ZylithSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ...batchFixture(),
        close_time_unix_ms: "soon",
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });

    await expect(sdk.submittableBatch("ETH/USDC")).rejects.toThrow(/batch close time/);
  });

  it("opens private liquidity positions through the wallet runtime with a coordinator batch", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(batchFixture()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const sdk = new ZylithSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const request = buildPrivateLiquidityPositionPlan({
      pair,
      baseAmount: "1",
      quoteAmount: "2500",
      currentPrice: "2500",
      minPrice: "2250",
      maxPrice: "2750",
      spreadBps: 30,
    }).openPosition;
    const openPrivateLiquidityPosition = vi.fn(async () => ({
      lifecycle_id: "lp-1",
      position_commitment: "0xposition",
      transition_commitment: "0xtransition",
      funding_note_commitments: ["0xbase", "0xquote"],
      batch_id: "batch-1",
      epoch_id: 1,
    }));

    await expect(
      sdk.openPrivateLiquidityPosition({ openPrivateLiquidityPosition }, request)
    ).resolves.toMatchObject({
      lifecycle_id: "lp-1",
      position_commitment: "0xposition",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://coordinator.example/api/pairs/ETH/USDC/batches/submittable",
      expect.objectContaining({
        headers: { accept: "application/json" },
      })
    );
    expect(openPrivateLiquidityPosition).toHaveBeenCalledWith(
      request,
      batchFixture()
    );
  });

  it("selects settlement outputs for withdrawal", async () => {
    const submitStrk20Withdrawal = vi.fn(async () => ({ transaction_hash: "0xwithdraw" }));
    const sdk = new ZylithSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(sdk.withdrawSettlementOutput({
      submitPrivateOrder: vi.fn(async () => ({})),
      submitStrk20Withdrawal,
      getWithdrawableNotes: () => [
        { note_commitment: "0xdeposit", source: "deposit", asset: "STRK", amount: "1", locked: false, spent: false, metadata_commitment: "0x1" },
        { note_commitment: "0xsettlement", source: "settlement_output", asset: "STRK", amount: "1", locked: false, spent: false, metadata_commitment: "0x2" },
      ],
    })).resolves.toMatchObject({ transaction_hash: "0xwithdraw" });
    expect(submitStrk20Withdrawal).toHaveBeenCalledWith({ note_commitment: "0xsettlement", asset: "STRK" });
  });

  it("redacts prover error payloads", async () => {
    const sdk = new ZylithSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: "proof rejected",
        calldata: ["0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"],
      }), { status: 500, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });

    await expect(sdk.proofStatus("batch-1")).rejects.toThrow(/proof rejected/);
    await expect(sdk.proofStatus("batch-1")).rejects.not.toThrow(/1234567890abcdef/);
  });

  it("keeps waiting for settlement across transient polling failures", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        batch_id: "batch-1",
        state: "proving",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        batch_id: "batch-1",
        state: "confirmed-onchain",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const sdk = new ZylithSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(sdk.waitForSettlement("batch-1", {
      timeoutMs: 1_000,
      intervalMs: 1,
    })).resolves.toMatchObject({ state: "confirmed-onchain" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects proof status returned for a different batch", async () => {
    const sdk = new ZylithSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        batch_id: "batch-2",
        state: "confirmed-onchain",
        matched_order_count_bucket: "0-7",
        reuse_state: "unknown",
        failure: null,
        updated_at_unix_ms: 1,
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });

    await expect(sdk.proofStatus("batch-1")).rejects.toThrow(/wrong batch/);
  });

  it("cancels settlement polling immediately when the caller aborts", async () => {
    const controller = new AbortController();
    const sdk = new ZylithSdk({
      coordinatorUrl: "https://coordinator.example",
      proverUrl: "https://prover.example",
      fetchImpl: abortingFetch(),
    });
    const attempt = sdk.waitForSettlement("batch-1", {
      timeoutMs: 60_000,
      intervalMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(attempt).rejects.toThrow("Zylith SDK request aborted");
  });
});

describe("@zylith/sdk relay", () => {
  it("builds package access token headers", () => {
    expect(relayAccessHeaders(packageFixture())).toMatchObject({
      "x-zylith-relay-package-access-token": "relay-token",
    });
  });

  it("rejects missing package access token headers", () => {
    expect(() =>
      relayAccessHeaders({
        ...packageFixture(),
        access_token: undefined,
      })
    ).toThrow("Renewal relay package access token is missing");
  });

  it("rejects blank package access token headers", () => {
    expect(() =>
      relayAccessHeaders({
        ...packageFixture(),
        access_token: "   ",
      })
    ).toThrow("Renewal relay package access token is missing");
  });

  it("redacts relay error payloads", async () => {
    const sdk = new ZylithSdk({
      relayUrl: "https://relay.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: "relay rejected package",
        signature: ["0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"],
      }), { status: 500, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });

    await expect(sdk.packageStatus(packageFixture())).rejects.toThrow(/relay rejected package/);
    await expect(sdk.packageStatus(packageFixture())).rejects.not.toThrow(/abcdefabcdef/);
  });

  it("rejects relay status for a different package", async () => {
    const sdk = new ZylithSdk({
      relayUrl: "https://relay.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ...relayStatusFixture(),
        package_id: "other-package",
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });

    await expect(sdk.packageStatus(packageFixture())).rejects.toThrow(/wrong package/);
  });

  it("rejects impossible relay slot counts", async () => {
    const sdk = new ZylithSdk({
      relayUrl: "https://relay.example",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ...relayStatusFixture(),
        submitted_slots: 1,
        failed_slots: 1,
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });

    await expect(sdk.packageStatus(packageFixture())).rejects.toThrow(/impossible slot counts/);
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
    access_token: "relay-token",
    relay_policy: {
      prover_url: "https://prover.example",
      coordinator_url: "https://coordinator.example",
      submission_safety_buffer_ms: 5_000,
      max_submission_delay_ms: 0,
    },
    slots: [],
  };
}

function relayStatusFixture() {
  return {
    package_id: "pkg",
    package_commitment: "0xpkg",
    pair: "ETH/USDC",
    start_epoch: 1,
    end_epoch: 2,
    slot_count: 1,
    relay_mode: "ZylithRelay" as const,
    pending_slots: 1,
    submitted_slots: 0,
    failed_slots: 0,
    updated_at_unix_ms: 1,
  };
}

function abortingFetch(): typeof fetch {
  return vi.fn(async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    })
  ) as unknown as typeof fetch;
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
