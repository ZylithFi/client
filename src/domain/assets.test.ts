import { afterEach, describe, expect, it } from "vitest";
import { assetDecimals, configureAssetDecimals, toAtomicStr } from "./assets";
import type { DeploymentConfig } from "./deployment";

afterEach(() => configureAssetDecimals(null));

describe("asset precision", () => {
  it("knows the traded assets' decimals", () => {
    expect(assetDecimals("STRK")).toBe(18);
    expect(assetDecimals("ETH")).toBe(18);
    expect(assetDecimals("USDC")).toBe(6);
    expect(toAtomicStr("0.001", "ETH")).toBe("1000000000000000");
  });

  it("takes each asset's decimals from the deployment manifest", () => {
    // the same asset name can be another token, with other decimals, on another network.
    configureAssetDecimals({ product: { assets: { USDC: { decimals: 18 } } } } as unknown as DeploymentConfig);
    expect(toAtomicStr("1", "USDC")).toBe("1000000000000000000");
  });
});
