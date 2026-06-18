import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDemoOrdersFixture,
  demoOrdersFixtureEnabled,
} from "./demoOrdersFixture";

describe("demo orders fixture", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/trade");
  });

  it("builds representative maker and taker order data", () => {
    const fixture = buildDemoOrdersFixture(1_700_000_000_000);

    expect(fixture.orders.length).toBeGreaterThan(20);
    expect(fixture.strategies).toHaveLength(4);
    expect(fixture.batches.some((batch) => batch.status === "Settled")).toBe(true);
    expect(fixture.pendingDeposits).toHaveLength(1);
    expect(fixture.withdrawableNotes).toHaveLength(3);
    expect(fixture.settlementTranscripts["demo-batch-103"]).toMatchObject({
      pair_id: "STRK/USDC",
      batch_epoch: 103,
    });
  });

  it("persists dev demo activation from the URL", () => {
    window.history.replaceState(null, "", "/orders?demo=orders");

    expect(demoOrdersFixtureEnabled()).toBe(true);

    window.history.replaceState(null, "", "/orders");
    expect(demoOrdersFixtureEnabled()).toBe(true);
  });
});
