import type {
  OfflineRenewalPackage,
  OfflineRenewalRelayResult,
} from "../offlineRenewalOperator";
import { localServiceUrl, normalizeUrl } from "./serviceUrls";

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
  import.meta.env.VITE_ZYLITH_RENEWAL_RELAY_URL || localServiceUrl(3400)
);

export function managedRenewalRelayConfigured(): boolean {
  return Boolean(managedRelayUrl);
}

export async function submitManagedRenewalPackage(
  renewalPackage: OfflineRenewalPackage
): Promise<ManagedRelayPackageStatus | null> {
  if (renewalPackage.relay_mode !== "ZylithRelay") return null;
  return postJson<ManagedRelayPackageStatus>(
    requiredManagedRelayUrl(),
    "/packages",
    renewalPackage
  );
}

export async function fetchManagedRenewalPackageResults(
  renewalPackage: PackageAccessFields & { package_id: string }
): Promise<ManagedRelayPackageResults | null> {
  return fetchJson<ManagedRelayPackageResults>(
    requiredManagedRelayUrl(),
    `/packages/${encodeURIComponent(renewalPackage.package_id)}/results`,
    relayAuthorizationHeaders(renewalPackage)
  ).catch(() => null);
}

export async function deleteManagedRenewalPackage(
  renewalPackage: PackageAccessFields & {
    package_id: string;
    relay_mode?: "SelfRelay" | "ZylithRelay";
  }
): Promise<boolean> {
  if (renewalPackage.relay_mode !== "ZylithRelay") return false;
  return deleteJson(
    requiredManagedRelayUrl(),
    `/packages/${encodeURIComponent(renewalPackage.package_id)}`,
    relayAuthorizationHeaders(renewalPackage)
  ).catch(() => false);
}

type PackageAccessFields = {
  package_commitment?: string;
  parent_cancel_authority?: string;
  relay_authorization?: OfflineRenewalPackage["relay_authorization"];
};

async function fetchJson<T>(
  baseUrl: string,
  path: string,
  authHeaders: Record<string, string> = {}
): Promise<T | null> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...relayHeaders(),
      ...authHeaders,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await relayErrorMessage(response));
  return (await response.json()) as T;
}

async function deleteJson(
  baseUrl: string,
  path: string,
  authHeaders: Record<string, string> = {}
): Promise<boolean> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: {
      ...relayHeaders(),
      ...authHeaders,
    },
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(await relayErrorMessage(response));
  return true;
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<T> {
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
  return `Renewal relay request failed with HTTP ${response.status}${
    detail ? `: ${detail}` : ""
  }`;
}

async function relayErrorDetail(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return "";
  try {
    const parsed = JSON.parse(text) as {
      error?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    const error = parsed.error ?? parsed.detail ?? parsed.message;
    return typeof error === "string" ? error : text;
  } catch {
    return text;
  }
}

function relayHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  return headers;
}

function relayAuthorizationHeaders(
  renewalPackage: PackageAccessFields
): Record<string, string> {
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
    "x-zylith-relay-parent-cancel-authority":
      renewalPackage.parent_cancel_authority,
    "x-zylith-relay-signer": auth.signer_public_key,
    "x-zylith-relay-signature-r": auth.signature_r,
    "x-zylith-relay-signature-s": auth.signature_s,
  };
}

function requiredManagedRelayUrl() {
  if (managedRelayUrl) return managedRelayUrl;
  throw new Error("Zylith relay endpoint is not configured");
}
