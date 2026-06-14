import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachOrderIngressTelemetry,
  applyStrk20ExitClaimReceipt,
  applyPendingConsolidationRoot,
  batchSubmissionSafetyBufferMs,
  createZylithWalletRuntime,
  defaultServiceUrlForHost,
  firstRenewalSlotEpoch,
  hasBatchSubmissionSafetyWindow,
  hasRecoverablePendingDeposit,
  hostedNoteConsolidationEnabledForDeployment,
  hostedWithdrawalEnabledForDeployment,
  makerCurveFundingReservePoints,
  renewalPackageMaxSubmissionDelayMs,
  rotateMakerCurvePoints,
  transactionCalldataContainsDepositActivation,
  walletWasmModuleUrlAllowed,
  type LocalNoteRecord,
  type PendingConsolidationRecord,
  type NormalizedMakerCurvePoint,
} from "./zylithWalletRuntime";

beforeEach(() => {
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    clear: vi.fn(() => {
      storage.clear();
    }),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/deployment.json") {
      return {
        ok: true,
        json: async () => ({
          chain_id: "0x534e5f5345504f4c4941",
          contracts: {
            auction_verifier: "0xverifier",
            privacy_deposit_bridge: "0xbridge",
            shielded_asset_adapter: "0xbridge",
          },
          proof: {
            note_consolidation_statement_program_address: "0xconsolidation",
            native_tx_prover_url: "https://tx-prover.test",
          },
          funding: {
            primary: "starknet_privacy",
            capabilities: {
              private_withdrawals: true,
              private_transfers: true,
            },
            starknet_privacy: {
              privacy_pool: "0xpool",
              bridge_adapter: "0xbridge",
              discovery_url: "https://discovery.test",
              proving_url: "https://prover.test",
              paymaster_address: "0xpaymaster",
              paymaster_url: "https://paymaster.test",
              shielded_asset_adapter: "0xbridge",
              proof_signer_class_hash: "0xsigner",
            },
          },
        }),
      };
    }
    return {
      ok: false,
      json: async () => ({}),
      text: async () => "",
    };
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchMock,
  });
});

describe("service URL resolution", () => {
  it("falls back to the production API origin on zylith.fi hosts", () => {
    expect(defaultServiceUrlForHost("app.zylith.fi", "indexer")).toBe(
      "https://api.zylith.fi/indexer"
    );
    expect(defaultServiceUrlForHost("preview.zylith.fi", "/prover/")).toBe(
      "https://api.zylith.fi/prover"
    );
  });

  it("does not infer production services for unrelated hosts", () => {
    expect(defaultServiceUrlForHost("example.com", "indexer")).toBe("");
    expect(defaultServiceUrlForHost("", "indexer")).toBe("");
  });
});

describe("wallet runtime module loading", () => {
  it("allows same-origin wallet wasm modules and rejects remote modules by default", () => {
    expect(
      walletWasmModuleUrlAllowed(
        "/wallet/zylith_wallet_wasm.js",
        "https://app.zylith.fi/orders"
      )
    ).toBe(true);
    expect(
      walletWasmModuleUrlAllowed(
        "https://cdn.example.test/wallet.js",
        "https://app.zylith.fi/orders"
      )
    ).toBe(false);
    expect(
      walletWasmModuleUrlAllowed(
        "https://cdn.example.test/wallet.js",
        "https://app.zylith.fi/orders",
        true
      )
    ).toBe(true);
  });
});

describe("wallet passphrases", () => {
  it("accepts any nonblank passphrase", async () => {
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWallet("x")).resolves.toBe(true);

    expect(runtime.hasVault()).toBe(true);
    runtime.lock();
  });

  it("rejects only blank passphrases", async () => {
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWallet("")).rejects.toThrow(
      "Zylith wallet passphrase cannot be blank"
    );
  });

  it("derives hosted withdrawal availability from deployment capabilities", async () => {
    const runtime = createZylithWalletRuntime(mockWalletCore());

    expect(runtime.hostedWithdrawalAvailable()).toBe(false);
    expect(runtime.hostedNoteConsolidationAvailable()).toBe(false);

    await runtime.createWallet("x");

    expect(runtime.hostedWithdrawalAvailable()).toBe(true);
    expect(runtime.hostedNoteConsolidationAvailable()).toBe(true);
  });
});

