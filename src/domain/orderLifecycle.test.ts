import { describe, expect, it } from "vitest";
import { reconcileOrderLifecycle, type LocalOrder } from "./orderLifecycle";

const pair = {
  pair_id: "STRK/USDC",
  base_asset_id: "STRK",
  quote_asset_id: "USDC",
  price_base_scale: "1000000000000000000",
};

function order(overrides: Partial<LocalOrder> = {}): LocalOrder {
  return {
    ordRef: overrides.ordRef ?? "ORD-1001",
    orderCommitment: overrides.orderCommitment ?? "0xorder",
    cancellationSecret: overrides.cancellationSecret ?? "0xcancel",
    expectedOutputMetadataCommitment: overrides.expectedOutputMetadataCommitment,
    strategyId: overrides.strategyId,
    batchId: overrides.batchId ?? "batch-1",
    epochId: overrides.epochId ?? 10,
    pair: overrides.pair ?? "STRK/USDC",
    side: overrides.side ?? "Buy",
    wireMode: overrides.wireMode ?? "Limit",
    amount: overrides.amount ?? "10",
    fundingAsset: overrides.fundingAsset,
    fundingAmount: overrides.fundingAmount,
    limitPrice: overrides.limitPrice ?? "0.30",
    minFill: overrides.minFill ?? "",
    fillOrKill: overrides.fillOrKill ?? false,
    status: overrides.status ?? "settling",
    submittedAt: overrides.submittedAt ?? 1_000,
    filledAmount: overrides.filledAmount,
    clearingPrice: overrides.clearingPrice,
    cancelTransactionHash: overrides.cancelTransactionHash,
  };
}

