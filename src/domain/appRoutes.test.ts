import { describe, expect, it } from "vitest";
import {
  liquidityPath,
  liquidityTabFromPath,
  takerPath,
  takerTabFromPath,
} from "./appRoutes";

describe("app routes", () => {
  it("maps taker paths to tabs", () => {
    expect(takerTabFromPath("/trade")).toBe("trade");
    expect(takerTabFromPath("/orders")).toBe("orders");
    expect(takerTabFromPath("/assets")).toBe("assets");
    expect(takerTabFromPath("/reports")).toBe("reports");
    expect(takerTabFromPath("/tca")).toBe("reports");
    expect(takerTabFromPath("/unknown")).toBe("trade");
  });

  it("maps liquidity paths to tabs", () => {
    expect(liquidityTabFromPath("/liquidity/positions")).toBe("positions");
    expect(liquidityTabFromPath("/liquidity/curves")).toBe("positions");
    expect(liquidityTabFromPath("/liquidity/orders")).toBe("orders");
    expect(liquidityTabFromPath("/liquidity/inventory")).toBe("inventory");
    expect(liquidityTabFromPath("/liquidity/analytics")).toBe("analytics");
    expect(liquidityTabFromPath("/liquidity/unknown")).toBe("positions");
    expect(liquidityTabFromPath("/liquidity")).toBe("positions");
  });

  it("normalizes canonical taker paths", () => {
    expect(takerPath("trade")).toBe("/trade");
    expect(takerPath("orders")).toBe("/orders");
    expect(takerPath("assets")).toBe("/assets");
    expect(takerPath("reports")).toBe("/tca");
  });

  it("normalizes canonical liquidity paths", () => {
    expect(liquidityPath("positions")).toBe("/liquidity/positions");
    expect(liquidityPath("orders")).toBe("/liquidity/orders");
    expect(liquidityPath("inventory")).toBe("/liquidity/inventory");
    expect(liquidityPath("analytics")).toBe("/liquidity/analytics");
  });
});
