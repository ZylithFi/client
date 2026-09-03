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
    expect(normalizeSelfRelayUrl("https://relay.example.com/")).toBe(
      "https://relay.example.com"
    );
    expect(normalizeSelfRelayUrl("http://localhost:3400/")).toBe(
      "http://localhost:3400"
    );
  });

  it("rejects insecure non-local relay endpoints", () => {
    expect(normalizeSelfRelayUrl("http://relay.example.com")).toBe("");
    expect(normalizeSelfRelayUrl("not a url")).toBe("");
  });

  it("posts only SelfRelay packages to the configured endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
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
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const status = await submitSelfHostedRenewalPackage(
      "https://relay.example.com/",
      selfRelayPackage()
    );

    expect(status?.relay_mode).toBe("SelfRelay");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://relay.example.com/packages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
        }),
      })
    );

    await expect(
      submitSelfHostedRenewalPackage("https://relay.example.com/", {
        ...selfRelayPackage(),
        relay_mode: "ZylithRelay",
      })
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses package access token headers for result sync and deletion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            package_id: "pkg-1",
            package_commitment: "0xabc",
            results: [],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const renewalPackage = {
      package_id: "pkg-1",
      access_token: "relay-token",
      relay_mode: "SelfRelay" as const,
    };

    await fetchSelfHostedRenewalPackageResults(
      "https://relay.example.com",
      renewalPackage
    );
    await deleteSelfHostedRenewalPackage(
      "https://relay.example.com",
      renewalPackage
    );

    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toHaveProperty(
        "x-zylith-relay-package-access-token",
        "relay-token"
      );
      expect(call[1]?.headers).not.toHaveProperty(
        "x-zylith-relay-signature-r"
      );
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://relay.example.com/packages/pkg-1/results"
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("requires package access token for result sync", async () => {
    await expect(
      fetchSelfHostedRenewalPackageResults("https://relay.example.com", {
        package_id: "pkg-1",
      })
    ).rejects.toThrow("Renewal relay package access token is missing");
  });

  it("normalizes self-hosted relay abort failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new DOMException("Signal is aborted without reason", "AbortError")
        )
    );

    await expect(
      submitSelfHostedRenewalPackage(
        "https://relay.example.com/",
        selfRelayPackage()
      )
    ).rejects.toThrow(
      "Self-hosted relay request failed. Check your connection and retry."
    );
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
    parent_cancel_authority: "0xparent",
    parent_cancel_marker: "0xcancel",
    access_token: "relay-token",
    relay_policy: {
      coordinator_url: "https://api.zylith.fi",
      prover_url: "https://api.zylith.fi",
      submission_safety_buffer_ms: 1000,
      max_submission_delay_ms: 0,
    },
    slots: [
      {
        slot_id: "pkg-1:1",
        pair: "STRK/USDC",
        batch_id: "STRK-USDC-1",
        epoch_id: 1,
        parent_child_index: 1,
        order_commitment: "0xorder",
        ingress_request: { order_submission: {} },
      },
    ],
  };
}
