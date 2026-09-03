export type AppTab = "trade" | "orders" | "assets" | "reports";

export const TAKER_TABS: readonly AppTab[] = [
  "trade",
  "orders",
  "assets",
  "reports",
];

export function takerTabFromPath(path: string): AppTab {
  if (path === "/orders") return "orders";
  if (path === "/assets") return "assets";
  if (path === "/reports" || path === "/tca") return "reports";
  return "trade";
}

export function takerPath(tab: AppTab): string {
  return tab === "trade" ? "/trade" : tab === "reports" ? "/tca" : `/${tab}`;
}
