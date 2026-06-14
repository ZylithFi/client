import type { TicketSubmitIntent } from "../components/OrderTicket";
import type { BatchSummary } from "../domain/auctionEpoch";
import type { WithdrawableNote } from "../domain/shieldedBalances";

export type TraderSdkOptions = {
  coordinatorUrl: string;
  proverUrl: string;
  fetchImpl?: typeof fetch;
};

export type TraderWalletRuntime = {
  submitPrivateOrder: (order: TicketSubmitIntent) => Promise<PrivateOrderSubmission>;
  syncPrivateSettlementReports?: (requests: PrivateReportRequest[]) => Promise<unknown[]>;
  scanNotes?: () => Promise<boolean>;
  submitHostedWithdrawal?: (request: { note_commitment: string; asset?: string }) => Promise<unknown>;
  getWithdrawableNotes?: () => WithdrawableNote[];
};

export type PrivateOrderSubmission = {
  order_id?: string;
  order_commitment?: string;
  batch_id?: string;
  epoch_id?: number;
  status?: string;
};

export type PrivateReportRequest = {
  batch_id: string;
  order_commitments: string[];
  orders?: Array<{ order_commitment: string; cancellation_secret: string }>;
};

export type PublicProofJobStatus = {
  batch_id: string;
  state: string;
  matched_order_count_bucket?: string;
  reuse_state?: "no_fill" | "matched" | "unknown";
  failure?: string | null;
  updated_at_unix_ms?: number;
};

export class ZylithTraderSdk {
  private readonly coordinatorUrl: string;
  private readonly proverUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: TraderSdkOptions) {
    this.coordinatorUrl = stripTrailingSlash(options.coordinatorUrl);
    this.proverUrl = stripTrailingSlash(options.proverUrl);
    this.fetcher = options.fetchImpl ?? fetch;
  }

  async currentBatch(pair: string): Promise<BatchSummary> {
    const [base, quote] = pair.split("/");
    if (!base || !quote) throw new Error(`Invalid pair ${pair}`);
    return this.getJson<BatchSummary>(
      `${this.coordinatorUrl}/api/pairs/${encodeURIComponent(base)}/${encodeURIComponent(quote)}/batches/current`
    );
  }

  async submitPrivateOrder(wallet: TraderWalletRuntime, order: TicketSubmitIntent): Promise<PrivateOrderSubmission> {
    return wallet.submitPrivateOrder(order);
  }

  async proofStatus(batchId: string): Promise<PublicProofJobStatus | null> {
    const response = await this.fetcher(
      `${this.proverUrl}/api/public/proof-jobs/${encodeURIComponent(batchId)}`,
      { headers: { accept: "application/json" } }
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await responseError(response));
    return (await response.json()) as PublicProofJobStatus;
  }

  async waitForSettlement(batchId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<PublicProofJobStatus> {
    const timeoutAt = Date.now() + (options.timeoutMs ?? 20 * 60_000);
    const intervalMs = options.intervalMs ?? 5_000;
    let last: PublicProofJobStatus | null = null;
    while (Date.now() < timeoutAt) {
      last = await this.proofStatus(batchId);
      if (last?.state === "confirmed-onchain") return last;
      if (last?.failure) throw new Error(last.failure);
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for settlement${last ? `: ${last.state}` : ""}`);
  }

  async recoverOutputs(wallet: TraderWalletRuntime, requests: PrivateReportRequest[]): Promise<unknown[]> {
    if (!wallet.syncPrivateSettlementReports) return [];
    return wallet.syncPrivateSettlementReports(requests);
  }

  async withdraw(wallet: TraderWalletRuntime, noteCommitment: string, asset?: string): Promise<unknown> {
    if (!wallet.submitHostedWithdrawal) throw new Error("Wallet runtime does not expose withdrawal submission");
    return wallet.submitHostedWithdrawal({ note_commitment: noteCommitment, asset });
  }

  private async getJson<T>(url: string): Promise<T> {
    const response = await this.fetcher(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(await responseError(response));
    return (await response.json()) as T;
  }
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return `Request failed with HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown };
    const detail = parsed.error ?? parsed.detail ?? parsed.message;
    return typeof detail === "string" ? detail : text;
  } catch {
    return text;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
