import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBatchTranscripts, apiProofJobStatuses } from "./auctionEpoch";

describe("auction epoch public artifact fetchers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pages settlement transcript batch IDs instead of issuing one large URL", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/api/batches/transcripts?");
      const ids = batchIdsFromUrl(url);
      expect(ids.length).toBeLessThanOrEqual(16);
      return jsonResponse(ids.map((batch_id) => ({
        batch_id,
        pair_id: "STRK/ETH",
        batch_epoch: Number(batch_id.replace("batch-", "")),
        clearing_price: "1",
      })));
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const ids = Array.from({ length: 40 }, (_, index) => `batch-${index}`);
    const transcripts = await apiBatchTranscripts(ids);

    expect(transcripts).toHaveLength(40);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("deduplicates proof-job batch IDs before paging", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const ids = batchIdsFromUrl(String(input));
      expect(ids.length).toBeLessThanOrEqual(16);
      return jsonResponse(ids.map((batch_id) => ({
        batch_id,
        state: "confirmed-onchain",
        witness_available: false,
        proof_artifact_available: false,
        onchain_submission_available: true,
        updated_at_unix_ms: 1,
      })));
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const ids = Array.from({ length: 20 }, (_, index) => `batch-${index % 10}`);
    const statuses = await apiProofJobStatuses(ids);

    expect(statuses).toHaveLength(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function batchIdsFromUrl(url: string): string[] {
  const parsed = new URL(url);
  return (parsed.searchParams.get("batch_ids") ?? "")
    .split(",")
    .filter(Boolean);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
