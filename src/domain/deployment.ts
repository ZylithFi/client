import { useEffect, useState } from "react";
import { ZylithExchangeClient, readSdkJsonResponse } from "@zylith/sdk";
import { normalizeConfiguredFelt } from "./felt";
import { fetchWithTimeout } from "./runtimeHttp";
import { browserSafeServiceUrl, localServiceUrl, normalizeUrl } from "./serviceUrls";

export type PairConfig = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  min_order_amount: string;
  min_order_quote_amount: string;
  price_base_scale: string;
  taker_fee_bps: number;
  external_match_enabled: boolean;
  external_settlement_support_quote: string;
  enabled: boolean;
  reference_price_methodology?: RegistryMarketConfig["reference_price"]["methodology"];
  reference_max_age_ms?: number;
  reference_attestation_ttl_ms?: number;
};

export type RegistryMarketConfig = {
  market_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  min_order_amount: string;
  min_order_quote_amount: string;
  price_base_scale: string;
  taker_fee_bps: number;
  capabilities: {
    market_data: boolean;
    external_matching: boolean;
  };
  external_settlement_support_quote: string;
  external_min_profit_quote: string;
  enabled: boolean;
  reference_price: {
    methodology: "direct_bbo_midpoint";
    primary: RegistryVenueObservation;
    corroborating: RegistryVenueObservation[];
    min_sources: number;
    max_age_ms: number;
    max_source_spread_bps: number;
    max_cross_source_deviation_bps: number;
    envelope_bps: number;
    attestation_ttl_ms: number;
  } | {
    methodology: "synthetic_cross_bbo_midpoint";
    base_market_id: string;
    quote_market_id: string;
    max_leg_skew_ms: number;
    max_age_ms: number;
    envelope_bps: number;
    attestation_ttl_ms: number;
  };
};

type RegistryVenueObservation =
  | { kind: "direct"; adapter: "binance" | "coinbase" | "kraken" | "okx"; symbol: string }
  | { kind: "same_venue_ratio"; adapter: "binance" | "coinbase" | "kraken" | "okx"; base_symbol: string; quote_symbol: string };

export type MarketAssetConfig = {
  asset_id: string;
  token_address: string;
  decimals: number;
  min_trade_amount: string;
  erc20_behavior: string;
  enabled: boolean;
  funding_enabled: boolean;
  reference_identity: {
    reference_asset_id: string;
    relationship: "native" | "wrapped_one_to_one" | "stable_one_to_one";
  };
};

export type DeploymentConfig = {
  deployment: {
    finalized: boolean;
    release_commit: string;
  };
  network: string;
  chain_id: string;
  rpc_url: string;
  contracts: {
    commitment_registry: string;
    privacy_deposit_bridge: string;
    ekubo_external_match_router: string;
    exchange: string;
  };
  market_registry: {
    schema_version: number;
    registry_version: number;
    registry_hash: string;
    network: string;
    chain_id: string;
    gas_fee_asset_id: string;
    objective_numeraire_asset_id: string;
    assets: MarketAssetConfig[];
    markets: RegistryMarketConfig[];
  };
  funding: {
    primary: "starknet_privacy" | string;
    starknet_privacy?: {
      privacy_pool?: string;
      privacy_pool_class_hash?: string;
      bridge_adapter?: string;
      proving_url?: string;
      proving_ohttp_policy?: "disabled" | "best_effort" | "required";
      paymaster_address?: string;
      paymaster_url?: string;
      proof_signer_class_hash?: string;
      /** the execution key registries a wallet may seal to: the current and, in a rotation, the next. */
      ingress_key_registry_fingerprint?: string;
      ingress_key_registry_next_fingerprint?: string;
      sdk_package?: string;
      sdk_version?: string;
      min_proving_delay_blocks?: number;
    };
  };
  proof: {
    scheme: "snip36-stwo";
    proof_version: string;
    transition_proof_program_address: string;
    withdrawal_proof_program_address: string;
    residual_recovery_proof_program_address: string;
    virtual_program_hash: string;
    starknet_os_config_hash: string;
    proof_account_address: string;
    settlement_account_address: string;
    proof_validity_blocks: number;
    config_locked_after_deploy: boolean;
    prover_build_id: string;
  };
  roles: {
    protocol_fee_recipient: string;
    pause_guardian_address: string;
    reference_price_signer: string;
  };
  runtime: {
    epoch_ms: number;
    max_close_delay_ms: number;
    withdrawal_delay_seconds: number;
    external_window_seconds: number;
    max_book_orders: number;
    max_admissions_per_transition: number;
    max_internal_deferral_epochs: number;
  };
};

