import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfflineRenewalPackage } from "../offlineRenewalOperator";
import {
  deleteSelfHostedRenewalPackage,
  fetchSelfHostedRenewalPackageResults,
  normalizeSelfRelayUrl,
  submitSelfHostedRenewalPackage,
} from "./selfHostedRenewalRelay";

describe("selfHostedRenewalRelay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes HTTPS and local relay endpoints", () => {
    expect(normalizeSelfRelayUrl("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(normalizeSelfRelayUrl("http://localhost:3400/")).toBe("http://localhost:3400");
  });

  it("rejects insecure non-local relay endpoints", () => {
    expect(normalizeSelfRelayUrl("http://relay.example.com")).toBe("");
    expect(normalizeSelfRelayUrl("not a url")).toBe("");
  });

  it("posts only SelfRelay packages to the configured endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      package_id: "pkg-1",
      package_commitment: "0xabc",
      pair: "STRK/USDC",
      start_epoch: 1,
      end_epoch: 1,
      slot_count: 1,
      relay_mode: "SelfRelay",
      pending_slots: 1,
      submitted_slots: 0,
      failed_slots: 0,
      updated_at_unix_ms: 1,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await submitSelfHostedRenewalPackage(
      "https://relay.example.com/",
      selfRelayPackage(),
    );

    expect(status?.relay_mode).toBe("SelfRelay");
    expect(fetchMock).toHaveBeenCalledWith("https://relay.example.com/packages", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "content-type": "application/json" }),
    }));

    await expect(submitSelfHostedRenewalPackage(
      "https://relay.example.com/",
      { ...selfRelayPackage(), relay_mode: "ZylithRelay" },
    )).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends package authorization headers for result sync and deletion", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        package_id: "pkg-1",
        package_commitment: "0xabc",
        results: [],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const authorized = {
      package_id: "pkg-1",
      package_commitment: "0xabc",
      parent_cancel_authority: "0xparent",
      relay_mode: "SelfRelay" as const,
      relay_authorization: {
        signer_public_key: "0xsigner",
        signature_r: "0xr",
        signature_s: "0xs",
      },
    };

    await fetchSelfHostedRenewalPackageResults("https://relay.example.com", authorized);
    await deleteSelfHostedRenewalPackage("https://relay.example.com", authorized);

    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        "x-zylith-relay-package-commitment": "0xabc",
        "x-zylith-relay-parent-cancel-authority": "0xparent",
        "x-zylith-relay-signer": "0xsigner",
        "x-zylith-relay-signature-r": "0xr",
        "x-zylith-relay-signature-s": "0xs",
      });
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://relay.example.com/packages/pkg-1/results");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });
});

function selfRelayPackage(): OfflineRenewalPackage {
  return {
    version: 1,
    package_id: "pkg-1",
    package_commitment: "0xabc",
    created_at_unix_ms: 1,
    pair: "STRK/USDC",
    start_epoch: 1,
    end_epoch: 1,
    slot_count: 1,
    relay_mode: "SelfRelay",
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
