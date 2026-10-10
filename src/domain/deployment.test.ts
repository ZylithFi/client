import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBrowserNetworkPolicy, assertDeploymentManifest, assertPinnedExecutionKeys, defaultDepositAsset, defaultPair, deploymentForExecutionKey, deploymentManifestIdentity, enabledPairs, loadDeployment, pinnedRegistryFingerprints, verifyMarketRegistryHash, type DeploymentConfig } from "./deployment";
import shipped from "../../public/deployment.example.json";

const example = JSON.parse(JSON.stringify(shipped));

afterEach(() => vi.unstubAllGlobals());

function finalized(manifest: typeof example) {
  manifest.deployment = { finalized: true, release_commit: "a".repeat(40) };
  for (const field of ["commitment_registry", "privacy_deposit_bridge", "ekubo_external_match_router", "exchange"]) {
    if (!manifest.contracts[field] || manifest.contracts[field] === "0x0") manifest.contracts[field] = "0x1234";
  }
  for (const field of ["transition_proof_program_address", "withdrawal_proof_program_address", "residual_recovery_proof_program_address", "virtual_program_hash", "starknet_os_config_hash", "proof_account_address", "proof_account_class_hash", "transition_proof_program_class_hash", "withdrawal_proof_program_class_hash", "residual_recovery_proof_program_class_hash", "settlement_account_address"]) manifest.proof[field] = "0x1234";
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

  it("selects STRK as the deposit default from the registry fee asset", () => {
    const deployed = finalized(JSON.parse(JSON.stringify(example)));
    expect(defaultDepositAsset(deployed)).toBe("STRK");
    deployed.market_registry.assets.reverse();
    expect(defaultDepositAsset(deployed)).toBe("STRK");
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
    manifest.proof.prover_build_id = "stwo-production-v1";
    manifest.proof.proof_version = "PROOF1";
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
    expect(() => assertDeploymentManifest(unpinned)).toThrow(/fingerprint/i);

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
    expect(() => assertPinnedExecutionKeys("0".repeat(64), manifest("0".repeat(64)))).toThrow(/fingerprint/i);
    expect(() => pinnedRegistryFingerprints(manifest("not hex", pinned))).toThrow(/fingerprint/i);
  });

  it("rejects every present malformed or duplicate rotation pin", () => {
    const other = "cd".repeat(32);
    const invalidPins: unknown[] = [other.toUpperCase(), "0".repeat(64), " not hex ", "", null, pinned];
    for (const bad of invalidPins) {
      expect(() => pinnedRegistryFingerprints(manifest(pinned, bad as string))).toThrow(/fingerprint/i);
    }
    expect(pinnedRegistryFingerprints(manifest(pinned, other))).toEqual([pinned, other]);
    expect(() => assertPinnedExecutionKeys(pinned, manifest(pinned, "0".repeat(64)))).toThrow(/fingerprint/i);
  });

  it("rejects malformed optional rotation pins at manifest load", () => {
    const invalidPins: unknown[] = ["CD".repeat(32), "0".repeat(64), "not hex", "ab".repeat(32), null];
    for (const bad of invalidPins) {
      const deployed = finalized(JSON.parse(JSON.stringify(example)));
      deployed.funding.starknet_privacy.ingress_key_registry_next_fingerprint = bad as string;
      expect(() => assertDeploymentManifest(deployed)).toThrow(/fingerprint|funding configuration/i);
    }
    const nextWithoutCurrent = finalized(JSON.parse(JSON.stringify(example)));
    delete nextWithoutCurrent.funding.starknet_privacy.ingress_key_registry_fingerprint;
    nextWithoutCurrent.funding.starknet_privacy.ingress_key_registry_next_fingerprint = "cd".repeat(32);
    expect(() => assertDeploymentManifest(nextWithoutCurrent)).toThrow(/fingerprint|funding configuration/i);
  });
});

