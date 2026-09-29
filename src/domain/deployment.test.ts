import { describe, expect, it } from "vitest";
import { assertDeploymentManifest, assertPinnedExecutionKeys, enabledPairs, pinnedRegistryFingerprints, verifyMarketRegistryHash } from "./deployment";
import shipped from "../../public/deployment.example.json";

const example = JSON.parse(JSON.stringify(shipped));

function finalized(manifest: typeof example) {
  manifest.deployment = { finalized: true, release_commit: "a".repeat(40) };
  for (const field of ["proof_program_address", "virtual_program_hash", "starknet_os_config_hash", "proof_account_address", "settlement_account_address"]) manifest.proof[field] = "0x1234";
  manifest.proof.config_locked_after_deploy = true;
  manifest.roles = { protocol_fee_recipient: "0x1234", pause_guardian_address: "0x1234", reference_price_signer: "0x1234" };
  return manifest;
}

describe("deployment manifest", () => {
  it("recomputes the same canonical registry hash as core", async () => {
    await expect(verifyMarketRegistryHash(example)).resolves.toBeUndefined();
    const changed = JSON.parse(JSON.stringify(example));
    changed.market_registry.markets[0].taker_fee_bps += 1;
    await expect(verifyMarketRegistryHash(changed)).rejects.toThrow(/hash mismatch/);
  });

  it("accepts a deployed manifest in the shipped schema", () => {
    const deployed = finalized({
      ...example,
      contracts: { commitment_registry: "0x1", privacy_deposit_bridge: "0x2", ekubo_external_match_router: "0x3", exchange: "0x4" },
    });
    expect(() => assertDeploymentManifest(deployed)).not.toThrow();
    expect(enabledPairs(deployed).map((pair) => pair.pair_id)).toContain("STRK/USDC");
  });

  it("rejects a manifest whose exchange is not deployed or whose runtime is missing", () => {
    expect(() => assertDeploymentManifest(example)).toThrow(/must be a nonzero address/);
    const { runtime: _, ...withoutRuntime } = { ...example, contracts: { ...example.contracts, commitment_registry: "0x1", privacy_deposit_bridge: "0x2", exchange: "0x4" } };
    expect(() => assertDeploymentManifest(withoutRuntime)).toThrow(/missing runtime/);
  });

  it("rejects runtime limits that cannot represent a usable deployment", () => {
    const manifest = finalized(JSON.parse(JSON.stringify(example)));
    for (const name of ["commitment_registry", "privacy_deposit_bridge", "exchange"]) manifest.contracts[name] = "0x1234";
    manifest.runtime.max_admissions_per_transition = manifest.runtime.max_book_orders + 1;
    expect(() => assertDeploymentManifest(manifest)).toThrow(/runtime is malformed/);
  });

  it("rejects a pair whose registry key and canonical pair id disagree", () => {
    const manifest = finalized(JSON.parse(JSON.stringify(example)));
    for (const name of ["commitment_registry", "privacy_deposit_bridge", "exchange"]) manifest.contracts[name] = "0x1234";
    manifest.market_registry.markets.find((market: { market_id: string }) => market.market_id === "STRK/USDC").market_id = "ETH/USDC";
    expect(() => assertDeploymentManifest(manifest)).toThrow(/sorted and unique|market ETH\/USDC is malformed/);
  });

  it("rejects reference sources outside the canonical production policy", () => {
    const wrongPrimary = finalized(JSON.parse(JSON.stringify(example)));
    for (const name of ["commitment_registry", "privacy_deposit_bridge", "exchange"]) wrongPrimary.contracts[name] = "0x1234";
    wrongPrimary.market_registry.markets[0].reference_price.primary.adapter = "coinbase";
    expect(() => assertDeploymentManifest(wrongPrimary)).toThrow(/invalid reference pricing/);

    const wrongCorroboration = finalized(JSON.parse(JSON.stringify(example)));
    for (const name of ["commitment_registry", "privacy_deposit_bridge", "exchange"]) wrongCorroboration.contracts[name] = "0x1234";
    wrongCorroboration.market_registry.markets[0].reference_price.corroborating[0] = {
      kind: "direct",
      adapter: "coinbase",
      symbol: "ETH-USDC",
    };
    expect(() => assertDeploymentManifest(wrongCorroboration)).toThrow(/invalid reference pricing/);
  });
});

describe("execution key pinning", () => {
  const pinned = "ab".repeat(32);
  const manifest = (current?: string, next?: string) => ({
    funding: { primary: "starknet_privacy", starknet_privacy: { ingress_key_registry_fingerprint: current, ingress_key_registry_next_fingerprint: next } },
  });

  it("accepts only the pinned registry, or its announced successor", () => {
    expect(() => assertPinnedExecutionKeys(pinned, manifest(pinned))).not.toThrow();
    expect(() => assertPinnedExecutionKeys(pinned.toUpperCase(), manifest(pinned))).not.toThrow();
    expect(() => assertPinnedExecutionKeys("cd".repeat(32), manifest(pinned))).toThrow(/do not match/);
    expect(() => assertPinnedExecutionKeys("cd".repeat(32), manifest(pinned, "cd".repeat(32)))).not.toThrow();
  });

  it("fails closed when the manifest pins nothing", () => {
    expect(() => assertPinnedExecutionKeys(pinned, manifest())).toThrow(/pins no execution keys/);
    expect(() => assertPinnedExecutionKeys("0".repeat(64), manifest("0".repeat(64)))).toThrow(/pins no execution keys/);
    expect(pinnedRegistryFingerprints(manifest("not hex", pinned))).toEqual([pinned]);
  });
});

describe("external matching in the manifest", () => {
  const deployed = () => {
    const manifest = finalized(JSON.parse(JSON.stringify(example)));
    for (const name of ["commitment_registry", "privacy_deposit_bridge", "exchange", "ekubo_external_match_router"]) manifest.contracts[name] = "0x1234";
    return manifest;
  };

  it("needs a router and a window once a pair routes externally", () => {
    const manifest = deployed();
    const pair = manifest.market_registry.markets.find((candidate: { enabled: boolean }) => candidate.enabled)!;
    pair.capabilities.external_matching = true;
    pair.external_settlement_support_quote = "5000";
    pair.external_min_profit_quote = "1";
    manifest.runtime.external_window_seconds = 0;
    expect(() => assertDeploymentManifest(manifest)).toThrow(/external window/);
    manifest.runtime.external_window_seconds = 30;
    manifest.contracts.ekubo_external_match_router = "0x0";
    expect(() => assertDeploymentManifest(manifest)).toThrow(/external match router/);
    manifest.contracts.ekubo_external_match_router = "0x1234";
    expect(() => assertDeploymentManifest(manifest)).not.toThrow();
  });
});
