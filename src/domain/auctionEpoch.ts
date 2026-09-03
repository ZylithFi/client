import { useEffect, useState } from "react";
import { fetchWithTimeout as runtimeFetchWithTimeout } from "./runtimeHttp";
import { browserSafeServiceUrl, localServiceUrl, normalizeUrl } from "./serviceUrls";

export const COORDINATOR_URL: string =
  browserSafeServiceUrl(
    normalizeUrl(import.meta.env.VITE_ZYLITH_COORDINATOR_URL) ||
      localServiceUrl(3000, "coordinator"),
    "coordinator",
  );
export const INDEXER_URL: string =
  browserSafeServiceUrl(
    normalizeUrl(import.meta.env.VITE_ZYLITH_INDEXER_URL) ||
      localServiceUrl(3300, "indexer"),
    "indexer",
  );
export const PROVER_URL: string =
  browserSafeServiceUrl(
    normalizeUrl(import.meta.env.VITE_ZYLITH_PRIVATE_INGRESS_URL) ||
      localServiceUrl(3200, "prover"),
    "prover",
  );

const BACKGROUND_FETCH_TIMEOUT_MS = 8_000;
const BULK_BATCH_ID_PAGE_SIZE = 16;
const BACKGROUND_BATCH_ID_POLL_LIMIT = 32;

export type BatchSummary = {
  batch_id: string;
  pair_id: string;
  epoch_id: number;
  close_time_unix_ms: number;
  status: "Open" | "Closed" | "Clearing" | "Settled" | "Cancelled" | "Proving" | "Settling";
  order_count_bucket: string;
};

const BATCH_STATUSES = new Set<BatchSummary["status"]>([
  "Open",
  "Closed",
  "Clearing",
  "Settled",
  "Cancelled",
  "Proving",
  "Settling",
]);

export type DeploymentConfig = {
  network: string;
  chain_id: string;
  rpc_url: string;
  product: {
    assets?: Record<string, {
      asset_id: string;
      min_trade_amount: string;
      decimals?: number;
      enabled: boolean;
    }>;
    pairs: Record<string, {
      pair_id: string;
      base_asset_id: string;
      quote_asset_id: string;
      min_order_amount: string;
      price_base_scale: string;
      heartbeat_cover_price: string;
      taker_fee_bps: number;
      relay_fee_bps: number;
      enabled: boolean;
    }>;
  };
  token_addresses: Record<string, string>;
  contracts?: {
    auction_verifier?: string;
  };
  proof?: {
    proof_version?: string;
    output_claim_delay_seconds?: number;
    native_tx_prover_ohttp_enabled?: boolean;
    auction_verifier_class_hash?: string;
    statement_proof_program_hashes?: Record<string, string>;
    admission_proof_program_hash?: string;
    auction_result_proof_program_hash?: string;
    nullifier_proof_program_hash?: string;
    renewal_proof_program_hash?: string;
    liquidity_position_proof_program_hash?: string;
    settlement_proof_program_hash?: string;
    settlement_order_proof_program_hash?: string;
    settlement_input_membership_proof_program_hash?: string;
    settlement_output_recovery_proof_program_hash?: string;
    note_consolidation_proof_program_hash?: string;
    aggregate_settlement_proof_program_hash?: string;
    withdrawal_proof_program_hash?: string;
    multi_pair_proof_program_hash?: string;
    native_tx_prover_url?: string;
    settlement_note_fee_statement_program_address?: string;
    settlement_order_statement_program_address?: string;
    settlement_input_membership_statement_program_address?: string;
    settlement_output_recovery_statement_program_address?: string;
    liquidity_position_statement_program_address?: string;
    admission_statement_program_address?: string;
    auction_result_statement_program_address?: string;
    multi_pair_statement_program_address?: string;
  };
  proof_config?: Record<string, unknown>;
};

const TOP_LEVEL_DEPLOYMENT_FIELDS = new Set([
  "deployment",
  "network",
  "rpc_url",
  "chain_id",
  "contracts",
  "token_addresses",
  "funding",
  "product",
  "proof",
  "proof_config",
  "roles",
  "runtime",
]);

const REQUIRED_TOP_LEVEL_DEPLOYMENT_FIELDS = new Set([
  "deployment",
  "network",
  "rpc_url",
  "chain_id",
  "contracts",
  "token_addresses",
  "funding",
  "product",
  "proof",
  "roles",
  "runtime",
]);

