import { beforeEach, describe, expect, it, vi } from "vitest";
import checkedInDeployment from "../public/deployment.example.json";
import { RuntimeHttpStatusError } from "./domain/runtimeHttp";
import {
  clearSelectedStarknetProvider,
  connectStarknetProvider,
} from "./domain/browserWallet";
import {
  decryptLocalStore,
  encryptLocalStore,
  type EncryptedLocalStore,
} from "./domain/walletLocalCrypto";
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
  isAmbiguousPrivateOrderSubmissionError,
  isDefiniteNoteConsolidationSubmitRejection,
  hostedRelayLeadEpochs,
  mergeLocalNoteRecord,
  noteConsolidationEnabledForDeployment,
  renewalPackageMaxSubmissionDelayMs,
  shouldReleasePendingLiquidityPositionOpen,
  strk20WithdrawalEnabledForDeployment,
  transactionCalldataContainsDepositActivation,
  validateWalletChainMatch,
  walletWasmModuleUrlAllowed,
  type LocalNoteRecord,
  type PendingConsolidationRecord,
} from "./zylithWalletRuntime";

function testDeploymentManifest() {
  const manifest = structuredClone(checkedInDeployment);
  manifest.rpc_url = "https://rpc.test";
  manifest.contracts.auction_verifier = "0x101";
  manifest.contracts.privacy_deposit_bridge = "0x102";
  manifest.contracts.shielded_asset_adapter = "0x102";
  manifest.proof.note_consolidation_statement_program_address = "0x103";
  manifest.proof.native_tx_prover_url = "https://tx-prover.test";
  manifest.proof.native_tx_prover_ohttp_enabled = true;
  manifest.funding.starknet_privacy.privacy_pool = "0x104";
  manifest.funding.starknet_privacy.bridge_adapter = "0x102";
  manifest.funding.starknet_privacy.discovery_url = "https://discovery.test";
  manifest.funding.starknet_privacy.proving_url = "https://prover.test";
  manifest.funding.starknet_privacy.proving_ohttp_enabled = true;
  manifest.funding.starknet_privacy.paymaster_address = "0x105";
  manifest.funding.starknet_privacy.paymaster_url = "https://paymaster.test";
  manifest.funding.starknet_privacy.proof_signer_class_hash = "0x106";
  return manifest;
}

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
        json: async () => testDeploymentManifest(),
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "",
    };
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchMock,
  });
  clearSelectedStarknetProvider();
});

