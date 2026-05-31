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
  if (renewalPackage.relay_mode !== "ZylithRelay") return null;
  return postJson<ManagedRelayPackageStatus>(
    requiredManagedRelayUrl(),
    "/packages",
    renewalPackage,
  );
}

export async function fetchManagedRenewalPackageResults(
  renewalPackage: RelayAuthorizationHeaders & { package_id: string },
): Promise<ManagedRelayPackageResults | null> {
  if (!managedRelayUrl) return null;
  return fetchJson<ManagedRelayPackageResults>(
    managedRelayUrl,
    `/packages/${encodeURIComponent(renewalPackage.package_id)}/results`,
    relayAuthorizationHeaders(renewalPackage),
  );
}

export async function deleteManagedRenewalPackage(
  renewalPackage: RelayAuthorizationHeaders & {
    package_id: string;
    relay_mode?: "SelfRelay" | "ZylithRelay";
  },
): Promise<boolean> {
  if (renewalPackage.relay_mode !== "ZylithRelay" || !managedRelayUrl) return false;
  return deleteJson(
    managedRelayUrl,
    `/packages/${encodeURIComponent(renewalPackage.package_id)}`,
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
    throw new Error(await relayErrorMessage(response));
  }
  return (await response.json()) as T;
}

async function deleteJson(
  baseUrl: string,
  path: string,
  authHeaders: Record<string, string> = {},
): Promise<boolean> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: {
      ...relayHeaders(),
      ...authHeaders,
    },
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(await relayErrorMessage(response));
  }
  return true;
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
    throw new Error(await relayErrorMessage(response));
  }
  return (await response.json()) as T;
}

async function relayErrorMessage(response: Response) {
  const detail = await relayErrorDetail(response);
  return `Renewal relay request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
}

async function relayErrorDetail(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return "";
  try {
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown };
    const error = parsed.error ?? parsed.detail ?? parsed.message;
    return typeof error === "string" ? error : text;
  } catch {
    return text;
  }
}

function relayHeaders(): Record<string, string> {
  return {
    accept: "application/json",
  };
}

function requiredManagedRelayUrl() {
  if (managedRelayUrl) return managedRelayUrl;
  throw new Error("Zylith relay endpoint is not configured");
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
  if (!isLocalHost(window.location.hostname)) return "";
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

function normalizeUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function isLocalHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
