import { userFacingErrorMessage } from "./domain/userFacingErrors";

type BatchSummary = {
  batch_id: string;
  pair_id: string;
  epoch_id: number;
  close_time_unix_ms: number;
  status: string;
};

type IngressResponse = {
  coordinator_submission: unknown;
  receipt: unknown;
};

type CoordinatorAccepted = {
  order_commitment: string;
  batch_id: string;
  accepted_at_unix_ms: number;
};

type PublicProofJobStatus = {
  state?: string;
  matched_order_count?: number;
  reuse_state?: "no_fill" | "matched" | "unknown";
  failure?: string;
};

type RenewalCancelMarkerStatus = {
  recorded?: boolean;
};

// Browser-side relay for exact-slot offline renewal packages produced by the
// embedded wallet. This is intentionally separate from normal strategy
// execution: it lets a delegated operator submit prebuilt child orders for
// authorized epochs without receiving wallet spend or withdrawal keys.
export type OfflineRenewalPackage = {
  version: 1;
  package_id: string;
  package_commitment: string;
  created_at_unix_ms: number;
  pair: string;
  start_epoch: number;
  end_epoch: number;
  slot_count: number;
  relay_mode?: "SelfRelay" | "ZylithRelay";
  parent_cancel_authority: string;
  parent_cancel_marker: string;
  relay_authorization?: {
    signer_public_key: string;
    signature_r: string;
    signature_s: string;
  };
  ingress_key_registry_fingerprint?: string;
  relay_policy: {
    prover_url: string;
    coordinator_url: string;
    submission_safety_buffer_ms: number;
    max_submission_delay_ms: number;
  };
  slots: OfflineRenewalSlot[];
};

export type OfflineRenewalSlot = {
  slot_id: string;
  pair: string;
  batch_id: string;
  epoch_id: number;
  parent_child_index: number;
  order_commitment: string;
  funding_note_commitments?: string[];
  ingress_request: unknown;
};

export type OfflineRenewalOperatorOptions = {
  coordinatorUrl?: string;
  proverUrl?: string;
  submittedOrderCommitments?: Iterable<string>;
  fetchImpl?: typeof fetch;
  verifyPackage?: (renewalPackage: OfflineRenewalPackage) => Promise<boolean> | boolean;
  now?: () => number;
};

export type OfflineRenewalRelayResult = {
  slot_id: string;
  pair: string;
  parent_child_index: number;
  order_commitment: string;
  batch_id: string;
  epoch_id: number;
  status:
    | "submitted"
    | "already_submitted"
    | "not_due"
    | "batch_not_open"
    | "safety_buffer"
    | "awaiting_settlement"
    | "awaiting_wallet_refresh"
    | "missed"
    | "failed";
  detail?: string;
  accepted?: CoordinatorAccepted;
};

declare global {
  interface Window {
    zylithOfflineRenewalOperator?: {
      relayPackage: typeof relayOfflineRenewalPackage;
    };
  }
}

export const OFFLINE_RENEWAL_RELAY_RESULTS_EVENT = "zylith:offline-renewal-relay-results";

export function installOfflineRenewalOperatorRuntime() {
  if (typeof window === "undefined") return;
  window.zylithOfflineRenewalOperator = {
    relayPackage: (renewalPackage, options = {}) => relayOfflineRenewalPackage(renewalPackage, {
      verifyPackage: verifyOfflineRenewalPackageWithWalletRuntime,
      ...options,
    }),
  };
}

