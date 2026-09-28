import { describe, expect, it } from "vitest";
import { type StoredOrder, type WalletNote, mergeState, unadmittedOrderState, walletWasmModuleUrlAllowed } from "./zylithWalletRuntime";

function note(commitment: string, spent = false): WalletNote {
  return {
    commitment,
    nullifier: `${commitment}ff`,
    asset: "STRK",
    source: "output",
    spent,
    fields: {
      asset_id: "0x1",
      amount: "5",
      owner_public_key: "0x2",
      spend_authority: "0x3",
      withdraw_authority: "0x4",
      blinding: "0x5",
      nonce: 1,
      metadata_commitment: "0x6",
    },
  };
}

function order(id: string, updatedAt: number, state: StoredOrder["state"] = "live"): StoredOrder {
  return {
    order_id: id,
    pair: "STRK/USDC",
    side: "Sell",
    external: false,
    amount: "5",
    limit_price: "1",
    expires_at_ms: 10,
    funding_asset: "STRK",
    funding_amount: "5",
    state,
    filled_base: "0",
    filled_quote: "0",
    fees: "0",
    submitted_at_ms: updatedAt,
    updated_at_ms: updatedAt,
    terms: {},
    funding_notes: [],
    nullifiers: [],
    base_asset: "STRK",
    quote_asset: "USDC",
    scan_after_seq: 0,
    seen_seqs: [],
    locked_input: "5",
  };
}

describe("wallet state merge", () => {
  it("adds missing notes and orders, keeps newer orders and spends, and rewinds the scan cursor", () => {
    const local = { version: 2 as const, notes: [note("0xa"), note("0xb")], orders: [order("0x1", 5, "filled")], scanned_seq: 40 };
    const remote = { version: 2 as const, notes: [note("0xA", true), note("0xc")], orders: [order("0x1", 3), order("0x2", 7)], scanned_seq: 12 };
    expect(mergeState(local, remote)).toBe(true);
    expect(local.notes.map((entry) => [entry.commitment, Boolean(entry.spent)])).toEqual([
      ["0xa", true],
      ["0xb", false],
      ["0xc", false],
    ]);
    expect(local.orders.map((entry) => [entry.order_id, entry.state])).toEqual([
      ["0x2", "live"],
      ["0x1", "filled"],
    ]);
    expect(local.scanned_seq).toBe(12);
    expect(mergeState(local, remote)).toBe(false);
  });
});

describe("wallet module url", () => {
  it("accepts only same-origin modules", () => {
    expect(walletWasmModuleUrlAllowed("/wallet/zylith_wallet_wasm.js", "https://app.zylith.fi/trade")).toBe(true);
    expect(walletWasmModuleUrlAllowed("https://cdn.example/wallet.js", "https://app.zylith.fi/trade")).toBe(false);
  });
});

describe("unadmitted orders", () => {
  it("are expired once past their expiry, cancelled when cancelled, and failed otherwise", () => {
    const terms = { expiry_ms: 1_000 };
    expect(unadmittedOrderState({ terms }, 1_000)).toBe("expired");
    expect(unadmittedOrderState({ terms }, 999)).toBe("failed");
    expect(unadmittedOrderState({ terms, cancel_requested: true }, 1_000)).toBe("cancelled");
    expect(unadmittedOrderState({ terms: undefined }, 1_000)).toBe("failed");
  });
});
