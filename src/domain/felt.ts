export function normalizeFeltForComparison(
  value: string | undefined | null,
): string {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return `0x${BigInt(trimmed).toString(16)}`;
  } catch {
    const normalized = trimmed.toLowerCase();
    const hex = normalized.startsWith("0x") ? normalized.slice(2) : normalized;
    return `0x${hex.replace(/^0+/, "") || "0"}`;
  }
}

export function normalizeOptionalFelt(value: string | undefined | null) {
  const normalized = normalizeFeltForComparison(value);
  return normalized && normalized !== "0x0" ? normalized : null;
}

export function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim() === "") {
    const field = label ? label[0].toUpperCase() + label.slice(1) : "Value";
    throw new Error(`${field} is required`);
  }
  return value;
}

export function requiredNonZeroFelt(value: unknown, label: string) {
  const felt = requiredString(value, label).trim();
  const normalized =
    felt.startsWith("0x") || felt.startsWith("0X") ? felt.slice(2) : felt;
  if (/^0*$/i.test(normalized)) {
    const field = label ? label[0].toUpperCase() + label.slice(1) : "Value";
    throw new Error(`${field} must be configured`);
  }
  return felt;
}
