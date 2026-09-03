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

type LiquidityAutomationPackageStatus = {
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

type LiquidityAutomationPackageResults = {
  package_id: string;
  package_commitment: string;
  results: OfflineRenewalRelayResult[];
};

const liquidityAutomationRelayUrl = normalizeUrl(
  browserSafeServiceUrl(
    normalizeUrl(import.meta.env.VITE_ZYLITH_RENEWAL_RELAY_URL) ||
      localServiceUrl(3400, "relay"),
    "relay"
  )
);
const RELAY_LABEL = "Liquidity automation relay";

export function liquidityAutomationRelayConfigured(): boolean {
  return Boolean(liquidityAutomationRelayUrl);
}

export async function submitLiquidityAutomationPackage(
  renewalPackage: OfflineRenewalPackage
): Promise<LiquidityAutomationPackageStatus | null> {
  if (renewalPackage.relay_mode !== "ZylithRelay") return null;
  return relayPostJson<LiquidityAutomationPackageStatus>({
    baseUrl: requiredLiquidityAutomationRelayUrl(),
    path: "/packages",
    label: RELAY_LABEL,
    body: renewalPackage,
  });
}

export async function fetchLiquidityAutomationPackageResults(
  renewalPackage: PackageAccessFields & { package_id: string }
): Promise<LiquidityAutomationPackageResults | null> {
  return relayGetJson<LiquidityAutomationPackageResults>({
    baseUrl: requiredLiquidityAutomationRelayUrl(),
    path: `/packages/${encodeURIComponent(renewalPackage.package_id)}/results`,
    label: RELAY_LABEL,
    headers: relayPackageAccessHeaders(renewalPackage.access_token),
  });
}

export async function deleteLiquidityAutomationPackage(
  renewalPackage: PackageAccessFields & {
    package_id: string;
    relay_mode?: "SelfRelay" | "ZylithRelay";
  }
): Promise<boolean> {
  if (renewalPackage.relay_mode !== "ZylithRelay") return false;
  return relayDeleteJson({
    baseUrl: requiredLiquidityAutomationRelayUrl(),
    path: `/packages/${encodeURIComponent(renewalPackage.package_id)}`,
    label: RELAY_LABEL,
    headers: relayPackageAccessHeaders(renewalPackage.access_token),
  });
}

type PackageAccessFields = {
  access_token?: string;
};

function requiredLiquidityAutomationRelayUrl() {
  if (liquidityAutomationRelayUrl) return liquidityAutomationRelayUrl;
  throw new Error("Zylith relay endpoint is not configured");
}
