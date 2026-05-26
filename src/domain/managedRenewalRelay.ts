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

const managedRelayUrl = normalizeUrl(
  import.meta.env.VITE_ZYLITH_RENEWAL_RELAY_URL || localServiceUrl(3400),
);
const managedRelayToken = normalizeText(import.meta.env.VITE_ZYLITH_RENEWAL_RELAY_TOKEN);

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
  packageId: string,
): Promise<ManagedRelayPackageResults | null> {
  if (!managedRelayUrl) return null;
  return fetchJson<ManagedRelayPackageResults>(
    managedRelayUrl,
    `/api/relay/packages/${encodeURIComponent(packageId)}/results`,
  );
}

async function fetchJson<T>(baseUrl: string, path: string): Promise<T | null> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: relayHeaders(),
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
    ...(managedRelayToken ? { authorization: `Bearer ${managedRelayToken}` } : {}),
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