describe("hosted withdrawal deployment availability", () => {
  const deployment = {
    contracts: {
      auction_verifier: "0xverifier",
      privacy_deposit_bridge: "0xbridge",
      shielded_asset_adapter: "0xbridge",
    },
    proof: {
      note_consolidation_statement_program_address: "0xconsolidation",
      native_tx_prover_url: "https://tx-prover.test",
    },
    funding: {
      primary: "starknet_privacy",
      capabilities: {
        private_withdrawals: true,
        private_transfers: true,
      },
      starknet_privacy: {
        privacy_pool: "0xpool",
        bridge_adapter: "0xbridge",
        shielded_asset_adapter: "0xbridge",
        discovery_url: "https://discovery.test",
        proving_url: "https://prover.test",
        paymaster_address: "0xpaymaster",
        paymaster_url: "https://paymaster.test",
        proof_signer_class_hash: "0xsigner",
      },
    },
  };

  it("enables withdrawals automatically from a complete private withdrawal deployment", () => {
    expect(hostedWithdrawalEnabledForDeployment(deployment)).toBe(true);
  });

  it("keeps withdrawals disabled when the deployment does not advertise the capability", () => {
    expect(hostedWithdrawalEnabledForDeployment({
      ...deployment,
      funding: {
        ...deployment.funding,
        capabilities: { private_withdrawals: false },
      },
    })).toBe(false);
  });

  it("keeps withdrawals disabled when the STRK privacy rail is incomplete", () => {
    expect(hostedWithdrawalEnabledForDeployment({
      ...deployment,
      funding: {
        ...deployment.funding,
        starknet_privacy: {
          ...deployment.funding.starknet_privacy,
          paymaster_url: "",
        },
      },
    })).toBe(false);
  });

  it("keeps withdrawals disabled when the privacy bridge is not the shielded adapter", () => {
    expect(hostedWithdrawalEnabledForDeployment({
      ...deployment,
      funding: {
        ...deployment.funding,
        starknet_privacy: {
          ...deployment.funding.starknet_privacy,
          shielded_asset_adapter: "0xadapter",
        },
      },
    })).toBe(false);
  });

  it("enables note consolidation automatically from proof deployment capabilities", () => {
    expect(hostedNoteConsolidationEnabledForDeployment(deployment)).toBe(true);
  });

  it("keeps note consolidation disabled without the native statement program", () => {
    expect(hostedNoteConsolidationEnabledForDeployment({
      ...deployment,
      proof: {
        ...deployment.proof,
        note_consolidation_statement_program_address: "",
      },
    })).toBe(false);
  });
});

