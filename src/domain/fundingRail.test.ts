import { describe, expect, it } from "vitest";
import {
  fundingRailTokenAddress,
  noteConsolidationEnabledForDeployment,
  selectedDepositFundingRail,
  strk20WithdrawalEnabledForDeployment,
  type FundingDeploymentConfig,
} from "./fundingRail";

const completeDeployment = {
  proof: {
    native_tx_prover_url: "https://prover",
    native_tx_prover_ohttp_enabled: true,
    note_consolidation_statement_program_address: "0xabc",
  },
  contracts: {
    auction_verifier: "0x123",
    shielded_asset_adapter: "0x456",
  },
  token_addresses: {
    STRK: "0xaaa1",
  },
  funding: {
    primary: "starknet_privacy",
    assets: {
      STRK: {
        token_address: "0xaaa1",
        rail_token_address: "0xaaa1",
      },
    },
    starknet_privacy: {
      privacy_pool: "0xaaa",
      bridge_adapter: "0x456",
      discovery_url: "https://discovery",
      proving_url: "https://prover",
      proving_ohttp_enabled: true,
      paymaster_address: "0x789",
      paymaster_url: "https://paymaster",
      proof_signer_class_hash: "0x999",
      sdk_package: "@starkware-libs/starknet-privacy-sdk",
      sdk_version: "1.0.0",
      min_proving_delay_blocks: 10,
    },
  },
  product: {
    assets: {
      STRK: {
        token_address: "0xaaa1",
      },
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
      provingOhttpEnabled: true,
    });
  });

  it("resolves the funding token only when product and rail aliases match", () => {
    expect(fundingRailTokenAddress(completeDeployment, "STRK")).toBe("0xaaa1");

    expect(() =>
      fundingRailTokenAddress(
        {
          ...completeDeployment,
          funding: {
            ...completeDeployment.funding,
            assets: {
              STRK: {
                ...completeDeployment.funding.assets.STRK,
                rail_token_address: "0xaaa2",
              },
            },
          },
        },
        "STRK",
      ),
    ).toThrow("STRK token address does not match the configured funding rail token address");

    expect(() =>
      fundingRailTokenAddress(
        {
          ...completeDeployment,
          funding: {
            ...completeDeployment.funding,
            assets: {},
          },
        },
        "STRK",
      ),
    ).toThrow("STRK funding rail token address is not configured");
  });

  it("rejects incomplete or mismatched funding rails", () => {
    expect(() =>
      selectedDepositFundingRail({
        ...completeDeployment,
        contracts: {
          ...completeDeployment.contracts,
          shielded_asset_adapter: "0x999",
        },
      })
    ).toThrow("Private deposit funding is not fully configured");
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
        contracts: {
          ...completeDeployment.contracts,
          shielded_asset_adapter: "",
        },
      })
    ).toThrow("Private deposit funding is not fully configured");
    expect(() =>
      selectedDepositFundingRail({
        ...completeDeployment,
        funding: { primary: "unsupported" },
      })
    ).toThrow("Unsupported funding configuration");
    expect(() =>
      selectedDepositFundingRail({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            proving_ohttp_enabled: false,
          },
        },
      })
    ).toThrow("Private deposit funding is not fully configured");
    expect(() =>
      selectedDepositFundingRail({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            proving_url: "http://35.192.48.142:3000",
          },
        },
      })
    ).toThrow("Private deposit funding is not fully configured");
    expect(() =>
      selectedDepositFundingRail({
        ...completeDeployment,
        contracts: {
          ...completeDeployment.contracts,
          shielded_asset_adapter: "0x0",
        },
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            bridge_adapter: "0x0",
          },
        },
      })
    ).toThrow("Private deposit funding is not fully configured");
    expect(() =>
      selectedDepositFundingRail({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            paymaster_address: "not-a-felt",
          },
        },
      })
    ).toThrow("Private deposit funding is not fully configured");
  });

  it("allows localhost service URLs for local development only", () => {
    const localDeployment = {
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            discovery_url: "http://localhost:8080",
            proving_url: "http://127.0.0.1:3000",
            paymaster_url: "http://[::1]:8787/execute-outside",
          },
        },
      };
    expect(
      selectedDepositFundingRail(localDeployment, { allowLocalServiceUrls: true })
    ).toMatchObject({
      discoveryUrl: "http://localhost:8080",
      provingUrl: "http://127.0.0.1:3000",
      paymasterUrl: "http://[::1]:8787/execute-outside",
    });
    expect(() =>
      selectedDepositFundingRail(localDeployment, { allowLocalServiceUrls: false })
    ).toThrow("Private deposit funding is not fully configured");
    expect(
      strk20WithdrawalEnabledForDeployment(localDeployment, {
        allowLocalServiceUrls: false,
      })
    ).toBe(false);
  });

  it("allows same-origin service paths for deployment rewrites", () => {
    const rewriteDeployment = {
      ...completeDeployment,
      funding: {
        ...completeDeployment.funding,
        starknet_privacy: {
          ...completeDeployment.funding.starknet_privacy,
          discovery_url: "/starknet-privacy-discovery",
          proving_url: "/starknet-privacy-prover-sepolia",
          paymaster_url: "/paymaster/execute-outside",
        },
      },
      proof: {
        ...completeDeployment.proof,
        native_tx_prover_url: "/starknet-privacy-prover-sepolia",
      },
    };

    expect(selectedDepositFundingRail(rewriteDeployment)).toMatchObject({
      discoveryUrl: "/starknet-privacy-discovery",
      provingUrl: "/starknet-privacy-prover-sepolia",
      paymasterUrl: "/paymaster/execute-outside",
    });
    expect(strk20WithdrawalEnabledForDeployment(rewriteDeployment)).toBe(true);
    expect(noteConsolidationEnabledForDeployment(rewriteDeployment)).toBe(true);

    expect(() =>
      selectedDepositFundingRail({
        ...rewriteDeployment,
        funding: {
          ...rewriteDeployment.funding,
          starknet_privacy: {
            ...rewriteDeployment.funding.starknet_privacy,
            proving_url: "//privacy-prover.example",
          },
        },
      })
    ).toThrow("Private deposit funding is not fully configured");
  });

  it("honors a matching funding-level shielded adapter alias", () => {
    expect(
      selectedDepositFundingRail({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            shielded_asset_adapter: "0x456",
          },
        },
      })
    ).toMatchObject({
      bridgeAdapter: "0x456",
      shieldedAssetAdapter: "0x456",
    });
  });

  it("enables STRK20 withdrawals for complete private funding deployments", () => {
    expect(strk20WithdrawalEnabledForDeployment(completeDeployment)).toBe(true);
    expect(
      strk20WithdrawalEnabledForDeployment({
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
    expect(
      strk20WithdrawalEnabledForDeployment({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            proving_ohttp_enabled: false,
          },
        },
      })
    ).toBe(false);
    expect(
      strk20WithdrawalEnabledForDeployment({
        ...completeDeployment,
        contracts: {
          ...completeDeployment.contracts,
          shielded_asset_adapter: "0x0",
        },
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            bridge_adapter: "0x0",
          },
        },
      })
    ).toBe(false);
    expect(
      strk20WithdrawalEnabledForDeployment({
        ...completeDeployment,
        funding: {
          ...completeDeployment.funding,
          starknet_privacy: {
            ...completeDeployment.funding.starknet_privacy,
            discovery_url: "http://35.192.48.142:8080",
          },
        },
      },
        { allowLocalServiceUrls: false },
      )
    ).toBe(false);
  });

  it("enables note consolidation from complete private funding and proof config", () => {
    expect(noteConsolidationEnabledForDeployment(completeDeployment)).toBe(
      true,
    );
    expect(
      noteConsolidationEnabledForDeployment({
        ...completeDeployment,
        proof: {
          ...completeDeployment.proof,
          note_consolidation_statement_program_address: "",
        },
      })
    ).toBe(false);
    expect(
      noteConsolidationEnabledForDeployment({
        ...completeDeployment,
        proof: {
          ...completeDeployment.proof,
          native_tx_prover_ohttp_enabled: false,
        },
      })
    ).toBe(false);
    expect(
      noteConsolidationEnabledForDeployment({
        ...completeDeployment,
        contracts: {
          ...completeDeployment.contracts,
          auction_verifier: "0x0",
        },
      })
    ).toBe(false);
    expect(
      noteConsolidationEnabledForDeployment({
        ...completeDeployment,
        proof: {
          ...completeDeployment.proof,
          native_tx_prover_url: "http://34.29.249.119:3000",
        },
      },
        { allowLocalServiceUrls: false },
      )
    ).toBe(false);
  });
});
