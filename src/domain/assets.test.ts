import { afterEach, describe, expect, it } from "vitest";
import { assetDecimals, configureAssetDecimals, fromAtomicStr, toAtomicStr } from "./assets";
import type { DeploymentConfig } from "./deployment";

afterEach(() => configureAssetDecimals(null));

describe("asset precision", () => {
  it("refuses to invent decimals before the registry is loaded", () => {
    configureAssetDecimals(null);
    expect(() => assetDecimals("STRK")).toThrow(/not defined/);
  });

  it("takes every traded asset's decimals from the market registry", () => {
    configureAssetDecimals({
      market_registry: {
        assets: [
          { asset_id: "STRK", decimals: 18 },
          { asset_id: "ETH", decimals: 18 },
          { asset_id: "USDC", decimals: 6 },
        ],
      },
    } as unknown as DeploymentConfig);
    expect(assetDecimals("STRK")).toBe(18);
    expect(assetDecimals("ETH")).toBe(18);
    expect(assetDecimals("USDC")).toBe(6);
    expect(toAtomicStr("0.001", "ETH")).toBe("1000000000000000");
  });

  it("takes each asset's decimals from the deployment manifest", () => {
    // the same asset name can be another token, with other decimals, on another network.
    configureAssetDecimals({
      market_registry: { assets: [{ asset_id: "USDC", decimals: 18 }] },
    } as unknown as DeploymentConfig);
    expect(toAtomicStr("1", "USDC")).toBe("1000000000000000000");
  });

  it("rejects malformed values instead of reinterpreting them", () => {
    configureAssetDecimals({
      market_registry: { assets: [{ asset_id: "USDC", decimals: 6 }] },
    } as unknown as DeploymentConfig);
    for (const value of ["", ".", "-1", "+1", "1e3", "1,000", "1.2.3", "  "]) {
      expect(() => toAtomicStr(value, "USDC")).toThrow(/valid amount/i);
    }
  });

  it("rejects precision that cannot be represented by the asset", () => {
    configureAssetDecimals({
      market_registry: { assets: [{ asset_id: "USDC", decimals: 6 }] },
    } as unknown as DeploymentConfig);
    expect(() => toAtomicStr("1.0000001", "USDC")).toThrow(/at most 6 decimal/i);
    expect(toAtomicStr("1.000000", "USDC")).toBe("1000000");
  });

  it("rejects values outside the protocol's u128 amount boundary", () => {
    configureAssetDecimals({
      market_registry: { assets: [{ asset_id: "USDC", decimals: 0 }] },
    } as unknown as DeploymentConfig);
    const outsideU128 = (1n << 128n).toString();
    expect(() => toAtomicStr(outsideU128, "USDC")).toThrow(/too large/i);
    expect(() => fromAtomicStr(outsideU128, "USDC")).toThrow(/invalid/i);
    expect(() => toAtomicStr("1".repeat(65), "USDC")).toThrow(/valid amount/i);
  });
});
