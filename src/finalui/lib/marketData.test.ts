import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchMarketCandles,
  openMarketStream,
  parseMarketCandle,
  parseMarketSummary,
} from "./marketData";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close() {
    this.closed = true;
  }
}

describe("same-origin market data", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("loads candle history only from the same-origin proxy", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          candles: [
            { time: 60, open: 1, high: 2, low: 0.5, close: 1.5 },
            { time: 120, open: 1, high: 0.9, low: 0.5, close: 1.5 },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const candles = await fetchMarketCandles("ETH", "USDC", "1M", new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/market-data/v1/ETH/USDC/candles/1M");
    expect(candles).toEqual([{ time: 60, open: 1, high: 2, low: 0.5, close: 1.5 }]);
  });

  it("streams summaries and candles over one same-origin event source", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const summaries: unknown[] = [];
    const candles: unknown[] = [];

    const close = openMarketStream("STRK", "USDC", "15m", {
      onSummary: (summary) => summaries.push(summary),
      onCandle: (candle) => candles.push(candle),
    });
    const source = FakeEventSource.instances[0]!;
    source.emit("summary", {
      bbos: [
        { venue: "Binance", bid: 1, ask: 1.1, observed_at_unix_ms: 5 },
        { venue: "Coinbase", bid: 0, ask: 0 },
        { venue: "Unknown", bid: 1, ask: 1 },
      ],
      stats: { last: 1, change_percent: -2, high: 2, low: 0.5, quote_volume: 10 },
    });
    source.emit("candle", { time: 60, open: 1, high: 2, low: 0.5, close: 1.5 });
    source.emit("candle", { time: "bad" });
    close();

    expect(source.url).toBe("/market-data/v1/STRK/USDC/stream/15m");
    expect(summaries).toEqual([
      {
        bbos: [{ venue: "Binance", bid: 1, ask: 1.1, observedAtUnixMs: undefined }],
        stats: { last: 1, changePercent: -2, high: 2, low: 0.5, quoteVolume: 10 },
      },
    ]);
    expect(candles).toEqual([{ time: 60, open: 1, high: 2, low: 0.5, close: 1.5 }]);
    expect(source.closed).toBe(true);
  });

  it("rejects malformed payloads", () => {
    expect(parseMarketCandle({ time: 60, open: 1, high: 2, low: 3, close: 1 })).toBeNull();
    expect(parseMarketCandle({ time: 60.5, open: 1, high: 2, low: 0.5, close: 1 })).toBeNull();
    expect(parseMarketSummary({ bbos: "nope" })).toBeNull();
    expect(parseMarketSummary({ bbos: [], stats: { last: "1" } })).toEqual({ bbos: [], stats: null });
    expect(parseMarketSummary({ bbos: [{ venue: "Kraken", bid: 2, ask: 1 }] })).toEqual({
      bbos: [],
      stats: null,
    });
    expect(parseMarketSummary({ bbos: [
      { venue: "Binance", bid: 1, ask: 2 },
      { venue: "Binance", bid: 2, ask: 3 },
    ] })?.bbos).toHaveLength(1);
  });

  it("canonicalizes bounded candle history and drops duplicate timestamps", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      candles: [
        { time: 120, open: 1, high: 3, low: 1, close: 2 },
        { time: 60, open: 1, high: 2, low: 0.5, close: 1.5 },
        { time: 120, open: 2, high: 4, low: 2, close: 3 },
      ],
    }))));

    await expect(fetchMarketCandles("ETH", "USDC", "1m", new AbortController().signal)).resolves.toEqual([
      { time: 60, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: 120, open: 2, high: 4, low: 2, close: 3 },
    ]);
  });
});
