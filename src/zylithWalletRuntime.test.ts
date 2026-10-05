import { describe, expect, it } from "vitest";
import {
  type StoredOrder,
  type WalletNote,
  assertSealedBuild,
  claimRetryDelay,
  createExclusiveBooleanOperation,
  createSerialOperationQueue,
  fundingAdmissionDisposition,
  authenticatedTerminalSequence,
  mergeState,
  parseClaimedOpenNoteId,
  parseOnchainPairConfig,
  parseFundingCommitmentRegistration,
  quarantineDamagedWalletState,
  recoverySnapshotStateForScope,
  requireRecoveryArtifactHistory,
  requireWalletSignatureVaultBundle,
  requireWalletState,
  parsePendingResidualExit,
  requireExchangeStatus,
  requireExecutionKeyRegistry,
  requireIndexerStatus,
  requireStatusAnswer,
  recoveryTransactionDisposition,
  transactionHash,
  unadmittedOrderState,
  walletWasmModuleUrlAllowed,
  walletBalances,
} from "./zylithWalletRuntime";
import type { DeploymentConfig } from "./domain/deployment";

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
      nonce: "1",
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
    funding_notes: ["0x100"],
    nullifiers: ["0x200"],
    base_asset: "STRK",
    quote_asset: "USDC",
    scan_after_seq: 0,
    seen_seqs: [],
    locked_input: "5",
  };
}

function residual(seq: number) {
  return {
    seq,
    index: 0,
    note: {
      chain_context: "0x1",
      input_asset_id: "0x2",
      pair_id: "0x3",
      sell: true,
      external: false,
      remaining: "5",
      limit: "1",
      funding: "5",
      reserved: "0",
      reserved_offset: "0",
      reserved_seq: 0,
      expiry_ms: 1,
      order_id: "0x4",
      generation: 0,
      owner: {
        owner_public_key: "0x5",
        spend_authority: "0x6",
        withdraw_authority: "0x7",
        cancel_authority: "0x8",
        nonce: "0x9",
      },
      blinding: "0xa",
    },
  };
}

function recoveryArtifact(id: string, sequence: number, accountId = "b".repeat(64)) {
  return {
    artifact_id: id.repeat(64),
    account_id: accountId,
    kind: "Snapshot",
    sequence,
    created_at_unix_ms: sequence,
    payload: {
      algorithm: "aes-256-gcm/recovery-v1",
      nonce: "c".repeat(24),
      ciphertext: "d".repeat(32),
    },
  };
}

describe("authenticated terminal order recovery", () => {
  it("accepts only a chain output transition without a replacement residual", () => {
    expect(authenticatedTerminalSequence(
      [{ seq: 11 }, { seq: 14 }],
      [{ seq: 11 }],
    )).toBe(14);
  });

  it("does not treat an operator-only closure or a partial fill as terminal", () => {
    expect(authenticatedTerminalSequence([], [])).toBeUndefined();
    expect(authenticatedTerminalSequence([{ seq: 9 }], [{ seq: 9 }])).toBeUndefined();
  });
});