export async function relayOfflineRenewalPackage(
  renewalPackage: OfflineRenewalPackage,
  options: OfflineRenewalOperatorOptions = {},
): Promise<OfflineRenewalRelayResult[]> {
  validateOfflineRenewalPackage(renewalPackage);
  if (options.verifyPackage) {
    const verified = await options.verifyPackage(renewalPackage);
    if (!verified) throw new Error("Offline renewal package authorization is invalid");
  }
  const fetcher = options.fetchImpl ?? fetch;
  const coordinatorUrl = normalizeUrl(options.coordinatorUrl || renewalPackage.relay_policy.coordinator_url);
  const proverUrl = normalizeUrl(options.proverUrl || renewalPackage.relay_policy.prover_url);
  if (!coordinatorUrl || !proverUrl) {
    throw new Error("Offline renewal operator requires coordinator and private ingress URLs");
  }
  const alreadySubmitted = new Set(options.submittedOrderCommitments ?? []);
  const results: OfflineRenewalRelayResult[] = [];
  for (const slot of renewalPackage.slots) {
    if (alreadySubmitted.has(slot.order_commitment)) {
      results.push(slotResult(slot, "already_submitted"));
      continue;
    }
    try {
      const currentBatch = await fetchCurrentPairBatch(fetcher, coordinatorUrl, slot.pair);
      if (!currentBatch || currentBatch.batch_id !== slot.batch_id || currentBatch.epoch_id !== slot.epoch_id) {
        results.push(slotResult(slot, "not_due"));
        continue;
      }
      if (currentBatch.status !== "Open") {
        results.push(slotResult(slot, "batch_not_open", currentBatch.status));
        continue;
      }
      const cancelStatus = await fetchRenewalCancelMarkerStatus(fetcher, coordinatorUrl, renewalPackage);
      if (!cancelStatus) {
        results.push(slotResult(slot, "awaiting_settlement", "Waiting for renewal cancellation status before submitting child orders."));
        continue;
      }
      if (cancelStatus.recorded) {
        results.push(slotResult(slot, "missed", "Renewal parent cancellation marker is recorded."));
        continue;
      }
      const now = options.now?.() ?? Date.now();
      if (currentBatch.close_time_unix_ms - now <= renewalPackage.relay_policy.submission_safety_buffer_ms) {
        results.push(slotResult(slot, "safety_buffer"));
        continue;
      }
      await delay(relayDelayMs(currentBatch, renewalPackage, now));
      const afterDelay = options.now?.() ?? Date.now();
      if (currentBatch.close_time_unix_ms - afterDelay <= renewalPackage.relay_policy.submission_safety_buffer_ms) {
        results.push(slotResult(slot, "safety_buffer"));
        continue;
      }
      const guard = await priorSlotReuseGuard(fetcher, proverUrl, renewalPackage, slot, alreadySubmitted);
      if (guard) {
        results.push(guard);
        continue;
      }
      const ingress = await postJson<IngressResponse>(
        fetcher,
        proverUrl,
        "/api/private/orders",
        attestedIngressRequest(renewalPackage, slot),
      );
      validateIngressForSlot(renewalPackage, slot, ingress.receipt);
      const accepted = await postJson<CoordinatorAccepted>(
        fetcher,
        coordinatorUrl,
        "/api/orders",
        ingress.coordinator_submission,
      );
      validateAcceptedForSlot(slot, accepted);
      alreadySubmitted.add(slot.order_commitment);
      results.push({
        ...slotResult(slot, "submitted"),
        accepted,
      });
    } catch (error) {
      results.push(slotResult(slot, "failed", userFacingErrorMessage(error, "Relay failed.")));
    }
  }
  dispatchRelayResults(renewalPackage, results);
  return results;
}

async function verifyOfflineRenewalPackageWithWalletRuntime(renewalPackage: OfflineRenewalPackage): Promise<boolean> {
  const wallet = typeof window !== "undefined" ? window.zylithWallet : undefined;
  if (!wallet?.verifyOfflineRenewalPackage) return false;
  return wallet.verifyOfflineRenewalPackage(renewalPackage).catch(() => false);
}

