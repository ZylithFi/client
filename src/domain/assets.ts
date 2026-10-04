import type { DeploymentConfig } from "./deployment";

let configuredAssetDecimals: Record<string, number> | null = null;
const MAX_U128 = (1n << 128n) - 1n;

export type PricePair = {
  base_asset_id: string;
  quote_asset_id: string;
  price_base_scale?: string;
};

export function configureAssetDecimals(deployment: DeploymentConfig | null): void {
  configuredAssetDecimals = deployment ? {} : null;
  const assets = deployment?.market_registry.assets ?? [];
  for (const metadata of assets) {
    const assetId = metadata.asset_id;
    if (typeof metadata.decimals === "number" && Number.isInteger(metadata.decimals) && metadata.decimals >= 0) {
      configuredAssetDecimals![assetId] = metadata.decimals;
    }
  }
}

export function assetDecimals(assetId: string): number {
  const decimals = configuredAssetDecimals?.[assetId];
  if (decimals === undefined) {
    throw new Error(`Asset ${assetId} is not defined by the loaded market registry`);
  }
  return decimals;
}

export function toAtomicStr(human: string, assetId: string): string {
  const trimmed = human.trim();
  if (!trimmed || trimmed.length > 64 || !/^\d+(?:\.\d*)?$/.test(trimmed)) {
    throw new Error("Enter a valid amount.");
  }
  const dec = assetDecimals(assetId);
  const [intPart = "0", fracPart = ""] = trimmed.split(".");
  if (fracPart.length > dec) {
    throw new Error(`${assetId} supports at most ${dec} decimal places.`);
  }
  const frac = fracPart.padEnd(dec, "0");
  const atomic = BigInt(intPart || "0") * (10n ** BigInt(dec)) + BigInt(frac || "0");
  if (atomic > MAX_U128) throw new Error("Amount is too large.");
  return atomic.toString();
}

export function fromAtomicStr(atomic: string, assetId: string): string {
  if (!atomic || atomic === "0") return "0";
  if (!/^(0|[1-9]\d{0,38})$/.test(atomic) || BigInt(atomic) > MAX_U128) {
    throw new Error("Atomic amount is invalid.");
  }
  const dec = assetDecimals(assetId);
  const n = BigInt(atomic);
  const d = 10n ** BigInt(dec);
  const int = n / d;
  const frac = n % d;
  if (frac === 0n) return int.toString();
  return `${int}.${frac.toString().padStart(dec, "0").replace(/0+$/, "")}`;
}

export function safeFromAtomicStr(
  atomic: string | bigint | number | undefined,
  assetId: string,
  fallback = "-",
): string {
  if (atomic === undefined) return fallback;
  try {
    return fromAtomicStr(String(atomic), assetId);
  } catch {
    return fallback;
  }
}

export function assetScale(assetId: string): bigint {
  return 10n ** BigInt(assetDecimals(assetId));
}

/** a price in quote atoms per `price_base_scale` base atoms, as quote units per base unit. */
export function formatPrice(priceAtoms: string, pair: PricePair): string {
  const baseScale = assetScale(pair.base_asset_id);
  const priceBaseScale = BigInt(pair.price_base_scale ?? baseScale.toString());
  if (priceBaseScale <= 0n) throw new Error("Price scale is invalid.");
  return fromAtomicStr(((BigInt(priceAtoms) * baseScale) / priceBaseScale).toString(), pair.quote_asset_id);
}

/** quote units per base unit as a price in quote atoms per `price_base_scale` base atoms. */
export function toPriceAtoms(humanQuotePerBase: string, pair: PricePair): string {
  const quoteAtomsPerBase = BigInt(toAtomicStr(humanQuotePerBase, pair.quote_asset_id));
  const priceBaseScale = BigInt(pair.price_base_scale ?? assetScale(pair.base_asset_id).toString());
  return ((quoteAtomsPerBase * priceBaseScale) / assetScale(pair.base_asset_id)).toString();
}