const DEPLOYMENT_META_FIELDS = new Set(["finalized", "release_commit"]);

const CONTRACT_FIELDS = new Set([
  "commitment_registry",
  "batch_registry",
  "shielded_asset_adapter",
  "privacy_deposit_bridge",
  "auction_verifier",
]);

const FUNDING_FIELDS = new Set([
  "primary",
  "capabilities",
  "starknet_privacy",
  "assets",
]);

const REQUIRED_FUNDING_FIELDS = new Set([
  "primary",
  "starknet_privacy",
  "assets",
]);

const FUNDING_CAPABILITY_FIELDS = new Set([
  "private_deposits",
  "private_withdrawals",
  "private_transfers",
  "discovery_sync",
  "proof_bearing_transactions",
  "paymaster_ready",
  "user_controlled_disclosure",
]);

const STARKNET_PRIVACY_FUNDING_FIELDS = new Set([
  "privacy_pool",
  "bridge_adapter",
  "shielded_asset_adapter",
  "discovery_url",
  "proving_url",
  "proving_ohttp_enabled",
  "paymaster_address",
  "paymaster_url",
  "ingress_key_registry_fingerprint",
  "sdk_package",
  "sdk_version",
  "min_proving_delay_blocks",
  "proof_signer_class_hash",
]);

const OPTIONAL_STARKNET_PRIVACY_FUNDING_FIELDS = new Set([
  "shielded_asset_adapter",
]);

const REQUIRED_STARKNET_PRIVACY_FUNDING_FIELDS = new Set(
  [...STARKNET_PRIVACY_FUNDING_FIELDS].filter(
    (field) => !OPTIONAL_STARKNET_PRIVACY_FUNDING_FIELDS.has(field),
  ),
);

const FUNDING_ASSET_FIELDS = new Set([
  "asset_id",
  "token_address",
  "rail_token_address",
  "min_trade_amount",
  "enabled_pairs",
]);

const PRODUCT_FIELDS = new Set(["assets", "pairs"]);

const PRODUCT_ASSET_FIELDS = new Set([
  "asset_id",
  "min_trade_amount",
  "decimals",
  "enabled",
  "token_address",
  "erc20_behavior",
  "audit_status",
]);

const PRODUCT_PAIR_FIELDS = new Set([
  "pair_id",
  "base_asset_id",
  "quote_asset_id",
  "min_order_amount",
  "price_base_scale",
  "heartbeat_cover_price",
  "taker_fee_bps",
  "relay_fee_bps",
  "enabled",
]);

const REQUIRED_PRODUCT_PAIR_FIELDS = new Set([
  "pair_id",
  "base_asset_id",
  "quote_asset_id",
  "min_order_amount",
  "price_base_scale",
  "heartbeat_cover_price",
  "taker_fee_bps",
  "relay_fee_bps",
  "enabled",
]);

const PROOF_FIELDS = new Set([
  "scheme",
  "proof_version",
  "settlement_statement_type",
  "settlement_statement_schema",
  "auction_statement_type",
  "auction_statement_schema",
  "settlement_entrypoint",
  "proof_entrypoint",
  "proof_program_address",
  "proof_program_hash",
  "auction_verifier_class_hash",
  "statement_proof_program_hashes",
  "admission_proof_program_hash",
  "auction_result_proof_program_hash",
  "nullifier_proof_program_hash",
  "renewal_proof_program_hash",
  "liquidity_position_proof_program_hash",
  "settlement_proof_program_hash",
  "settlement_order_proof_program_hash",
  "settlement_input_membership_proof_program_hash",
  "settlement_output_recovery_proof_program_hash",
  "note_consolidation_proof_program_hash",
  "aggregate_settlement_proof_program_hash",
  "withdrawal_proof_program_hash",
  "multi_pair_proof_program_hash",
  "starknet_os_config_hash",
  "proof_account_address",
  "settlement_statement_program_address",
  "settlement_note_fee_statement_program_address",
  "settlement_order_statement_program_address",
  "settlement_input_membership_statement_program_address",
  "settlement_output_recovery_statement_program_address",
  "nullifier_statement_program_address",
  "renewal_statement_program_address",
  "liquidity_position_statement_program_address",
  "admission_statement_program_address",
  "auction_result_statement_program_address",
  "multi_pair_statement_program_address",
  "note_consolidation_statement_program_address",
  "withdrawal_statement_program_address",
  "settlement_account_address",
  "deposit_root_registrar_address",
  "proof_validity_blocks",
  "output_claim_delay_seconds",
  "proof_program_locked_after_deploy",
  "operational_config_locked_after_deploy",
  "commitment_registry_config_locked_after_deploy",
  "batch_registry_config_locked_after_deploy",
  "privacy_deposit_bridge_config_locked_after_deploy",
  "native_prover_rpc_url",
  "native_tx_prover_url",
  "native_tx_prover_ohttp_enabled",
  "initial_note_root",
  "initial_nullifier_root",
  "initial_renewal_root",
  "initial_fee_root",
]);

