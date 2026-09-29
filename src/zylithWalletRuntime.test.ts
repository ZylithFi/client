import { describe, expect, it } from "vitest";
import {
  type StoredOrder,
  type WalletNote,
  mergeState,
  parsePendingResidualExit,
  recoveryTransactionDisposition,
  unadmittedOrderState,
  walletWasmModuleUrlAllowed,
} from "./zylithWalletRuntime";

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

  it("restores the durable one-time authorities of a prepared residual recovery", () => {
    const prepared = order("0x3", 9);
    prepared.residual = { seq: 7, index: 0, note: {} as never };
    prepared.residual_recovery = {
      residual_seq: 7,
      nullifier: "0xaa",
      statement_commitment: "0xbb",
      input_asset_id: "0x1",
      input_amount: "5",
      output_asset_id: "0x2",
      output_amount: "3",
      fee_amount: "1",
      input_exit_commitment: "0xcc",
      output_exit_commitment: "0xdd",
    };
    const local = { version: 2 as const, notes: [], orders: [order("0x3", 4)], scanned_seq: 0 };
    const remote = { version: 2 as const, notes: [], orders: [prepared], scanned_seq: 0 };
    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0].residual_recovery).toEqual(prepared.residual_recovery);
  });

  it("prefers monotonic chain progress over wall-clock order timestamps", () => {
    const localOrder = order("0x0A", 50_000);
    localOrder.seen_seqs = [4];
    localOrder.filled_base = "2";
    localOrder.locked_input = "3";
    const remoteOrder = order("0xa", 1, "filled");
    remoteOrder.seen_seqs = [4, 5];
    remoteOrder.closed_seq = 5;
    remoteOrder.filled_base = "5";
    remoteOrder.locked_input = "0";
    const local = { version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 5 };
    const remote = { version: 2 as const, notes: [], orders: [remoteOrder], scanned_seq: 5 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders).toHaveLength(1);
    expect(local.orders[0]).toMatchObject({ state: "filled", closed_seq: 5, filled_base: "5", locked_input: "0" });
    expect(local.orders[0].seen_seqs).toEqual([4, 5]);
  });

  it("merges retry metadata for the same prepared residual authority", () => {
    const localOrder = order("0xb", 10);
    localOrder.residual = { seq: 7, index: 0, note: {} as never };
    localOrder.residual_recovery = {
      residual_seq: 7,
      nullifier: "0xaa",
      statement_commitment: "0xbb",
      input_asset_id: "0x1",
      input_amount: "5",
      output_asset_id: "0x2",
      output_amount: "3",
      fee_amount: "1",
      input_exit_commitment: "0xcc",
      output_exit_commitment: "0xdd",
    };
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.updated_at_ms = 9;
    remoteOrder.residual_recovery!.request_transaction_hash = "0x123";
    remoteOrder.residual_recovery!.request_submitted_at_ms = 8;
    const local = { version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 7 };
    const remote = { version: 2 as const, notes: [], orders: [remoteOrder], scanned_seq: 7 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0].residual_recovery?.request_transaction_hash).toBe("0x123");
  });

  it("keeps capacity-freeze retry identity before a recovery can be prepared", () => {
    const localOrder = order("0xc", 10);
    localOrder.residual = { seq: 7, index: 0, note: {} as never };
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.residual_capacity_freeze = {
      residual_seq: 7,
      transaction_hash: "0x456",
      submitted_at_ms: 8,
    };
    const local = { version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 7 };
    const remote = { version: 2 as const, notes: [], orders: [remoteOrder], scanned_seq: 7 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0].residual_capacity_freeze?.transaction_hash).toBe("0x456");
    expect(local.orders[0].residual_recovery).toBeUndefined();
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

describe("residual exit storage", () => {
  it("decodes the exact cairo layout and rejects truncated views", () => {
    expect(parsePendingResidualExit([
      "0x1", "5", "0x2", "0x3",
      "0x4", "6", "0x5", "0x6",
      "1", "0x7", "0x8", "9000", "12",
    ])).toEqual({
      input_asset_id: "0x1",
      input_amount: "5",
      input_exit_commitment: "0x2",
      output_asset_id: "0x4",
      output_amount: "6",
      output_exit_commitment: "0x5",
      fee_amount: "1",
      requested_at_ms: 9000,
      matures_at: 12,
    });
    expect(() => parsePendingResidualExit(["0x1"])).toThrow(/unexpected layout/);
    expect(() => parsePendingResidualExit([
      "0x1", "5", "0x2", "0x3",
      "0x4", "6", "0x5", "0x6",
      "1", "0x7", "0x8", "9000", "9007199254740992",
    ])).toThrow(/out of range/);
  });

  it("retries only failed or sufficiently stale missing transactions", () => {
    expect(recoveryTransactionDisposition(null, 1_000, 2_000, 5_000)).toBe("pending");
    expect(recoveryTransactionDisposition({ failed: false, notFound: false, confirmed: false }, 1_000, 2_000, 5_000)).toBe("pending");
    expect(recoveryTransactionDisposition({ failed: false, notFound: false, confirmed: true }, 1_000, 2_000, 5_000)).toBe("confirmed");
    expect(recoveryTransactionDisposition({ failed: true, notFound: false }, 1_000, 2_000, 5_000)).toBe("retry");
    expect(recoveryTransactionDisposition({ failed: false, notFound: true }, 1_000, 5_999, 5_000)).toBe("pending");
    expect(recoveryTransactionDisposition({ failed: false, notFound: true }, 1_000, 6_000, 5_000)).toBe("retry");
  });
});
