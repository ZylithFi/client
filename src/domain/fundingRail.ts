import { normalizeFeltForComparison } from "./felt";

export type FundingDeploymentConfig = {
  proof?: {
    native_tx_prover_url?: string;
    note_consolidation_statement_program_address?: string;
  };
  contracts?: {
    auction_verifier?: string;
    shielded_asset_adapter?: string;
    privacy_deposit_bridge?: string;
  };
  funding?: {
    primary?: "starknet_privacy" | string;
    capabilities?: {
      private_withdrawals?: boolean;
      private_transfers?: boolean;
    };
    starknet_privacy?: {
      privacy_pool?: string;
      bridge_adapter?: string;
      discovery_url?: string;
      proving_url?: string;
      paymaster_address?: string;
      paymaster_url?: string;
      proof_signer_class_hash?: string;
      shielded_asset_adapter?: string;
      sdk_package?: string;
      sdk_version?: string;
      min_proving_delay_blocks?: number;
    };
  };
};

export type DepositFundingRail = {
  kind: "starknet_privacy";
  privacyPool?: string;
  bridgeAdapter?: string;
  discoveryUrl?: string;
  provingUrl?: string;
  paymasterAddress?: string;
  paymasterUrl?: string;
  privacyProofSignerClassHash?: string;
  sdkPackage?: string;
  sdkVersion?: string;
  minProvingDelayBlocks?: number;
  shieldedAssetAdapter?: string;
};

export type StarknetPrivacyDepositFundingRail = Extract<
  DepositFundingRail,
  { kind: "starknet_privacy" }
>;

export function selectedDepositFundingRail(
  deployment: FundingDeploymentConfig,
): DepositFundingRail {
  const primary = deployment.funding?.primary || "starknet_privacy";
  if (primary !== "starknet_privacy") {
    throw new Error(`Unsupported funding configuration: ${primary}`);
  }
  const selected: DepositFundingRail = {
    kind: "starknet_privacy",
    privacyPool: deployment.funding?.starknet_privacy?.privacy_pool,
    bridgeAdapter:
      deployment.funding?.starknet_privacy?.bridge_adapter ||
      deployment.contracts?.privacy_deposit_bridge,
    discoveryUrl: deployment.funding?.starknet_privacy?.discovery_url,
    provingUrl: deployment.funding?.starknet_privacy?.proving_url,
    paymasterAddress: deployment.funding?.starknet_privacy?.paymaster_address,
    paymasterUrl: deployment.funding?.starknet_privacy?.paymaster_url,
    privacyProofSignerClassHash:
      deployment.funding?.starknet_privacy?.proof_signer_class_hash,
    sdkPackage: deployment.funding?.starknet_privacy?.sdk_package,
    sdkVersion: deployment.funding?.starknet_privacy?.sdk_version,
    minProvingDelayBlocks:
      deployment.funding?.starknet_privacy?.min_proving_delay_blocks,
    shieldedAssetAdapter:
      deployment.funding?.starknet_privacy?.shielded_asset_adapter ||
      deployment.contracts?.shielded_asset_adapter,
  };
  if (
    selected.privacyPool &&
    selected.bridgeAdapter &&
    selected.discoveryUrl &&
    selected.provingUrl &&
    selected.shieldedAssetAdapter &&
    selected.privacyProofSignerClassHash &&
    normalizeFeltForComparison(selected.bridgeAdapter) ===
      normalizeFeltForComparison(selected.shieldedAssetAdapter)
  ) {
    return selected;
  }
  throw new Error("Private deposit funding is not fully configured");
}

export function hostedWithdrawalEnabledForDeployment(
  deployment: FundingDeploymentConfig,
) {
  if (deployment.funding?.primary !== "starknet_privacy") return false;
  if (deployment.funding?.capabilities?.private_withdrawals !== true) {
    return false;
  }
  const rail = deployment.funding.starknet_privacy;
  const bridgeAdapter =
    rail?.bridge_adapter || deployment.contracts?.privacy_deposit_bridge;
  const shieldedAssetAdapter =
    rail?.shielded_asset_adapter || deployment.contracts?.shielded_asset_adapter;
  if (
    normalizeFeltForComparison(bridgeAdapter) !==
    normalizeFeltForComparison(shieldedAssetAdapter)
  ) {
    return false;
  }
  return Boolean(
    rail?.privacy_pool &&
      bridgeAdapter &&
      shieldedAssetAdapter &&
      rail.discovery_url &&
      rail.proving_url &&
      rail.paymaster_address &&
      rail.paymaster_url &&
      rail.proof_signer_class_hash
  );
}

export function hostedNoteConsolidationEnabledForDeployment(
  deployment: FundingDeploymentConfig,
) {
  if (deployment.funding?.primary !== "starknet_privacy") return false;
  if (
    deployment.funding?.capabilities?.private_withdrawals !== true &&
    deployment.funding?.capabilities?.private_transfers !== true
  ) {
    return false;
  }
  return Boolean(
    deployment.contracts?.auction_verifier &&
      deployment.proof?.note_consolidation_statement_program_address &&
      deployment.proof?.native_tx_prover_url
  );
}