const DEPLOYMENT_MANIFEST_TIMEOUT_MS = 10_000;
const MAX_U128 = (1n << 128n) - 1n;
const REQUIRED_FIELDS = ["deployment", "network", "chain_id", "rpc_url", "contracts", "market_registry", "funding", "proof", "roles", "runtime"] as const;
const REQUIRED_CONTRACTS = ["commitment_registry", "privacy_deposit_bridge", "exchange"] as const;

export const OPERATOR_URL = serviceUrl(import.meta.env.VITE_ZYLITH_OPERATOR_URL, 3200, "operator");
export const INDEXER_URL = serviceUrl(import.meta.env.VITE_ZYLITH_INDEXER_URL, 3300, "indexer");
/** wallet vaults and encrypted recovery snapshots. */
export const BACKUP_URL = serviceUrl(import.meta.env.VITE_ZYLITH_COORDINATOR_URL, 3000, "coordinator");

function serviceUrl(configured: unknown, port: number, path: string) {
  return normalizeUrl(browserSafeServiceUrl(normalizeUrl(configured) || localServiceUrl(port, path), path));
}

/** the sdk takes absolute urls; same-origin service paths resolve against the page. */
function absolute(url: string) {
  if (typeof window === "undefined" || /^https?:\/\//i.test(url)) return url;
  return new URL(url, window.location.origin).toString().replace(/\/+$/, "");
}

let exchangeClient: ZylithExchangeClient | null = null;

export function exchange(): ZylithExchangeClient {
  exchangeClient ??= new ZylithExchangeClient({ operatorUrl: absolute(OPERATOR_URL), indexerUrl: absolute(INDEXER_URL) });
  return exchangeClient;
}

export function assertDeploymentManifest(value: unknown): asserts value is DeploymentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deployment manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowedFields = new Set(REQUIRED_FIELDS);
  for (const field of Object.keys(record)) {
    if (!allowedFields.has(field as (typeof REQUIRED_FIELDS)[number])) {
      throw new Error(`Deployment manifest contains obsolete or unknown field ${field}`);
    }
  }
  for (const field of REQUIRED_FIELDS) {
    if (record[field] === undefined || record[field] === null) {
      throw new Error(`Deployment manifest is missing ${field}`);
    }
  }
  if (!/^[a-z0-9_-]{1,32}$/.test(String(record.network)) || !normalizeConfiguredFelt(record.chain_id)) {
    throw new Error("Deployment manifest network identity is malformed");
  }
  if (!validHttpsUrl(record.rpc_url)) {
    throw new Error("Deployment manifest RPC URL must use HTTPS");
  }
  const contracts = record.contracts as Record<string, unknown>;
  for (const contract of REQUIRED_CONTRACTS) {
    if (!normalizeConfiguredFelt(contracts?.[contract])) {
      throw new Error(`Deployment manifest contract ${contract} must be a nonzero address`);
    }
  }
  const deployment = record.deployment as Record<string, unknown>;
  if (deployment.finalized !== true || !/^[0-9a-f]{40}$/.test(String(deployment.release_commit ?? "")) || /^0+$/.test(String(deployment.release_commit))) {
    throw new Error("Deployment manifest is not a finalized release");
  }
  const proof = record.proof as Record<string, unknown>;
  if (
    proof.config_locked_after_deploy !== true
    || proof.scheme !== "snip36-stwo"
    || !validProofVersion(proof.proof_version)
    || !Number.isSafeInteger(proof.proof_validity_blocks)
    || (proof.proof_validity_blocks as number) < 1
    || (proof.proof_validity_blocks as number) > 100_000
    || !/^[A-Za-z0-9._+-]{1,128}$/.test(String(proof.prover_build_id ?? ""))
  ) {
    throw new Error("Deployment manifest proof configuration is not locked");
  }
  for (const field of ["transition_proof_program_address", "withdrawal_proof_program_address", "residual_recovery_proof_program_address", "virtual_program_hash", "starknet_os_config_hash", "proof_account_address", "settlement_account_address"]) {
    if (!normalizeConfiguredFelt(proof[field])) {
      throw new Error(`Deployment manifest proof ${field} must be a nonzero felt`);
    }
  }
  const roles = record.roles as Record<string, unknown>;
  for (const field of ["protocol_fee_recipient", "pause_guardian_address", "reference_price_signer"]) {
    if (!normalizeConfiguredFelt(roles[field])) {
      throw new Error(`Deployment manifest role ${field} must be a nonzero felt`);
    }
  }
  const registry = record.market_registry as DeploymentConfig["market_registry"];
  assertMarketRegistry(registry, String(record.network), String(record.chain_id));
  const funding = record.funding as DeploymentConfig["funding"];
  if (funding.primary !== "starknet_privacy" || funding.starknet_privacy?.proving_ohttp_policy !== "best_effort") {
    throw new Error("Production funding must use best-effort OHTTP");
  }
  const rail = funding.starknet_privacy;
  if (
    !rail
    || !normalizeConfiguredFelt(rail.privacy_pool)
    || !normalizeConfiguredFelt(rail.privacy_pool_class_hash)
    || normalizeConfiguredFelt(rail.bridge_adapter) !== normalizeConfiguredFelt(contracts.privacy_deposit_bridge)
    || !normalizeConfiguredFelt(rail.paymaster_address)
    || !normalizeConfiguredFelt(rail.proof_signer_class_hash)
    || !validServiceUrl(rail.proving_url)
    || !validServiceUrl(rail.paymaster_url)
    || rail.sdk_package !== "@starkware-libs/starknet-privacy-sdk"
    || rail.sdk_version !== "0.14.3-rc.7"
    || !Number.isSafeInteger(rail.min_proving_delay_blocks)
    || (rail.min_proving_delay_blocks ?? 0) < 1
    || pinnedRegistryFingerprints({ funding }).length === 0
  ) throw new Error("Deployment manifest private funding configuration is malformed");
  for (const pair of registry.markets) {
    const support = pair.external_settlement_support_quote;
    const profit = pair.external_min_profit_quote;
    if (!validU128Decimal(support) || !validU128Decimal(profit) || pair.capabilities.external_matching !== (BigInt(support) > 0n && BigInt(profit) > 0n)) {
      throw new Error(`Deployment manifest market ${pair.market_id} has inconsistent external matching configuration`);
    }
    if (!pair.enabled && pair.capabilities.external_matching) {
      throw new Error(`Deployment manifest disabled market ${pair.market_id} cannot enable external matching`);
    }
  }
  const runtime = record.runtime as Record<string, unknown>;
  if (
    !Number.isSafeInteger(runtime?.epoch_ms)
    || (runtime.epoch_ms as number) < 1_000
    || (runtime.epoch_ms as number) > 300_000
    || !Number.isSafeInteger(runtime.max_close_delay_ms)
    || (runtime.max_close_delay_ms as number) <= 0
    || !Number.isSafeInteger(runtime.withdrawal_delay_seconds)
    || (runtime.withdrawal_delay_seconds as number) <= 0
    || !Number.isSafeInteger(runtime.max_book_orders)
    || (runtime.max_book_orders as number) < 1
    || (runtime.max_book_orders as number) > 1_024
    || !Number.isSafeInteger(runtime.max_admissions_per_transition)
    || (runtime.max_admissions_per_transition as number) < 1
    || (runtime.max_admissions_per_transition as number) > (runtime.max_book_orders as number)
    || !Number.isSafeInteger(runtime.max_internal_deferral_epochs)
    || (runtime.max_internal_deferral_epochs as number) < 1
  ) {
    throw new Error("Deployment manifest runtime is malformed");
  }
  // a pair routed to ekubo needs the router and a window in which a fill can land.
  const routed = registry.markets.filter((pair) => pair.enabled && pair.capabilities.external_matching);
  if (routed.length > 0) {
    if (!normalizeConfiguredFelt(contracts?.ekubo_external_match_router)) {
      throw new Error("Deployment manifest enables external matching without an external match router");
    }
    if (!Number.isSafeInteger(runtime.external_window_seconds) || (runtime.external_window_seconds as number) <= 0) {
      throw new Error("Deployment manifest enables external matching without an external window");
    }
  } else if (runtime.external_window_seconds !== 0) {
    throw new Error("Deployment manifest configures an external window without external matching");
  }
  if ((runtime.external_window_seconds as number) > 300) {
    throw new Error("Deployment manifest external window is too long");
  }
  assertBrowserNetworkPolicy(record as DeploymentConfig);
}

