const usdQuoteAssets = new Set(["USDC", "USDT", "USD"]);

export function marketPricePrecision(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 8;
  if (value >= 1_000) return 2;
  if (value >= 1) return 4;
  if (value >= 0.01) return 8;
  return Math.min(12, Math.max(8, Math.ceil(-Math.log10(value)) + 4));
}

export function formatQuotedPrice(
  value: number | undefined,
  quoteAsset: string,
) {
  const numeric = value ?? 0;
  if (!Number.isFinite(numeric) || numeric <= 0) return "-";
  const formatted = numeric.toLocaleString("en-US", {
    minimumFractionDigits: numeric >= 1_000 ? 2 : 0,
    maximumFractionDigits: marketPricePrecision(numeric),
  });
  return usdQuoteAssets.has(quoteAsset)
    ? `$${formatted}`
    : `${formatted} ${quoteAsset}`;
}

export function defaultTradeAmount(asset: string) {
  if (asset === "USDC" || asset === "USDT" || asset === "USD") return "5000";
  if (asset === "strkBTC" || asset === "WBTC" || asset === "BTC") return "0.05";
  if (asset === "ETH") return "2";
  return "10000";
}
