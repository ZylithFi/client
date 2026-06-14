import { describe, expect, it, vi } from "vitest";
import type { OfflineRenewalPackage } from "../offlineRenewalOperator";
import { relayAuthorizationHeaders, ZylithRelaySdk } from "./relay";

describe("ZylithRelaySdk", () => {
  it("registers packages and fetches results with package auth headers", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/packages")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ package_id: "pkg", package_commitment: "0xpkg", pair: "ETH/USDC", start_epoch: 1, end_epoch: 2, slot_count: 2, relay_mode: "ZylithRelay", pending_slots: 2, submitted_slots: 0, failed_slots: 0, updated_at_unix_ms: 1 });
      }
      if (url.endsWith("/packages/pkg/results")) {
        expect((init?.headers as Record<string, string>)["x-zylith-relay-signature-r"]).toBe("0xr");
        return jsonResponse({ package_id: "pkg", package_commitment: "0xpkg", results: [] });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const sdk = new ZylithRelaySdk({ relayUrl: "https://relay.example/", fetchImpl });
    await expect(sdk.registerPackage(packageFixture())).resolves.toMatchObject({ package_id: "pkg" });
    await expect(sdk.packageResults(packageFixture())).resolves.toMatchObject({ package_id: "pkg" });
  });

  it("omits auth headers when package authorization is incomplete", () => {
    expect(relayAuthorizationHeaders({ package_id: "pkg" })).toEqual({});
  });
});

function packageFixture(): OfflineRenewalPackage {
  return {
    version: 1,
    package_id: "pkg",
    package_commitment: "0xpkg",
    created_at_unix_ms: 1,
    pair: "ETH/USDC",
    start_epoch: 1,
    end_epoch: 2,
    slot_count: 1,
    relay_mode: "ZylithRelay",
    parent_cancel_authority: "0xparent",
    parent_cancel_marker: "0xcancel",
    relay_authorization: {
      signer_public_key: "0xparent",
      signature_r: "0xr",
      signature_s: "0xs",
    },
    relay_policy: {
      prover_url: "https://prover.example",
      coordinator_url: "https://coordinator.example",
      submission_safety_buffer_ms: 15_000,
      max_submission_delay_ms: 0,
    },
    slots: [],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
