import type { MakerBandAttribution } from "./shieldedBalances";

export type LocalOrderStatus =
  | "queued" | "in_batch" | "proving" | "settling" | "settled_pending_output"
  | "filled" | "partial" | "no_fill" | "rolled" | "cancelled" | "failed"
  | "proof_failed" | "stalled";

export type LocalOrder = {
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
  wireMode: "Limit" | "Maker Curve" | "TWAP" | "VWAP" | "Repeat" | "Resting";
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
  makerCurvePoints?: Array<{ price: string; baseAmount: string }>;
  makerBandAttribution?: MakerBandAttribution;
};

export type PrivateStrategyChildSummary = {
  parent_child_index: number;
  batch_id: string;
  epoch_id: number;
  order_commitment?: string;
  cancellation_secret?: string;
  expected_output_metadata_commitment?: string;
  funding_note_commitments?: string[];
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
  maker_curve_points?: Array<{ price: string; base_amount: string }>;
  maker_inventory_cap?: string;
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
  maker_fee_bps?: number;
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
  failure?: string | null;
};

export type OrderLifecycleOutputNote = {
  source: "deposit" | "settlement_output";
  batch_id?: string;
  asset: string;
  amount: string;
  metadata_commitment: string;
  maker_attribution?: MakerBandAttribution;
};

const LEGACY_SESSION_ORDERS_KEY = "zylith.session.orders";
const ORDERS_KEY_PREFIX = "zylith.local.orders";
const VALID_ORDER_STATUSES = new Set<LocalOrderStatus>([
  "queued",
  "in_batch",
  "proving",
  "settling",
  "settled_pending_output",
  "filled",
  "partial",
  "no_fill",
  "rolled",
  "cancelled",
  "failed",
  "proof_failed",
  "stalled",
]);

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

function isPrivateReportTerminalStatus(status: LocalOrderStatus): boolean {
  return status === "filled" || status === "partial" || status === "no_fill";
}

function ordersKey(ownerKey: string): string {
  return `${ORDERS_KEY_PREFIX}.${ownerKey}`;
}

function normalizeOrders(raw: unknown): LocalOrder[] {
  return Array.isArray(raw)
    ? raw.flatMap((order) => {
        if (!order || typeof order !== "object") return [];
        const rawStatus = (order as { status?: unknown }).status;
        const status = rawStatus === "settlement_blocked"
          ? "stalled"
          : rawStatus;
        if (!VALID_ORDER_STATUSES.has(status as LocalOrderStatus)) return [];
        const candidate = order as LocalOrder;
        return [{ ...candidate, status: status as LocalOrderStatus }];
      })
    : [];
}

export function loadOrders(ownerKey: string | null): LocalOrder[] {
  if (!ownerKey) return [];
  try {
    const key = ordersKey(ownerKey);
    const stored = localStorage.getItem(key);
    if (stored) return normalizeOrders(JSON.parse(stored));

    const legacy = sessionStorage.getItem(LEGACY_SESSION_ORDERS_KEY);
    if (!legacy) return [];
    const migrated = normalizeOrders(JSON.parse(legacy));
    localStorage.setItem(key, JSON.stringify(migrated));
    sessionStorage.removeItem(LEGACY_SESSION_ORDERS_KEY);
    return migrated;
  } catch {
    return [];
  }
}

