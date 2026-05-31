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

  it("normalizes raw Starknet network errors", () => {
    const message = userFacingErrorMessage(
      new Error("RpcError: RPC: starknet_estimateFee with params {\"execution_error\":true}"),
    );

    expect(message).toBe("Starknet network returned an error. Please retry later.");
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
    )).toBe("Private order was rejected by validation. Check available notes, curve bands, and batch status, then retry.");
  });

  it("does not expose relay authorization internals", () => {
    const message = userFacingErrorMessage(
      new Error("Renewal relay request failed with HTTP 401: Unauthorized"),
    );

    expect(message).toBe("Zylith relay could not verify this renewal package. Refresh, unlock, and retry.");
    expect(message).not.toMatch(/token|bearer|signature|authorization/i);
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
  });

  it("explains body-size failures without a generic fallback", () => {
    expect(userFacingErrorMessage(
      new Error("request to coordinator failed with HTTP 413: payload too large"),
    )).toBe("Request is too large for the service. Choose a shorter window and retry.");
  });
});
