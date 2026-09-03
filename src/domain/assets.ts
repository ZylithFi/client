import type { DeploymentConfig, LastClearingPrice } from "./auctionEpoch";

export const DEFAULT_ASSET_DECIMALS: Record<string, number> = {
  STRK: 18,
  ETH: 18,
  USDC: 6,
  strkBTC: 8,
  WBTC: 8,
  USDT: 6,
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

export function toPriceAtomicStr(humanQuotePerBase: string, quoteAssetId: string): string {
  return toAtomicStr(humanQuotePerBase, quoteAssetId);
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

export function formatClearingPrice(price: LastClearingPrice, pair: PricePair): string {
  try {
    const baseScale = assetScale(pair.base_asset_id);
    const priceBaseScale = BigInt(price.priceBaseScale ?? pair.price_base_scale ?? baseScale.toString());
    const quoteAtomicPerBase = (BigInt(price.clearingPrice) * baseScale) / priceBaseScale;
    return fromAtomicStr(quoteAtomicPerBase.toString(), pair.quote_asset_id);
  } catch {
    return price.clearingPrice;
  }
}

export function formatHeadroomBps(
  side: "Buy" | "Sell",
  limitPrice: string,
  clearingPrice: string,
): string {
  const bps = headroomBpsValue(side, limitPrice, clearingPrice);
  if (bps === null) return "-";
  const formatted = Math.abs(bps) >= 100
    ? bps.toFixed(0)
    : bps.toFixed(1);
  return `${bps > 0 ? "+" : ""}${formatted} bps`;
}

export function headroomBpsValue(
  side: "Buy" | "Sell",
  limitPrice: string,
  clearingPrice: string,
): number | null {
  const limit = Number(limitPrice);
  const clearing = Number(clearingPrice);
  if (!Number.isFinite(limit) || !Number.isFinite(clearing) || limit <= 0) return null;
  return side === "Buy"
    ? ((limit - clearing) / limit) * 10_000
    : ((clearing - limit) / limit) * 10_000;
}
