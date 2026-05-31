import { describe, expect, it } from "vitest";
import { rotateMakerCurvePoints, type NormalizedMakerCurvePoint } from "./zylithWalletRuntime";

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
});
