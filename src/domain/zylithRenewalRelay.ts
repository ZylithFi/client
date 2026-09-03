import type {
  OfflineRenewalPackage,
  OfflineRenewalRelayResult,
} from "../offlineRenewalOperator";
import {
  browserSafeServiceUrl,
  localServiceUrl,
  normalizeUrl,
} from "./serviceUrls";
import {
  relayDeleteJson,
  relayGetJson,
  relayPackageAccessHeaders,
  relayPostJson,
} from "./renewalRelayHttp";

type ZylithRenewalPackageStatus = {
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
  access_token?: string;
};

type ZylithRenewalPackageResults = {
  package_id: string;
  package_commitment: string;
  results: OfflineRenewalRelayResult[];
};

const zylithRenewalRelayUrl = normalizeUrl(
  browserSafeServiceUrl(
    normalizeUrl(import.meta.env.VITE_ZYLITH_RENEWAL_RELAY_URL) ||
      localServiceUrl(3400, "relay"),
    "relay"
  )
);
const RELAY_LABEL = "Renewal relay";

export function zylithRenewalRelayConfigured(): boolean {
  return Boolean(zylithRenewalRelayUrl);
}

export async function submitZylithRenewalPackage(
  renewalPackage: OfflineRenewalPackage
): Promise<ZylithRenewalPackageStatus | null> {
  if (renewalPackage.relay_mode !== "ZylithRelay") return null;
  return relayPostJson<ZylithRenewalPackageStatus>({
    baseUrl: requiredZylithRenewalRelayUrl(),
    path: "/packages",
    label: RELAY_LABEL,
    body: renewalPackage,
  });
}

export async function fetchZylithRenewalPackageResults(
  renewalPackage: PackageAccessFields & { package_id: string }
): Promise<ZylithRenewalPackageResults | null> {
  return relayGetJson<ZylithRenewalPackageResults>({
    baseUrl: requiredZylithRenewalRelayUrl(),
    path: `/packages/${encodeURIComponent(renewalPackage.package_id)}/results`,
    label: RELAY_LABEL,
    headers: relayPackageAccessHeaders(renewalPackage.access_token),
  });
}

export async function deleteZylithRenewalPackage(
  renewalPackage: PackageAccessFields & {
    package_id: string;
    relay_mode?: "SelfRelay" | "ZylithRelay";
  }
): Promise<boolean> {
  if (renewalPackage.relay_mode !== "ZylithRelay") return false;
  return relayDeleteJson({
    baseUrl: requiredZylithRenewalRelayUrl(),
    path: `/packages/${encodeURIComponent(renewalPackage.package_id)}`,
    label: RELAY_LABEL,
    headers: relayPackageAccessHeaders(renewalPackage.access_token),
  });
}

type PackageAccessFields = {
  access_token?: string;
};

function requiredZylithRenewalRelayUrl() {
  if (zylithRenewalRelayUrl) return zylithRenewalRelayUrl;
  throw new Error("Zylith relay endpoint is not configured");
}
