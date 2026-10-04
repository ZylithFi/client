import type { PairConfig } from "./deployment";

export type { PairConfig } from "./deployment";

export type ReferencePriceSnapshot = {
  /** quote units per base unit. */
  displayPrice: string;
  /** quote atoms per price-base-scale base atoms. */
  midpointPrice: string;
  priceBaseScale: string;
  observedAtUnixMs: number;
  validUntilUnixMs: number;
};

/** what the ticket asks for, in human units: the app turns it into an order draft. */
export type TicketSubmitIntent = {
  pairId: string;
  side: "Buy" | "Sell";
  /** quote to spend on a buy, base to sell on a sell. */
  payAmount: string;
  /** exact authenticated quote atoms per price-base-scale base atoms. */
  midpointPrice: string;
  priceBaseScale: string;
  observedAtUnixMs: number;
  validUntilUnixMs: number;
  external: boolean;
};

export function ticketReferenceIsFresh(
  intent: TicketSubmitIntent,
  pair: PairConfig,
  nowUnixMs = Date.now(),
) {
  return /^(0|[1-9]\d{0,38})$/.test(intent.midpointPrice)
    && BigInt(intent.midpointPrice) > 0n
    && intent.priceBaseScale === pair.price_base_scale
    && Number.isSafeInteger(intent.observedAtUnixMs)
    && Number.isSafeInteger(intent.validUntilUnixMs)
    && intent.observedAtUnixMs > 0
    && nowUnixMs - intent.observedAtUnixMs <= (pair.reference_max_age_ms ?? 15_000)
    && intent.observedAtUnixMs - nowUnixMs <= 5_000
    && intent.validUntilUnixMs >= nowUnixMs
    && intent.validUntilUnixMs >= intent.observedAtUnixMs
    && intent.validUntilUnixMs - intent.observedAtUnixMs
      <= (pair.reference_attestation_ttl_ms ?? 15_000);
}

/** the exact quote atoms committed by an order at its protected execution price. */
export function orderQuoteValue(
  amount: string,
  limitPrice: string,
  pair: Pick<PairConfig, "price_base_scale">,
): bigint {
  const numerator = BigInt(amount) * BigInt(limitPrice);
  const denominator = BigInt(pair.price_base_scale);
  if (denominator <= 0n) throw new Error("Order price scale is invalid");
  return (numerator + denominator - 1n) / denominator;
}
