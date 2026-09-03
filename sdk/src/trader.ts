import type { BatchSummary, TicketSubmitIntent } from "./common.js";
import {
  DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
  DEFAULT_SDK_REQUEST_TIMEOUT_MS,
  fetchWithSdkTimeout,
  normalizeSdkServiceUrl,
  parseBatchSummary,
  readSdkJsonResponse,
  readSdkResponseText,
  sanitizeSdkErrorMessage,
} from "./common.js";
import type {
  PrivateLiquidityPositionCloseRequest,
  PrivateLiquidityPositionOpenRequest,
  PrivateLiquidityPositionReconfigureRequest,
} from "./liquidity.js";
import type {
  LiquidityPositionWalletRuntime,
  PrivateLiquidityPositionLifecycleResult,
  PrivateLiquidityPositionOpenResult,
  PrivateOrderSubmission,
  PrivateReportRequest,
  TraderWalletRuntime,
} from "./wallet.js";

export type {
  LiquidityPositionWalletRuntime,
  PrivateLiquidityPositionOpenResult,
  PrivateOrderSubmission,
  PrivateReportRequest,
  TraderWalletRuntime,
} from "./wallet.js";

export type TraderSdkOptions = {
  coordinatorUrl: string;
  proverUrl: string;
  fetchImpl?: typeof fetch;
};

export type SettlementOutputWithdrawalOptions = {
  noteCommitment?: string;
  asset?: string;
  pair?: string;
};

export type PublicProofJobStatus = {
  batch_id: string;
  state: string;
  matched_order_count_bucket?: string;
  reuse_state?: "no_fill" | "matched" | "unknown";
  failure?: string | null;
  updated_at_unix_ms?: number;
};

export type SdkRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type WaitForSettlementOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
};

export class ZylithTraderSdk {
  private readonly coordinatorUrl: string;
  private readonly proverUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: TraderSdkOptions) {
    this.coordinatorUrl = normalizeSdkServiceUrl(options.coordinatorUrl, "coordinatorUrl");
    this.proverUrl = normalizeSdkServiceUrl(options.proverUrl, "proverUrl");
    this.fetcher = options.fetchImpl ?? defaultFetch();
  }

  async submittableBatch(pair: string, options: SdkRequestOptions = {}): Promise<BatchSummary> {
    const [base, quote] = pair.split("/");
    if (!base || !quote) throw new Error(`Invalid pair ${pair}`);
    const value = await this.getJson(
      `${this.coordinatorUrl}/api/pairs/${encodeURIComponent(base)}/${encodeURIComponent(quote)}/batches/submittable`,
      options
    );
    const batch = parseBatchSummary(value);
    if (normalizePairId(batch.pair_id) !== normalizePairId(pair)) {
      throw new Error("Coordinator returned a batch for the wrong pair");
    }
    return batch;
  }

  async submitPrivateOrder(wallet: TraderWalletRuntime, order: TicketSubmitIntent): Promise<PrivateOrderSubmission> {
    return wallet.submitPrivateOrder(order);
  }

  async openPrivateLiquidityPosition(
    wallet: LiquidityPositionWalletRuntime,
    request: PrivateLiquidityPositionOpenRequest,
    options: SdkRequestOptions = {}
  ): Promise<PrivateLiquidityPositionOpenResult> {
    if (!wallet.openPrivateLiquidityPosition) {
      throw new Error("Wallet runtime does not expose private liquidity position opening");
    }
    const batch = await this.submittableBatch(request.pairId, options);
    return wallet.openPrivateLiquidityPosition(request, batch);
  }

  async reconfigurePrivateLiquidityPosition(
    wallet: LiquidityPositionWalletRuntime,
    pair: string,
    request: PrivateLiquidityPositionReconfigureRequest,
    options: SdkRequestOptions = {}
  ): Promise<PrivateLiquidityPositionLifecycleResult> {
    if (!wallet.reconfigurePrivateLiquidityPosition) {
      throw new Error("Wallet runtime does not expose private liquidity position reconfiguration");
    }
    const batch = await this.submittableBatch(pair, options);
    return wallet.reconfigurePrivateLiquidityPosition(request, batch);
  }

  async closePrivateLiquidityPosition(
    wallet: LiquidityPositionWalletRuntime,
    pair: string,
    request: PrivateLiquidityPositionCloseRequest,
    options: SdkRequestOptions = {}
  ): Promise<PrivateLiquidityPositionLifecycleResult> {
    if (!wallet.closePrivateLiquidityPosition) {
      throw new Error("Wallet runtime does not expose private liquidity position close");
    }
    const batch = await this.submittableBatch(pair, options);
    return wallet.closePrivateLiquidityPosition(request, batch);
  }

  async proofStatus(batchId: string, options: SdkRequestOptions = {}): Promise<PublicProofJobStatus | null> {
    const response = await fetchWithSdkTimeout(
      this.fetcher,
      `${this.proverUrl}/api/public/proof-jobs/${encodeURIComponent(batchId)}`,
      { headers: { accept: "application/json" }, signal: options.signal },
      options.timeoutMs
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await responseError(response, options));
    const status = parsePublicProofJobStatus(await readSdkJsonResponse(response, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      label: "Prover proof status response",
    }));
    if (status.batch_id !== batchId) {
      throw new Error("Prover returned proof status for the wrong batch");
    }
    return status;
  }

  async waitForSettlement(batchId: string, options: WaitForSettlementOptions = {}): Promise<PublicProofJobStatus> {
    const timeoutMs = positiveDuration(options.timeoutMs ?? 20 * 60_000, "Settlement timeout");
    const intervalMs = positiveDuration(options.intervalMs ?? 5_000, "Settlement polling interval");
    const timeoutAt = Date.now() + timeoutMs;
    let last: PublicProofJobStatus | null = null;
    let lastTransientError: string | null = null;
    while (Date.now() < timeoutAt) {
      throwIfAborted(options.signal);
      const remainingMs = timeoutAt - Date.now();
      try {
        last = await this.proofStatus(batchId, {
          signal: options.signal,
          timeoutMs: Math.max(1, Math.min(DEFAULT_SDK_REQUEST_TIMEOUT_MS, remainingMs)),
        });
        lastTransientError = null;
      } catch (error) {
        if (options.signal?.aborted) throw new Error("Zylith SDK request aborted");
        if (!isTransientPollingError(error)) throw error;
        lastTransientError = sanitizeSdkErrorMessage(error, "transient settlement polling error");
        await sleep(Math.min(intervalMs, Math.max(0, timeoutAt - Date.now())), options.signal);
        continue;
      }
      if (last?.state === "confirmed-onchain") return last;
      if (last?.failure) throw new Error(last.failure);
      await sleep(Math.min(intervalMs, Math.max(0, timeoutAt - Date.now())), options.signal);
    }
    throw new Error(
      `Timed out waiting for settlement${last ? `: ${last.state}` : lastTransientError ? `: ${lastTransientError}` : ""}`
    );
  }

  async recoverOutputs(wallet: TraderWalletRuntime, requests: PrivateReportRequest[]): Promise<unknown[]> {
    if (!wallet.syncPrivateSettlementReports) return [];
    return wallet.syncPrivateSettlementReports(requests);
  }

  async withdraw(wallet: TraderWalletRuntime, noteCommitment: string, asset?: string): Promise<unknown> {
    if (!wallet.submitStrk20Withdrawal) throw new Error("Wallet runtime does not expose withdrawal submission");
    return wallet.submitStrk20Withdrawal({ note_commitment: noteCommitment, asset });
  }

  async withdrawSettlementOutput(
    wallet: TraderWalletRuntime,
    options: SettlementOutputWithdrawalOptions = {}
  ): Promise<unknown> {
    const notes = wallet.getWithdrawableNotes?.() ?? [];
    const note = notes.find((candidate) =>
      candidate.source === "settlement_output" &&
      !candidate.locked &&
      !candidate.spent &&
      (!options.noteCommitment || candidate.note_commitment === options.noteCommitment) &&
      (!options.asset || candidate.asset === options.asset) &&
      (!options.pair || noteLiquidityAttribution(candidate)?.pair_id === options.pair)
    );
    if (!note) throw new Error("No withdrawable settlement output matches the request");
    return this.withdraw(wallet, note.note_commitment, note.asset);
  }

  private async getJson(url: string, options: SdkRequestOptions): Promise<unknown> {
    const response = await fetchWithSdkTimeout(
      this.fetcher,
      url,
      { headers: { accept: "application/json" }, signal: options.signal },
      options.timeoutMs
    );
    if (!response.ok) throw new Error(await responseError(response, options));
    return readSdkJsonResponse(response, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      label: "Coordinator response",
    });
  }
}

