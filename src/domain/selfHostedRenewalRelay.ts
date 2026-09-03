import type {
  OfflineRenewalPackage,
  OfflineRenewalRelayResult,
} from "../offlineRenewalOperator";
import {
  localRemove,
  sessionGet,
  sessionSet,
} from "./safeSessionStorage";
import {
  relayDeleteJson,
  relayGetJson,
  relayPackageAccessHeaders,
  relayPostJson,
} from "./renewalRelayHttp";

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
  access_token?: string;
};

type RelayPackageResults = {
  package_id: string;
  package_commitment: string;
  results: OfflineRenewalRelayResult[];
};

const SELF_RELAY_URL_PREFIX = "zylith.self-relay-url.v1:";
const RELAY_LABEL = "Self-hosted relay";

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
  sessionSet(selfRelayUrlKey(packageId), normalized);
  localRemove(selfRelayUrlKey(packageId));
}

export function readSelfHostedRelayUrl(packageId: string): string {
  if (!packageId) return "";
  return sessionGet(selfRelayUrlKey(packageId), "");
}

export async function submitSelfHostedRenewalPackage(
  endpointUrl: string,
  renewalPackage: OfflineRenewalPackage
): Promise<RelayPackageStatus | null> {
  const baseUrl = requiredSelfRelayUrl(endpointUrl);
  if (renewalPackage.relay_mode !== "SelfRelay") return null;
  return relayPostJson<RelayPackageStatus>({
    baseUrl,
    path: "/packages",
    label: RELAY_LABEL,
    body: renewalPackage,
  });
}

export async function fetchSelfHostedRenewalPackageResults(
  endpointUrl: string,
  renewalPackage: PackageAccessFields & { package_id: string }
): Promise<RelayPackageResults | null> {
  const baseUrl = normalizeSelfRelayUrl(endpointUrl);
  if (!baseUrl) return null;
  return relayGetJson<RelayPackageResults>({
    baseUrl,
    path: `/packages/${encodeURIComponent(renewalPackage.package_id)}/results`,
    label: RELAY_LABEL,
    headers: relayPackageAccessHeaders(renewalPackage.access_token),
  });
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
  return relayDeleteJson({
    baseUrl,
    path: `/packages/${encodeURIComponent(renewalPackage.package_id)}`,
    label: RELAY_LABEL,
    headers: relayPackageAccessHeaders(renewalPackage.access_token),
  });
}

type PackageAccessFields = {
  access_token?: string;
};

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
