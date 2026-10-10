import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcProvider, constants } from "starknet";
import {
  privacyBridgeDepositFlatCalldata,
  privacyBridgeDepositCalldata,
  privacyBridgeStrk20ExitClaimCalldata,
  privacyBridgeStrk20ExitClaimFlatCalldata,
  privacyBridgeStrk20ExitAuthorizationCall,
  sanitizeFundingRelayErrorBody,
  shouldRetryDirectProvingTransport,
  runProvingTransportAttempts,
  starknetPrivacySdkChainId,
  submitResidualRecovery,
  STARKNET_PRIVACY_OHTTP_EXECUTE_TIMEOUT_MS,
  type PrivacyBridgeDepositPlan,
  type SubmitResidualRecoveryInput,
} from "./starknetPrivacyFunding";

vi.mock("@starkware-libs/starknet-privacy-sdk/browser", () => ({
  ProvingServiceProofProvider: class {
    async getDefaultDetails() {
      return {
        chainId: constants.StarknetChainId.SN_SEPOLIA,
        version: "0x3", nonce: "0x0", tip: "0x0",
        nonceDataAvailabilityMode: "L1", feeDataAvailabilityMode: "L1",
        paymasterData: [], accountDeploymentData: [],
        resourceBounds: {
          l1_gas: { max_amount: 1n, max_price_per_unit: 1n },
          l2_gas: { max_amount: 1n, max_price_per_unit: 1n },
          l1_data_gas: { max_amount: 1n, max_price_per_unit: 1n },
        },
      };
    }
    async prove() {
      return { data: "test-proof", proofFacts: ["0xfac"] };
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("proof signer v2 supplied material", () => {
  const vectors = [
    {
      proofSignerPrivateKey: "0x61e92aa2f68fab50076a57d60f9a65fd953242fd5b5a4ce0c05f3b8a1d4b6db",
      proofSignerSalt: "0x788689130ce49a08cf4ad92ac95537b9629dc5dea84c26a3d56301466a943f3",
      publicKey: "0x50556cf7cf2be020b0c9f17d54d6ab6107bf7d60c7d9df3e1794c43b979ca5c",
      address: "0x434d027452fcf52ccbea3866f0bc3556d24d2d3f56aad18c1c55c9b82fb3dd0",
    },
    {
      proofSignerPrivateKey: "0x7a22e19566683233efedfa4d595a6faf3ca1f62a5e74a3ee9fe631714fce6d8",
      proofSignerSalt: "0x749be86411fe1f66ae6e9e4cbcf00a326d242efe8930673d199e5b2a358d3d8",
      publicKey: "0x4eede9925b9650a768688df18e8614f4807843188093a3999a51679684d5068",
      address: "0x2aa256ef7b02f3d6b90e3a90bc30b22bb527801c1bd9e8474fb8f367d6f103a",
    },
  ];

  it.each(vectors)("uses the supplied scalar and salt for account $address without a seed or browser digest", async (vector) => {
    const addresses: string[] = [];
    vi.spyOn(RpcProvider.prototype, "getClassHashAt").mockImplementation(async (address) => {
      addresses.push(String(address));
      return "0x123";
    });
    vi.spyOn(RpcProvider.prototype, "getBlockNumber").mockResolvedValue(100);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async () => {
      throw new Error("the funding integration must not hash recovery seed material");
    });
    let relayBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      relayBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ transaction_hash: "0x999" }));
    });
    const input: SubmitResidualRecoveryInput = {
      proofSignerPrivateKey: vector.proofSignerPrivateKey,
      proofSignerSalt: vector.proofSignerSalt,
      chainId: "0x534e5f5345504f4c4941", rpcUrl: "https://rpc.example.invalid",
      provingUrl: "https://prover.example.invalid", provingOhttpPolicy: "disabled",
      paymasterAddress: "0x456", paymasterUrl: "https://relay.example.invalid",
      privacyProofSignerClassHash: "0x123", minProvingDelayBlocks: 0,
      proofProgramCall: { contractAddress: "0x789", entrypoint: "compile_residual_recovery_proof", calldata: ["0x1"] },
      settlementCall: { contractAddress: "0xabc", entrypoint: "request_residual_recovery", calldata: ["0x2"] },
    };
    const inputHasNoRecoverySeed: "seedHex" extends keyof SubmitResidualRecoveryInput ? false : true = true;
    expect(inputHasNoRecoverySeed).toBe(true);
    await expect(submitResidualRecovery(input)).resolves.toEqual({ transactionHash: "0x999" });
    expect(addresses).toEqual([vector.address]);
    expect(relayBody).toMatchObject({ signer_address: vector.address, call: { entrypoint: "request_residual_recovery", calldata: ["0x2"] } });
    expect(JSON.stringify(relayBody)).not.toContain(vector.proofSignerPrivateKey);
    expect(JSON.stringify(relayBody)).not.toContain("seedHex");
  });

  it("deploys with the supplied v2 salt and the real Stark signer public key", async () => {
    const vector = vectors[1];
    const lookup = vi.spyOn(RpcProvider.prototype, "getClassHashAt");
    lookup.mockRejectedValueOnce(new Error("not deployed")).mockRejectedValueOnce(new Error("not deployed")).mockResolvedValue("0x123");
    vi.spyOn(RpcProvider.prototype, "getBlockNumber").mockResolvedValue(100);
    let approval: unknown;
    const assertWalletContext = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ transaction_hash: "0x999" })));
    await expect(submitResidualRecovery({
      provider: { request: async (request) => { approval = request; return { transaction_hash: "0xaaa" }; } },
      proofSignerPrivateKey: vector.proofSignerPrivateKey, proofSignerSalt: vector.proofSignerSalt,
      chainId: "0x534e5f5345504f4c4941", rpcUrl: "https://rpc.example.invalid",
      provingUrl: "https://prover.example.invalid", provingOhttpPolicy: "disabled",
      paymasterAddress: "0x456", paymasterUrl: "https://relay.example.invalid",
      privacyProofSignerClassHash: "0x123", minProvingDelayBlocks: 0,
      assertWalletContext,
      proofProgramCall: { contractAddress: "0x789", entrypoint: "compile_residual_recovery_proof", calldata: ["0x1"] },
      settlementCall: { contractAddress: "0xabc", entrypoint: "request_residual_recovery", calldata: ["0x2"] },
    })).resolves.toEqual({ transactionHash: "0x999" });
    expect(approval).toEqual({
      type: "wallet_addInvokeTransaction",
      params: { calls: [{ contract_address: constants.UDC.ADDRESS, entry_point: constants.UDC.ENTRYPOINT, calldata: ["0x123", vector.proofSignerSalt, "0x0", "0x1", vector.publicKey] }] },
    });
    expect(assertWalletContext).toHaveBeenCalledTimes(1);
  });
});