function noteLiquidityAttribution(
  note: { liquidity_provider_attribution?: unknown },
): { pair_id?: string } | undefined {
  return note.liquidity_provider_attribution as { pair_id?: string } | undefined;
}

async function responseError(response: Response, options: SdkRequestOptions = {}): Promise<string> {
  const text = await readSdkResponseText(response, {
    maxBytes: DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    label: "SDK error response",
  }).catch(() => "");
  if (!text.trim()) return `Request failed with HTTP ${response.status}`;
  return sanitizeSdkErrorMessage(text, `Request failed with HTTP ${response.status}`);
}

function defaultFetch(): typeof fetch {
  return fetch.bind(globalThis);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Zylith SDK request aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isTransientPollingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Network request failed|Zylith SDK request timed out|Zylith SDK request aborted/i.test(message);
}

function parsePublicProofJobStatus(value: unknown): PublicProofJobStatus {
  const record = objectRecord(value, "Prover proof status response");
  const reuseState = optionalString(record.reuse_state, "proof reuse state");
  if (reuseState !== undefined && !["no_fill", "matched", "unknown"].includes(reuseState)) {
    throw new Error("Prover returned an invalid proof reuse state");
  }
  const failure = record.failure === null ? null : optionalString(record.failure, "proof failure");
  return {
    batch_id: requiredString(record.batch_id, "proof batch id"),
    state: requiredString(record.state, "proof state"),
    matched_order_count_bucket: optionalString(record.matched_order_count_bucket, "matched order count bucket"),
    reuse_state: reuseState as PublicProofJobStatus["reuse_state"],
    failure,
    updated_at_unix_ms: optionalNonNegativeSafeInteger(record.updated_at_unix_ms, "proof update time"),
  };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}

function optionalNonNegativeSafeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeSafeInteger(value, label);
}

function normalizePairId(value: string): string {
  return value.replace(/[-_]/g, "/").toUpperCase();
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Zylith SDK request aborted");
}
