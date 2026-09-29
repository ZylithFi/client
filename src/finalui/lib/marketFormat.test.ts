import { describe, expect, it } from "vitest";
import {
  defaultTradeAmount,
  formatQuotedPrice,
  marketPricePrecision,
} from "./marketFormat";

describe("market formatting", () => {
  it("uses the quote asset instead of labeling every market as dollars", () => {
    expect(formatQuotedPrice(0.04423549, "USDC")).toBe("0.04423549 USDC");
    expect(formatQuotedPrice(31.1948597941, "ETH")).toBe("31.1949 ETH");
    expect(formatQuotedPrice(0.0000152224681812, "ETH")).toBe("0.000015222 ETH");
  });

  it("preserves useful significant digits for small cross rates", () => {
    expect(marketPricePrecision(0.044)).toBe(8);
    expect(marketPricePrecision(0.0000172)).toBe(9);
    expect(marketPricePrecision(0.000000553)).toBe(11);
  });

  it("chooses indicative amounts in the asset being paid", () => {
    expect(defaultTradeAmount("USDC")).toBe("1");
    expect(defaultTradeAmount("ETH")).toBe("1");
    expect(defaultTradeAmount("STRK")).toBe("1");
  });
});
