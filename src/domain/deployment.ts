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
  enabled: boolean;
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
  token_addresses: Record<string, string>;
  funding: {
    primary: "starknet_privacy" | string;
    starknet_privacy?: {
      privacy_pool?: string;
      bridge_adapter?: string;
      discovery_url?: string;
      proving_url?: string;
      proving_ohttp_enabled?: boolean;
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
    assets?: Record<string, { token_address?: string; rail_token_address?: string }>;
  };
  product: {
    assets?: Record<string, { asset_id: string; min_trade_amount: string; decimals?: number; enabled: boolean; token_address?: string }>;
    pairs: Record<string, PairConfig>;
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
const REQUIRED_FIELDS = ["deployment", "network", "chain_id", "rpc_url", "contracts", "token_addresses", "funding", "product", "proof", "roles", "runtime"] as const;
const REQUIRED_CONTRACTS = ["commitment_registry", "privacy_deposit_bridge", "exchange"] as const;

export const OPERATOR_URL = serviceUrl(import.meta.env.VITE_ZYLITH_OPERATOR_URL, 3200, "prover");
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
  const pairs = (record.product as { pairs?: unknown })?.pairs;
  if (!pairs || typeof pairs !== "object") {
    throw new Error("Deployment manifest has no pairs");
  }
  for (const pair of Object.values(pairs as Record<string, PairConfig>)) {
    if (!pair.pair_id || !pair.base_asset_id || !pair.quote_asset_id || !/^[1-9]\d*$/.test(pair.price_base_scale ?? "")) {
      throw new Error(`Deployment manifest pair ${pair.pair_id ?? "?"} is malformed`);
    }
  }
  const runtime = record.runtime as Record<string, unknown>;
  if (!Number.isSafeInteger(runtime?.epoch_ms) || (runtime.epoch_ms as number) <= 0) {
    throw new Error("Deployment manifest runtime is malformed");
  }
  // a pair routed to ekubo needs the router and a window in which a fill can land.
  const routed = Object.values(pairs as Record<string, PairConfig>).filter((pair) => pair.enabled && pair.external_match_enabled);
  if (routed.length > 0) {
    if (!normalizeConfiguredFelt(contracts?.ekubo_external_match_router)) {
      throw new Error("Deployment manifest enables external matching without an external match router");
    }
    if (!Number.isSafeInteger(runtime.external_window_seconds) || (runtime.external_window_seconds as number) <= 0) {
      throw new Error("Deployment manifest enables external matching without an external window");
    }
  }
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
  return manifest;
}

export function enabledPairs(deployment: DeploymentConfig | null): PairConfig[] {
  return deployment ? Object.values(deployment.product.pairs).filter((pair) => pair.enabled) : [];
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
