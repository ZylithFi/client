export type AppTab = "trade" | "orders" | "assets" | "reports";
export type Workspace = "taker" | "liquidity";
export type LiquidityTab = "curves" | "orders" | "inventory" | "analytics";

export const LIQUIDITY_TABS: readonly LiquidityTab[] = [
  "curves",
  "orders",
  "inventory",
  "analytics",
];

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

export function liquidityTabFromPath(path: string): LiquidityTab {
  const segment = path.split("/")[2];
  if (segment === "curves") return "curves";
  if (segment === "orders") return "orders";
  if (segment === "inventory") return "inventory";
  if (segment === "analytics") return "analytics";
  return "curves";
}

export function takerPath(tab: AppTab): string {
  return tab === "trade" ? "/trade" : tab === "reports" ? "/tca" : `/${tab}`;
}

export function liquidityPath(tab: LiquidityTab): string {
  return `/liquidity/${tab}`;
}