const OPTIONAL_PROOF_FIELDS = new Set([
  "commitment_registry_config_locked_after_deploy",
  "batch_registry_config_locked_after_deploy",
  "privacy_deposit_bridge_config_locked_after_deploy",
  "native_prover_rpc_url",
  "auction_verifier_class_hash",
  "statement_proof_program_hashes",
  "admission_proof_program_hash",
  "auction_result_proof_program_hash",
  "nullifier_proof_program_hash",
  "renewal_proof_program_hash",
  "liquidity_position_proof_program_hash",
  "settlement_proof_program_hash",
  "note_consolidation_proof_program_hash",
  "aggregate_settlement_proof_program_hash",
  "withdrawal_proof_program_hash",
  "multi_pair_proof_program_hash",
  "multi_pair_statement_program_address",
]);

const REQUIRED_PROOF_FIELDS = new Set(
  [...PROOF_FIELDS].filter((field) => !OPTIONAL_PROOF_FIELDS.has(field)),
);

const ROLE_FIELDS = new Set([
  "protocol_fee_recipient",
  "relay_fee_recipient",
  "pause_guardian_address",
]);

const RUNTIME_FIELDS = new Set([
  "batch_window_ms",
  "public_artifact_delay_min_epochs",
  "public_artifact_delay_max_epochs",
  "artifact_epoch_bucket_size",
  "output_claim_delay_seconds",
]);

export function assertCurrentDeploymentManifestShape(
  deployment: unknown,
): asserts deployment is DeploymentConfig {
  if (!isPlainObject(deployment)) {
    throw new Error("Deployment manifest must be a JSON object");
  }
  assertAllowedFields(deployment, [], TOP_LEVEL_DEPLOYMENT_FIELDS);
  assertRequiredFields(deployment, [], REQUIRED_TOP_LEVEL_DEPLOYMENT_FIELDS);
  assertAllowedObjectFields(deployment, ["deployment"], DEPLOYMENT_META_FIELDS);
  assertAllowedObjectFields(deployment, ["contracts"], CONTRACT_FIELDS);
  assertAllowedObjectFields(deployment, ["funding"], FUNDING_FIELDS, REQUIRED_FUNDING_FIELDS);
  assertOptionalObjectAllowedFields(
    deployment,
    ["funding", "capabilities"],
    FUNDING_CAPABILITY_FIELDS,
  );
  assertAllowedObjectFields(
    deployment,
    ["funding", "starknet_privacy"],
    STARKNET_PRIVACY_FUNDING_FIELDS,
    REQUIRED_STARKNET_PRIVACY_FUNDING_FIELDS,
  );
  assertAllowedRecordFields(deployment, ["funding", "assets"], FUNDING_ASSET_FIELDS);
  assertAllowedObjectFields(deployment, ["product"], PRODUCT_FIELDS);
  assertAllowedRecordFields(deployment, ["product", "assets"], PRODUCT_ASSET_FIELDS);
  assertAllowedRecordFields(
    deployment,
    ["product", "pairs"],
    PRODUCT_PAIR_FIELDS,
    REQUIRED_PRODUCT_PAIR_FIELDS,
  );
  assertAllowedObjectFields(deployment, ["proof"], PROOF_FIELDS, REQUIRED_PROOF_FIELDS);
  assertOptionalObjectAllowedFields(deployment, ["proof_config"], PROOF_FIELDS);
  assertAllowedObjectFields(deployment, ["roles"], ROLE_FIELDS);
  assertAllowedObjectFields(deployment, ["runtime"], RUNTIME_FIELDS);
}

