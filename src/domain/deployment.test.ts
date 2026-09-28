import { describe, expect, it } from "vitest";
import { assertDeploymentManifest, assertPinnedExecutionKeys, enabledPairs, pinnedRegistryFingerprints } from "./deployment";
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
    const pair = Object.values(manifest.product.pairs as Record<string, { enabled: boolean; external_match_enabled: boolean }>).find((candidate) => candidate.enabled)!;
    pair.external_match_enabled = true;
    manifest.runtime.external_window_seconds = 0;
    expect(() => assertDeploymentManifest(manifest)).toThrow(/external window/);
    manifest.runtime.external_window_seconds = 30;
    manifest.contracts.ekubo_external_match_router = "0x0";
    expect(() => assertDeploymentManifest(manifest)).toThrow(/external match router/);
    manifest.contracts.ekubo_external_match_router = "0x1234";
    expect(() => assertDeploymentManifest(manifest)).not.toThrow();
  });
});