async function priorSlotReuseGuard(
  fetcher: typeof fetch,
  proverUrl: string,
  renewalPackage: OfflineRenewalPackage,
  slot: OfflineRenewalSlot,
  alreadySubmitted: Set<string>,
): Promise<OfflineRenewalRelayResult | null> {
  const priorSlots = renewalPackage.slots.filter(candidate =>
    candidate.parent_child_index < slot.parent_child_index &&
    alreadySubmitted.has(candidate.order_commitment) &&
    slotsReuseFundingNotes(candidate, slot),
  );
  for (const prior of priorSlots) {
    const status = await fetchJson<PublicProofJobStatus>(
      fetcher,
      proverUrl,
      `/api/public/proof-jobs/${encodeURIComponent(prior.batch_id)}`,
    );
    if (!status) {
      return slotResult(slot, "awaiting_settlement", `Waiting for prior child batch ${prior.batch_id} proof status.`);
    }
    if (proofJobFailed(status)) {
      return slotResult(slot, "awaiting_settlement", `Prior child batch ${prior.batch_id} proof failed; refresh this package before reusing maker capital.`);
    }
    if (proofJobConfirmed(status)) {
      if (status.reuse_state === "no_fill") continue;
      if (status.reuse_state === "matched") {
        return slotResult(slot, "awaiting_wallet_refresh", `Prior child batch ${prior.batch_id} settled; refresh this package before reusing maker capital.`);
      }
      return slotResult(slot, "awaiting_wallet_refresh", `Prior child batch ${prior.batch_id} settled; refresh this package before reusing maker capital.`);
    }
    return slotResult(slot, "awaiting_settlement", `Waiting for prior child batch ${prior.batch_id} to settle.`);
  }
  return null;
}

function slotsReuseFundingNotes(candidate: OfflineRenewalSlot, slot: OfflineRenewalSlot): boolean {
  const current = new Set(slot.funding_note_commitments ?? []);
  const prior = candidate.funding_note_commitments ?? [];
  if (current.size === 0 || prior.length === 0) return true;
  return prior.some(commitment => current.has(commitment));
}

function attestedIngressRequest(renewalPackage: OfflineRenewalPackage, slot: OfflineRenewalSlot): Record<string, unknown> {
  if (!slot.ingress_request || typeof slot.ingress_request !== "object" || Array.isArray(slot.ingress_request)) {
    throw new Error("Offline renewal slot ingress request must be an object");
  }
  return {
    ...(slot.ingress_request as Record<string, unknown>),
    renewal_package_id: renewalPackage.package_id,
    renewal_package_commitment: renewalPackage.package_commitment,
    renewal_relay_mode: renewalPackage.relay_mode,
    renewal_slot_order_commitment: slot.order_commitment,
    renewal_slot_pair: slot.pair,
    renewal_slot_batch_id: slot.batch_id,
    renewal_slot_epoch_id: slot.epoch_id,
  };
}

function validateIngressForSlot(renewalPackage: OfflineRenewalPackage, slot: OfflineRenewalSlot, receipt: unknown) {
  if (!receipt || typeof receipt !== "object") throw new Error("Private ingress response is missing receipt");
  const record = receipt as Record<string, unknown>;
  if (record.order_commitment !== slot.order_commitment) throw new Error("Private ingress receipt order commitment mismatch");
  if (record.pair_id !== slot.pair) throw new Error("Private ingress receipt pair mismatch");
  if (record.batch_id !== slot.batch_id) throw new Error("Private ingress receipt batch mismatch");
  if (record.epoch_id !== slot.epoch_id) throw new Error("Private ingress receipt epoch mismatch");
  if (record.relay_mode !== renewalPackage.relay_mode) throw new Error("Private ingress receipt relay mode mismatch");
  if (record.renewal_package_id !== renewalPackage.package_id) throw new Error("Private ingress receipt package id mismatch");
  if (record.renewal_package_commitment !== renewalPackage.package_commitment) {
    throw new Error("Private ingress receipt package commitment mismatch");
  }
}

function validateAcceptedForSlot(slot: OfflineRenewalSlot, accepted: CoordinatorAccepted) {
  if (accepted.order_commitment !== slot.order_commitment) throw new Error("Coordinator accepted order commitment mismatch");
  if (accepted.batch_id !== slot.batch_id) throw new Error("Coordinator accepted batch mismatch");
}

function proofJobConfirmed(status: PublicProofJobStatus): boolean {
  return status.state?.toLowerCase() === "confirmed-onchain";
}

function proofJobFailed(status: PublicProofJobStatus): boolean {
  return Boolean(status.failure) || Boolean(status.state?.toLowerCase().includes("failed"));
}