function assertAllowedObjectFields(
  source: unknown,
  path: readonly string[],
  allowedFields: ReadonlySet<string>,
  requiredFields: ReadonlySet<string> = allowedFields,
) {
  const value = readObjectPath(source, path);
  if (value === null) {
    throw new Error(`Deployment manifest field ${path.join(".")} must be an object`);
  }
  if (!isPlainObject(value)) {
    throw new Error(`Deployment manifest field ${path.join(".")} must be an object`);
  }
  assertAllowedFields(value, path, allowedFields);
  assertRequiredFields(value, path, requiredFields);
}

function assertOptionalObjectAllowedFields(
  source: unknown,
  path: readonly string[],
  allowedFields: ReadonlySet<string>,
) {
  const value = readOptionalObjectPath(source, path);
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`Deployment manifest field ${path.join(".")} must be an object`);
  }
  assertAllowedFields(value, path, allowedFields);
}

function assertAllowedRecordFields(
  source: unknown,
  path: readonly string[],
  allowedFields: ReadonlySet<string>,
  requiredFields: ReadonlySet<string> = allowedFields,
) {
  const record = readObjectPath(source, path);
  if (record === null) {
    throw new Error(`Deployment manifest field ${path.join(".")} must be an object`);
  }
  if (!isPlainObject(record)) {
    throw new Error(`Deployment manifest field ${path.join(".")} must be an object`);
  }
  if (Object.keys(record).length === 0) {
    throw new Error(`Deployment manifest field ${path.join(".")} must not be empty`);
  }
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (!isPlainObject(entryValue)) {
      throw new Error(
        `Deployment manifest field ${[...path, entryKey].join(".")} must be an object`,
      );
    }
    assertAllowedFields(entryValue, [...path, entryKey], allowedFields);
    assertRequiredFields(entryValue, [...path, entryKey], requiredFields);
  }
}

function assertAllowedFields(
  value: Record<string, unknown>,
  path: readonly string[],
  allowedFields: ReadonlySet<string>,
) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      const dottedPath = [...path, field].join(".");
      throw new Error(`Deployment manifest includes unsupported field ${dottedPath}`);
    }
  }
}

function assertRequiredFields(
  value: Record<string, unknown>,
  path: readonly string[],
  requiredFields: ReadonlySet<string>,
) {
  for (const field of requiredFields) {
    if (!(field in value)) {
      const dottedPath = [...path, field].join(".");
      throw new Error(`Deployment manifest is missing required field ${dottedPath}`);
    }
  }
}

export type CoordinatorStatus = {
  batch_window_ms: number;
};

export type PublicSettlementTranscript = {
  batch_id: string;
  pair_id: string;
  batch_epoch: number;
  clearing_price: string | number;
  price_base_scale?: string | number;
  published_at_unix_ms?: number;
  settled_at_unix_ms?: number;
  loaded_at_unix_ms?: number;
};

export type PublicProofJobStatus = {
  batch_id: string;
  state: string;
  matched_order_count?: number;
  matched_order_count_bucket?: string;
  reuse_state?: "no_fill" | "matched" | "unknown";
  witness_available: boolean;
  proof_artifact_available: boolean;
  onchain_submission_available: boolean;
  failure?: "proving_failed" | "onchain_submit_failed" | string | null;
  updated_at_unix_ms: number;
};

export type LastClearingPrice = {
  batchId: string;
  epochId: number;
  clearingPrice: string;
  priceBaseScale?: string;
};

export async function apiSubmittablePairBatch(
  base: string,
  quote: string,
): Promise<BatchSummary> {
  const r = await fetchWithTimeout(
    `${COORDINATOR_URL}/api/pairs/${encodeURIComponent(base)}/${encodeURIComponent(quote)}/batches/submittable`,
  );
  if (!r.ok) throw new Error(`Coordinator ${r.status}`);
  return assertBatchSummary(await r.json(), "Coordinator submittable batch");
}

async function apiBatches(): Promise<BatchSummary[]> {
  const r = await fetchWithTimeout(`${COORDINATOR_URL}/api/batches`);
  if (!r.ok) throw new Error(`Coordinator ${r.status}`);
  const batches = await r.json();
  if (!Array.isArray(batches)) {
    throw new Error("Coordinator batches response is malformed");
  }
  return batches.map((batch) => assertBatchSummary(batch, "Coordinator batch"));
}

async function apiStatus(): Promise<CoordinatorStatus> {
  const r = await fetchWithTimeout(`${COORDINATOR_URL}/health`);
  if (!r.ok) throw new Error(`Coordinator ${r.status}`);
  return r.json() as Promise<CoordinatorStatus>;
}

