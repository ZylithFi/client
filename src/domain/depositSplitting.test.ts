import { describe, expect, it } from "vitest";
import { denominationTableForAsset, splitDepositAmount } from "./depositSplitting";

const STRK = 10n ** 18n;
const ETH = 10n ** 18n;
const USDC = 10n ** 6n;
const BTC = 10n ** 8n;

describe("deposit splitting", () => {
  it("uses fixed launch denominations for STRK", () => {
    const table = denominationTableForAsset("STRK", 18);
    expect(table).toContain(2n * STRK);
    expect(table).toContain(25_000_000n * STRK);
  });

  it("covers large launch-token denomination bands", () => {
    expect(denominationTableForAsset("USDC", 6)).toContain(1_000_000n * USDC);
    expect(denominationTableForAsset("ETH", 18)).toContain(500n * ETH);
    expect(denominationTableForAsset("strkBTC", 8)).toContain(10n * BTC);
  });

  it("splits small STRK deposits into usable inventory notes", () => {
    const chunks = splitDepositAmount(10n * STRK, "STRK", 18);
    expect(chunks).toEqual([
      5n * STRK,
      2n * STRK,
      2n * STRK,
      1n * STRK,
    ]);
  });

  it("preserves sub-denomination deposits exactly", () => {
    const chunks = splitDepositAmount(1n * STRK, "STRK", 18);
    expect(chunks).toEqual([1n * STRK]);
  });

  it("splits larger STRK deposits into bounded inventory notes", () => {
    const chunks = splitDepositAmount(123n * STRK, "STRK", 18);
    expect(chunks).toEqual([
      50n * STRK,
      25n * STRK,
      10n * STRK,
      10n * STRK,
      10n * STRK,
      10n * STRK,
      5n * STRK,
      3n * STRK,
    ]);
    expect(chunks.reduce((sum, chunk) => sum + chunk, 0n)).toBe(123n * STRK);
  });

  it("splits USD-native USDC deposits into bounded inventory notes", () => {
    const chunks = splitDepositAmount(137n * USDC, "USDC", 6);
    expect(chunks).toEqual([
      50n * USDC,
      50n * USDC,
      10n * USDC,
      10n * USDC,
      10n * USDC,
      5n * USDC,
      1n * USDC,
      1n * USDC,
    ]);
    expect(chunks.reduce((sum, chunk) => sum + chunk, 0n)).toBe(137n * USDC);
  });

  it("keeps tiny deposits compact instead of fragmenting dust notes", () => {
    expect(splitDepositAmount(2n * USDC, "USDC", 6)).toEqual([2n * USDC]);
    expect(splitDepositAmount(4n * USDC, "USDC", 6)).toEqual([4n * USDC]);
  });

  it("uses BTC-scale denominations for strkBTC", () => {
    const chunks = splitDepositAmount(BTC / 10n, "strkBTC", 8);
    expect(chunks).toEqual([
      BTC / 20n,
      BTC / 100n,
      BTC / 100n,
      BTC / 100n,
      BTC / 100n,
      BTC / 200n,
      BTC / 200n,
    ]);
    expect(chunks.reduce((sum, chunk) => sum + chunk, 0n)).toBe(BTC / 10n);
  });

  it("covers institutional-sized deposits while preserving exact value", () => {
    const chunks = splitDepositAmount(1_000_000n * USDC, "USDC", 6);
    expect(chunks).toEqual([
      500_000n * USDC,
      100_000n * USDC,
      100_000n * USDC,
      100_000n * USDC,
      100_000n * USDC,
      50_000n * USDC,
      50_000n * USDC,
    ]);
    expect(chunks.length).toBeLessThanOrEqual(8);
    expect(chunks.reduce((sum, chunk) => sum + chunk, 0n)).toBe(1_000_000n * USDC);
  });

  it("falls back to unit denominations for unlisted assets", () => {
    const table = denominationTableForAsset("NEW", 6);
    expect(table.slice(0, 3)).toEqual([1n * USDC, 5n * USDC, 10n * USDC]);
  });
});
