import { describe, expect, it } from "vitest";
import type { OrderRow } from "../../domain/orders";
import { filledPercentage, sortOrderRows } from "./OrderTableCells";

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

describe("filled progress", () => {
  it("computes a bounded percentage without floating-point precision loss", () => {
    expect(filledPercentage("0.1", "0.3")).toBe(33.3);
    expect(filledPercentage("340282366920938463463374607431768211454", "340282366920938463463374607431768211455")).toBe(100);
    expect(filledPercentage("2", "1")).toBe(100);
    expect(filledPercentage("invalid", "1")).toBe(0);
    expect(filledPercentage("1", "0")).toBe(0);
  });
});
