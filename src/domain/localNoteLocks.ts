import type { LocalOrder, PrivateStrategySummary } from "./orderLifecycle";

export function normalizeLocalLockRef(value: string | undefined | null): string {
  if (!value) return "";
  try {
    return `0x${BigInt(value).toString(16)}`;
  } catch {
    const hex = value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
    return `0x${hex || "0"}`;
  }
}

export function retainedLocalNoteLockRefs(
  orders: Pick<LocalOrder, "orderCommitment">[],
  strategies: Pick<PrivateStrategySummary, "parent_order_commitment" | "submitted_children" | "status">[],
): string[] {
  const retained = new Set<string>();
  const retain = (value: string | undefined | null) => {
    const normalized = normalizeLocalLockRef(value);
    if (normalized && normalized !== "0x0") retained.add(normalized);
  };

  for (const order of orders) {
    retain(order.orderCommitment);
  }
  for (const strategy of strategies) {
    if (
      strategy.status === "completed" ||
      strategy.status === "failed" ||
      strategy.status === "cancelled"
    ) {
      continue;
    }
    retain(strategy.parent_order_commitment);
    for (const child of strategy.submitted_children) {
      retain(child.order_commitment);
    }
  }

  return [...retained];
}
