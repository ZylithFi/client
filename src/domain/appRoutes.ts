export type AppTab = "trade" | "orders" | "assets";

export const TAKER_TABS: readonly AppTab[] = [
  "trade",
  "orders",
  "assets",
];

export function takerTabFromPath(path: string): AppTab {
  if (path === "/orders") return "orders";
  if (path === "/assets") return "assets";
  return "trade";
}

export function takerPath(tab: AppTab): string {
  return tab === "trade" ? "/trade" : `/${tab}`;
}