describe("shouldRetryDirectProvingTransport", () => {
  it("allows a direct HTTPS retry for OHTTP transport timeouts and aborts", () => {
    expect(
      shouldRetryDirectProvingTransport(
        new Error(
          "Private deposit proof generation timed out before the proof service returned."
        )
      )
    ).toBe(true);
    expect(
      shouldRetryDirectProvingTransport(
        new Error("OHTTP request failed: Signal is aborted without reason")
      )
    ).toBe(true);
  });

  it("does not hide deterministic prover or contract failures", () => {
    expect(
      shouldRetryDirectProvingTransport(
        new Error("Execution reverted: SCREENING_REQUIRED")
      )
    ).toBe(false);
    expect(
      shouldRetryDirectProvingTransport(new Error("proof block number too recent"))
    ).toBe(false);
  });
});

describe("runProvingTransportAttempts", () => {
  it("keeps the OHTTP wrapper deadline long enough for official prover jobs", () => {
    expect(STARKNET_PRIVACY_OHTTP_EXECUTE_TIMEOUT_MS).toBeGreaterThanOrEqual(
      10 * 60_000,
    );
  });

  it("falls back to direct HTTPS when OHTTP proof transport hangs", async () => {
    vi.useFakeTimers();
    const stages: string[] = [];
    const attempts: boolean[] = [];
    const result = runProvingTransportAttempts({
      flow: "deposit",
      provingOhttpPolicy: "best_effort",
      setStage: (stage) => stages.push(stage),
      run: async (useOhttp) => {
        attempts.push(useOhttp);
        if (useOhttp) return new Promise<string>(() => undefined);
        return "direct-ok";
      },
    });

    await vi.advanceTimersByTimeAsync(STARKNET_PRIVACY_OHTTP_EXECUTE_TIMEOUT_MS);

    await expect(result).resolves.toBe("direct-ok");
    expect(attempts).toEqual([true, false]);
    expect(stages).toEqual([
      "Private deposit proof continuing over direct HTTPS because best-effort OHTTP is unavailable",
    ]);
  });

  it("uses direct HTTPS only when OHTTP is disabled", async () => {
    const attempts: boolean[] = [];
    await expect(
      runProvingTransportAttempts({
        flow: "deposit",
        provingOhttpPolicy: "disabled",
        setStage: () => undefined,
        run: async (useOhttp) => {
          attempts.push(useOhttp);
          return "direct-ok";
        },
      })
    ).resolves.toBe("direct-ok");
    expect(attempts).toEqual([false]);
  });

  it("fails closed without direct fallback when OHTTP is required", async () => {
    const attempts: boolean[] = [];
    await expect(
      runProvingTransportAttempts({
        flow: "withdrawal",
        provingOhttpPolicy: "required",
        setStage: () => undefined,
        run: async (useOhttp) => {
          attempts.push(useOhttp);
          throw new Error("OHTTP request failed: network timeout");
        },
      })
    ).rejects.toThrow("network timeout");
    expect(attempts).toEqual([true]);
  });

  it("does not fall back when OHTTP returns a deterministic prover error", async () => {
    await expect(
      runProvingTransportAttempts({
        flow: "withdrawal",
        provingOhttpPolicy: "best_effort",
        setStage: () => undefined,
        run: async () => {
          throw new Error("Execution reverted: SCREENING_REQUIRED");
        },
      })
    ).rejects.toThrow("SCREENING_REQUIRED");
  });
});

