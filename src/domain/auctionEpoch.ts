import { useEffect, useState } from "react";

export const COORDINATOR_URL: string =
  (import.meta.env.VITE_ZYLITH_COORDINATOR_URL as string | undefined) ?? localServiceUrl(3000);
export const INDEXER_URL: string =
  (import.meta.env.VITE_ZYLITH_INDEXER_URL as string | undefined) ?? localServiceUrl(3300);

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
): Record<string, PublicSettlementTranscript> {
  const [transcripts, setTranscripts] = useState<Record<string, PublicSettlementTranscript>>({});
  const latestEpoch = batches.reduce((max, batch) => Math.max(max, batch.epoch_id ?? 0), 0);
  const settledKey = batches
    .filter(b => {
      if (b.status === "Settled") return true;
      if (!["Closed", "Clearing", "Proving", "Settling"].includes(b.status)) return false;
      return latestEpoch > 0 && latestEpoch - b.epoch_id <= 16;
    })
    .map(b => b.batch_id)
    .sort()
    .join("|");

  useEffect(() => {
    if (!settledKey) return;
    let cancelled = false;

    async function loadSettledTranscripts() {
      const settledIds = settledKey.split("|").filter(Boolean);
      if (settledIds.length === 0) return;

      const loaded = await Promise.all(
        settledIds.map(async batchId => {
          try {
            const transcript = await apiBatchTranscript(batchId);
            return transcript
              ? [batchId, { ...transcript, loaded_at_unix_ms: Date.now() }] as const
              : null;
          } catch {
            return null;
          }
        }),
      );

      if (cancelled) return;
      const next: Record<string, PublicSettlementTranscript> = {};
      for (const entry of loaded) {
        if (entry) next[entry[0]] = entry[1];
      }
      if (Object.keys(next).length > 0) {
        setTranscripts(prev => ({ ...prev, ...next }));
      }
    }

    void loadSettledTranscripts();
    const t = setInterval(() => { void loadSettledTranscripts(); }, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [settledKey]);

  return transcripts;
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
