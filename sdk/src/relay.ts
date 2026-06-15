import type { RelayMode } from "./common.js";

export type OfflineRenewalRelayResult = {
  package_id?: string;
  slot_index?: number;
  order_commitment?: string;
  batch_id?: string;
  epoch_id?: number;
  status?: string;
  detail?: string;
};

export type OfflineRenewalPackage = {
  version: number;
  package_id: string;
  package_commitment: string;
  created_at_unix_ms: number;
  pair: string;
  start_epoch: number;
  end_epoch: number;
  slot_count: number;
  relay_mode: RelayMode;
  parent_cancel_authority: string;
  parent_cancel_marker: string;
  relay_authorization?: {
    signer_public_key?: string;
    signature_r?: string;
    signature_s?: string;
  };
  relay_policy?: {
    prover_url?: string;
    coordinator_url?: string;
    submission_safety_buffer_ms?: number;
    max_submission_delay_ms?: number;
  };
  slots: unknown[];
};

export type RelayPackageStatus = {
  package_id: string;
  package_commitment: string;
  pair: string;
  start_epoch: number;
  end_epoch: number;
  slot_count: number;
  relay_mode: RelayMode;
  pending_slots: number;
  submitted_slots: number;
  failed_slots: number;
  updated_at_unix_ms: number;
};

export type RelayPackageResults = {
  package_id: string;
  package_commitment: string;
  results: OfflineRenewalRelayResult[];
};

export type RelaySdkOptions = {
  relayUrl: string;
  fetchImpl?: typeof fetch;
};

export type PackageAuthFields = {
  package_id: string;
  package_commitment?: string;
  parent_cancel_authority?: string;
  relay_authorization?: OfflineRenewalPackage["relay_authorization"];
};

export type SelfHostedRelayExecutor = (
  renewalPackage: OfflineRenewalPackage,
  options: {
    coordinatorUrl?: string;
    proverUrl?: string;
    submittedOrderCommitments?: Iterable<string>;
    verifyPackage?: (renewalPackage: OfflineRenewalPackage) => Promise<boolean> | boolean;
    fetchImpl?: typeof fetch;
  }
) => Promise<OfflineRenewalRelayResult[]>;

export class ZylithRelaySdk {
  private readonly relayUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: RelaySdkOptions) {
    this.relayUrl = stripTrailingSlash(options.relayUrl);
    this.fetcher = options.fetchImpl ?? defaultFetch();
  }

  async registerPackage(renewalPackage: OfflineRenewalPackage): Promise<RelayPackageStatus> {
    return this.postJson<RelayPackageStatus>("/packages", renewalPackage);
  }

  async packageStatus(renewalPackage: PackageAuthFields): Promise<RelayPackageStatus | null> {
    return this.getJson<RelayPackageStatus>(
      `/packages/${encodeURIComponent(renewalPackage.package_id)}`,
      relayAuthorizationHeaders(renewalPackage)
    );
  }

  async packageResults(renewalPackage: PackageAuthFields): Promise<RelayPackageResults | null> {
    return this.getJson<RelayPackageResults>(
      `/packages/${encodeURIComponent(renewalPackage.package_id)}/results`,
      relayAuthorizationHeaders(renewalPackage)
    );
  }

  async tombstonePackage(renewalPackage: PackageAuthFields): Promise<boolean> {
    const response = await this.fetcher(
      `${this.relayUrl}/packages/${encodeURIComponent(renewalPackage.package_id)}`,
      {
        method: "DELETE",
        headers: {
          accept: "application/json",
          ...relayAuthorizationHeaders(renewalPackage),
        },
      }
    );
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(await responseError(response));
    return true;
  }

  async relaySelfHostedPackage(
    renewalPackage: OfflineRenewalPackage,
    executor: SelfHostedRelayExecutor,
    options: {
      coordinatorUrl?: string;
      proverUrl?: string;
      submittedOrderCommitments?: Iterable<string>;
      verifyPackage?: (renewalPackage: OfflineRenewalPackage) => Promise<boolean> | boolean;
    } = {}
  ): Promise<OfflineRenewalRelayResult[]> {
    return executor(renewalPackage, {
      ...options,
      fetchImpl: this.fetcher,
    });
  }

  private async getJson<T>(path: string, headers: Record<string, string>): Promise<T | null> {
    const response = await this.fetcher(`${this.relayUrl}${path}`, {
      headers: { accept: "application/json", ...headers },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await responseError(response));
    return (await response.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetcher(`${this.relayUrl}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await responseError(response));
    return (await response.json()) as T;
  }
}

export function relayAuthorizationHeaders(renewalPackage: PackageAuthFields): Record<string, string> {
  const auth = renewalPackage.relay_authorization;
  if (
    !renewalPackage.package_commitment ||
    !renewalPackage.parent_cancel_authority ||
    !auth?.signer_public_key ||
    !auth.signature_r ||
    !auth.signature_s
  ) {
    return {};
  }
  return {
    "x-zylith-relay-package-commitment": renewalPackage.package_commitment,
    "x-zylith-relay-parent-cancel-authority": renewalPackage.parent_cancel_authority,
    "x-zylith-relay-signer": auth.signer_public_key,
    "x-zylith-relay-signature-r": auth.signature_r,
    "x-zylith-relay-signature-s": auth.signature_s,
  };
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return `Relay request failed with HTTP ${response.status}`;
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

function defaultFetch(): typeof fetch {
  return fetch.bind(globalThis);
}