describe("starknetPrivacySdkChainId", () => {
  it("canonicalizes supported networks and rejects unknown chains", () => {
    expect(starknetPrivacySdkChainId("0x534e5f5345504f4c4941")).toBe(
      constants.StarknetChainId.SN_SEPOLIA
    );
    expect(starknetPrivacySdkChainId("SN_MAIN")).toBe(
      constants.StarknetChainId.SN_MAIN
    );
    expect(() => starknetPrivacySdkChainId("0x1234")).toThrow(
      "Unsupported Starknet chain ID for private funding"
    );
  });
});

describe("sanitizeFundingRelayErrorBody", () => {
  it("keeps actionable paymaster configuration errors readable", () => {
    expect(
      sanitizeFundingRelayErrorBody(
        JSON.stringify({
          error: "paymaster_address does not match paymaster configuration",
        })
      )
    ).toBe("paymaster_address does not match paymaster configuration");
  });

  it("redacts large relay error fields before they are wrapped", () => {
    const detail = sanitizeFundingRelayErrorBody(
      JSON.stringify({
        error:
          'failed for 0x1234567890abcdef1234567890abcdef1234567890abcdef with "calldata":["0x1234567890abcdef1234567890abcdef1234567890abcdef"] and amount 1234567890123456789012345678901234567890',
      })
    );

    expect(detail).toBe(
      'failed for <felt> with "calldata":[...] and amount <number>'
    );
  });
});

describe("privacyBridgeDepositCalldata", () => {
  it("builds custody-bound activation calldata expected by the bridge", () => {
    const plan: PrivacyBridgeDepositPlan = {
      amount: 300n,
      encodedArgs: {
        funding_commitments: ["0xf00", "0xf01"],
        deposit_roots: ["0xd00", "0xd01"],
        encrypted_note_activations: ["0xe00", "0xe01"],
        note_commitments: ["0xaaa", "0xaab"],
        asset_ids: ["0x55534443", "0x55534443"],
        amounts: ["100", "200"],
        withdraw_authorities: ["0xauth0", "0xauth1"],
      },
    };

    expect(privacyBridgeDepositCalldata(plan)).toEqual([
      ["0xf00", "0xf01"],
      ["0xd00", "0xd01"],
      ["0xe00", "0xe01"],
      ["0xaaa", "0xaab"],
      ["0x55534443", "0x55534443"],
      ["100", "200"],
      ["0xauth0", "0xauth1"],
    ]);
    expect(privacyBridgeDepositFlatCalldata(plan)).toEqual([
      "2", "0xf00", "0xf01",
      "2", "0xd00", "0xd01",
      "2", "0xe00", "0xe01",
      "2", "0xaaa", "0xaab",
      "2", "0x55534443", "0x55534443",
      "2", "100", "200",
      "2", "0xauth0", "0xauth1",
    ]);
  });

  it("serializes custody fields without exposing the deposit nonce", () => {
    const rawNonce = "7";
    const plan: PrivacyBridgeDepositPlan = {
      amount: 300n,
      encodedArgs: {
        funding_commitments: ["0xf00"],
        deposit_roots: ["0xd00"],
        encrypted_note_activations: ["0xe00"],
        note_commitments: ["0xaaa"],
        asset_ids: ["0x55534443"],
        amounts: ["300"],
        withdraw_authorities: ["0xauth"],
      },
    };

    const serialized = JSON.stringify(privacyBridgeDepositCalldata(plan));
    expect(serialized).toContain("0xaaa");
    expect(serialized).toContain("0x55534443");
    expect(serialized).toContain("300");
    expect(serialized).toContain("0xauth");
    expect(serialized).not.toContain(rawNonce);
  });
});

describe("privacyBridgeStrk20ExitClaimCalldata", () => {
  it("builds an exact atomic STRK20 exit authorization and claim", () => {
    const calldata = privacyBridgeStrk20ExitClaimCalldata({
      exitCommitment: "0xexit",
      openNoteId: "0xopen",
    });

    expect(calldata).toEqual([
      [],
      ["0xexit", "0xopen"],
      [],
      [],
      [],
      [],
      [],
    ]);
    expect(privacyBridgeStrk20ExitClaimFlatCalldata({
      exitCommitment: "0xexit",
      openNoteId: "0xopen",
    })).toEqual([
      "0",
      "2", "0xexit", "0xopen",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(privacyBridgeStrk20ExitAuthorizationCall({
      bridgeAddress: "0xbridge",
      exitCommitment: "0xexit",
      openNoteId: "0xopen",
      signature: { signature_r: "0xr", signature_s: "0xs" },
    })).toEqual({
      contractAddress: "0xbridge",
      entrypoint: "authorize_strk20_exit_claim",
      calldata: ["0xexit", "0xopen", "0xr", "0xs"],
    });
  });
});
