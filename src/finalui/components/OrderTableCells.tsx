import type { OrderRow } from "../../domain/orders";

export type OrderSortKey = "orderValue" | "time";
export type OrderSortDirection = "ascending" | "descending";

function numericValue(value: string) {
  const parsed = Number.parseFloat(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
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
  const totalValue = numericValue(total);
  const percentage = totalValue > 0 ? Math.min(100, Math.max(0, numericValue(filled) / totalValue * 100)) : 0;
  return (
    <div className="filled-progress" title={`${percentage.toFixed(1)}% filled`}>
      <div className="filled-progress-track" aria-hidden="true"><i style={{ width: `${percentage}%` }}/></div>
      <span>{filled}</span>
    </div>
  );
}
