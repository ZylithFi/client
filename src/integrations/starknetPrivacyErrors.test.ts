import { describe, expect, it } from "vitest";
import {
  decodeMaybeHexString,
  errorMessage,
  isProofBlockTooRecent,
  isProofProviderContractVisibilityLag,
  isUserRejected,
  isWalletCallShapeError,
  isWalletRequestUnavailableError,
  sanitizeRpcMessage,
  starknetRpcReason,
  summarizeFundingError,
  unwrapJsonErrorBody,
} from "./starknetPrivacyErrors";

describe("starknet privacy error summaries", () => {
  it("unwraps JSON error bodies before summarizing", () => {
    expect(unwrapJsonErrorBody('{"error":"paymaster_address does not match paymaster configuration"}')).toBe(
      "paymaster_address does not match paymaster configuration"
    );
    expect(summarizeFundingError('{"error":"paymaster_address does not match paymaster configuration"}')).toContain(
      "deployment configuration does not match the relay"
    );
  });

  it("maps known wallet funding failures to user-facing summaries", () => {
    expect(summarizeFundingError("u256_sub overflow")).toBe(
      "Connected wallet does not have enough token balance for this deposit."
    );
    expect(summarizeFundingError("ETH deposit amount leaves no room for the wallet transaction fee.")).toContain(
      "slightly smaller amount"
    );
  });

  it("keeps proof retry classifications machine-readable", () => {
    expect(isProofBlockTooRecent(new Error("proof block number 100 too recent"))).toBe(true);
    expect(isProofBlockTooRecent(new Error("outer", {
      cause: new Error("maximum allowed block number is 20"),
    }))).toBe(true);
    expect(isProofProviderContractVisibilityLag("requested contract address 0xabc is not deployed")).toBe(true);
  });

  it("detects wallet request and shape failures", () => {
    expect(isUserRejected("User rejected the transaction")).toBe(true);
    expect(isWalletRequestUnavailableError("wallet_addInvokeTransaction method not found")).toBe(true);
    expect(isWalletCallShapeError("invalid_union: contractAddress expected")).toBe(true);
  });
});

describe("starknet privacy RPC error normalization", () => {
  it("extracts nested error messages and decodes readable hex strings", () => {
    const error = {
      message: "RPC error",
      data: {
        revert_error: "0x494e56414c49445f534947",
      },
    };

    expect(errorMessage(error)).toContain("INVALID_SIG");
    expect(decodeMaybeHexString("0x494e56414c49445f534947")).toBe("0x494e56414c49445f534947 ('INVALID_SIG')");
  });

  it("redacts large calldata and signatures from RPC messages", () => {
    expect(sanitizeRpcMessage('{"calldata":["0x1","0x2"],"signature":["0x3"]}')).toBe(
      '{"calldata":[...],"signature":[...]}'
    );
  });

  it("extracts useful Starknet RPC reasons", () => {
    expect(starknetRpcReason("RPC: ('transfer amount exceeds balance')")).toBe(
      "transfer amount exceeds balance"
    );
    expect(starknetRpcReason("RPC: account validation failed")).toBe(
      "account validation failed"
    );
  });
});
