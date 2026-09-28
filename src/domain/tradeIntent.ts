export type { PairConfig } from "./deployment";

export type ReferencePriceSnapshot = {
  /** quote units per base unit. */
  displayPrice: string;
  /** quote atoms per price-base-scale base atoms. */
  midpointPrice: string;
  priceBaseScale: string;
  observedAtUnixMs: number;
};

/** what the ticket asks for, in human units: the app turns it into an order draft. */
export type TicketSubmitIntent = {
  pairId: string;
  side: "Buy" | "Sell";
  /** quote to spend on a buy, base to sell on a sell. */
  payAmount: string;
  /** quote units per base unit. */
  limitPrice: string;
  external: boolean;
};