describe("batch submission safety", () => {
  it("uses a proportional safety buffer with a conservative default", () => {
    expect(batchSubmissionSafetyBufferMs()).toBe(15_000);
    expect(batchSubmissionSafetyBufferMs(90_000)).toBe(15_000);
    expect(batchSubmissionSafetyBufferMs(60_000)).toBe(12_000);
    expect(batchSubmissionSafetyBufferMs(45_000)).toBe(9_000);
    expect(batchSubmissionSafetyBufferMs(30_000)).toBe(6_000);
    expect(batchSubmissionSafetyBufferMs(20_000)).toBe(5_000);
  });

  it("requires more than the active safety buffer before close", () => {
    const now = 1_000_000;

    expect(hasBatchSubmissionSafetyWindow(now + 15_000, now)).toBe(false);
    expect(hasBatchSubmissionSafetyWindow(now + 15_001, now)).toBe(true);
    expect(hasBatchSubmissionSafetyWindow(now + 6_000, now, 30_000)).toBe(false);
    expect(hasBatchSubmissionSafetyWindow(now + 6_001, now, 30_000)).toBe(true);
  });

  it("allows self-relay to use the current epoch only inside the safety window", () => {
    const now = 1_000_000;
    const batch = { epoch_id: 42, close_time_unix_ms: now + 15_001 };

    expect(firstRenewalSlotEpoch(batch, "SelfRelay", now)).toBe(42);
    expect(
      firstRenewalSlotEpoch(
        { ...batch, close_time_unix_ms: now + 15_000 },
        "SelfRelay",
        now
      )
    ).toBe(43);
    expect(
      firstRenewalSlotEpoch(
        { ...batch, close_time_unix_ms: now + 6_001 },
        "SelfRelay",
        now,
        30_000
      )
    ).toBe(42);
    expect(
      firstRenewalSlotEpoch(
        { ...batch, close_time_unix_ms: now + 6_000 },
        "SelfRelay",
        now,
        30_000
      )
    ).toBe(43);
  });

  it("starts managed Zylith Relay packages at the next epoch", () => {
    const now = 1_000_000;

    expect(
      firstRenewalSlotEpoch(
        { epoch_id: 42, close_time_unix_ms: now + 600_000 },
        "ZylithRelay",
        now
      )
    ).toBe(43);
  });

  it("gives managed relays a wider package submission window than self relay", () => {
    expect(renewalPackageMaxSubmissionDelayMs("SelfRelay")).toBe(7_000);
    expect(renewalPackageMaxSubmissionDelayMs("ZylithRelay")).toBe(45_000);
  });
});

describe("order ingress telemetry", () => {
  it("attaches telemetry without mutating the original payload", () => {
    const payload = {
      order_submission: { order_bundle: { order_commitment: "0xabc" } },
    };
    const telemetry = {
      version: 1,
      client_build_ms: 40,
      private_submission_delay_ms: 0,
      client_elapsed_before_private_ingress_ms: 250,
      batch_time_remaining_before_private_ingress_ms: 20_000,
      submission_safety_buffer_ms: 15_000,
    } as const;

    const result = attachOrderIngressTelemetry(payload, telemetry);

    expect(result).toEqual({
      order_submission: { order_bundle: { order_commitment: "0xabc" } },
      ingress_telemetry: telemetry,
    });
    expect(payload).toEqual({
      order_submission: { order_bundle: { order_commitment: "0xabc" } },
    });
  });

  it("leaves non-object payloads unchanged", () => {
    expect(
      attachOrderIngressTelemetry("raw", {
        version: 1,
        client_build_ms: 10,
        private_submission_delay_ms: 0,
        client_elapsed_before_private_ingress_ms: 10,
        batch_time_remaining_before_private_ingress_ms: 20_000,
        submission_safety_buffer_ms: 15_000,
      })
    ).toBe("raw");
  });
});

describe("maker curve materialization", () => {
  it("rotates prices without reducing per-band depth below protocol minimums", () => {
    const oneStrk = 1_000_000_000_000_000_000n;
    const points: NormalizedMakerCurvePoint[] = [
      { price: 10_000_000_000_000_000n, base_amount: oneStrk },
      { price: 15_000_000_000_000_000n, base_amount: oneStrk },
      { price: 20_000_000_000_000_000n, base_amount: oneStrk },
    ];

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const rotated = rotateMakerCurvePoints(points, 1_000);
      expect(rotated).toHaveLength(points.length);
      expect(rotated.map(point => point.base_amount)).toEqual(points.map(point => point.base_amount));
      expect(rotated.every(point => point.base_amount >= oneStrk)).toBe(true);
    }
  });

  it("reserves bid-curve funding against the maximum upward price rotation", () => {
    const oneStrk = 1_000_000_000_000_000_000n;
    const points: NormalizedMakerCurvePoint[] = [
      { price: 100_000_000_000_000n, base_amount: oneStrk },
      { price: 120_000_000_000_000n, base_amount: oneStrk },
      { price: 140_000_000_000_000n, base_amount: oneStrk },
    ];

    const reserve = makerCurveFundingReservePoints(points, "Buy", 250);
    expect(reserve.map(point => point.price)).toEqual([
      102_500_000_000_000n,
      123_000_000_000_000n,
      143_500_000_000_000n,
    ]);
    expect(reserve.map(point => point.base_amount)).toEqual(points.map(point => point.base_amount));

    const askReserve = makerCurveFundingReservePoints(points, "Sell", 250);
    expect(askReserve.map(point => point.price)).toEqual(points.map(point => point.price));
  });
});

