import { describe, expect, it } from "vitest";
import {
  normalizeConfiguredFelt,
  normalizeFeltForComparison,
  normalizeOptionalFelt,
  normalizeStrictFelt,
  requiredNonZeroFelt,
  requiredString,
} from "./felt";

describe("felt helpers", () => {
  it("normalizes decimal and hex felt strings", () => {
    expect(normalizeFeltForComparison("26")).toBe("0x1a");
    expect(normalizeFeltForComparison("0x00001A")).toBe("0x1a");
    expect(normalizeFeltForComparison("  0X000f  ")).toBe("0xf");
  });

  it("normalizes empty and zero values", () => {
    expect(normalizeFeltForComparison(undefined)).toBe("");
    expect(normalizeFeltForComparison(null)).toBe("");
    expect(normalizeFeltForComparison("")).toBe("");
    expect(normalizeFeltForComparison("0")).toBe("0x0");
    expect(normalizeOptionalFelt("0x000")).toBeNull();
    expect(normalizeOptionalFelt("not-a-felt")).toBeNull();
    expect(
      normalizeOptionalFelt(
        "0x800000000000011000000000000000000000000000000000000000000000001",
      ),
    ).toBeNull();
  });

  it("requires non-empty strings and nonzero felts", () => {
    expect(requiredString("abc", "field")).toBe("abc");
    expect(requiredNonZeroFelt("0x01", "address")).toBe("0x01");
    expect(normalizeStrictFelt("0x01")).toBe("0x1");
    expect(normalizeConfiguredFelt("0x01")).toBe("0x1");
    expect(() => requiredString("", "field")).toThrow("Field is required");
    expect(() => requiredNonZeroFelt("0x0", "address")).toThrow(
      "Address must be configured",
    );
    expect(() => requiredNonZeroFelt("not-a-felt", "address")).toThrow(
      "Address must be a valid Starknet felt",
    );
    expect(normalizeStrictFelt("not-a-felt")).toBe("");
    expect(normalizeConfiguredFelt("0x0")).toBe("");
    expect(
      normalizeStrictFelt(
        "0x800000000000011000000000000000000000000000000000000000000000000",
      ),
    ).toBe(
      "0x800000000000011000000000000000000000000000000000000000000000000",
    );
    expect(
      normalizeStrictFelt(
        "0x800000000000011000000000000000000000000000000000000000000000001",
      ),
    ).toBe("");
  });
});
