import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVenueBbos } from "./venueBbo";

function response(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("fetchVenueBbos", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses only same-venue books when deriving a cross BBO", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("coinbase") && input.includes("STRK-USD")) return response({ bid: "0.0463", ask: "0.0465" });
      if (input.includes("coinbase")) return response({ message: "NotFound" }, false);
      if (input.includes("kraken") && input.includes("STRKUSDC")) return response({ result: {} });
      if (input.includes("kraken") && input.includes("STRKUSD")) return response({ result: { STRKUSD: { a: ["0.0464"], b: ["0.0462"] } } });
      if (input.includes("kraken") && input.includes("USDCUSD")) return response({ result: { USDCUSD: { a: ["1.0002"], b: ["0.9998"] } } });
      if (input.includes("okx") && input.includes("STRK-USDC")) return response({ data: [] });
      if (input.includes("okx") && input.includes("STRK-USDT")) return response({ data: [{ bids: [["0.0463"]], asks: [["0.0465"]] }] });
      if (input.includes("okx") && input.includes("USDC-USDT")) return response({ data: [{ bids: [["0.9999"]], asks: [["1.0001"]] }] });
      throw new Error(`unexpected request ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const feeds = await fetchVenueBbos("STRK", "USDC", new AbortController().signal);

    expect(feeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ venue: "Coinbase", bid: 0.0463, ask: 0.0465 }),
      expect.objectContaining({ venue: "Kraken", bid: 0.0462 / 1.0002, ask: 0.0464 / 0.9998 }),
      expect.objectContaining({ venue: "OKX", bid: 0.0463 / 1.0001, ask: 0.0465 / 0.9999 }),
    ]));
  });
});
