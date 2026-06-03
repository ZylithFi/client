import { describe, expect, it, vi } from "vitest";
import { relayOfflineRenewalPackage, type OfflineRenewalPackage } from "./offlineRenewalOperator";

describe("offlineRenewalOperator", () => {
  it("requires renewal cancellation metadata", async () => {
    const renewalPackage = selfRelayPackage();
    delete (renewalPackage as { parent_cancel_marker?: string }).parent_cancel_marker;

    await expect(relayOfflineRenewalPackage(renewalPackage, {
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })).rejects.toThrow("Offline renewal package cancellation marker is missing");
  });

  it("rejects packages that fail injected package verification", async () => {
    await expect(relayOfflineRenewalPackage(selfRelayPackage(), {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      verifyPackage: () => false,
    })).rejects.toThrow("Offline renewal package authorization is invalid");
  });

  it("does not reuse funding after a prior proof failure", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/pairs/STRK/USDC/batches/current")) {
        return jsonResponse({
          batch_id: "STRK-USDC-2",
          pair_id: "STRK/USDC",
          epoch_id: 2,
          close_time_unix_ms: Date.now() + 60_000,
          status: "Open",
        });
      }
      if (url.includes("/api/renewal/cancel-markers/")) {
        return jsonResponse({ recorded: false });
      }
      if (url.includes("/api/public/proof-jobs/STRK-USDC-1")) {
        return jsonResponse({ state: "proof-failed", failure: "temporary prover failure" });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const results = await relayOfflineRenewalPackage(selfRelayPackage(), {
      fetchImpl: fetchMock,
      submittedOrderCommitments: ["0xorder1"],
      now: () => Date.now(),
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe("already_submitted");
    expect(results[1]?.status).toBe("awaiting_settlement");
    expect(results[1]?.detail).toContain("proof failed");
  });

  it("injects package attestation fields before private ingress", async () => {
    const renewalPackage = selfRelayPackage();
    renewalPackage.end_epoch = 1;
    renewalPackage.slot_count = 1;
    renewalPackage.slots = [renewalPackage.slots[0]!];
    let ingressBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/pairs/STRK/USDC/batches/current")) {
        return jsonResponse({
          batch_id: "STRK-USDC-1",
          pair_id: "STRK/USDC",
          epoch_id: 1,
          close_time_unix_ms: Date.now() + 60_000,
          status: "Open",
        });
      }
      if (url.includes("/api/renewal/cancel-markers/")) {
        return jsonResponse({ recorded: false });
      }
      if (url.includes("/api/private/orders")) {
        ingressBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({
          receipt: {
            order_commitment: "0xorder1",
            pair_id: "STRK/USDC",
            batch_id: "STRK-USDC-1",
            epoch_id: 1,
            relay_mode: "SelfRelay",
            renewal_package_id: "pkg-1",
            renewal_package_commitment: "0xpackage",
          },
          coordinator_submission: {
            order_commitment: "0xorder1",
            batch_id: "STRK-USDC-1",
          },
        });
      }
      if (url.includes("/api/orders")) {
        return jsonResponse({
          order_commitment: "0xorder1",
          batch_id: "STRK-USDC-1",
          accepted_at_unix_ms: Date.now(),
        });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const results = await relayOfflineRenewalPackage(renewalPackage, {
      fetchImpl: fetchMock,
      now: () => Date.now(),
    });

    expect(results[0]?.status).toBe("submitted");
    expect(ingressBody).toMatchObject({
      renewal_package_id: "pkg-1",
      renewal_package_commitment: "0xpackage",
      renewal_relay_mode: "SelfRelay",
      renewal_slot_order_commitment: "0xorder1",
      renewal_slot_pair: "STRK/USDC",
      renewal_slot_batch_id: "STRK-USDC-1",
      renewal_slot_epoch_id: 1,
    });
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function selfRelayPackage(): OfflineRenewalPackage {
  return {
    version: 1,
    package_id: "pkg-1",
    package_commitment: "0xpackage",
    created_at_unix_ms: 1,
    pair: "STRK/USDC",
    start_epoch: 1,
    end_epoch: 2,
    slot_count: 2,
    relay_mode: "SelfRelay",
    parent_cancel_authority: "0xparent",
    parent_cancel_marker: "0xcancel",
    relay_policy: {
      coordinator_url: "https://coordinator.example",
      prover_url: "https://prover.example",
      submission_safety_buffer_ms: 1_000,
      max_submission_delay_ms: 0,
    },
    slots: [
      {
        slot_id: "pkg-1:1",
        pair: "STRK/USDC",
        batch_id: "STRK-USDC-1",
        epoch_id: 1,
        parent_child_index: 1,
        order_commitment: "0xorder1",
        funding_note_commitments: ["0xlabel"],
        ingress_request: { order_submission: {} },
      },
      {
        slot_id: "pkg-1:2",
        pair: "STRK/USDC",
        batch_id: "STRK-USDC-2",
        epoch_id: 2,
        parent_child_index: 2,
        order_commitment: "0xorder2",
        funding_note_commitments: ["0xlabel"],
        ingress_request: { order_submission: {} },
      },
    ],
  };
}
