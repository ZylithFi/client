import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assetDecimals,
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
  toAtomicStr,
  MarketDataEngine,
} from "./common.js";
import { ExchangeHttpError, ExchangeRejectedError, ZylithExchangeClient, transitionWindows } from "./exchange.js";

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

describe("@zylith/sdk common", () => {
  it("knows the traded assets' decimals, and the manifest overrides them", () => {
    configureAssetDecimals(undefined);
    expect(assetDecimals("USDC")).toBe(6);
    expect(toAtomicStr("0.001", "ETH")).toBe("1000000000000000");
    configureAssetDecimals({ USDC: { decimals: 18 } });
    expect(assetDecimals("USDC")).toBe(18);
    configureAssetDecimals(undefined);
  });

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

  it("rejects public cleartext URLs in exchange and market data clients", async () => {
    expect(() => new ZylithExchangeClient({
      operatorUrl: "http://35.192.48.142:8080",
      indexerUrl: "https://api.zylith.fi/indexer",
    })).toThrow(/operatorUrl must use HTTPS/);

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

  it("normalizes pair ids before selecting clearing reference prices", () => {
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

  it("requires distinct sources for clearing reference prices", () => {
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

});


const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function transition(seq: number) {
  return { seq, block_number: seq, transaction_hash: "0x1", new_book_root: "0x2", note_root: "0x3", output_root: "0x4", outputs: [] };
}

describe("@zylith/sdk exchange", () => {
  it("covers a seq range with globally aligned windows", () => {
    expect(transitionWindows(1, 1)).toEqual([[0, 63]]);
    expect(transitionWindows(63, 64)).toEqual([[0, 63], [64, 127]]);
    expect(transitionWindows(130, 200)).toEqual([[128, 191], [192, 255]]);
  });

  it("reads every transition after a seq through aligned windows", async () => {
    const urls: string[] = [];
    const client = new ZylithExchangeClient({
      operatorUrl: "https://operator.example",
      indexerUrl: "https://indexer.example",
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const [start, end] = url.split("/").slice(-2).map(Number);
        const seqs = Array.from({ length: end - start + 1 }, (_, index) => start + index).filter((seq) => seq >= 1 && seq <= 70);
        return json({ start, end, latest_seq: 70, transitions: seqs.map(transition) });
      }) as unknown as typeof fetch,
    });
    const { latestSeq, transitions } = await client.transitionsAfter(60);
    expect(latestSeq).toBe(70);
    expect(transitions.map((entry) => entry.seq)).toEqual([61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
    expect(urls).toEqual([
      "https://indexer.example/api/transitions/range/0/63",
      "https://indexer.example/api/transitions/range/64/127",
    ]);
  });

  it("rejects an index with a gap or out-of-range transitions", async () => {
    const gap = new ZylithExchangeClient({
      operatorUrl: "https://operator.example",
      indexerUrl: "https://indexer.example",
      fetchImpl: vi.fn(async () => json({ start: 0, end: 63, latest_seq: 3, transitions: [transition(1), transition(3)] })) as unknown as typeof fetch,
    });
    await expect(gap.transitionsAfter(0)).rejects.toThrow(/missing a transition/);
    const stray = new ZylithExchangeClient({
      operatorUrl: "https://operator.example",
      indexerUrl: "https://indexer.example",
      fetchImpl: vi.fn(async () => json({ start: 0, end: 63, latest_seq: 99, transitions: [transition(99)] })) as unknown as typeof fetch,
    });
    await expect(stray.transitions(0, 63)).rejects.toThrow(/outside the requested range/);
  });

  it("opens sealed answers, surfaces refusals and redacts operator errors", async () => {
    const responseKey = "ab".repeat(32);
    const sealed = { version: 2, digest: "d1", shares: [] };
    const seal = async (answer: unknown, digest = sealed.digest) => {
      const key = await crypto.subtle.importKey("raw", Uint8Array.from({ length: 32 }, () => 0xab), "AES-GCM", false, ["encrypt"]);
      const nonce = Uint8Array.from({ length: 12 }, (_, index) => index);
      const plaintext = new TextEncoder().encode(JSON.stringify(answer).padEnd(1024, " "));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(digest) }, key, plaintext));
      const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return json({ nonce: hex(nonce), ciphertext: hex(ciphertext) });
    };
    const answer = { ok: true, orders: [{ order_id: "0x1", status: "unknown", cancel_requested: false, events: [] }], withdrawals: [] };
    const responses = [
      await seal(answer),
      await seal({ ok: false, error: "rejected 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" }),
      await seal(answer, "another request"),
      json({ error: "the request does not open" }, 400),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new ZylithExchangeClient({ operatorUrl: "https://operator.example", indexerUrl: "https://indexer.example", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.status(sealed, responseKey)).resolves.toMatchObject({ orders: answer.orders });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://operator.example/api/private/requests");
    const refused = client.submit(sealed, responseKey);
    await expect(refused).rejects.toBeInstanceOf(ExchangeRejectedError);
    await expect(refused).rejects.not.toThrow(/1234567890abcdef/);
    await expect(client.status(sealed, responseKey)).rejects.toThrow(/does not open/);
    await expect(client.submit(sealed, responseKey)).rejects.toBeInstanceOf(ExchangeHttpError);
  });
});
