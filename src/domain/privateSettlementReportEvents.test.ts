import { describe, expect, it, vi } from "vitest";
import {
  notifyPrivateSettlementReports,
  subscribePrivateSettlementReports,
} from "./privateSettlementReportEvents";

describe("private settlement report notifications", () => {
  it("notifies internal subscribers with counts without dispatching report bodies on window", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const listener = vi.fn();
    const unsubscribe = subscribePrivateSettlementReports(listener);

    notifyPrivateSettlementReports(2);
    notifyPrivateSettlementReports(0);
    unsubscribe();
    notifyPrivateSettlementReports(3);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(2);
    expect(dispatchSpy).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it("isolates listener failures from other subscribers", () => {
    const throwing = vi.fn(() => {
      throw new Error("listener failed");
    });
    const listener = vi.fn();
    const unsubscribeThrowing = subscribePrivateSettlementReports(throwing);
    const unsubscribe = subscribePrivateSettlementReports(listener);

    expect(() => notifyPrivateSettlementReports(1)).not.toThrow();

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1);
    unsubscribeThrowing();
    unsubscribe();
  });
});
