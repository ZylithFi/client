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
  if (!quoteAsset || !Number.isFinite(numeric) || numeric <= 0) return "Unavailable";
  const formatted = numeric.toLocaleString("en-US", {
    minimumFractionDigits: numeric >= 1_000 ? 2 : 0,
    maximumFractionDigits: marketPricePrecision(numeric),
  });
  return `${formatted} ${quoteAsset}`;
}

export function defaultTradeAmount(_asset: string) {
  return "1";
}
