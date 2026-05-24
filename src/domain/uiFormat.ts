import type { BatchSummary } from "./auctionEpoch";

export function msToCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function batchState(
  batch: BatchSummary,
  now: number,
): { label: string; tone: "good" | "warn" | "info" } {
  if (batch.status === "Closed") return { label: "Closed", tone: "warn" };
  if (batch.status === "Clearing" || batch.status === "Proving") {
    return { label: "Proving", tone: "info" };
  }
  if (batch.status === "Settling") return { label: "Settling", tone: "info" };
  if (batch.status === "Settled") return { label: "Settled", tone: "info" };
  if (batch.status === "Cancelled") return { label: "Cancelled", tone: "warn" };
  const msLeft = batch.close_time_unix_ms - now;
  if (msLeft <= 15_000) return { label: "Closing", tone: "warn" };
  return { label: "Accepting", tone: "good" };
}
