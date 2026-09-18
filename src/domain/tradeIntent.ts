export type TicketShape = "limit" | "strategy";
export type StratKind = "Repeat";
export type ExecutionPreference = "PrivateOnly" | "PrivateThenExternal";

export type PairConfig = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  min_order_amount: string;
  price_base_scale?: string;
  taker_fee_bps?: number;
  external_match_enabled: boolean;
  enabled: boolean;
};

export type ReferencePriceSnapshot = {
  displayPrice: string;
  midpointPrice: string;
  priceBaseScale?: string;
  observedAtUnixMs?: number;
};

export type TicketSubmitIntent = {
  pairId?: string;
  side: "Buy" | "Sell";
  shape: TicketShape;
  stratKind: StratKind;
  amount: string;
  limitPrice: string;
  minFill: string;
  fillOrKill: boolean;
  durationHours: string;
  childSize: string;
  priceLimit: string;
  jitter: number;
  executionPreference: ExecutionPreference;
  keepTryingPrivate: boolean;
  retryHours: string;
  relayMode?: "SelfRelay" | "ZylithRelay";
  relayOperator?: "ZylithRelay" | "SelfHostedRelay";
  selfRelayUrl?: string;
};

export type FundingPreview = {
  asset: string;
  required: string;
  selected_total: string;
  expected_change: string;
  notes: Array<{
    note_commitment: string;
    asset: string;
    amount: string;
    source: "deposit" | "settlement_output";
  }>;
};
