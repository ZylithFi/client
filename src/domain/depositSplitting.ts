const DEFAULT_MAX_DEPOSIT_NOTES = 8;
const DEFAULT_SPLIT_WEIGHTS = [50n, 20n, 10n, 10n, 5n];

const DEPOSIT_DENOMINATION_TABLES: Record<string, readonly string[]> = {
  STRK: [
    "2", "5", "10", "25", "50", "100", "250", "500", "1000", "2500",
    "5000", "10000", "25000", "50000", "100000", "250000", "500000",
    "1000000", "2500000", "5000000", "10000000", "25000000",
  ],
  USDC: [
    "1", "5", "10", "50", "100", "500", "1000", "5000", "10000",
    "50000", "100000", "500000", "1000000",
  ],
  ETH: [
    "0.0003", "0.001", "0.003", "0.01", "0.03", "0.1", "0.3",
    "1", "3", "10", "30", "100", "300", "500",
  ],
  strkBTC: [
    "0.00001", "0.00005", "0.0001", "0.0005", "0.001", "0.005",
    "0.01", "0.05", "0.1", "0.5", "1", "5", "10",
  ],
  WBTC: [
    "0.00001", "0.00005", "0.0001", "0.0005", "0.001", "0.005",
    "0.01", "0.05", "0.1", "0.5", "1", "5", "10",
  ],
  USDT: [
    "1", "5", "10", "50", "100", "500", "1000", "5000", "10000",
    "50000", "100000", "500000", "1000000",
  ],
};

export function splitDepositAmount(
  rawAmount: bigint,
  assetId: string,
  decimals: number,
  maxNotes = DEFAULT_MAX_DEPOSIT_NOTES,
): bigint[] {
  if (rawAmount <= 0n) return [];
  const ascendingDenominations = denominationTableForAsset(assetId, decimals)
    .filter(denomination => denomination > 0n && denomination <= rawAmount)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (ascendingDenominations.length === 0 || maxNotes <= 1) return [rawAmount];

  const descendingDenominations = [...ascendingDenominations].reverse();
  const minDenomination = ascendingDenominations[0];
  if (ascendingDenominations.length === 1 && rawAmount <= minDenomination * 4n) {
    const exactMinCount = rawAmount / minDenomination;
    if (
      rawAmount % minDenomination === 0n &&
      exactMinCount > 1n &&
      exactMinCount <= BigInt(maxNotes)
    ) {
      return Array.from({ length: Number(exactMinCount) }, () => minDenomination);
    }
    return [rawAmount];
  }
  const chunks: bigint[] = [];
  let remaining = rawAmount;

  for (const weight of DEFAULT_SPLIT_WEIGHTS) {
    if (chunks.length >= maxNotes - 1 || remaining <= 0n) break;
    const target = roundedPercent(rawAmount, weight);
    const denomination = largestDenominationAtMost(descendingDenominations, target, remaining);
    if (!denomination) continue;
    chunks.push(denomination);
    remaining -= denomination;
  }

  for (const denomination of descendingDenominations) {
    while (remaining >= denomination && chunks.length < maxNotes - 1) {
      chunks.push(denomination);
      remaining -= denomination;
    }
  }

  if (remaining > 0n) {
    if (chunks.length === 0) return [rawAmount];
    const shouldKeepRemainderSeparate = chunks.length < maxNotes && remaining * 2n >= minDenomination;
    if (shouldKeepRemainderSeparate) {
      chunks.push(remaining);
    } else {
      chunks[chunks.length - 1] += remaining;
    }
  }

  return chunks.length > 0
    ? chunks.sort((left, right) => left > right ? -1 : left < right ? 1 : 0)
    : [rawAmount];
}

export function denominationTableForAsset(assetId: string, decimals: number): bigint[] {
  const table = DEPOSIT_DENOMINATION_TABLES[assetId];
  if (!table) throw new Error(`Deposit denominations are not configured for ${assetId}`);
  return dedupeSortedAscending(table.map(amount => parseHumanAmount(amount, decimals)));
}

function dedupeSortedAscending(values: bigint[]): bigint[] {
  return [...new Set(values.filter(value => value > 0n))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function largestDenominationAtMost(
  descendingDenominations: readonly bigint[],
  target: bigint,
  remaining: bigint,
): bigint | null {
  if (target <= 0n || remaining <= 0n) return null;
  return descendingDenominations.find(denomination =>
    denomination <= target && denomination <= remaining,
  ) ?? null;
}

function roundedPercent(amount: bigint, percent: bigint): bigint {
  return (amount * percent + 50n) / 100n;
}

function parseHumanAmount(value: string, decimals: number): bigint {
  const [whole = "0", fractional = ""] = value.split(".");
  const safeDecimals = Math.max(0, decimals);
  const normalizedFraction = fractional.padEnd(safeDecimals, "0").slice(0, safeDecimals);
  return BigInt(whole || "0") * 10n ** BigInt(safeDecimals) +
    BigInt(normalizedFraction || "0");
}
