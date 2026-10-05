import { afterEach, describe, expect, it, vi } from "vitest";
import { constants } from "starknet";
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
  STARKNET_PRIVACY_OHTTP_EXECUTE_TIMEOUT_MS,
  type PrivacyBridgeDepositPlan,
} from "./starknetPrivacyFunding";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
