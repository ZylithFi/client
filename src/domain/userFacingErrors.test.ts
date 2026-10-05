import { describe, expect, it } from "vitest";

import { userFacingErrorMessage } from "./userFacingErrors";

describe("userFacingErrorMessage", () => {
  it("describes wallet changes for the operation that was interrupted", () => {
    expect(userFacingErrorMessage(
      new Error("Connected Starknet wallet changed during the private withdrawal."),
    )).toBe("Connected wallet changed during withdrawal. Reconnect the wallet you started with and retry.");
    expect(userFacingErrorMessage(
      new Error("Connected Starknet wallet changed during the deposit."),
    )).toBe("Connected wallet changed during deposit. Reconnect the wallet you started with and retry.");
  });

  it("hides private deposit deployment internals", () => {
    const message = userFacingErrorMessage(
      new Error("Starknet Privacy funding is not fully configured")
    );

    expect(message).toBe(
      "Private deposits are not available in this deployment. Refresh the app and retry."
    );
    expect(message).not.toMatch(/Starknet Privacy|SDK|paymaster|proof signer/i);
  });

  it("hides low-level private deposit proof internals", () => {
    const message = userFacingErrorMessage(
      new Error(
        "Private deposit proof failed: Wallet, prover, or RPC returned a low-level error."
      )
    );

    expect(message).toBe("Private deposit proof failed. Please retry later.");
    expect(message).not.toMatch(/SDK|low-level|RPC|prover/i);
  });

  it("explains privacy prover protocol drift without exposing proof internals", () => {
    const message = userFacingErrorMessage(
      new Error(
        "Invalid proof facts: Proof version 88314448135728 (PROOF0) is not allowed under this protocol version."
      )
    );

    expect(message).toBe(
      "Private deposits are temporarily unavailable because the privacy prover and Starknet submission gateway use different proof versions."
    );
    expect(message).not.toMatch(/PROOF0|proof facts|883144/i);
  });

  it("explains missing STRK20 screening attestations without exposing contract internals", () => {
    const message = userFacingErrorMessage(
      new Error(
        "Private deposit proof failed: Execution reverted: SCREENING_REQUIRED"
      )
    );

    expect(message).toBe(
      "Private deposits are temporarily unavailable while screening is configured."
    );
    expect(message).not.toMatch(/SCREENING_REQUIRED|attestation/i);
  });

  it("uses flow-neutral wording for privacy SDK warnings", () => {
    expect(
      userFacingErrorMessage(
        new Error("Private withdrawal privacy warning: USER_LINKAGE")
      )
    ).toBe(
      "This action would weaken privacy. Use a different amount or retry later."
    );
  });

  it("hides private deposit funding transaction internals", () => {
    const message = userFacingErrorMessage(
      new Error(
        "Private deposit funding setup failed: Failed while funding deposit session from connected wallet: Starknet RPC returned an error."
      )
    );

    expect(message).toBe(
      "Private deposit transaction failed. Please retry later."
    );
    expect(message).not.toMatch(/deposit session|RPC|setup/i);
  });

  it("explains wallet paymaster execution failures during private deposits", () => {
    const message = userFacingErrorMessage(
      new Error(
        "Failed while funding deposit session from connected wallet: PaymasterV2Error: Paymaster error 156: An error occurred (TRANSACTION_EXECUTION_ERROR)"
      )
    );

    expect(message).toBe(
      "The connected wallet could not execute the funding transfer. Open the wallet, review the failed transaction, and retry."
    );
    expect(message).not.toMatch(
      /PaymasterV2Error|TRANSACTION_EXECUTION_ERROR|deposit session/i
    );
  });

  it("explains terse wallet simulation failures during connected-wallet deposit funding", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "Failed while funding deposit session from connected wallet: Transaction failed"
        )
      )
    ).toBe(
      "The connected wallet could not execute the funding transfer. Open the wallet, review the failed transaction, and retry."
    );
    expect(
      userFacingErrorMessage(
        new Error(
          "Failed while funding deposit session from connected wallet: Unknown token"
        )
      )
    ).toBe(
      "The connected wallet could not execute the funding transfer. Open the wallet, review the failed transaction, and retry."
    );
  });

  it("explains transaction-relay failures without deposit-specific wording", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "Private withdrawal submission failed: Transaction relay did not return a transaction hash"
        )
      )
    ).toBe("Transaction relay is unavailable. Please retry later.");
    expect(
      userFacingErrorMessage(
        new Error("Private relay request failed with HTTP 502")
      )
    ).toBe("Transaction relay is unavailable. Please retry later.");
  });

  it("explains fee-token headroom before opening the wallet transfer", () => {
    const message = userFacingErrorMessage(
      new Error(
        "Private deposit funding setup failed: Depositing the fee token would leave no room for the wallet transaction fee. Try a slightly smaller amount."
      )
    );

    expect(message).toBe(
      "This deposit would leave no fee-token balance for the wallet fee. Try a slightly smaller amount."
    );
  });

  it("distinguishes insufficient shielded balance from public network fees", () => {
    const message = userFacingErrorMessage(
      new Error("An error occurred (INSUFFICIENT_PRIVATE_BALANCE)"),
    );

    expect(message).toBe(
      "Your shielded balance does not cover this private transaction fee.",
    );
    expect(message).not.toMatch(/Starknet network fees|connected wallet/i);
  });

  it("explains counterfactual connected-wallet accounts before private deposits", () => {
    const message = userFacingErrorMessage(
      new Error(
        "Private deposit funding setup failed: Failed while checking connected Starknet wallet activation: Connected Starknet wallet is not activated yet. Complete one outgoing Starknet transaction in the wallet, then retry the deposit."
      )
    );

    expect(message).toBe(
      "Connected Starknet wallet is not activated yet. Complete one outgoing Starknet transaction in the wallet, then retry the deposit."
    );
  });

  it("explains deposit relay configuration mismatches from JSON error bodies", () => {
    const message = userFacingErrorMessage(
      new Error(
        JSON.stringify({
          error: "paymaster_address does not match paymaster configuration",
        })
      )
    );

    expect(message).toBe(
      "The app deployment configuration does not match the deposit relay. This deployment needs a configuration fix before deposits can work."
    );
    expect(message).not.toMatch(/paymaster_address|configuration$/i);
  });

  it("explains paymaster balance exhaustion without blaming the connected wallet", () => {
    const message = userFacingErrorMessage(
      new Error(
        "Private deposit submission failed: Starknet RPC rejected proof-bearing invoke: code=55 message=Account validation failed data=Resources bounds exceed balance (6160594220038880144)."
      )
    );

    expect(message).toBe(
      "Deposit relay is temporarily underfunded. Please retry later."
    );
  });

  it("normalizes raw Starknet network errors", () => {
    const message = userFacingErrorMessage(
      new Error(
        'RpcError: RPC: starknet_estimateFee with params {"execution_error":true}'
      )
    );

    expect(message).toBe(
      "Starknet network returned an error. Please retry later."
    );
  });

  it("normalizes raw abort signal failures", () => {
    expect(
      userFacingErrorMessage(new Error("Signal is aborted without reason"))
    ).toBe("Request timed out. Please retry later.");
    expect(
      userFacingErrorMessage(new Error("Zylith SDK request aborted"))
    ).toBe("Request timed out. Please retry later.");
    expect(userFacingErrorMessage(new Error("fetch failed"))).toBe(
      "Network request failed. Check your connection and retry."
    );
  });

  it("redacts field elements from fallback messages", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "wallet returned unknown token 0x1234567890abcdef1234567890abcdef1234567890abcdef"
        )
      )
    ).toBe("Wallet returned unknown token <felt>");
  });

  it("explains wallet signature timeouts as wallet actions", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "Wallet signature request timed out. Open your Starknet wallet, approve the signature, and retry."
        )
      )
    ).toBe("Wallet signature timed out. Open your Starknet wallet and retry.");
  });

  it("explains wallet connection timeouts as wallet actions", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "Starknet wallet request timed out. Unlock your wallet and retry."
        )
      )
    ).toBe(
      "Wallet connection timed out. Open or unlock your Starknet wallet and retry."
    );
  });

  it("explains wallet transaction timeouts as wallet actions", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "Starknet wallet transaction timed out. Open your wallet, approve the transaction, and retry."
        )
      )
    ).toBe(
      "Wallet transaction timed out. Open your Starknet wallet and retry."
    );
  });

  it("normalizes wrapped private deposit abort signal failures before generic proof failures", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "Private deposit proof failed: Signal is aborted without reason"
        )
      )
    ).toBe("Private deposit service timed out. Please retry later.");
  });

  it("extracts service JSON error envelopes before applying generic fallback", () => {
    const message = userFacingErrorMessage(
      new Error(
        JSON.stringify({
          error: "No available USDC balance can fund this order",
        })
      )
    );

    expect(message).toBe(
      "No available USDC balance can fund this order. Cancel or edit existing orders if USDC is reserved, or deposit more USDC."
    );
  });

  it("handles cyclic provider error objects without overflowing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.error = cyclic;

    expect(
      userFacingErrorMessage(cyclic, "Wallet request failed. Retry.")
    ).toBe("Wallet request failed. Retry.");
  });

  it("bounds deeply nested provider error traversal", () => {
    const root: Record<string, unknown> = {};
    let current = root;
    for (let depth = 0; depth < 100; depth += 1) {
      const nested: Record<string, unknown> = {};
      current.error = nested;
      current = nested;
    }
    current.message = "internal wallet detail";

    expect(
      userFacingErrorMessage(root, "Wallet request failed. Retry.")
    ).toBe("Wallet request failed. Retry.");
  });

  it("still extracts ordinary bounded nested provider errors", () => {
    expect(
      userFacingErrorMessage({
        error: {
          detail: {
            message: "user rejected the request",
          },
        },
      })
    ).toBe("Request cancelled in wallet.");
  });

  it("isolates provider errors with throwing fields and revoked proxies", () => {
    const throwing = Object.defineProperty({}, "message", {
      get: () => { throw new Error("broken message getter"); },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(userFacingErrorMessage(throwing, "Wallet request failed. Retry."))
      .toBe("Wallet request failed. Retry.");
    expect(userFacingErrorMessage(proxy, "Wallet request failed. Retry."))
      .toBe("Wallet request failed. Retry.");
  });

  it("explains body-size failures without a generic fallback", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "request to coordinator failed with HTTP 413: payload too large"
        )
      )
    ).toBe(
      "Request is too large for the service."
    );
  });
});
