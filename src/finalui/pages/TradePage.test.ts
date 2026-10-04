import { describe, expect, it } from "vitest";
import { mergeMarketCandles } from "./TradePage";

describe("trade market history reconciliation", () => {
  it("does not let a late history response overwrite a newer stream candle", () => {
    const current = [
      { time: 60, open: 1, high: 2, low: 1, close: 2 },
      { time: 120, open: 2, high: 4, low: 2, close: 4 },
    ];
    const staleHistory = [
      { time: 60, open: 1, high: 2, low: 1, close: 2 },
      { time: 120, open: 2, high: 3, low: 2, close: 3 },
    ];

    expect(mergeMarketCandles(staleHistory, current)).toEqual(current);
  });

  it("sorts, deduplicates, and bounds merged history", () => {
    const older = Array.from({ length: 500 }, (_, index) => ({
      time: index + 1,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
    }));
    const latest = { time: 501, open: 2, high: 2, low: 2, close: 2 };
    const merged = mergeMarketCandles(older, [latest, latest]);
    expect(merged).toHaveLength(500);
    expect(merged[0]?.time).toBe(2);
    expect(merged.at(-1)).toEqual(latest);
  });
});
