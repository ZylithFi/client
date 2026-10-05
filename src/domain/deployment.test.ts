import { describe, expect, it } from "vitest";
import { assertBrowserNetworkPolicy, assertDeploymentManifest, assertPinnedExecutionKeys, defaultPair, enabledPairs, pinnedRegistryFingerprints, verifyMarketRegistryHash } from "./deployment";
import shipped from "../../public/deployment.example.json";

const example = JSON.parse(JSON.stringify(shipped));

function finalized(manifest: typeof example) {
  manifest.deployment = { finalized: true, release_commit: "a".repeat(40) };
  for (const field of ["commitment_registry", "privacy_deposit_bridge", "ekubo_external_match_router", "exchange"]) {
    if (!manifest.contracts[field] || manifest.contracts[field] === "0x0") manifest.contracts[field] = "0x1234";
  }
  for (const field of ["transition_proof_program_address", "withdrawal_proof_program_address", "residual_recovery_proof_program_address", "virtual_program_hash", "starknet_os_config_hash", "proof_account_address", "settlement_account_address"]) manifest.proof[field] = "0x1234";
  manifest.proof.config_locked_after_deploy = true;
  manifest.roles = { protocol_fee_recipient: "0x1234", pause_guardian_address: "0x1234", reference_price_signer: "0x1234" };
  manifest.funding.starknet_privacy = {
    ...manifest.funding.starknet_privacy,
    privacy_pool: "0x1234",
    privacy_pool_class_hash: "0x1234",
    bridge_adapter: manifest.contracts.privacy_deposit_bridge,
    proving_url: "/starknet-privacy-prover",
    proving_ohttp_policy: "best_effort",
    paymaster_address: "0x1234",
    paymaster_url: "/paymaster/execute-outside",
    proof_signer_class_hash: "0x1234",
    ingress_key_registry_fingerprint: "ab".repeat(32),
    sdk_package: "@starkware-libs/starknet-privacy-sdk",
    sdk_version: "0.14.3-rc.7",
    min_proving_delay_blocks: 10,
  };
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

  it("selects STRK/USDC as the product default regardless of registry ordering", () => {
    const deployed = finalized(JSON.parse(JSON.stringify(example)));
    for (const name of ["commitment_registry", "privacy_deposit_bridge", "exchange"]) deployed.contracts[name] = "0x1234";
    expect(defaultPair(deployed)?.pair_id).toBe("STRK/USDC");
    expect(enabledPairs(deployed)[0]?.pair_id).toBe("STRK/USDC");
    deployed.market_registry.markets.reverse();
    expect(defaultPair(deployed)?.pair_id).toBe("STRK/USDC");
    expect(enabledPairs(deployed)[0]?.pair_id).toBe("STRK/USDC");
  });

  it("keeps synthetic residuals eligible for external multihop execution", () => {
    const deployed = finalized(JSON.parse(JSON.stringify(example)));
    for (const name of ["commitment_registry", "privacy_deposit_bridge", "exchange", "ekubo_external_match_router"]) deployed.contracts[name] = "0x1234";
    const configured = deployed.market_registry.markets.find((candidate: { market_id: string }) => candidate.market_id === "STRK/ETH");
    if (!configured) throw new Error("missing synthetic market fixture");
    configured.capabilities.external_matching = true;
    configured.external_settlement_support_quote = "1";
    configured.external_min_profit_quote = "1";
    deployed.runtime.external_window_seconds = 30;
    const pair = enabledPairs(deployed).find((candidate) => candidate.pair_id === "STRK/ETH");
    expect(pair?.external_match_enabled).toBe(true);
    expect(() => assertDeploymentManifest(deployed)).not.toThrow();
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

  it("rejects network-path and backslash service URL confusion", () => {
    const manifest = finalized(JSON.parse(JSON.stringify(example)));
    manifest.funding.starknet_privacy.proving_url = "/\\attacker.example/prover";
    expect(() => assertDeploymentManifest(manifest)).toThrow(/funding configuration/i);
    manifest.funding.starknet_privacy.proving_url = "//attacker.example/prover";
    expect(() => assertDeploymentManifest(manifest)).toThrow(/funding configuration/i);
  });

  it("rejects incomplete or unpinned proof identities", () => {
    const manifest = finalized(JSON.parse(JSON.stringify(example)));
    manifest.proof.scheme = "legacy";
    expect(() => assertDeploymentManifest(manifest)).toThrow(/proof configuration/i);
    manifest.proof.scheme = "snip36-stwo";
    manifest.proof.proof_validity_blocks = 0;
    expect(() => assertDeploymentManifest(manifest)).toThrow(/proof configuration/i);
    manifest.proof.proof_validity_blocks = 450;
    manifest.proof.prover_build_id = "";
    expect(() => assertDeploymentManifest(manifest)).toThrow(/proof configuration/i);
  });

  it("rejects oversized registry collections and arithmetic outside u128", () => {
    const tooManyMarkets = finalized(JSON.parse(JSON.stringify(example)));
    while (tooManyMarkets.market_registry.markets.length <= 8) {
      tooManyMarkets.market_registry.markets.push(structuredClone(tooManyMarkets.market_registry.markets[0]));
    }
    expect(() => assertDeploymentManifest(tooManyMarkets)).toThrow(/registry size is invalid/);
  });

  it("rejects insecure rpc, incomplete funding, and bridge drift at startup", () => {
    const insecure = finalized(JSON.parse(JSON.stringify(example)));
    insecure.rpc_url = "http://rpc.example";
    expect(() => assertDeploymentManifest(insecure)).toThrow(/RPC URL/i);

    const unpinned = finalized(JSON.parse(JSON.stringify(example)));
    unpinned.funding.starknet_privacy.ingress_key_registry_fingerprint = "0".repeat(64);
    expect(() => assertDeploymentManifest(unpinned)).toThrow(/funding configuration/i);

    const drifted = finalized(JSON.parse(JSON.stringify(example)));
    drifted.funding.starknet_privacy.bridge_adapter = "0x9999";
    expect(() => assertDeploymentManifest(drifted)).toThrow(/funding configuration/i);
  });

  it("keeps every production browser endpoint inside the deployed content-security policy", () => {
    const manifest = finalized(JSON.parse(JSON.stringify(example)));
    manifest.rpc_url = "https://api.zylith.fi/starknet-rpc";
    manifest.funding.starknet_privacy.proving_url = "https://api.zylith.fi/starknet-privacy-prover";
    manifest.funding.starknet_privacy.paymaster_url = "/paymaster/execute-outside";
    expect(() => assertBrowserNetworkPolicy(manifest, "https://app.zylith.fi/trade")).not.toThrow();

    manifest.rpc_url = "https://rpc.example";
    expect(() => assertBrowserNetworkPolicy(manifest, "https://app.zylith.fi/trade")).toThrow(/browser network policy/i);

    manifest.rpc_url = "https://api.zylith.fi/starknet-rpc";
    manifest.funding.starknet_privacy.proving_url = "https://prover.example";
    expect(() => assertBrowserNetworkPolicy(manifest, "https://app.zylith.fi/trade")).toThrow(/browser network policy/i);
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