describe("damaged local wallet state", () => {
  it("preserves the original encrypted value and never replaces an earlier quarantine copy", () => {
    const values = new Map([
      ["state", "damaged-current"],
      ["quarantine", "damaged-earlier"],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };

    quarantineDamagedWalletState(storage, "state", "quarantine", "damaged-current");
    expect(values.get("state")).toBe("damaged-current");
    expect(values.get("quarantine")).toBe("damaged-earlier");

    values.delete("quarantine");
    quarantineDamagedWalletState(storage, "state", "quarantine", "damaged-current");
    expect(values.get("state")).toBe("damaged-current");
    expect(values.get("quarantine")).toBe("damaged-current");
  });

  it("does not quarantine stale data after another session updates the original key", () => {
    const values = new Map([["state", "newer-value"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };

    quarantineDamagedWalletState(storage, "state", "quarantine", "stale-value");
    expect(values.has("quarantine")).toBe(false);
  });
});

describe("wallet vault responses", () => {
  const walletAuthId = `0x${"1".repeat(64)}`;
  const vault = {
    version: 2 as const,
    kdf: "wallet-signature-sha256-v2" as const,
    algorithm: "AES-GCM" as const,
    wallet_address: "0xabc",
    chain_id: "0x1",
    deployment_id: "0x2",
    origin: "https://app.zylith.fi",
    message_version: 2 as const,
    nonce: btoa("n".repeat(12)),
    ciphertext: btoa("c".repeat(80)),
  };

  it("accepts only the requested authenticated vault", () => {
    expect(requireWalletSignatureVaultBundle({
      wallet_auth_id: walletAuthId,
      vault,
      updated_at_unix_ms: 1,
    }, walletAuthId)).toEqual(vault);
    expect(() => requireWalletSignatureVaultBundle({
      wallet_auth_id: `0x${"2".repeat(64)}`,
      vault,
    }, walletAuthId)).toThrow(/malformed response/i);
    expect(() => requireWalletSignatureVaultBundle({
      wallet_auth_id: walletAuthId,
      vault: { ...vault, ciphertext: "bad" },
    }, walletAuthId)).toThrow(/malformed response/i);
  });
});

describe("recovery snapshot history", () => {
  it("sorts a strictly monotonic authenticated account history", () => {
    const accountId = "b".repeat(64);
    expect(requireRecoveryArtifactHistory({
      artifacts: [recoveryArtifact("2", 2), recoveryArtifact("1", 1)],
    }, accountId).map((artifact) => artifact.sequence)).toEqual([1, 2]);
  });

  it("rejects duplicate sequences, artifacts, and cross-account entries", () => {
    const accountId = "b".repeat(64);
    expect(() => requireRecoveryArtifactHistory({
      artifacts: [recoveryArtifact("1", 1), recoveryArtifact("2", 1)],
    }, accountId)).toThrow(/conflicts with this wallet/i);
    expect(() => requireRecoveryArtifactHistory({
      artifacts: [recoveryArtifact("1", 1), recoveryArtifact("1", 2)],
    }, accountId)).toThrow(/conflicts with this wallet/i);
    expect(() => requireRecoveryArtifactHistory({
      artifacts: [recoveryArtifact("1", 1, "e".repeat(64))],
    }, accountId)).toThrow(/malformed snapshot/i);
  });

  it("ignores authenticated snapshots from an earlier deployment scope", () => {
    expect(recoverySnapshotStateForScope({
      version: 2,
      scope: "account:old-exchange",
      state: { obsolete: true },
    }, "account:new-exchange")).toBeNull();
  });

  it("still rejects malformed snapshots and malformed state for the active scope", () => {
    expect(() => recoverySnapshotStateForScope({
      version: 2,
      state: { version: 2, notes: [], orders: [], scanned_seq: 0 },
    }, "account:new-exchange")).toThrow(/conflicts with this wallet/i);
    expect(() => recoverySnapshotStateForScope({
      version: 2,
      scope: "account:new-exchange",
      state: { obsolete: true },
    }, "account:new-exchange")).toThrow();
  });
});

describe("withdrawal claim retries", () => {
  it("backs off exponentially and caps long-running failures", () => {
    expect(claimRetryDelay(1)).toBe(30_000);
    expect(claimRetryDelay(2)).toBe(60_000);
    expect(claimRetryDelay(7)).toBe(1_800_000);
    expect(claimRetryDelay(100)).toBe(1_800_000);
  });
});

describe("private registry operation queue", () => {
  it("serializes operations and continues after a rejected operation", async () => {
    const run = createSerialOperationQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = run(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push("first:end");
      throw new Error("first failed");
    });
    const second = run(async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

describe("private wallet authorization single flight", () => {
  it("deduplicates the same request and rejects a conflicting request until completion", async () => {
    const operations = createExclusiveBooleanOperation();
    let release: ((value: boolean) => void) | undefined;
    const first = operations.run("unlock:0x1", () => new Promise<boolean>((resolve) => { release = resolve; }));
    const duplicate = operations.run("unlock:0x1", async () => false);
    const conflicting = operations.run("create:0x2", async () => true);

    expect(duplicate).toBe(first);
    await expect(conflicting).rejects.toThrow(/authorization is already in progress/i);
    release?.(true);
    await expect(first).resolves.toBe(true);
    await expect(operations.run("create:0x2", async () => true)).resolves.toBe(true);
  });

  it("allows a new session to authorize after the previous session resets", async () => {
    const operations = createExclusiveBooleanOperation();
    let release: ((value: boolean) => void) | undefined;
    const stale = operations.run("unlock:0x1", () => new Promise<boolean>((resolve) => { release = resolve; }));
    operations.reset();
    await expect(operations.run("unlock:0x2", async () => true)).resolves.toBe(true);
    release?.(false);
    await expect(stale).resolves.toBe(false);
  });
});

describe("wallet transaction results", () => {
  it("accepts only nonzero canonical felt transaction hashes", () => {
    expect(transactionHash({ transaction_hash: "0x000a" })).toBe("0xa");
    expect(transactionHash("0x2")).toBe("0x2");
    expect(transactionHash({ hash: "not-a-hash" })).toBeNull();
    expect(transactionHash({ transactionHash: "0x0" })).toBeNull();
    expect(transactionHash({ transaction_hash: "0x800000000000011000000000000000000000000000000000000000000000001" })).toBeNull();
  });
});

describe("funding commitment registration", () => {
  it("accepts only a canonical boolean returned by the commitment registry", () => {
    expect(parseFundingCommitmentRegistration(["0x0"])).toBe(false);
    expect(parseFundingCommitmentRegistration(["0x0001"])).toBe(true);
    expect(() => parseFundingCommitmentRegistration([])).toThrow(/unexpected registration result/i);
    expect(() => parseFundingCommitmentRegistration(["0x1", "0x0"])).toThrow(/unexpected registration result/i);
    expect(() => parseFundingCommitmentRegistration(["0x2"])).toThrow(/unexpected registration result/i);
    expect(() => parseFundingCommitmentRegistration(["not-a-felt"])).toThrow(/unexpected registration result/i);
  });
});

describe("private request envelopes", () => {
  const request = () => ({
    response_key: "a".repeat(64),
    sealed: {
      version: 2,
      digest: "b".repeat(64),
      shares: [{
        key_id: "current",
        ciphertext: {
          algorithm: "ecdh-p256+hkdf-sha256+aes-256-gcm/private-order-v1",
          key_id: "current",
          ephemeral_public_key: `04${"c".repeat(128)}`,
          nonce: "d".repeat(24),
          ciphertext: "e".repeat(32),
        },
      }],
    },
  });

  it("accepts the pinned envelope shape and rejects key or size drift", () => {
    expect(() => assertSealedBuild(request())).not.toThrow();
    const mismatched = request();
    mismatched.sealed.shares[0].ciphertext.key_id = "next";
    expect(() => assertSealedBuild(mismatched)).toThrow(/malformed private request/i);
    const oversized = request();
    oversized.sealed.shares[0].ciphertext.ciphertext = "e".repeat((64 * 1024) + 2);
    expect(() => assertSealedBuild(oversized)).toThrow(/malformed private request/i);
  });
});

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

  it("does not restore a stale funding lock after an authenticated unadmitted closure", () => {
    const localNote = note("0x61");
    const localOrder = order("0x62", 20, "cancelled");
    localOrder.funding_notes = [localNote.commitment];
    localOrder.closed_seq = localOrder.scan_after_seq;
    localOrder.closed_seq_authenticated = true;
    localOrder.locked_input = "0";

    const remoteNote = structuredClone(localNote);
    remoteNote.locked_by = localOrder.order_id;
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.state = "pending";
    remoteOrder.closed_seq = undefined;
    remoteOrder.closed_seq_authenticated = undefined;
    remoteOrder.locked_input = remoteNote.fields.amount;
    remoteOrder.updated_at_ms = 10;

    const local = { version: 2 as const, notes: [localNote], orders: [localOrder], scanned_seq: 20 };
    const remote = { version: 2 as const, notes: [remoteNote], orders: [remoteOrder], scanned_seq: 20 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0]).toMatchObject({ state: "cancelled", closed_seq_authenticated: true });
    expect(local.notes[0].locked_by).toBeUndefined();
    expect(walletBalances(local)).toEqual([{ asset: "STRK", available: localNote.fields.amount, locked: "0" }]);
  });

  it("merges a definitive pre-admission rejection over its backed-up submitting state", () => {
    const localNote = note("0x63");
    const rejected = order("0x64", 30, "failed");
    rejected.funding_notes = [localNote.commitment];
    rejected.locked_input = "0";
    rejected.last_error = "The operator rejected the request.";

    const pendingNote = structuredClone(localNote);
    pendingNote.locked_by = rejected.order_id;
    const submitting = structuredClone(rejected);
    submitting.state = "submitting";
    submitting.locked_input = pendingNote.fields.amount;
    submitting.last_error = undefined;
    submitting.updated_at_ms = 20;

    const local = { version: 2 as const, notes: [localNote], orders: [rejected], scanned_seq: 30 };
    const remote = { version: 2 as const, notes: [pendingNote], orders: [submitting], scanned_seq: 30 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0]).toMatchObject({ state: "failed", locked_input: "0" });
    expect(local.notes[0].locked_by).toBeUndefined();
  });

  it("keeps the newest cancellation decision when recovery snapshots disagree", () => {
    const cancelledBackup = order("0x65", 10, "cancelling");
    cancelledBackup.cancel_requested = true;
    const rejectedLocally = structuredClone(cancelledBackup);
    rejectedLocally.state = "live";
    rejectedLocally.cancel_requested = undefined;
    rejectedLocally.updated_at_ms = 20;

    const local = { version: 2 as const, notes: [], orders: [rejectedLocally], scanned_seq: 0 };
    const remote = { version: 2 as const, notes: [], orders: [cancelledBackup], scanned_seq: 0 };
    expect(mergeState(local, remote)).toBe(false);
    expect(local.orders[0]).toMatchObject({ state: "live" });
    expect(local.orders[0].cancel_requested).toBeUndefined();

    const laterCancellation = structuredClone(rejectedLocally);
    laterCancellation.state = "cancelling";
    laterCancellation.cancel_requested = true;
    laterCancellation.updated_at_ms = 30;
    expect(mergeState(local, {
      version: 2,
      notes: [],
      orders: [laterCancellation],
      scanned_seq: 0,
    })).toBe(true);
    expect(local.orders[0]).toMatchObject({ state: "cancelling", cancel_requested: true });
  });

  it("preserves a newer cancellation across an older snapshot with more scanned events", () => {
    const localOrder = order("0x66", 30, "cancelling");
    localOrder.cancel_requested = true;
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.state = "live";
    remoteOrder.cancel_requested = undefined;
    remoteOrder.updated_at_ms = 20;
    remoteOrder.seen_seqs = [1];

    const local = { version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 1 };
    expect(mergeState(local, {
      version: 2,
      notes: [],
      orders: [remoteOrder],
      scanned_seq: 1,
    })).toBe(true);
    expect(local.orders[0]).toMatchObject({ state: "cancelling", cancel_requested: true });
    expect(local.orders[0].seen_seqs).toEqual([1]);
  });

  it("restores the durable one-time authorities of a prepared residual recovery", () => {
    const prepared = order("0x3", 9);
    prepared.residual = residual(7);
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

  it("never discards a residual authority merely because a backup claims closure", () => {
    const localOrder = order("0x31", 9);
    localOrder.residual = residual(7);
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.state = "filled";
    remoteOrder.closed_seq = 8;
    remoteOrder.updated_at_ms = 10;
    const local = { version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 7 };
    const remote = { version: 2 as const, notes: [], orders: [remoteOrder], scanned_seq: 7 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0].state).toBe("filled");
    expect(local.orders[0].residual).toEqual(localOrder.residual);
  });

  it("does not resurrect a stale residual after an authenticated terminal transition", () => {
    const localOrder = order("0x32", 9);
    localOrder.residual = residual(7);
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
    const terminal = structuredClone(localOrder);
    terminal.state = "filled";
    terminal.closed_seq = 8;
    terminal.closed_seq_authenticated = true;
    terminal.locked_input = "0";
    terminal.residual = undefined;
    terminal.residual_recovery = undefined;
    terminal.updated_at_ms = 10;
    const local = { version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 8 };
    const remote = { version: 2 as const, notes: [], orders: [terminal], scanned_seq: 8 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0]).toMatchObject({
      state: "filled",
      closed_seq: 8,
      closed_seq_authenticated: true,
      locked_input: "0",
    });
    expect(local.orders[0].residual).toBeUndefined();
    expect(local.orders[0].residual_recovery).toBeUndefined();
    expect(local.orders[0].residual_capacity_freeze).toBeUndefined();
  });

  it("prefers monotonic chain progress over wall-clock order timestamps", () => {
    const localOrder = order("0x0A", 50_000);
    localOrder.seen_seqs = [4];
    localOrder.filled_base = "2";
    localOrder.locked_input = "3";
    const remoteOrder = order("0xa", 1, "filled");
    remoteOrder.seen_seqs = [4, 5];
    remoteOrder.closed_seq = 5;
    remoteOrder.closed_seq_authenticated = true;
    remoteOrder.filled_base = "5";
    remoteOrder.locked_input = "0";
    const local = { version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 5 };
    const remote = { version: 2 as const, notes: [], orders: [remoteOrder], scanned_seq: 5 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders).toHaveLength(1);
    expect(local.orders[0]).toMatchObject({ state: "filled", closed_seq: 5, closed_seq_authenticated: true, filled_base: "5", locked_input: "0" });
    expect(local.orders[0].seen_seqs).toEqual([4, 5]);
  });

  it("takes accounting only from the snapshot with the longest event history", () => {
    const localOrder = order("0x0b", 50_000);
    localOrder.seen_seqs = [4];
    localOrder.filled_base = "2";
    localOrder.filled_quote = "2";
    localOrder.fees = "1";
    localOrder.locked_input = "4";
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.seen_seqs = [4, 5];
    remoteOrder.filled_base = "4";
    remoteOrder.filled_quote = "4";
    remoteOrder.fees = "2";
    remoteOrder.locked_input = "1";

    const local = { version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 5 };
    expect(mergeState(local, {
      version: 2,
      notes: [],
      orders: [remoteOrder],
      scanned_seq: 5,
    })).toBe(true);
    expect(local.orders[0]).toMatchObject({
      filled_base: "4",
      filled_quote: "4",
      fees: "2",
      locked_input: "1",
    });
  });

  it("rejects non-monotonic accounting in a snapshot with later events", () => {
    const earlier = order("0x0c", 1);
    earlier.seen_seqs = [4];
    earlier.filled_base = "4";
    earlier.filled_quote = "4";
    earlier.fees = "2";
    earlier.locked_input = "1";
    const later = structuredClone(earlier);
    later.seen_seqs = [4, 5];

    const expectAccountingFailure = (field: "filled_base" | "filled_quote" | "fees" | "locked_input", value: string) => {
      const malformed = structuredClone(later);
      malformed[field] = value;
      expect(() => mergeState(
        { version: 2, notes: [], orders: [structuredClone(earlier)], scanned_seq: 5 },
        { version: 2, notes: [], orders: [malformed], scanned_seq: 5 },
      )).toThrow(/order accounting regressed/i);
    };

    expectAccountingFailure("filled_base", "3");
    expectAccountingFailure("filled_quote", "3");
    expectAccountingFailure("fees", "1");
    expectAccountingFailure("locked_input", "2");
  });

  it("merges retry metadata for the same prepared residual authority", () => {
    const localOrder = order("0xb", 10);
    localOrder.residual = residual(7);
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
    localOrder.residual = residual(7);
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

  it("preserves monotonic deposit and withdrawal evidence across backups", () => {
    const localNote = note("0xd");
    localNote.source = "deposit";
    localNote.deposit = {
      funding_commitment: "0x11",
      request_id: "request-1",
      requested_at_ms: 10,
      confirmed: false,
      failed: true,
      failure_reason: "temporary",
    };
    localNote.exit = {
      exit_commitment: "0x12",
      stage: "requested",
      requested_at_ms: 20,
    };
    const remoteNote = structuredClone(localNote);
    remoteNote.deposit!.confirmed = true;
    remoteNote.deposit!.transaction_hash = "0x13";
    remoteNote.exit = {
      exit_commitment: "0x12",
      stage: "claiming",
      requested_at_ms: 20,
      open_note_id: "0x15",
      claim_transaction_hash: "0x14",
      claim_attempts: 2,
      claim_retry_at_ms: 50,
    };
    const local = { version: 2 as const, notes: [localNote], orders: [], scanned_seq: 0 };
    const remote = { version: 2 as const, notes: [remoteNote], orders: [], scanned_seq: 0 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.notes[0].deposit).toMatchObject({
      confirmed: true,
      transaction_hash: "0x13",
    });
    expect(local.notes[0].deposit?.failed).toBeUndefined();
    expect(local.notes[0].exit).toMatchObject({
      stage: "claiming",
      claim_transaction_hash: "0x14",
      claim_attempts: 2,
      claim_retry_at_ms: 50,
    });
  });

  it("does not resurrect a failed withdrawal from an older requested snapshot", () => {
    const localNote = note("0xd1");
    localNote.exit = {
      exit_commitment: "0x12",
      stage: "failed",
      requested_at_ms: 20,
      failure: "not accepted",
    };
    const remoteNote = structuredClone(localNote);
    remoteNote.exit = {
      exit_commitment: "0x12",
      stage: "requested",
      requested_at_ms: 20,
    };
    const local = { version: 2 as const, notes: [localNote], orders: [], scanned_seq: 0 };
    expect(mergeState(local, {
      version: 2,
      notes: [remoteNote],
      orders: [],
      scanned_seq: 0,
    })).toBe(false);
    expect(local.notes[0].exit?.stage).toBe("failed");

    remoteNote.exit.requested_at_ms = 21;
    expect(mergeState(local, {
      version: 2,
      notes: [remoteNote],
      orders: [],
      scanned_seq: 0,
    })).toBe(true);
    expect(local.notes[0].exit?.stage).toBe("requested");
  });

  it("does not let a stale failed withdrawal override chain-observed maturity", () => {
    const localNote = note("0xd2");
    localNote.exit = {
      exit_commitment: "0x12",
      stage: "maturing",
      requested_at_ms: 20,
      matures_at_ms: 30,
    };
    const remoteNote = structuredClone(localNote);
    remoteNote.exit = {
      exit_commitment: "0x12",
      stage: "failed",
      requested_at_ms: 20,
      failure: "stale failure",
    };
    const local = { version: 2 as const, notes: [localNote], orders: [], scanned_seq: 0 };

    expect(mergeState(local, {
      version: 2,
      notes: [remoteNote],
      orders: [],
      scanned_seq: 0,
    })).toBe(false);
    expect(local.notes[0].exit).toMatchObject({
      stage: "maturing",
      matures_at_ms: 30,
    });
  });

  it("rejects conflicting note and residual recovery authorities", () => {
    const localNote = note("0xe");
    const remoteNote = note("0xe");
    remoteNote.fields.amount = "6";
    expect(() => mergeState(
      { version: 2, notes: [localNote], orders: [], scanned_seq: 0 },
      { version: 2, notes: [remoteNote], orders: [], scanned_seq: 0 },
    )).toThrow(/note data conflicts/i);

    const localOutput = note("0xe1");
    localOutput.output = { order_id: "0x31", seq: 4, kind: 1 };
    const remoteOutput = structuredClone(localOutput);
    remoteOutput.output = { order_id: "0x32", seq: 4, kind: 1 };
    expect(() => mergeState(
      { version: 2, notes: [localOutput], orders: [], scanned_seq: 4 },
      { version: 2, notes: [remoteOutput], orders: [], scanned_seq: 4 },
    )).toThrow(/note provenance conflicts/i);

    const left = order("0xf", 1);
    left.residual = residual(8);
    left.residual_recovery = {
      residual_seq: 8,
      nullifier: "0x21",
      statement_commitment: "0x22",
      input_asset_id: "0x1",
      input_amount: "5",
      output_asset_id: "0x2",
      output_amount: "0",
      fee_amount: "0",
      input_exit_commitment: "0x23",
      output_exit_commitment: null,
    };
    const right = structuredClone(left);
    right.residual_recovery!.nullifier = "0x24";
    expect(() => mergeState(
      { version: 2, notes: [], orders: [left], scanned_seq: 0 },
      { version: 2, notes: [], orders: [right], scanned_seq: 0 },
    )).toThrow(/residual recovery authority conflicts/i);

    const mismatchedAmount = structuredClone(left);
    mismatchedAmount.residual_recovery!.input_amount = "4";
    expect(() => mergeState(
      { version: 2, notes: [], orders: [left], scanned_seq: 0 },
      { version: 2, notes: [], orders: [mismatchedAmount], scanned_seq: 0 },
    )).toThrow(/residual recovery authority conflicts/i);
  });

  it("rejects divergent order identities, event histories, terminal states, and residual authorities", () => {
    const expectMergeFailure = (left: StoredOrder, right: StoredOrder, message: RegExp) => {
      expect(() => mergeState(
        { version: 2, notes: [], orders: [left], scanned_seq: 0 },
        { version: 2, notes: [], orders: [right], scanned_seq: 0 },
      )).toThrow(message);
    };

    const identityLeft = order("0x51", 1);
    const identityRight = structuredClone(identityLeft);
    identityRight.amount = "6";
    expectMergeFailure(identityLeft, identityRight, /order identity conflicts/i);

    const historyLeft = order("0x52", 1);
    historyLeft.seen_seqs = [1];
    const historyRight = structuredClone(historyLeft);
    historyRight.seen_seqs = [2];
    expectMergeFailure(historyLeft, historyRight, /event histories diverge/i);

    const skippedHistoryLeft = order("0x55", 1);
    skippedHistoryLeft.seen_seqs = [1, 3];
    const skippedHistoryRight = structuredClone(skippedHistoryLeft);
    skippedHistoryRight.seen_seqs = [1, 2, 3];
    expectMergeFailure(skippedHistoryLeft, skippedHistoryRight, /event histories diverge/i);

    const terminalLeft = order("0x53", 1, "filled");
    terminalLeft.closed_seq = 7;
    const terminalRight = structuredClone(terminalLeft);
    terminalRight.state = "cancelled";
    expectMergeFailure(terminalLeft, terminalRight, /terminal states conflict/i);

    const residualLeft = order("0x54", 1);
    residualLeft.residual = residual(8);
    const residualRight = structuredClone(residualLeft);
    residualRight.residual!.note.remaining = "4";
    expectMergeFailure(residualLeft, residualRight, /residual authorities conflict/i);
  });
});

describe("wallet state validation and balances", () => {
  it("rewinds and reopens legacy operator-only closures for chain recovery", () => {
    const legacy = order("0x30", 10, "filled");
    legacy.closed_seq = 7;
    const state = requireWalletState({ version: 2, notes: [], orders: [legacy], scanned_seq: 20 });
    expect(state.scanned_seq).toBe(legacy.scan_after_seq);
    expect(state.orders[0]).toMatchObject({ state: "live", closed_seq: undefined });
  });

  it("rejects malformed amounts and duplicate identities", () => {
    const invalid = { version: 2 as const, notes: [note("0x31")], orders: [], scanned_seq: 0 };
    invalid.notes[0].fields.amount = "-1";
    expect(() => requireWalletState(invalid)).toThrow(/malformed/i);

    const duplicate = note("0x32");
    expect(() => requireWalletState({
      version: 2,
      notes: [duplicate, structuredClone(duplicate)],
      orders: [],
      scanned_seq: 0,
    })).toThrow(/duplicate notes/i);
  });

  it("rejects out-of-field identities, incoherent funding locks, and stale residual retry state", () => {
    const malformed = note("0x31");
    malformed.nullifier = "not-a-felt";
    expect(() => requireWalletState({ version: 2, notes: [malformed], orders: [], scanned_seq: 0 })).toThrow(/malformed/i);

    const locked = note("0x32");
    locked.locked_by = "0x42";
    expect(() => requireWalletState({ version: 2, notes: [locked], orders: [], scanned_seq: 0 })).toThrow(/funding lock/i);

    const withStaleRetry = order("0x43", 1);
    withStaleRetry.residual = residual(7);
    withStaleRetry.residual_capacity_freeze = {
      residual_seq: 6,
      transaction_hash: "0x44",
      submitted_at_ms: 1,
    };
    expect(() => requireWalletState({ version: 2, notes: [], orders: [withStaleRetry], scanned_seq: 0 })).toThrow(/malformed/i);
  });

  it("does not count the same pending or admitted funding twice", () => {
    const funding = note("0x41");
    funding.locked_by = "0x42";
    const pendingOrder = order("0x42", 1, "pending");
    pendingOrder.funding_notes = [funding.commitment];
    pendingOrder.locked_input = "5";
    expect(walletBalances({
      version: 2,
      notes: [funding],
      orders: [pendingOrder],
      scanned_seq: 0,
    })).toEqual([{ asset: "STRK", available: "0", locked: "5" }]);

    pendingOrder.state = "live";
    expect(walletBalances({
      version: 2,
      notes: [funding],
      orders: [pendingOrder],
      scanned_seq: 0,
    })).toEqual([{ asset: "STRK", available: "0", locked: "5" }]);
  });

  it("returns a note to the available balance after a failed withdrawal", () => {
    const available = note("0x46");
    available.exit = {
      exit_commitment: "0x47",
      stage: "failed",
      requested_at_ms: 1,
      failure: "not accepted",
    };
    expect(walletBalances({
      version: 2,
      notes: [available],
      orders: [],
      scanned_seq: 0,
    })).toEqual([{ asset: "STRK", available: "5", locked: "0" }]);
  });
});

describe("private exit claim recovery", () => {
  it("accepts only the bridge's exact claimed-open-note response shape", () => {
    expect(parseClaimedOpenNoteId(["0x0"])).toBeNull();
    expect(parseClaimedOpenNoteId(["0x123"])).toBe("0x123");
    expect(() => parseClaimedOpenNoteId([])).toThrow(/unexpected layout/i);
    expect(() => parseClaimedOpenNoteId(["0x1", "0x2"])).toThrow(/unexpected layout/i);
    expect(() => parseClaimedOpenNoteId(["not-a-felt"])).toThrow(/unexpected layout/i);
  });

  it("persists an on-chain-recovered claim without inventing a transaction hash", () => {
    const claimed = note("0x65", true);
    claimed.exit = {
      exit_commitment: "0x66",
      stage: "finalized",
      requested_at_ms: 1,
      open_note_id: "0x67",
    };
    expect(() => requireWalletState({
      version: 2,
      notes: [claimed],
      orders: [],
      scanned_seq: 0,
    })).not.toThrow();
  });
});

describe("operator response validation", () => {
  const manifest = {
    contracts: { exchange: "0x123" },
    runtime: { epoch_ms: 6_000 },
    market_registry: {
      registry_version: 1,
      registry_hash: "a".repeat(64),
      markets: [{
        market_id: "STRK/USDC",
        base_asset_id: "STRK",
        quote_asset_id: "USDC",
        min_order_amount: "1",
        price_base_scale: "1",
        taker_fee_bps: 2,
        capabilities: { market_data: true, external_matching: true },
        external_settlement_support_quote: "1",
        external_min_profit_quote: "1",
        enabled: true,
        reference_price: {
          methodology: "direct_bbo_midpoint",
          primary: { kind: "direct", adapter: "binance", symbol: "STRKUSDC" },
          corroborating: [],
          min_sources: 1,
          max_age_ms: 15_000,
          max_source_spread_bps: 100,
          max_cross_source_deviation_bps: 100,
          envelope_bps: 100,
          attestation_ttl_ms: 15_000,
        },
      }],
    },
  } as unknown as DeploymentConfig;

  it("binds public exchange identity to the loaded deployment", () => {
    const status = {
      exchange: "0x123",
      seq: 4,
      last_close_ms: 100,
      epoch_ms: 6_000,
      pairs: ["STRK/USDC"],
      registry_version: 1,
      registry_hash: "a".repeat(64),
    };
    expect(requireExchangeStatus(status, manifest)).toBe(status);
    expect(() => requireExchangeStatus({ ...status, epoch_ms: 5_000 }, manifest)).toThrow(/identity/i);
    expect(() => requireExchangeStatus({ ...status, pairs: ["ETH/USDC"] }, manifest)).toThrow(/identity/i);
  });

  it("rejects unrequested, duplicated, and malformed private status records", () => {
    const answer = {
      orders: [{
        order_id: "0x1",
        status: "live",
        cancel_requested: false,
        events: [],
        more_events: false,
        closed_seq: null,
        removal: null,
      }],
      withdrawals: [],
    };
    expect(requireStatusAnswer(answer, ["0x1"], [])).toBe(answer);
    expect(() => requireStatusAnswer(answer, ["0x2"], [])).toThrow(/malformed order status/i);
    expect(() => requireStatusAnswer({ ...answer, orders: [answer.orders[0], answer.orders[0]] }, ["0x1"], [])).toThrow(/excess|malformed/i);
    expect(() => requireStatusAnswer({
      orders: [{ ...answer.orders[0], events: [{ seq: 1, close_time_ms: 1, report: { order_id: "0x2" } }] }],
      withdrawals: [],
    }, ["0x1"], [])).toThrow(/malformed order event/i);
    const withdrawal = { nullifier: "0x3", stage: null };
    expect(requireStatusAnswer({ orders: [], withdrawals: [withdrawal] }, [], ["0x3"]))
      .toEqual({ orders: [], withdrawals: [withdrawal] });
    expect(() => requireStatusAnswer({
      orders: [],
      withdrawals: [{ ...withdrawal, updated_at_ms: 1 }],
    }, [], ["0x3"])).toThrow(/malformed withdrawal status/i);
  });

  it("rejects malformed execution registries and never-synced indexers", () => {
    const point = `04${"11".repeat(64)}`;
    expect(requireExecutionKeyRegistry({ keys: [{ key_id: "key-1", public_key: point }] })).toEqual({
      keys: [{ key_id: "key-1", public_key: point }],
    });
    expect(() => requireExecutionKeyRegistry({ keys: [] })).toThrow(/malformed/i);
    expect(() => requireExecutionKeyRegistry({ keys: [
      { key_id: "key-1", public_key: point },
      { key_id: "key-2", public_key: point },
    ] })).toThrow(/duplicated/i);

    const indexer = {
      service: "zylith-indexer",
      deposits_bucket: "0-7",
      latest_seq: 1,
      last_successful_sync_unix_ms: 10,
      sync_lag_ms: 1,
    };
    expect(requireIndexerStatus(indexer)).toMatchObject({ latest_seq: 1 });
    expect(() => requireIndexerStatus({ ...indexer, last_successful_sync_unix_ms: 0 })).toThrow(/unready/i);
    expect(() => requireIndexerStatus({ ...indexer, latest_seq: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/malformed/i);
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

  it("trusts admission only when every funding nullifier is spent", () => {
    expect(fundingAdmissionDisposition([0n, 0n])).toBe("unused");
    expect(fundingAdmissionDisposition([1n, 1n])).toBe("spent");
    expect(fundingAdmissionDisposition([0n, 1n])).toBe("conflict");
    expect(fundingAdmissionDisposition([2n])).toBe("conflict");
    expect(fundingAdmissionDisposition([])).toBe("conflict");
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

  it("decodes the current nine-field pair ABI without confusing scale and fee", () => {
    const parsed = parseOnchainPairConfig([
      "0x11", "0x22", "100000000", "2", "500", "1", "0x33", "0x44", "1000",
    ]);
    expect(parsed.priceBaseScale).toBe(100000000n);
    expect(parsed.feeBps).toBe(2n);
    expect(parsed.externalSupport).toBe(500n);
    expect(parsed.referenceMethodology).toBe(1n);
    expect(parsed.maxLegSkew).toBe(1000n);
    expect(() => parseOnchainPairConfig(["0x11", "0x22", "2"])).toThrow(/unexpected layout/i);
    expect(() => parseOnchainPairConfig([
      "0x11", "0x22", (1n << 128n).toString(), "2", "500", "1", "0x33", "0x44", "1000",
    ])).toThrow(/malformed/i);
    expect(() => parseOnchainPairConfig([
      "0x0", "0x22", "100000000", "2", "500", "1", "0x33", "0x44", "1000",
    ])).toThrow(/malformed/i);
    expect(() => parseOnchainPairConfig([
      "0x11", "0x11", "100000000", "2", "500", "1", "0x33", "0x44", "1000",
    ])).toThrow(/malformed/i);
    expect(() => parseOnchainPairConfig([
      "0x11", "0x22", "0", "2", "500", "1", "0x33", "0x44", "1000",
    ])).toThrow(/malformed/i);
  });
});