async function selectRuntimeProvider(provider: unknown) {
  (provider as { chainId?: string }).chainId ??= "0x534e5f5345504f4c4941";
  await connectStarknetProvider(provider as never, "ready");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

describe("liquidity position pending-open reconciliation", () => {
  const now = 1_800_000_000_000;
  const batch = (
    status: "Open" | "Closed" | "Clearing" | "Settled" | "Cancelled" | "Proving" | "Settling",
    closeDeltaMs: number
  ) => ({
    batch_id: "batch-strk-usdc-42",
    pair_id: "STRK/USDC",
    epoch_id: 42,
    close_time_unix_ms: now - closeDeltaMs,
    status,
    order_count_bucket: "0-7",
  });

  it("only releases failed pending LP opens after the batch is safely stale", () => {
    expect(shouldReleasePendingLiquidityPositionOpen(batch("Open", 60 * 60_000), now)).toBe(false);
    expect(shouldReleasePendingLiquidityPositionOpen(batch("Proving", 60 * 60_000), now)).toBe(false);
    expect(shouldReleasePendingLiquidityPositionOpen(batch("Settling", 60 * 60_000), now)).toBe(false);
    expect(shouldReleasePendingLiquidityPositionOpen(batch("Settled", 60 * 60_000), now)).toBe(false);
    expect(shouldReleasePendingLiquidityPositionOpen(batch("Closed", 29 * 60_000), now)).toBe(false);
    expect(shouldReleasePendingLiquidityPositionOpen(batch("Closed", 30 * 60_000), now)).toBe(true);
    expect(shouldReleasePendingLiquidityPositionOpen(batch("Cancelled", 0), now)).toBe(true);
    expect(shouldReleasePendingLiquidityPositionOpen(null, now)).toBe(false);
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
  });
});

describe("wallet chain validation", () => {
  it("fails closed when deployment or wallet chain ID is missing", () => {
    expect(() => validateWalletChainMatch("", "SN_SEPOLIA", "sepolia")).toThrow(
      "Deployment manifest is missing the Starknet chain ID."
    );
    expect(() =>
      validateWalletChainMatch("0x534e5f5345504f4c4941", "", "sepolia")
    ).toThrow("Connected Starknet wallet did not report its network.");
  });

  it("accepts matching aliases and rejects mismatched networks", () => {
    expect(() =>
      validateWalletChainMatch("0x534e5f5345504f4c4941", "SN_SEPOLIA", "sepolia")
    ).not.toThrow();
    expect(() =>
      validateWalletChainMatch("0x534e5f5345504f4c4941", "SN_MAIN", "sepolia")
    ).toThrow("Wrong Starknet network. Switch to Starknet Sepolia in your wallet and retry.");
  });

  it("reads chain ID through method-style wallet providers", async () => {
    const request = vi.fn(async (payload: { type?: string; method?: string }) => {
      if (payload.type === "wallet_requestAccounts") return [{ address: "0xabc" }];
      if (payload.type === "wallet_requestChainId") {
        throw new Error("unsupported method");
      }
      if (payload.method === "wallet_requestChainId") return "SN_SEPOLIA";
      if (payload.type === "wallet_signTypedData") return ["0x1", "0x2"];
      return null;
    });
    await connectStarknetProvider({
      account: { address: "0xabc" },
      request,
    } as never, "ready");
    request.mockClear();
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith({ type: "wallet_requestChainId" });
    expect(request).toHaveBeenCalledWith({ method: "wallet_requestChainId" });
  });
});

describe("wallet-signature sessions", () => {
  it("derives STRK20 withdrawal availability from deployment config", async () => {
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const runtime = createZylithWalletRuntime(mockWalletCore());

    expect(runtime.strk20WithdrawalAvailable()).toBe(false);
    expect(runtime.noteConsolidationAvailable()).toBe(false);

    await runtime.createWalletWithWalletSignature("0xabc");

    expect(runtime.strk20WithdrawalAvailable()).toBe(true);
    expect(runtime.noteConsolidationAvailable()).toBe(true);
  });

  it("creates and unlocks wallet-signature vaults", async () => {
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(runtime.vaultAuthMode("0xabc")).toBe("wallet-signature");
    expect(runtime.vaultAuthMode("0xdef")).toBe("none");
    expect(
      JSON.parse(localStorage.getItem("zylith.wallet.vault.v4:0xabc") ?? "{}"),
    ).toMatchObject({ version: 4, kdf: "wallet-signature-sha256-v2" });
    const walletVaultCalls = vi.mocked(fetch).mock.calls.filter(([input]) =>
      String(input).includes("/api/wallet-vaults/"),
    );
    expect(walletVaultCalls).toHaveLength(2);
    for (const [, init] of walletVaultCalls) {
      expect(init?.headers).toMatchObject({
        "x-zylith-wallet-vault-auth": expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
    runtime.lock();

    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(signMessage).toHaveBeenCalled();
  });

  it("removes deployment-stale wallet-signature vaults so they can be recreated", async () => {
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    localStorage.setItem(
      "zylith.wallet.vault.v4:0xabc",
      JSON.stringify({
        version: 4,
        kdf: "wallet-signature-sha256-v2",
        algorithm: "AES-GCM",
        wallet_address: "0xabc",
        chain_id: "0x534e5f5345504f4c4941",
        deployment_id: "old-deployment",
        origin: window.location.origin,
        message_version: 2,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAA",
      }),
    );
    const runtime = createZylithWalletRuntime(mockWalletCore());

    expect(runtime.vaultAuthMode("0xabc")).toBe("wallet-signature");
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(false);
    expect(localStorage.getItem("zylith.wallet.vault.v4:0xabc")).toBeNull();
    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);
  });

  it("authorizes private liquidity position lifecycle actions with the unlocked seed", async () => {
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await runtime.createWalletWithWalletSignature("0xabc");

    expect(runtime.authorizePrivateLiquidityPositionOpen({
      position_id: "0x123",
      output_position_commitment: "0xabc",
      epoch: "7",
      base_amount: "0",
      quote_amount: "0",
    })).toEqual({
      signature_r: "0xopenr",
      signature_s: "0xopens",
    });
  });

  it("rejects legacy liquidity curve order modes at the public submission boundary", async () => {
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
      account: {
        address: "0xabc",
        signMessage,
      },
    });
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await runtime.createWalletWithWalletSignature("0xabc");

    const baseDraft = {
      pair: "STRK/USDC",
      side: "Sell" as const,
      amount: "1000000000000000000",
      limitPrice: "1000000",
      minFill: "1",
      fillOrKill: false,
      batchId: "batch-strk-usdc-9",
      batchWindowMs: 20_000,
    };

    await expect(
      runtime.submitPrivateOrder({
        ...baseDraft,
        mode: "Liquidity Position",
      })
    ).rejects.toThrow(
      "Private liquidity must be opened through the private liquidity position lifecycle"
    );
    await expect(
      runtime.submitPrivateOrder({
        ...baseDraft,
        mode: "Resting",
      })
    ).rejects.toThrow(
      "Private liquidity must be opened through the private liquidity position lifecycle"
    );
  });

  it("opens private liquidity positions through private and coordinator lifecycle ingress", async () => {
    const seedHex = "11".repeat(32);
    const lifecycleId = "a".repeat(64);
    const deploymentScope = "0x534e5f5345504f4c4941:0x101:0x102:0x102";
    const notesKey = `zylith.wallet.notes.v1:acct-test:${deploymentScope}`;
    const localNotes: LocalNoteRecord[] = [
      {
        note_commitment: "0xbase",
        deployment_scope: deploymentScope,
        source: "deposit",
        deposit_confirmed: true,
        note: {
          asset_id: "STRK",
          amount: "1000",
          owner_public_key: "0xowner",
          spend_authority: "0xspend",
          withdraw_authority: "0xwithdraw",
          blinding: "0x101",
          nonce: 1,
          metadata_commitment: "0x0",
        },
      },
      {
        note_commitment: "0xquote",
        deployment_scope: deploymentScope,
        source: "deposit",
        deposit_confirmed: true,
        note: {
          asset_id: "USDC",
          amount: "2000",
          owner_public_key: "0xowner",
          spend_authority: "0xspend",
          withdraw_authority: "0xwithdraw",
          blinding: "0x102",
          nonce: 2,
          metadata_commitment: "0x0",
        },
      },
    ];
    localStorage.setItem(
      notesKey,
      JSON.stringify(
        await encryptLocalStore(localNotes, seedHex, "acct-test", "notes")
      )
    );
    const buildOpen = vi.fn((inputJson: string) => {
      const input = JSON.parse(inputJson);
      expect(input).toMatchObject({
        pair_id: "STRK/USDC",
        batch_id: "batch-strk-usdc-9",
        epoch_id: "9",
        base_asset_id: "STRK",
        quote_asset_id: "USDC",
        base_reserve: "500",
        quote_reserve: "1500",
        prior_liquidity_position_root: "0x0",
      });
      expect(input.funding_notes).toHaveLength(2);
      expect(input.open_funding).toBeUndefined();
      return JSON.stringify({
        lifecycle_id: lifecycleId,
        position: { position_id: "0xposid", pair_id: "STRK/USDC" },
        position_commitment: "0xpos",
        transition_commitment: "0xtrans",
        funding_note_commitments: ["0xbase", "0xquote"],
        ingress_request: {
          pair_id: "STRK/USDC",
          batch_id: "batch-strk-usdc-9",
          epoch_id: 9,
          transition_witness: { kind: "test" },
          ingress_telemetry: { version: 1 },
        },
      });
    });
    const core = {
      ...(mockWalletCore() as Record<string, unknown>),
      zylith_wallet_build_private_liquidity_position_open: buildOpen,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/deployment.json") return jsonResponse(testDeploymentManifest());
      if (url === "https://rpc.test") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.method).toBe("starknet_call");
        expect(body.params.request.calldata).toEqual([]);
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: ["0x0"] });
      }
      if (url.endsWith("/health")) return jsonResponse({ batch_window_ms: 20_000 });
      if (url.endsWith("/api/private/liquidity-positions/lifecycle")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.ingress_telemetry.version).toBe(1);
        return jsonResponse({
          receipt: { lifecycle_id: lifecycleId },
          coordinator_submission: {
            lifecycle_id: lifecycleId,
            transition_commitment: "0xtrans",
          },
        });
      }
      if (url.endsWith("/api/liquidity-positions/lifecycle")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.lifecycle_id).toBe(lifecycleId);
        expect(body.ingress_telemetry.version).toBe(1);
        return jsonResponse({
          lifecycle_id: lifecycleId,
          transition_commitment: "0xtrans",
          batch_id: "batch-strk-usdc-9",
          accepted_at_unix_ms: Date.now(),
        });
      }
      if (url.includes("/api/recovery/")) {
        if ((init?.method ?? "GET").toUpperCase() === "GET") {
          return jsonResponse({ artifacts: [] });
        }
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/wallet-vaults/")) return jsonResponse({ ok: true });
      return jsonResponse({}, 404);
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
      account: {
        address: "0xabc",
        signMessage,
      },
    });
    const runtime = createZylithWalletRuntime(core as never);

    await runtime.createWalletWithWalletSignature("0xabc");
    const result = await runtime.openPrivateLiquidityPosition(
      {
        kind: "OpenPrivateLiquidityPosition",
        pairId: "STRK/USDC",
        baseAssetId: "STRK",
        quoteAssetId: "USDC",
        baseReserveAtomic: "500",
        quoteReserveAtomic: "1500",
        priceLowerBoundAtomic: "90",
        priceUpperBoundAtomic: "120",
        maxFillBasePerBatchAtomic: "100",
        curvePolicy: {
          kind: "StaticRange",
          bandCount: 3,
          spreadBps: 30,
          targetBaseRatioBps: 5000,
          inventorySkewBps: 0,
          maxPriceDeviationBps: 0,
        },
        rotationPolicy: {
          maxPriceRotationBps: 50,
          maxDepthRotationBps: 50,
          skipEpochBps: 0,
        },
        durationHours: 1,
        privacyMode: "RotatingPrivate",
      },
      {
        batch_id: "batch-strk-usdc-9",
        pair_id: "STRK/USDC",
        epoch_id: 9,
        close_time_unix_ms: Date.now() + 60_000,
        status: "Open",
        order_count_bucket: "0",
      }
    );

    expect(result).toMatchObject({
      lifecycle_id: lifecycleId,
      position_commitment: "0xpos",
      transition_commitment: "0xtrans",
      batch_id: "batch-strk-usdc-9",
      epoch_id: 9,
    });
    expect(buildOpen).toHaveBeenCalledTimes(1);
    const privatePosts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/private/liquidity-positions/lifecycle")
    );
    const orderPosts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/private/orders")
    );
    expect(privatePosts).toHaveLength(1);
    expect(orderPosts).toHaveLength(0);
    const stored = JSON.parse(localStorage.getItem(notesKey) ?? "{}") as EncryptedLocalStore;
    const decoded = await decryptLocalStore<LocalNoteRecord[]>(
      stored,
      seedHex,
      "acct-test",
      "notes"
    );
    expect(decoded.map((note) => note.locked_by_order)).toEqual([
      `0xliquidity-position:${lifecycleId}`,
      `0xliquidity-position:${lifecycleId}`,
    ]);
  });

  it("requests an insertion witness before opening into a non-empty liquidity position root", async () => {
    const seedHex = "11".repeat(32);
    const lifecycleId = "b".repeat(64);
    const deploymentScope = "0x534e5f5345504f4c4941:0x101:0x102:0x102";
    const notesKey = `zylith.wallet.notes.v1:acct-test:${deploymentScope}`;
    const localNotes: LocalNoteRecord[] = [
      {
        note_commitment: "0xbase",
        deployment_scope: deploymentScope,
        source: "deposit",
        deposit_confirmed: true,
        note: {
          asset_id: "STRK",
          amount: "1000",
          owner_public_key: "0xowner",
          spend_authority: "0xspend",
          withdraw_authority: "0xwithdraw",
          blinding: "0x101",
          nonce: 1,
          metadata_commitment: "0x0",
        },
      },
      {
        note_commitment: "0xquote",
        deployment_scope: deploymentScope,
        source: "deposit",
        deposit_confirmed: true,
        note: {
          asset_id: "USDC",
          amount: "2000",
          owner_public_key: "0xowner",
          spend_authority: "0xspend",
          withdraw_authority: "0xwithdraw",
          blinding: "0x102",
          nonce: 2,
          metadata_commitment: "0x0",
        },
      },
    ];
    localStorage.setItem(
      notesKey,
      JSON.stringify(
        await encryptLocalStore(localNotes, seedHex, "acct-test", "notes")
      )
    );
    const buildOpen = vi.fn((inputJson: string) => {
      const input = JSON.parse(inputJson);
      const callIndex = buildOpen.mock.calls.length;
      if (callIndex === 1) {
        expect(input).toMatchObject({
          prior_liquidity_position_root: "0x0",
        });
        expect(input.state_update).toBeUndefined();
      } else {
        expect(input).toMatchObject({
          prior_liquidity_position_root: "0xabc",
          state_update: { position_id: "0xposid" },
        });
      }
      return JSON.stringify({
        lifecycle_id: lifecycleId,
        position: { position_id: "0xposid", pair_id: "STRK/USDC" },
        position_commitment: "0xpos",
        transition_commitment: "0xtrans",
        funding_note_commitments: ["0xbase", "0xquote"],
        ingress_request: {
          pair_id: "STRK/USDC",
          batch_id: "batch-strk-usdc-9",
          epoch_id: 9,
          transition_witness: { kind: "test" },
          ingress_telemetry: { version: 1 },
        },
      });
    });
    const core = {
      ...(mockWalletCore() as Record<string, unknown>),
      zylith_wallet_build_private_liquidity_position_open: buildOpen,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/deployment.json") return jsonResponse(testDeploymentManifest());
      if (url === "https://rpc.test") {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: ["0xabc"] });
      }
      if (url.endsWith("/health")) return jsonResponse({ batch_window_ms: 20_000 });
      if (url.endsWith("/api/private/liquidity-positions/insertion-witness")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body).toMatchObject({
          position_id: "0xposid",
          output_commitment: "0xpos",
          prior_liquidity_position_root: "0xabc",
        });
        return jsonResponse({
          prior_liquidity_position_root: "0xabc",
          new_liquidity_position_root: "0xdef",
          active_position_count: 1,
          state_update: {
            position_id: "0xposid",
            output_commitment: "0xpos",
            sparse_witness: {
              key_low: "0x1",
              key_high: "0x2",
              merkle_path: [],
              merkle_directions: [],
            },
          },
        });
      }
      if (url.endsWith("/api/private/liquidity-positions/lifecycle")) {
        return jsonResponse({
          receipt: { lifecycle_id: lifecycleId },
          coordinator_submission: {
            lifecycle_id: lifecycleId,
            transition_commitment: "0xtrans",
          },
        });
      }
      if (url.endsWith("/api/liquidity-positions/lifecycle")) {
        return jsonResponse({
          lifecycle_id: lifecycleId,
          transition_commitment: "0xtrans",
          batch_id: "batch-strk-usdc-9",
          accepted_at_unix_ms: Date.now(),
        });
      }
      if (url.includes("/api/recovery/")) {
        if ((init?.method ?? "GET").toUpperCase() === "GET") {
          return jsonResponse({ artifacts: [] });
        }
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/wallet-vaults/")) return jsonResponse({ ok: true });
      return jsonResponse({}, 404);
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
      account: {
        address: "0xabc",
        signMessage,
      },
    });
    const runtime = createZylithWalletRuntime(core as never);

    await runtime.createWalletWithWalletSignature("0xabc");
    await expect(
      runtime.openPrivateLiquidityPosition(
        {
          kind: "OpenPrivateLiquidityPosition",
          pairId: "STRK/USDC",
          baseAssetId: "STRK",
          quoteAssetId: "USDC",
          baseReserveAtomic: "500",
          quoteReserveAtomic: "1500",
          priceLowerBoundAtomic: "90",
          priceUpperBoundAtomic: "120",
          maxFillBasePerBatchAtomic: "100",
          curvePolicy: {
            kind: "StaticRange",
            bandCount: 3,
            spreadBps: 30,
            targetBaseRatioBps: 5000,
            inventorySkewBps: 0,
            maxPriceDeviationBps: 0,
          },
          rotationPolicy: {
            maxPriceRotationBps: 50,
            maxDepthRotationBps: 50,
            skipEpochBps: 0,
          },
          durationHours: 1,
          privacyMode: "RotatingPrivate",
        },
        {
          batch_id: "batch-strk-usdc-9",
          pair_id: "STRK/USDC",
          epoch_id: 9,
          close_time_unix_ms: Date.now() + 60_000,
          status: "Open",
          order_count_bucket: "0",
        }
      )
    ).resolves.toMatchObject({
      lifecycle_id: lifecycleId,
      position_commitment: "0xpos",
    });

    expect(buildOpen).toHaveBeenCalledTimes(2);
    const insertionPosts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/private/liquidity-positions/insertion-witness")
    );
    expect(insertionPosts).toHaveLength(1);
  });

  it("reconfigures a stored private liquidity position through state-witnessed lifecycle ingress", async () => {
    const seedHex = "11".repeat(32);
    const lifecycleId = "c".repeat(64);
    const deploymentScope = "0x534e5f5345504f4c4941:0x101:0x102:0x102";
    const positionsKey = `zylith.wallet.liquidity-positions.v1:acct-test:${deploymentScope}`;
    const storedPosition = {
      position_id: "0x701",
      pair_id: "STRK/USDC",
      base_asset_id: "STRK",
      quote_asset_id: "USDC",
      owner_authority: "0xabc123",
      expiry_epoch: "27",
    };
    localStorage.setItem(
      positionsKey,
      JSON.stringify(
        await encryptLocalStore(
          [
            {
              id: "0x701",
              position: storedPosition,
              position_commitment: "0x7010",
              pair_id: "STRK/USDC",
              status: "active",
              deployment_scope: deploymentScope,
            },
          ],
          seedHex,
          "acct-test",
          "liquidity-positions"
        )
      )
    );
    const prepareReconfigure = vi.fn((inputJson: string) => {
      const input = JSON.parse(inputJson);
      expect(input).toMatchObject({
        pair_id: "STRK/USDC",
        batch_id: "batch-strk-usdc-12",
        epoch_id: "12",
        price_lower_bound: "95",
        price_upper_bound: "130",
        max_fill_base_per_batch: "500",
      });
      expect(input.prior_position.position_id).toBe("0x701");
      return JSON.stringify({
        kind: "reconfigure",
        position_id: "0x701",
        prior_position: storedPosition,
        prior_position_commitment: "0x7010",
        output_position: {
          ...storedPosition,
          price_lower_bound: "95",
          price_upper_bound: "130",
          max_fill_base_per_batch: "500",
          expiry_epoch: "30",
        },
        output_position_commitment: "0x7020",
        output_notes: [],
        base_amount: "0",
        quote_amount: "0",
        lifecycle_authorization: {
          signature_r: "0x1",
          signature_s: "0x2",
        },
      });
    });
    const buildReconfigure = vi.fn((inputJson: string) => {
      const input = JSON.parse(inputJson);
      expect(input).toMatchObject({
        prior_liquidity_position_root: "0xabc",
        state_update: {
          position_id: "0x701",
          prior_commitment: "0x7010",
          output_commitment: "0x7020",
        },
      });
      return JSON.stringify({
        lifecycle_id: lifecycleId,
        position_id: "0x701",
        prior_position_commitment: "0x7010",
        output_position: {
          ...storedPosition,
          price_lower_bound: "95",
          price_upper_bound: "130",
          max_fill_base_per_batch: "500",
          expiry_epoch: "30",
        },
        output_position_commitment: "0x7020",
        transition_commitment: "0x7030",
        output_notes: [],
        ingress_request: {
          pair_id: "STRK/USDC",
          batch_id: "batch-strk-usdc-12",
          epoch_id: 12,
          transition_witness: { kind: "reconfigure" },
          ingress_telemetry: { version: 1 },
        },
      });
    });
    const core = {
      ...(mockWalletCore() as Record<string, unknown>),
      zylith_wallet_prepare_private_liquidity_position_reconfigure:
        prepareReconfigure,
      zylith_wallet_build_private_liquidity_position_reconfigure:
        buildReconfigure,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/deployment.json") return jsonResponse(testDeploymentManifest());
      if (url === "https://rpc.test") {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: ["0xabc"] });
      }
      if (url.endsWith("/health")) return jsonResponse({ batch_window_ms: 20_000 });
      if (url.endsWith("/api/private/liquidity-positions/state")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body).toMatchObject({
          position_id: "0x701",
          owner_authority: "0xabc123",
          prior_liquidity_position_root: "0xabc",
        });
        return jsonResponse({
          prior_liquidity_position_root: "0xabc",
          position: storedPosition,
          position_commitment: "0x7010",
          active_position_count: 1,
        });
      }
      if (url.endsWith("/api/private/liquidity-positions/state-update-witness")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body).toMatchObject({
          kind: "reconfigure",
          position_id: "0x701",
          prior_commitment: "0x7010",
          output_commitment: "0x7020",
          prior_liquidity_position_root: "0xabc",
        });
        return jsonResponse({
          prior_liquidity_position_root: "0xabc",
          new_liquidity_position_root: "0xdef",
          active_position_count: 1,
          state_update: {
            position_id: "0x701",
            prior_commitment: "0x7010",
            output_commitment: "0x7020",
            sparse_witness: {
              key_low: "0x1",
              key_high: "0x0",
              merkle_path: ["0x0"],
              merkle_directions: ["0x1"],
            },
          },
        });
      }
      if (url.endsWith("/api/private/liquidity-positions/lifecycle")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.ingress_telemetry.version).toBe(1);
        return jsonResponse({
          receipt: { lifecycle_id: lifecycleId },
          coordinator_submission: {
            lifecycle_id: lifecycleId,
            transition_commitment: "0x7030",
          },
        });
      }
      if (url.endsWith("/api/liquidity-positions/lifecycle")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.lifecycle_id).toBe(lifecycleId);
        return jsonResponse({
          lifecycle_id: lifecycleId,
          transition_commitment: "0x7030",
          batch_id: "batch-strk-usdc-12",
          accepted_at_unix_ms: Date.now(),
        });
      }
      if (url.includes("/api/recovery/")) {
        if ((init?.method ?? "GET").toUpperCase() === "GET") {
          return jsonResponse({ artifacts: [] });
        }
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/wallet-vaults/")) return jsonResponse({ ok: true });
      return jsonResponse({}, 404);
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
      account: {
        address: "0xabc",
        signMessage,
      },
    });
    const runtime = createZylithWalletRuntime(core as never);

    await runtime.createWalletWithWalletSignature("0xabc");
    const result = await runtime.reconfigurePrivateLiquidityPosition(
      {
        kind: "ReconfigurePrivateLiquidityPosition",
        positionId: "0x701",
        priceLowerBoundAtomic: "95",
        priceUpperBoundAtomic: "130",
        maxFillBasePerBatchAtomic: "500",
        curvePolicy: {
          kind: "StaticRange",
          bandCount: 3,
          spreadBps: 30,
          targetBaseRatioBps: 5000,
          inventorySkewBps: 0,
          maxPriceDeviationBps: 0,
        },
        rotationPolicy: {
          maxPriceRotationBps: 10,
          maxDepthRotationBps: 10,
          skipEpochBps: 0,
        },
        expiryEpoch: "30",
      },
      {
        batch_id: "batch-strk-usdc-12",
        pair_id: "STRK/USDC",
        epoch_id: 12,
        close_time_unix_ms: Date.now() + 60_000,
        status: "Open",
        order_count_bucket: "0",
      }
    );

    expect(result).toMatchObject({
      lifecycle_id: lifecycleId,
      position_id: "0x701",
      prior_position_commitment: "0x7010",
      output_position_commitment: "0x7020",
      transition_commitment: "0x7030",
      batch_id: "batch-strk-usdc-12",
      epoch_id: 12,
    });
    expect(prepareReconfigure).toHaveBeenCalledTimes(1);
    expect(buildReconfigure).toHaveBeenCalledTimes(1);
    expect(runtime.getPrivateLiquidityPositions()[0]).toMatchObject({
      id: "0x701",
      position_commitment: "0x7020",
      status: "pending_reconfigure",
    });
  });

  it("promotes pending private liquidity positions from settlement lifecycle reports", async () => {
    const seedHex = "11".repeat(32);
    const deploymentScope = "0x534e5f5345504f4c4941:0x101:0x102:0x102";
    const positionsKey = `zylith.wallet.liquidity-positions.v1:acct-test:${deploymentScope}`;
    const storedPosition = {
      position_id: "0x701",
      pair_id: "STRK/USDC",
      base_asset_id: "STRK",
      quote_asset_id: "USDC",
      owner_authority: "0xabc123",
      expiry_epoch: "27",
    };
    localStorage.setItem(
      positionsKey,
      JSON.stringify(
        await encryptLocalStore(
          [
            {
              id: "0x701",
              position: storedPosition,
              position_commitment: "0x7020",
              pair_id: "STRK/USDC",
              status: "pending_reconfigure",
              deployment_scope: deploymentScope,
              last_lifecycle_id: "lp-life-1",
              last_transition_commitment: "0x7030",
              last_batch_id: "batch-strk-usdc-12",
              last_epoch_id: 12,
            },
          ],
          seedHex,
          "acct-test",
          "liquidity-positions"
        )
      )
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/deployment.json") return jsonResponse(testDeploymentManifest());
      if (url === "https://rpc.test") {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: ["0xoutputroot"] });
      }
      if (url.endsWith("/api/settlement-reports/batch-strk-usdc-12")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body).toMatchObject({
          output_recovery_key_tags: [],
          order_report_auths: [],
          liquidity_position_transition_commitments: ["0x7030"],
        });
        return jsonResponse({
          batch_id: "batch-strk-usdc-12",
          pair_id: "STRK/USDC",
          batch_epoch: 12,
          settled_at_unix_ms: 1_778_661_520_000,
          output_note_root: "0xoutputroot",
          clearing_price: "100",
          price_base_scale: "1",
          matched_order_count_bucket: "0-7",
          output_recovery_records: [],
          order_execution_reports: [],
          liquidity_position_lifecycle_reports: [
            {
              transition_commitment: "0x7030",
              kind: "Reconfigure",
              consumed_position_commitment: "0x7010",
              output_position_commitment: "0x7020",
            },
          ],
        });
      }
      if (url.includes("/api/recovery/")) {
        if ((init?.method ?? "GET").toUpperCase() === "GET") {
          return jsonResponse({ artifacts: [] });
        }
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/wallet-vaults/")) return jsonResponse({ ok: true });
      return jsonResponse({}, 404);
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    await selectRuntimeProvider({
      account: {
        address: "0xabc",
        signMessage: vi.fn(async () => ["0x1", "0x2"]),
      },
    });
    const runtime = createZylithWalletRuntime({
      ...(mockWalletCore() as Record<string, unknown>),
      zylith_wallet_output_recovery_key_tags_range: () =>
        JSON.stringify({ key_tags: [] }),
    } as never);

    await runtime.createWalletWithWalletSignature("0xabc");
    await expect(
      runtime.syncPrivateSettlementReports([
        {
          batch_id: "batch-strk-usdc-12",
          orders: [],
          liquidity_position_transition_commitments: ["0x7030"],
        },
      ])
    ).resolves.toHaveLength(1);

    expect(runtime.getPrivateLiquidityPositions()[0]).toMatchObject({
      id: "0x701",
      position_commitment: "0x7020",
      status: "active",
      updated_at_unix_ms: 1_778_661_520_000,
    });
  });

  it("switches wallet networks before wallet-signature private session setup", async () => {
    let walletChainId = "SN_MAIN";
    const request = vi.fn(async (payload: { type?: string; params?: { chainId?: string } }) => {
      if (payload.type === "wallet_requestAccounts") return [{ address: "0xabc" }];
      if (payload.type === "wallet_requestChainId") return walletChainId;
      if (payload.type === "wallet_switchStarknetChain") {
        walletChainId = payload.params?.chainId ?? walletChainId;
        return null;
      }
      if (payload.type === "wallet_signTypedData") return ["0x1", "0x2"];
      return null;
    });
    await selectRuntimeProvider({
      account: { address: "0xabc" },
      request,
    });
    request.mockClear();
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith({
      type: "wallet_switchStarknetChain",
      params: { chainId: "0x534e5f5345504f4c4941" },
    });
    expect(request).toHaveBeenCalledWith({
      type: "wallet_signTypedData",
      params: expect.objectContaining({
        primaryType: "ZylithSession",
      }),
    });
  });

  it("continues after an accepted wallet switch when the wallet still omits chain ID", async () => {
    const request = vi.fn(
      async (payload: { type?: string; method?: string; params?: { chainId?: string } }) => {
        if (payload.type === "wallet_requestAccounts") return [{ address: "0xabc" }];
        if (payload.type === "wallet_requestChainId") return null;
        if (payload.method === "wallet_requestChainId") return null;
        if (payload.type === "wallet_switchStarknetChain") return null;
        if (payload.type === "wallet_signTypedData") return ["0x1", "0x2"];
        return null;
      }
    );
    await selectRuntimeProvider({
      chainId: "",
      account: { address: "0xabc" },
      request,
    });
    request.mockClear();
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith({ type: "wallet_requestChainId" });
    expect(request).toHaveBeenCalledWith({
      type: "wallet_switchStarknetChain",
      params: { chainId: "0x534e5f5345504f4c4941" },
    });
    expect(request).toHaveBeenCalledWith({
      type: "wallet_signTypedData",
      params: expect.objectContaining({
        primaryType: "ZylithSession",
      }),
    });
  });

  it("binds wallet session authorization to wallet, chain, origin, and deployment", async () => {
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);

    expect(signMessage).toHaveBeenCalledTimes(1);
    const typedData = (signMessage.mock.calls[0] as unknown[])[0] as {
      primaryType?: string;
      domain?: { chainId?: string };
      message?: {
        action?: string;
        wallet?: string;
        origin?: string;
        deployment?: string;
        version?: string;
      };
    };
    expect(typedData.primaryType).toBe("ZylithSession");
    expect(typedData.domain).toMatchObject({
      chainId: "0x534e5f5345504f4c4941",
    });
    expect(typedData.message).toMatchObject({
      wallet: "0xabc",
      version: "2",
    });
    expect(typedData.message?.action).not.toBe("");
    expect(typedData.message?.origin).toMatch(/^0x[0-9a-f]+$/);
    expect(typedData.message?.deployment).toMatch(/^0x[0-9a-f]+$/);
  });

  it("deletes corrupt encrypted private stores without retaining copies", async () => {
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const scope =
      "acct-test:0x534e5f5345504f4c4941:0x101:0x102:0x102";
    const corruptNotesKey = `zylith.wallet.notes.v1:${scope}`;
    localStorage.setItem(
      corruptNotesKey,
      JSON.stringify({
        version: 1,
        algorithm: "AES-GCM",
        nonce: "not-valid-base64",
        ciphertext: "not-valid-base64",
      }),
    );
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);

    expect(localStorage.getItem(corruptNotesKey)).toBeNull();
    expect(
      vi.mocked(localStorage.setItem).mock.calls.some(([key]) =>
        key.startsWith(`${corruptNotesKey}.corrupt.`)
      ),
    ).toBe(false);
  });

  it("deduplicates concurrent wallet-signature unlock requests", async () => {
    let resolveUnlockSignature:
      | ((signature: string[]) => void)
      | undefined;
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await runtime.createWalletWithWalletSignature("0xabc");
    signMessage.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          resolveUnlockSignature = resolve;
        })
    );
    signMessage.mockClear();
    runtime.lock();

    const first = runtime.unlockWithWalletSignature("0xabc");
    const second = runtime.unlockWithWalletSignature("0xabc");
    for (let attempt = 0; attempt < 20 && signMessage.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(signMessage).toHaveBeenCalledTimes(1);
    resolveUnlockSignature?.(["0x1", "0x2"]);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  it("does not create a private session from a wallet signature that resolves after lock", async () => {
    let resolveSignature: ((signature: string[]) => void) | undefined;
    const signMessage = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveSignature = resolve;
        })
    );
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const runtime = createZylithWalletRuntime(mockWalletCore());

    const attempt = runtime.createWalletWithWalletSignature("0xabc");
    for (let i = 0; i < 20 && signMessage.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(signMessage).toHaveBeenCalledTimes(1);
    runtime.lock();
    resolveSignature?.(["0x1", "0x2"]);

    await expect(attempt).rejects.toThrow("Wallet session changed. Retry.");
    expect(runtime.isReady()).toBe(false);
    expect(localStorage.getItem("zylith.wallet.vault.v4:0xabc")).toBeNull();
  });

  it("does not unlock a private session from a wallet signature that resolves after lock", async () => {
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const runtime = createZylithWalletRuntime(mockWalletCore());
    await runtime.createWalletWithWalletSignature("0xabc");
    runtime.lock();

    let resolveUnlockSignature:
      | ((signature: string[]) => void)
      | undefined;
    signMessage.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          resolveUnlockSignature = resolve;
        })
    );
    signMessage.mockClear();

    const attempt = runtime.unlockWithWalletSignature("0xabc");
    for (let i = 0; i < 20 && signMessage.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(signMessage).toHaveBeenCalledTimes(1);
    runtime.lock();
    resolveUnlockSignature?.(["0x1", "0x2"]);

    await expect(attempt).rejects.toThrow("Wallet session changed. Retry.");
    expect(runtime.isReady()).toBe(false);
  });

  it("does not create a wallet-signature vault when coordinator vault lookup is offline", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/deployment.json") {
          return {
            ok: true,
            json: async () => testDeploymentManifest(),
          };
        }
        throw new TypeError("Failed to fetch");
      }),
    });
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).rejects.toThrow(
      "Private trading state is unavailable. Retry later."
    );

    expect(runtime.vaultAuthMode("0xabc")).toBe("none");
    expect(localStorage.getItem("zylith.wallet.vault.v4:0xabc")).toBeNull();
  });

  it("keeps wallet-signature vaults scoped to the connected Starknet account", async () => {
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    const provider = {
      account: {
        address: "0xabc",
        signMessage,
      },
    };
    await selectRuntimeProvider(provider);
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(runtime.hasVault("0xabc")).toBe(true);
    expect(runtime.hasVault("0xdef")).toBe(false);

    runtime.lock();
    provider.account.address = "0xdef";
    await expect(runtime.createWalletWithWalletSignature("0xdef")).resolves.toBe(true);

    expect(runtime.hasVault("0xabc")).toBe(true);
    expect(runtime.hasVault("0xdef")).toBe(true);
    expect(localStorage.getItem("zylith.wallet.vault.v4:0xabc")).toBeTruthy();
    expect(localStorage.getItem("zylith.wallet.vault.v4:0xdef")).toBeTruthy();
    expect(localStorage.getItem("zylith.wallet.vault.v4")).toBeNull();
  });

  it("fails wallet-signature setup promptly when deployment manifest loading stalls", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(() => new Promise(() => undefined)),
    });
    const signMessage = vi.fn(async () => ["0x1", "0x2"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
      });
    const runtime = createZylithWalletRuntime(mockWalletCore());

    const attempt = expect(runtime.createWalletWithWalletSignature("0xabc"))
      .rejects
      .toThrow("Deployment manifest is unavailable. Check your connection and retry.");
    await vi.advanceTimersByTimeAsync(10_001);

    await attempt;
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("uses one wallet_signTypedData request when account.signMessage is unavailable", async () => {
    const request = vi.fn(async (payload: { type?: string }) =>
      payload.type === "wallet_signTypedData" ? ["0x1", "0x2"] : null
    );
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
        },
        request,
      });
    request.mockClear();
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(
      true
    );

    const signRequests = request.mock.calls.filter(
      ([payload]) => payload.type === "wallet_signTypedData"
    );
    expect(signRequests).toHaveLength(1);
    expect(request).toHaveBeenCalledWith({
      type: "wallet_signTypedData",
      params: expect.objectContaining({
        primaryType: "ZylithSession",
      }),
    });
  });

  it("preserves wallet_signTypedData provider request context", async () => {
    const provider = {
      account: {
        address: "0xabc",
      },
      request: vi.fn(async function (
        this: { account?: { address?: string } },
        payload: { type?: string }
      ) {
        if (this?.account?.address !== "0xabc") {
          throw new Error("missing wallet provider context");
        }
        return payload.type === "wallet_signTypedData" ? ["0x1", "0x2"] : null;
      }),
    };
    await selectRuntimeProvider(provider);
    provider.request.mockClear();
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(
      true
    );

    expect(provider.request).toHaveBeenCalledWith({
      type: "wallet_signTypedData",
      params: expect.objectContaining({
        primaryType: "ZylithSession",
      }),
    });
  });

  it("prefers wallet_signTypedData over injected account signMessage", async () => {
    const request = vi.fn(async (payload: { type?: string }) =>
      payload.type === "wallet_signTypedData" ? ["0x1", "0x2"] : null
    );
    const signMessage = vi.fn(async () => ["0x3", "0x4"]);
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
          signMessage,
        },
        request,
      });
    request.mockClear();
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(
      true
    );

    expect(request).toHaveBeenCalledWith({
      type: "wallet_signTypedData",
      params: expect.objectContaining({
        primaryType: "ZylithSession",
      }),
    });
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("tries method-style typed-data signing before failing unsupported wallets", async () => {
    const request = vi.fn(async (_payload: { type?: string; method?: string }) => {
      throw new Error("unsupported method");
    });
    await selectRuntimeProvider({
        account: {
          address: "0xabc",
        },
        request,
      });
    request.mockClear();
    const runtime = createZylithWalletRuntime(mockWalletCore());

    await expect(runtime.createWalletWithWalletSignature("0xabc")).rejects.toThrow(
      "Selected Starknet wallet cannot sign Zylith messages"
    );
    expect(
      request.mock.calls.filter(([payload]) => payload.type === "wallet_signTypedData")
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(([payload]) => payload.method === "wallet_signTypedData")
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(([payload]) => payload.method === "starknet_signTypedData")
    ).toHaveLength(1);
  });
});

