import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfflineRenewalPackage } from "../offlineRenewalOperator";

describe("liquidityAutomationRelay", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("registers hosted liquidity packages without bundling a frontend bearer token", async () => {
    vi.stubEnv("VITE_ZYLITH_RENEWAL_RELAY_URL", "https://relay.zylith.example");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
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
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { submitLiquidityAutomationPackage } = await import(
      "./liquidityAutomationRelay"
    );

    await submitLiquidityAutomationPackage(zylithRelayPackage());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://relay.zylith.example/packages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          accept: "application/json",
          "content-type": "application/json",
        }),
      })
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "authorization"
    );
  });

  it("uses package access token headers for hosted results and deletion", async () => {
    vi.stubEnv("VITE_ZYLITH_RENEWAL_RELAY_URL", "https://relay.zylith.example");
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
    const { deleteLiquidityAutomationPackage, fetchLiquidityAutomationPackageResults } =
      await import("./liquidityAutomationRelay");
    const renewalPackage = zylithRelayPackage();
    renewalPackage.access_token = "relay-token";

    await fetchLiquidityAutomationPackageResults(renewalPackage);
    await deleteLiquidityAutomationPackage(renewalPackage);

    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toHaveProperty(
        "x-zylith-relay-package-access-token",
        "relay-token"
      );
      expect(call[1]?.headers).not.toHaveProperty(
        "x-zylith-relay-signature-r"
      );
      expect(call[1]?.headers).not.toHaveProperty("authorization");
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://relay.zylith.example/packages/pkg-1/results"
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("requires package access token for hosted result access", async () => {
    vi.stubEnv("VITE_ZYLITH_RENEWAL_RELAY_URL", "https://relay.zylith.example");
    const { fetchLiquidityAutomationPackageResults } = await import(
      "./liquidityAutomationRelay"
    );

    await expect(
      fetchLiquidityAutomationPackageResults({
        ...zylithRelayPackage(),
        access_token: undefined,
      })
    ).rejects.toThrow("Renewal relay package access token is missing");
  });

  it("rejects blank package access tokens for hosted result access", async () => {
    vi.stubEnv("VITE_ZYLITH_RENEWAL_RELAY_URL", "https://relay.zylith.example");
    const { fetchLiquidityAutomationPackageResults } = await import(
      "./liquidityAutomationRelay"
    );

    await expect(
      fetchLiquidityAutomationPackageResults({
        ...zylithRelayPackage(),
        access_token: "   ",
      })
    ).rejects.toThrow("Renewal relay package access token is missing");
  });

  it("normalizes hosted relay abort failures", async () => {
    vi.stubEnv("VITE_ZYLITH_RENEWAL_RELAY_URL", "https://relay.zylith.example");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new DOMException("Signal is aborted without reason", "AbortError")
        )
    );
    const { submitLiquidityAutomationPackage } = await import(
      "./liquidityAutomationRelay"
    );

    await expect(submitLiquidityAutomationPackage(zylithRelayPackage())).rejects.toThrow(
      "Liquidity automation relay request failed. Check your connection and retry."
    );
  });

  it("redacts large relay error fields before surfacing failures", async () => {
    vi.stubEnv("VITE_ZYLITH_RENEWAL_RELAY_URL", "https://relay.zylith.example");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              'failed for commitment 0x1234567890abcdef1234567890abcdef1234567890abcdef with "calldata":["0x1234567890abcdef1234567890abcdef1234567890abcdef"] and "signature":["0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef"] and amount 1234567890123456789012345678901234567890',
          }),
          { status: 500 }
        )
      )
    );
    const { submitLiquidityAutomationPackage } = await import(
      "./liquidityAutomationRelay"
    );

    await expect(submitLiquidityAutomationPackage(zylithRelayPackage())).rejects.toThrow(
      'Liquidity automation relay request failed with HTTP 500: failed for commitment <felt> with "calldata":[...] and "signature":[...] and amount <number>'
    );
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
    parent_cancel_marker: "0xcancel",
    relay_authorization: {
      signer_public_key: "0xsigner",
      signature_r: "0xr",
      signature_s: "0xs",
    },
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
