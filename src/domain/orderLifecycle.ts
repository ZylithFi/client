import type { LiquidityBandPoint } from "./liquidityBands";
import type { LiquidityBandAttribution } from "./shieldedBalances";

export type LocalOrderWireMode =
  | "Limit"
  | "Liquidity Position"
  | "TWAP"
  | "VWAP"
  | "Repeat"
  | "Resting";

export type LocalOrderStatus =
  | "queued" | "in_batch" | "proving" | "settling" | "settled_pending_output"
  | "filled" | "partial" | "no_fill" | "rolled" | "cancelled" | "failed"
  | "proof_failed" | "stalled";

export type LocalOrder = {
  deployment_scope?: string;
  ordRef: string;
  orderCommitment: string;
  cancellationSecret: string;
  expectedOutputMetadataCommitment?: string;
  fundingNoteCommitments?: string[];
  strategyId?: string;
  batchId: string;
  epochId: number;
  pair: string;
  side: "Buy" | "Sell";
  wireMode: LocalOrderWireMode;
  amount: string;
  fundingAsset?: string;
  fundingAmount?: string;
  limitPrice: string;
  minFill: string;
  fillOrKill: boolean;
  status: LocalOrderStatus;
  submittedAt: number;
  filledAmount?: string;
  clearingPrice?: string;
  arrivalReferencePrice?: string;
  arrivalReferenceSource?: "last_clearing";
  arrivalReferenceAt?: number;
  cancelTransactionHash?: string;
  liquidityBandPoints?: LiquidityBandPoint[];
  liquidityBandAttribution?: LiquidityBandAttribution;
  relayMode?: "SelfRelay" | "ZylithRelay";
  relayFeeBps?: number;
};

export function orderLiquidityBandPoints(
  order: Pick<LocalOrder, "liquidityBandPoints">,
): LocalOrder["liquidityBandPoints"] {
  return order.liquidityBandPoints;
}

export function orderLiquidityBandAttribution(
  order: Pick<LocalOrder, "liquidityBandAttribution">,
): LocalOrder["liquidityBandAttribution"] {
  return order.liquidityBandAttribution;
}

export function normalizeLocalOrder(order: LocalOrder): LocalOrder {
  return {
    ...order,
    wireMode: normalizeLocalOrderWireMode((order as { wireMode?: unknown }).wireMode),
    liquidityBandPoints: orderLiquidityBandPoints(order),
    liquidityBandAttribution: orderLiquidityBandAttribution(order),
  };
}

function normalizeLocalOrderWireMode(value: unknown): LocalOrderWireMode {
  if (
    value === "Limit" ||
    value === "Liquidity Position" ||
    value === "TWAP" ||
    value === "VWAP" ||
    value === "Repeat" ||
    value === "Resting"
  ) {
    return value;
  }
  return "Limit";
}

export type PrivateStrategyChildSummary = {
  parent_child_index: number;
  batch_id: string;
  epoch_id: number;
  order_commitment?: string;
  cancellation_secret?: string;
  expected_output_metadata_commitment?: string;
  funding_note_commitments?: string[];
  relay_status?: string;
  relay_detail?: string;
  submitted_at_unix_ms: number;
  delegated?: boolean;
};

export type PrivateStrategySummary = {
  id: string;
  parent_order_commitment?: string;
  mode: "TWAP" | "VWAP" | "Repeat" | "Resting";
  pair: string;
  side?: "Buy" | "Sell";
  status: "active" | "delegated" | "pending_relay" | "paused" | "completed" | "failed" | "cancelled";
  total_amount: string;
  remaining_amount: string;
  child_amount: string;
  limit_price?: string;
  price_base_scale?: string;
  min_fill?: string;
  fill_or_kill?: boolean;
  liquidity_curve_points?: Array<{ price: string; base_amount: string }>;
  liquidity_inventory_cap?: string;
  renewal_window_children?: number;
  max_children: number;
  next_child_index: number;
  start_epoch: number;
  end_epoch: number;
  offline_package?: {
    package_id: string;
    package_commitment: string;
    created_at_unix_ms: number;
    start_epoch: number;
    end_epoch: number;
    slot_count: number;
    relay_mode?: "SelfRelay" | "ZylithRelay";
    parent_cancel_authority?: string;
    relay_authorization?: {
      signer_public_key: string;
      signature_r: string;
      signature_s: string;
    };
  };
  parent_cancel_transaction_hash?: string;
  last_error?: string;
  submitted_children: PrivateStrategyChildSummary[];
};

export type OrderLifecycleBatch = {
  batch_id: string;
  epoch_id?: number;
  status: "Open" | "Closed" | "Clearing" | "Settled" | "Cancelled" | "Proving" | "Settling";
};