export async function apiBatchTranscripts(batchIds: string[]): Promise<PublicSettlementTranscript[]> {
  if (batchIds.length === 0) return [];
  const loaded: PublicSettlementTranscript[] = [];
  for (const page of chunks(uniqueStrings(batchIds), BULK_BATCH_ID_PAGE_SIZE)) {
    const query = page.map(encodeURIComponent).join(",");
    const path = `/api/batches/transcripts?batch_ids=${query}`;
    const bases = INDEXER_URL ? [COORDINATOR_URL, INDEXER_URL] : [COORDINATOR_URL];
    for (const base of bases) {
      try {
        const r = await fetchWithTimeout(`${base}${path}`);
        if (!r.ok) continue;
        loaded.push(...await r.json() as PublicSettlementTranscript[]);
        break;
      } catch {
        continue;
      }
    }
  }
  return loaded;
}

export async function apiProofJobStatuses(batchIds: string[]): Promise<PublicProofJobStatus[]> {
  if (!PROVER_URL || batchIds.length === 0) return [];
  const loaded: PublicProofJobStatus[] = [];
  for (const page of chunks(uniqueStrings(batchIds), BULK_BATCH_ID_PAGE_SIZE)) {
    const query = page.map(encodeURIComponent).join(",");
    try {
      const r = await fetchWithTimeout(`${PROVER_URL}/api/public/proof-jobs?batch_ids=${query}`);
      if (r.ok) {
        loaded.push(...await r.json() as PublicProofJobStatus[]);
      }
    } catch {
      continue;
    }
  }
  return loaded;
}

async function loadDeployment(): Promise<DeploymentConfig> {
  const r = await fetchWithTimeout("/deployment.json", {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error("Deployment configuration is unavailable");
  const deployment = await r.json();
  assertCurrentDeploymentManifestShape(deployment);
  return deployment;
}

export function useBatches(): { batches: BatchSummary[]; online: boolean | null } {
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await apiBatches();
        if (!cancelled) { setBatches(data); setOnline(true); }
      } catch {
        if (!cancelled) setOnline(false);
      }
    }
    void poll();
    const t = setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return { batches, online };
}

export function usePublicSettlementTranscripts(
  batches: BatchSummary[],
  extraBatchIds: string[] = [],
): Record<string, PublicSettlementTranscript> {
  const [transcripts, setTranscripts] = useState<Record<string, PublicSettlementTranscript>>({});
  const latestEpochByPair = batches.reduce<Record<string, number>>((acc, batch) => {
    const pairId = batch.pair_id || "unknown";
    acc[pairId] = Math.max(acc[pairId] ?? 0, batch.epoch_id ?? 0);
    return acc;
  }, {});
  const settledKey = batches
    .filter(b => {
      const latestEpoch = latestEpochByPair[b.pair_id || "unknown"] ?? 0;
      if (latestEpoch <= 0) return false;
      if (!["Settled", "Closed", "Clearing", "Proving", "Settling"].includes(b.status)) return false;
      return latestEpoch - b.epoch_id <= 16;
    })
    .map(b => b.batch_id)
    .sort()
    .join("|");
  const extraKey = [...new Set(extraBatchIds)].filter(Boolean).sort().join("|");
  const pendingKey = [
    ...new Set([
      ...settledKey.split("|").filter(Boolean),
      ...extraKey.split("|").filter(Boolean),
    ]),
  ]
    .filter(batchId => !transcripts[batchId])
    .sort()
    .join("|");

  useEffect(() => {
    if (!pendingKey) return;
    let cancelled = false;

    async function loadSettledTranscripts() {
      const settledIds = pendingKey.split("|").filter(Boolean).slice(0, BACKGROUND_BATCH_ID_POLL_LIMIT);
      if (settledIds.length === 0) return;

      const loaded = await apiBatchTranscripts(settledIds)
        .catch(() => [] as PublicSettlementTranscript[]);

      if (cancelled) return;
      const next: Record<string, PublicSettlementTranscript> = {};
      for (const transcript of loaded) {
        next[transcript.batch_id] = { ...transcript, loaded_at_unix_ms: Date.now() };
      }
      if (Object.keys(next).length > 0) {
        setTranscripts(prev => ({ ...prev, ...next }));
      }
    }

    void loadSettledTranscripts();
    const t = setInterval(() => { void loadSettledTranscripts(); }, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pendingKey]);

  return transcripts;
}

export function usePublicProofJobStatuses(
  batchIds: string[],
): Record<string, PublicProofJobStatus> {
  const [statuses, setStatuses] = useState<Record<string, PublicProofJobStatus>>({});
  const key = [...new Set(batchIds)]
    .filter(Boolean)
    .filter(batchId => !isTerminalProofStatus(statuses[batchId]))
    .sort()
    .join("|");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    async function loadStatuses() {
      const ids = key.split("|").filter(Boolean).slice(0, BACKGROUND_BATCH_ID_POLL_LIMIT);
      const loaded = await apiProofJobStatuses(ids).catch(() => [] as PublicProofJobStatus[]);
      if (cancelled) return;
      const next: Record<string, PublicProofJobStatus> = {};
      for (const status of loaded) {
        next[status.batch_id] = status;
      }
      if (Object.keys(next).length > 0) {
        setStatuses(prev => ({ ...prev, ...next }));
      }
    }

    void loadStatuses();
    const t = setInterval(() => { void loadStatuses(); }, 2500);
    return () => { cancelled = true; clearInterval(t); };
  }, [key]);

  return statuses;
}

