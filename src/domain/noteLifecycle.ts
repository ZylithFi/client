import type { PublicSettlementTranscript } from "./auctionEpoch";
import type { PendingDeposit, WithdrawableNote } from "./shieldedBalances";

export type AmountByAssetInput = {
  asset: string;
  amount: string;
};

export function safeAtomicAmount(value: string | bigint | number | undefined): bigint {
  if (value === undefined) return 0n;
  try {
    const parsed = BigInt(String(value));
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

export function sumByAsset<T extends AmountByAssetInput>(items: T[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const item of items) {
    totals.set(item.asset, (totals.get(item.asset) ?? 0n) + safeAtomicAmount(item.amount));
  }
  return totals;
}

export function settlementBasisMs(
  note: WithdrawableNote,
  transcripts: Record<string, PublicSettlementTranscript>,
): number | null {
  if (!note.batch_id) return null;
  const transcript = transcripts[note.batch_id];
  return transcript?.settled_at_unix_ms ?? transcript?.loaded_at_unix_ms ?? null;
}

export function settlementReadyAtMs(
  note: WithdrawableNote,
  transcripts: Record<string, PublicSettlementTranscript>,
  claimDelaySeconds: number,
): number | null {
  const basis = settlementBasisMs(note, transcripts);
  return basis === null ? null : basis + claimDelaySeconds * 1000;
}

export function activeSettlementOutputs(notes: WithdrawableNote[]): WithdrawableNote[] {
  return notes.filter(note =>
    note.source === "settlement_output" &&
    !note.locked &&
    !note.spent &&
    !note.pending_withdrawal_tx,
  );
}

export function pendingWithdrawalOutputs(notes: WithdrawableNote[]): WithdrawableNote[] {
  return notes.filter(note => Boolean(note.pending_withdrawal_tx));
}

export function claimableOutputs(
  notes: WithdrawableNote[],
  transcripts: Record<string, PublicSettlementTranscript>,
  claimDelaySeconds: number,
  nowMs: number,
): WithdrawableNote[] {
  return activeSettlementOutputs(notes).filter(note => {
    const readyAt = settlementReadyAtMs(note, transcripts, claimDelaySeconds);
    return readyAt !== null && nowMs >= readyAt;
  });
}

export function claimDelayedOutputs(
  notes: WithdrawableNote[],
  transcripts: Record<string, PublicSettlementTranscript>,
  claimDelaySeconds: number,
  nowMs: number,
): WithdrawableNote[] {
  const claimable = new Set(
    claimableOutputs(notes, transcripts, claimDelaySeconds, nowMs)
      .map(note => note.note_commitment),
  );
  return activeSettlementOutputs(notes).filter(note =>
    settlementReadyAtMs(note, transcripts, claimDelaySeconds) !== null &&
    !claimable.has(note.note_commitment),
  );
}

export function pendingDepositTotals(pendingDeposits: PendingDeposit[]): Map<string, bigint> {
  return sumByAsset(pendingDeposits.filter(deposit => !deposit.confirmed && !deposit.failed));
}
