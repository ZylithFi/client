import { describe, expect, it } from "vitest";
import {
  paymasterExecuteUrl,
  serviceBaseUrl,
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
});
