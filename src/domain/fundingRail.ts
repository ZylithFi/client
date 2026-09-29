import type { DeploymentConfig } from "./deployment";
import { normalizeConfiguredFelt } from "./felt";

export type FundingDeploymentConfig = Pick<DeploymentConfig, "market_registry" | "funding">;

export type OhttpPolicy = "disabled" | "best_effort" | "required";

export type DepositFundingRail = {
  kind: "starknet_privacy";
  privacyPool?: string;
  bridgeAdapter?: string;
  discoveryUrl?: string;
  provingUrl?: string;
  provingOhttpPolicy?: OhttpPolicy;
  paymasterAddress?: string;
  paymasterUrl?: string;
  privacyProofSignerClassHash?: string;
  sdkPackage?: string;
  sdkVersion?: string;
  minProvingDelayBlocks?: number;
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
    provingOhttpPolicy:
      deployment.funding?.starknet_privacy?.proving_ohttp_policy,
    paymasterAddress: deployment.funding?.starknet_privacy?.paymaster_address,
    paymasterUrl: deployment.funding?.starknet_privacy?.paymaster_url,
    privacyProofSignerClassHash:
      deployment.funding?.starknet_privacy?.proof_signer_class_hash,
    sdkPackage: deployment.funding?.starknet_privacy?.sdk_package,
    sdkVersion: deployment.funding?.starknet_privacy?.sdk_version,
    minProvingDelayBlocks:
      deployment.funding?.starknet_privacy?.min_proving_delay_blocks,
  };
  if (
    configuredFelt(selected.privacyPool) &&
    configuredFelt(selected.bridgeAdapter) &&
    selected.discoveryUrl &&
    selected.provingUrl &&
    validOhttpPolicy(selected.provingOhttpPolicy) &&
    configuredFelt(selected.paymasterAddress) &&
    selected.paymasterUrl &&
    configuredFelt(selected.privacyProofSignerClassHash) &&
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
  const registryAsset = deployment.market_registry.assets.find((candidate) => candidate.asset_id === asset);
  if (!registryAsset) {
    throw new Error(`${asset} token address is not configured`);
  }
  if (!registryAsset.enabled || !registryAsset.funding_enabled) {
    throw new Error(`${asset} is not enabled for funding`);
  }
  if (!configuredFelt(registryAsset.token_address)) {
    throw new Error(`Market registry asset ${asset} must have a nonzero Starknet address`);
  }
  return registryAsset.token_address;
}

export function strk20WithdrawalEnabledForDeployment(
  deployment: FundingDeploymentConfig,
  options: FundingRailValidationOptions = {},
) {
  if (deployment.funding?.primary !== "starknet_privacy") return false;
  const rail = deployment.funding.starknet_privacy;
  if (!rail) return false;
  return Boolean(
    configuredFelt(rail.bridge_adapter) &&
    configuredFelt(rail.privacy_pool) &&
      rail.discovery_url &&
      rail.proving_url &&
      validOhttpPolicy(rail.proving_ohttp_policy) &&
      configuredFelt(rail.paymaster_address) &&
      rail.paymaster_url &&
      configuredFelt(rail.proof_signer_class_hash) &&
      configuredServiceUrl(rail.discovery_url, options) &&
      configuredServiceUrl(rail.proving_url, options) &&
      configuredServiceUrl(rail.paymaster_url, options)
  );
}

function validOhttpPolicy(value: unknown): value is OhttpPolicy {
  return value === "disabled" || value === "best_effort" || value === "required";
}

function configuredFelt(value: string | undefined | null): string {
  return normalizeConfiguredFelt(value);
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
