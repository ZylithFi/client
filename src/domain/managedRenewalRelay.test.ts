import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfflineRenewalPackage } from "../offlineRenewalOperator";

describe("managedRenewalRelay", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("registers managed packages without bundling a frontend bearer token", async () => {
    vi.stubEnv("VITE_ZYLITH_RENEWAL_RELAY_URL", "https://relay.zylith.example");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      package_id: "pkg-1",
      package_commitment: "0xabc",
      pair: "STRK/USDC",
      start_epoch: 1,
      end_epoch: 1,
      slot_count: 1,
      relay_mode: "ZylithRelay",
      pending_slots: 1,
      submitted_slots: 0,
      failed_slots: 0,
      updated_at_unix_ms: 1,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { submitManagedRenewalPackage } = await import("./managedRenewalRelay");

    await submitManagedRenewalPackage(zylithRelayPackage());

    expect(fetchMock).toHaveBeenCalledWith("https://relay.zylith.example/packages", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        accept: "application/json",
        "content-type": "application/json",
      }),
    }));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });
});

function zylithRelayPackage(): OfflineRenewalPackage {
  return {
    version: 1,
    package_id: "pkg-1",
    package_commitment: "0xabc",
    created_at_unix_ms: 1,
    pair: "STRK/USDC",
    start_epoch: 1,
    end_epoch: 1,
    slot_count: 1,
    relay_mode: "ZylithRelay",
    parent_cancel_authority: "0xparent",
    relay_authorization: {
      signer_public_key: "0xsigner",
      signature_r: "0xr",
      signature_s: "0xs",
    },
    relay_policy: {
      coordinator_url: "https://api.zylith.fi",
      prover_url: "https://api.zylith.fi",
      submission_safety_buffer_ms: 1000,
      max_submission_delay_ms: 0,
    },
    slots: [{
      slot_id: "pkg-1:1",
      pair: "STRK/USDC",
      batch_id: "STRK-USDC-1",
      epoch_id: 1,
      parent_child_index: 1,
      order_commitment: "0xorder",
      ingress_request: { order_submission: {} },
    }],
  };
}