describe("pending consolidation finalization", () => {
  it("does not mutate local notes before the expected output root is visible on-chain", () => {
    const pending = pendingConsolidation();
    const records = [sourceNote(pending)];

    const result = applyPendingConsolidationRoot(records, pending, "0xdead", "scope-a");

    expect(result.changed).toBe(false);
    expect(result.records[0]).toBe(records[0]);
    expect(result.outputRecords).toHaveLength(0);
  });

  it("marks sources spent and returns recovery outputs only after root verification", () => {
    const pending = pendingConsolidation();
    const records = [sourceNote(pending)];

    const result = applyPendingConsolidationRoot(records, pending, "0xabc", "scope-a");

    expect(result.changed).toBe(true);
    expect(result.records[0].spent).toBe(true);
    expect(result.records[0].locked_by_order).toBeUndefined();
    expect(result.records[0].pending_consolidation).toBeUndefined();
    expect(result.outputRecords).toHaveLength(1);
    expect(result.outputRecords[0]).toMatchObject({
      note_commitment: "0xdef",
      deployment_scope: "scope-a",
      batch_id: "0xconsolidation",
      source: "settlement_output",
    });
  });
});

describe("STRK20 exit claim reconciliation", () => {
  it("does not mark a failed STRK20 open-note claim as spent", () => {
    const note = strk20ExitNote();

    const changed = applyStrk20ExitClaimReceipt(note, {
      failed: true,
      notFound: false,
      reason: "reverted",
    });

    expect(changed).toBe(true);
    expect(note.spent).toBe(false);
    expect(note.locked_by_order).toBe("withdrawal:0xexit");
    expect(note.pending_withdrawal_tx).toBe("0xstaged");
    expect(note.pending_strk20_open_note_tx).toBeUndefined();
    expect(note.strk20_open_note_id).toBeUndefined();
  });

  it("leaves pending STRK20 open-note claims untouched until confirmed", () => {
    const note = strk20ExitNote();

    const changed = applyStrk20ExitClaimReceipt(note, {
      failed: false,
      notFound: false,
      confirmed: false,
    });

    expect(changed).toBe(false);
    expect(note.spent).toBe(false);
    expect(note.pending_withdrawal_tx).toBe("0xstaged");
    expect(note.pending_strk20_open_note_tx).toBe("0xclaim");
    expect(note.strk20_open_note_id).toBe("0xopen");
  });

  it("marks STRK20 open-note exits spent only after claim confirmation", () => {
    const note = strk20ExitNote();

    const changed = applyStrk20ExitClaimReceipt(note, {
      failed: false,
      notFound: false,
      confirmed: true,
    });

    expect(changed).toBe(true);
    expect(note.spent).toBe(true);
    expect(note.locked_by_order).toBeUndefined();
    expect(note.pending_withdrawal_tx).toBeUndefined();
    expect(note.pending_strk20_open_note_tx).toBeUndefined();
    expect(note.strk20_open_note_id).toBe("0xopen");
  });

});

