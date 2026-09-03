import { describe, expect, it } from "vitest";
import {
  decodeMaybeHexString,
  errorMessage,
  isProofBlockTooRecent,
  isProofExpired,
  isProofProviderContractVisibilityLag,
  isProofProviderServiceBusy,
  isProofProviderTransientNetworkError,
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

  it("keeps paymaster account balance failures separate from user wallet balance failures", () => {
    expect(
      summarizeFundingError(
        "Starknet RPC rejected proof-bearing invoke: code=55 message=Account validation failed data=Resources bounds exceed balance (6160594220038880144)."
      )
    ).toBe(
      "Deposit relay does not have enough STRK to submit the proof-bearing transaction."
    );
  });

  it("reports and classifies expired proof-bearing submissions", () => {
    const error = new Error("outer", {
      cause: {
        message:
          "Starknet RPC rejected proof-bearing fee estimate: Entry point panicked with 0x50524f4f465f45585049524544 ('PROOF_EXPIRED')",
      },
    });
    expect(summarizeFundingError(error)).toBe(
      "The privacy proof expired before Starknet accepted it. Retrying with a fresher proof."
    );
    expect(isProofExpired(error)).toBe(true);
  });

  it("reports proof protocol incompatibility before generic proof-fact errors", () => {
    expect(summarizeFundingError(
      "Invalid proof facts: Proof version 88314448135728 (PROOF0) is not allowed under this protocol version."
    )).toBe(
      "The privacy prover is incompatible with the current Starknet protocol."
    );
  });

  it("reports missing STRK20 screening attestations explicitly", () => {
    expect(summarizeFundingError("Execution reverted: SCREENING_REQUIRED")).toBe(
      "Private deposit screening attestation is not configured."
    );
  });

  it("normalizes raw browser abort signal failures", () => {
    expect(summarizeFundingError("Signal is aborted without reason")).toBe(
      "A required service timed out. Please retry later."
    );
    expect(summarizeFundingError("The operation was aborted.")).toBe(
      "A required service timed out. Please retry later."
    );
    expect(summarizeFundingError("Zylith SDK request aborted")).toBe(
      "A required service timed out. Please retry later."
    );
    expect(summarizeFundingError("fetch failed")).toBe(
      "A required network request failed."
    );
  });

  it("keeps proof retry classifications machine-readable", () => {
    expect(isProofBlockTooRecent(new Error("proof block number 100 too recent"))).toBe(true);
    expect(isProofExpired(new Error("Execution reverted: PROOF_EXPIRED"))).toBe(true);
    expect(isProofBlockTooRecent(new Error("outer", {
      cause: new Error("maximum allowed block number is 20"),
    }))).toBe(true);
    expect(isProofProviderContractVisibilityLag("requested contract address 0xabc is not deployed")).toBe(true);
    expect(isProofProviderServiceBusy("Service is busy: The proving service is at capacity")).toBe(true);
    expect(isProofProviderServiceBusy(new Error("outer", {
      cause: new Error("ProvingServiceError -32005"),
    }))).toBe(true);
    expect(isProofProviderTransientNetworkError("Network request failed")).toBe(true);
    expect(isProofProviderTransientNetworkError(new Error("outer", {
      cause: new Error("Signal is aborted without reason"),
    }))).toBe(true);
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

  it("redacts long felts and decimal blobs from RPC messages", () => {
    expect(
      sanitizeRpcMessage(
        "reverted for note 0x1234567890abcdef1234567890abcdef1234567890abcdef and amount 1234567890123456789012345678901234567890"
      )
    ).toBe("reverted for note <felt> and amount <number>");
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
