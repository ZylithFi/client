import { describe, expect, it } from "vitest";
import { privacyBridgeDepositCalldata, type PrivacyBridgeDepositPlan } from "./starknetPrivacyFunding";

describe("privacyBridgeDepositCalldata", () => {
  it("builds the batch-shaped privacy_invoke calldata expected by the bridge", () => {
    const plan: PrivacyBridgeDepositPlan = {
      amount: 300n,
      encodedArgs: {
        asset_id: "USDC",
        total_amount: "300",
        amounts: ["100", "200"],
        deposit_nonces: ["7", "8"],
        note_commitments: ["0xaaa", "0xbbb"],
        withdraw_authorities: ["0x111", "0x222"],
      },
    };

    expect(privacyBridgeDepositCalldata(plan)).toEqual([
      "USDC",
      "300",
      ["100", "200"],
      ["7", "8"],
      ["0xaaa", "0xbbb"],
      ["0x111", "0x222"],
    ]);
  });
});
