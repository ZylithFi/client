import type { OfflineRenewalPackage, OfflineRenewalRelayResult } from "../offlineRenewalOperator";

type ManagedRelayPackageStatus = {
  package_id: string;
  package_commitment: string;
  pair: string;
  start_epoch: number;
  end_epoch: number;
  slot_count: number;
  relay_mode: "ZylithRelay";
  pending_slots: number;
  submitted_slots: number;
  failed_slots: number;
  updated_at_unix_ms: number;
};

type ManagedRelayPackageResults = {
  package_id: string;
  package_commitment: string;
  results: OfflineRenewalRelayResult[];
};

type RelayAuthorizationHeaders = {
  package_commitment?: string;
  parent_cancel_authority?: string;
  relay_authorization?: {
    signer_public_key: string;
    signature_r: string;
    signature_s: string;
  };
};

const managedRelayUrl = normalizeUrl(
  import.meta.env.VITE_ZYLITH_RENEWAL_RELAY_URL || localServiceUrl(3400),
);

export function managedRenewalRelayConfigured(): boolean {
  return Boolean(managedRelayUrl);
}

export async function submitManagedRenewalPackage(
  renewalPackage: OfflineRenewalPackage,
): Promise<ManagedRelayPackageStatus | null> {
  if (renewalPackage.relay_mode !== "ZylithRelay" || !managedRelayUrl) return null;
  return postJson<ManagedRelayPackageStatus>(managedRelayUrl, "/api/relay/packages", renewalPackage);
}

export async function fetchManagedRenewalPackageResults(
  renewalPackage: RelayAuthorizationHeaders & { package_id: string },
): Promise<ManagedRelayPackageResults | null> {
  if (!managedRelayUrl) return null;
  return fetchJson<ManagedRelayPackageResults>(
    managedRelayUrl,
    `/api/relay/packages/${encodeURIComponent(renewalPackage.package_id)}/results`,
    relayAuthorizationHeaders(renewalPackage),
  );
}

async function fetchJson<T>(
  baseUrl: string,
  path: string,
  authHeaders: Record<string, string> = {},
): Promise<T | null> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...relayHeaders(),
      ...authHeaders,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Renewal relay request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...relayHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Renewal relay request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function relayHeaders(): Record<string, string> {
  return {
    accept: "application/json",
  };
}

function relayAuthorizationHeaders(input: RelayAuthorizationHeaders): Record<string, string> {
  const auth = input.relay_authorization;
  if (!auth || !input.package_commitment || !input.parent_cancel_authority) return {};
  return {
    "x-zylith-relay-package-commitment": input.package_commitment,
    "x-zylith-relay-parent-cancel-authority": input.parent_cancel_authority,
    "x-zylith-relay-signer": auth.signer_public_key,
    "x-zylith-relay-signature-r": auth.signature_r,
    "x-zylith-relay-signature-s": auth.signature_s,
  };
}

function localServiceUrl(port: number) {
  if (typeof window === "undefined") return "";
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

function normalizeUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
