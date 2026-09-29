import { useEffect, useState } from "react";
import { ZylithExchangeClient } from "@zylith/sdk";
import { normalizeConfiguredFelt } from "./felt";
import { fetchWithTimeout } from "./runtimeHttp";
import { browserSafeServiceUrl, localServiceUrl, normalizeUrl } from "./serviceUrls";

export type PairConfig = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  min_order_amount: string;
  price_base_scale: string;
  taker_fee_bps: number;
  external_match_enabled: boolean;
  external_settlement_support_quote: string;
  enabled: boolean;
};

export type RegistryMarketConfig = {
  market_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  min_order_amount: string;
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
    connected_wallet_fee_reserve_amount: string;
    objective_numeraire_asset_id: string;
    assets: MarketAssetConfig[];
    markets: RegistryMarketConfig[];
  };
  funding: {
    primary: "starknet_privacy" | string;
    starknet_privacy?: {
      privacy_pool?: string;
      bridge_adapter?: string;
      discovery_url?: string;
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
    proof_program_address: string;
    virtual_program_hash: string;
    starknet_os_config_hash: string;
    proof_account_address: string;
    settlement_account_address: string;
    config_locked_after_deploy: boolean;
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
  if (proof.config_locked_after_deploy !== true) {
    throw new Error("Deployment manifest proof configuration is not locked");
  }
  for (const field of ["proof_program_address", "virtual_program_hash", "starknet_os_config_hash", "proof_account_address", "settlement_account_address"]) {
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
  for (const pair of registry.markets) {
    const support = pair.external_settlement_support_quote;
    const profit = pair.external_min_profit_quote;
    if (!/^\d+$/.test(support ?? "") || !/^\d+$/.test(profit ?? "") || pair.capabilities.external_matching !== (BigInt(support) > 0n && BigInt(profit) > 0n)) {
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
}

function assertMarketRegistry(registry: DeploymentConfig["market_registry"], network: string, chainId: string): void {
  if (!registry || registry.schema_version !== 1 || !Number.isSafeInteger(registry.registry_version) || registry.registry_version <= 0) {
    throw new Error("Deployment manifest market registry identity is malformed");
  }
  if (!/^[a-z0-9_-]{1,32}$/.test(registry.network) || !/^[0-9a-f]{64}$/.test(registry.registry_hash) || registry.network !== network || registry.chain_id !== chainId) {
    throw new Error("Deployment manifest and market registry identities differ");
  }
  if (!Array.isArray(registry.assets) || !Array.isArray(registry.markets) || registry.assets.length === 0 || registry.markets.length === 0) {
    throw new Error("Deployment manifest market registry is empty");
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
    if (!token || tokens.has(token) || !Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36 || !/^[1-9]\d*$/.test(asset.min_trade_amount) || asset.erc20_behavior !== "vanilla_exact_delta") {
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
  if (!/^[1-9]\d*$/.test(registry.connected_wallet_fee_reserve_amount)) {
    throw new Error("Deployment manifest market registry has an invalid wallet fee reserve");
  }
  for (const market of registry.markets) {
    const base = assets.get(market.base_asset_id);
    const quote = assets.get(market.quote_asset_id);
    if (!base || !quote || !validRegistryIdentifier(market.market_id) || market.market_id !== `${market.base_asset_id}/${market.quote_asset_id}` || !/^[1-9]\d*$/.test(market.price_base_scale ?? "") || !/^[1-9]\d*$/.test(market.min_order_amount ?? "") || BigInt(market.min_order_amount) < BigInt(base.min_trade_amount) || !Number.isSafeInteger(market.taker_fee_bps) || market.taker_fee_bps < 1 || market.taker_fee_bps > 100 || (market.enabled && (!base.enabled || !quote.enabled || market.capabilities.market_data !== true))) {
      throw new Error(`Deployment manifest market ${market.market_id || "?"} is malformed`);
    }
    assertReferencePrice(market);
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

function assertReferencePrice(market: RegistryMarketConfig): void {
  const reference = market.reference_price;
  const sources = [reference?.primary, ...(reference?.corroborating ?? [])];
  const adapters = sources.map((source) => source?.adapter);
  const validSymbol = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(value);
  const corroboratingValid = (reference?.corroborating ?? []).every((source) =>
    source.kind === "same_venue_ratio"
    && ["coinbase", "kraken", "okx"].includes(source.adapter)
    && validSymbol(source.base_symbol)
    && validSymbol(source.quote_symbol)
  );
  const corroboratingAdapters = new Set((reference?.corroborating ?? []).map((source) => source.adapter));
  if (!reference || reference.methodology !== "direct_bbo_midpoint" || reference.primary?.kind !== "direct" || reference.primary.adapter !== "binance" || !validSymbol(reference.primary.symbol) || !corroboratingValid || !corroboratingAdapters.has("coinbase") || !corroboratingAdapters.has("kraken") || sources.length < 3 || new Set(adapters).size !== adapters.length || !Number.isSafeInteger(reference.min_sources) || reference.min_sources < 3 || reference.min_sources > sources.length || !Number.isSafeInteger(reference.max_age_ms) || reference.max_age_ms < 1 || reference.max_age_ms > 15_000 || !Number.isSafeInteger(reference.attestation_ttl_ms) || reference.attestation_ttl_ms < 1 || reference.attestation_ttl_ms > 15_000 || !validBps(reference.max_source_spread_bps) || !validBps(reference.max_cross_source_deviation_bps) || !validBps(reference.envelope_bps)) {
    throw new Error(`Deployment manifest market ${market.market_id} has invalid reference pricing`);
  }
}

function validBps(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < 10_000;
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
  const value = (await response.json()) as Record<string, unknown>;
  const manifest = value.manifest ?? value;
  assertDeploymentManifest(manifest);
  await verifyMarketRegistryHash(manifest);
  return manifest;
}

export function enabledPairs(deployment: DeploymentConfig | null): PairConfig[] {
  return deployment
    ? deployment.market_registry.markets
        .filter((market) => market.enabled)
        .map((market) => ({
          pair_id: market.market_id,
          base_asset_id: market.base_asset_id,
          quote_asset_id: market.quote_asset_id,
          min_order_amount: market.min_order_amount,
          price_base_scale: market.price_base_scale,
          taker_fee_bps: market.taker_fee_bps,
          external_match_enabled: market.capabilities.external_matching,
          external_settlement_support_quote: market.external_settlement_support_quote,
          enabled: market.enabled,
        }))
    : [];
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