describe("deployment refresh for an active execution key", () => {
  const keyA = "ab".repeat(32);
  const keyB = "cd".repeat(32);
  const accept = () => undefined;
  const deployment = (current: string, next?: string) => {
    const value = finalized(JSON.parse(JSON.stringify(example))) as DeploymentConfig;
    value.funding.starknet_privacy!.ingress_key_registry_fingerprint = current;
    if (next === undefined) delete value.funding.starknet_privacy!.ingress_key_registry_next_fingerprint;
    else value.funding.starknet_privacy!.ingress_key_registry_next_fingerprint = next;
    return value;
  };
  const responseFor = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

  it("freezes the wallet worker manifest identity across pin-only refreshes", async () => {
    const current = deployment(keyA);
    const overlap = deployment(keyA, keyB);
    overlap.deployment.release_commit = "b".repeat(40);
    overlap.runtime.epoch_ms += 1_000;
    overlap.roles.pause_guardian_address = "0x5678";
    const identity = await deploymentManifestIdentity(current);
    expect(identity).toBe("sha256:d784dbca4601d3edb5f73dc67124a1b8daaf258c581406aa8925a51bcbce5964");
    await expect(deploymentManifestIdentity(overlap)).resolves.toBe(identity);

    const changed = deployment(keyA);
    changed.contracts.exchange = "0x999";
    await expect(deploymentManifestIdentity(changed)).resolves.not.toBe(identity);
  });

  it("refreshes a stale session through overlap to active B and preserves only the refreshed pins", async () => {
    const sessionA = deployment(keyA);
    const overlap = deployment(keyA, keyB);
    overlap.deployment.release_commit = "b".repeat(40);
    overlap.runtime.epoch_ms += 1_000;
    overlap.roles.pause_guardian_address = "0x5678";
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseFor(overlap));
    vi.stubGlobal("fetch", fetch);

    const accepted: DeploymentConfig[] = [];
    const activeB = await deploymentForExecutionKey(keyB, sessionA, (value) => accepted.push(value));
    expect(pinnedRegistryFingerprints({ funding: activeB.funding })).toEqual([keyA, keyB]);
    expect(activeB.deployment.release_commit).toBe(sessionA.deployment.release_commit);
    expect(activeB.runtime.epoch_ms).toBe(sessionA.runtime.epoch_ms);
    expect(activeB.roles.pause_guardian_address).toBe(sessionA.roles.pause_guardian_address);
    expect(accepted).toEqual([activeB]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    await expect(loadDeployment()).resolves.toBe(activeB);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a normally pinned registry on the cached deployment", async () => {
    const current = deployment(keyA);
    const fetch = vi.fn(async () => responseFor(current));
    vi.stubGlobal("fetch", fetch);
    await expect(deploymentForExecutionKey(keyA, current, accept)).resolves.toBe(current);
    await expect(deploymentForExecutionKey(keyA.toUpperCase(), current, accept)).rejects.toThrow(/malformed/i);
    await expect(deploymentForExecutionKey("0".repeat(64), current, accept)).rejects.toThrow(/malformed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps active B usable during overlap and converges a stale A session to retired [B]", async () => {
    const sessionA = deployment(keyA);
    const overlap = deployment(keyA, keyB);
    const retired = deployment(keyB);
    const fetch = vi.fn(async () => responseFor(retired));
    vi.stubGlobal("fetch", fetch);

    await expect(deploymentForExecutionKey(keyB, overlap, accept)).resolves.toBe(overlap);
    expect(fetch).not.toHaveBeenCalled();
    const converged = await deploymentForExecutionKey(keyB, sessionA, accept);
    expect(pinnedRegistryFingerprints({ funding: converged.funding })).toEqual([keyB]);
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(deploymentForExecutionKey(keyA, converged, accept)).rejects.toThrow(/do not match/i);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent trusted-manifest refreshes", async () => {
    const current = deployment(keyA);
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const accepted: DeploymentConfig[] = [];
    const refreshes = Array.from({ length: 8 }, () => deploymentForExecutionKey(keyB, current, (value) => accepted.push(value)));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release(responseFor(deployment(keyA, keyB)));
    const updated = await Promise.all(refreshes);
    expect(updated.every((value) => value.funding.starknet_privacy!.ingress_key_registry_next_fingerprint === keyB)).toBe(true);
    expect(accepted).toHaveLength(8);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed refreshed manifests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseFor({ unknown: true })));
    await expect(deploymentForExecutionKey(keyB, deployment(keyA), accept)).rejects.toThrow(/missing|unknown/i);
  });

  it.each([
    ["network", (value: DeploymentConfig) => { value.network = "mainnet"; value.market_registry.network = "mainnet"; }],
    ["chain", (value: DeploymentConfig) => { value.chain_id = "0x1"; value.market_registry.chain_id = "0x1"; }],
    ["rpc service", (value: DeploymentConfig) => { value.rpc_url = "https://other-rpc.example"; }],
    ["exchange", (value: DeploymentConfig) => { value.contracts.exchange = "0x999"; }],
    ["proving service", (value: DeploymentConfig) => { value.funding.starknet_privacy!.proving_url = "https://other-prover.example"; }],
    ["proof program", (value: DeploymentConfig) => { value.proof.transition_proof_program_address = "0x999"; }],
    ["proof account class", (value: DeploymentConfig) => { value.proof.proof_account_class_hash = "0x999"; }],
    ["proof program class", (value: DeploymentConfig) => { value.proof.transition_proof_program_class_hash = "0x999"; }],
  ])("rejects refreshed deployment with changed %s security context", async (_name, alter) => {
    const current = deployment(keyA);
    const changed = deployment(keyA, keyB);
    alter(changed);
    vi.stubGlobal("fetch", vi.fn(async () => responseFor(changed)));
    await expect(deploymentForExecutionKey(keyB, current, accept)).rejects.toThrow(/deployment context changed|registry hash mismatch/i);
  });

  it("rejects a fully valid refreshed manifest that still does not pin the active key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseFor(deployment(keyA))));
    await expect(deploymentForExecutionKey(keyB, deployment(keyA), accept)).rejects.toThrow(/do not match/i);
  });

  it("does not publish a refreshed cache when the live-session acceptance check fails", async () => {
    const keyC = "ef".repeat(32);
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => responseFor(
      init?.cache === "no-store" ? deployment(keyA, keyC) : deployment(keyA),
    ));
    vi.stubGlobal("fetch", fetch);
    const previouslyAccepted = await loadDeployment();
    const changed = new Error("wallet session changed");
    await expect(deploymentForExecutionKey(keyC, deployment(keyA), () => { throw changed; })).rejects.toBe(changed);
    await expect(loadDeployment()).resolves.toBe(previouslyAccepted);
  });

  it("validates every coalesced caller against its own deployment identity", async () => {
    const current = deployment(keyA);
    const otherDeployment = deployment(keyA);
    otherDeployment.contracts.exchange = "0x999";
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const accepted = vi.fn();
    const matching = deploymentForExecutionKey(keyB, current, accepted);
    const substituted = deploymentForExecutionKey(keyB, otherDeployment, accepted);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release(responseFor(deployment(keyA, keyB)));
    await expect(matching).resolves.toMatchObject({ contracts: current.contracts });
    await expect(substituted).rejects.toThrow(/deployment context changed/i);
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("coalesces a failed refresh and retries with one new request without poisoning the cache", async () => {
    let forcedRequests = 0;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.cache !== "no-store") return responseFor(deployment(keyA));
      forcedRequests += 1;
      return forcedRequests === 1
        ? responseFor({ malformed: true })
        : responseFor(deployment(keyA, keyB));
    });
    vi.stubGlobal("fetch", fetch);
    const cached = await loadDeployment();
    const failures = await Promise.allSettled(Array.from({ length: 6 }, () => deploymentForExecutionKey(keyB, deployment(keyA), accept)));
    expect(failures.every((result) => result.status === "rejected")).toBe(true);
    expect(forcedRequests).toBe(1);
    await expect(loadDeployment()).resolves.toBe(cached);
    await expect(deploymentForExecutionKey(keyB, deployment(keyA), accept)).resolves.toMatchObject({ funding: { starknet_privacy: { ingress_key_registry_next_fingerprint: keyB } } });
    expect(forcedRequests).toBe(2);
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
