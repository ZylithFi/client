import { describe, expect, it } from "vitest";
import { privacyBridgeDepositCalldata, type PrivacyBridgeDepositPlan } from "./starknetPrivacyFunding";

describe("privacyBridgeDepositCalldata", () => {
  it("builds the opaque activation calldata expected by the bridge", () => {
    const plan: PrivacyBridgeDepositPlan = {
      amount: 300n,
      encodedArgs: {
        funding_commitments: ["0xf00", "0xf01"],
        deposit_roots: ["0xd00", "0xd01"],
        encrypted_note_activations: ["0xe00", "0xe01"],
      },
    };

    expect(privacyBridgeDepositCalldata(plan)).toEqual([
      ["0xf00", "0xf01"],
      ["0xd00", "0xd01"],
      ["0xe00", "0xe01"],
    ]);
  });

  it("does not serialize raw deposit asset amount nonce or note commitment", () => {
    const rawAsset = "USDC";
    const rawAmount = "300";
    const rawNonce = "7";
    const rawNoteCommitment = "0xaaa";
    const plan: PrivacyBridgeDepositPlan = {
      amount: 300n,
      encodedArgs: {
        funding_commitments: ["0xf00"],
        deposit_roots: ["0xd00"],
        encrypted_note_activations: ["0xe00"],
      },
    };

    const serialized = JSON.stringify(privacyBridgeDepositCalldata(plan));
    expect(serialized).not.toContain(rawAsset);
    expect(serialized).not.toContain(rawAmount);
    expect(serialized).not.toContain(rawNonce);
    expect(serialized).not.toContain(rawNoteCommitment);
  });
});
