import { describe, expect, it } from "vitest";

import { RuntimeHttpStatusError } from "./runtimeHttp";
import { userFacingErrorMessage } from "./userFacingErrors";

describe("userFacingErrorMessage", () => {
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
      "Private deposits are temporarily unavailable while the privacy prover is upgraded."
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

  it("explains ETH deposit fee headroom before opening the wallet transfer", () => {
    const message = userFacingErrorMessage(
      new Error(
        "Private deposit funding setup failed: ETH deposit amount leaves no room for the wallet transaction fee. Try a slightly smaller amount."
      )
    );

    expect(message).toBe(
      "ETH deposit amount leaves no room for the wallet fee. Try a slightly smaller amount."
    );
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

  it("explains wallet transaction timeouts as wallet actions", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "Starknet wallet transaction timed out. Open your wallet, approve the transaction, and retry."
        )
      )
    ).toBe("Wallet transaction timed out. Open your Starknet wallet and retry.");
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

  it("hides auction-window rollover internals", () => {
    expect(
      userFacingErrorMessage(new Error("Auction window is no longer open"))
    ).toBe(
      "Submission window moved. Retry to use the next available window."
    );
    expect(
      userFacingErrorMessage(
        new Error("Auction window is inside the submission safety buffer")
      )
    ).toBe(
      "Submission window moved. Retry to use the next available window."
    );
    expect(
      userFacingErrorMessage(
        new Error(
          "Auction window entered the submission safety buffer before private ingress submission"
        )
      )
    ).toBe(
      "Submission window moved. Retry to use the next available window."
    );
    expect(
      userFacingErrorMessage(
        new Error("Auction window rolled forward. Please retry if this persists.")
      )
    ).toBe(
      "Submission window moved. Retry to use the next available window."
    );
    expect(
      userFacingErrorMessage(
        new Error(
          "No safe auction window is available; cannot refresh renewal slots"
        )
      )
    ).toBe(
      "Submission window moved. Retry to use the next available window."
    );
    expect(
      userFacingErrorMessage(
        new RuntimeHttpStatusError("/api/orders", 409, "")
      )
    ).toBe(
      "Submission window moved. Retry to use the next available window."
    );
  });

  it("extracts service JSON error envelopes before applying generic fallback", () => {
    const message = userFacingErrorMessage(
      new Error(
        JSON.stringify({ error: "No available USDC balance can fund this order" })
      )
    );

    expect(message).toBe(
      "No available USDC balance can fund this order. Cancel or edit existing positions if USDC is reserved, or deposit more USDC."
    );
  });

  it("explains liquidity position validation failures without refresh advice", () => {
    expect(
      userFacingErrorMessage(
        new Error("liquidity curve outer bands must span at least 20 bps")
      )
    ).toBe(
      "Position bands are too tight for this pair. Widen the outer prices and retry."
    );

    expect(
      userFacingErrorMessage(
        new Error("Request to /api/private/orders failed with HTTP 400")
      )
    ).toBe(
      "Private order was rejected by validation. Check available notes and position bands, then retry."
    );
  });

  it("does not expose relay authorization internals", () => {
    const message = userFacingErrorMessage(
      new Error("Renewal relay request failed with HTTP 401: Unauthorized")
    );

    expect(message).toBe(
      "Zylith relay could not verify this renewal package. Refresh the app and retry."
    );
    expect(message).not.toMatch(/token|bearer|signature|authorization/i);
  });

  it("does not classify unrelated unauthorized errors as renewal relay failures", () => {
    expect(
      userFacingErrorMessage(new Error("Unauthorized"))
    ).toBe("Unauthorized");
    expect(
      userFacingErrorMessage(
        new Error("Private report request failed with HTTP 401: Unauthorized")
      )
    ).not.toBe(
      "Zylith relay could not verify this renewal package. Refresh the app and retry."
    );
  });

  it("explains withdrawal claim-window timing", () => {
    const message = userFacingErrorMessage(
      JSON.stringify({
        error:
          "Settlement output claim window is not open yet. Retry after the claim delay.",
      })
    );

    expect(message).toBe(
      "Withdrawal claim window is not open yet. Please retry after the claim delay."
    );
  });

  it("keeps relayer HTTP failures out of the generic renewal-package bucket", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "Renewal relay request failed with HTTP 400: Hosted relay only accepts ZylithRelay packages"
        )
      )
    ).toBe("Select Zylith relay as the renewal operator and retry.");

    expect(
      userFacingErrorMessage(
        new Error(
          "Renewal relay request failed with HTTP 400: Renewal package exceeds slot limit"
        )
      )
    ).toBe(
      "Renewal window is too large for the hosted relay. Choose a shorter window and retry."
    );

    expect(
      userFacingErrorMessage(
        new Error(
          "Renewal relay request failed with HTTP 404: <html><body>not found</body></html>"
        )
      )
    ).toBe("Zylith relay endpoint is unavailable. Refresh the app and retry.");

    expect(
      userFacingErrorMessage(
        new Error("Zylith relay endpoint is not configured")
      )
    ).toBe("Zylith relay endpoint is unavailable. Refresh the app and retry.");

    expect(
      userFacingErrorMessage(
        new Error("Self-hosted relay endpoint is invalid or missing")
      )
    ).toBe("Enter a valid self-hosted relay endpoint and retry.");

    expect(
      userFacingErrorMessage(
        new Error(
          "Self-hosted relay request failed with HTTP 400: Relay accepts SelfRelay packages, got ZylithRelay"
        )
      )
    ).toBe(
      "Relay mode does not match the selected renewal operator. Check the relay configuration and retry."
    );
  });

  it("explains body-size failures without a generic fallback", () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "request to coordinator failed with HTTP 413: payload too large"
        )
      )
    ).toBe(
      "Request is too large for the service. Choose a shorter window and retry."
    );
  });
});
