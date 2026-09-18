import { afterEach, describe, expect, it, vi } from "vitest";
import checkedInDeployment from "../../public/deployment.example.json";
import {
  apiBatchTranscripts,
  apiArrivalReferenceAttestation,
  apiProofJobStatuses,
  apiSubmittablePairBatch,
  assertArrivalReferenceAttestation,
  assertCurrentDeploymentManifestShape,
} from "./auctionEpoch";

describe("auction epoch public artifact fetchers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("pages settlement transcript batch IDs instead of issuing one large URL", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/api/batches/transcripts?");
      const ids = batchIdsFromUrl(url);
      expect(ids.length).toBeLessThanOrEqual(16);
      return jsonResponse(
        ids.map((batch_id) => ({
          batch_id,
          pair_id: "STRK/ETH",
          batch_epoch: Number(batch_id.replace("batch-", "")),
          clearing_price: "1",
        }))
      );
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
      return jsonResponse(
        ids.map((batch_id) => ({
          batch_id,
          state: "confirmed-onchain",
          witness_available: false,
          proof_artifact_available: false,
          onchain_submission_available: true,
          updated_at_unix_ms: 1,
        }))
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const ids = Array.from({ length: 20 }, (_, index) => `batch-${index % 10}`);
    const statuses = await apiProofJobStatuses(ids);

    expect(statuses).toHaveLength(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to per-batch transcript endpoints when bulk transcript fetch fails", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 503 })
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(apiBatchTranscripts(["batch-1", "batch-2"])).resolves.toEqual(
      []
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [input] of vi.mocked(fetchImpl).mock.calls) {
      expect(String(input)).toContain("/api/batches/transcripts?");
    }
  });

  it("does not fall back to per-batch proof-job endpoints when bulk status fetch fails", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 503 })
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(apiProofJobStatuses(["batch-1", "batch-2"])).resolves.toEqual(
      []
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toContain(
      "/api/public/proof-jobs?batch_ids=batch-1,batch-2"
    );
  });

  it("normalizes raw browser abort failures on submittable batch fetches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Signal is aborted without reason");
      })
    );

    await expect(apiSubmittablePairBatch("STRK", "ETH")).rejects.toThrow(
      "Network request failed. Check your connection and retry."
    );
  });

  it("times out submittable batch fetches when fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined))
    );

    const request = apiSubmittablePairBatch("STRK", "ETH");
    const assertion = expect(request).rejects.toThrow(
      "Network request failed. Check your connection and retry."
    );
    await vi.advanceTimersByTimeAsync(8_001);

    await assertion;
  });

  it("returns structurally valid submittable batch responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          batch_id: "batch-strk-eth-42",
          pair_id: "STRK/ETH",
          epoch_id: 42,
          close_time_unix_ms: Date.now() + 10_000,
          status: "Open",
          order_count_bucket: "1-4",
        })
      )
    );

    await expect(apiSubmittablePairBatch("STRK", "ETH")).resolves.toMatchObject(
      {
        batch_id: "batch-strk-eth-42",
        pair_id: "STRK/ETH",
        status: "Open",
      }
    );
  });

  it("encodes pair path segments when fetching submittable batches", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        batch_id: "batch-strk-eth-42",
        pair_id: "STRK/ETH",
        epoch_id: 42,
        close_time_unix_ms: Date.now() + 10_000,
        status: "Open",
        order_count_bucket: "1-4",
      })
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await apiSubmittablePairBatch("STRK/TEST", "ETH+USD");

    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toContain(
      "/api/pairs/STRK%2FTEST/ETH%2BUSD/batches/submittable"
    );
  });

  it("fetches and validates the signed live arrival-price attestation", async () => {
    const now = Date.now();
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toContain(
          "/api/public/reference-prices/attestation"
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ pair_id: "ETH/USDC" });
        return jsonResponse(referenceAttestation(now));
      }
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      apiArrivalReferenceAttestation(referencePair(), "0x0123")
    ).resolves.toEqual({
      midpointPrice: "2500000000",
      priceBaseScale: "1000000000000000000",
      observedAtUnixMs: now - 1_000,
    });
  });

  it("rejects arrival-price attestations with mismatched or unsafe bindings", () => {
    const now = 1_800_000_000_000;
    const valid = referenceAttestation(now);
    expect(() =>
      assertArrivalReferenceAttestation(valid, referencePair(), "0x123", now)
    ).not.toThrow();

    const wrongPair = structuredClone(valid);
    wrongPair.attestation.envelope.pair_id = "STRK/USDC";
    expect(() =>
      assertArrivalReferenceAttestation(
        wrongPair,
        referencePair(),
        "0x123",
        now
      )
    ).toThrow("Reference-price attestation response is malformed");

    const wrongVerifier = structuredClone(valid);
    wrongVerifier.attestation.auction_verifier_address = "0x999";
    expect(() =>
      assertArrivalReferenceAttestation(
        wrongVerifier,
        referencePair(),
        "0x123",
        now
      )
    ).toThrow("Reference-price attestation response is malformed");

    const insufficientSources = structuredClone(valid);
    insufficientSources.attestation.envelope.source_count = 2;
    expect(() =>
      assertArrivalReferenceAttestation(
        insufficientSources,
        referencePair(),
        "0x123",
        now
      )
    ).toThrow("Reference-price attestation response is malformed");

    const expired = structuredClone(valid);
    expired.attestation.valid_until_unix_ms = now - 30_001;
    expect(() =>
      assertArrivalReferenceAttestation(expired, referencePair(), "0x123", now)
    ).toThrow("Reference-price attestation response is malformed");

    const overflow = structuredClone(valid);
    overflow.attestation.envelope.midpoint_price = (1n << 128n).toString();
    expect(() =>
      assertArrivalReferenceAttestation(overflow, referencePair(), "0x123", now)
    ).toThrow("Reference-price attestation response is malformed");
  });

  it("rejects malformed submittable batch responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          batch_id: "batch-strk-eth-42",
          pair_id: "STRK/ETH",
          epoch_id: "42",
          close_time_unix_ms: Date.now() + 10_000,
          status: "Open",
          order_count_bucket: "1-4",
        })
      )
    );

    await expect(apiSubmittablePairBatch("STRK", "ETH")).rejects.toThrow(
      "Coordinator submittable batch response is malformed"
    );
  });

  it("rejects fields outside the current deployment manifest schema", () => {
    const manifest = currentDeploymentManifest();
    expect(() => assertCurrentDeploymentManifestShape(manifest)).not.toThrow();

    expect(() =>
      assertCurrentDeploymentManifestShape({
        ...manifest,
        unexpected_top_level: true,
      })
    ).toThrow("unsupported field unexpected_top_level");

    expect(() =>
      assertCurrentDeploymentManifestShape({
        ...manifest,
        contracts: {
          ...manifest.contracts,
          unexpected_contract: "0xdead",
        },
      })
    ).toThrow("unsupported field contracts.unexpected_contract");

    expect(() =>
      assertCurrentDeploymentManifestShape({
        ...manifest,
        funding: {
          ...manifest.funding,
          starknet_privacy: {
            ...manifest.funding.starknet_privacy,
            unexpected_privacy_field: "0x2",
          },
        },
      })
    ).toThrow(
      "unsupported field funding.starknet_privacy.unexpected_privacy_field"
    );

    expect(() =>
      assertCurrentDeploymentManifestShape({
        ...manifest,
        funding: {
          ...manifest.funding,
          capabilities: {
            private_deposits: true,
            private_withdrawals: true,
            private_transfers: true,
            discovery_sync: true,
            proof_bearing_transactions: true,
            paymaster_ready: true,
            user_controlled_disclosure: true,
          },
          starknet_privacy: {
            ...manifest.funding.starknet_privacy,
            shielded_asset_adapter: "0x123",
          },
        },
      })
    ).not.toThrow();

    expect(() =>
      assertCurrentDeploymentManifestShape({
        ...manifest,
        funding: {
          ...manifest.funding,
          capabilities: {
            unexpected_capability: true,
          },
        },
      })
    ).toThrow("unsupported field funding.capabilities.unexpected_capability");

    expect(() =>
      assertCurrentDeploymentManifestShape({
        ...manifest,
        product: {
          ...manifest.product,
          pairs: {
            "STRK/USDC": {
              ...manifest.product.pairs["STRK/USDC"],
              unexpected_pair_field: true,
            },
          },
        },
      })
    ).toThrow(
      "unsupported field product.pairs.STRK/USDC.unexpected_pair_field"
    );

    const deployedPairShape = structuredClone(manifest);
    const deployedPair = deployedPairShape.product.pairs["STRK/USDC"] as Record<
      string,
      unknown
    >;
    delete deployedPair.price_base_scale;
    delete deployedPair.heartbeat_cover_price;
    delete deployedPair.taker_fee_bps;
    expect(() =>
      assertCurrentDeploymentManifestShape(deployedPairShape)
    ).toThrow(
      "missing required field product.pairs.STRK/USDC.price_base_scale"
    );

    const missingExternalMatchCapability = structuredClone(manifest);
    delete (
      missingExternalMatchCapability.product.pairs["STRK/USDC"] as Record<
        string,
        unknown
      >
    ).external_match_enabled;
    expect(() =>
      assertCurrentDeploymentManifestShape(missingExternalMatchCapability)
    ).toThrow(
      "missing required field product.pairs.STRK/USDC.external_match_enabled"
    );

    const malformedExternalMatchCapability = structuredClone(manifest);
    (
      malformedExternalMatchCapability.product.pairs[
        "STRK/USDC"
      ] as Record<string, unknown>
    ).external_match_enabled = "false";
    expect(() =>
      assertCurrentDeploymentManifestShape(
        malformedExternalMatchCapability
      )
    ).toThrow(
      "field product.pairs.STRK/USDC.external_match_enabled must be boolean"
    );

    const enabledExternalMatch = structuredClone(manifest);
    enabledExternalMatch.product.pairs[
      "STRK/USDC"
    ].external_match_enabled = true;
    expect(() =>
      assertCurrentDeploymentManifestShape(enabledExternalMatch)
    ).not.toThrow();

    const missingPairIdentity = structuredClone(manifest);
    delete (
      missingPairIdentity.product.pairs["STRK/USDC"] as Record<string, unknown>
    ).pair_id;
    expect(() =>
      assertCurrentDeploymentManifestShape(missingPairIdentity)
    ).toThrow("missing required field product.pairs.STRK/USDC.pair_id");

    expect(() =>
      assertCurrentDeploymentManifestShape({
        ...manifest,
        proof_config: {
          ...manifest.proof,
          native_prover_rpc_url: "https://api.zylith.fi/starknet-rpc",
        },
      })
    ).not.toThrow();

    expect(() =>
      assertCurrentDeploymentManifestShape({
        ...manifest,
        proof_config: {
          ...manifest.proof,
          unexpected_proof_config_field: true,
        },
      })
    ).toThrow("unsupported field proof_config.unexpected_proof_config_field");

    const deployedProofShape = structuredClone(manifest);
    const deployedProof = deployedProofShape.proof as Record<string, unknown>;
    deployedProof.native_prover_rpc_url = "https://api.zylith.fi/starknet-rpc";
    deployedProof.settlement_note_fee_statement_program_address = "0x110";
    deployedProof.settlement_order_statement_program_address = "0x111";
    deployedProof.settlement_input_membership_statement_program_address =
      "0x112";
    deployedProof.settlement_output_recovery_statement_program_address =
      "0x113";
    deployedProof.admission_statement_program_address = "0x105";
    deployedProof.auction_result_statement_program_address = "0x106";
    deployedProof.multi_pair_statement_program_address = "0x114";
    deployedProof.multi_pair_settlement_statement_program_address = "0x115";
    deployedProof.auction_verifier_class_hash = "0x107";
    deployedProof.statement_proof_program_hashes = {
      ADMISSION: "0x201",
      AUCTION_RESULT: "0x202",
      NULLIFIER: "0x203",
      RENEWAL: "0x204",
      SETTLEMENT: "0x206",
      NOTE_CONSOLIDATION: "0x207",
      AGGREGATE_SETTLEMENT: "0x208",
      WITHDRAWAL: "0x209",
      MULTI_PAIR: "0x20a",
      MULTI_PAIR_SETTLEMENT: "0x20b",
    };
    deployedProof.admission_proof_program_hash = "0x201";
    deployedProof.auction_result_proof_program_hash = "0x202";
    deployedProof.nullifier_proof_program_hash = "0x203";
    deployedProof.renewal_proof_program_hash = "0x204";
    deployedProof.settlement_proof_program_hash = "0x206";
    deployedProof.note_consolidation_proof_program_hash = "0x207";
    deployedProof.aggregate_settlement_proof_program_hash = "0x208";
    deployedProof.withdrawal_proof_program_hash = "0x209";
    deployedProof.multi_pair_proof_program_hash = "0x20a";
    deployedProof.multi_pair_settlement_proof_program_hash = "0x20b";
    deployedProof.external_match_authorization_proof_program_hash = "0x20c";
    deployedProof.external_match_authorization_statement_program_address =
      "0x116";
    delete deployedProof.commitment_registry_config_locked_after_deploy;
    delete deployedProof.batch_registry_config_locked_after_deploy;
    delete deployedProof.privacy_deposit_bridge_config_locked_after_deploy;
    expect(() =>
      assertCurrentDeploymentManifestShape(deployedProofShape)
    ).not.toThrow();

    const missingProofProgramHash = structuredClone(manifest);
    delete (missingProofProgramHash.proof as Record<string, unknown>)
      .proof_program_hash;
    expect(() =>
      assertCurrentDeploymentManifestShape(missingProofProgramHash)
    ).toThrow("missing required field proof.proof_program_hash");

    const inheritedRequiredField = structuredClone(manifest);
    delete (inheritedRequiredField as unknown as Record<string, unknown>)
      .network;
    Object.setPrototypeOf(inheritedRequiredField, { network: "sepolia" });
    expect(() =>
      assertCurrentDeploymentManifestShape(inheritedRequiredField)
    ).toThrow("missing required field network");
  });
});

function batchIdsFromUrl(url: string): string[] {
  const parsed = new URL(url, "http://localhost:5173");
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

function currentDeploymentManifest() {
  return structuredClone(checkedInDeployment);
}

function referencePair() {
  return {
    pair_id: "ETH/USDC",
    base_asset_id: "ETH",
    quote_asset_id: "USDC",
    price_base_scale: "1000000000000000000",
  };
}

function referenceAttestation(now: number) {
  return {
    attestation: {
      envelope: {
        pair_id: "ETH/USDC",
        base_asset_id: "ETH",
        quote_asset_id: "USDC",
        midpoint_price: "2500000000",
        lower_price: "2496250000",
        upper_price: "2503750000",
        price_base_scale: "1000000000000000000",
        source_count: 3,
        observed_at_unix_ms: now - 1_000,
      },
      auction_verifier_address: "0x123",
      source_set_commitment: "0x456",
      valid_until_unix_ms: now + 5_000,
      nonce: 7,
      signer_public_key: "0x789",
      signature: {
        signature_r: "0xabc",
        signature_s: "0xdef",
      },
    },
  };
}