export type OrderLifecyclePair = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  price_base_scale?: string;
  taker_fee_bps?: number;
  relay_fee_bps?: number;
};

export type OrderLifecycleTranscript = {
  batch_id: string;
  batch_epoch: number;
  clearing_price: string | number;
  price_base_scale?: string | number;
};

export type OrderLifecycleProofStatus = {
  batch_id: string;
  state: string;
  matched_order_count?: number;
  reuse_state?: "no_fill" | "matched" | "unknown";
  failure?: string | null;
};

export type OrderLifecycleOutputNote = {
  source: "deposit" | "settlement_output";
  batch_id?: string;
  asset: string;
  amount: string;
  metadata_commitment: string;
  liquidity_provider_attribution?: LiquidityBandAttribution;
};

function noteLiquidityAttribution(
  note: OrderLifecycleOutputNote | undefined,
): LiquidityBandAttribution | undefined {
  return note?.liquidity_provider_attribution;
}

export function statusLabel(s: LocalOrderStatus): string {
  const m: Record<LocalOrderStatus, string> = {
    queued: "Queued", in_batch: "In batch", proving: "Proving",
    settling: "Settling", settled_pending_output: "Output pending",
    filled: "Filled", partial: "Partial",
    no_fill: "No fill", rolled: "Rolled", cancelled: "Cancelled", failed: "Failed",
    proof_failed: "Proof failed", stalled: "Stalled",
  };
  return m[s];
}

export function statusTone(s: LocalOrderStatus): string {
  if (s === "filled" || s === "partial") return "good";
  if (s === "in_batch" || s === "proving" || s === "settling" || s === "settled_pending_output") return "info";
  if (s === "queued") return "muted";
  if (s === "rolled" || s === "no_fill") return "warn";
  if (s === "stalled") return "warn";
  if (s === "proof_failed") return "danger";
  return "danger";
}

export function isLiquidityPositionOrder(order: LocalOrder): boolean {
  const wireMode = normalizeLocalOrderWireMode((order as { wireMode?: unknown }).wireMode);
  return Boolean(order.strategyId) ||
    wireMode === "Liquidity Position" ||
    wireMode === "Resting";
}

function isPrivateReportTerminalStatus(status: LocalOrderStatus): boolean {
  return status === "filled" || status === "partial" || status === "no_fill";
}

export function ordersChanged(before: LocalOrder[], after: LocalOrder[]): boolean {
  if (before.length !== after.length) return true;
  return after.some((order, index) => {
    const previous = before[index];
    return (
      order.status !== previous.status ||
      order.clearingPrice !== previous.clearingPrice ||
      order.filledAmount !== previous.filledAmount ||
      order.fundingAsset !== previous.fundingAsset ||
      order.fundingAmount !== previous.fundingAmount ||
      order.relayMode !== previous.relayMode ||
      order.relayFeeBps !== previous.relayFeeBps ||
      JSON.stringify(order.fundingNoteCommitments ?? []) !== JSON.stringify(previous.fundingNoteCommitments ?? []) ||
      order.cancelTransactionHash !== previous.cancelTransactionHash ||
      order.liquidityBandAttribution !== previous.liquidityBandAttribution
    );
  });
}