export function saveOrders(orders: LocalOrder[], ownerKey: string | null): void {
  if (!ownerKey) return;
  try { localStorage.setItem(ordersKey(ownerKey), JSON.stringify(orders)); } catch { /* noop */ }
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
      JSON.stringify(order.fundingNoteCommitments ?? []) !== JSON.stringify(previous.fundingNoteCommitments ?? []) ||
      order.cancelTransactionHash !== previous.cancelTransactionHash ||
      order.makerBandAttribution !== previous.makerBandAttribution
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
  noFillFallbackEpochs = 10,
  settlementBlockedFallbackEpochs = 10,
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
  noFillFallbackEpochs?: number;
  settlementBlockedFallbackEpochs?: number;
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
  const latestEpoch = batches.reduce(
    (max, batch) => Math.max(max, batch.epoch_id ?? 0),
    0,
  );
  for (const note of withdrawableNotes) {
    if (note.source !== "settlement_output" || !note.batch_id) continue;
    settlementOutputs.set(note.batch_id, [...(settlementOutputs.get(note.batch_id) ?? []), note]);
  }

  const usedOutputCommitments = new Set<string>();

  return orders.map((order) => {
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
      if (proofStatus.matched_order_count === 0) {
        return { ...order, status: "no_fill" as LocalOrderStatus };
      }
      return { ...order, status: "settled_pending_output" as LocalOrderStatus };
    }
    const batch = batches.find(candidate => candidate.batch_id === order.batchId);
    if (!batch && !transcript) return order;
    if (batch?.status === "Cancelled") return { ...order, status: "cancelled" as LocalOrderStatus };
    if (transcript || batch?.status === "Settled") {
      if (!transcript) return { ...order, status: "settled_pending_output" as LocalOrderStatus };
      const pair = pairs.find(candidate => candidate.pair_id === order.pair);
      const expectedOutputAsset = pair
        ? order.side === "Buy" ? pair.base_asset_id : pair.quote_asset_id
        : undefined;
      const clearingPrice = pair
        ? formatClearingPrice({
            batchId: transcript.batch_id,
            epochId: transcript.batch_epoch,
            clearingPrice: String(transcript.clearing_price),
            priceBaseScale: transcript.price_base_scale === undefined
              ? undefined
              : String(transcript.price_base_scale),
          }, pair)
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
      const matchedOutput = exactOutput ?? (pair
        ? findAmountMatchedOutput({
            order,
            transcript,
            pair,
            batchOutputs,
            usedOutputCommitments,
            toAtomicStr,
            assetScale,
          })
        : null);
      if (matchedOutput && pair) {
        const amountAtomic = BigInt(toAtomicStr(order.amount, pair.base_asset_id));
        const priceBaseScale = BigInt(
          transcript.price_base_scale === undefined
            ? pair.price_base_scale ?? assetScale(pair.base_asset_id).toString()
            : String(transcript.price_base_scale),
        );
        const clearingAtomic = BigInt(String(transcript.clearing_price));
        const grossOutputAtomic = order.side === "Buy"
          ? amountAtomic
          : (amountAtomic * clearingAtomic) / priceBaseScale;
        const feeBps = BigInt(
          order.wireMode === "Maker Curve" || order.wireMode === "Resting"
            ? pair.maker_fee_bps ?? 0
            : pair.taker_fee_bps ?? 4,
        );
        const feeDenominator = 10_000n;
        const fullOutputAtomic =
          (grossOutputAtomic * (feeDenominator - feeBps)) / feeDenominator;
        const outputAtomic = BigInt(matchedOutput.amount);
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
          makerBandAttribution: matchedOutput.maker_attribution ?? order.makerBandAttribution,
        };
      }
      if (matchedOutput) {
        usedOutputCommitments.add(matchedOutput.metadata_commitment);
        return {
          ...order,
          status: "filled" as LocalOrderStatus,
          clearingPrice,
          makerBandAttribution: matchedOutput.maker_attribution ?? order.makerBandAttribution,
        };
      }
      const transcriptEpoch = Number(transcript.batch_epoch);
      if (
        Number.isFinite(transcriptEpoch) &&
        latestEpoch > 0 &&
        latestEpoch - transcriptEpoch >= noFillFallbackEpochs
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
        latestEpoch - batchEpoch >= settlementBlockedFallbackEpochs
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
        latestEpoch - batchEpoch >= settlementBlockedFallbackEpochs
      ) {
        return { ...order, status: "stalled" as LocalOrderStatus };
      }
      return { ...order, status: "settling" as LocalOrderStatus };
    }
    return order;
  });
}

function findAmountMatchedOutput({
  order,
  transcript,
  pair,
  batchOutputs,
  usedOutputCommitments,
  toAtomicStr,
  assetScale,
}: {
  order: LocalOrder;
  transcript: OrderLifecycleTranscript;
  pair: OrderLifecyclePair;
  batchOutputs: OrderLifecycleOutputNote[];
  usedOutputCommitments: Set<string>;
  toAtomicStr: (human: string, assetId: string) => string;
  assetScale: (assetId: string) => bigint;
}) {
  const expectedOutputAsset = order.side === "Buy" ? pair.base_asset_id : pair.quote_asset_id;
  const amountAtomic = BigInt(toAtomicStr(order.amount, pair.base_asset_id));
  const priceBaseScale = BigInt(
    transcript.price_base_scale === undefined
      ? pair.price_base_scale ?? assetScale(pair.base_asset_id).toString()
      : String(transcript.price_base_scale),
  );
  const clearingAtomic = BigInt(String(transcript.clearing_price));
  const grossOutputAtomic = order.side === "Buy"
    ? amountAtomic
    : (amountAtomic * clearingAtomic) / priceBaseScale;
  const feeBps = BigInt(
    order.wireMode === "Maker Curve" || order.wireMode === "Resting"
      ? pair.maker_fee_bps ?? 0
      : pair.taker_fee_bps ?? 4,
  );
  const expectedNetOutput =
    (grossOutputAtomic * (10_000n - feeBps)) / 10_000n;
  if (expectedNetOutput <= 0n) return null;
  return batchOutputs.find(note =>
    !usedOutputCommitments.has(note.metadata_commitment) &&
    note.asset === expectedOutputAsset &&
    BigInt(note.amount) === expectedNetOutput
  ) ?? null;
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
