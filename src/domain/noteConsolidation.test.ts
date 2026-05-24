import { describe, expect, it } from "vitest";
import { noteConsolidationPlans } from "./noteConsolidation";
import type { WithdrawableNote } from "./shieldedBalances";

const STRK = 10n ** 18n;

function note(amount: bigint, overrides: Partial<WithdrawableNote> = {}): WithdrawableNote {
  return {
    note_commitment: `0x${amount.toString(16)}`,
    source: "settlement_output",
    asset: "STRK",
    amount: amount.toString(),
    locked: false,
    spent: false,
    metadata_commitment: `0xmeta${amount.toString(16)}`,
    ...overrides,
  };
}

describe("note consolidation planning", () => {
  it("plans odd note consolidation into fewer standard denominations", () => {
    const plans = noteConsolidationPlans([
      note(3n * STRK, { note_commitment: "0xodd1" }),
      note(3n * STRK, { note_commitment: "0xodd2" }),
      note(3n * STRK, { note_commitment: "0xodd3" }),
      note(3n * STRK, { note_commitment: "0xodd4" }),
      note(3n * STRK, { note_commitment: "0xodd5" }),
      note(3n * STRK, { note_commitment: "0xodd6" }),
      note(3n * STRK, { note_commitment: "0xodd7" }),
      note(3n * STRK, { note_commitment: "0xodd8" }),
    ]);

    expect(plans).toHaveLength(1);
    expect(plans[0].asset).toBe("STRK");
    expect(plans[0].sourceNoteCount).toBe(8);
    expect(plans[0].sourceAmountDisplay).toBe("24");
    expect(plans[0].targetNoteCount).toBeLessThan(8);
    expect(plans[0].executable).toBe(false);
  });

  it("ignores locked, spent, pending-withdrawal, and already standard notes", () => {
    const plans = noteConsolidationPlans([
      note(3n * STRK, { locked: true }),
      note(7n * STRK, { spent: true }),
      note(11n * STRK, { pending_withdrawal_tx: "0xtx" }),
      note(10n * STRK),
      note(2n * STRK),
    ]);

    expect(plans).toHaveLength(0);
  });
});