export function reconcileOrderLifecycle({
  orders,
  batches,
  settlementTranscripts,
  proofStatuses,
  withdrawableNotes,
  pairs,
    noFillDisplayAfterEpochs = 10,
    stalledDisplayAfterEpochs = 10,
  formatClearingPrice,
  toAtomicStr,
  fromAtomicStr,
  assetScale,
}: {
  orders: LocalOrder[];
  batches: OrderLifecycleBatch[];
  settlementTranscripts: Record<string, OrderLifecycleTranscript>;
  proofStatuses?: Record<string, OrderLifecycleProofStatus>;
  withdrawableNotes: OrderLifecycleOutputNote[];
  pairs: OrderLifecyclePair[];
  noFillDisplayAfterEpochs?: number;
  stalledDisplayAfterEpochs?: number;
  formatClearingPrice: (price: {
    batchId: string;
    epochId: number;
    clearingPrice: string;
    priceBaseScale?: string;
  }, pair: OrderLifecyclePair) => string;
  toAtomicStr: (human: string, assetId: string) => string;
  fromAtomicStr: (atomic: string, assetId: string) => string;
  assetScale: (assetId: string) => bigint;
}): LocalOrder[] {
  if (orders.length === 0 || batches.length === 0) return orders;

  const settlementOutputs = new Map<string, OrderLifecycleOutputNote[]>();
  const batchesById = new Map(
    batches.map(batch => [batch.batch_id, batch] as const),
  );
  const pairsById = new Map(
    pairs.map(pair => [pair.pair_id, pair] as const),
  );
  const latestEpoch = batches.reduce(
    (max, batch) => Math.max(max, batch.epoch_id ?? 0),
    0,
  );
  for (const note of withdrawableNotes) {
    if (note.source !== "settlement_output" || !note.batch_id) continue;
    const outputs = settlementOutputs.get(note.batch_id);
    if (outputs) outputs.push(note);
    else settlementOutputs.set(note.batch_id, [note]);
  }

  const usedOutputCommitments = new Set<string>();

  return orders.map(normalizeLocalOrder).map((order) => {
    const transcript = settlementTranscripts[order.batchId];
    const proofStatus = proofStatuses?.[order.batchId];
    if (["cancelled", "rolled", "failed"].includes(order.status)) {
      return order;
    }
    if ((order.status === "proof_failed" || order.status === "stalled") && !transcript && !proofStatus) {
      return order;
    }
    if (!transcript && proofStatus?.failure) {
      return { ...order, status: "proof_failed" as LocalOrderStatus };
    }
    if (!transcript && isPrivateReportTerminalStatus(order.status)) {
      return order;
    }
    if (!transcript && proofStatus?.state === "confirmed-onchain") {
      if (proofStatus.reuse_state === "no_fill") {
        return { ...order, status: "no_fill" as LocalOrderStatus };
      }
      return { ...order, status: "settled_pending_output" as LocalOrderStatus };
    }
    const batch = batchesById.get(order.batchId);
    if (!batch && !transcript) return order;
    if (batch?.status === "Cancelled") return { ...order, status: "cancelled" as LocalOrderStatus };
    if (transcript || batch?.status === "Settled") {
      if (!transcript) return { ...order, status: "settled_pending_output" as LocalOrderStatus };
      const pair = pairsById.get(order.pair);
      const expectedOutputAsset = pair
        ? order.side === "Buy" ? pair.base_asset_id : pair.quote_asset_id
        : undefined;
      const clearingPrice = pair
        ? safeFormatClearingPrice({
            batchId: transcript.batch_id,
            epochId: transcript.batch_epoch,
            clearingPrice: String(transcript.clearing_price),
            priceBaseScale: transcript.price_base_scale === undefined
              ? undefined
              : String(transcript.price_base_scale),
          }, pair, formatClearingPrice)
        : String(transcript.clearing_price);
      const batchOutputs = settlementOutputs.get(order.batchId) ?? [];
      const exactOutput = order.expectedOutputMetadataCommitment
        ? batchOutputs
            .find(note =>
              !usedOutputCommitments.has(note.metadata_commitment) &&
              sameFelt(note.metadata_commitment, order.expectedOutputMetadataCommitment) &&
              (!expectedOutputAsset || note.asset === expectedOutputAsset)
            )
        : null;
      const matchedOutput = exactOutput ?? null;
      if (matchedOutput && pair) {
        const amountAtomic = safeToAtomic(toAtomicStr, order.amount, pair.base_asset_id);
        const priceBaseScale = parseNonNegativeBigInt(
          transcript.price_base_scale === undefined
            ? pair.price_base_scale ?? assetScale(pair.base_asset_id).toString()
            : String(transcript.price_base_scale),
        );
        const clearingAtomic = parseNonNegativeBigInt(String(transcript.clearing_price));
        const outputAtomic = parseNonNegativeBigInt(matchedOutput.amount);
        const feeBpsValue = orderTotalFeeBps(order, pair);
        if (
          amountAtomic === null ||
          priceBaseScale === null ||
          priceBaseScale <= 0n ||
          clearingAtomic === null ||
          outputAtomic === null ||
          feeBpsValue < 0 ||
          feeBpsValue >= 10_000
        ) {
          usedOutputCommitments.add(matchedOutput.metadata_commitment);
          return {
            ...order,
            status: "filled" as LocalOrderStatus,
            clearingPrice,
            liquidityBandAttribution:
              noteLiquidityAttribution(matchedOutput) ?? order.liquidityBandAttribution,
          };
        }
        const grossOutputAtomic = order.side === "Buy"
          ? amountAtomic
          : (amountAtomic * clearingAtomic) / priceBaseScale;
        const feeBps = BigInt(feeBpsValue);
        const feeDenominator = 10_000n;
        const fullOutputAtomic =
          (grossOutputAtomic * (feeDenominator - feeBps)) / feeDenominator;
        const isPartial = outputAtomic > 0n && outputAtomic < fullOutputAtomic;
        const feeAdjustedOutput = feeBps > 0n
          ? (outputAtomic * feeDenominator) / (feeDenominator - feeBps)
          : outputAtomic;
        const filledAmount = !isPartial
          ? order.amount
          : order.side === "Buy"
            ? fromAtomicStr(feeAdjustedOutput.toString(), pair.base_asset_id)
            : clearingAtomic > 0n
              ? fromAtomicStr(((feeAdjustedOutput * priceBaseScale) / clearingAtomic).toString(), pair.base_asset_id)
              : undefined;
        usedOutputCommitments.add(matchedOutput.metadata_commitment);
        return {
          ...order,
          status: (isPartial ? "partial" : "filled") as LocalOrderStatus,
          clearingPrice,
          filledAmount,
          liquidityBandAttribution:
            noteLiquidityAttribution(matchedOutput) ?? order.liquidityBandAttribution,
        };
      }
      if (matchedOutput) {
        usedOutputCommitments.add(matchedOutput.metadata_commitment);
        return {
          ...order,
          status: "filled" as LocalOrderStatus,
          clearingPrice,
          liquidityBandAttribution:
            noteLiquidityAttribution(matchedOutput) ?? order.liquidityBandAttribution,
        };
      }
      const transcriptEpoch = Number(transcript.batch_epoch);
      if (
        Number.isFinite(transcriptEpoch) &&
        latestEpoch > 0 &&
        latestEpoch - transcriptEpoch >= noFillDisplayAfterEpochs
      ) {
        return { ...order, status: "no_fill" as LocalOrderStatus, clearingPrice };
      }
      return { ...order, status: "settling" as LocalOrderStatus, clearingPrice };
    }
    if (!batch) return order;
    if (batch.status === "Open" && order.status === "queued") {
      return { ...order, status: "in_batch" as LocalOrderStatus };
    }
    if (
      (batch.status === "Closed" || batch.status === "Clearing" || batch.status === "Proving") &&
      (order.status === "queued" || order.status === "in_batch" || order.status === "proving" || order.status === "settling")
    ) {
      if (proofStatus?.state === "proving") return { ...order, status: "proving" as LocalOrderStatus };
      if (proofStatus?.state === "proof-generated" || proofStatus?.state === "submitting-onchain" || proofStatus?.state === "submitted-onchain") {
        return { ...order, status: "settling" as LocalOrderStatus };
      }
      const batchEpoch = batch.epoch_id ?? order.epochId;
      if (
        latestEpoch > 0 &&
        Number.isFinite(batchEpoch) &&
        latestEpoch - batchEpoch >= stalledDisplayAfterEpochs
      ) {
        return { ...order, status: "stalled" as LocalOrderStatus };
      }
      if (batch.status === "Closed") return { ...order, status: "in_batch" as LocalOrderStatus };
      return { ...order, status: "proving" as LocalOrderStatus };
    }
    if (
      batch.status === "Settling" &&
      (order.status === "queued" || order.status === "in_batch" || order.status === "proving" || order.status === "settling")
    ) {
      const batchEpoch = batch.epoch_id ?? order.epochId;
      if (
        latestEpoch > 0 &&
        Number.isFinite(batchEpoch) &&
        latestEpoch - batchEpoch >= stalledDisplayAfterEpochs
      ) {
        return { ...order, status: "stalled" as LocalOrderStatus };
      }
      return { ...order, status: "settling" as LocalOrderStatus };
    }
    return order;
  });
}

