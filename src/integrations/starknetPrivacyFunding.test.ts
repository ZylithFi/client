import { describe, expect, it } from "vitest";
import {
  privacyBridgeDepositCalldata,
  privacyBridgeDepositInvokeCall,
  privacyBridgeStrk20ExitClaimCalldata,
  privacyBridgeStrk20ExitClaimInvokeCall,
  STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS,
  type PrivacyBridgeDepositPlan,
} from "./starknetPrivacyFunding";

describe("starknet privacy proof delay schedule", () => {
  it("retries with monotonically older proof blocks", () => {
    expect(STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS[0]).toBeGreaterThanOrEqual(16);
    for (let i = 1; i < STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS.length; i += 1) {
      expect(STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS[i]).toBeGreaterThan(
        STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS[i - 1],
      );
    }
  });
});

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
    expect(privacyBridgeDepositInvokeCall({
      bridgeAddress: "0xbridge",
      plan,
    })).toEqual({
      contractAddress: "0xbridge",
      entrypoint: "privacy_invoke",
      calldata: [
        ["0xf00", "0xf01"],
        ["0xd00", "0xd01"],
        ["0xe00", "0xe01"],
      ],
    });
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

describe("privacyBridgeStrk20ExitClaimCalldata", () => {
  it("builds the staged STRK20 exit claim calldata without a public recipient", () => {
    const calldata = privacyBridgeStrk20ExitClaimCalldata({
      exitCommitment: "0xexit",
      openNoteId: "0xopen",
      signature: {
        signature_r: "0xr",
        signature_s: "0xs",
      },
    });

    expect(calldata).toEqual([
      [],
      ["0xexit", "0xopen", "0xr", "0xs"],
      [],
    ]);
    expect(privacyBridgeStrk20ExitClaimInvokeCall({
      bridgeAddress: "0xbridge",
      exitCommitment: "0xexit",
      openNoteId: "0xopen",
      signature: {
        signature_r: "0xr",
        signature_s: "0xs",
      },
    })).toEqual({
      contractAddress: "0xbridge",
      entrypoint: "privacy_invoke",
      calldata,
    });
    expect(JSON.stringify(calldata)).not.toContain("recipient");
  });
});
