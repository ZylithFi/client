import { describe, expect, it } from "vitest";
import { isIncrementalChartUpdate } from "./PriceChart";

const candle = (time: number, close = time) => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
});

describe("incremental chart updates", () => {
  it("updates only the live final candle when history is unchanged", () => {
    expect(isIncrementalChartUpdate(
      [candle(1), candle(2)],
      [candle(1), candle(2, 3)],
    )).toBe(true);
    expect(isIncrementalChartUpdate(
      [candle(1), candle(2)],
      [candle(1), candle(2), candle(3)],
    )).toBe(true);
  });

  it("requires a full reset when an appended update also corrects history", () => {
    expect(isIncrementalChartUpdate(
      [candle(1), candle(2)],
      [candle(1), candle(2, 3), candle(3)],
    )).toBe(false);
    expect(isIncrementalChartUpdate(
      [candle(1), candle(2)],
      [candle(9), candle(2)],
    )).toBe(false);
  });
});