/** keeps manifest-selected browser traffic inside the production csp boundary. */
export function assertBrowserNetworkPolicy(
  deployment: Pick<DeploymentConfig, "rpc_url" | "funding">,
  pageUrl = typeof window === "undefined" ? "" : window.location.href,
): void {
  if (!pageUrl) return;
  const page = new URL(pageUrl);
  if (page.hostname !== "app.zylith.fi") return;
  const allowedOrigins = new Set([page.origin, "https://api.zylith.fi"]);
  const rail = deployment.funding.starknet_privacy;
  const endpoints = [
    deployment.rpc_url,
    rail?.proving_url,
    rail?.paymaster_url,
  ];
  for (const endpoint of endpoints) {
    if (typeof endpoint !== "string") continue;
    const resolved = new URL(endpoint, page.origin);
    if (!allowedOrigins.has(resolved.origin)) {
      throw new Error(`Deployment manifest browser network policy rejects ${resolved.origin}`);
    }
  }
}

function validProofVersion(value: unknown): boolean {
  return (typeof value === "string" && /^PROOF[1-9][0-9]{0,3}$/.test(value))
    || Boolean(normalizeConfiguredFelt(value));
}

function validHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validServiceUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (validHttpsUrl(value)) return true;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return false;
  try {
    const base = "https://zylith.invalid";
    const parsed = new URL(value, base);
    return parsed.origin === base && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function assertMarketRegistry(registry: DeploymentConfig["market_registry"], network: string, chainId: string): void {
  if (!registry || registry.schema_version !== 1 || !Number.isSafeInteger(registry.registry_version) || registry.registry_version <= 0) {
    throw new Error("Deployment manifest market registry identity is malformed");
  }
  if (!/^[a-z0-9_-]{1,32}$/.test(registry.network) || !/^[0-9a-f]{64}$/.test(registry.registry_hash) || registry.network !== network || registry.chain_id !== chainId) {
    throw new Error("Deployment manifest and market registry identities differ");
  }
  if (
    !Array.isArray(registry.assets)
    || !Array.isArray(registry.markets)
    || registry.assets.length === 0
    || registry.assets.length > 8
    || registry.markets.length === 0
    || registry.markets.length > 8
  ) {
    throw new Error("Deployment manifest market registry size is invalid");
  }
  const assetIds = registry.assets.map((asset) => asset.asset_id);
  const marketIds = registry.markets.map((market) => market.market_id);
  if (!strictlySortedUnique(assetIds) || !strictlySortedUnique(marketIds)) {
    throw new Error("Deployment manifest market registry identifiers must be sorted and unique");
  }
  const assets = new Map(registry.assets.map((asset) => [asset.asset_id, asset]));
  const tokens = new Set<string>();
  for (const asset of registry.assets) {
    if (!validRegistryIdentifier(asset.asset_id)) throw new Error(`Deployment manifest asset ${asset.asset_id} has an invalid identifier`);
    const token = normalizeConfiguredFelt(asset.token_address);
    if (!token || tokens.has(token) || !Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36 || !validU128Decimal(asset.min_trade_amount, true) || asset.erc20_behavior !== "vanilla_exact_delta") {
      throw new Error(`Deployment manifest asset ${asset.asset_id} is malformed or duplicated`);
    }
    tokens.add(token);
    if (asset.enabled && !asset.funding_enabled) throw new Error(`Deployment manifest asset ${asset.asset_id} is not fundable`);
    if (!asset.enabled && asset.funding_enabled) throw new Error(`Deployment manifest disabled asset ${asset.asset_id} cannot enable funding`);
    const relationship = asset.reference_identity?.relationship;
    const native = relationship === "native";
    if (!asset.reference_identity?.reference_asset_id || !validRegistryIdentifier(asset.reference_identity.reference_asset_id) || !["native", "wrapped_one_to_one", "stable_one_to_one"].includes(relationship) || native !== (asset.reference_identity.reference_asset_id === asset.asset_id)) {
      throw new Error(`Deployment manifest asset ${asset.asset_id} has an invalid reference identity`);
    }
  }
  if (!assets.get(registry.gas_fee_asset_id)?.enabled || !assets.get(registry.objective_numeraire_asset_id)?.enabled) {
    throw new Error("Deployment manifest market registry has invalid gas or numeraire assets");
  }
  for (const market of registry.markets) {
    const base = assets.get(market.base_asset_id);
    const quote = assets.get(market.quote_asset_id);
    if (!base || !quote || !validRegistryIdentifier(market.market_id) || market.market_id !== `${market.base_asset_id}/${market.quote_asset_id}` || !validU128Decimal(market.price_base_scale, true) || !validU128Decimal(market.min_order_amount, true) || !validU128Decimal(market.min_order_quote_amount, true) || BigInt(market.min_order_amount) < BigInt(base.min_trade_amount) || BigInt(market.min_order_quote_amount) < BigInt(quote.min_trade_amount) || !Number.isSafeInteger(market.taker_fee_bps) || market.taker_fee_bps < 1 || market.taker_fee_bps > 100 || (market.enabled && (!base.enabled || !quote.enabled || market.capabilities.market_data !== true))) {
      throw new Error(`Deployment manifest market ${market.market_id || "?"} is malformed`);
    }
    assertReferencePrice(market, registry);
  }
  for (const asset of registry.assets.filter((candidate) => candidate.enabled)) {
    if (!registry.markets.some((market) => market.enabled && (market.base_asset_id === asset.asset_id || market.quote_asset_id === asset.asset_id))) {
      throw new Error(`Deployment manifest enabled asset ${asset.asset_id} is unused`);
    }
    const directNumeraireMarkets = registry.markets.filter((market) => market.enabled && ((market.base_asset_id === asset.asset_id && market.quote_asset_id === registry.objective_numeraire_asset_id) || (market.quote_asset_id === asset.asset_id && market.base_asset_id === registry.objective_numeraire_asset_id))).length;
    if (asset.asset_id !== registry.objective_numeraire_asset_id && directNumeraireMarkets !== 1) {
      throw new Error(`Deployment manifest asset ${asset.asset_id} must have exactly one direct numeraire market`);
    }
  }
}

function assertReferencePrice(market: RegistryMarketConfig, registry: DeploymentConfig["market_registry"]): void {
  const reference = market.reference_price;
  if (!reference || !Number.isSafeInteger(reference.max_age_ms) || reference.max_age_ms < 1 || reference.max_age_ms > 15_000 || !Number.isSafeInteger(reference.attestation_ttl_ms) || reference.attestation_ttl_ms < 1 || reference.attestation_ttl_ms > 15_000 || !validBps(reference.envelope_bps)) {
    throw new Error(`Deployment manifest market ${market.market_id} has invalid reference pricing`);
  }
  if (reference.methodology === "synthetic_cross_bbo_midpoint") {
    const base = registry.markets.find((candidate) => candidate.market_id === reference.base_market_id);
    const quote = registry.markets.find((candidate) => candidate.market_id === reference.quote_market_id);
    if (!base?.enabled || !quote?.enabled || base.reference_price.methodology !== "direct_bbo_midpoint" || quote.reference_price.methodology !== "direct_bbo_midpoint" || base.base_asset_id !== market.base_asset_id || quote.base_asset_id !== market.quote_asset_id || base.quote_asset_id !== registry.objective_numeraire_asset_id || quote.quote_asset_id !== registry.objective_numeraire_asset_id || base.price_base_scale !== market.price_base_scale || quote.price_base_scale !== market.price_base_scale || reference.base_market_id === reference.quote_market_id || !Number.isSafeInteger(reference.max_leg_skew_ms) || reference.max_leg_skew_ms < 1 || reference.max_leg_skew_ms > reference.max_age_ms) {
      throw new Error(`Deployment manifest market ${market.market_id} has invalid synthetic reference pricing`);
    }
    return;
  }
  if (!Array.isArray(reference.corroborating) || reference.corroborating.length > 7) {
    throw new Error(`Deployment manifest market ${market.market_id} has invalid reference pricing`);
  }
  const sources = [reference.primary, ...reference.corroborating];
  const adapters = sources.map((source) => source?.adapter);
  const validSymbol = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(value);
  const corroboratingValid = reference.corroborating.every((source) =>
    source.kind === "same_venue_ratio"
    && ["coinbase", "kraken", "okx"].includes(source.adapter)
    && validSymbol(source.base_symbol)
    && validSymbol(source.quote_symbol)
  );
  const corroboratingAdapters = new Set(reference.corroborating.map((source) => source.adapter));
  if (market.quote_asset_id !== registry.objective_numeraire_asset_id || reference.primary.kind !== "direct" || reference.primary.adapter !== "binance" || !validSymbol(reference.primary.symbol) || !corroboratingValid || !corroboratingAdapters.has("coinbase") || !corroboratingAdapters.has("kraken") || sources.length < 3 || new Set(adapters).size !== adapters.length || !Number.isSafeInteger(reference.min_sources) || reference.min_sources < 3 || reference.min_sources > sources.length || !validBps(reference.max_source_spread_bps) || !validBps(reference.max_cross_source_deviation_bps)) {
    throw new Error(`Deployment manifest market ${market.market_id} has invalid reference pricing`);
  }
}

function validBps(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < 10_000;
}

function validU128Decimal(value: unknown, nonzero = false): value is string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,38})$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed <= MAX_U128 && (!nonzero || parsed > 0n);
}

function validRegistryIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_\/-]{1,64}$/.test(value);
}

function strictlySortedUnique(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

export async function verifyMarketRegistryHash(deployment: DeploymentConfig): Promise<void> {
  const registry = { ...deployment.market_registry } as Record<string, unknown>;
  const declared = String(registry.registry_hash);
  delete registry.registry_hash;
  const bytes = new TextEncoder().encode(canonicalJson(registry));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const computed = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (computed !== declared) throw new Error("Deployment manifest market registry hash mismatch");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Market registry contains a non-JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

/** the registry fingerprints the deployed manifest pins; placeholders pin nothing. */
export function pinnedRegistryFingerprints(deployment: Pick<DeploymentConfig, "funding">): string[] {
  const rail = deployment.funding.starknet_privacy;
  return [rail?.ingress_key_registry_fingerprint, rail?.ingress_key_registry_next_fingerprint]
    .map((fingerprint) => (fingerprint ?? "").trim().toLowerCase())
    .filter((fingerprint) => /^[0-9a-f]{64}$/.test(fingerprint) && /[1-9a-f]/.test(fingerprint));
}

/**
 * the operator serves the execution keys, so a compromised operator api or proxy could swap in
 * its own and read every sealed order. the wallet seals only to a registry the manifest, shipped
 * with the app, pins; anything else fails closed.
 */
export function assertPinnedExecutionKeys(fingerprint: string, deployment: Pick<DeploymentConfig, "funding">) {
  const pinned = pinnedRegistryFingerprints(deployment);
  if (pinned.length === 0) throw new Error("This deployment pins no execution keys. Private requests are disabled.");
  if (!pinned.includes(fingerprint.trim().toLowerCase())) {
    throw new Error("The operator's execution keys do not match this deployment. Private requests are disabled.");
  }
}

let deploymentPromise: Promise<DeploymentConfig> | null = null;

export function loadDeployment(): Promise<DeploymentConfig> {
  deploymentPromise ??= requestDeployment().catch((error: unknown) => {
    deploymentPromise = null;
    throw error;
  });
  return deploymentPromise;
}

async function requestDeployment(): Promise<DeploymentConfig> {
  let response: Response;
  try {
    response = await fetchWithTimeout("/deployment.json", { headers: { accept: "application/json" } }, DEPLOYMENT_MANIFEST_TIMEOUT_MS);
  } catch {
    throw new Error("Deployment manifest is unavailable. Check your connection and retry.");
  }
  if (!response.ok) {
    throw new Error(`Deployment manifest request failed with HTTP ${response.status}`);
  }
  const value = (await readSdkJsonResponse(response, {
    timeoutMs: DEPLOYMENT_MANIFEST_TIMEOUT_MS,
    label: "Deployment manifest",
  })) as Record<string, unknown>;
  const manifest = value.manifest ?? value;
  assertDeploymentManifest(manifest);
  await verifyMarketRegistryHash(manifest);
  return manifest;
}

export function enabledPairs(deployment: DeploymentConfig | null): PairConfig[] {
  const pairs = deployment
    ? deployment.market_registry.markets
        .filter((market) => market.enabled)
        .map((market) => ({
          pair_id: market.market_id,
          base_asset_id: market.base_asset_id,
          quote_asset_id: market.quote_asset_id,
          min_order_amount: market.min_order_amount,
          min_order_quote_amount: market.min_order_quote_amount,
          price_base_scale: market.price_base_scale,
          taker_fee_bps: market.taker_fee_bps,
          external_match_enabled: market.capabilities.external_matching,
          external_settlement_support_quote: market.external_settlement_support_quote,
          enabled: market.enabled,
          reference_price_methodology: market.reference_price.methodology,
          reference_max_age_ms: market.reference_price.max_age_ms,
          reference_attestation_ttl_ms: market.reference_price.attestation_ttl_ms,
        }))
    : [];
  return pairs.sort((left, right) => {
    if (left.pair_id === "STRK/USDC") return -1;
    if (right.pair_id === "STRK/USDC") return 1;
    return left.pair_id.localeCompare(right.pair_id);
  });
}

export function defaultPair(deployment: DeploymentConfig | null): PairConfig | null {
  const pairs = enabledPairs(deployment);
  return pairs.find((pair) => pair.pair_id === "STRK/USDC") ?? pairs[0] ?? null;
}

/** the registry-selected fee asset is the default funding asset when it is fundable. */
export function defaultDepositAsset(deployment: DeploymentConfig | null): string {
  if (!deployment) return "";
  const assets = deployment.market_registry.assets;
  const preferred = assets.find(
    (asset) => asset.asset_id === deployment.market_registry.gas_fee_asset_id
      && asset.enabled
      && asset.funding_enabled,
  );
  return preferred?.asset_id
    ?? assets.find((asset) => asset.enabled && asset.funding_enabled)?.asset_id
    ?? "";
}

export function useDeploymentState(): { deployment: DeploymentConfig | null; error: string | null } {
  const [state, setState] = useState<{ deployment: DeploymentConfig | null; error: string | null }>({ deployment: null, error: null });
  useEffect(() => {
    let cancelled = false;
    loadDeployment()
      .then((deployment) => !cancelled && setState({ deployment, error: null }))
      .catch((reason: unknown) => {
        if (!cancelled) setState({ deployment: null, error: reason instanceof Error ? reason.message : "Deployment configuration is unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
