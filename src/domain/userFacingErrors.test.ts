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
});