describe("STRK20 withdrawal deployment availability", () => {
  const deployment = testDeploymentManifest();

  it("enables withdrawals automatically from a complete private withdrawal deployment", () => {
    expect(strk20WithdrawalEnabledForDeployment(deployment)).toBe(true);
  });

  it("keeps withdrawals disabled when the STRK privacy rail is incomplete", () => {
    expect(strk20WithdrawalEnabledForDeployment({
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
    expect(strk20WithdrawalEnabledForDeployment({
      ...deployment,
      contracts: {
        ...deployment.contracts,
        shielded_asset_adapter: "0x107",
      },
    })).toBe(false);
  });

  it("enables note consolidation automatically from proof deployment config", () => {
    expect(noteConsolidationEnabledForDeployment(deployment)).toBe(true);
  });

  it("keeps note consolidation disabled without the native statement program", () => {
    expect(noteConsolidationEnabledForDeployment({
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

  it("starts hosted Zylith Relay packages far enough ahead for relay registration", () => {
    const now = 1_000_000;

    expect(hostedRelayLeadEpochs()).toBe(6);
    expect(
      firstRenewalSlotEpoch(
        { epoch_id: 42, close_time_unix_ms: now + 600_000 },
        "ZylithRelay",
        now,
        20_000
      )
    ).toBe(48);
    expect(
      firstRenewalSlotEpoch(
        { epoch_id: 42, close_time_unix_ms: now + 600_000 },
        "ZylithRelay",
        now,
        90_000
      )
    ).toBe(44);
  });

  it("submits hosted relay packages as soon as their batch opens", () => {
    expect(renewalPackageMaxSubmissionDelayMs("SelfRelay")).toBe(0);
    expect(renewalPackageMaxSubmissionDelayMs("ZylithRelay")).toBe(0);
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

describe("private order submission ambiguity", () => {
  it("keeps private-order locks ambiguous after transient private ingress failures", () => {
    expect(
      isAmbiguousPrivateOrderSubmissionError(
        new Error("Network request failed. Check your connection and retry."),
        "private_ingress"
      )
    ).toBe(true);
    expect(
      isAmbiguousPrivateOrderSubmissionError(
        new RuntimeHttpStatusError("/api/private/orders", 503, "unavailable"),
        "private_ingress"
      )
    ).toBe(true);
  });

  it("treats explicit private ingress validation rejections as definite failures", () => {
    expect(
      isAmbiguousPrivateOrderSubmissionError(
        new RuntimeHttpStatusError("/api/private/orders", 400, "bad order"),
        "private_ingress"
      )
    ).toBe(false);
    expect(
      isAmbiguousPrivateOrderSubmissionError(
        new RuntimeHttpStatusError("/api/private/orders", 409, "conflict"),
        "private_ingress"
      )
    ).toBe(false);
  });

  it("keeps coordinator submission network failures ambiguous after ingress succeeds", () => {
    expect(
      isAmbiguousPrivateOrderSubmissionError(
        new Error("Request to /api/orders timed out after 15000ms"),
        "coordinator_submission"
      )
    ).toBe(true);
    expect(
      isAmbiguousPrivateOrderSubmissionError(
        new RuntimeHttpStatusError("/api/orders", 400, "batch closed"),
        "coordinator_submission"
      )
    ).toBe(false);
  });
});

describe("note consolidation submit ambiguity", () => {
  it("treats submit 4xx as definite so local note locks can be released", () => {
    expect(
      isDefiniteNoteConsolidationSubmitRejection(
        new RuntimeHttpStatusError(
          "/api/private/note-consolidations/submit",
          400,
          "bad witness"
        )
      )
    ).toBe(true);
  });

  it("does not treat submit 5xx as definite because the transaction may have been broadcast", () => {
    expect(
      isDefiniteNoteConsolidationSubmitRejection(
        new RuntimeHttpStatusError(
          "/api/private/note-consolidations/submit",
          502,
          "gateway"
        )
      )
    ).toBe(false);
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
      batch_id: "0x103",
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

describe("local note recovery merge", () => {
  it("does not reattach pending withdrawal state to already spent notes", () => {
    const existing = {
      ...strk20ExitNote(),
      spent: true,
      locked_by_order: undefined,
      pending_withdrawal_tx: undefined,
      pending_strk20_open_note_tx: undefined,
      strk20_open_note_id: undefined,
      withdrawal_requested_at_unix_ms: undefined,
    };
    const incoming = strk20ExitNote();

    const changed = mergeLocalNoteRecord(existing, incoming);

    expect(changed).toBe(false);
    expect(existing.spent).toBe(true);
    expect(existing.pending_withdrawal_tx).toBeUndefined();
    expect(existing.pending_strk20_open_note_tx).toBeUndefined();
    expect(existing.strk20_open_note_id).toBeUndefined();
  });

  it("recovers pending STRK20 open-note claim metadata for unspent notes", () => {
    const existing = {
      ...strk20ExitNote(),
      locked_by_order: "withdrawal:0xexit",
      pending_withdrawal_tx: "0xstaged",
      pending_strk20_open_note_tx: undefined,
      strk20_open_note_id: undefined,
      withdrawal_requested_at_unix_ms: 1_600_000_000_000,
    };
    const incoming = strk20ExitNote();

    const changed = mergeLocalNoteRecord(existing, incoming);

    expect(changed).toBe(true);
    expect(existing.pending_strk20_open_note_tx).toBe("0xclaim");
    expect(existing.strk20_open_note_id).toBe("0xopen");
    expect(existing.withdrawal_requested_at_unix_ms).toBe(1_700_000_000_000);
  });

  it("clears failed deposit state when recovery proves confirmation", () => {
    const existing = {
      ...sourceNote(pendingConsolidation()),
      locked_by_order: undefined,
      deposit_confirmed: false,
      deposit_failed: true,
      deposit_failure_reason: "Deposit transaction was not submitted.",
    };
    const incoming = {
      ...existing,
      deposit_confirmed: true,
      deposit_failed: undefined,
      deposit_failure_reason: undefined,
    };

    const changed = mergeLocalNoteRecord(existing, incoming);

    expect(changed).toBe(true);
    expect(existing.deposit_confirmed).toBe(true);
    expect(existing.deposit_failed).toBeUndefined();
    expect(existing.deposit_failure_reason).toBeUndefined();
  });

  it("does not let stale recovery failure overwrite a confirmed deposit", () => {
    const existing = {
      ...sourceNote(pendingConsolidation()),
      locked_by_order: undefined,
      deposit_confirmed: true,
      deposit_failed: undefined,
      deposit_failure_reason: undefined,
    };
    const incoming = {
      ...existing,
      deposit_confirmed: false,
      deposit_failed: true,
      deposit_failure_reason: "Deposit transaction was not submitted.",
    };

    const changed = mergeLocalNoteRecord(existing, incoming);

    expect(changed).toBe(false);
    expect(existing.deposit_confirmed).toBe(true);
    expect(existing.deposit_failed).toBeUndefined();
    expect(existing.deposit_failure_reason).toBeUndefined();
  });

  it("clears pending local state when recovery proves a note is spent", () => {
    const existing = {
      ...strk20ExitNote(),
      spent: false,
      pending_consolidation: pendingConsolidation(),
    };
    const incoming = {
      ...existing,
      spent: true,
      pending_consolidation: undefined,
      pending_withdrawal_tx: undefined,
      pending_strk20_open_note_tx: undefined,
      withdrawal_requested_at_unix_ms: undefined,
    };

    const changed = mergeLocalNoteRecord(existing, incoming);

    expect(changed).toBe(true);
    expect(existing.spent).toBe(true);
    expect(existing.locked_by_order).toBeUndefined();
    expect(existing.pending_consolidation).toBeUndefined();
    expect(existing.pending_withdrawal_tx).toBeUndefined();
    expect(existing.pending_strk20_open_note_tx).toBeUndefined();
    expect(existing.withdrawal_requested_at_unix_ms).toBeUndefined();
    expect(existing.strk20_open_note_id).toBe("0xopen");
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

  it("rejects calldata activation matches when bridge or tuple fields differ", () => {
    const calldata = new Set(["0xabc", "0x1", "0x2", "0x3"]);

    expect(transactionCalldataContainsDepositActivation(calldata, {
      bridgeAddress: null,
      fundingCommitment: "0x1",
      depositRoot: "0x2",
      activation: "0x3",
    })).toBe(false);
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
    consolidation_id: "0x103",
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
    zylith_wallet_generate_seed_hex: () => seedHex,
    zylith_wallet_derive_public_config: () =>
      JSON.stringify({
        account_id: "acct-test",
        spend_authority: "0xspend",
        note_recognition_public_key: "0xowner",
        withdraw_authority: "0xwithdraw",
      }),
    zylith_wallet_authorize_liquidity_position_open: () =>
      JSON.stringify({ signature_r: "0xopenr", signature_s: "0xopens" }),
    zylith_wallet_authorize_liquidity_position_reconfigure: () =>
      JSON.stringify({ signature_r: "0xreconfigurer", signature_s: "0xreconfigures" }),
    zylith_wallet_authorize_liquidity_position_close: () =>
      JSON.stringify({ signature_r: "0xcloser", signature_s: "0xcloses" }),
  } as never;
}
