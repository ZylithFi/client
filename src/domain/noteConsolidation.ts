import { assetDecimals, fromAtomicStr } from "./assets";
import { denominationTableForAsset, splitDepositAmount } from "./depositSplitting";
import { safeAtomicAmount } from "./noteLifecycle";
import type { WithdrawableNote } from "./shieldedBalances";

export type NoteConsolidationPlan = {
  kind: "deposit_exit" | "consolidation";
  asset: string;
  sourceNoteCommitments: string[];
  sourceNoteCount: number;
  nonStandardSourceCount: number;
  sourceAmount: string;
  sourceAmountDisplay: string;
  targetAmounts: string[];
  targetAmountDisplays: string[];
  targetNoteCount: number;
  reason: string;
  executable: true;
};

export function noteConsolidationPlans(notes: WithdrawableNote[]): NoteConsolidationPlan[] {
  const byAsset = new Map<string, WithdrawableNote[]>();
  for (const note of notes) {
    if (!isAvailablePrivateNote(note)) continue;
    const entries = byAsset.get(note.asset) ?? [];
    entries.push(note);
    byAsset.set(note.asset, entries);
  }

  return Array.from(byAsset.entries())
    .map(([asset, assetNotes]) => consolidationPlanForAsset(asset, assetNotes))
    .filter((plan): plan is NoteConsolidationPlan => Boolean(plan))
    .sort((left, right) => right.nonStandardSourceCount - left.nonStandardSourceCount || left.asset.localeCompare(right.asset));
}

function consolidationPlanForAsset(asset: string, notes: WithdrawableNote[]): NoteConsolidationPlan | null {
  const decimals = assetDecimals(asset);
  const depositNotes = notes.filter(note => note.source === "deposit");
  if (depositNotes.length > 0) {
    const sourceAmount = depositNotes.reduce((sum, note) => sum + safeAtomicAmount(note.amount), 0n);
    const targetAmounts = splitDepositAmount(sourceAmount, asset, decimals);
    return {
      kind: "deposit_exit",
      asset,
      sourceNoteCommitments: depositNotes.map(note => note.note_commitment),
      sourceNoteCount: depositNotes.length,
      nonStandardSourceCount: depositNotes.length,
      sourceAmount: sourceAmount.toString(),
      sourceAmountDisplay: fromAtomicStr(sourceAmount.toString(), asset),
      targetAmounts: targetAmounts.map(amount => amount.toString()),
      targetAmountDisplays: targetAmounts.map(amount => fromAtomicStr(amount.toString(), asset)),
      targetNoteCount: targetAmounts.length,
      reason: depositNotes.length === 1
        ? "Convert this deposit note into a settlement output before withdrawing."
        : "Convert deposit notes into settlement outputs before withdrawing.",
      executable: true,
    };
  }
  const standard = new Set(denominationTableForAsset(asset, decimals).map(value => value.toString()));
  const nonStandardNotes = notes.filter(note => !standard.has(note.amount));
  if (nonStandardNotes.length < 2) return null;

  const sourceAmount = nonStandardNotes.reduce((sum, note) => sum + safeAtomicAmount(note.amount), 0n);
  const targetAmounts = splitDepositAmount(sourceAmount, asset, decimals);
  if (targetAmounts.length >= nonStandardNotes.length) return null;

  return {
    kind: "consolidation",
    asset,
    sourceNoteCommitments: nonStandardNotes.map(note => note.note_commitment),
    sourceNoteCount: nonStandardNotes.length,
    nonStandardSourceCount: nonStandardNotes.length,
    sourceAmount: sourceAmount.toString(),
    sourceAmountDisplay: fromAtomicStr(sourceAmount.toString(), asset),
    targetAmounts: targetAmounts.map(amount => amount.toString()),
    targetAmountDisplays: targetAmounts.map(amount => fromAtomicStr(amount.toString(), asset)),
    targetNoteCount: targetAmounts.length,
    reason: "Odd change and partial-fill notes can be merged into fewer standard denominations.",
    executable: true,
  };
}

function isAvailablePrivateNote(note: WithdrawableNote): boolean {
  return !note.locked && !note.spent && !note.pending_withdrawal_tx && safeAtomicAmount(note.amount) > 0n;
}
