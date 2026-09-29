import { describe, expect, it } from "vitest";
import shipped from "../../public/deployment.example.json";
import {
  fundingRailTokenAddress,
  selectedDepositFundingRail,
  strk20WithdrawalEnabledForDeployment,
  type FundingDeploymentConfig,
} from "./fundingRail";

function deployment(): FundingDeploymentConfig {
  const value = JSON.parse(JSON.stringify(shipped));
  value.funding.starknet_privacy = {
    ...value.funding.starknet_privacy,
    privacy_pool: "0x123",
    bridge_adapter: "0x456",
    discovery_url: "https://discovery.example",
    proving_url: "https://prover.example",
    proving_ohttp_policy: "best_effort",
    paymaster_address: "0x789",
    paymaster_url: "https://paymaster.example",
    proof_signer_class_hash: "0x999",
  };
  return value;
}

describe("fundingRail", () => {
  it("derives funding assets only from the market registry", () => {
    const value = deployment();
    expect(fundingRailTokenAddress(value, "STRK")).toBe(
      value.market_registry.assets.find((asset) => asset.asset_id === "STRK")?.token_address,
    );
    value.market_registry.assets.find((asset) => asset.asset_id === "STRK")!.funding_enabled = false;
    expect(() => fundingRailTokenAddress(value, "STRK")).toThrow("not enabled for funding");
    expect(() => fundingRailTokenAddress(value, "UNKNOWN")).toThrow("not configured");
  });

  it.each(["disabled", "best_effort", "required"] as const)(
    "accepts the explicit %s ohttp policy",
    (policy) => {
      const value = deployment();
      value.funding.starknet_privacy!.proving_ohttp_policy = policy;
      expect(selectedDepositFundingRail(value)).toMatchObject({
        kind: "starknet_privacy",
        provingOhttpPolicy: policy,
      });
      expect(strk20WithdrawalEnabledForDeployment(value)).toBe(true);
    },
  );

  it("rejects missing policy and incomplete funding services", () => {
    const missingPolicy = deployment();
    delete missingPolicy.funding.starknet_privacy!.proving_ohttp_policy;
    expect(() => selectedDepositFundingRail(missingPolicy)).toThrow("not fully configured");

    const insecure = deployment();
    insecure.funding.starknet_privacy!.proving_url = "http://198.51.100.1";
    expect(() => selectedDepositFundingRail(insecure)).toThrow("not fully configured");
    expect(strk20WithdrawalEnabledForDeployment(insecure)).toBe(false);
  });

  it("allows local urls only when explicitly requested", () => {
    const value = deployment();
    value.funding.starknet_privacy!.discovery_url = "http://localhost:8080";
    value.funding.starknet_privacy!.proving_url = "http://127.0.0.1:3000";
    value.funding.starknet_privacy!.paymaster_url = "http://[::1]:8787";
    expect(() => selectedDepositFundingRail(value, { allowLocalServiceUrls: false })).toThrow();
    expect(selectedDepositFundingRail(value, { allowLocalServiceUrls: true })).toBeTruthy();
  });
});
