import { describe, expect, it } from "vitest";

import { userFacingErrorMessage } from "./userFacingErrors";

describe("userFacingErrorMessage", () => {
  it("hides private deposit deployment internals", () => {
    const message = userFacingErrorMessage(
      new Error("Starknet Privacy funding is not fully configured"),
    );

    expect(message).toBe("Private deposits are not available in this deployment. Refresh the app and retry.");
    expect(message).not.toMatch(/Starknet Privacy|SDK|paymaster|proof signer/i);
  });

  it("hides low-level private deposit proof internals", () => {
    const message = userFacingErrorMessage(
      new Error("Private deposit proof failed: Wallet, prover, or RPC returned a low-level error."),
    );

    expect(message).toBe("Private deposit proof failed. Please retry later.");
    expect(message).not.toMatch(/SDK|low-level|RPC|prover/i);
  });

  it("hides private deposit funding transaction internals", () => {
    const message = userFacingErrorMessage(
      new Error("Private deposit funding setup failed: Failed while funding embedded signer from connected wallet: Starknet RPC returned an error."),
    );

    expect(message).toBe("Private deposit transaction failed. Please retry later.");
    expect(message).not.toMatch(/embedded signer|RPC|setup/i);
  });

  it("explains wallet paymaster execution failures during private deposits", () => {
    const message = userFacingErrorMessage(
      new Error("Failed while funding embedded signer from connected wallet: PaymasterV2Error: Paymaster error 156: An error occurred (TRANSACTION_EXECUTION_ERROR)"),
    );

    expect(message).toBe("The connected wallet could not execute the funding transfer. Leave a small fee balance in the wallet and retry with a lower amount.");
    expect(message).not.toMatch(/PaymasterV2Error|TRANSACTION_EXECUTION_ERROR|embedded signer/i);
  });

  it("explains ETH deposit fee headroom before opening the wallet transfer", () => {
    const message = userFacingErrorMessage(
      new Error("Private deposit funding setup failed: ETH deposit amount leaves no room for the wallet transaction fee. Try a slightly smaller amount."),
    );

    expect(message).toBe("ETH deposit amount leaves no room for the wallet fee. Try a slightly smaller amount.");
  });

  it("explains inactive connected wallets during private deposits", () => {
    const message = userFacingErrorMessage(
      new Error("Private deposit funding setup failed: Connected Starknet wallet must be deployed before depositing."),
    );

    expect(message).toBe("Connected wallet could not execute the funding transfer. Activate it in your Starknet wallet and retry.");
    expect(message).not.toMatch(/class hash|contract not found|deployed before depositing/i);
  });

  it("explains deposit relay configuration mismatches from JSON error bodies", () => {
    const message = userFacingErrorMessage(
      new Error(JSON.stringify({ error: "paymaster_address does not match paymaster configuration" })),
    );

    expect(message).toBe("The app deployment configuration does not match the deposit relay. This deployment needs a configuration fix before deposits can work.");
    expect(message).not.toMatch(/paymaster_address|configuration$/i);
  });

  it("normalizes raw Starknet network errors", () => {
    const message = userFacingErrorMessage(
      new Error("RpcError: RPC: starknet_estimateFee with params {\"execution_error\":true}"),
    );

    expect(message).toBe("Starknet network returned an error. Please retry later.");
  });

  it("hides auction-window rollover internals", () => {
    expect(userFacingErrorMessage(
      new Error("Auction window is no longer open"),
    )).toBe("Auction window rolled forward. Please retry if this persists.");
  });

  it("extracts service JSON error envelopes before applying generic fallback", () => {
    const message = userFacingErrorMessage(
      new Error(JSON.stringify({ error: "No unlocked USDC note can fund this order" })),
    );

    expect(message).toBe("No unlocked USDC note can fund this order. Cancel or edit existing curves if USDC is locked, or deposit more USDC.");
  });

  it("explains maker curve validation failures without refresh advice", () => {
    expect(userFacingErrorMessage(
      new Error("maker curve outer bands must span at least 20 bps"),
    )).toBe("Curve bands are too tight for this pair. Widen the outer prices and retry.");

    expect(userFacingErrorMessage(
      new Error("Request to /api/private/orders failed with HTTP 400"),
    )).toBe("Private order was rejected by validation. Check available notes and curve bands, then retry.");
  });

  it("does not expose relay authorization internals", () => {
    const message = userFacingErrorMessage(
      new Error("Renewal relay request failed with HTTP 401: Unauthorized"),
    );

    expect(message).toBe("Zylith relay could not verify this renewal package. Refresh, unlock, and retry.");
    expect(message).not.toMatch(/token|bearer|signature|authorization/i);
  });

  it("explains withdrawal claim-window timing", () => {
    const message = userFacingErrorMessage(
      JSON.stringify({
        error:
          "Settlement output claim window is not open yet. Retry after the claim delay.",
      }),
    );

    expect(message).toBe(
      "Withdrawal claim window is not open yet. Please retry after the claim delay.",
    );
  });

  it("keeps relayer HTTP failures out of the generic renewal-package bucket", () => {
    expect(userFacingErrorMessage(
      new Error("Renewal relay request failed with HTTP 400: Managed relay only accepts ZylithRelay packages"),
    )).toBe("Select Zylith relay as the renewal operator and retry.");

    expect(userFacingErrorMessage(
      new Error("Renewal relay request failed with HTTP 400: Renewal package exceeds slot limit"),
    )).toBe("Renewal window is too large for the managed relay. Choose a shorter window and retry.");

    expect(userFacingErrorMessage(
      new Error("Renewal relay request failed with HTTP 404: <html><body>not found</body></html>"),
    )).toBe("Zylith relay endpoint is unavailable. Refresh the app and retry.");

    expect(userFacingErrorMessage(
      new Error("Zylith relay endpoint is not configured"),
    )).toBe("Zylith relay endpoint is unavailable. Refresh the app and retry.");

    expect(userFacingErrorMessage(
      new Error("Self-hosted relay endpoint is invalid or missing"),
    )).toBe("Enter a valid self-hosted relay endpoint and retry.");

    expect(userFacingErrorMessage(
      new Error("Self-hosted relay request failed with HTTP 400: Relay accepts SelfRelay packages, got ZylithRelay"),
    )).toBe("Relay mode does not match the selected renewal operator. Check the relay configuration and retry.");
  });

  it("explains body-size failures without a generic fallback", () => {
    expect(userFacingErrorMessage(
      new Error("request to coordinator failed with HTTP 413: payload too large"),
    )).toBe("Request is too large for the service. Choose a shorter window and retry.");
  });
});