function validateOfflineRenewalPackage(renewalPackage: OfflineRenewalPackage) {
  if (renewalPackage.version !== 1) throw new Error("Unsupported offline renewal package version");
  if (renewalPackage.slot_count !== renewalPackage.slots.length) {
    throw new Error("Offline renewal package slot_count does not match slots length");
  }
  if (renewalPackage.relay_mode && !["SelfRelay", "ZylithRelay"].includes(renewalPackage.relay_mode)) {
    throw new Error("Offline renewal package relay mode is unsupported");
  }
  if (renewalPackage.relay_mode === "ZylithRelay") {
    throw new Error("Zylith relay packages must be submitted to the managed renewal relay");
  }
  if (!renewalPackage.parent_cancel_authority || !renewalPackage.parent_cancel_marker) {
    throw new Error("Offline renewal package cancellation marker is missing");
  }
  const seen = new Set<string>();
  for (const slot of renewalPackage.slots) {
    if (slot.pair !== renewalPackage.pair) throw new Error("Offline renewal slot pair mismatch");
    if (slot.epoch_id < renewalPackage.start_epoch || slot.epoch_id > renewalPackage.end_epoch) {
      throw new Error("Offline renewal slot epoch outside package range");
    }
    if (seen.has(slot.order_commitment)) throw new Error("Duplicate offline renewal order commitment");
    seen.add(slot.order_commitment);
    if (!slot.order_commitment.startsWith("0x")) throw new Error("Offline renewal slot commitment must be felt-like");
  }
}

function slotResult(
  slot: OfflineRenewalSlot,
  status: OfflineRenewalRelayResult["status"],
  detail?: string,
): OfflineRenewalRelayResult {
  return {
    slot_id: slot.slot_id,
    pair: slot.pair,
    parent_child_index: slot.parent_child_index,
    order_commitment: slot.order_commitment,
    batch_id: slot.batch_id,
    epoch_id: slot.epoch_id,
    status,
    detail,
  };
}

function dispatchRelayResults(
  renewalPackage: OfflineRenewalPackage,
  results: OfflineRenewalRelayResult[],
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OFFLINE_RENEWAL_RELAY_RESULTS_EVENT, {
    detail: {
      package_id: renewalPackage.package_id,
      package_commitment: renewalPackage.package_commitment,
      results,
    },
  }));
}

async function fetchCurrentPairBatch(fetcher: typeof fetch, coordinatorUrl: string, pair: string) {
  const [base, quote] = pair.split("/");
  return fetchJson<BatchSummary>(fetcher, coordinatorUrl, `/api/pairs/${base}/${quote}/batches/current`);
}

async function fetchRenewalCancelMarkerStatus(
  fetcher: typeof fetch,
  coordinatorUrl: string,
  renewalPackage: OfflineRenewalPackage,
) {
  return fetchJson<RenewalCancelMarkerStatus>(
    fetcher,
    coordinatorUrl,
    `/api/renewal/cancel-markers/${encodeURIComponent(renewalPackage.parent_cancel_marker ?? "")}`,
  );
}

async function fetchJson<T>(fetcher: typeof fetch, baseUrl: string, path: string): Promise<T | null> {
  const response = await fetcher(`${baseUrl}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

async function postJson<T>(fetcher: typeof fetch, baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function relayDelayMs(batch: BatchSummary, renewalPackage: OfflineRenewalPackage, now: number) {
  const maxDelay = Math.min(
    renewalPackage.relay_policy.max_submission_delay_ms,
    batch.close_time_unix_ms - now - renewalPackage.relay_policy.submission_safety_buffer_ms,
  );
  if (maxDelay <= 0) return 0;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return Math.floor((bytes[0] / 0x1_0000_0000) * maxDelay);
}

function delay(ms: number) {
  return ms > 0 ? new Promise((resolve) => globalThis.setTimeout(resolve, ms)) : Promise.resolve();
}

function normalizeUrl(value: string) {
  return value.replace(/\/+$/, "");
}
