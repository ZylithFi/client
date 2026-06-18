import type {
  LocalOrder,
  LocalOrderStatus,
  PrivateStrategySummary,
} from "./orderLifecycle";
import type {
  BatchSummary,
  PublicSettlementTranscript,
} from "./auctionEpoch";
import type {
  PendingDeposit,
  WalletBalance,
  WithdrawableNote,
} from "./shieldedBalances";

const DEMO_ORDERS_SESSION_KEY = "zylith.demo.orders";

export type DemoOrdersFixture = {
  orders: LocalOrder[];
  strategies: PrivateStrategySummary[];
  batches: BatchSummary[];
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  withdrawableNotes: WithdrawableNote[];
};

export function demoOrdersFixtureEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "orders") {
      window.sessionStorage.setItem(DEMO_ORDERS_SESSION_KEY, "1");
      return true;
    }
    return window.sessionStorage.getItem(DEMO_ORDERS_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function buildDemoOrdersFixture(now = Date.now()): DemoOrdersFixture {
  const strategyId = "demo-resting-strk-usdc";
  const pairId = "STRK/USDC";
  const baseAsset = "STRK";
  const quoteAsset = "USDC";
  const priceBaseScale = "1000000000000000000";
  const childBaseAtomic = "10000000000000000000";
  const childBaseDisplay = "10";
  const childQuoteDisplay = "0.24";
  const childCommitment = (epoch: number) => `0x0demo_child_${epoch}`;
  const metadataCommitment = (epoch: number) => `0x0demo_meta_${epoch}`;
  const fundingCommitment = (epoch: number) => `0x0demo_funding_${epoch}`;
  const batchId = (epoch: number) => `demo-batch-${epoch}`;
  const submittedAt = (epoch: number) =>
    now - (112 - epoch) * 12 * 60 * 1000;
  const batch = (
    epoch: number,
    status: BatchSummary["status"],
    orderCountBucket = "2-5"
  ): BatchSummary => ({
    batch_id: batchId(epoch),
    pair_id: pairId,
    epoch_id: epoch,
    close_time_unix_ms: now - (112 - epoch) * 12 * 60 * 1000,
    status,
    order_count_bucket: orderCountBucket,
  });
  const transcript = (
    epoch: number,
    clearingPrice: string
  ): PublicSettlementTranscript => ({
    batch_id: batchId(epoch),
    pair_id: pairId,
    batch_epoch: epoch,
    clearing_price: clearingPrice,
    price_base_scale: priceBaseScale,
    settled_at_unix_ms: submittedAt(epoch) + 7 * 60 * 1000,
    loaded_at_unix_ms: now,
  });
  const childOrder = (
    epoch: number,
    status: LocalOrderStatus,
    overrides: Partial<LocalOrder> = {}
  ): LocalOrder => ({
    deployment_scope: "demo:orders",
    ordRef: `DEMO-${epoch}`,
    orderCommitment: childCommitment(epoch),
    cancellationSecret: `0x0demo_cancel_${epoch}`,
    expectedOutputMetadataCommitment: metadataCommitment(epoch),
    fundingNoteCommitments: [fundingCommitment(epoch)],
    strategyId,
    batchId: batchId(epoch),
    epochId: epoch,
    pair: pairId,
    side: "Buy",
    wireMode: "Resting",
    amount: childBaseDisplay,
    fundingAsset: quoteAsset,
    fundingAmount: childQuoteDisplay,
    limitPrice: "0.0240",
    minFill: "2",
    fillOrKill: false,
    status,
    submittedAt: submittedAt(epoch),
    makerCurvePoints: [
      { price: "0.0236", baseAmount: "3" },
      { price: "0.0240", baseAmount: "4" },
      { price: "0.0245", baseAmount: "3" },
    ],
    relayMode: "ZylithRelay",
    relayFeeBps: 2,
    ...overrides,
  });

  const children = [104, 105, 106, 107, 108, 109, 110, 111].map((epoch) => ({
    parent_child_index: epoch - 103,
    batch_id: batchId(epoch),
    epoch_id: epoch,
    order_commitment: childCommitment(epoch),
    cancellation_secret: `0x0demo_cancel_${epoch}`,
    expected_output_metadata_commitment: metadataCommitment(epoch),
    funding_note_commitments: [fundingCommitment(epoch)],
    relay_status:
      epoch === 110 ? "submitted" : epoch === 111 ? "due" : "accepted",
    submitted_at_unix_ms: submittedAt(epoch),
    delegated: true,
  }));

  const strategy: PrivateStrategySummary = {
    id: strategyId,
    parent_order_commitment: "0x0demo_parent_curve",
    mode: "Resting",
    pair: pairId,
    side: "Buy",
    status: "active",
    total_amount: "120000000000000000000",
    remaining_amount: "40000000000000000000",
    child_amount: childBaseAtomic,
    limit_price: "24000000000000000",
    price_base_scale: priceBaseScale,
    min_fill: "2000000000000000000",
    fill_or_kill: false,
    maker_curve_points: [
      { price: "23600", base_amount: "3000000000000000000" },
      { price: "24000", base_amount: "4000000000000000000" },
      { price: "24500", base_amount: "3000000000000000000" },
    ],
    maker_inventory_cap: "120000000000000000000",
    renewal_window_children: 3,
    max_children: 12,
    next_child_index: 9,
    start_epoch: 104,
    end_epoch: 115,
    offline_package: {
      package_id: "demo-package-resting-strk-usdc",
      package_commitment: "0x0demo_package_commitment",
      created_at_unix_ms: now - 2 * 60 * 60 * 1000,
      start_epoch: 104,
      end_epoch: 115,
      slot_count: 12,
      relay_mode: "ZylithRelay",
      parent_cancel_authority: "0x0demo_cancel_authority",
      relay_authorization: {
        signer_public_key: "0x0demo_relay_signer",
        signature_r: "0x01",
        signature_s: "0x02",
      },
    },
    submitted_children: children,
  };

  const ethStrategyId = "demo-resting-eth-usdc";
  const ethChildren = [92, 93, 94, 95, 96, 97, 98, 99, 100].map(
    (epoch, index) => ({
      parent_child_index: index + 1,
      batch_id: batchId(epoch),
      epoch_id: epoch,
      order_commitment: `0x0demo_eth_child_${epoch}`,
      cancellation_secret: `0x0demo_eth_cancel_${epoch}`,
      expected_output_metadata_commitment: `0x0demo_eth_meta_${epoch}`,
      funding_note_commitments: [`0x0demo_eth_funding_${epoch}`],
      relay_status: epoch === 100 ? "submitted" : "accepted",
      submitted_at_unix_ms: submittedAt(epoch),
      delegated: true,
    })
  );
  const ethStrategy: PrivateStrategySummary = {
    id: ethStrategyId,
    parent_order_commitment: "0x0demo_eth_parent",
    mode: "Resting",
    pair: "ETH/USDC",
    side: "Sell",
    status: "active",
    total_amount: "24000000000000000000",
    remaining_amount: "6000000000000000000",
    child_amount: "2000000000000000000",
    limit_price: "3300000000000000000000",
    price_base_scale: priceBaseScale,
    min_fill: "500000000000000000",
    fill_or_kill: false,
    maker_curve_points: [
      { price: "3300000000", base_amount: "600000000000000000" },
      { price: "3340000000", base_amount: "700000000000000000" },
      { price: "3380000000", base_amount: "700000000000000000" },
    ],
    maker_inventory_cap: "24000000000000000000",
    renewal_window_children: 3,
    max_children: 12,
    next_child_index: 10,
    start_epoch: 92,
    end_epoch: 103,
    offline_package: {
      package_id: "demo-package-eth-usdc",
      package_commitment: "0x0demo_eth_package",
      created_at_unix_ms: now - 3 * 60 * 60 * 1000,
      start_epoch: 92,
      end_epoch: 103,
      slot_count: 12,
      relay_mode: "SelfRelay",
      parent_cancel_authority: "0x0demo_eth_cancel_authority",
    },
    submitted_children: ethChildren,
  };

  const btcStrategyId = "demo-paused-strkbtc-usdc";
  const btcChildren = [84, 85, 86, 87].map((epoch, index) => ({
    parent_child_index: index + 1,
    batch_id: batchId(epoch),
    epoch_id: epoch,
    order_commitment: `0x0demo_btc_child_${epoch}`,
    cancellation_secret: `0x0demo_btc_cancel_${epoch}`,
    expected_output_metadata_commitment: `0x0demo_btc_meta_${epoch}`,
    funding_note_commitments: [`0x0demo_btc_funding_${epoch}`],
    relay_status: "accepted",
    submitted_at_unix_ms: submittedAt(epoch),
    delegated: true,
  }));
  const btcStrategy: PrivateStrategySummary = {
    id: btcStrategyId,
    parent_order_commitment: "0x0demo_btc_parent",
    mode: "Resting",
    pair: "strkBTC/USDC",
    side: "Buy",
    status: "paused",
    total_amount: "240000000",
    remaining_amount: "180000000",
    child_amount: "15000000",
    limit_price: "67400000000000000000000",
    price_base_scale: priceBaseScale,
    min_fill: "5000000",
    fill_or_kill: false,
    maker_curve_points: [
      { price: "67400000000", base_amount: "5000000" },
      { price: "66900000000", base_amount: "5000000" },
      { price: "66400000000", base_amount: "5000000" },
    ],
    maker_inventory_cap: "240000000",
    renewal_window_children: 4,
    max_children: 16,
    next_child_index: 5,
    start_epoch: 84,
    end_epoch: 99,
    offline_package: {
      package_id: "demo-package-strkbtc-usdc",
      package_commitment: "0x0demo_btc_package",
      created_at_unix_ms: now - 6 * 60 * 60 * 1000,
      start_epoch: 84,
      end_epoch: 99,
      slot_count: 16,
      relay_mode: "ZylithRelay",
      parent_cancel_authority: "0x0demo_btc_cancel_authority",
    },
    submitted_children: btcChildren,
  };

  const completedStrategyId = "demo-completed-usdc-usdt";
  const completedChildren = [70, 71, 72, 73, 74, 75].map((epoch, index) => ({
    parent_child_index: index + 1,
    batch_id: batchId(epoch),
    epoch_id: epoch,
    order_commitment: `0x0demo_stable_child_${epoch}`,
    cancellation_secret: `0x0demo_stable_cancel_${epoch}`,
    expected_output_metadata_commitment: `0x0demo_stable_meta_${epoch}`,
    funding_note_commitments: [`0x0demo_stable_funding_${epoch}`],
    relay_status: "accepted",
    submitted_at_unix_ms: submittedAt(epoch),
    delegated: true,
  }));
  const completedStrategy: PrivateStrategySummary = {
    id: completedStrategyId,
    parent_order_commitment: "0x0demo_stable_parent",
    mode: "Resting",
    pair: "USDC/USDT",
    side: "Sell",
    status: "completed",
    total_amount: "6000000000",
    remaining_amount: "0",
    child_amount: "1000000000",
    limit_price: "999800000000000000",
    price_base_scale: priceBaseScale,
    min_fill: "250000000",
    fill_or_kill: false,
    maker_curve_points: [
      { price: "999800", base_amount: "300000000" },
      { price: "1000000", base_amount: "400000000" },
      { price: "1000200", base_amount: "300000000" },
    ],
    maker_inventory_cap: "6000000000",
    renewal_window_children: 3,
    max_children: 6,
    next_child_index: 7,
    start_epoch: 70,
    end_epoch: 75,
    submitted_children: completedChildren,
  };

  const ethOrder = (
    epoch: number,
    status: LocalOrderStatus,
    overrides: Partial<LocalOrder> = {}
  ): LocalOrder =>
    childOrder(epoch, status, {
      ordRef: `DEMO-ETH-${epoch}`,
      orderCommitment: `0x0demo_eth_child_${epoch}`,
      cancellationSecret: `0x0demo_eth_cancel_${epoch}`,
      expectedOutputMetadataCommitment: `0x0demo_eth_meta_${epoch}`,
      fundingNoteCommitments: [`0x0demo_eth_funding_${epoch}`],
      strategyId: ethStrategyId,
      pair: "ETH/USDC",
      side: "Sell",
      amount: "2",
      fundingAsset: "ETH",
      fundingAmount: "2",
      limitPrice: "3,300",
      minFill: "0.5",
      makerCurvePoints: [
        { price: "3,300", baseAmount: "0.6" },
        { price: "3,340", baseAmount: "0.7" },
        { price: "3,380", baseAmount: "0.7" },
      ],
      relayMode: "SelfRelay",
      relayFeeBps: 0,
      ...overrides,
    });
  const btcOrder = (
    epoch: number,
    status: LocalOrderStatus,
    overrides: Partial<LocalOrder> = {}
  ): LocalOrder =>
    childOrder(epoch, status, {
      ordRef: `DEMO-BTC-${epoch}`,
      orderCommitment: `0x0demo_btc_child_${epoch}`,
      cancellationSecret: `0x0demo_btc_cancel_${epoch}`,
      expectedOutputMetadataCommitment: `0x0demo_btc_meta_${epoch}`,
      fundingNoteCommitments: [`0x0demo_btc_funding_${epoch}`],
      strategyId: btcStrategyId,
      pair: "strkBTC/USDC",
      side: "Buy",
      amount: "0.15",
      fundingAsset: quoteAsset,
      fundingAmount: "10,110",
      limitPrice: "67,400",
      minFill: "0.05",
      makerCurvePoints: [
        { price: "67,400", baseAmount: "0.05" },
        { price: "66,900", baseAmount: "0.05" },
        { price: "66,400", baseAmount: "0.05" },
      ],
      ...overrides,
    });
  const stableOrder = (
    epoch: number,
    status: LocalOrderStatus,
    overrides: Partial<LocalOrder> = {}
  ): LocalOrder =>
    childOrder(epoch, status, {
      ordRef: `DEMO-STABLE-${epoch}`,
      orderCommitment: `0x0demo_stable_child_${epoch}`,
      cancellationSecret: `0x0demo_stable_cancel_${epoch}`,
      expectedOutputMetadataCommitment: `0x0demo_stable_meta_${epoch}`,
      fundingNoteCommitments: [`0x0demo_stable_funding_${epoch}`],
      strategyId: completedStrategyId,
      pair: "USDC/USDT",
      side: "Sell",
      amount: "1,000",
      fundingAsset: "USDC",
      fundingAmount: "1,000",
      limitPrice: "0.9998",
      minFill: "250",
      makerCurvePoints: [
        { price: "0.9998", baseAmount: "300" },
        { price: "1.0000", baseAmount: "400" },
        { price: "1.0002", baseAmount: "300" },
      ],
      relayMode: "SelfRelay",
      relayFeeBps: 0,
      ...overrides,
    });
  const takerOrder = (
    epoch: number,
    status: LocalOrderStatus,
    overrides: Partial<LocalOrder> = {}
  ): LocalOrder => ({
    deployment_scope: "demo:orders",
    ordRef: `DEMO-TAKER-${epoch}`,
    orderCommitment: `0x0demo_taker_${epoch}`,
    cancellationSecret: `0x0demo_taker_cancel_${epoch}`,
    expectedOutputMetadataCommitment: `0x0demo_taker_meta_${epoch}`,
    fundingNoteCommitments: [`0x0demo_taker_funding_${epoch}`],
    batchId: batchId(epoch),
    epochId: epoch,
    pair: pairId,
    side: "Buy",
    wireMode: "Limit",
    amount: "18",
    fundingAsset: quoteAsset,
    fundingAmount: "0.45",
    limitPrice: "0.0250",
    minFill: "5",
    fillOrKill: false,
    status,
    submittedAt: submittedAt(epoch),
    arrivalReferencePrice: "0.0241",
    arrivalReferenceSource: "last_clearing",
    arrivalReferenceAt: submittedAt(epoch) - 30_000,
    ...overrides,
  });

  const orders: LocalOrder[] = [
    childOrder(111, "in_batch", {
      ordRef: "DEMO-CURVE-ACTIVE",
      orderCommitment: "0x0demo_parent_curve",
      expectedOutputMetadataCommitment: "0x0demo_meta_parent",
      batchId: batchId(111),
      epochId: 111,
    }),
    childOrder(110, "settling", { ordRef: "DEMO-110-SETTLING" }),
    childOrder(109, "proving", { ordRef: "DEMO-109-PROVING" }),
    childOrder(108, "proof_failed", { ordRef: "DEMO-108-ATTENTION" }),
    childOrder(107, "no_fill", { ordRef: "DEMO-107-NOFILL" }),
    childOrder(106, "partial", {
      ordRef: "DEMO-106-PARTIAL",
      filledAmount: "5",
      clearingPrice: "0.0239",
    }),
    childOrder(105, "filled", {
      ordRef: "DEMO-105-FILLED",
      filledAmount: "10",
      clearingPrice: "0.0238",
    }),
    childOrder(104, "no_fill", { ordRef: "DEMO-104-NOFILL" }),
    ethOrder(100, "settling"),
    ethOrder(99, "partial", { filledAmount: "0.9", clearingPrice: "3,312" }),
    ethOrder(98, "filled", { filledAmount: "2", clearingPrice: "3,303" }),
    ethOrder(97, "no_fill"),
    ethOrder(96, "filled", { filledAmount: "2", clearingPrice: "3,298" }),
    ethOrder(95, "partial", { filledAmount: "1.1", clearingPrice: "3,307" }),
    ethOrder(94, "filled", { filledAmount: "2", clearingPrice: "3,301" }),
    ethOrder(93, "no_fill"),
    ethOrder(92, "filled", { filledAmount: "2", clearingPrice: "3,295" }),
    btcOrder(87, "in_batch"),
    btcOrder(86, "in_batch"),
    btcOrder(85, "no_fill"),
    btcOrder(84, "filled", { filledAmount: "0.08", clearingPrice: "67,820" }),
    stableOrder(75, "filled", { filledAmount: "1,000", clearingPrice: "1.0001" }),
    stableOrder(74, "filled", { filledAmount: "1,000", clearingPrice: "1.0000" }),
    stableOrder(73, "partial", { filledAmount: "620", clearingPrice: "0.9999" }),
    stableOrder(72, "no_fill"),
    stableOrder(71, "filled", { filledAmount: "1,000", clearingPrice: "1.0001" }),
    stableOrder(70, "filled", { filledAmount: "1,000", clearingPrice: "1.0000" }),
    takerOrder(112, "queued", { ordRef: "DEMO-TAKER-QUEUED" }),
    takerOrder(111, "in_batch", {
      ordRef: "DEMO-TAKER-IN-BATCH",
      side: "Sell",
      amount: "14",
      fundingAsset: baseAsset,
      fundingAmount: "14",
      limitPrice: "0.0248",
      minFill: "4",
    }),
    takerOrder(110, "settling", { ordRef: "DEMO-TAKER-SETTLING" }),
    takerOrder(109, "proving", {
      ordRef: "DEMO-TAKER-PROVING",
      side: "Sell",
      amount: "30",
      fundingAsset: baseAsset,
      fundingAmount: "30",
      limitPrice: "0.0243",
      minFill: "12",
    }),
    takerOrder(107, "no_fill", {
      ordRef: "DEMO-TAKER-NO-FILL",
      side: "Sell",
      amount: "20",
      fundingAsset: baseAsset,
      fundingAmount: "20",
      limitPrice: "0.0268",
      minFill: "20",
      fillOrKill: true,
    }),
    takerOrder(106, "partial", {
      ordRef: "DEMO-TAKER-PARTIAL",
      amount: "40",
      fundingAmount: "0.96",
      limitPrice: "0.0240",
      minFill: "10",
      filledAmount: "24",
      clearingPrice: "0.0239",
    }),
    takerOrder(103, "filled", {
      ordRef: "DEMO-TAKER-FILLED",
      orderCommitment: "0x0demo_taker_fill",
      cancellationSecret: "0x0demo_taker_cancel",
      expectedOutputMetadataCommitment: "0x0demo_taker_meta",
      fundingNoteCommitments: ["0x0demo_taker_funding"],
      side: "Sell",
      amount: "25",
      fundingAsset: baseAsset,
      fundingAmount: "25",
      limitPrice: "0.0242",
      minFill: "10",
      filledAmount: "25",
      clearingPrice: "0.0244",
    }),
    takerOrder(102, "cancelled", {
      ordRef: "DEMO-TAKER-CANCELLED",
      side: "Buy",
      amount: "50",
      fundingAmount: "1.15",
      limitPrice: "0.0230",
      cancelTransactionHash: "0x0demo_cancelled_transaction",
    }),
    takerOrder(101, "proof_failed", {
      ordRef: "DEMO-TAKER-ATTENTION",
      side: "Sell",
      amount: "12",
      fundingAsset: baseAsset,
      fundingAmount: "12",
      limitPrice: "0.0255",
      minFill: "3",
    }),
  ];

  const settlementTranscripts = [103, 105, 106, 107].reduce<
    Record<string, PublicSettlementTranscript>
  >((acc, epoch) => {
    acc[batchId(epoch)] = transcript(
      epoch,
      epoch === 103 ? "24400000000000000" : "23900000000000000"
    );
    return acc;
  }, {});

  return {
    orders,
    strategies: [strategy, ethStrategy, btcStrategy, completedStrategy],
    batches: [
      batch(112, "Open", "1"),
      batch(111, "Open", "2-5"),
      batch(110, "Settling"),
      batch(109, "Proving"),
      batch(108, "Closed"),
      batch(107, "Settled"),
      batch(106, "Settled"),
      batch(105, "Settled"),
      batch(104, "Settled", "0"),
      batch(103, "Settled"),
      batch(102, "Cancelled"),
      batch(101, "Closed"),
      { ...batch(100, "Settling"), pair_id: "ETH/USDC" },
      { ...batch(99, "Settled"), pair_id: "ETH/USDC" },
      { ...batch(98, "Settled"), pair_id: "ETH/USDC" },
      { ...batch(97, "Settled"), pair_id: "ETH/USDC" },
      { ...batch(96, "Settled"), pair_id: "ETH/USDC" },
      { ...batch(95, "Settled"), pair_id: "ETH/USDC" },
      { ...batch(94, "Settled"), pair_id: "ETH/USDC" },
      { ...batch(93, "Settled"), pair_id: "ETH/USDC" },
      { ...batch(92, "Settled"), pair_id: "ETH/USDC" },
      { ...batch(87, "Open"), pair_id: "strkBTC/USDC" },
      { ...batch(86, "Open"), pair_id: "strkBTC/USDC" },
      { ...batch(85, "Settled"), pair_id: "strkBTC/USDC" },
      { ...batch(84, "Settled"), pair_id: "strkBTC/USDC" },
      { ...batch(75, "Settled"), pair_id: "USDC/USDT" },
      { ...batch(74, "Settled"), pair_id: "USDC/USDT" },
      { ...batch(73, "Settled"), pair_id: "USDC/USDT" },
      { ...batch(72, "Settled"), pair_id: "USDC/USDT" },
      { ...batch(71, "Settled"), pair_id: "USDC/USDT" },
      { ...batch(70, "Settled"), pair_id: "USDC/USDT" },
    ],
    settlementTranscripts,
    balances: [
      {
        asset: quoteAsset,
        available: "126000000",
        locked: "690000",
      },
      {
        asset: baseAsset,
        available: "180000000000000000000",
        locked: "30000000000000000000",
      },
      {
        asset: "ETH",
        available: "18000000000000000000",
        locked: "6000000000000000000",
      },
      {
        asset: "strkBTC",
        available: "120000000",
        locked: "60000000",
      },
    ],
    pendingDeposits: [
      {
        note_commitment: "0x0demo_pending_deposit",
        asset: quoteAsset,
        amount: "25000000",
        request_id: "demo-deposit-request",
        requested_at_unix_ms: now - 9 * 60 * 1000,
        confirmed: false,
      },
    ],
    withdrawableNotes: [
      {
        note_commitment: "0x0demo_output_105",
        batch_id: batchId(105),
        source: "settlement_output",
        asset: baseAsset,
        amount: "10000000000000000000",
        locked: false,
        spent: false,
        metadata_commitment: metadataCommitment(105),
      },
      {
        note_commitment: "0x0demo_output_106",
        batch_id: batchId(106),
        source: "settlement_output",
        asset: baseAsset,
        amount: "5000000000000000000",
        locked: false,
        spent: false,
        metadata_commitment: metadataCommitment(106),
      },
      {
        note_commitment: "0x0demo_taker_output",
        batch_id: "demo-batch-103",
        source: "settlement_output",
        asset: quoteAsset,
        amount: "610000",
        locked: false,
        spent: false,
        metadata_commitment: "0x0demo_taker_meta",
      },
    ],
  };
}
