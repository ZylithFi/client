import { describe, expect, it } from "vitest";
import {
  paymasterExecuteUrl,
  paymasterPrivacySignerEnsureUrl,
  paymasterPrivacySignerRelayUrl,
  serviceBaseUrl,
  transactionHashFromResult,
} from "./starknetPrivacyTransport";

describe("starknet privacy transport urls", () => {
  it("normalizes service base urls", () => {
    expect(serviceBaseUrl(" https://api.example.com/// ")).toBe("https://api.example.com");
    expect(serviceBaseUrl("https://api.example.com/path")).toBe("https://api.example.com/path");
  });

  it("builds paymaster execute urls from either base or execute endpoint", () => {
    expect(paymasterExecuteUrl("https://paymaster.example.com")).toBe(
      "https://paymaster.example.com/execute-outside"
    );
    expect(paymasterExecuteUrl("https://paymaster.example.com/execute-outside")).toBe(
      "https://paymaster.example.com/execute-outside"
    );
    expect(paymasterExecuteUrl("https://paymaster.example.com///")).toBe(
      "https://paymaster.example.com/execute-outside"
    );
    expect(paymasterExecuteUrl(" https://paymaster.example.com/execute-outside ")).toBe(
      "https://paymaster.example.com/execute-outside"
    );
  });

  it("builds privacy-signer urls from either base or execute endpoint", () => {
    expect(paymasterPrivacySignerEnsureUrl("https://paymaster.example.com")).toBe(
      "https://paymaster.example.com/privacy-signer/ensure"
    );
    expect(paymasterPrivacySignerRelayUrl("https://paymaster.example.com")).toBe(
      "https://paymaster.example.com/privacy-signer/relay"
    );
    expect(paymasterPrivacySignerEnsureUrl("https://paymaster.example.com/execute-outside")).toBe(
      "https://paymaster.example.com/privacy-signer/ensure"
    );
    expect(paymasterPrivacySignerRelayUrl("https://paymaster.example.com/execute-outside")).toBe(
      "https://paymaster.example.com/privacy-signer/relay"
    );
  });
});

describe("transactionHashFromResult", () => {
  it("extracts wallet and relay transaction hashes", () => {
    expect(transactionHashFromResult("0xabc")).toBe("0xabc");
    expect(transactionHashFromResult({ transaction_hash: "0xabc" })).toBe("0xabc");
    expect(transactionHashFromResult({ transactionHash: "0xdef" })).toBe("0xdef");
    expect(transactionHashFromResult({ hash: "0x123" })).toBe("0x123");
  });

  it("returns null for missing or empty hashes", () => {
    expect(transactionHashFromResult(null)).toBeNull();
    expect(transactionHashFromResult({ transaction_hash: "" })).toBeNull();
    expect(transactionHashFromResult({ transaction_hash: 123 })).toBeNull();
  });
});
