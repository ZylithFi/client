import { afterEach, describe, expect, it, vi } from "vitest";
import { constants } from "starknet";
import {
  assertConnectedWalletAccountActivatedForDeposit,
  CONNECTED_WALLET_ETH_FEE_RESERVE_ATOMS,
  connectedWalletFundingShortfall,
  executeWalletCall,
  isDiscoveryHealthyWithFallback,
  privacyBridgeDepositFlatCalldata,
  privacyBridgeDepositCalldata,
  privacyBridgeDepositInvokeCall,
  privacyBridgeStrk20ExitClaimCalldata,
  privacyBridgeStrk20ExitClaimFlatCalldata,
  privacyBridgeStrk20ExitClaimInvokeCall,
  sanitizeFundingRelayErrorBody,
  shouldRetryDirectProvingTransport,
  runProvingTransportAttempts,
  starknetPrivacySdkChainId,
  STARKNET_PRIVACY_OHTTP_EXECUTE_TIMEOUT_MS,
  STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS,
  summarizeSdkPrivacyWarnings,
  type PrivacyBridgeDepositPlan,
} from "./starknetPrivacyFunding";

const STARKNET_ETH_TOKEN_ADDRESS = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("starknet privacy proof delay schedule", () => {
  it("retries with monotonically older proof blocks", () => {
    expect(STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS[0]).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS.length; i += 1) {
      expect(STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS[i]).toBeGreaterThan(
        STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS[i - 1],
      );
    }
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
      provingOhttpEnabled: true,
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
      "Private deposit proof retrying over direct HTTPS transport",
    ]);
  });

  it("does not fall back when OHTTP returns a deterministic prover error", async () => {
    await expect(
      runProvingTransportAttempts({
        flow: "withdrawal",
        provingOhttpEnabled: true,
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

describe("connectedWalletFundingShortfall", () => {
  it("requires ETH fee headroom before opening the wallet transfer", () => {
    const transferAmount = 1_000_000_000_000_000_000n;

    expect(connectedWalletFundingShortfall({
      tokenAddress: STARKNET_ETH_TOKEN_ADDRESS,
      sourceBalance: transferAmount,
      transferAmount,
    })).toBe("ETH deposit amount leaves no room for the wallet transaction fee. Try a slightly smaller amount.");

    expect(connectedWalletFundingShortfall({
      tokenAddress: STARKNET_ETH_TOKEN_ADDRESS,
      sourceBalance: transferAmount + CONNECTED_WALLET_ETH_FEE_RESERVE_ATOMS,
      transferAmount,
    })).toBeNull();
  });

  it("does not reserve ETH fee headroom for non-ETH token transfers", () => {
    const transferAmount = 1_000_000n;

    expect(connectedWalletFundingShortfall({
      tokenAddress: "0x1234",
      sourceBalance: transferAmount,
      transferAmount,
    })).toBeNull();
  });
});

describe("assertConnectedWalletAccountActivatedForDeposit", () => {
  it("rejects counterfactual connected wallet accounts before opening a funding transfer", async () => {
    const rpcProvider = {
      getClassHashAt: vi.fn(async () => {
        throw new Error("contract not deployed");
      }),
    };

    await expect(
      assertConnectedWalletAccountActivatedForDeposit(
        rpcProvider as never,
        "0xabc"
      )
    ).rejects.toThrow("Connected Starknet wallet is not activated yet");
    expect(rpcProvider.getClassHashAt).toHaveBeenCalledWith(
      "0xabc",
      "pre_confirmed"
    );
    expect(rpcProvider.getClassHashAt).toHaveBeenCalledWith("0xabc", "latest");
  });

  it("allows deployed connected wallet accounts to fund the private deposit signer", async () => {
    const rpcProvider = {
      getClassHashAt: vi.fn(async () => "0xclass"),
    };

    await expect(
      assertConnectedWalletAccountActivatedForDeposit(
        rpcProvider as never,
        "0xabc"
      )
    ).resolves.toBeUndefined();
    expect(rpcProvider.getClassHashAt).toHaveBeenCalledWith(
      "0xabc",
      "pre_confirmed"
    );
  });

  it("rejects malformed connected wallet addresses before calling RPC", async () => {
    const rpcProvider = {
      getClassHashAt: vi.fn(async () => "0xclass"),
    };

    await expect(
      assertConnectedWalletAccountActivatedForDeposit(
        rpcProvider as never,
        "not-a-starknet-address"
      )
    ).rejects.toThrow("invalid account address");
    expect(rpcProvider.getClassHashAt).not.toHaveBeenCalled();
  });
});

describe("isDiscoveryHealthyWithFallback", () => {
  it("accepts a direct healthy discovery response when the SDK health probe is transiently false", async () => {
    const provider = {
      isHealthy: vi.fn(async () => false),
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "OK" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      isDiscoveryHealthyWithFallback(
        provider,
        "https://api.example.com/discovery/"
      )
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/discovery/health",
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("rejects the service when both SDK and direct health checks fail", async () => {
    const provider = {
      isHealthy: vi.fn(async () => false),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 }))
    );

    await expect(
      isDiscoveryHealthyWithFallback(provider, "https://api.example.com")
    ).resolves.toBe(false);
  });
});

describe("executeWalletCall", () => {
  it("uses wallet-native invoke requests instead of account execute wrappers", async () => {
    const request = async () => ({ transaction_hash: "0xabc" });
    const execute = async () => {
      throw new Error("account wrapper should not run");
    };

    await expect(
      executeWalletCall(
        {
          request,
          account: { execute },
        } as never,
        {
          contractAddress: "0xtoken",
          entrypoint: "transfer",
          calldata: ["0xrecipient", "1", "0"],
        }
      )
    ).resolves.toEqual({ transaction_hash: "0xabc" });
  });

  it("preserves provider request context for wallet-native invoke requests", async () => {
    const provider = {
      account: { address: "0xabc" },
      request(
        this: { account?: { address?: string } },
        rawRequest: { type?: string },
      ) {
        if (rawRequest.type !== "wallet_addInvokeTransaction")
          return Promise.resolve(null);
        return Promise.resolve({ transaction_hash: this.account?.address });
      },
    };
    const requestSpy = vi.spyOn(provider, "request");

    await expect(
      executeWalletCall(provider as never, {
        contractAddress: "0xtoken",
        entrypoint: "transfer",
        calldata: ["0xrecipient", "1", "0"],
      })
    ).resolves.toEqual({ transaction_hash: "0xabc" });
    expect(requestSpy).toHaveBeenCalledWith({
      type: "wallet_addInvokeTransaction",
      params: {
        calls: [
          {
            contract_address: "0xtoken",
            entry_point: "transfer",
            calldata: ["0xrecipient", "1", "0"],
          },
        ],
      },
    });
  });

  it("rejects wallets without wallet-native invoke requests", async () => {
    const execute = vi.fn(async () => ({ transaction_hash: "0xunexpected" }));

    await expect(
      executeWalletCall(
        {
          account: { execute },
        } as never,
        {
          contractAddress: "0xtoken",
          entrypoint: "transfer",
          calldata: ["0xrecipient", "1", "0"],
        }
      )
    ).rejects.toThrow("Selected Starknet wallet cannot approve private deposits");
    expect(execute).not.toHaveBeenCalled();
  });

  it("times out stalled wallet-native invoke requests", async () => {
    vi.useFakeTimers();
    const request = vi.fn(() => new Promise(() => undefined));

    const attempt = expect(
      executeWalletCall(
        {
          request,
        } as never,
        {
          contractAddress: "0xtoken",
          entrypoint: "transfer",
          calldata: ["0xrecipient", "1", "0"],
        }
      )
    ).rejects.toThrow(
      "Wallet approval timed out before the connected Starknet wallet returned a transaction hash."
    );

    await vi.advanceTimersByTimeAsync(12 * 60_000);
    await attempt;
  });

  it("does not retry real wallet transaction failures through account execute", async () => {
    const request = vi.fn(async () => {
      throw new Error(
        "PaymasterV2Error: Paymaster error 156: An error occurred (TRANSACTION_EXECUTION_ERROR)"
      );
    });
    const execute = vi.fn(async () => ({ transaction_hash: "0xunexpected" }));

    await expect(
      executeWalletCall(
        {
          request,
          account: { execute },
        } as never,
        {
          contractAddress: "0xtoken",
          entrypoint: "transfer",
          calldata: ["0xrecipient", "1", "0"],
        }
      )
    ).rejects.toThrow("TRANSACTION_EXECUTION_ERROR");
    expect(execute).not.toHaveBeenCalled();
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

describe("summarizeSdkPrivacyWarnings", () => {
  it("keeps warning codes but drops SDK warning message details", () => {
    const summary = summarizeSdkPrivacyWarnings([
      {
        code: "USER_LINKAGE",
        message:
          "linked note 0x1234567890abcdef1234567890abcdef1234567890abcdef for account 0xabc",
      },
      {
        code: "USER_LINKAGE",
        message: "duplicate details should not be surfaced",
      },
    ] as never);

    expect(summary).toBe("USER_LINKAGE");
    expect(summary).not.toContain("0x1234567890abcdef");
    expect(summary).not.toContain("linked note");
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
    expect(privacyBridgeDepositInvokeCall({
      bridgeAddress: "0xbridge",
      plan,
    })).toEqual({
      contractAddress: "0xbridge",
      entrypoint: "privacy_invoke",
      calldata: [
        ["0xf00", "0xf01"],
        ["0xd00", "0xd01"],
        ["0xe00", "0xe01"],
        ["0xaaa", "0xaab"],
        ["0x55534443", "0x55534443"],
        ["100", "200"],
        ["0xauth0", "0xauth1"],
      ],
    });
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
  it("builds the staged STRK20 exit claim calldata without a public recipient", () => {
    const calldata = privacyBridgeStrk20ExitClaimCalldata({
      exitCommitment: "0xexit",
      openNoteId: "0xopen",
      signature: {
        signature_r: "0xr",
        signature_s: "0xs",
      },
    });

    expect(calldata).toEqual([
      [],
      ["0xexit", "0xopen", "0xr", "0xs"],
      [],
      [],
      [],
      [],
      [],
    ]);
    expect(privacyBridgeStrk20ExitClaimInvokeCall({
      bridgeAddress: "0xbridge",
      exitCommitment: "0xexit",
      openNoteId: "0xopen",
      signature: {
        signature_r: "0xr",
        signature_s: "0xs",
      },
    })).toEqual({
      contractAddress: "0xbridge",
      entrypoint: "privacy_invoke",
      calldata,
    });
    expect(privacyBridgeStrk20ExitClaimFlatCalldata({
      exitCommitment: "0xexit",
      openNoteId: "0xopen",
      signature: {
        signature_r: "0xr",
        signature_s: "0xs",
      },
    })).toEqual([
      "0",
      "4", "0xexit", "0xopen", "0xr", "0xs",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(JSON.stringify(calldata)).not.toContain("recipient");
  });
});
