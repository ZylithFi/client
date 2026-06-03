import { useEffect, useState } from "react";

export const COORDINATOR_URL: string =
  (import.meta.env.VITE_ZYLITH_COORDINATOR_URL as string | undefined) ?? localServiceUrl(3000);
export const INDEXER_URL: string =
  (import.meta.env.VITE_ZYLITH_INDEXER_URL as string | undefined) ?? localServiceUrl(3300);
export const PROVER_URL: string =
  ((import.meta.env.VITE_ZYLITH_PRIVATE_INGRESS_URL as string | undefined) ||
    (import.meta.env.VITE_ZYLITH_PROVER_URL as string | undefined)) ?? localServiceUrl(3200);

function localServiceUrl(port: number) {
  if (typeof window === "undefined") return "";
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return `http://${host}:${port}`;
  }
  return "";
}

export type BatchSummary = {
  batch_id: string;
  pair_id: string;
  epoch_id: number;
  close_time_unix_ms: number;
  status: "Open" | "Closed" | "Clearing" | "Settled" | "Cancelled" | "Proving" | "Settling";
  order_count_bucket: string;
};

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
      price_base_scale?: string;
      taker_fee_bps?: number;
      maker_fee_bps?: number;
      relay_fee_bps?: number;
      enabled: boolean;
    }>;
  };
  token_addresses: Record<string, string>;
  contracts?: {
    auction_verifier?: string;
  };
  proof?: {
    output_claim_delay_seconds?: number;
    native_tx_prover_ohttp_enabled?: boolean;
    native_tx_prover_url?: string;
    native_prover_rpc_url?: string;
  };
  proof_config?: {
    output_claim_delay_seconds?: number;
    native_tx_prover_ohttp_enabled?: boolean;
    native_tx_prover_url?: string;
    native_prover_rpc_url?: string;
  };
};

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

export async function apiCurrentPairBatch(base: string, quote: string): Promise<BatchSummary> {
  const r = await fetch(`${COORDINATOR_URL}/api/pairs/${base}/${quote}/batches/current`);
  if (!r.ok) throw new Error(`Coordinator ${r.status}`);
  return r.json() as Promise<BatchSummary>;
}

async function apiBatches(): Promise<BatchSummary[]> {
  const r = await fetch(`${COORDINATOR_URL}/api/batches`);
  if (!r.ok) throw new Error(`Coordinator ${r.status}`);
  return r.json() as Promise<BatchSummary[]>;
}

async function apiStatus(): Promise<CoordinatorStatus> {
  const r = await fetch(`${COORDINATOR_URL}/health`);
  if (!r.ok) throw new Error(`Coordinator ${r.status}`);
  return r.json() as Promise<CoordinatorStatus>;
}

async function apiBatchTranscript(batchId: string): Promise<PublicSettlementTranscript | null> {
  const path = `/api/batches/${encodeURIComponent(batchId)}/transcript`;
  const bases = INDEXER_URL ? [COORDINATOR_URL, INDEXER_URL] : [COORDINATOR_URL];
  for (const base of bases) {
    try {
      const r = await fetch(`${base}${path}`);
      if (r.status === 404) continue;
      if (!r.ok) continue;
      return r.json() as Promise<PublicSettlementTranscript>;
    } catch {
      continue;
    }
  }
  return null;
}

async function apiBatchTranscripts(batchIds: string[]): Promise<PublicSettlementTranscript[]> {
  if (batchIds.length === 0) return [];
  const query = batchIds.map(encodeURIComponent).join(",");
  const path = `/api/batches/transcripts?batch_ids=${query}`;
  const bases = INDEXER_URL ? [COORDINATOR_URL, INDEXER_URL] : [COORDINATOR_URL];
  for (const base of bases) {
    try {
      const r = await fetch(`${base}${path}`);
      if (!r.ok) continue;
      return r.json() as Promise<PublicSettlementTranscript[]>;
    } catch {
      continue;
    }
  }
  const loaded = await Promise.all(batchIds.map(apiBatchTranscript));
  return loaded.filter((transcript): transcript is PublicSettlementTranscript => Boolean(transcript));
}

async function apiProofJobStatus(batchId: string): Promise<PublicProofJobStatus | null> {
  if (!PROVER_URL) return null;
  const r = await fetch(`${PROVER_URL}/api/public/proof-jobs/${encodeURIComponent(batchId)}`);
  if (r.status === 404) return null;
  if (!r.ok) return null;
  return r.json() as Promise<PublicProofJobStatus>;
}

async function apiProofJobStatuses(batchIds: string[]): Promise<PublicProofJobStatus[]> {
  if (!PROVER_URL || batchIds.length === 0) return [];
  const query = batchIds.map(encodeURIComponent).join(",");
  const r = await fetch(`${PROVER_URL}/api/public/proof-jobs?batch_ids=${query}`);
  if (!r.ok) {
    const loaded = await Promise.all(batchIds.map(apiProofJobStatus));
    return loaded.filter((status): status is PublicProofJobStatus => Boolean(status));
  }
  return r.json() as Promise<PublicProofJobStatus[]>;
}

async function loadDeployment(): Promise<DeploymentConfig> {
  const r = await fetch("/deployment.json");
  if (!r.ok) throw new Error("Deployment configuration is unavailable");
  return r.json() as Promise<DeploymentConfig>;
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
      const settledIds = pendingKey.split("|").filter(Boolean);
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
      const ids = key.split("|").filter(Boolean);
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
