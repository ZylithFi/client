import type { DeploymentConfig } from "./deployment";

export const DEFAULT_ASSET_DECIMALS: Record<string, number> = {
  STRK: 18,
  ETH: 18,
  USDC: 6,
};

let configuredAssetDecimals: Record<string, number> = { ...DEFAULT_ASSET_DECIMALS };

export type PricePair = {
  base_asset_id: string;
  quote_asset_id: string;
  price_base_scale?: string;
};

export function configureAssetDecimals(deployment: DeploymentConfig | null): void {
  configuredAssetDecimals = { ...DEFAULT_ASSET_DECIMALS };
  const assets = deployment?.product.assets ?? {};
  for (const [assetId, metadata] of Object.entries(assets)) {
    if (typeof metadata.decimals === "number" && Number.isInteger(metadata.decimals) && metadata.decimals >= 0) {
      configuredAssetDecimals[assetId] = metadata.decimals;
    }
  }
}

export function assetDecimals(assetId: string): number {
  return configuredAssetDecimals[assetId] ?? DEFAULT_ASSET_DECIMALS[assetId] ?? 18;
}

export function toAtomicStr(human: string, assetId: string): string {
  const trimmed = human.trim();
  if (!trimmed || !/^\d*(\.\d*)?$/.test(trimmed) || trimmed === ".") return "0";
  const dec = assetDecimals(assetId);
  const [intPart = "0", fracPart = ""] = trimmed.split(".");
  const frac = fracPart.padEnd(dec, "0").slice(0, dec);
  return (BigInt(intPart || "0") * (10n ** BigInt(dec)) + BigInt(frac || "0")).toString();
}

export function fromAtomicStr(atomic: string, assetId: string): string {
  if (!atomic || atomic === "0") return "0";
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
  try {
    const baseScale = assetScale(pair.base_asset_id);
    const priceBaseScale = BigInt(pair.price_base_scale ?? baseScale.toString());
    return fromAtomicStr(((BigInt(priceAtoms) * baseScale) / priceBaseScale).toString(), pair.quote_asset_id);
  } catch {
    return priceAtoms;
  }
}

/** quote units per base unit as a price in quote atoms per `price_base_scale` base atoms. */
export function toPriceAtoms(humanQuotePerBase: string, pair: PricePair): string {
  const quoteAtomsPerBase = BigInt(toAtomicStr(humanQuotePerBase, pair.quote_asset_id));
  const priceBaseScale = BigInt(pair.price_base_scale ?? assetScale(pair.base_asset_id).toString());
  return ((quoteAtomsPerBase * priceBaseScale) / assetScale(pair.base_asset_id)).toString();
}
