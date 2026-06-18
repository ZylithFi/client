import { describe, expect, it } from "vitest";
import { normalizeFeltForComparison, privateReportOrderSyncKey } from "./privateReportSync";

describe("private report sync keys", () => {
  it("normalizes decimal and hex felt strings to the same key form", () => {
    expect(normalizeFeltForComparison("26")).toBe("0x1a");
    expect(normalizeFeltForComparison("0x00001A")).toBe("0x1a");
  });

  it("normalizes empty and zero sync key values", () => {
    expect(normalizeFeltForComparison(undefined)).toBe("");
    expect(normalizeFeltForComparison(null)).toBe("");
    expect(normalizeFeltForComparison("0")).toBe("0x0");
    expect(normalizeFeltForComparison("0x000")).toBe("0x0");
  });

  it("builds sync keys only for nonzero commitments with batch ids", () => {
    expect(privateReportOrderSyncKey("batch-1", "26")).toBe("batch-1:0x1a");
    expect(privateReportOrderSyncKey("batch-1", "0x001a")).toBe("batch-1:0x1a");
    expect(privateReportOrderSyncKey("batch-1", "0")).toBe("");
    expect(privateReportOrderSyncKey("", "26")).toBe("");
  });
});
