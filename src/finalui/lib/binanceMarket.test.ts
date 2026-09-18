import { describe, expect, it } from "vitest";
import {
  binanceMarketForPair,
  combineBinanceBooks,
  combineBinanceCandles,
  combineBinanceKlines,
  combineBinanceTickers,
  parseBinanceKlineEvent,
  parseBinanceTicker,
} from "./binanceMarket";

describe("binance market construction", () => {
  it("uses the same ratio markets as the signed STRK/USDC reference", () => {
    expect(binanceMarketForPair("STRK", "USDC")).toEqual({
      kind: "ratio",
      baseSymbol: "STRKUSDT",
      quoteSymbol: "USDCUSDT",
    });
  });

  it("derives executable ratio bid and ask without inverting either side", () => {
    expect(combineBinanceBooks(
      { bid: 0.041, ask: 0.0412 },
      { bid: 0.9998, ask: 1.0002 },
    )).toEqual({
      bid: 0.041 / 1.0002,
      ask: 0.0412 / 0.9998,
    });
  });

  it("joins ratio candles by opening timestamp", () => {
    const base = [
      [1_000_000, "0.04", "0.05", "0.03", "0.045"],
      [2_000_000, "0.05", "0.06", "0.04", "0.055"],
    ];
    const quote = [
      [1_000_000, "1.00", "1.01", "0.99", "1.005"],
      [3_000_000, "1.01", "1.02", "1.00", "1.015"],
    ];
    expect(combineBinanceKlines(base, quote)).toEqual([{
      time: 1_000,
      open: 0.04,
      high: 0.05 / 0.99,
      low: 0.03 / 1.01,
      close: 0.045 / 1.005,
    }]);
  });

  it("parses live kline updates and rejects malformed data", () => {
    expect(parseBinanceKlineEvent({
      stream: "strkusdt@kline_5m",
      data: {
        s: "STRKUSDT",
        k: { t: 1_000_000, o: "0.04", h: "0.05", l: "0.03", c: "0.045" },
      },
    })).toEqual({
      symbol: "STRKUSDT",
      candle: { time: 1_000, open: 0.04, high: 0.05, low: 0.03, close: 0.045 },
    });
    expect(parseBinanceKlineEvent({ s: "STRKUSDT", k: { t: "bad" } })).toBeNull();
  });

  it("only combines synchronized ratio updates", () => {
    const base = { time: 1_000, open: 4, high: 5, low: 3, close: 4.5 };
    const quote = { time: 1_000, open: 2, high: 2.5, low: 1.5, close: 2.25 };
    expect(combineBinanceCandles(base, quote)).toEqual({
      time: 1_000,
      open: 2,
      high: 5 / 1.5,
      low: 3 / 2.5,
      close: 2,
    });
    expect(combineBinanceCandles(base, { ...quote, time: 2_000 })).toBeNull();
  });

  it("derives ratio-market statistics from the two Binance tickers", () => {
    const base = parseBinanceTicker({
      lastPrice: "112",
      prevClosePrice: "100",
      highPrice: "116",
      lowPrice: "95",
      quoteVolume: "201430000",
    });
    const quote = parseBinanceTicker({
      lastPrice: "1.01",
      prevClosePrice: "1",
      highPrice: "1.02",
      lowPrice: "0.99",
      quoteVolume: "300000000",
    });

    expect(base).not.toBeNull();
    expect(quote).not.toBeNull();
    expect(combineBinanceTickers(base!, quote!)).toEqual({
      last: 112 / 1.01,
      changePercent: ((112 / 1.01 - 100) / 100) * 100,
      high: 116 / 0.99,
      low: 95 / 1.02,
      quoteVolume: 201430000,
    });
  });
});
