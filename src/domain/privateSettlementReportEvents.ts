type PrivateSettlementReportListener = (count: number) => void;

const listeners = new Set<PrivateSettlementReportListener>();

export function notifyPrivateSettlementReports(count: number) {
  if (count <= 0) return;
  for (const listener of listeners) {
    try {
      listener(count);
    } catch {
      // Notification listeners are UI-only; report sync must not depend on them.
    }
  }
}

export function subscribePrivateSettlementReports(
  listener: PrivateSettlementReportListener
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
