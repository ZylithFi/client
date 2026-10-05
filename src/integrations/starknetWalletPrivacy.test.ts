import { describe, expect, it, vi } from "vitest";
import {
  claimZylithExitToWallet,
  fundZylithFromWallet,
  walletPrivateBalance,
  walletPrivateSubmissionMayHaveLanded,
} from "./starknetWalletPrivacy";
import { requirePrivateStrk20Support } from "../domain/starknetWalletCapabilities";

function providerWithResponses(responses: unknown[]) {
  responses.unshift(["0.10.4"]);
  const request = vi.fn(async () => {
    if (responses.length === 0) throw new Error("unexpected wallet request");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  return { provider: { request }, request };
}

describe("starknet wallet privacy", () => {
  it("probes capabilities silently and selects the newest compatible wallet api", async () => {
    const request = vi.fn(async () => ["0.9", "0.10.3", "0.10.4"]);
    await expect(requirePrivateStrk20Support({ request })).resolves.toBe("0.10.4");
    expect(request).toHaveBeenCalledWith({
      type: "wallet_supportedWalletApi",
      params: undefined,
    });
  });

  it("fails before a private action when the wallet lacks strk20 support", async () => {
    const request = vi.fn(async () => ["0.10.2"]);
    await expect(requirePrivateStrk20Support({ request })).rejects.toThrow(/does not support private strk20/i);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reads the requested token's exact private balance", async () => {
    const { provider, request } = providerWithResponses([
      [
        { token: "0x1", balance: "0x2a" },
        { token: "0x2", balance: "0x7" },
      ],
    ]);

    await expect(walletPrivateBalance(provider, "0x1")).resolves.toBe(42n);
    expect(request).toHaveBeenLastCalledWith({
      type: "wallet_strk20Balances",
      params: { tokens: ["0x1"], api_version: "0.10.4" },
    });
  });

  it("treats an unregistered wallet as having no shielded balance before onboarding", async () => {
    const { provider } = providerWithResponses([
      new Error("An error occurred (NOT_REGISTERED)"),
    ]);
    await expect(walletPrivateBalance(provider, "0x1")).resolves.toBe(0n);
  });

  it("uses one private wallet approval when enough balance is already shielded", async () => {
    const { provider, request } = providerWithResponses([
      [{ token: "0x1", balance: "0x64" }],
      { transaction_hash: "0xabc" },
    ]);

    await expect(
      fundZylithFromWallet({
        provider,
        tokenAddress: "0x1",
        amount: 50n,
        bridgeAddress: "0x2",
        bridgeCalldata: ["1", "0x3"],
      }),
    ).resolves.toEqual({ transactionHash: "0xabc", shieldTransactionHash: null });
    expect(request).toHaveBeenNthCalledWith(3, {
      type: "wallet_strk20InvokeTransaction",
      params: {
        api_version: "0.10.4",
        actions: [
          { type: "withdraw", token: "0x1", amount: "0x32", recipient: "0x2" },
          { type: "invoke", contract: "0x2", calldata: ["1", "0x3"] },
        ],
      },
    });
  });

  it("shields only the shortfall before requesting the private Zylith deposit", async () => {
    const stages: string[] = [];
    const { provider, request } = providerWithResponses([
      [{ token: "0x1", balance: "0x14" }],
      { transaction_hash: "0xaaa" },
      [{ token: "0x1", balance: "0x14" }],
      [{ token: "0x1", balance: "0x64" }],
      { transaction_hash: "0xbbb" },
    ]);

    await expect(
      fundZylithFromWallet({
        provider,
        tokenAddress: "0x1",
        amount: 100n,
        amountLabel: "100 USDC",
        bridgeAddress: "0x2",
        bridgeCalldata: ["0x3"],
        onStage: (stage) => stages.push(stage),
        pollDelayMs: 0,
        maxBalancePolls: 2,
      }),
    ).resolves.toEqual({
      transactionHash: "0xbbb",
      shieldTransactionHash: "0xaaa",
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      type: "wallet_strk20InvokeTransaction",
      params: {
        api_version: "0.10.4",
        actions: [{ type: "deposit", token: "0x1", amount: "0x50" }],
      },
    });
    expect(request).toHaveBeenNthCalledWith(6, {
      type: "wallet_strk20InvokeTransaction",
      params: {
        api_version: "0.10.4",
        actions: [
          { type: "withdraw", token: "0x1", amount: "0x64", recipient: "0x2" },
          { type: "invoke", contract: "0x2", calldata: ["0x3"] },
        ],
      },
    });
    expect(stages).toEqual([
      "Preparing private balance",
      "Shielding 100 USDC",
      "Waiting for shielded balance",
      "Funding Zylith",
      "Deposit submitted",
    ]);
  });

  it("claims a finalized exit into an open note owned by the connected wallet", async () => {
    const { provider, request } = providerWithResponses([
      {
        call: {
          contract_address: "0x123",
          entry_point: "apply_actions",
          calldata: [
            "0x2",
            "0x7", "0xa", "0xb", "0xc", "0x1", "0x55",
            "0xa", "0x2", "0xa",
            "0x0", "0x3", "0x44", "0x55", "0x99",
            "0x0", "0x0", "0x0", "0x0", "0x0",
          ],
        },
        proof: { data: "proof", output: ["0x3"], proof_facts: ["0x4"] },
      },
    ]);
    const submitPreparedCall = vi.fn(async () => "0xccc");
    const buildAuthorizationCall = vi.fn((openNoteId: string) => ({
      contractAddress: "0x2",
      entrypoint: "authorize_strk20_exit_claim",
      calldata: ["0x44", openNoteId, "0x99", "0xaa", "0xbb"],
    }));

    await expect(
      claimZylithExitToWallet({
        provider,
        walletAddress: "0x99",
        chainId: "0x534e5f5345504f4c4941",
        paymasterAddress: "0x77",
        paymasterUrl: "https://paymaster.example/execute-outside",
        privacyPoolAddress: "0x123",
        tokenAddress: "0x1",
        bridgeAddress: "0x2",
        bridgeCalldata: [
          "0", "3", "0x44", "${openNoteIds[0]}", "0x99",
          "0", "0", "0", "0", "0",
        ],
        buildAuthorizationCall,
        submitPreparedCall,
      }),
    ).resolves.toEqual({ transactionHash: "0xccc" });
    expect(request).toHaveBeenLastCalledWith({
      type: "wallet_strk20PrepareInvoke",
      params: {
        api_version: "0.10.4",
        actions: [
          { type: "transfer", token: "0x1", amount: "OPEN", recipient: "0x99" },
          {
            type: "invoke",
            contract: "0x2",
            calldata: [
              "0", "3", "0x44", "${openNoteIds[0]}", "0x99",
              "0", "0", "0", "0", "0",
            ],
          },
        ],
        simulate: false,
      },
    });
    expect(buildAuthorizationCall).toHaveBeenCalledWith("0x55");
    expect(submitPreparedCall).toHaveBeenCalledWith(expect.objectContaining({
      signerAddress: "0x99",
      paymasterAddress: "0x77",
      callAndProof: expect.objectContaining({
        call: expect.objectContaining({ contractAddress: "0x123" }),
      }),
      authorizationCall: expect.objectContaining({
        entrypoint: "authorize_strk20_exit_claim",
      }),
    }));
  });

  it("rejects a prepared claim whose private output and bridge claim disagree", async () => {
    const { provider } = providerWithResponses([{
      call: {
        contract_address: "0x123",
        entry_point: "apply_actions",
        calldata: [
          "0x2",
          "0x7", "0xa", "0xb", "0xc", "0x1", "0x55",
          "0xa", "0x2", "0xa",
          "0x0", "0x3", "0x44", "0x56", "0x99",
          "0x0", "0x0", "0x0", "0x0", "0x0",
        ],
      },
      proof: { data: "proof", output: ["0x3"], proof_facts: ["0x4"] },
    }]);
    const buildAuthorizationCall = vi.fn();

    await expect(claimZylithExitToWallet({
      provider,
      walletAddress: "0x99",
      chainId: "0x1",
      paymasterAddress: "0x77",
      paymasterUrl: "https://paymaster.example/execute-outside",
      privacyPoolAddress: "0x123",
      tokenAddress: "0x1",
      bridgeAddress: "0x2",
      bridgeCalldata: [
        "0", "3", "0x44", "${openNoteIds[0]}", "0x99",
        "0", "0", "0", "0", "0",
      ],
      buildAuthorizationCall,
      submitPreparedCall: vi.fn(),
    })).rejects.toThrow(/malformed private claim/i);
    expect(buildAuthorizationCall).not.toHaveBeenCalled();
  });

  it("fails closed on malformed balances and transaction acknowledgements", async () => {
    await expect(
      walletPrivateBalance(providerWithResponses([[{ token: "0x1", balance: "nope" }]]).provider, "0x1"),
    ).rejects.toThrow(/malformed private balance/i);
    await expect(
      fundZylithFromWallet({
        provider: providerWithResponses([[{ token: "0x1", balance: "0x64" }], {}]).provider,
        tokenAddress: "0x1",
        amount: 1n,
        bridgeAddress: "0x2",
        bridgeCalldata: [],
      }),
    ).rejects.toThrow(/transaction hash/i);
    await expect(
      walletPrivateBalance(
        providerWithResponses([[
          {
            token: "0x1",
            balance:
              "0x0800000000000011000000000000000000000000000000000000000000000001",
          },
        ]]).provider,
        "0x1",
      ),
    ).rejects.toThrow(/malformed private balance/i);
  });

  it("distinguishes rejected requests from ambiguous wallet transport failures", () => {
    expect(
      walletPrivateSubmissionMayHaveLanded({
        code: "INVALID_REQUEST_PAYLOAD",
        message: "An error occurred (INVALID_REQUEST_PAYLOAD)",
      }),
    ).toBe(false);
    expect(
      walletPrivateSubmissionMayHaveLanded(
        new Error("The selected wallet does not support private STRK20 actions."),
      ),
    ).toBe(false);
    expect(
      walletPrivateSubmissionMayHaveLanded(
        new Error("The wallet timed out while preparing the private transaction."),
      ),
    ).toBe(true);
  });
});
