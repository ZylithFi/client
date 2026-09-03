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
  const normalized = normalizeStrictFelt(value);
  return normalized && normalized !== "0x0" ? normalized : null;
}

export const STARKNET_FIELD_PRIME =
  3618502788666131213697322783095070105623107215331596699973092056135872020481n;

export function normalizeStrictFelt(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = BigInt(trimmed);
    if (parsed < 0n || parsed >= STARKNET_FIELD_PRIME) return "";
    return `0x${parsed.toString(16)}`;
  } catch {
    return "";
  }
}

export function normalizeConfiguredFelt(value: unknown): string {
  const normalized = normalizeStrictFelt(value);
  return normalized === "0x0" ? "" : normalized;
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
  const normalized = normalizeStrictFelt(felt);
  const field = label ? label[0].toUpperCase() + label.slice(1) : "Value";
  if (!normalized) {
    throw new Error(`${field} must be a valid Starknet felt`);
  }
  if (normalized === "0x0") {
    throw new Error(`${field} must be configured`);
  }
  return felt;
}
