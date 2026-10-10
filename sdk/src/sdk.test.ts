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
import {
  ExchangeHttpError,
  ExchangeRejectedError,
  ZylithExchangeClient,
  openSealedResponse,
  transitionWindows,
} from "./exchange.js";

const pair = {
  pair_id: "ETH/USDC",
  base_asset_id: "ETH",
  quote_asset_id: "USDC",
  min_order_amount: "0.01",
  enabled: true,
};

const testHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const testU32be = (value: number) => {
  const encoded = new Uint8Array(4);
  new DataView(encoded.buffer).setUint32(0, value, false);
  return encoded;
};
const testFrame = (parts: Uint8Array[]) => {
  const encoded = new Uint8Array(4 + parts.reduce((total, part) => total + 4 + part.length, 0));
  const view = new DataView(encoded.buffer);
  view.setUint32(0, parts.length, false);
  let offset = 4;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    encoded.set(part, offset);
    offset += part.length;
  }
  return encoded;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("@zylith/sdk common", () => {
  it("requires the deployment registry to define every asset's decimals", () => {
    configureAssetDecimals(undefined);
    expect(() => assetDecimals("USDC")).toThrow(/not defined/);
    configureAssetDecimals({ USDC: { decimals: 6 }, ETH: { decimals: 18 } });
    expect(assetDecimals("USDC")).toBe(6);
    expect(toAtomicStr("0.001", "ETH")).toBe("1000000000000000");
    expect(() => assetDecimals("UNKNOWN")).toThrow(/not defined/);
    expect(() => configureAssetDecimals({ BROKEN: {} })).toThrow(/invalid decimals/);
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
  return { seq, block_number: seq, transaction_hash: "0x1", new_book_root: "0x2", note_root: "0x3", output_root: "0x4", note_batch_index: seq, outputs: [] };
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

  it("downloads the public note accumulator roots in bounded generic ranges", async () => {
    const urls: string[] = [];
    const roots = Array.from({ length: 300 }, (_, index) => `0x${(index + 1).toString(16)}`);
    const client = new ZylithExchangeClient({
      operatorUrl: "https://operator.example",
      indexerUrl: "https://indexer.example",
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const [start, end] = url.split("/").slice(-2).map(Number);
        return json({ start, end, total: roots.length, roots: roots.slice(start, end + 1) });
      }) as unknown as typeof fetch,
    });
    await expect(client.allNoteBatchRoots()).resolves.toEqual(roots);
    expect(urls).toEqual([
      "https://indexer.example/api/note-batches/range/0/255",
      "https://indexer.example/api/note-batches/range/256/511",
    ]);
  });

  it("fetches every reference price through one market-independent endpoint", async () => {
    const fetchImpl = vi.fn(async () => json({
      prices: [
        { pair: "ETH/USDC", midpoint: "2500000000", scale: "1000000", observed_at_ms: 1, valid_until_ms: 2 },
        { pair: "STRK/USDC", midpoint: "500000", scale: "1000000", observed_at_ms: 1, valid_until_ms: 2 },
      ],
    }));
    const client = new ZylithExchangeClient({
      operatorUrl: "https://operator.example",
      indexerUrl: "https://indexer.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.referencePrice("STRK/USDC")).resolves.toMatchObject({ midpoint: "500000" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://operator.example/api/public/reference-prices");
  });

  it("rejects duplicate or incomplete reference-price batches", async () => {
    const duplicate = { pair: "ETH/USDC", midpoint: "1", scale: "1", observed_at_ms: 1, valid_until_ms: 2 };
    const client = new ZylithExchangeClient({
      operatorUrl: "https://operator.example",
      indexerUrl: "https://indexer.example",
      fetchImpl: vi.fn(async () => json({ prices: [duplicate, duplicate] })) as unknown as typeof fetch,
    });

    await expect(client.referencePrices()).rejects.toThrow(/invalid reference-price batch/);
    await expect(new ZylithExchangeClient({
      operatorUrl: "https://operator.example",
      indexerUrl: "https://indexer.example",
      fetchImpl: vi.fn(async () => json({ prices: [] })) as unknown as typeof fetch,
    }).referencePrice("ETH/USDC")).rejects.toThrow(/no reference price/);
  });

  it("accepts only the exact active X25519 execution-key registry", async () => {
    const profile = "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20Poly1305/base";
    const key = {
      key_id: "active",
      algorithm: profile,
      public_key: "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
    };
    const registry = { keys: [key] };
    const client = (body: unknown) => new ZylithExchangeClient({
      operatorUrl: "https://operator.example",
      indexerUrl: "https://indexer.example",
      fetchImpl: vi.fn(async () => json(body)) as unknown as typeof fetch,
    });

    await expect(client(registry).executionKeys()).resolves.toEqual(registry);
    for (const malformed of [
      null,
      {},
      { keys: [] },
      { keys: [key, { ...key, key_id: "next" }] },
      ...(["key_id", "algorithm", "public_key"] as const).map((field) => {
        const missing = { ...key } as Record<string, unknown>;
        delete missing[field];
        return { keys: [missing] };
      }),
      { keys: [{ ...key, algorithm: "X25519" }] },
      { keys: [{ ...key, public_key: "00".repeat(32) }] },
      { keys: [{ ...key, public_key: key.public_key.toUpperCase() }] },
      { keys: [{ ...key, public_key: "01" }] },
      ...["UPPER", "-bad", "bad-", "bad.dot", "bad:colon"].map((key_id) => ({ keys: [{ ...key, key_id }] })),
      ...[
        `01${"00".repeat(31)}`,
        `ec${"ff".repeat(30)}7f`,
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
        "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
        `ed${"ff".repeat(30)}7f`,
        `ee${"ff".repeat(30)}7f`,
        `${"00".repeat(31)}80`,
      ].map((public_key) => ({ keys: [{ ...key, public_key }] })),
      { keys: [{ ...key, extra: true }] },
      { ...registry, extra: true },
    ]) await expect(client(malformed).executionKeys()).rejects.toThrow(/malformed execution-key registry/i);
  });

  it("opens sealed answers, surfaces refusals and redacts operator errors", async () => {
    const responseKey = "ab".repeat(32);
    const sealed = {
      version: 3 as const,
      key_id: "active",
      digest: "d1".repeat(32),
      encapsulated_key: "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
      ciphertext: "cd".repeat(4_112),
    };
    const seal = async (answer: unknown, digest = sealed.digest, plaintextOverride?: string) => {
      const utf8 = (value: string) => new TextEncoder().encode(value);
      const digestBytes = Uint8Array.from(digest.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
      const salt = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
      const nonce = Uint8Array.from({ length: 12 }, (_, index) => index);
      const version = testU32be(3);
      const size = testU32be(16_384);
      const root = await crypto.subtle.importKey("raw", Uint8Array.from({ length: 32 }, () => 0xab), "HKDF", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt,
          info: testFrame([utf8("zylith-response-key-hkdf-sha256-v3"), version, size, digestBytes]),
        },
        root,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
      );
      const plaintext = utf8((plaintextOverride ?? JSON.stringify(answer)).padEnd(16_384, " "));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM",
        iv: nonce,
        additionalData: testFrame([utf8("zylith-response-aad-v3"), version, size, digestBytes, salt]),
      }, key, plaintext));
      return json({ version: 3, salt: testHex(salt), nonce: testHex(nonce), ciphertext: testHex(ciphertext) });
    };
    const answer = { ok: true, orders: [{ order_id: "0x1", status: "unknown", cancel_requested: false, events: [] }], withdrawals: [] };
    const responses = [
      await seal(answer),
      await seal({ ok: false, error: "rejected 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" }),
      await seal(answer, "another request"),
      await seal(undefined, sealed.digest, "private-response-material-that-is-not-json"),
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
    const malformed = client.status(sealed, responseKey);
    await expect(malformed).rejects.toThrow(/answer is malformed/i);
    await expect(malformed).rejects.not.toThrow(/private-response-material/);
    await expect(client.submit(sealed, responseKey)).rejects.toBeInstanceOf(ExchangeHttpError);
  });

  it("matches the frozen response-v3 HKDF and AAD vector", async () => {
    const utf8 = (value: string) => new TextEncoder().encode(value);
    const rootBytes = Uint8Array.from({ length: 32 }, () => 0xab);
    const digest = Uint8Array.from({ length: 32 }, () => 0xd1);
    const salt = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const version = testU32be(3);
    const size = testU32be(16_384);
    const info = testFrame([utf8("zylith-response-key-hkdf-sha256-v3"), version, size, digest]);
    const aad = testFrame([utf8("zylith-response-aad-v3"), version, size, digest, salt]);
    const root = await crypto.subtle.importKey("raw", rootBytes, "HKDF", false, ["deriveBits"]);
    const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, root, 256));
    const aadDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", aad));
    expect(testHex(derived)).toBe("ea8e968545afac9bc818918aa846b762c1bd3993270c3433be2c0500647d6c1a");
    expect(testHex(aadDigest)).toBe("a30c16572c02911878dbaf83891deef37391361916baebb587c15a8c6e54a61f");
  });

  it("rejects legacy, noncanonical, truncated, and extended response wires", async () => {
    const digest = "d1".repeat(32);
    const current = {
      version: 3 as const,
      salt: "ab".repeat(32),
      nonce: "cd".repeat(12),
      ciphertext: "ef".repeat(16_400),
    };
    for (const malformed of [
      { nonce: current.nonce, ciphertext: current.ciphertext },
      ...(["version", "salt", "nonce", "ciphertext"] as const).map((field) => {
        const missing = { ...current } as Record<string, unknown>;
        delete missing[field];
        return missing;
      }),
      { ...current, version: 2 },
      { ...current, salt: current.salt.toUpperCase() },
      { ...current, nonce: `${current.nonce}00` },
      { ...current, ciphertext: current.ciphertext.slice(2) },
      { ...current, ciphertext: `${current.ciphertext}00` },
      { ...current, extra: true },
    ]) await expect(openSealedResponse("ab".repeat(32), digest, malformed as never)).rejects.toThrow(/malformed sealed response/i);
  });

  it("rejects legacy, noncanonical, and extended sealed request wires before transport", async () => {
    const fetchImpl = vi.fn();
    const client = new ZylithExchangeClient({
      operatorUrl: "https://operator.example",
      indexerUrl: "https://indexer.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const current = {
      version: 3 as const,
      key_id: "active",
      digest: "ab".repeat(32),
      encapsulated_key: "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
      ciphertext: "ef".repeat(4_112),
    };
    for (const malformed of [
      { version: 2, digest: current.digest, shares: [] },
      ...(["version", "key_id", "digest", "encapsulated_key", "ciphertext"] as const).map((field) => {
        const missing = { ...current } as Record<string, unknown>;
        delete missing[field];
        return missing;
      }),
      { ...current, key_id: "UPPER" },
      { ...current, digest: current.digest.toUpperCase() },
      { ...current, encapsulated_key: `01${"00".repeat(31)}` },
      { ...current, ciphertext: `${current.ciphertext}00` },
      { ...current, extra: true },
    ]) await expect(client.submit(malformed as never, "ab".repeat(32))).rejects.toThrow(/malformed sealed request/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
