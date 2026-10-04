import type { OrderRow } from "../../domain/orders";

export type OrderSortKey = "orderValue" | "time";
export type OrderSortDirection = "ascending" | "descending";

function decimalParts(value: string) {
  const normalized = value.replaceAll(",", "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return { whole, fraction };
}

export function filledPercentage(filled: string, total: string) {
  const filledParts = decimalParts(filled);
  const totalParts = decimalParts(total);
  if (!filledParts || !totalParts) return 0;
  const decimals = Math.max(filledParts.fraction.length, totalParts.fraction.length);
  const integer = ({ whole, fraction }: NonNullable<ReturnType<typeof decimalParts>>) =>
    BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  const filledValue = integer(filledParts);
  const totalValue = integer(totalParts);
  if (totalValue <= 0n) return 0;
  const tenths = (filledValue * 1_000n + totalValue / 2n) / totalValue;
  return Number(tenths > 1_000n ? 1_000n : tenths) / 10;
}

export function sortOrderRows(rows: OrderRow[], key: OrderSortKey | null, direction: OrderSortDirection) {
  if (key === null) return rows;
  return [...rows].sort((left, right) => {
    if (key === "orderValue" && (left.orderValueNumeric === null || right.orderValueNumeric === null)) {
      if (left.orderValueNumeric === null && right.orderValueNumeric === null) return right.submittedAt - left.submittedAt || left.id.localeCompare(right.id);
      return left.orderValueNumeric === null ? 1 : -1;
    }
    const result = key === "time"
      ? left.submittedAt - right.submittedAt
      : left.orderValueNumeric! - right.orderValueNumeric!;
    const directed = direction === "ascending" ? result : -result;
    return directed || right.submittedAt - left.submittedAt || left.id.localeCompare(right.id);
  });
}

function SortIndicator({ direction }: { direction: OrderSortDirection | null }) {
  return (
    <svg className="table-sort-icon" viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {direction === "ascending" && <path d="m3 8 3-3 3 3"/>}
      {direction === "descending" && <path d="m3 6 3 3 3-3"/>}
      {direction === null && <><path d="m3 5 3-3 3 3"/><path d="m3 9 3 3 3-3"/></>}
    </svg>
  );
}

export function SortableTableHeader<T extends string>({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  className,
}: {
  label: string;
  sortKey: T;
  activeKey: T | null;
  direction: OrderSortDirection;
  onSort: (key: T) => void;
  className?: string;
}) {
  const active = activeKey === sortKey;
  return (
    <th className={className} aria-sort={active ? direction : "none"}>
      <button className={`table-sort${active ? " active" : ""}`} type="button" onClick={() => onSort(sortKey)}>
        {label}<SortIndicator direction={active ? direction : null}/>
      </button>
    </th>
  );
}

export function FilledProgress({ filled, total }: { filled: string; total: string }) {
  const percentage = filledPercentage(filled, total);
  return (
    <div
      className="filled-progress"
      title={`${percentage.toFixed(1)}% filled`}
      role="progressbar"
      aria-label={`${filled} of ${total} filled`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Number(percentage.toFixed(1))}
    >
      <div className="filled-progress-track" aria-hidden="true"><i style={{ width: `${percentage}%` }}/></div>
      <span>{filled}</span>
    </div>
  );
}
