import { describe, expect, it, vi } from "vitest";
import {
  createHttpJsonPriceSource,
  createLastClearingPriceSource,
  createStarknetOraclePriceSource,
  MarketDataEngine,
  readJsonPath,
} from "./marketData";

describe("market data adapters", () => {
  it("reads nested JSON price paths and rejects pair mismatches", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        pair: "ETH-USDC",
        price: "1000.5",
        observed_at: 1_781_500_000,
      },
    })) as unknown as typeof fetch;
    const source = createHttpJsonPriceSource({
      id: "http-feed",
      url: "https://prices.example/eth-usdc",
      pairPath: "$.data.pair",
      pricePath: "$.data.price",
      observedAtPath: "$.data.observed_at",
      fetchImpl,
    });

    await expect(source.observe("ETH/USDC")).resolves.toMatchObject({
      source: "http-feed",
      pair: "ETH/USDC",
      price: 1000.5,
      observedAt: 1_781_500_000_000,
    });
    await expect(source.observe("STRK/USDC")).resolves.toBeNull();
  });

  it("reads Starknet oracle call results with scale and timestamp", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("starknet_call");
      expect(body.params.request.contract_address).toBe("0xoracle");
      return jsonResponse({
        result: [
          `0x${(1000_00000000n).toString(16)}`,
          `0x${(1_781_500_000n).toString(16)}`,
        ],
      });
    }) as unknown as typeof fetch;
    const source = createStarknetOraclePriceSource({
      id: "oracle",
      rpcUrl: "https://rpc.example",
      contractAddress: "0xoracle",
      entrypoint: "0xselector",
      calldata: (pair) => [pair],
      priceScale: 100_000_000,
      timestampIndex: 1,
      fetchImpl,
    });

    await expect(source.observe("ETH/USDC")).resolves.toMatchObject({
      source: "oracle",
      price: 1000,
      observedAt: 1_781_500_000_000,
    });
  });

  it("aggregates sources through stale and divergence policy", async () => {
    const now = 1_781_500_000_000;
    const engine = new MarketDataEngine({
      sources: [
        { id: "a", observe: async (pair) => ({ source: "a", pair, price: 1000, observedAt: now }) },
        { id: "b", observe: async (pair) => ({ source: "b", pair, price: 1001, observedAt: now }) },
      ],
      fairPricePolicy: {
        maxStalenessMs: 10_000,
        maxDivergenceBps: 50,
        minSources: 2,
      },
      now: () => now,
    });

    await expect(engine.fairPrice("ETH/USDC")).resolves.toMatchObject({
      ok: true,
      price: 1000.5,
      sources: ["a", "b"],
    });
  });

  it("reads latest settlement transcript as an analytics source", async () => {
    const source = createLastClearingPriceSource("last-clearing", {
      old: {
        batch_id: "old",
        pair_id: "ETH/USDC",
        batch_epoch: 1,
        clearing_price: "990000",
        price_base_scale: "1000",
        settled_at_unix_ms: 1,
      },
      latest: {
        batch_id: "latest",
        pair_id: "ETH/USDC",
        batch_epoch: 2,
        clearing_price: "1000000",
        price_base_scale: "1000",
        settled_at_unix_ms: 2,
      },
    });

    await expect(source.observe("ETH/USDC")).resolves.toMatchObject({
      source: "last-clearing",
      price: 1000,
      observedAt: 2,
    });
  });

  it("reads simple JSON paths", () => {
    expect(readJsonPath({ a: { b: [{ c: 4 }] } }, "$.a.b.0.c")).toBe(4);
    expect(readJsonPath({ a: 1 }, "$.a.b")).toBeUndefined();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
