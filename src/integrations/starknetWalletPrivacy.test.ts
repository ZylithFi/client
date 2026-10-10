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
  const request = vi.fn(async (_request: { type: string; params: unknown }) => {
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
      params: {
        tokens: ["0x1"],
        api_version: "0.10.4",
      },
    });
  });

  it("sends only standard balance parameters to a 0.10.3 wallet", async () => {
    const responses: unknown[] = [["0.10.3"], [{ token: "0x1", balance: "0x2a" }]];
    const request = vi.fn(async () => responses.shift());

    await expect(walletPrivateBalance({ request }, "0x1")).resolves.toBe(42n);
    expect(request).toHaveBeenLastCalledWith({
      type: "wallet_strk20Balances",
      params: { tokens: ["0x1"], api_version: "0.10.3" },
    });
  });

  it("does not send non-standard consent fields to a 0.10.4 wallet", async () => {
    const { provider, request } = providerWithResponses([
      [{ token: "0x1", balance: "0x2a" }],
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
      [
        { token: "0x1", balance: "0x64" },
        { token: "0xfee", balance: "0xa" },
      ],
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
          { type: "invoke", contract: "0x2", calldata: ["0x1", "0x3"] },
        ],
      },
    });
  });

  it("marks submission only at the state-changing wallet request boundary", async () => {
    let submissionStarted = false;
    const observations: Array<{ type: string; submissionStarted: boolean }> = [];
    const responses: unknown[] = [
      ["0.10.4"],
      [
        { token: "0x1", balance: "0x64" },
        { token: "0xfee", balance: "0xa" },
      ],
      { transaction_hash: "0xabc" },
    ];
    const request = vi.fn(async (request: { type: string; params: unknown }) => {
      observations.push({ type: request.type, submissionStarted });
      return responses.shift();
    });

    await expect(fundZylithFromWallet({
      provider: { request },
      tokenAddress: "0x1",
      amount: 50n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["1", "0x3"],
      onWalletTransactionSubmissionStarted: () => { submissionStarted = true; },
    })).resolves.toEqual({ transactionHash: "0xabc", shieldTransactionHash: null });

    expect(observations).toEqual([
      { type: "wallet_supportedWalletApi", submissionStarted: false },
      { type: "wallet_strk20Balances", submissionStarted: false },
      { type: "wallet_strk20InvokeTransaction", submissionStarted: true },
    ]);
  });

  it("shields only the selected asset before funding in a separate private transaction", async () => {
    const { provider, request } = providerWithResponses([
      [{ token: "0x1", balance: "0x14" }],
      { transaction_hash: "0xaaa" },
      [{ token: "0x1", balance: "0x64" }],
      { transaction_hash: "0xbbb" },
    ]);

    const onWalletTransactionSubmissionStarted = vi.fn();
    const onWalletTransactionResolved = vi.fn();
    await expect(fundZylithFromWallet({
      provider,
      tokenAddress: "0x1",
      amount: 100n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["0x3"],
      transactionStatus: async () => "confirmed",
      pollDelayMs: 0,
      maxBalancePolls: 1,
      onWalletTransactionSubmissionStarted,
      onWalletTransactionResolved,
    })).resolves.toEqual({ transactionHash: "0xbbb", shieldTransactionHash: "0xaaa" });

    expect(onWalletTransactionSubmissionStarted).toHaveBeenCalledTimes(2);
    expect(onWalletTransactionResolved).toHaveBeenCalledTimes(1);

    expect(request).toHaveBeenNthCalledWith(3, {
      type: "wallet_strk20InvokeTransaction",
      params: {
        api_version: "0.10.4",
        actions: [{ type: "deposit", token: "0x1", amount: "0x50" }],
      },
    });
    expect(request).toHaveBeenNthCalledWith(5, {
      type: "wallet_strk20InvokeTransaction",
      params: {
        api_version: "0.10.4",
        actions: [
          { type: "withdraw", token: "0x1", amount: "0x64", recipient: "0x2" },
          { type: "invoke", contract: "0x2", calldata: ["0x3"] },
        ],
      },
    });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "wallet_strk20PrepareInvoke",
    }));
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "wallet_addInvokeTransaction",
    }));
  });

  it("uses the observed wallet fee to reserve the selected asset for funding", async () => {
    const { provider, request } = providerWithResponses([
      [{ token: "0x1", balance: "0x0" }],
      { transaction_hash: "0xaaa" },
      [{ token: "0x1", balance: "0x5a" }],
      { transaction_hash: "0xaab" },
      [{ token: "0x1", balance: "0x6e" }],
      { transaction_hash: "0xbbb" },
    ]);

    await expect(fundZylithFromWallet({
      provider,
      tokenAddress: "0x1",
      amount: 100n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["0x3"],
      transactionStatus: async () => "confirmed",
      pollDelayMs: 0,
      maxBalancePolls: 1,
    })).resolves.toEqual({ transactionHash: "0xbbb", shieldTransactionHash: "0xaaa" });
    expect(request).toHaveBeenNthCalledWith(5, {
      type: "wallet_strk20InvokeTransaction",
      params: {
        api_version: "0.10.4",
        actions: [{ type: "deposit", token: "0x1", amount: "0x1e" }],
      },
    });
  });

  it("stops before funding when the separate shielding transaction fails", async () => {
    const { provider, request } = providerWithResponses([
      [{ token: "0x1", balance: "0x0" }],
      { transaction_hash: "0xaaa" },
    ]);
    const transactionStatus = vi.fn(async () => "failed" as const);

    const onWalletTransactionSubmissionStarted = vi.fn();
    const onWalletTransactionResolved = vi.fn();
    await expect(fundZylithFromWallet({
      provider,
      tokenAddress: "0x1",
      amount: 100n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["0x3"],
      transactionStatus,
      pollDelayMs: 0,
      maxBalancePolls: 10,
      onWalletTransactionSubmissionStarted,
      onWalletTransactionResolved,
    })).rejects.toThrow(/shielding transaction failed/i);
    expect(transactionStatus).toHaveBeenCalledWith("0xaaa");
    expect(onWalletTransactionSubmissionStarted).toHaveBeenCalledTimes(1);
    expect(onWalletTransactionResolved).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("leaves an unconfirmed shielding submission unresolved", async () => {
    const { provider } = providerWithResponses([
      [{ token: "0x1", balance: "0x0" }],
      { transaction_hash: "0xaaa" },
    ]);
    const onWalletTransactionSubmissionStarted = vi.fn();
    const onWalletTransactionResolved = vi.fn();

    await expect(fundZylithFromWallet({
      provider,
      tokenAddress: "0x1",
      amount: 100n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["0x3"],
      transactionStatus: async () => "pending",
      pollDelayMs: 0,
      maxBalancePolls: 1,
      onWalletTransactionSubmissionStarted,
      onWalletTransactionResolved,
    })).rejects.toThrow(/shielded balance is not ready/i);

    expect(onWalletTransactionSubmissionStarted).toHaveBeenCalledTimes(1);
    expect(onWalletTransactionResolved).not.toHaveBeenCalled();
  });

  it("registers the canonical deposit token before reading private balances", async () => {
    const { provider, request } = providerWithResponses([
      true,
      [
        { token: "0x512", balance: "0x64" },
        { token: "0xfee", balance: "0xa" },
      ],
      { transaction_hash: "0xabc" },
    ]);

    await expect(fundZylithFromWallet({
      provider,
      tokenAddress: "0x0512",
      tokenMetadata: { name: "USDC", symbol: "USDC", decimals: 6 },
      amount: 50n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["0x3"],
    })).resolves.toEqual({ transactionHash: "0xabc", shieldTransactionHash: null });

    expect(request).toHaveBeenNthCalledWith(2, {
      type: "wallet_watchAsset",
      params: {
        type: "ERC20",
        options: {
          address: "0x512",
          name: "USDC",
          symbol: "USDC",
          decimals: 6,
        },
        api_version: "0.10.4",
      },
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      type: "wallet_strk20Balances",
      params: {
        tokens: ["0x512"],
        api_version: "0.10.4",
      },
    });
  });

  it("does not continue when the wallet refuses to register the deposit token", async () => {
    const { provider, request } = providerWithResponses([false]);
    await expect(fundZylithFromWallet({
      provider,
      tokenAddress: "0x512",
      tokenMetadata: { name: "USDC", symbol: "USDC", decimals: 6 },
      amount: 50n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["0x3"],
    })).rejects.toThrow(/add usdc/i);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not misclassify a registered wallet after a non-standard balance request", async () => {
    const request = vi.fn(async (walletRequest: { type: string; params: unknown }) => {
      if (walletRequest.type === "wallet_supportedWalletApi") return ["0.10.4"];
      if (walletRequest.type === "wallet_strk20Balances") {
        const params = walletRequest.params as Record<string, unknown>;
        if ("valid_until" in params) throw new Error("An error occurred (NOT_REGISTERED)");
        return [
          { token: "0x1", balance: "0x64" },
          { token: "0xfee", balance: "0xa" },
        ];
      }
      if (walletRequest.type === "wallet_strk20InvokeTransaction") {
        const actions = (walletRequest.params as {
          actions: Array<{ type: string }>;
        }).actions;
        if (actions[0]?.type === "deposit") {
          throw new Error("An error occurred (NOT_REGISTERED)");
        }
        return { transaction_hash: "0xabc" };
      }
      throw new Error("unexpected wallet request");
    });

    await expect(fundZylithFromWallet({
      provider: { request },
      tokenAddress: "0x1",
      amount: 50n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["0x3"],
    })).resolves.toEqual({ transactionHash: "0xabc", shieldTransactionHash: null });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]![0]).toEqual({
      type: "wallet_strk20Balances",
      params: { tokens: ["0x1"], api_version: "0.10.4" },
    });
  });

  it("fails before funding if the connected wallet context changed", async () => {
    const { provider, request } = providerWithResponses([[
      { token: "0x1", balance: "0x64" },
      { token: "0xfee", balance: "0xa" },
    ]]);

    await expect(fundZylithFromWallet({
      provider,
      tokenAddress: "0x1",
      amount: 50n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["0x3"],
      assertWalletContext: () => { throw new Error("wallet changed"); },
    })).rejects.toThrow("wallet changed");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("claims a finalized exit into an open note owned by the connected wallet", async () => {
    const { provider, request } = providerWithResponses([
      [{ token: "0xfee", balance: "0x4" }],
      {
        call: {
          contract_address: "0x123",
          entry_point: "apply_actions",
          calldata: [
            "0x3",
            "0x3", "0x77", "0xfee", "0x4",
            "0x7", "0xa", "0xb", "0xc", "0x1", "0x55",
            "0xa", "0x2", "0x9",
            "0x0", "0x2", "0x44", "0x55",
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
      calldata: ["0x44", openNoteId, "0xaa", "0xbb"],
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
        feeTokenAddress: "0xfee",
        feeAmount: 4n,
        bridgeAddress: "0x2",
        bridgeCalldata: [
          "0", "2", "0x44", "${openNoteIds[0]}",
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
          { type: "withdraw", token: "0xfee", amount: "0x4", recipient: "0x77" },
          { type: "transfer", token: "0x1", amount: "OPEN", recipient: "0x99" },
          {
            type: "invoke",
            contract: "0x2",
            calldata: [
              "0x0", "0x2", "0x44", "${openNoteIds[0]}",
              "0x0", "0x0", "0x0", "0x0", "0x0",
            ],
          },
        ],
        simulate: false,
      },
    });
    expect(buildAuthorizationCall).toHaveBeenCalledWith("0x55");
    expect(submitPreparedCall).toHaveBeenCalledWith(expect.objectContaining({
      signerAddress: "0x55",
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
    const { provider } = providerWithResponses([[
      { token: "0xfee", balance: "0x4" },
    ], {
      call: {
        contract_address: "0x123",
        entry_point: "apply_actions",
        calldata: [
          "0x3",
          "0x3", "0x77", "0xfee", "0x4",
          "0x7", "0xa", "0xb", "0xc", "0x1", "0x55",
          "0xa", "0x2", "0x9",
          "0x0", "0x2", "0x44", "0x56",
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
      feeTokenAddress: "0xfee",
      feeAmount: 4n,
      bridgeAddress: "0x2",
      bridgeCalldata: [
        "0", "2", "0x44", "${openNoteIds[0]}",
        "0", "0", "0", "0", "0",
      ],
      buildAuthorizationCall,
      submitPreparedCall: vi.fn(),
    })).rejects.toThrow(/malformed private claim/i);
    expect(buildAuthorizationCall).not.toHaveBeenCalled();
  });

  it("fails before proof generation when the private fee balance is insufficient", async () => {
    const { provider, request } = providerWithResponses([
      [{ token: "0xfee", balance: "0x3" }],
    ]);

    await expect(claimZylithExitToWallet({
      provider,
      walletAddress: "0x99",
      chainId: "0x1",
      paymasterAddress: "0x77",
      paymasterUrl: "https://paymaster.example/execute-outside",
      privacyPoolAddress: "0x123",
      tokenAddress: "0x1",
      feeTokenAddress: "0xfee",
      feeAmount: 4n,
      bridgeAddress: "0x2",
      bridgeCalldata: ["0", "2", "0x44", "${openNoteIds[0]}", "0", "0", "0", "0", "0"],
      buildAuthorizationCall: vi.fn(),
      submitPreparedCall: vi.fn(),
    })).rejects.toThrow(/private STRK balance does not cover/i);
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "wallet_strk20PrepareInvoke",
    }));
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
