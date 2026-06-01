import { describe, expect, it } from "vitest";
import {
  makerCurveFundingReservePoints,
  rotateMakerCurvePoints,
  type NormalizedMakerCurvePoint,
} from "./zylithWalletRuntime";

describe("maker curve materialization", () => {
  it("rotates prices without reducing per-band depth below protocol minimums", () => {
    const oneStrk = 1_000_000_000_000_000_000n;
    const points: NormalizedMakerCurvePoint[] = [
      { price: 10_000_000_000_000_000n, base_amount: oneStrk },
      { price: 15_000_000_000_000_000n, base_amount: oneStrk },
      { price: 20_000_000_000_000_000n, base_amount: oneStrk },
    ];

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const rotated = rotateMakerCurvePoints(points, 1_000);
      expect(rotated).toHaveLength(points.length);
      expect(rotated.map(point => point.base_amount)).toEqual(points.map(point => point.base_amount));
      expect(rotated.every(point => point.base_amount >= oneStrk)).toBe(true);
    }
  });

  it("reserves bid-curve funding against the maximum upward price rotation", () => {
    const oneStrk = 1_000_000_000_000_000_000n;
    const points: NormalizedMakerCurvePoint[] = [
      { price: 100_000_000_000_000n, base_amount: oneStrk },
      { price: 120_000_000_000_000n, base_amount: oneStrk },
      { price: 140_000_000_000_000n, base_amount: oneStrk },
    ];

    const reserve = makerCurveFundingReservePoints(points, "Buy", 250);
    expect(reserve.map(point => point.price)).toEqual([
      102_500_000_000_000n,
      123_000_000_000_000n,
      143_500_000_000_000n,
    ]);
    expect(reserve.map(point => point.base_amount)).toEqual(points.map(point => point.base_amount));

    const askReserve = makerCurveFundingReservePoints(points, "Sell", 250);
    expect(askReserve.map(point => point.price)).toEqual(points.map(point => point.price));
  });
});
