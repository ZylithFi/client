import { describe, expect, it } from "vitest";
import type { PairConfig } from "./deployment";
import { orderQuoteValue, ticketReferenceIsFresh, type TicketSubmitIntent } from "./tradeIntent";

const pair = {
  pair_id: "STRK/USDC",
  base_asset_id: "STRK",
  quote_asset_id: "USDC",
  price_base_scale: "1000000000000000000",
  reference_max_age_ms: 10_000,
} as PairConfig;

function intent(now: number): TicketSubmitIntent {
  return {
    pairId: pair.pair_id,
    side: "Buy",
    payAmount: "10",
    midpointPrice: "50000",
    priceBaseScale: pair.price_base_scale,
    observedAtUnixMs: now - 1_000,
    validUntilUnixMs: now + 1_000,
    external: false,
  };
}

describe("ticket reference freshness", () => {
  it("accepts only a current exact-scale authenticated midpoint", () => {
    const now = 1_000_000;
    expect(ticketReferenceIsFresh(intent(now), pair, now)).toBe(true);
    expect(ticketReferenceIsFresh({ ...intent(now), midpointPrice: "0" }, pair, now)).toBe(false);
    expect(ticketReferenceIsFresh({ ...intent(now), priceBaseScale: "1" }, pair, now)).toBe(false);
    expect(ticketReferenceIsFresh({ ...intent(now), observedAtUnixMs: now - 10_001 }, pair, now)).toBe(false);
    expect(ticketReferenceIsFresh({ ...intent(now), observedAtUnixMs: now + 5_001 }, pair, now)).toBe(false);
    expect(ticketReferenceIsFresh({ ...intent(now), validUntilUnixMs: now - 1 }, pair, now)).toBe(false);
    expect(ticketReferenceIsFresh({ ...intent(now), observedAtUnixMs: now + 4_000, validUntilUnixMs: now + 1_000 }, pair, now)).toBe(false);
    expect(ticketReferenceIsFresh({ ...intent(now), validUntilUnixMs: now + 20_000 }, pair, now)).toBe(false);
    expect(ticketReferenceIsFresh({ ...intent(now), observedAtUnixMs: 1.5 }, pair, now)).toBe(false);
  });
});

describe("order quote value", () => {
  it("rounds up in quote units for both buy and sell minimum-value checks", () => {
    expect(orderQuoteValue("10", "105", { price_base_scale: "100" })).toBe(11n);
    expect(orderQuoteValue("10", "100", { price_base_scale: "100" })).toBe(10n);
    expect(() => orderQuoteValue("10", "100", { price_base_scale: "0" })).toThrow(/scale/i);
  });
});
