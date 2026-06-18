import { describe, expect, it } from "vitest";
import {
  hostedNoteConsolidationEnabledForDeployment,
  hostedWithdrawalEnabledForDeployment,
  selectedDepositFundingRail,
  type FundingDeploymentConfig,
} from "./fundingRail";

const completeDeployment = {
  proof: {
    native_tx_prover_url: "https://prover",
    note_consolidation_statement_program_address: "0xabc",
  },
  contracts: {
    auction_verifier: "0x123",
    privacy_deposit_bridge: "0x456",
    shielded_asset_adapter: "0x456",
  },
  funding: {
    primary: "starknet_privacy",
    capabilities: {
      private_withdrawals: true,
      private_transfers: true,
    },
    starknet_privacy: {
      privacy_pool: "0xaaa",
      bridge_adapter: "0x456",
      discovery_url: "https://discovery",
      proving_url: "https://prover",
      paymaster_address: "0x789",
      paymaster_url: "https://paymaster",
      proof_signer_class_hash: "0x999",
      shielded_asset_adapter: "0x456",
      sdk_package: "@starkware-libs/starknet-privacy-sdk",
      sdk_version: "1.0.0",
      min_proving_delay_blocks: 10,
    },
  },
} satisfies FundingDeploymentConfig;

describe("fundingRail", () => {
  it("selects the configured STRK20 funding rail", () => {
    expect(selectedDepositFundingRail(completeDeployment)).toMatchObject({
      kind: "starknet_privacy",
      bridgeAdapter: "0x456",
      privacyPool: "0xaaa",
      privacyProofSignerClassHash: "0x999",
    });
  });

  it("rejects incomplete or mismatched funding rails", () => {
    expect(() =>
      selectedDepositFundingRail({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            shielded_asset_adapter: "0x999",
          },
        },
      })
    ).toThrow("Private deposit funding is not fully configured");
    expect(() =>
      selectedDepositFundingRail({
        ...completeDeployment,
        funding: { primary: "protocol_local" },
      })
    ).toThrow("Unsupported funding configuration");
  });

  it("enables hosted withdrawals only for complete private-withdrawal deployments", () => {
    expect(hostedWithdrawalEnabledForDeployment(completeDeployment)).toBe(true);
    expect(
      hostedWithdrawalEnabledForDeployment({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          capabilities: { private_withdrawals: false },
        },
      })
    ).toBe(false);
    expect(
      hostedWithdrawalEnabledForDeployment({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            paymaster_url: "",
          },
        },
      })
    ).toBe(false);
  });

  it("enables hosted consolidation for private withdrawal or transfer deployments", () => {
    expect(hostedNoteConsolidationEnabledForDeployment(completeDeployment)).toBe(
      true,
    );
    expect(
      hostedNoteConsolidationEnabledForDeployment({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          capabilities: {},
        },
      })
    ).toBe(false);
  });
});
