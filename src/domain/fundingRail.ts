import { normalizeConfiguredFelt } from "./felt";

export type FundingDeploymentConfig = {
  token_addresses?: Record<string, string>;
  proof?: {
    native_tx_prover_url?: string;
    native_tx_prover_ohttp_enabled?: boolean;
    note_consolidation_statement_program_address?: string;
  };
  contracts?: {
    auction_verifier?: string;
    shielded_asset_adapter?: string;
  };
  funding?: {
    primary?: "starknet_privacy" | string;
    assets?: Record<
      string,
      {
        token_address?: string;
        rail_token_address?: string;
      }
    >;
    starknet_privacy?: {
      privacy_pool?: string;
      bridge_adapter?: string;
      shielded_asset_adapter?: string;
      discovery_url?: string;
      proving_url?: string;
      proving_ohttp_enabled?: boolean;
      paymaster_address?: string;
      paymaster_url?: string;
      proof_signer_class_hash?: string;
      sdk_package?: string;
      sdk_version?: string;
      min_proving_delay_blocks?: number;
    };
  };
  product?: {
    assets?: Record<
      string,
      {
        token_address?: string;
      }
    >;
  };
};

export type DepositFundingRail = {
  kind: "starknet_privacy";
  privacyPool?: string;
  bridgeAdapter?: string;
  discoveryUrl?: string;
  provingUrl?: string;
  provingOhttpEnabled?: boolean;
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

type FundingRailValidationOptions = {
  allowLocalServiceUrls?: boolean;
};

export function selectedDepositFundingRail(
  deployment: FundingDeploymentConfig,
  options: FundingRailValidationOptions = {},
): DepositFundingRail {
  const primary = deployment.funding?.primary;
  if (primary !== "starknet_privacy") {
    throw new Error(`Unsupported funding configuration: ${primary || "missing"}`);
  }
  const selected: DepositFundingRail = {
    kind: "starknet_privacy",
    privacyPool: deployment.funding?.starknet_privacy?.privacy_pool,
    bridgeAdapter: deployment.funding?.starknet_privacy?.bridge_adapter,
    discoveryUrl: deployment.funding?.starknet_privacy?.discovery_url,
    provingUrl: deployment.funding?.starknet_privacy?.proving_url,
    provingOhttpEnabled:
      deployment.funding?.starknet_privacy?.proving_ohttp_enabled,
    paymasterAddress: deployment.funding?.starknet_privacy?.paymaster_address,
    paymasterUrl: deployment.funding?.starknet_privacy?.paymaster_url,
    privacyProofSignerClassHash:
      deployment.funding?.starknet_privacy?.proof_signer_class_hash,
    sdkPackage: deployment.funding?.starknet_privacy?.sdk_package,
    sdkVersion: deployment.funding?.starknet_privacy?.sdk_version,
    minProvingDelayBlocks:
      deployment.funding?.starknet_privacy?.min_proving_delay_blocks,
    shieldedAssetAdapter: configuredShieldedAssetAdapter(deployment),
  };
  const bridgeAdapter = configuredFelt(selected.bridgeAdapter);
  const shieldedAssetAdapter = configuredFelt(selected.shieldedAssetAdapter);
  if (
    configuredFelt(selected.privacyPool) &&
    bridgeAdapter &&
    selected.discoveryUrl &&
    selected.provingUrl &&
    shieldedAssetAdapter &&
    selected.provingOhttpEnabled === true &&
    configuredFelt(selected.paymasterAddress) &&
    selected.paymasterUrl &&
    configuredFelt(selected.privacyProofSignerClassHash) &&
    bridgeAdapter === shieldedAssetAdapter &&
    configuredServiceUrl(selected.discoveryUrl, options) &&
    configuredServiceUrl(selected.provingUrl, options) &&
    configuredServiceUrl(selected.paymasterUrl, options)
  ) {
    return selected;
  }
  throw new Error("Private deposit funding is not fully configured");
}

export function fundingRailTokenAddress(
  deployment: FundingDeploymentConfig,
  assetId: string,
): string {
  const asset = assetId.trim();
  if (!asset) throw new Error("Asset ID is required");
  const topLevel = deployment.token_addresses?.[asset];
  const railToken = deployment.funding?.assets?.[asset]?.rail_token_address;
  const configured = [
    [`token_addresses.${asset}`, topLevel],
    [`funding.assets.${asset}.rail_token_address`, railToken],
    [`funding.assets.${asset}.token_address`, deployment.funding?.assets?.[asset]?.token_address],
    [`product.assets.${asset}.token_address`, deployment.product?.assets?.[asset]?.token_address],
  ] as const;
  if (!topLevel) {
    throw new Error(`${asset} token address is not configured`);
  }
  if (!railToken) {
    throw new Error(`${asset} funding rail token address is not configured`);
  }

  let canonical = "";
  for (const [label, value] of configured) {
    if (value === undefined) continue;
    const normalized = configuredFelt(value);
    if (!normalized) {
      throw new Error(`Deployment manifest field ${label} must be a nonzero Starknet address`);
    }
    canonical ||= normalized;
    if (normalized !== canonical) {
      throw new Error(`${asset} token address does not match the configured funding rail token address`);
    }
  }
  return topLevel;
}

export function strk20WithdrawalEnabledForDeployment(
  deployment: FundingDeploymentConfig,
  options: FundingRailValidationOptions = {},
) {
  if (deployment.funding?.primary !== "starknet_privacy") return false;
  const rail = deployment.funding.starknet_privacy;
  if (!rail) return false;
  const bridgeAdapter = configuredFelt(rail?.bridge_adapter);
  const shieldedAssetAdapter = configuredFelt(
    configuredShieldedAssetAdapter(deployment),
  );
  if (!bridgeAdapter || bridgeAdapter !== shieldedAssetAdapter) {
    return false;
  }
  return Boolean(
    configuredFelt(rail?.privacy_pool) &&
      rail.discovery_url &&
      rail.proving_url &&
      rail.proving_ohttp_enabled === true &&
      configuredFelt(rail.paymaster_address) &&
      rail.paymaster_url &&
      configuredFelt(rail.proof_signer_class_hash) &&
      configuredServiceUrl(rail.discovery_url, options) &&
      configuredServiceUrl(rail.proving_url, options) &&
      configuredServiceUrl(rail.paymaster_url, options)
  );
}

export function noteConsolidationEnabledForDeployment(
  deployment: FundingDeploymentConfig,
  options: FundingRailValidationOptions = {},
) {
  if (deployment.funding?.primary !== "starknet_privacy") return false;
  return Boolean(
      configuredFelt(deployment.contracts?.auction_verifier) &&
      configuredFelt(deployment.proof?.note_consolidation_statement_program_address) &&
      deployment.proof?.native_tx_prover_url &&
      deployment.proof?.native_tx_prover_ohttp_enabled === true &&
      configuredServiceUrl(deployment.proof.native_tx_prover_url, options)
  );
}

function configuredFelt(value: string | undefined | null): string {
  return normalizeConfiguredFelt(value);
}

function configuredShieldedAssetAdapter(
  deployment: FundingDeploymentConfig,
): string | undefined {
  const contractAdapter = deployment.contracts?.shielded_asset_adapter;
  const fundingAdapter =
    deployment.funding?.starknet_privacy?.shielded_asset_adapter;
  if (contractAdapter === undefined) return fundingAdapter;
  if (fundingAdapter === undefined) return contractAdapter;
  const normalizedContract = configuredFelt(contractAdapter);
  const normalizedFunding = configuredFelt(fundingAdapter);
  if (!normalizedContract || !normalizedFunding) return "";
  return normalizedContract === normalizedFunding ? contractAdapter : "";
}

function configuredServiceUrl(
  value: string | undefined | null,
  options: FundingRailValidationOptions,
): string {
  if (!value?.trim()) return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:") return trimmed;
    if (
      parsed.protocol === "http:" &&
      localServiceUrlsAllowed(options) &&
      isLocalServiceHost(parsed.hostname)
    ) {
      return trimmed;
    }
    return "";
  } catch {
    return "";
  }
}

function localServiceUrlsAllowed(options: FundingRailValidationOptions): boolean {
  return options.allowLocalServiceUrls ?? import.meta.env.DEV === true;
}

function isLocalServiceHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