function isTerminalProofStatus(status?: PublicProofJobStatus): boolean {
  if (!status) return false;
  if (status.failure) return true;
  return ["confirmed-onchain", "failed", "cancelled"].includes(status.state);
}

export function useDeployment(): DeploymentConfig | null {
  const [deployment, setDeployment] = useState<DeploymentConfig | null>(null);
  useEffect(() => {
    loadDeployment().then(setDeployment).catch(() => { /* noop */ });
  }, []);
  return deployment;
}

export function useCoordinatorStatus(): CoordinatorStatus | null {
  const [status, setStatus] = useState<CoordinatorStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await apiStatus();
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus(null);
      }
    }
    void poll();
    const t = setInterval(() => { void poll(); }, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  return status;
}

export function lastClearingByPair(
  transcripts: Record<string, PublicSettlementTranscript>,
): Record<string, LastClearingPrice> {
  const result: Record<string, LastClearingPrice> = {};
  for (const transcript of Object.values(transcripts)) {
    const pairId = transcript.pair_id;
    const current = result[pairId];
    if (current && current.epochId >= transcript.batch_epoch) continue;
    result[pairId] = {
      batchId: transcript.batch_id,
      epochId: transcript.batch_epoch,
      clearingPrice: String(transcript.clearing_price),
      priceBaseScale: transcript.price_base_scale === undefined ? undefined : String(transcript.price_base_scale),
    };
  }
  return result;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  try {
    return await runtimeFetchWithTimeout(input, init, BACKGROUND_FETCH_TIMEOUT_MS);
  } catch {
    throw new Error("Network request failed. Check your connection and retry.");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function assertBatchSummary(value: unknown, label: string): BatchSummary {
  if (!isPlainObject(value)) throw new Error(`${label} response is malformed`);
  const batch = value as Record<string, unknown>;
  const batchId = batch.batch_id;
  const pairId = batch.pair_id;
  const epochId = batch.epoch_id;
  const closeTimeUnixMs = batch.close_time_unix_ms;
  const status = batch.status;
  const orderCountBucket = batch.order_count_bucket;
  if (
    typeof batchId !== "string" ||
    batchId.trim() === "" ||
    typeof pairId !== "string" ||
    pairId.trim() === "" ||
    typeof epochId !== "number" ||
    !Number.isInteger(epochId) ||
    epochId < 0 ||
    typeof closeTimeUnixMs !== "number" ||
    !Number.isFinite(closeTimeUnixMs) ||
    !BATCH_STATUSES.has(status as BatchSummary["status"]) ||
    typeof orderCountBucket !== "string"
  ) {
    throw new Error(`${label} response is malformed`);
  }
  return {
    batch_id: batchId,
    pair_id: pairId,
    epoch_id: epochId,
    close_time_unix_ms: closeTimeUnixMs,
    status: status as BatchSummary["status"],
    order_count_bucket: orderCountBucket,
  };
}

function readObjectPath(
  root: unknown,
  path: readonly string[],
): Record<string, unknown> | null {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainObject(current)) return null;
    current = current[segment];
  }
  return isPlainObject(current) ? current : null;
}

function readOptionalObjectPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    if (!(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function chunks<T>(values: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    pages.push(values.slice(index, index + size));
  }
  return pages;
}