describe("deposit confirmation polling", () => {
  it("continues polling recoverable pending deposits", () => {
    expect(hasRecoverablePendingDeposit([
      {
        ...sourceNote(pendingConsolidation()),
        locked_by_order: undefined,
        deposit_confirmed: false,
        pending_deposit_tx: "0xtx",
      },
    ])).toBe(true);
  });

  it("does not poll terminal or non-deposit notes", () => {
    const pending = pendingConsolidation();
    expect(hasRecoverablePendingDeposit([
      {
        ...sourceNote(pending),
        locked_by_order: undefined,
        deposit_confirmed: true,
      },
      {
        ...sourceNote(pending),
        locked_by_order: undefined,
        deposit_failed: true,
      },
      {
        ...sourceNote(pending),
        locked_by_order: undefined,
        spent: true,
      },
      {
        ...sourceNote(pending),
        source: "settlement_output",
        locked_by_order: undefined,
      },
    ])).toBe(false);
  });

  it("matches deposit activations from successful transaction calldata", () => {
    const calldata = new Set(["0xabc", "0x1", "0x2", "0x3"]);

    expect(transactionCalldataContainsDepositActivation(calldata, {
      bridgeAddress: "0x0abc",
      fundingCommitment: "0x01",
      depositRoot: "0x02",
      activation: "0x03",
    })).toBe(true);
  });

  it("rejects calldata activation fallback when bridge or tuple fields differ", () => {
    const calldata = new Set(["0xabc", "0x1", "0x2", "0x3"]);

    expect(transactionCalldataContainsDepositActivation(calldata, {
      bridgeAddress: "0xdef",
      fundingCommitment: "0x1",
      depositRoot: "0x2",
      activation: "0x3",
    })).toBe(false);
    expect(transactionCalldataContainsDepositActivation(calldata, {
      bridgeAddress: "0xabc",
      fundingCommitment: "0x1",
      depositRoot: "0x2",
      activation: "0x4",
    })).toBe(false);
  });
});

function pendingConsolidation(): PendingConsolidationRecord {
  return {
    consolidation_id: "0xconsolidation",
    output_note_root: "0xabc",
    source_note_commitments: ["0x123"],
    outputs: [
      {
        note_commitment: "0xdef",
        note: notePreimage("0xasset", "100"),
        output_note: { value: "0xout" },
        output_proof: { merkle_path: [], merkle_directions: [] },
      },
    ],
    submitted_at_unix_ms: 1_700_000_000_000,
  };
}

function sourceNote(pending: PendingConsolidationRecord): LocalNoteRecord {
  return {
    note_commitment: "0x123",
    deployment_scope: "scope-a",
    source: "deposit",
    note: notePreimage("0xasset", "100"),
    locked_by_order: `consolidation:${pending.consolidation_id}`,
    pending_consolidation: pending,
  };
}

function strk20ExitNote(): LocalNoteRecord {
  return {
    note_commitment: "0xexit",
    deployment_scope: "scope-a",
    source: "settlement_output",
    note: notePreimage("0xasset", "100"),
    locked_by_order: "withdrawal:0xexit",
    spent: false,
    pending_withdrawal_tx: "0xstaged",
    pending_strk20_open_note_tx: "0xclaim",
    strk20_exit_commitment: "0xexitcommitment",
    strk20_open_note_id: "0xopen",
    withdrawal_requested_at_unix_ms: 1_700_000_000_000,
  };
}

function notePreimage(asset: string, amount: string): LocalNoteRecord["note"] {
  return {
    asset_id: asset,
    amount,
    owner_public_key: "0xowner",
    spend_authority: "0xspend",
    withdraw_authority: "0xwithdraw",
    blinding: "0xblind",
    nonce: 1,
    metadata_commitment: "0xmeta",
  };
}

function mockWalletCore() {
  const seedHex = "11".repeat(32);
  return {
    zylith_wallet_generate_mnemonic: () => "zylith test seed phrase",
    zylith_wallet_mnemonic_to_seed_hex: () => seedHex,
    zylith_wallet_seed_hex_to_mnemonic: () => "zylith test seed phrase",
    zylith_wallet_derive_public_config: () =>
      JSON.stringify({
        account_id: "acct-test",
        spend_authority: "0xspend",
        note_recognition_public_key: "0xowner",
        withdraw_authority: "0xwithdraw",
      }),
  } as never;
}