const deps = {
  pairs: [pair],
  formatClearingPrice: () => "0.25",
  toAtomicStr: (human: string, assetId: string) => {
    const decimals = assetId === "USDC" ? 6 : 18;
    const [whole, frac = ""] = human.split(".");
    return (BigInt(whole || "0") * 10n ** BigInt(decimals) +
      BigInt(frac.padEnd(decimals, "0").slice(0, decimals) || "0")).toString();
  },
  fromAtomicStr: (atomic: string, assetId: string) => {
    const decimals = assetId === "USDC" ? 6 : 18;
    const scale = 10n ** BigInt(decimals);
    const value = BigInt(atomic);
    const whole = value / scale;
    const frac = value % scale;
    return frac === 0n
      ? whole.toString()
      : `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
  },
  assetScale: (assetId: string) => 10n ** BigInt(assetId === "USDC" ? 6 : 18),
};

describe("order lifecycle reconciliation", () => {
  it("attributes fills by expected output metadata, not by batch alone", () => {
    const updated = reconcileOrderLifecycle({
      orders: [
        order({ ordRef: "ORD-match", expectedOutputMetadataCommitment: "0xmatch" }),
        order({ ordRef: "ORD-miss", expectedOutputMetadataCommitment: "0xmiss" }),
      ],
      batches: [{ batch_id: "batch-1", epoch_id: 10, status: "Settled" }],
      settlementTranscripts: {
        "batch-1": {
          batch_id: "batch-1",
          batch_epoch: 10,
          clearing_price: "250000",
          price_base_scale: "1000000000000000000",
        },
      },
      withdrawableNotes: [{
        source: "settlement_output",
        batch_id: "batch-1",
        asset: "STRK",
        amount: "10000000000000000000",
        metadata_commitment: "0xmatch",
      }],
      ...deps,
    });

    expect(updated.find(o => o.ordRef === "ORD-match")?.status).toBe("filled");
    expect(updated.find(o => o.ordRef === "ORD-miss")?.status).toBe("settling");
  });

  it("recovers a no_fill order when the exact output metadata arrives later", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({
        ordRef: "ORD-late",
        status: "no_fill",
        expectedOutputMetadataCommitment: "0xlate",
      })],
      batches: [{ batch_id: "batch-1", epoch_id: 10, status: "Settled" }],
      settlementTranscripts: {
        "batch-1": {
          batch_id: "batch-1",
          batch_epoch: 10,
          clearing_price: "250000",
          price_base_scale: "1000000000000000000",
        },
      },
      withdrawableNotes: [{
        source: "settlement_output",
        batch_id: "batch-1",
        asset: "STRK",
        amount: "10000000000000000000",
        metadata_commitment: "0xlate",
      }],
      ...deps,
    });

    expect(updated[0].status).toBe("filled");
  });

  it("matches output metadata commitments after felt normalization", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({
        ordRef: "ORD-normalized",
        status: "no_fill",
        expectedOutputMetadataCommitment: "0x000abc",
      })],
      batches: [{ batch_id: "batch-1", epoch_id: 10, status: "Settled" }],
      settlementTranscripts: {
        "batch-1": {
          batch_id: "batch-1",
          batch_epoch: 10,
          clearing_price: "250000",
          price_base_scale: "1000000000000000000",
        },
      },
      withdrawableNotes: [{
        source: "settlement_output",
        batch_id: "batch-1",
        asset: "STRK",
        amount: "10000000000000000000",
        metadata_commitment: "0xabc",
      }],
      ...deps,
    });

    expect(updated[0].status).toBe("filled");
  });

  it("fails old orders closed for many epochs into no_fill instead of leaving them settling", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({ expectedOutputMetadataCommitment: undefined })],
      batches: [
        { batch_id: "batch-1", epoch_id: 10, status: "Settled" },
        { batch_id: "batch-latest", epoch_id: 25, status: "Open" },
      ],
      settlementTranscripts: {
        "batch-1": {
          batch_id: "batch-1",
          batch_epoch: 10,
          clearing_price: "250000",
        },
      },
      withdrawableNotes: [],
      noFillFallbackEpochs: 10,
      ...deps,
    });

    expect(updated[0].status).toBe("no_fill");
  });

  it("uses the filled output asset when residual and fill notes share metadata", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({
        ordRef: "ORD-buy",
        side: "Buy",
        expectedOutputMetadataCommitment: "0xmeta",
      })],
      batches: [{ batch_id: "batch-1", epoch_id: 10, status: "Settled" }],
      settlementTranscripts: {
        "batch-1": {
          batch_id: "batch-1",
          batch_epoch: 10,
          clearing_price: "250000",
          price_base_scale: "1000000000000000000",
        },
      },
      withdrawableNotes: [
        {
          source: "settlement_output",
          batch_id: "batch-1",
          asset: "USDC",
          amount: "1000000",
          metadata_commitment: "0xmeta",
        },
        {
          source: "settlement_output",
          batch_id: "batch-1",
          asset: "STRK",
          amount: "10000000000000000000",
          metadata_commitment: "0xmeta",
        },
      ],
      ...deps,
    });

    expect(updated[0].status).toBe("filled");
    expect(updated[0].filledAmount).toBe("10");
  });

  it("corrects a previously terminal fill when asset-filtered output metadata is available", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({
        ordRef: "ORD-buy",
        side: "Buy",
        status: "partial",
        filledAmount: "0.000001",
        expectedOutputMetadataCommitment: "0xmeta",
      })],
      batches: [{ batch_id: "batch-1", epoch_id: 10, status: "Settled" }],
      settlementTranscripts: {
        "batch-1": {
          batch_id: "batch-1",
          batch_epoch: 10,
          clearing_price: "250000",
          price_base_scale: "1000000000000000000",
        },
      },
      withdrawableNotes: [
        {
          source: "settlement_output",
          batch_id: "batch-1",
          asset: "USDC",
          amount: "1000000",
          metadata_commitment: "0xmeta",
        },
        {
          source: "settlement_output",
          batch_id: "batch-1",
          asset: "STRK",
          amount: "10000000000000000000",
          metadata_commitment: "0xmeta",
        },
      ],
      ...deps,
    });

    expect(updated[0].status).toBe("filled");
    expect(updated[0].filledAmount).toBe("10");
  });

  it("does not mark taker-fee net output as partial when the gross order fully filled", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({
        ordRef: "ORD-buy-fee",
        side: "Buy",
        expectedOutputMetadataCommitment: "0xfee",
      })],
      batches: [{ batch_id: "batch-1", epoch_id: 10, status: "Settled" }],
      settlementTranscripts: {
        "batch-1": {
          batch_id: "batch-1",
          batch_epoch: 10,
          clearing_price: "250000",
          price_base_scale: "1000000000000000000",
        },
      },
      withdrawableNotes: [{
        source: "settlement_output",
        batch_id: "batch-1",
        asset: "STRK",
        amount: "9996000000000000000",
        metadata_commitment: "0xfee",
      }],
      ...deps,
    });

    expect(updated[0].status).toBe("filled");
    expect(updated[0].filledAmount).toBe("10");
  });

  it("recovers older filled orders by matching net output amount when metadata was not stored", () => {
    const updated = reconcileOrderLifecycle({
      orders: [
        order({
          ordRef: "ORD-sell",
          side: "Sell",
          amount: "20",
          expectedOutputMetadataCommitment: undefined,
        }),
        order({
          ordRef: "ORD-buy",
          side: "Buy",
          amount: "20",
          expectedOutputMetadataCommitment: undefined,
        }),
      ],
      batches: [{ batch_id: "batch-1", epoch_id: 10, status: "Settled" }],
      settlementTranscripts: {
        "batch-1": {
          batch_id: "batch-1",
          batch_epoch: 10,
          clearing_price: "45000",
          price_base_scale: "1000000000000000000",
        },
      },
      withdrawableNotes: [
        {
          source: "settlement_output",
          batch_id: "batch-1",
          asset: "USDC",
          amount: "899640",
          metadata_commitment: "0xsell-output",
        },
        {
          source: "settlement_output",
          batch_id: "batch-1",
          asset: "STRK",
          amount: "19992000000000000000",
          metadata_commitment: "0xbuy-output",
        },
      ],
      ...deps,
    });

    expect(updated.find(o => o.ordRef === "ORD-sell")?.status).toBe("filled");
    expect(updated.find(o => o.ordRef === "ORD-buy")?.status).toBe("filled");
    expect(updated.find(o => o.ordRef === "ORD-buy")?.filledAmount).toBe("20");
  });

  it("settles from transcript and notes even when the batch aged out of the current batch list", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({ status: "in_batch", expectedOutputMetadataCommitment: "0xmatch" })],
      batches: [{ batch_id: "batch-latest", epoch_id: 20, status: "Open" }],
      settlementTranscripts: {
        "batch-1": {
          batch_id: "batch-1",
          batch_epoch: 10,
          clearing_price: "250000",
          price_base_scale: "1000000000000000000",
        },
      },
      withdrawableNotes: [{
        source: "settlement_output",
        batch_id: "batch-1",
        asset: "STRK",
        amount: "10000000000000000000",
        metadata_commitment: "0xmatch",
      }],
      ...deps,
    });

    expect(updated[0].status).toBe("filled");
  });

  it("keeps newly closed batches as settling instead of proving", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({ status: "in_batch" })],
      batches: [
        { batch_id: "batch-1", epoch_id: 10, status: "Closed" },
        { batch_id: "batch-latest", epoch_id: 11, status: "Open" },
      ],
      settlementTranscripts: {},
      withdrawableNotes: [],
      settlementBlockedFallbackEpochs: 10,
      ...deps,
    });

    expect(updated[0].status).toBe("settling");
  });

  it("marks confirmed onchain settlement as output pending while delayed artifacts are hidden", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({ status: "settling" })],
      batches: [
        { batch_id: "batch-1", epoch_id: 10, status: "Settled" },
        { batch_id: "batch-latest", epoch_id: 11, status: "Open" },
      ],
      settlementTranscripts: {},
      proofStatuses: {
        "batch-1": {
          batch_id: "batch-1",
          state: "confirmed-onchain",
          matched_order_count: 2,
        },
      },
      withdrawableNotes: [],
      ...deps,
    });

    expect(updated[0].status).toBe("settled_pending_output");
  });

  it("releases confirmed zero-match batches before delayed artifacts publish", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({ status: "settling" })],
      batches: [
        { batch_id: "batch-1", epoch_id: 10, status: "Settled" },
        { batch_id: "batch-latest", epoch_id: 11, status: "Open" },
      ],
      settlementTranscripts: {},
      proofStatuses: {
        "batch-1": {
          batch_id: "batch-1",
          state: "confirmed-onchain",
          matched_order_count: 0,
        },
      },
      withdrawableNotes: [],
      ...deps,
    });

    expect(updated[0].status).toBe("no_fill");
  });

  it("marks proof job failures as proof_failed without waiting for epoch aging", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({ status: "settling" })],
      batches: [
        { batch_id: "batch-1", epoch_id: 10, status: "Closed" },
        { batch_id: "batch-latest", epoch_id: 11, status: "Open" },
      ],
      settlementTranscripts: {},
      proofStatuses: {
        "batch-1": {
          batch_id: "batch-1",
          state: "proving-failed",
          failure: "proving_failed",
        },
      },
      withdrawableNotes: [],
      settlementBlockedFallbackEpochs: 10,
      ...deps,
    });

    expect(updated[0].status).toBe("proof_failed");
  });

  it("marks unresolved old closed batches as stalled", () => {
    const updated = reconcileOrderLifecycle({
      orders: [order({ status: "settling" })],
      batches: [
        { batch_id: "batch-1", epoch_id: 10, status: "Closed" },
        { batch_id: "batch-latest", epoch_id: 25, status: "Open" },
      ],
      settlementTranscripts: {},
      withdrawableNotes: [],
      settlementBlockedFallbackEpochs: 10,
      ...deps,
    });

    expect(updated[0].status).toBe("stalled");
  });
});
