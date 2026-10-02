import { describe, expect, it } from "vitest";
import type { OrderRow } from "../../domain/orders";
import { sortOrderRows } from "./OrderTableCells";

function row(id: string, orderValueNumeric: number | null, submittedAt: number): OrderRow {
  return {
    id,
    pair: "STRK/USDC",
    side: "Buy",
    state: "live",
    external: false,
    amount: "1",
    filled: "0",
    orderValue: "1 USDC",
    orderValueNumeric,
    averagePrice: "Not filled",
    fees: "None",
    submittedAt,
    recoveryAvailable: false,
  };
}

describe("order table sorting", () => {
  it("sorts order values in a common numeraire and keeps unavailable values last", () => {
    const rows = [row("small", 10, 1), row("unknown", null, 3), row("large", 100, 2)];
    expect(sortOrderRows(rows, "orderValue", "descending").map((item) => item.id)).toEqual(["large", "small", "unknown"]);
    expect(sortOrderRows(rows, "orderValue", "ascending").map((item) => item.id)).toEqual(["small", "large", "unknown"]);
  });

  it("sorts time deterministically", () => {
    const rows = [row("older", 10, 1), row("newer", 10, 2)];
    expect(sortOrderRows(rows, "time", "descending").map((item) => item.id)).toEqual(["newer", "older"]);
  });
});
