import {
  DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
  fetchWithSdkTimeout,
  normalizeSdkServiceUrl,
  readSdkJsonResponse,
  readSdkResponseText,
  sanitizeSdkErrorMessage,
} from "./common.js";
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
  access_token?: string;
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
  access_token?: string;
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
  access_token?: string;
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
    this.relayUrl = normalizeSdkServiceUrl(options.relayUrl, "relayUrl");
    this.fetcher = options.fetchImpl ?? defaultFetch();
  }

  async registerPackage(renewalPackage: OfflineRenewalPackage): Promise<RelayPackageStatus> {
    const value = await this.postJson("/packages", renewalPackage);
    return parseRelayPackageStatus(value, renewalPackage, true);
  }

  async packageStatus(renewalPackage: PackageAuthFields): Promise<RelayPackageStatus | null> {
    const value = await this.getJson(
      `/packages/${encodeURIComponent(renewalPackage.package_id)}`,
      relayAccessHeaders(renewalPackage)
    );
    return value === null ? null : parseRelayPackageStatus(value, renewalPackage, false);
  }

  async packageResults(renewalPackage: PackageAuthFields): Promise<RelayPackageResults | null> {
    const value = await this.getJson(
      `/packages/${encodeURIComponent(renewalPackage.package_id)}/results`,
      relayAccessHeaders(renewalPackage)
    );
    return value === null ? null : parseRelayPackageResults(value, renewalPackage);
  }

  async tombstonePackage(renewalPackage: PackageAuthFields): Promise<boolean> {
    const response = await fetchWithSdkTimeout(
      this.fetcher,
      `${this.relayUrl}/packages/${encodeURIComponent(renewalPackage.package_id)}`,
      {
        method: "DELETE",
        headers: {
          accept: "application/json",
          ...relayAccessHeaders(renewalPackage),
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

  private async getJson(path: string, headers: Record<string, string>): Promise<unknown | null> {
    const response = await fetchWithSdkTimeout(this.fetcher, `${this.relayUrl}${path}`, {
      headers: { accept: "application/json", ...headers },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await responseError(response));
    return readSdkJsonResponse(response, { label: "Relay response" });
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const response = await fetchWithSdkTimeout(this.fetcher, `${this.relayUrl}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await responseError(response));
    return readSdkJsonResponse(response, { label: "Relay response" });
  }
}

export function relayAccessHeaders(renewalPackage: PackageAuthFields): Record<string, string> {
  const accessToken = renewalPackage.access_token?.trim();
  if (!accessToken) {
    throw new Error("Renewal relay package access token is missing");
  }
  return {
    "x-zylith-relay-package-access-token": accessToken,
  };
}

async function responseError(response: Response): Promise<string> {
  const text = await readSdkResponseText(response, {
    maxBytes: DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
    label: "Relay error response",
  }).catch(() => "");
  if (!text.trim()) return `Relay request failed with HTTP ${response.status}`;
  return sanitizeSdkErrorMessage(text, `Relay request failed with HTTP ${response.status}`);
}

function defaultFetch(): typeof fetch {
  return fetch.bind(globalThis);
}

function parseRelayPackageStatus(
  value: unknown,
  expected: { package_id: string; package_commitment?: string },
  requireAccessToken: boolean
): RelayPackageStatus {
  const record = objectRecord(value, "Relay package status");
  const packageId = requiredString(record.package_id, "relay package id");
  const packageCommitment = requiredString(record.package_commitment, "relay package commitment");
  if (packageId !== expected.package_id) throw new Error("Relay returned status for the wrong package");
  if (expected.package_commitment && packageCommitment !== expected.package_commitment) {
    throw new Error("Relay returned status for the wrong package commitment");
  }
  const relayMode = requiredString(record.relay_mode, "relay mode");
  if (relayMode !== "SelfRelay" && relayMode !== "ZylithRelay") {
    throw new Error("Relay returned an invalid relay mode");
  }
  const accessToken = optionalString(record.access_token, "relay package access token");
  if (requireAccessToken && !accessToken) {
    throw new Error("Relay registration response omitted the package access token");
  }
  const slotCount = nonNegativeSafeInteger(record.slot_count, "relay slot count");
  const pendingSlots = boundedCount(record.pending_slots, "pending relay slots", slotCount);
  const submittedSlots = boundedCount(record.submitted_slots, "submitted relay slots", slotCount);
  const failedSlots = boundedCount(record.failed_slots, "failed relay slots", slotCount);
  if (submittedSlots + failedSlots > slotCount) {
    throw new Error("Relay package status contains impossible slot counts");
  }
  return {
    package_id: packageId,
    package_commitment: packageCommitment,
    pair: requiredString(record.pair, "relay package pair"),
    start_epoch: nonNegativeSafeInteger(record.start_epoch, "relay start epoch"),
    end_epoch: nonNegativeSafeInteger(record.end_epoch, "relay end epoch"),
    slot_count: slotCount,
    relay_mode: relayMode,
    pending_slots: pendingSlots,
    submitted_slots: submittedSlots,
    failed_slots: failedSlots,
    updated_at_unix_ms: nonNegativeSafeInteger(record.updated_at_unix_ms, "relay update time"),
    access_token: accessToken,
  };
}

function parseRelayPackageResults(
  value: unknown,
  expected: { package_id: string; package_commitment?: string }
): RelayPackageResults {
  const record = objectRecord(value, "Relay package results");
  const packageId = requiredString(record.package_id, "relay package id");
  const packageCommitment = requiredString(record.package_commitment, "relay package commitment");
  if (packageId !== expected.package_id) throw new Error("Relay returned results for the wrong package");
  if (expected.package_commitment && packageCommitment !== expected.package_commitment) {
    throw new Error("Relay returned results for the wrong package commitment");
  }
  if (!Array.isArray(record.results)) throw new Error("Relay package results must be an array");
  return {
    package_id: packageId,
    package_commitment: packageCommitment,
    results: record.results.map((entry, index) => parseRelayResult(entry, index)),
  };
}

function parseRelayResult(value: unknown, index: number): OfflineRenewalRelayResult {
  const record = objectRecord(value, `Relay result ${index}`);
  return {
    package_id: optionalString(record.package_id, "relay result package id"),
    slot_index: optionalNonNegativeSafeInteger(record.slot_index, "relay result slot index"),
    order_commitment: optionalString(record.order_commitment, "relay result order commitment"),
    batch_id: optionalString(record.batch_id, "relay result batch id"),
    epoch_id: optionalNonNegativeSafeInteger(record.epoch_id, "relay result epoch"),
    status: optionalString(record.status, "relay result status"),
    detail: optionalString(record.detail, "relay result detail"),
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
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}

function optionalNonNegativeSafeInteger(value: unknown, label: string): number | undefined {
  return value === undefined || value === null ? undefined : nonNegativeSafeInteger(value, label);
}

function boundedCount(value: unknown, label: string, maximum: number): number {
  const count = nonNegativeSafeInteger(value, label);
  if (count > maximum) throw new Error(`Invalid ${label}`);
  return count;
}
