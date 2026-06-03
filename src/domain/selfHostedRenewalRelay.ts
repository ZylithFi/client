import type {
  OfflineRenewalPackage,
  OfflineRenewalRelayResult,
} from "../offlineRenewalOperator";

type RelayPackageStatus = {
  package_id: string;
  package_commitment: string;
  pair: string;
  start_epoch: number;
  end_epoch: number;
  slot_count: number;
  relay_mode: "SelfRelay";
  pending_slots: number;
  submitted_slots: number;
  failed_slots: number;
  updated_at_unix_ms: number;
};

type RelayPackageResults = {
  package_id: string;
  package_commitment: string;
  results: OfflineRenewalRelayResult[];
};

const SELF_RELAY_URL_PREFIX = "zylith.self-relay-url.v1:";

export function normalizeSelfRelayUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && !isLocalHost(url.hostname)) return "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function storeSelfHostedRelayUrl(
  packageId: string,
  endpointUrl: string
): void {
  const normalized = normalizeSelfRelayUrl(endpointUrl);
  if (!packageId || !normalized) return;
  try {
    sessionStorage.setItem(selfRelayUrlKey(packageId), normalized);
    localStorage.removeItem(selfRelayUrlKey(packageId));
  } catch {
    /* noop */
  }
}

export function readSelfHostedRelayUrl(packageId: string): string {
  if (!packageId) return "";
  try {
    return sessionStorage.getItem(selfRelayUrlKey(packageId)) ?? "";
  } catch {
    return "";
  }
}

export async function submitSelfHostedRenewalPackage(
  endpointUrl: string,
  renewalPackage: OfflineRenewalPackage
): Promise<RelayPackageStatus | null> {
  const baseUrl = requiredSelfRelayUrl(endpointUrl);
  if (renewalPackage.relay_mode !== "SelfRelay") return null;
  return postJson<RelayPackageStatus>(baseUrl, "/packages", renewalPackage);
}

export async function fetchSelfHostedRenewalPackageResults(
  endpointUrl: string,
  renewalPackage: PackageAccessFields & { package_id: string }
): Promise<RelayPackageResults | null> {
  const baseUrl = normalizeSelfRelayUrl(endpointUrl);
  if (!baseUrl) return null;
  return fetchJson<RelayPackageResults>(
    baseUrl,
    `/packages/${encodeURIComponent(renewalPackage.package_id)}/results`,
    relayAuthorizationHeaders(renewalPackage)
  ).catch(() => null);
}

export async function deleteSelfHostedRenewalPackage(
  endpointUrl: string,
  renewalPackage: PackageAccessFields & {
    package_id: string;
    relay_mode?: "SelfRelay" | "ZylithRelay";
  }
): Promise<boolean> {
  const baseUrl = normalizeSelfRelayUrl(endpointUrl);
  if (renewalPackage.relay_mode !== "SelfRelay" || !baseUrl) return false;
  return deleteJson(
    baseUrl,
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
      accept: "application/json",
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
      accept: "application/json",
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
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await relayErrorMessage(response));
  return (await response.json()) as T;
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

async function relayErrorMessage(response: Response) {
  const detail = await relayErrorDetail(response);
  return `Self-hosted relay request failed with HTTP ${response.status}${
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

function requiredSelfRelayUrl(endpointUrl: string) {
  const normalized = normalizeSelfRelayUrl(endpointUrl);
  if (normalized) return normalized;
  throw new Error("Self-hosted relay endpoint is invalid or missing");
}

function selfRelayUrlKey(packageId: string) {
  return `${SELF_RELAY_URL_PREFIX}${packageId}`;
}

function isLocalHost(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}
