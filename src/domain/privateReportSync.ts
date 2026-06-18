export { normalizeFeltForComparison } from "./felt";

import { normalizeFeltForComparison } from "./felt";

export function privateReportOrderSyncKey(
  batchId: string | undefined | null,
  orderCommitment: string | undefined | null
): string {
  if (!batchId) return "";
  const normalizedCommitment = normalizeFeltForComparison(orderCommitment);
  if (!normalizedCommitment || normalizedCommitment === "0x0") return "";
  return `${batchId}:${normalizedCommitment}`;
}