function orderTotalFeeBps(order: LocalOrder, pair: OrderLifecyclePair): number {
  const executionFeeBps = pair.taker_fee_bps ?? 4;
  return executionFeeBps;
}

function safeFormatClearingPrice(
  price: {
    batchId: string;
    epochId: number;
    clearingPrice: string;
    priceBaseScale?: string;
  },
  pair: OrderLifecyclePair,
  formatter: (price: {
    batchId: string;
    epochId: number;
    clearingPrice: string;
    priceBaseScale?: string;
  }, pair: OrderLifecyclePair) => string,
): string {
  try {
    return formatter(price, pair);
  } catch {
    return price.clearingPrice;
  }
}

function safeToAtomic(
  formatter: (human: string, assetId: string) => string,
  human: string,
  assetId: string,
): bigint | null {
  try {
    return parseNonNegativeBigInt(formatter(human, assetId));
  } catch {
    return null;
  }
}

function parseNonNegativeBigInt(value: string | number | bigint | undefined): bigint | null {
  if (value === undefined) return null;
  try {
    const parsed = BigInt(String(value));
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function sameFelt(left: string | undefined, right: string | undefined): boolean {
  return normalizeFelt(left) === normalizeFelt(right);
}

function normalizeFelt(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return `0x${BigInt(trimmed).toString(16)}`;
  } catch {
    const normalized = trimmed.toLowerCase();
    if (!normalized.startsWith("0x")) return `0x${normalized.replace(/^0+/, "") || "0"}`;
    return `0x${normalized.slice(2).replace(/^0+/, "") || "0"}`;
  }
}
