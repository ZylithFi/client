import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
// @ts-expect-error the browser project omits node types; vitest reads the actual wasm artifact.
import { readFileSync } from "node:fs";
import { legacyWalletWasm as walletWasm } from "./test/legacyWalletWasm";
import { hash } from "starknet";
import { ExchangeHttpError } from "@zylith/sdk";
import exampleDeployment from "../public/deployment.example.json";
import {
  type StoredOrder,
  type WalletNote,
  assertSealedBuild,
  claimRetryDelay,
  createZylithWalletRuntime,
  createExclusiveBooleanOperation,
  createSerialOperationQueue,
  type WalletCryptoPort,
  fundingAdmissionDisposition,
  authenticatedTerminalSequence,
  mergeState,
  parseClaimedOpenNoteId,
  parseWalletProofSignerMaterial,
  parseOnchainPairConfig,
  parseFundingCommitmentRegistration,
  quarantineDamagedWalletState,
  recoverySnapshotStateForScope,
  requireRecoveryArtifactHistory,
  requireWalletSignatureVaultBundle,
  requireWalletState,
  parsePendingResidualExit,
  requireExchangeStatus,
  requireExecutionKeyRegistry,
  requireIndexerStatus,
  requireStatusAnswer,
  recoveryTransactionDisposition,
  transactionHash,
  unadmittedOrderState,
  walletWasmModuleUrlAllowed,
  walletBalances,
} from "./zylithWalletRuntime";
import { deploymentManifestIdentity, exchange, loadDeployment, pinnedRegistryFingerprints, type DeploymentConfig } from "./domain/deployment";
import { clearSelectedStarknetProvider, connectStarknetProvider, subscribeWalletRuntime } from "./domain/browserWallet";
import { type WalletSignatureVaultContext } from "./domain/walletLocalCrypto";
import { encryptLocalStore, encryptSeedWithWalletSignature } from "./test/legacyWalletCrypto";
import { createWalletSignatureVaultWorkerService } from "./domain/walletLocalCrypto";
import { createWalletCryptoClient, type WalletCryptoWorkerLike } from "./domain/walletCryptoClient";
import { createWalletSignatureVaultStore } from "./domain/walletSignatureVaultStore";
import { normalizeFailure } from "./domain/userFacingErrors";
import {
  markProofSubmissionRejected,
  markProofSubmissionStarted,
} from "./integrations/starknetPrivacyErrors";
import {
  createWalletDeviceRecordStore,
  createWalletDeviceWorkerService,
  type WalletDeviceKeyOwner,
  type WalletDeviceOwnedKeyStore,
  type WalletDeviceRecordStore,
} from "./domain/walletDeviceSession";
import {
  createWalletCryptoWorkerDispatcher,
  parseWalletWorkerRequest,
  type WalletCryptoWorkerDispatcher,
  type WalletSessionModule,
  type WalletWorkerReply,
} from "./workers/walletCryptoProtocol";
import { walletAuthDeploymentId } from "./wallet/starknetProvider";
import { WalletMigrationRequiredError } from "./domain/walletVersion";
import { selectedDepositFundingRail, selectedResidualRecoveryFundingRail } from "./domain/fundingRail";
import { STARKNET_FIELD_PRIME, normalizeStrictFelt, requiredNonZeroFelt } from "./domain/felt";

const HPKE_PROFILE = "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20Poly1305/base" as const;
const X25519_PUBLIC_KEY = "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a";

type LegacyTestWalletCore = typeof walletWasm;

function withSessionFields(inputJson: string, fields: Record<string, string>) {
  return JSON.stringify({ ...fields, ...JSON.parse(inputJson) as Record<string, unknown> });
}

function classifiedSuccess(result: string) {
  const bytes = new TextEncoder().encode(result);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return JSON.stringify({ status: "OK", result_b64: btoa(binary) });
}

class LegacyTestWalletSession {
  private seedHex: string;

  constructor(
    seed: Uint8Array,
    private readonly chainId: string,
    private readonly deploymentId: string,
    private readonly core: LegacyTestWalletCore,
  ) {
    this.seedHex = Array.from(seed, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  lock() { this.seedHex = ""; }
  free() { this.lock(); }
  publicConfig() { return this.core.zylith_wallet_derive_public_config(this.requireSeed()); }
  recoveryAuthTag() { return this.core.zylith_wallet_recovery_auth_tag(this.requireSeed()); }
  deriveProofSigner(input: string) {
    return this.core.zylith_wallet_derive_proof_signer(withSessionFields(input, {
      seed_hex: this.requireSeed(), chain_id: this.chainId,
    }));
  }
  encryptLocalState(input: string) {
    return this.core.zylith_wallet_encrypt_local_state(withSessionFields(input, { seed_hex: this.requireSeed() }));
  }
  decryptLocalState(input: string) {
    return this.core.zylith_wallet_decrypt_local_state(this.requireSeed(), input);
  }
  decryptLocalStateClassified(input: string) { return this.classified(() => this.decryptLocalState(input)); }
  buildDepositSubmissionPlan(input: string) {
    return this.core.zylith_wallet_build_deposit_submission_plan(withSessionFields(input, {
      seed_hex: this.requireSeed(), chain_id: this.chainId,
    }));
  }
  buildOrderRequest(input: string) { return this.contextual(this.core.zylith_wallet_build_order_request, input); }
  buildCancelRequest(input: string) { return this.contextual(this.core.zylith_wallet_build_cancel_request, input); }
  buildStatusRequests(input: string) { return this.contextual(this.core.zylith_wallet_build_status_requests, input); }
  buildWithdrawRequest(input: string) { return this.contextual(this.core.zylith_wallet_build_withdraw_request, input); }
  buildResidualRecovery(input: string) {
    return this.core.zylith_wallet_build_residual_recovery(withSessionFields(input, { seed_hex: this.requireSeed() }));
  }
  createRecoverySnapshot(input: string) {
    return this.core.zylith_wallet_create_recovery_snapshot(withSessionFields(input, { seed_hex: this.requireSeed() }));
  }
  decryptRecoveryArtifact(input: string) {
    return this.core.zylith_wallet_decrypt_recovery_artifact(this.requireSeed(), input);
  }
  decryptRecoveryArtifactClassified(input: string) { return this.classified(() => this.decryptRecoveryArtifact(input)); }
  signStrk20ExitClaim(input: string) {
    return this.core.zylith_wallet_sign_strk20_exit_claim(withSessionFields(input, {
      seed_hex: this.requireSeed(), chain_id: this.chainId, exchange_address: this.deploymentId,
    }));
  }

  private classified(operation: () => string) {
    try {
      return classifiedSuccess(operation());
    } catch (error) {
      return JSON.stringify({ status: /migration required/i.test(String(error)) ? "MIGRATION_REQUIRED" : "DATA_INVALID" });
    }
  }

  private contextual(operation: (input: string) => string, input: string) {
    return operation(withSessionFields(input, {
      seed_hex: this.requireSeed(), chain_id: this.chainId, chain_context: this.deploymentId,
    }));
  }

  private requireSeed() {
    if (!this.seedHex) throw new Error("Wallet session is locked");
    return this.seedHex;
  }
}

class TestDeviceKeyStore implements WalletDeviceOwnedKeyStore {
  private readonly keys = new Map<string, CryptoKey>();
  private readonly owners = new Map<string, WalletDeviceKeyOwner>();

  async add(entry: { key: CryptoKey; owner: WalletDeviceKeyOwner }) {
    if (this.keys.has(entry.owner.keyId)) throw new Error("Device key collision");
    this.keys.set(entry.owner.keyId, entry.key);
    this.owners.set(entry.owner.keyId, { ...entry.owner });
  }
  async getOwned(owner: WalletDeviceKeyOwner) {
    return this.matches(owner) ? this.keys.get(owner.keyId) ?? null : null;
  }
  async deleteOwned(owner: WalletDeviceKeyOwner) {
    if (!this.matches(owner)) return false;
    this.keys.delete(owner.keyId);
    this.owners.delete(owner.keyId);
    return true;
  }
  private matches(owner: WalletDeviceKeyOwner) {
    return JSON.stringify(this.owners.get(owner.keyId)) === JSON.stringify(owner);
  }
}

class RuntimeTestWorker implements WalletCryptoWorkerLike {
  private readonly dispatcher: WalletCryptoWorkerDispatcher;
  private readonly listeners = {
    message: new Set<(event: MessageEvent<unknown>) => void>(),
    error: new Set<(event: ErrorEvent) => void>(),
    messageerror: new Set<(event: MessageEvent<unknown>) => void>(),
  };

  constructor(core: LegacyTestWalletCore, keyStore: WalletDeviceOwnedKeyStore, now?: () => number) {
    const module: WalletSessionModule = {
      default: async () => undefined,
      WalletSession: class extends LegacyTestWalletSession {
        constructor(seed: Uint8Array, chainId: string, deploymentId: string) {
          super(seed, chainId, deploymentId, core);
        }
      },
    };
    this.dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => module,
      deviceSessions: createWalletDeviceWorkerService({ keyStore, now }),
      signatureVault: createWalletSignatureVaultWorkerService(),
      now,
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
  }

  postMessage(message: unknown, transfer: Transferable[] = []) {
    const cloned = structuredClone(message, { transfer });
    parseWalletWorkerRequest(cloned);
    void this.dispatcher.dispatch(cloned).then((reply) => this.emit(reply));
  }
  terminate() { this.dispatcher.terminate(); }
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    this.listeners[type].add(listener as never);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    this.listeners[type].delete(listener as never);
  }
  private emit(reply: WalletWorkerReply) {
    for (const listener of this.listeners.message) listener(new MessageEvent("message", { data: structuredClone(reply) }));
  }
}

function createRuntime(
  core: LegacyTestWalletCore = walletWasm,
  options: Parameters<typeof createZylithWalletRuntime>[1] = {},
  transformPort?: (port: WalletCryptoPort) => WalletCryptoPort,
) {
  if (options.walletCryptoClientFactory) return createZylithWalletRuntime(core, options);
  const keyStore = new TestDeviceKeyStore();
  return createZylithWalletRuntime(core, {
    ...options,
    walletCryptoClientFactory: ({ deviceRecordStore, onInvalidated }) => {
      const port = createWalletCryptoClient({
        workerFactory: () => new RuntimeTestWorker(core, keyStore, options.now),
        deviceRecordStore,
        onInvalidated,
      });
      return transformPort?.(port) ?? port;
    },
  });
}

function overrideWalletPort(
  port: WalletCryptoPort,
  overrides: Partial<WalletCryptoPort>,
): WalletCryptoPort {
  return new Proxy(port, {
    get(target, property) {
      const override = overrides[property as keyof WalletCryptoPort];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function executionRegistry(keyId = "current") {
  return { keys: [{ key_id: keyId, algorithm: HPKE_PROFILE, public_key: X25519_PUBLIC_KEY }] };
}

const fundingSubmissionBoundary = vi.hoisted(() => ({
  imported: false,
  submit: vi.fn(async (_input: unknown) => ({ transactionHash: "0x888" })),
}));
vi.mock("./integrations/starknetPrivacyFunding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./integrations/starknetPrivacyFunding")>();
  fundingSubmissionBoundary.imported = true;
  return { ...actual, submitResidualRecovery: fundingSubmissionBoundary.submit };
});

const walletPrivacyBoundary = vi.hoisted(() => {
  const prepareInvoke = vi.fn();
  const submitProofBearingCall = vi.fn();
  return {
    prepareInvoke,
    submitProofBearingCall,
    claim: vi.fn(async (input: {
      assertWalletContext?: () => void;
      buildAuthorizationCall: (openNoteId: string) => Promise<unknown>;
    }) => {
      input.assertWalletContext?.();
      const openNoteId = "0x777";
      prepareInvoke(openNoteId);
      const authorization = await input.buildAuthorizationCall(openNoteId);
      input.assertWalletContext?.();
      submitProofBearingCall(authorization);
      return { transactionHash: "0x999" };
    }),
  };
});
vi.mock("./integrations/starknetWalletPrivacy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./integrations/starknetWalletPrivacy")>();
  return { ...actual, claimZylithExitToWallet: walletPrivacyBoundary.claim };
});

const proofSignerMaterial = {
  key_schedule_version: 2,
  proof_signer_private_key: "0x7a22e19566683233efedfa4d595a6faf3ca1f62a5e74a3ee9fe631714fce6d8",
  proof_signer_salt: "0x749be86411fe1f66ae6e9e4cbcf00a326d242efe8930673d199e5b2a358d3d8",
};

function testProofSignerContextFelt(value: unknown, label: string) {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} must be a nonzero canonical Starknet felt.`);
  }
  const digits = value.replace(/^0x/, "").replace(/^0+/, "");
  if (!digits || digits.length > 64) throw new Error(`${label} must be a nonzero canonical Starknet felt.`);
  const parsed = BigInt(`0x${digits}`);
  if (parsed >= STARKNET_FIELD_PRIME) throw new Error(`${label} must be a nonzero canonical Starknet felt.`);
  return `0x${parsed.toString(16)}`;
}

function buildWalletProofSignerMaterial(
  derive: (inputJson: string) => string,
  input: {
    seedHex: string;
    manifest: Pick<DeploymentConfig, "chain_id" | "funding" | "market_registry">;
    connectedChainId: unknown;
  },
) {
  const chainId = testProofSignerContextFelt(input.manifest.chain_id, "chain_id");
  if (testProofSignerContextFelt(input.connectedChainId, "connected_chain_id") !== chainId) {
    throw new Error("Connected Starknet wallet chain does not match the deployment network.");
  }
  const rail = selectedResidualRecoveryFundingRail(input.manifest);
  const classHash = testProofSignerContextFelt(rail.privacyProofSignerClassHash, "privacy_proof_signer_class_hash");
  return parseWalletProofSignerMaterial(derive(JSON.stringify({
    seed_hex: input.seedHex,
    chain_id: chainId,
    proof_signer_class_hash: classHash,
  })));
}

function buildWalletDepositSubmissionPlan<T>(
  buildPlan: (inputJson: string) => string,
  input: {
    seedHex: string;
    manifest: Pick<DeploymentConfig, "chain_id" | "funding" | "market_registry">;
    connectedChainId: unknown;
    assetId: string;
    amountAtoms: string;
    depositNonce: string;
  },
): T {
  const chainId = normalizeStrictFelt(requiredNonZeroFelt(input.manifest.chain_id, "chain_id"));
  const connectedChainId = normalizeStrictFelt(requiredNonZeroFelt(input.connectedChainId, "connected_chain_id"));
  if (connectedChainId !== chainId) throw new Error("Connected Starknet wallet chain does not match the deployment network.");
  const bridgeAddress = normalizeStrictFelt(requiredNonZeroFelt(
    selectedDepositFundingRail(input.manifest).bridgeAdapter,
    "privacy_deposit_bridge_address",
  ));
  return JSON.parse(buildPlan(JSON.stringify({
    seed_hex: input.seedHex,
    chain_id: chainId,
    bridge_address: bridgeAddress,
    asset_id: input.assetId,
    amount: input.amountAtoms,
    deposit_nonce: input.depositNonce,
  }))) as T;
}
const invalidProofSignerResults: Array<[string, string]> = [
  ...[undefined, 1, 3, "2", 2.5, null, true, {}, []].map((version): [string, string] => [
    `version ${JSON.stringify(version)}`, JSON.stringify({ ...proofSignerMaterial, key_schedule_version: version }),
  ]),
  ...["proof_signer_private_key", "proof_signer_salt"].flatMap((field) => [
    ...[undefined, null, 1, [], {}, "", "0x0", "0x00", "-0x1", "+0x1", " 0x1", "0x1 ", "0xg", "1", "0x01", "0xA", "0X1"].map((value): [string, string] => [
      `${field} ${JSON.stringify(value)}`, JSON.stringify({ ...proofSignerMaterial, [field]: value }),
    ]),
    [`duplicate ${field}`, JSON.stringify(proofSignerMaterial).replace("{", `{"${field}":"0x1",`)] as [string, string],
  ]),
  ["curve order", JSON.stringify({ ...proofSignerMaterial, proof_signer_private_key: "0x800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f" })],
  ["scalar above order within field", JSON.stringify({ ...proofSignerMaterial, proof_signer_private_key: "0x800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d30" })],
  ["field modulus", JSON.stringify({ ...proofSignerMaterial, proof_signer_salt: "0x800000000000011000000000000000000000000000000000000000000000001" })],
  ["field overflow", JSON.stringify({ ...proofSignerMaterial, proof_signer_salt: "0x10000000000000000000000000000000000000000000000000000000000000000" })],
  ["extra field", JSON.stringify({ ...proofSignerMaterial, seed_hex: "01".repeat(32) })],
  ["escaped duplicate version", JSON.stringify(proofSignerMaterial).replace("{", '{"key_schedule_\\u0076ersion":2,')],
  ["noncanonical float version", JSON.stringify(proofSignerMaterial).replace('"key_schedule_version":2', '"key_schedule_version":2.0')],
  ["noncanonical exponent version", JSON.stringify(proofSignerMaterial).replace('"key_schedule_version":2', '"key_schedule_version":2e0')],
  ["array", "[]"], ["null", "null"], ["malformed json", "{"],
];

describe("proof signer v2 browser boundary", () => {
  walletWasm.initSync({ module: readFileSync("public/wallet/zylith_wallet_wasm_bg.wasm") });
  const manifest = JSON.parse(JSON.stringify(exampleDeployment).replaceAll('"0x0"', '"0x123"')) as DeploymentConfig;
  const request = { seedHex: "01".repeat(32), manifest, connectedChainId: manifest.chain_id };

  it.each([
    ["00", "0x61e92aa2f68fab50076a57d60f9a65fd953242fd5b5a4ce0c05f3b8a1d4b6db", "0x788689130ce49a08cf4ad92ac95537b9629dc5dea84c26a3d56301466a943f3"],
    ["01", proofSignerMaterial.proof_signer_private_key, proofSignerMaterial.proof_signer_salt],
  ])("matches the generated wasm KAT for seed %s", (byte, privateKey, salt) => {
    const material = buildWalletProofSignerMaterial(walletWasm.zylith_wallet_derive_proof_signer, { ...request, seedHex: byte.repeat(32) });
    expect(material).toEqual({ proofSignerPrivateKey: privateKey, proofSignerSalt: salt });
  });

  it("passes only the canonical manifest chain and selected class to wasm", () => {
    const derive = vi.fn((_input: string) => JSON.stringify(proofSignerMaterial));
    const material = buildWalletProofSignerMaterial(derive, request);
    expect(JSON.parse(derive.mock.calls[0][0])).toEqual({ seed_hex: request.seedHex, chain_id: manifest.chain_id, proof_signer_class_hash: "0x123" });
    expect(material).toEqual({ proofSignerPrivateKey: proofSignerMaterial.proof_signer_private_key, proofSignerSalt: proofSignerMaterial.proof_signer_salt });
  });

  it.each(invalidProofSignerResults)("rejects malformed wasm output: %s", (_name, output) => {
    expect(() => buildWalletProofSignerMaterial(() => output, request)).toThrow(/proof signer|migration required/i);
  });

  it.each([undefined, null, "", "0x0", "0x1", "-0x1", "+0x1", " 0x534e5f5345504f4c4941", "0x534e5f5345504f4c4941 ", "SN_SEPOLIA"])("refuses unknown or mismatched connected chain %j before derivation", (connectedChainId) => {
    const derive = vi.fn(() => JSON.stringify(proofSignerMaterial));
    expect(() => buildWalletProofSignerMaterial(derive, { ...request, connectedChainId })).toThrow();
    expect(derive).not.toHaveBeenCalled();
  });

  it.each(["chain_id", "proof_signer_class_hash"])("rejects missing and invalid %s before derivation", (field) => {
    for (const invalid of [undefined, "", "0x0", " 0x1", "0x1 ", "-0x1", "+0x1", "0xg", "0x800000000000011000000000000000000000000000000000000000000000001"]) {
      const altered = structuredClone(manifest);
      if (field === "chain_id") altered.chain_id = invalid as string;
      else altered.funding.starknet_privacy!.proof_signer_class_hash = invalid;
      const derive = vi.fn(() => JSON.stringify(proofSignerMaterial));
      expect(() => buildWalletProofSignerMaterial(derive, { ...request, manifest: altered })).toThrow();
      expect(derive).not.toHaveBeenCalled();
    }
  });
});

describe("wallet v2 browser restore compatibility", () => {
  walletWasm.initSync({ module: readFileSync("public/wallet/zylith_wallet_wasm_bg.wasm") });
  const seedHex = "01".repeat(32);
  const manifest = JSON.parse(JSON.stringify(exampleDeployment).replaceAll('"0x0"', '"0x123"')) as DeploymentConfig;
  manifest.deployment = { finalized: true, release_commit: "a".repeat(40) };
  manifest.proof.config_locked_after_deploy = true;
  manifest.funding.starknet_privacy!.ingress_key_registry_fingerprint = "ab".repeat(32);
  const wrongVersions = [undefined, 1, 3, "2", 2.5, null, true, {}, []].map((version) => [version]);
  let runtime: ReturnType<typeof createZylithWalletRuntime>;
  let context: WalletSignatureVaultContext;
  let scope: string;
  let stateKey: string;
  let recovery: unknown[];
  let recoveryBody: string | null;
  let remoteVault: unknown;
  let requests: string[];
  let rpcResponses: Record<string, string[]>;
  let providerRequest: Mock<(input: { type?: string; method?: string; params?: unknown }) => Promise<unknown>>;

  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      key: (index: number) => [...values.keys()][index] ?? null,
    });
    localStorage.clear();
    recovery = [];
    recoveryBody = null;
    remoteVault = null;
    requests = [];
    rpcResponses = {};
    manifest.funding.starknet_privacy!.ingress_key_registry_fingerprint = "ab".repeat(32);
    fundingSubmissionBoundary.submit.mockClear();
    walletPrivacyBoundary.claim.mockClear();
    walletPrivacyBoundary.prepareInvoke.mockClear();
    walletPrivacyBoundary.submitProofBearingCall.mockClear();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/deployment.json") return new Response(JSON.stringify(manifest));
      if (url.includes("/api/recovery/")) {
        if (init?.method === "POST") return new Response(JSON.stringify(JSON.parse(String(init.body)).artifact));
        return new Response(recoveryBody ?? JSON.stringify({ artifacts: recovery }));
      }
      if (url === manifest.rpc_url) {
        const request = JSON.parse(String(init?.body));
        const result = rpcResponses[request.params.request.entry_point_selector];
        if (!result) throw new Error("unexpected rpc read");
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      }
      if (url.includes("/api/wallet-vaults/")) {
        const walletAuthId = decodeURIComponent(url.split("/").at(-1)!);
        return remoteVault ? new Response(JSON.stringify({ wallet_auth_id: walletAuthId, vault: remoteVault })) : new Response(null, { status: 404 });
      }
      throw new Error(`unexpected network request: ${url}`);
    });
    providerRequest = vi.fn(async (input: { type?: string; method?: string }) => {
        const method = input.type ?? input.method;
        if (method === "wallet_requestAccounts") return ["0xabc"];
        if (method?.includes("ChainId") || method?.includes("chainId")) return manifest.chain_id;
        if (method?.includes("signTypedData")) return ["0x1", "0x2"];
        throw new Error(`unexpected provider request: ${method}`);
    });
    await connectStarknetProvider({ request: providerRequest }, "test-wallet");
    context = {
      signature: ["0x1", "0x2"], walletAddress: "0xabc", chainId: manifest.chain_id,
      deploymentId: await walletAuthDeploymentId(manifest, 2), origin: window.location.origin, messageVersion: 2,
    };
    const config = JSON.parse(walletWasm.zylith_wallet_derive_public_config(seedHex));
    scope = `${config.account_id}:0x123`;
    stateKey = `zylith.wallet.state.v2:${scope}`;
    const vault = await encryptSeedWithWalletSignature(seedHex, context);
    localStorage.setItem("zylith.wallet.vault.v1:0xabc", JSON.stringify(vault));
    runtime = createRuntime();
  });

  afterEach(() => {
    runtime?.suspend();
    clearSelectedStarknetProvider();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const state = () => ({ version: 2, key_schedule_version: 2, notes: [], orders: [], scanned_seq: 0 });

  it("keeps root-seed identifiers and stateless secret wallet exports out of the production runtime", () => {
    const source = readFileSync("src/zylithWalletRuntime.ts", "utf8");
    expect(source).not.toMatch(/\bseedHex\b|\bseed_hex\b/);
    for (const forbidden of [
      "zylith_wallet_generate_seed_hex",
      "zylith_wallet_derive_public_config",
      "zylith_wallet_recovery_auth_tag",
      "zylith_wallet_build_deposit_submission_plan",
      "zylith_wallet_build_order_request",
      "zylith_wallet_build_cancel_request",
      "zylith_wallet_build_withdraw_request",
      "zylith_wallet_build_status_requests",
      "zylith_wallet_build_residual_recovery",
      "zylith_wallet_create_recovery_snapshot",
      "zylith_wallet_decrypt_recovery_artifact",
      "zylith_wallet_sign_strk20_exit_claim",
    ]) expect(source).not.toContain(forbidden);
  });

  it("binds signature authorization to one canonical worker context without retaining a root seed", async () => {
    const config = JSON.parse(walletWasm.zylith_wallet_derive_public_config(seedHex));
    const contexts: unknown[] = [];
    const preparation = {
      binding: { sessionId: `wcs_${"07".repeat(16)}`, generation: 1, contextToken: "opaque" },
      preparationToken: "08".repeat(16),
      vaultRaw: localStorage.getItem("zylith.wallet.vault.v1:0xabc")!,
      walletAuthId: "09".repeat(32),
      authToken: "0a".repeat(32),
      device: null,
    };
    const port = {
      prepareSignatureVaultOpen: vi.fn(async (_signature: unknown, _vaultRaw: string, workerContext: unknown) => {
        contexts.push(workerContext);
        return preparation;
      }),
      commitSignatureVault: vi.fn(async () => preparation.binding),
      publicConfig: vi.fn(async () => JSON.stringify(config)),
      recoveryAuthTag: vi.fn(async () => "0b".repeat(32)),
      finalizeSignatureVault: vi.fn(async () => ({ remembered: false })),
      lock: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as WalletCryptoPort;
    runtime = createRuntime(walletWasm, {
      walletCryptoClientFactory: () => port,
      now: () => 1_000,
    });

    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(contexts).toEqual([{
      walletAddress: "0xabc",
      chainId: manifest.chain_id,
      deploymentId: manifest.contracts.exchange,
      vaultDeploymentId: await walletAuthDeploymentId(manifest, 2),
      origin: window.location.origin,
      manifestIdentity: await deploymentManifestIdentity(manifest),
      manifestVersion: "1",
      expiresAtMs: 1_000 + 7 * 24 * 60 * 60 * 1_000,
    }]);
    expect(JSON.stringify(port)).not.toContain(seedHex);
    expect(runtime.getPublicConfig()).toEqual(config);
  });

  it("commits, hydrates, and finalizes before publishing runtime readiness", async () => {
    const config = JSON.parse(walletWasm.zylith_wallet_derive_public_config(seedHex));
    const phases: string[] = [];
    const preparation = {
      binding: { sessionId: `wcs_${"07".repeat(16)}`, generation: 1, contextToken: "opaque" },
      preparationToken: "08".repeat(16),
      vaultRaw: localStorage.getItem("zylith.wallet.vault.v1:0xabc")!,
      walletAuthId: "09".repeat(32),
      authToken: "0a".repeat(32),
      device: null,
    };
    const observe = (phase: string) => {
      phases.push(phase);
      expect(runtime.isReady()).toBe(false);
    };
    const port = {
      prepareSignatureVaultOpen: vi.fn(async () => {
        observe("prepare");
        return preparation;
      }),
      commitSignatureVault: vi.fn(async () => {
        observe("commit");
        return preparation.binding;
      }),
      publicConfig: vi.fn(async () => {
        observe("hydrate-public-config");
        return JSON.stringify(config);
      }),
      recoveryAuthTag: vi.fn(async () => {
        observe("hydrate-recovery-auth");
        return "0b".repeat(32);
      }),
      finalizeSignatureVault: vi.fn(async () => {
        observe("finalize");
        return { remembered: false };
      }),
      lock: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as WalletCryptoPort;
    runtime = createRuntime(walletWasm, { walletCryptoClientFactory: () => port });

    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(phases).toEqual([
      "prepare",
      "commit",
      "hydrate-public-config",
      "hydrate-recovery-auth",
      "finalize",
    ]);
    expect(runtime.isReady()).toBe(true);
  });

  it("ignores invalidation from a detached client generation", async () => {
    const callbacks: Array<() => void> = [];
    const keyStore = new TestDeviceKeyStore();
    runtime = createZylithWalletRuntime(walletWasm, {
      walletCryptoClientFactory: ({ deviceRecordStore, onInvalidated }) => {
        callbacks.push(() => onInvalidated?.("WORKER_FAILED"));
        return createWalletCryptoClient({
          workerFactory: () => new RuntimeTestWorker(walletWasm, keyStore),
          deviceRecordStore,
          onInvalidated,
        });
      },
    });

    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    runtime.suspend();
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const currentConfig = runtime.getPublicConfig();

    callbacks[0]!();
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(currentConfig);

    callbacks.at(-1)!();
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it("aborts a prepared worker session when its vault bytes do not exactly match the owned record", async () => {
    const storedRaw = localStorage.getItem("zylith.wallet.vault.v1:0xabc")!;
    const abort = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const port = {
      prepareSignatureVaultOpen: vi.fn(async () => ({
        binding: { sessionId: `wcs_${"07".repeat(16)}`, generation: 1, contextToken: "opaque" },
        preparationToken: "08".repeat(16),
        vaultRaw: JSON.stringify({ ...JSON.parse(storedRaw), ciphertext: btoa("x".repeat(48)) }),
        walletAuthId: "09".repeat(32),
        authToken: "0a".repeat(32),
        device: null,
      })),
      abortSignatureVault: abort,
      lock: vi.fn(async () => undefined),
      dispose,
    } as unknown as WalletCryptoPort;
    runtime = createRuntime(walletWasm, { walletCryptoClientFactory: () => port });

    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/session changed/i);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it("locks a worker that rejects vault preparation and leaves no partial runtime session", async () => {
    const failure = new Error("vault preparation failed");
    const lock = vi.fn(async () => undefined);
    const port = {
      prepareSignatureVaultOpen: vi.fn(async () => { throw failure; }),
      lock,
      dispose: vi.fn(),
    } as unknown as WalletCryptoPort;
    runtime = createRuntime(walletWasm, { walletCryptoClientFactory: () => port });

    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toBe(failure);
    await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(1));
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it("refuses wallet creation before backing up a new seed when a legacy device locator exists", async () => {
    localStorage.removeItem("zylith.wallet.vault.v1:0xabc");
    localStorage.setItem("zylith.wallet.device-session.v1:0xabc", "legacy-device-record");
    await rejectWithoutMutation(() => runtime.createWalletWithWalletSignature("0xabc"));
  });

  it.each(["local decryption", "device key generation"])("refuses hydration when a legacy device locator appears during %s", async (phase) => {
    const legacy = "legacy-device-record";
    if (phase === "local decryption") {
      const store = await encryptLocalStore(state(), seedHex, walletWasm);
      localStorage.setItem(stateKey, JSON.stringify(store));
      runtime = createRuntime({ ...walletWasm, zylith_wallet_decrypt_local_state: (seed, raw) => {
        const value = walletWasm.zylith_wallet_decrypt_local_state(seed, raw);
        localStorage.setItem("zylith.wallet.device-session.v1:0xabc", legacy);
        return value;
      } });
    } else {
      const generate = crypto.subtle.generateKey.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "generateKey").mockImplementation(async () => {
        const key = await generate({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        localStorage.setItem("zylith.wallet.device-session.v1:0xabc", legacy);
        return key;
      });
    }
    const originalState = localStorage.getItem(stateKey);
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/migration required/i);
    expect(localStorage.getItem("zylith.wallet.device-session.v1:0xabc")).toBe(legacy);
    expect(localStorage.getItem(stateKey)).toBe(originalState);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  it("preserves a legacy local record arriving during recovery encryption", async () => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    localStorage.setItem(stateKey, JSON.stringify({ ...store, nonce: btoa("n".repeat(12)) }));
    recovery = [JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({ seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1, payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: { ...state(), scanned_seq: 1 } }) })))];
    const legacy = JSON.stringify({ version: 1, key_schedule_version: 2, algorithm: "AES-GCM", nonce: store.nonce, ciphertext: store.ciphertext });
    runtime = createRuntime({ ...walletWasm, zylith_wallet_encrypt_local_state: (input) => {
      const record = walletWasm.zylith_wallet_encrypt_local_state(input);
      localStorage.setItem(stateKey, legacy);
      return record;
    } });
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/migration required/i);
    expect(localStorage.getItem(stateKey)).toBe(legacy);
    expect(runtime.isReady()).toBe(false);
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  it.each(["local decryption", "recovery wait"])("refuses hydration when a legacy local record appears during %s", async (phase) => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    localStorage.setItem(stateKey, JSON.stringify(store));
    const legacy = JSON.stringify({ version: 1, key_schedule_version: 2, algorithm: "AES-GCM", nonce: store.nonce, ciphertext: store.ciphertext });
    if (phase === "local decryption") {
      runtime = createRuntime({ ...walletWasm, zylith_wallet_decrypt_local_state: (seed, raw) => {
        const value = walletWasm.zylith_wallet_decrypt_local_state(seed, raw);
        localStorage.setItem(stateKey, legacy);
        return value;
      } });
    } else {
      const fetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init);
        if (String(input).includes("/api/recovery/") && !init?.method) localStorage.setItem(stateKey, legacy);
        return response;
      });
    }
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/migration required/i);
    expect(localStorage.getItem(stateKey)).toBe(legacy);
    expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBeNull();
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  it("refuses hydration from replaced compatible bytes without quarantining the replacement", async () => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    const replacement = JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 1 }, seedHex, walletWasm));
    localStorage.setItem(stateKey, JSON.stringify(store));
    runtime = createRuntime({ ...walletWasm, zylith_wallet_decrypt_local_state: (seed, raw) => {
      const value = walletWasm.zylith_wallet_decrypt_local_state(seed, raw);
      localStorage.setItem(stateKey, replacement);
      return value;
    } });
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/session changed/i);
    expect(localStorage.getItem(stateKey)).toBe(replacement);
    expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBeNull();
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it.each(["replacement", "removal"].flatMap((change) => [false, true].map((merge) => [change, merge] as const)))(
    "preserves exact hydration ownership on %s during recovery with merge %s", async (change, merge) => {
      const original = JSON.stringify(await encryptLocalStore(state(), seedHex, walletWasm));
      const replacement = JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 7 }, seedHex, walletWasm));
      localStorage.setItem(stateKey, original);
      if (merge) recovery = [JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({
        seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1,
        payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: { ...state(), notes: [note("0x77", true)] } }),
      })))];
      const fetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init);
        if (String(input).includes("/api/recovery/") && !init?.method) {
          if (change === "replacement") localStorage.setItem(stateKey, replacement);
          else localStorage.removeItem(stateKey);
        }
        return response;
      });
      await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/session changed/i);
      expect(localStorage.getItem(stateKey)).toBe(change === "replacement" ? replacement : null);
      expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBeNull();
      expect(runtime.isReady()).toBe(false);
      expect(runtime.getPublicConfig()).toBeNull();
    },
  );

  it.each(["absent", "current", "damaged"])("updates hydration ownership after its own recovery write from %s", async (initial) => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    if (initial !== "absent") localStorage.setItem(stateKey, JSON.stringify(initial === "damaged"
      ? { ...store, nonce: btoa("n".repeat(12)) } : store));
    recovery = [JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({
      seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1,
      payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: { ...state(), notes: [note("0x77", true)] } }),
    })))];
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(runtime.isReady()).toBe(true);
    expect(JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!)).notes).toEqual([note("0x77", true)]);
  });

  it.each(["replacement", "removal"])("preserves hydration ownership on %s during recovery encryption", async (change) => {
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore(state(), seedHex, walletWasm)));
    const replacement = JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 7 }, seedHex, walletWasm));
    recovery = [JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({
      seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1,
      payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: { ...state(), notes: [note("0x77", true)] } }),
    })))];
    runtime = createRuntime({ ...walletWasm, zylith_wallet_encrypt_local_state: (input) => {
      const encrypted = walletWasm.zylith_wallet_encrypt_local_state(input);
      if (change === "replacement") localStorage.setItem(stateKey, replacement);
      else localStorage.removeItem(stateKey);
      return encrypted;
    } });
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/session changed/i);
    expect(localStorage.getItem(stateKey)).toBe(change === "replacement" ? replacement : null);
    expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBeNull();
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it("preserves an authenticated insertion when hydration accepted an absent locator", async () => {
    const replacement = JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 7 }, seedHex, walletWasm));
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (String(input).includes("/api/recovery/") && !init?.method) localStorage.setItem(stateKey, replacement);
      return response;
    });
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/session changed/i);
    expect(localStorage.getItem(stateKey)).toBe(replacement);
    expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBeNull();
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it("keeps a newer ready generation and replacement while an old hydration recovery resumes", async () => {
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore(state(), seedHex, walletWasm)));
    const replacement = JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 7 }, seedHex, walletWasm));
    const fetch = globalThis.fetch;
    let release!: (response: Response) => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let first = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && !init?.method && first) {
        first = false;
        entered();
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      return fetch(input, init);
    });
    const stale = runtime.unlockWithWalletSignature("0xabc").then(() => null, (error: unknown) => error);
    await paused;
    runtime.suspend();
    localStorage.setItem(stateKey, replacement);
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const config = runtime.getPublicConfig();
    release(new Response(JSON.stringify({ artifacts: [] })));
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(localStorage.getItem(stateKey)).toBe(replacement);
  });

  it.each(["replacement", "removal", "legacy"])("checks hydration ownership before readiness after its recovery write and %s", async (change) => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    const original = JSON.stringify({ ...store, nonce: btoa("n".repeat(12)) });
    const replacement = JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 7 }, seedHex, walletWasm));
    const legacy = JSON.stringify({ ...store, version: 1 });
    localStorage.setItem(stateKey, original);
    recovery = [JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({
      seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1,
      payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: { ...state(), notes: [note("0x77", true)] } }),
    })))];
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, raw) => {
      setItem(key, raw);
      if (key === stateKey) {
        if (change === "removal") localStorage.removeItem(stateKey);
        else setItem(stateKey, change === "legacy" ? legacy : replacement);
      }
    });
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(change === "legacy" ? /migration required/i : /session changed/i);
    expect(localStorage.getItem(stateKey)).toBe(change === "removal" ? null : change === "legacy" ? legacy : replacement);
    expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBe(original);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it("preserves a v2 local seed vault arriving during a remote v3 read", async () => {
    const current = JSON.parse(localStorage.getItem("zylith.wallet.vault.v1:0xabc")!);
    remoteVault = current;
    localStorage.removeItem("zylith.wallet.vault.v1:0xabc");
    const legacy = JSON.stringify({ ...current, version: 2, kdf: "wallet-signature-sha256-v2", algorithm: "AES-GCM" });
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (String(input).includes("/api/wallet-vaults/")) localStorage.setItem("zylith.wallet.vault.v1:0xabc", legacy);
      return response;
    });
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/migration required/i);
    expect(localStorage.getItem("zylith.wallet.vault.v1:0xabc")).toBe(legacy);
    expect(runtime.isReady()).toBe(false);
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  it("preserves old local state as migration-required without quarantine or writes", async () => {
    const old = JSON.stringify({ version: 1, key_schedule_version: 2, algorithm: "AES-GCM", nonce: btoa("n".repeat(12)), ciphertext: btoa("c".repeat(32)) });
    localStorage.setItem(stateKey, old);
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
    expect(localStorage.getItem(stateKey)).toBe(old);
    expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBeNull();
  });

  it.each(["local", "remote"])("preserves a v2 seed vault and rejects %s restore without a v3 write", async (where) => {
    const v3 = JSON.parse(localStorage.getItem("zylith.wallet.vault.v1:0xabc")!);
    const old = { ...v3, version: 2, kdf: "wallet-signature-sha256-v2", algorithm: "AES-GCM" };
    if (where === "local") localStorage.setItem("zylith.wallet.vault.v1:0xabc", JSON.stringify(old));
    else { remoteVault = old; localStorage.removeItem("zylith.wallet.vault.v1:0xabc"); }
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
    if (where === "remote") expect(remoteVault).toEqual(old);
  });

  it("quarantines authentication damage while preserving the exact original record", async () => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    const damaged = JSON.stringify({ ...store, ciphertext: (store.ciphertext[0] === "A" ? "B" : "A") + store.ciphertext.slice(1) });
    localStorage.setItem(stateKey, damaged);
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/damaged.*no valid recovery/i);
    expect(localStorage.getItem(stateKey)).toBe(damaged);
    expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBe(damaged);
    expect(runtime.isReady()).toBe(false);
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  it("checks the generation after wasm local decryption before using or quarantining stale state", async () => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    localStorage.setItem(stateKey, JSON.stringify(store));
    runtime = createRuntime({ ...walletWasm, zylith_wallet_decrypt_local_state: (seed, raw) => {
      const value = walletWasm.zylith_wallet_decrypt_local_state(seed, raw);
      runtime.suspend();
      localStorage.setItem(stateKey, "current-value");
      return value;
    } });
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/session changed/i);
    expect(localStorage.getItem(stateKey)).toBe("current-value");
    expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBeNull();
    expect(runtime.isReady()).toBe(false);
  });

  it("checks the generation after wasm local encryption before committing a recovery save", async () => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    localStorage.setItem(stateKey, JSON.stringify({ ...store, nonce: btoa("n".repeat(12)) }));
    recovery = [JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({ seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1, payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: { ...state(), scanned_seq: 1 } }) })))];
    runtime = createRuntime({ ...walletWasm, zylith_wallet_encrypt_local_state: (input) => {
      const record = walletWasm.zylith_wallet_encrypt_local_state(input);
      runtime.suspend();
      localStorage.setItem(stateKey, "current-value");
      return record;
    } });
    await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/session changed/i);
    expect(localStorage.getItem(stateKey)).toBe("current-value");
    expect(runtime.isReady()).toBe(false);
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  it("preserves full-digest device metadata and refuses it against the new signed deployment felt", async () => {
    const original = JSON.stringify({ version: 1, key_schedule_version: 2, algorithm: "AES-GCM", key_id: "1".repeat(32), wallet_address: "0xabc", chain_id: manifest.chain_id, deployment_id: "0x" + "a".repeat(64), origin: window.location.origin, created_at_ms: Date.now(), expires_at_ms: Date.now() + 60_000, nonce: btoa("n".repeat(12)), ciphertext: btoa("c".repeat(80)) });
    localStorage.setItem("zylith.wallet.device-session.v1:0xabc", original);
    await rejectWithoutMutation(() => runtime.unlockWithDeviceSession("0xabc"));
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
    expect(() => runtime.vaultAuthMode("0xabc")).toThrow(/migration required/i);
    expect(localStorage.getItem("zylith.wallet.device-session.v1:0xabc")).toBe(original);
  });

  async function readyResidualSubmission(
    derive: (input: string) => string,
    encrypt = walletWasm.zylith_wallet_encrypt_local_state,
  ) {
    const ids = JSON.parse(walletWasm.zylith_wallet_market_ids(JSON.stringify({ pair: "STRK/USDC", base_asset: "STRK", quote_asset: "USDC" })));
    const storedOrder = {
      ...order("0x4", 1, "expired"), closed_seq: 1, closed_seq_authenticated: true,
      residual: {
        ...residual(1), note_root: "0x333", membership: {},
        note: { ...residual(1).note, chain_context: "0x123", pair_id: ids.pair_id, input_asset_id: ids.base_asset_id },
      },
    };
    const store = await encryptLocalStore({ ...state(), orders: [storedOrder] }, seedHex, walletWasm);
    localStorage.setItem(stateKey, JSON.stringify(store));
    rpcResponses[hash.getSelectorFromName("pair_config")] = [ids.base_asset_id, ids.quote_asset_id, "1000000000000000000", "2", "0", "0", "0", "0", "0"];
    rpcResponses[hash.getSelectorFromName("nullifier_state")] = ["0"];
    runtime.suspend();
    runtime = createRuntime({
      ...walletWasm,
      zylith_wallet_encrypt_local_state: encrypt,
      zylith_wallet_derive_proof_signer: derive,
      zylith_wallet_build_residual_recovery: () => JSON.stringify({
        public: { nullifier: "0x444", commitment: "0x555", input_asset_id: ids.base_asset_id, input_amount: "5", output_asset_id: ids.quote_asset_id, output_amount: "0", fee_amount: "0" },
        witness: ["0x1"], calldata: ["0x2"], input_exit_commitment: "0x777", output_exit_commitment: null,
      }),
    });
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
  }

  function lateLegacyRecord(kind: string) {
    if (kind === "device") return { key: "zylith.wallet.device-session.v1:0xabc", raw: "legacy-device-record" };
    const key = kind === "local" ? stateKey : "zylith.wallet.vault.v1:0xabc";
    const current = JSON.parse(localStorage.getItem(key)!);
    return { key, raw: JSON.stringify({ ...current, version: kind === "local" ? 1 : 2 }) };
  }

  async function readySealedSubmission(operation: "order" | "cancel" | "withdraw", cancellationOrderIds = ["0x4"]) {
    const registry = executionRegistry();
    manifest.funding.starknet_privacy!.ingress_key_registry_fingerprint = walletWasm.zylith_wallet_registry_fingerprint(JSON.stringify(registry));
    delete manifest.funding.starknet_privacy!.ingress_key_registry_next_fingerprint;
    const cachedDeployment = await loadDeployment();
    cachedDeployment.funding.starknet_privacy!.ingress_key_registry_fingerprint = manifest.funding.starknet_privacy!.ingress_key_registry_fingerprint;
    delete cachedDeployment.funding.starknet_privacy!.ingress_key_registry_next_fingerprint;
    vi.spyOn(exchange(), "executionKeys").mockResolvedValue(registry);
    vi.spyOn(exchange(), "exchangeStatus").mockResolvedValue({
      exchange: manifest.contracts.exchange, seq: 0, last_close_ms: 0, epoch_ms: manifest.runtime.epoch_ms,
      pairs: manifest.market_registry.markets.filter((market) => market.enabled).map((market) => market.market_id),
      registry_version: manifest.market_registry.registry_version, registry_hash: manifest.market_registry.registry_hash,
    });
    vi.spyOn(exchange(), "status").mockImplementation(() => new Promise(() => {}));
    const notes: WalletNote[] = [];
    const orders: StoredOrder[] = [];
    for (const [index, orderId] of cancellationOrderIds.entries()) {
      const plan = JSON.parse(walletWasm.zylith_wallet_build_deposit_submission_plan(JSON.stringify({
        seed_hex: seedHex, chain_id: manifest.chain_id,
        bridge_address: manifest.funding.starknet_privacy!.bridge_adapter,
        asset_id: "STRK", amount: "1000000000000000000", deposit_nonce: String(index + 1),
      })));
      const summary = JSON.parse(walletWasm.zylith_wallet_note_summary(JSON.stringify(plan.note_fields)));
      const funding: WalletNote = { ...summary, fields: plan.note_fields, asset: "STRK", source: "output" };
      const initialOrder = {
        ...order(orderId, 1), expires_at_ms: Date.now() + 60_000,
        funding_notes: [funding.commitment], nullifiers: [funding.nullifier],
      };
      if (operation === "cancel") funding.locked_by = initialOrder.order_id;
      notes.push(funding);
      if (operation === "cancel") orders.push(initialOrder);
    }
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
      ...state(), notes, orders,
    }, seedHex, walletWasm)));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    return () => operation === "cancel" ? runtime.cancelOrder(cancellationOrderIds[0]) : operation === "withdraw" ? runtime.withdraw(notes[0].commitment) : runtime.submitOrder({
      pair: "STRK/USDC", side: "Sell", external: false, amount: notes[0].fields.amount,
      limitPrice: "1000000", expiresAtMs: Date.now() + 60_000,
    });
  }

  it.each(["order", "cancel", "withdraw"] as const)(
    "treats the operator's pre-open 429 for %s as proved not submitted",
    async (operation) => {
      const submit = await readySealedSubmission(operation);
      vi.spyOn(exchange(), "submit").mockRejectedValue(
        new ExchangeHttpError("/api/private/requests", 429, "rate limited"),
      );

      const failure = await submit().then(() => null, (error: unknown) =>
        normalizeFailure(error, {
          operation: operation === "withdraw" ? "withdrawal" : operation,
          domain: operation === "withdraw" ? "withdrawal" : "order",
        })
      );

      expect(failure).toMatchObject({
        outcome: "not-submitted",
        retrySafe: true,
        recovery: "retry",
      });
    },
  );

  it("keeps an operator 503 during withdrawal submission non-retryable", async () => {
    const submit = await readySealedSubmission("withdraw");
    vi.spyOn(exchange(), "submit").mockRejectedValue(
      new ExchangeHttpError("/api/private/requests", 503, "service unavailable"),
    );

    const error = await submit().then(() => null, (failure: unknown) => failure);
    expect(normalizeFailure(error, {
      operation: "withdrawal",
      domain: "withdrawal",
    })).toMatchObject({
      code: "WITHDRAWAL_STATUS_UNKNOWN",
      outcome: "unknown",
      retrySafe: false,
      recovery: "check-status",
    });
  });

  it.each(["order", "cancel", "withdraw", "status"] as const)(
    "passes the trusted post-registry chain and exchange context to the %s builder",
    async (operation) => {
      const captured: Record<string, unknown>[] = [];
      const capture = (input: string) => {
        captured.push(JSON.parse(input) as Record<string, unknown>);
        return input;
      };
      runtime.suspend();
      runtime = createRuntime({
        ...walletWasm,
        zylith_wallet_build_order_request: (input) => walletWasm.zylith_wallet_build_order_request(capture(input)),
        zylith_wallet_build_cancel_request: (input) => walletWasm.zylith_wallet_build_cancel_request(capture(input)),
        zylith_wallet_build_withdraw_request: (input) => walletWasm.zylith_wallet_build_withdraw_request(capture(input)),
        zylith_wallet_build_status_requests: (input) => walletWasm.zylith_wallet_build_status_requests(capture(input)),
      });
      const submit = await readySealedSubmission(operation === "status" ? "cancel" : operation);
      if (operation === "status") {
        await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));
      } else {
        vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
        await submit();
      }
      expect(captured.at(-1)).toMatchObject({
        chain_id: manifest.chain_id,
        chain_context: manifest.contracts.exchange,
      });
    },
  );

  it("refreshes the live session's pins when an active key changes after registry cache expiry", async () => {
    const submit = await readySealedSubmission("order", ["0x4", "0x5"]);
    const submitRequest = vi.spyOn(exchange(), "submit");
    await submit();
    const registryB = executionRegistry("next");
    const fingerprintB = walletWasm.zylith_wallet_registry_fingerprint(JSON.stringify(registryB));
    manifest.funding.starknet_privacy!.ingress_key_registry_next_fingerprint = fingerprintB;
    const registryRequest = vi.spyOn(exchange(), "executionKeys").mockResolvedValue(registryB);
    registryRequest.mockClear();
    vi.spyOn(exchange(), "status").mockResolvedValue({ orders: [], withdrawals: [] });
    const firstRegistryRequestCount = requests.filter((request) => request === "GET /deployment.json").length;
    const baseTime = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 60_001);

    await runtime.cancelOrder(runtime.getOrders()[0].order_id);
    expect(registryRequest).toHaveBeenCalledTimes(1);
    expect(submitRequest.mock.calls.at(-1)?.[0]).toMatchObject({ version: 3, key_id: "next" });
    expect(requests.filter((request) => request === "GET /deployment.json")).toHaveLength(firstRegistryRequestCount + 1);

    manifest.funding.starknet_privacy!.ingress_key_registry_fingerprint = fingerprintB;
    delete manifest.funding.starknet_privacy!.ingress_key_registry_next_fingerprint;
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 120_002);
    await runtime.submitOrder({
      pair: "STRK/USDC", side: "Sell", external: false,
      amount: "1000000000000000000", limitPrice: "1000000", expiresAtMs: baseTime + 3_600_000,
    });
    expect(registryRequest).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request === "GET /deployment.json")).toHaveLength(firstRegistryRequestCount + 1);
  });

  it("does not let a stale rotation refresh update the deployment cache after the wallet generation changes", async () => {
    await readySealedSubmission("cancel", ["0x4", "0x5"]);
    const registryA = executionRegistry();
    const registryC = executionRegistry("successor");
    const fingerprintC = walletWasm.zylith_wallet_registry_fingerprint(JSON.stringify(registryC));
    manifest.funding.starknet_privacy!.ingress_key_registry_next_fingerprint = fingerprintC;
    const overlapResponse = JSON.stringify(manifest);
    const registryRequest = vi.spyOn(exchange(), "executionKeys").mockResolvedValue(registryC);
    registryRequest.mockClear();
    vi.spyOn(exchange(), "status").mockResolvedValue({ orders: [], withdrawals: [] });
    const normalFetch = globalThis.fetch;
    let release!: (response: Response) => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let intercept = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (intercept && String(input) === "/deployment.json") {
        intercept = false;
        entered();
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      return normalFetch(input, init);
    });
    const baseTime = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 60_001);
    const stale = runtime.cancelOrder(runtime.getOrders()[0].order_id).then(() => null, (error: unknown) => error);
    await paused;

    runtime.suspend();
    delete manifest.funding.starknet_privacy!.ingress_key_registry_next_fingerprint;
    registryRequest.mockResolvedValue(registryA);
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const activeConfig = runtime.getPublicConfig();
    expect(pinnedRegistryFingerprints({ funding: (await loadDeployment()).funding })).toEqual([
      walletWasm.zylith_wallet_registry_fingerprint(JSON.stringify(registryA)),
    ]);
    release(new Response(overlapResponse));
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(activeConfig);
    expect(pinnedRegistryFingerprints({ funding: (await loadDeployment()).funding })).toEqual([
      walletWasm.zylith_wallet_registry_fingerprint(JSON.stringify(registryA)),
    ]);
  });

  it.each(["order", "cancel"].flatMap((operation) => ["device", "local", "vault"].flatMap((kind) =>
    ["success", "transport"].map((completion) => [operation, kind, completion] as const),
  )))(
    "propagates a post-submit %s migration when legacy %s storage arrives after %s", async (operation, kind, completion) => {
      const submit = await readySealedSubmission(operation as "order" | "cancel");
      const legacy = lateLegacyRecord(kind);
      const boundary = vi.spyOn(exchange(), "submit").mockImplementation(async () => {
        localStorage.setItem(legacy.key, legacy.raw);
        if (completion === "transport") throw new TypeError("network acknowledgement interrupted");
        return { order_id: "0x4" };
      });
      await expect(submit()).rejects.toThrow(/migration required/i);
      expect(boundary).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(legacy.key)).toBe(legacy.raw);
      expect(runtime.isReady()).toBe(false);
      expect(runtime.getPublicConfig()).toBeNull();
    },
  );

  it.each(["order", "cancel"].flatMap((operation) => ["success", "migration", "transport"].flatMap((completion) =>
    [false, true].map((newLegacy) => [operation, completion, newLegacy] as const),
  )))(
    "preserves a newer generation when stale post-submit %s completion resumes with %s and new legacy %s", async (operation, completion, newLegacy) => {
      const submit = await readySealedSubmission(operation as "order" | "cancel");
      let release!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>((resolve) => { entered = resolve; });
      vi.spyOn(exchange(), "submit").mockImplementation(() => {
        entered();
        return new Promise((resolve, reject) => { release = () => {
          if (completion === "migration") reject(new WalletMigrationRequiredError());
          else if (completion === "transport") reject(new TypeError("network acknowledgement interrupted"));
          else resolve({ order_id: "0x4" });
        }; });
      });
      const stale = submit().then(() => null, (error: unknown) => error);
      await paused;
      runtime.suspend();
      const replacement = JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 7 }, seedHex, walletWasm));
      localStorage.setItem(stateKey, replacement);
      await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
      const config = runtime.getPublicConfig();
      if (newLegacy) localStorage.setItem("zylith.wallet.device-session.v1:0xabc", "new-generation-legacy-record");
      release();
      expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
      expect(localStorage.getItem(stateKey)).toBe(replacement);
      expect(runtime.isReady()).toBe(true);
      expect(runtime.getPublicConfig()).toEqual(config);
      if (newLegacy) {
        expect(localStorage.getItem("zylith.wallet.device-session.v1:0xabc")).toBe("new-generation-legacy-record");
        await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/migration required/i);
        expect(runtime.isReady()).toBe(false);
        expect(runtime.getPublicConfig()).toBeNull();
      }
    },
  );

  it.each(["device", "local", "vault"])("does not reuse a cleared %s migration cause for a later operation or authorization", async (kind) => {
    const submit = await readySealedSubmission("cancel");
    const legacy = lateLegacyRecord(kind);
    const original = localStorage.getItem(legacy.key);
    const boundary = vi.spyOn(exchange(), "submit").mockImplementationOnce(async () => {
      localStorage.setItem(legacy.key, legacy.raw);
      return { order_id: "0x4" };
    });
    await expect(submit()).rejects.toThrow(/migration required/i);
    await expect(runtime.cancelOrder("0x4")).rejects.toThrow(/locked/i);
    if (original === null) localStorage.removeItem(legacy.key);
    else localStorage.setItem(legacy.key, original);
    const next = await readySealedSubmission("cancel");
    boundary.mockResolvedValue({ order_id: "0x4" });
    await expect(next()).resolves.toBeUndefined();
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).not.toBeNull();
  });

  it.each(["device", "local", "vault"])("routes a cancellation backup migration from legacy %s storage to its owner before submission", async (kind) => {
    const cancel = await readySealedSubmission("cancel");
    const legacy = lateLegacyRecord(kind);
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (String(input).includes("/api/recovery/") && init?.method === "POST") localStorage.setItem(legacy.key, legacy.raw);
      return response;
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    await expect(cancel()).rejects.toThrow(/migration required/i);
    expect(boundary).not.toHaveBeenCalled();
    expect(localStorage.getItem(legacy.key)).toBe(legacy.raw);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it("continues cancellation after an ordinary optional backup network failure", async () => {
    const cancel = await readySealedSubmission("cancel");
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") throw new TypeError("backup temporarily unavailable");
      return fetch(input, init);
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    await expect(cancel()).resolves.toBeUndefined();
    expect(boundary).toHaveBeenCalledTimes(1);
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getOrders()).toEqual([expect.objectContaining({ state: "cancelling" })]);
  });

  it.each(["none", "device", "local", "vault"])("rejects a stale recovery 409 without touching a newer session with legacy %s storage", async (kind) => {
    const cancel = await readySealedSubmission("cancel");
    const fetch = globalThis.fetch;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const uploads: Array<{ previous_artifact_id: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") {
        uploads.push(JSON.parse(String(init.body)));
        if (uploads.length === 1) {
          entered();
          return new Promise<Response>((resolve) => { release = () => resolve(new Response("{}", { status: 409 })); });
        }
      }
      return fetch(input, init);
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    const stale = cancel().then(() => null, (error: unknown) => error);
    await paused;
    runtime.suspend();
    const replacement = JSON.stringify(await encryptLocalStore({
      ...state(), scanned_seq: 7, orders: [{ ...order("0x4", 1), expires_at_ms: Date.now() + 60_000 }],
    }, seedHex, walletWasm));
    localStorage.setItem(stateKey, replacement);
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const config = runtime.getPublicConfig();
    const orders = runtime.getOrders();
    recovery = [JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({
      seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1,
      payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: { ...state(), notes: [note("0x77", true)] } }),
    })))];
    const legacy = kind === "none" ? null : lateLegacyRecord(kind);
    if (legacy) localStorage.setItem(legacy.key, legacy.raw);
    const expectedState = localStorage.getItem(stateKey);
    requests = [];
    const writes = vi.spyOn(localStorage, "setItem");
    release();
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    expect(requests.filter((request) => request.includes("/api/recovery/"))).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    expect(boundary).not.toHaveBeenCalled();
    expect(localStorage.getItem(stateKey)).toBe(expectedState);
    if (legacy) expect(localStorage.getItem(legacy.key)).toBe(legacy.raw);
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(runtime.getOrders()).toEqual(orders);
    if (!legacy) {
      await expect(runtime.cancelOrder("0x4")).resolves.toBeUndefined();
      expect(uploads[1].previous_artifact_id).toBeNull();
    }
  });

  it("retains current recovery conflict merge and retry semantics", async () => {
    const cancel = await readySealedSubmission("cancel");
    const head = JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({
      seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1,
      payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: { ...state(), notes: [note("0x77", true)] } }),
    })));
    recovery = [head];
    const fetch = globalThis.fetch;
    const uploads: Array<{ previous_artifact_id: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") {
        uploads.push(JSON.parse(String(init.body)));
        if (uploads.length === 1) return new Response("{}", { status: 409 });
      }
      return fetch(input, init);
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    requests = [];
    await expect(cancel()).resolves.toBeUndefined();
    expect(uploads).toHaveLength(2);
    expect(uploads[1].previous_artifact_id).toBe(head.artifact_id);
    expect(requests.filter((request) => request.startsWith("GET ") && request.includes("/api/recovery/"))).toHaveLength(1);
    expect(boundary).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!));
    expect(persisted.notes).toContainEqual(expect.objectContaining({ commitment: "0x77", spent: true }));
    expect(runtime.isReady()).toBe(true);
  });

  it.each(["device", "local", "vault"])("routes a current recovery 409 migration from legacy %s storage before conflict follow-up", async (kind) => {
    const cancel = await readySealedSubmission("cancel");
    const legacy = lateLegacyRecord(kind);
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (String(input).includes("/api/recovery/") && init?.method === "POST") {
        localStorage.setItem(legacy.key, legacy.raw);
        return new Response("{}", { status: 409 });
      }
      return response;
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    requests = [];
    await expect(cancel()).rejects.toThrow(/migration required/i);
    expect(requests.filter((request) => request.startsWith("GET ") && request.includes("/api/recovery/"))).toEqual([]);
    expect(boundary).not.toHaveBeenCalled();
    expect(localStorage.getItem(legacy.key)).toBe(legacy.raw);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it.each([
    ["suspend", "none"], ["suspend", "device"], ["suspend", "local"], ["suspend", "vault"],
    ["migration", "device"], ["migration", "local"], ["migration", "vault"],
  ])("never submits queued cancellations after %s with legacy %s storage", async (transition, kind) => {
    await readySealedSubmission("cancel", ["0x4", "0x5"]);
    const fetch = globalThis.fetch;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let uploads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") {
        uploads += 1;
        if (uploads === 1) {
          entered();
          await new Promise<void>((resolve) => { release = resolve; });
        }
      }
      return fetch(input, init);
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    const first = runtime.cancelOrder("0x4").then(() => null, (error: unknown) => error);
    await paused;
    const queued = runtime.cancelOrder("0x5").then(() => null, (error: unknown) => error);
    await vi.waitFor(() => {
      const persisted = JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!));
      expect(persisted.orders.filter((candidate: StoredOrder) => candidate.cancel_requested)).toHaveLength(2);
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    if (transition === "suspend") {
      runtime.suspend();
      localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
        ...state(), scanned_seq: 7, orders: [{ ...order("0x77", 1), expires_at_ms: Date.now() + 60_000 }],
      }, seedHex, walletWasm)));
      await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    }
    const config = runtime.getPublicConfig();
    const orders = runtime.getOrders();
    const legacy = kind === "none" ? null : lateLegacyRecord(kind);
    if (legacy) localStorage.setItem(legacy.key, legacy.raw);
    const expectedState = localStorage.getItem(stateKey);
    requests = [];
    const writes = vi.spyOn(localStorage, "setItem");
    release();
    const [firstFailure, queuedFailure] = await Promise.all([first, queued]);
    expect(firstFailure).toMatchObject({ name: transition === "migration" ? "WalletMigrationRequiredError" : "WalletSessionChangedError" });
    expect(queuedFailure).toMatchObject({ name: "WalletSessionChangedError" });
    expect(boundary).not.toHaveBeenCalled();
    expect(uploads).toBe(1);
    expect(requests.filter((request) => request.includes("/api/recovery/"))).toHaveLength(1);
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.getItem(stateKey)).toBe(expectedState);
    if (legacy) expect(localStorage.getItem(legacy.key)).toBe(legacy.raw);
    expect(runtime.isReady()).toBe(transition === "suspend");
    expect(runtime.getPublicConfig()).toEqual(transition === "suspend" ? config : null);
    expect(runtime.getOrders()).toEqual(transition === "suspend" ? orders : []);
  });

  it.each(["order", "withdraw"] as const)("rejects a stale queued %s backup without submitting or rolling back a newer session", async (operation) => {
    const submit = await readySealedSubmission(operation);
    const initial = JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!));
    initial.orders.push({ ...order("0x4", 1), expires_at_ms: Date.now() + 60_000 });
    runtime.suspend();
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore(initial, seedHex, walletWasm)));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const fetch = globalThis.fetch;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let uploads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") {
        uploads += 1;
        if (uploads === 1) {
          entered();
          await new Promise<void>((resolve) => { release = resolve; });
        }
      }
      return fetch(input, init);
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    const first = runtime.cancelOrder("0x4").then(() => null, (error: unknown) => error);
    await paused;
    const queued = submit().then(() => null, (error: unknown) => error);
    await vi.waitFor(() => {
      const persisted = JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!));
      if (operation === "order") expect(persisted.orders).toHaveLength(2);
      else expect(persisted.notes[0].exit?.stage).toBe("requested");
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    runtime.suspend();
    const replacement = localStorage.getItem(stateKey);
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const config = runtime.getPublicConfig();
    const orders = runtime.getOrders();
    const balances = runtime.getBalances();
    const writes = vi.spyOn(localStorage, "setItem");
    release();
    for (const failure of await Promise.all([first, queued])) expect(failure).toMatchObject({ name: "WalletSessionChangedError" });
    expect(boundary).not.toHaveBeenCalled();
    expect(uploads).toBe(1);
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.getItem(stateKey)).toBe(replacement);
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(runtime.getOrders()).toEqual(orders);
    expect(runtime.getBalances()).toEqual(balances);
  });

  it("rejects a stale queued residual recovery backup without preparing or submitting for a newer session", async () => {
    await readySealedSubmission("cancel");
    await readyResidualSubmission(() => JSON.stringify(proofSignerMaterial));
    const initial = JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!));
    initial.orders.push({ ...order("0x5", 1), expires_at_ms: Date.now() + 60_000 });
    runtime.suspend();
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore(initial, seedHex, walletWasm)));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const fetch = globalThis.fetch;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let uploads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") {
        uploads += 1;
        if (uploads === 1) {
          entered();
          await new Promise<void>((resolve) => { release = resolve; });
        }
      }
      return fetch(input, init);
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x5" });
    const first = runtime.cancelOrder("0x5").then(() => null, (error: unknown) => error);
    await paused;
    const queued = runtime.prepareResidualRecovery("0x4").then(() => null, (error: unknown) => error);
    await vi.waitFor(() => {
      const persisted = JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!));
      expect(persisted.orders.find((candidate: StoredOrder) => candidate.order_id === "0x4").residual_recovery?.nullifier).toBe("0x444");
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    runtime.suspend();
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore(state(), seedHex, walletWasm)));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const replacement = localStorage.getItem(stateKey);
    const config = runtime.getPublicConfig();
    const writes = vi.spyOn(localStorage, "setItem");
    release();
    for (const failure of await Promise.all([first, queued])) expect(failure).toMatchObject({ name: "WalletSessionChangedError" });
    expect(boundary).not.toHaveBeenCalled();
    expect(fundingSubmissionBoundary.submit).not.toHaveBeenCalled();
    expect(uploads).toBe(1);
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.getItem(stateKey)).toBe(replacement);
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(runtime.getOrders()).toEqual([]);
  });

  it("continues both current queued cancellations after ordinary backup network failures", async () => {
    await readySealedSubmission("cancel", ["0x4", "0x5"]);
    const fetch = globalThis.fetch;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let uploads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") {
        uploads += 1;
        if (uploads === 1) {
          entered();
          await new Promise<void>((resolve) => { release = resolve; });
        }
        throw new TypeError("backup temporarily unavailable");
      }
      return fetch(input, init);
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    const first = runtime.cancelOrder("0x4");
    await paused;
    const queued = runtime.cancelOrder("0x5");
    await vi.waitFor(() => {
      const persisted = JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!));
      expect(persisted.orders.filter((candidate: StoredOrder) => candidate.cancel_requested)).toHaveLength(2);
    });
    release();
    await expect(Promise.all([first, queued])).resolves.toEqual([undefined, undefined]);
    expect(uploads).toBe(2);
    expect(boundary).toHaveBeenCalledTimes(2);
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getOrders()).toEqual([expect.objectContaining({ state: "cancelling" }), expect.objectContaining({ state: "cancelling" })]);
  });

  it.each(["order", "withdraw"] as const)("preserves required-backup failure semantics without submitting %s", async (operation) => {
    const submit = await readySealedSubmission(operation);
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") throw new TypeError("backup temporarily unavailable");
      return fetch(input, init);
    });
    const boundary = vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    await expect(submit()).rejects.toThrow(/backup temporarily unavailable/i);
    expect(boundary).not.toHaveBeenCalled();
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getOrders()).toEqual([]);
    const persisted = JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!));
    expect(persisted.notes[0].locked_by).toBeUndefined();
    expect(persisted.notes[0].exit).toBeUndefined();
  });

  it("keeps a newer ready generation writable while an old damaged-state repair fails", async () => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    localStorage.setItem(stateKey, JSON.stringify({ ...store, nonce: btoa("n".repeat(12)) }));
    recovery = [JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({
      seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1,
      payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: { ...state(), notes: [note("0x77", true)] } }),
    })))];
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const continueSave = new Promise<void>((resolve) => { release = resolve; });
    runtime.suspend();
    let firstEncryption = true;
    runtime = createRuntime(walletWasm, {}, (port) => overrideWalletPort(port, {
      encryptLocalState: async (input) => {
        const record = await port.encryptLocalState(input);
        if (firstEncryption) {
          firstEncryption = false;
          entered();
          await continueSave;
        }
        return record;
      },
    }));
    const stale = runtime.unlockWithWalletSignature("0xabc").then(() => null, (error: unknown) => error);
    await paused;
    runtime.suspend();
    recovery = [];
    const cancel = await readySealedSubmission("cancel");
    const config = runtime.getPublicConfig();
    const replacement = localStorage.getItem(stateKey);
    release();
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(localStorage.getItem(stateKey)).toBe(replacement);
    vi.spyOn(exchange(), "submit").mockResolvedValue({ order_id: "0x4" });
    await expect(cancel()).resolves.toBeUndefined();
  });

  it.each(["success", "migration", "transport"])("propagates a stale refresh session change after %s", async (completion) => {
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
      ...state(), orders: [order("0x4", 1, "expired")],
    }, seedHex, walletWasm)));
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(exchange(), "indexerStatus").mockImplementationOnce(() => {
      entered();
      return new Promise((resolve, reject) => { release = () => {
        if (completion === "migration") reject(new WalletMigrationRequiredError());
        else if (completion === "transport") reject(new TypeError("indexer temporarily unavailable"));
        else resolve({ service: "zylith-indexer", deposits_bucket: "0", latest_seq: 0, last_successful_sync_unix_ms: 1, sync_lag_ms: 0 });
      }; });
    });
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const stale = runtime.refresh().then(() => null, (error: unknown) => error);
    await paused;
    runtime.suspend();
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore(state(), seedHex, walletWasm)));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const replacement = localStorage.getItem(stateKey);
    const config = runtime.getPublicConfig();
    release();
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(localStorage.getItem(stateKey)).toBe(replacement);
  });

  it("fences a stale deposit-index result before a receipt follow-up", async () => {
    const pending = note("0x77");
    pending.source = "deposit";
    pending.deposit = {
      funding_commitment: "0x88",
      request_id: "0x89",
      requested_at_ms: Date.now(),
      confirmed: false,
      transaction_hash: "0x90",
    };
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
      ...state(),
      notes: [pending],
    }, seedHex, walletWasm)));
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(exchange(), "recentDeposits").mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { release = resolve; }) as never;
    });

    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const stale = runtime.refresh().then(() => null, (error: unknown) => error);
    await paused;
    runtime.suspend();
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore(state(), seedHex, walletWasm)));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const replacement = localStorage.getItem(stateKey);
    const currentConfig = runtime.getPublicConfig();
    const fetch = globalThis.fetch;
    let receiptRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === manifest.rpc_url) {
        const request = JSON.parse(String(init?.body)) as { method?: string };
        if (request.method === "starknet_getTransactionReceipt") receiptRequests += 1;
      }
      return fetch(input, init);
    });

    release({
      recent_funding_commitments: [],
      last_successful_sync_unix_ms: 1,
      sync_lag_ms: 0,
    });
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    expect(receiptRequests).toBe(0);
    expect(localStorage.getItem(stateKey)).toBe(replacement);
    expect(runtime.getPublicConfig()).toEqual(currentConfig);
    expect(runtime.getPendingDeposits()).toEqual([]);
  });

  it("preserves a lost-acknowledgement deposit blocker across an application restart", async () => {
    const pending = note("0x77");
    pending.source = "deposit";
    pending.deposit = {
      funding_commitment: "0x88",
      request_id: "0x89",
      requested_at_ms: Date.now() - 24 * 60 * 60 * 1_000,
      confirmed: false,
    };
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
      ...state(),
      notes: [pending],
    }, seedHex, walletWasm)));

    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(runtime.getPendingDeposits()).toEqual([
      expect.objectContaining({
        note_commitment: pending.commitment,
        transaction_hash: undefined,
        confirmed: false,
        failed: false,
      }),
    ]);

    runtime.suspend();
    runtime = createRuntime();
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(runtime.getPendingDeposits()).toEqual([
      expect.objectContaining({
        note_commitment: pending.commitment,
        transaction_hash: undefined,
        confirmed: false,
        failed: false,
      }),
    ]);
  });

  it("preserves a confirmed public transfer without private credit across restart", async () => {
    const pending = note("0x78");
    pending.source = "deposit";
    pending.deposit = {
      funding_commitment: "0x88",
      request_id: "0x89",
      requested_at_ms: Date.now() - 24 * 60 * 60 * 1_000,
      transaction_hash: "0x90",
      public_transaction_confirmed: true,
      confirmed: false,
    };
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
      ...state(),
      notes: [pending],
    }, seedHex, walletWasm)));

    for (let restart = 0; restart < 2; restart += 1) {
      await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
      expect(runtime.getPendingDeposits()).toEqual([
        expect.objectContaining({
          note_commitment: pending.commitment,
          transaction_hash: "0x90",
          public_transaction_confirmed: true,
          confirmed: false,
          failed: false,
        }),
      ]);
      runtime.suspend();
      runtime = createRuntime();
    }
  });

  it("preserves the current session and error when refresh has an ordinary network failure", async () => {
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
      ...state(), orders: [order("0x4", 1, "expired")],
    }, seedHex, walletWasm)));
    const unavailable = new TypeError("indexer temporarily unavailable");
    vi.spyOn(exchange(), "indexerStatus").mockRejectedValue(unavailable);
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const replacement = localStorage.getItem(stateKey);
    await expect(runtime.refresh()).rejects.toBe(unavailable);
    expect(runtime.isReady()).toBe(true);
    expect(localStorage.getItem(stateKey)).toBe(replacement);
  });

  it("preserves a newer order and funding when an old recovery backup fails", async () => {
    const submit = await readySealedSubmission("order");
    const fetch = globalThis.fetch;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") {
        entered();
        return new Promise<Response>((_resolve, reject) => { release = () => reject(new TypeError("backup unavailable")); });
      }
      return fetch(input, init);
    });
    const stale = submit().then(() => null, (error: unknown) => error);
    await paused;
    runtime.suspend();
    const replacement = localStorage.getItem(stateKey);
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const config = runtime.getPublicConfig();
    const orders = runtime.getOrders();
    const balances = runtime.getBalances();
    release();
    const failure = await stale;
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(localStorage.getItem(stateKey)).toBe(replacement);
    expect(runtime.getOrders()).toEqual(orders);
    expect(runtime.getBalances()).toEqual(balances);
    expect(failure).toMatchObject({ name: "WalletSessionChangedError" });
  });

  it.each(["order", "cancel"] as const)("retains uncertain transport acknowledgement semantics for %s", async (operation) => {
    const submit = await readySealedSubmission(operation);
    vi.spyOn(exchange(), "submit").mockRejectedValue(new TypeError("network acknowledgement interrupted"));
    await expect(submit()).resolves.toEqual(operation === "order" ? expect.objectContaining({ order_id: expect.any(String) }) : undefined);
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getOrders()).toEqual([expect.objectContaining({ state: operation === "order" ? "submitting" : "cancelling" })]);
  });

  it.each(["device", "local", "vault"])("clears a ready session when legacy %s state arrives during an async save", async (kind) => {
    let legacy!: ReturnType<typeof lateLegacyRecord>;
    await readyResidualSubmission(() => JSON.stringify(proofSignerMaterial), (input) => {
      const record = walletWasm.zylith_wallet_encrypt_local_state(input);
      legacy = lateLegacyRecord(kind);
      localStorage.setItem(legacy.key, legacy.raw);
      return record;
    });
    requests = [];
    await expect(runtime.prepareResidualRecovery("0x4")).rejects.toThrow(/migration required/i);
    expect(localStorage.getItem(legacy.key)).toBe(legacy.raw);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
    expect(requests.some((request) => request.startsWith("POST ") && request.includes("/api/recovery/"))).toBe(false);
    expect(fundingSubmissionBoundary.submit).not.toHaveBeenCalled();
  });

  it.each(["device", "local", "vault"])("clears a ready session when legacy %s state arrives during async authorization", async (kind) => {
    await readyResidualSubmission(() => JSON.stringify(proofSignerMaterial));
    const legacy = lateLegacyRecord(kind);
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (String(input) === manifest.rpc_url) localStorage.setItem(legacy.key, legacy.raw);
      return response;
    });
    requests = [];
    await expect(runtime.prepareResidualRecovery("0x4")).rejects.toThrow(/migration required/i);
    expect(localStorage.getItem(legacy.key)).toBe(legacy.raw);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
    expect(requests.some((request) => request.startsWith("POST ") && request.includes("/api/recovery/"))).toBe(false);
    expect(fundingSubmissionBoundary.submit).not.toHaveBeenCalled();
  });

  it.each(["device", "local", "vault"].flatMap((kind) =>
    ["signature", "device", "vault mode", "refresh"].map((path) => [kind, path]),
  ))("clears a ready session with legacy %s state through %s authorization", async (kind, path) => {
    await readyResidualSubmission(() => JSON.stringify(proofSignerMaterial));
    const legacy = lateLegacyRecord(kind);
    localStorage.setItem(legacy.key, legacy.raw);
    if (path === "vault mode") expect(() => runtime.vaultAuthMode("0xabc")).toThrow(/migration required/i);
    else await expect(path === "signature" ? runtime.unlockWithWalletSignature("0xabc")
      : path === "device" ? runtime.unlockWithDeviceSession("0xabc") : runtime.refresh()).rejects.toThrow(/migration required/i);
    expect(localStorage.getItem(legacy.key)).toBe(legacy.raw);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it("does not let a stale migration failure clear a newer ready generation", async () => {
    await readyResidualSubmission(() => JSON.stringify(proofSignerMaterial));
    const fetch = globalThis.fetch;
    let rejectRpc!: (error: unknown) => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === manifest.rpc_url) {
        entered();
        return new Promise<Response>((_resolve, reject) => { rejectRpc = reject; });
      }
      return fetch(input, init);
    });
    const stale = runtime.prepareResidualRecovery("0x4").then(() => null, (error: unknown) => error);
    await paused;
    runtime.suspend();
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const currentConfig = runtime.getPublicConfig();
    const currentState = localStorage.getItem(stateKey);
    rejectRpc(new WalletMigrationRequiredError());
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(currentConfig);
    expect(localStorage.getItem(stateKey)).toBe(currentState);
  });

  async function rejectWithoutMutation(operation: () => Promise<unknown>) {
    const stored = () => Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index)!;
      return [key, localStorage.getItem(key)];
    }));
    const originals = stored();
    await expect(operation()).rejects.toThrow(/migration required/i);
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
    expect(stored()).toEqual(originals);
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  }

  it("opens v2 state through the actual generated wasm and signature restore path", async () => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    expect(store).toMatchObject({ key_schedule_version: 2 });
    localStorage.setItem(stateKey, JSON.stringify(store));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(runtime.getPublicConfig()).toEqual({
      key_schedule_version: 2,
      account_id: "3142846eff7f5cd3bea9c020fcf9eb1e07554647daa520b0d065a0ac86292bc0",
      spend_authority: "0x243f889e32d8c58c3782e1451d535e0a0fc6d989b53f13faf5f9f00dee1439c",
      owner_tag: "0x28204bd403e2e99dbbbc654d2cc20f3a0ec2a15d43f58235b8a5dfb02f6c0d1",
      withdraw_authority: "0x2fce9fc2142d4041978ed24ec83d33c1d22b8c857d2ca1c0cf250164648324f",
    });
  });

  it.each(wrongVersions)("refuses local-store envelope version %j before restore", async (version) => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    localStorage.setItem(stateKey, JSON.stringify({ ...store, key_schedule_version: version }));
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
  });

  it.each(wrongVersions)("refuses authenticated wallet-state version %j before restore", async (version) => {
    const store = await encryptLocalStore({ ...state(), key_schedule_version: version }, seedHex, walletWasm);
    localStorage.setItem(stateKey, JSON.stringify(store));
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
  });

  it.each(wrongVersions)("refuses seed-vault version %j without reinterpreting the seed", async (version) => {
    const vault = JSON.parse(localStorage.getItem("zylith.wallet.vault.v1:0xabc")!);
    localStorage.setItem("zylith.wallet.vault.v1:0xabc", JSON.stringify({ ...vault, key_schedule_version: version }));
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
  });

  it.each(wrongVersions)("refuses device-session version %j through alternate unlock", async (version) => {
    localStorage.setItem("zylith.wallet.device-session.v2:0xabc", JSON.stringify({
      version: 2, key_schedule_version: version, algorithm: "AES-GCM", key_id: "1".repeat(32),
      wallet_address: "0xabc", chain_id: manifest.chain_id, deployment_id: context.deploymentId,
      origin: window.location.origin, created_at_ms: Date.now(), expires_at_ms: Date.now() + 10_000,
      nonce: btoa("n".repeat(12)), ciphertext: btoa("c".repeat(80)),
    }));
    await rejectWithoutMutation(() => runtime.unlockWithDeviceSession("0xabc"));
  });

  it.each(["local-store", "seed-vault", "device-session"])("refuses duplicate escaped version fields in %s", async (kind) => {
    const key = kind === "local-store" ? stateKey : kind === "seed-vault" ? "zylith.wallet.vault.v1:0xabc" : "zylith.wallet.device-session.v2:0xabc";
    const value = kind === "local-store"
      ? await encryptLocalStore(state(), seedHex, walletWasm)
      : JSON.parse(localStorage.getItem("zylith.wallet.vault.v1:0xabc")!);
    const body = JSON.stringify({ ...value, key_schedule_version: 2 });
    localStorage.setItem(key, body.replace(/}$/, ',"key_schedule_\\u0076ersion":2}'));
    await rejectWithoutMutation(() => kind === "device-session"
      ? runtime.unlockWithDeviceSession("0xabc") : runtime.unlockWithWalletSignature("0xabc"));
  });

  it.each(wrongVersions)("refuses recovery artifact version %j before decrypt or merge", async (version) => {
    const artifact = JSON.parse(walletWasm.zylith_wallet_create_recovery_snapshot(JSON.stringify({
      seed_hex: seedHex, sequence: 1, created_at_unix_ms: 1,
      payload_json: JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: state() }),
    })));
    recovery = [{ ...artifact, key_schedule_version: version }];
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
  });

  async function authenticatedRecoveryFixture(plaintext: string) {
    const recoveryKey = Uint8Array.from("1b9a6ca6ab55f1a08a0e08527ff74b927ece1c3ebcd153d41752587cf023b0ae".match(/../g)!, (byte) => Number.parseInt(byte, 16));
    const material = await crypto.subtle.importKey("raw", recoveryKey, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("zylith/wallet-key-separation-v1"), info: new TextEncoder().encode("zylith/recovery-artifact-aes-key") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const nonce = new Uint8Array(12);
    const accountId = scope.split(":")[0];
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`zylith-recovery-artifact:2:aes-256-gcm/recovery-v1:${accountId}:Snapshot:1:1`) }, key, new TextEncoder().encode(plaintext));
    const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { artifact_id: "a".repeat(64), key_schedule_version: 2, account_id: accountId, kind: "Snapshot", sequence: 1, created_at_unix_ms: 1, payload: { key_schedule_version: 2, algorithm: "aes-256-gcm/recovery-v1", nonce: hex(nonce), ciphertext: hex(new Uint8Array(ciphertext)) } };
  }

  it("opens an independently encrypted v2 recovery fixture", async () => {
    recovery = [await authenticatedRecoveryFixture(JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: state() }))];
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
  });

  it.each(wrongVersions)("refuses authenticated recovery plaintext version %j", async (version) => {
    for (const inner of [false, true]) {
      recovery = [await authenticatedRecoveryFixture(JSON.stringify({ version: 2, key_schedule_version: inner ? 2 : version, scope, state: { ...state(), key_schedule_version: inner ? version : 2 } }))];
      await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
    }
  });

  it("refuses duplicate versions inside authenticated recovery ciphertext", async () => {
    const payload = JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: state() });
    recovery = [await authenticatedRecoveryFixture(payload.replace('"key_schedule_version":2', '"key_schedule_version":1,"key_schedule_\\u0076ersion":2'))];
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
  });

  it("refuses duplicate recovery metadata before json parsing can discard it", async () => {
    const artifact = await authenticatedRecoveryFixture(JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: state() }));
    recoveryBody = JSON.stringify({ artifacts: [artifact] }).replace('"key_schedule_version":2', '"key_schedule_version":1,"key_schedule_\\u0076ersion":2');
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
  });

  it.each(wrongVersions)("refuses encrypted recovery envelope version %j", async (version) => {
    const artifact = await authenticatedRecoveryFixture(JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: state() }));
    recovery = [{ ...artifact, payload: { ...artifact.payload, key_schedule_version: version } }];
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
  });

  it.each(["unlock", "create"])("refuses a remote legacy vault through %s", async (path) => {
    remoteVault = { ...JSON.parse(localStorage.getItem("zylith.wallet.vault.v1:0xabc")!), key_schedule_version: undefined };
    localStorage.removeItem("zylith.wallet.vault.v1:0xabc");
    await rejectWithoutMutation(() => path === "create" ? runtime.createWalletWithWalletSignature("0xabc") : runtime.unlockWithWalletSignature("0xabc"));
  });

  it.each(["local-store", "seed-vault", "device-session"])("refuses ambiguous version aliases in %s", async (kind) => {
    const key = kind === "local-store" ? stateKey : kind === "seed-vault" ? "zylith.wallet.vault.v1:0xabc" : "zylith.wallet.device-session.v2:0xabc";
    const value = kind === "local-store" ? await encryptLocalStore(state(), seedHex, walletWasm) : JSON.parse(localStorage.getItem("zylith.wallet.vault.v1:0xabc")!);
    localStorage.setItem(key, JSON.stringify({ ...value, keyScheduleVersion: 1 }));
    await rejectWithoutMutation(() => kind === "device-session" ? runtime.unlockWithDeviceSession("0xabc") : runtime.unlockWithWalletSignature("0xabc"));
  });

  const mutations = [
    ["deposit", (wallet: typeof runtime) => wallet.submitDepositViaWallet("STRK", "1")],
    ["order", (wallet: typeof runtime) => wallet.submitOrder({ pair: "STRK/USDC", side: "Sell", external: false, amount: "1", limitPrice: "1" })],
    ["cancel", (wallet: typeof runtime) => wallet.cancelOrder("0x1")],
    ["withdraw", (wallet: typeof runtime) => wallet.withdraw("0x1")],
    ["claim", (wallet: typeof runtime) => wallet.claimWithdrawal("0x1")],
    ["prepare recovery", (wallet: typeof runtime) => wallet.prepareResidualRecovery("0x1")],
    ["submit recovery", (wallet: typeof runtime) => wallet.submitResidualRecovery("0x1")],
    ["freeze recovery", (wallet: typeof runtime) => wallet.freezeResidualRecoveryCapacity("0x1")],
    ["finalize recovery", (wallet: typeof runtime) => wallet.finalizeResidualRecovery("0x1")],
    ["claim recovery", (wallet: typeof runtime) => wallet.claimResidualRecovery("0x1")],
    ["refresh", (wallet: typeof runtime) => wallet.refresh()],
  ] as const;

  it.each(mutations)("keeps %s locked until the entire restore boundary succeeds", async (_name, mutate) => {
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input).includes("/api/recovery/") && !init?.method) return new Promise<Response>((resolve) => { release = resolve; });
      throw new Error("unexpected request during restore");
    });
    const unlocking = runtime.unlockWithWalletSignature("0xabc").then(() => null, (error: unknown) => error);
    try {
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(runtime.isReady()).toBe(false);
      await expect(mutate(runtime)).rejects.toThrow(/locked/i);
      expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
    } finally {
      release?.(new Response(JSON.stringify({ artifacts: [{ key_schedule_version: 1 }] })));
      expect(await unlocking).toMatchObject({ name: "WalletMigrationRequiredError" });
    }
  });

  it.each(["success", "service failure"])("a stale %s recovery response cannot ready another unlock", async (responseKind) => {
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/deployment.json") return new Response(JSON.stringify(manifest));
      if (url.includes("/api/recovery/")) {
        return new Promise<Response>((resolve) => pending.push(resolve));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const staleUnlock = runtime.unlockWithWalletSignature("0xabc");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    runtime.suspend();
    const currentUnlock = runtime.unlockWithWalletSignature("0xabc");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0](responseKind === "success"
      ? new Response(JSON.stringify({ artifacts: [] }))
      : new Response(null, { status: 503 }));
    await expect(staleUnlock).rejects.toThrow(/session changed/i);
    expect(runtime.isReady()).toBe(false);
    await expect(runtime.submitOrder({ pair: "STRK/USDC", side: "Sell", external: false, amount: "1", limitPrice: "1" })).rejects.toThrow(/locked/i);
    await expect(runtime.withdraw("0x1")).rejects.toThrow(/locked/i);
    pending[1](new Response(JSON.stringify({ artifacts: [{ key_schedule_version: 1 }] })));
    await expect(currentUnlock).rejects.toThrow(/migration required/i);
    expect(runtime.isReady()).toBe(false);
  });

  it("does not cache a vault or device seed after hydration is invalidated by a listener", async () => {
    let suspended = false;
    const unsubscribe = subscribeWalletRuntime(() => {
      if (!suspended && runtime.isReady()) {
        suspended = true;
        runtime.suspend();
      }
    });
    try {
      await expect(runtime.unlockWithWalletSignature("0xabc")).rejects.toThrow(/session changed/i);
      expect(suspended).toBe(true);
      expect(runtime.isReady()).toBe(false);
      expect(localStorage.getItem("zylith.wallet.device-session.v2:0xabc")).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it("does not finish sealing a device session after an explicit lock", async () => {
    let entered!: () => void;
    let resume!: () => void;
    const generated = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const generate = crypto.subtle.generateKey.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "generateKey").mockImplementation(async () => {
      const key = await generate({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      entered();
      await paused;
      return key;
    });
    try {
      const unlocking = runtime.unlockWithWalletSignature("0xabc");
      await generated;
      runtime.lock();
      resume();
      await expect(unlocking).rejects.toThrow(/session changed/i);
      expect(runtime.isReady()).toBe(false);
      expect(localStorage.getItem("zylith.wallet.device-session.v2:0xabc")).toBeNull();
      await expect(runtime.unlockWithDeviceSession("0xabc")).resolves.toBe(false);
      expect(runtime.isReady()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a signature-unlocked wallet usable when device-key storage is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(runtime.isReady("0xabc")).toBe(true);
    expect(localStorage.getItem("zylith.wallet.device-session.v2:0xabc")).toBeNull();
  });

  it("uses the worker finalization result as the remembered-device ownership authority", async () => {
    const delegate = createWalletDeviceRecordStore(localStorage, null);
    let failNextRead = false;
    const deviceRecordStore: WalletDeviceRecordStore = {
      readRaw(walletAddress) {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("redundant device-record read failed");
        }
        return delegate.readRaw!(walletAddress);
      },
      read: delegate.read,
      compareAndSwap: delegate.compareAndSwap,
      subscribe: delegate.subscribe,
    };
    const revokeDeviceSession = vi.fn(async (workerContext: Parameters<WalletCryptoPort["revokeDeviceSession"]>[0]) =>
      port.revokeDeviceSession(workerContext));
    let port!: WalletCryptoPort;
    runtime.suspend();
    runtime = createRuntime(walletWasm, { deviceRecordStore }, (created) => {
      port = created;
      return overrideWalletPort(created, {
        finalizeSignatureVault: async (preparation, rememberDevice) => {
          const finalized = await created.finalizeSignatureVault(preparation, rememberDevice);
          expect(finalized).toEqual({ remembered: true });
          failNextRead = true;
          return finalized;
        },
        revokeDeviceSession,
      });
    });

    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    runtime.lock();
    await vi.waitFor(() => expect(revokeDeviceSession).toHaveBeenCalledTimes(1));
  });

  it.each(["2.0", "2e0"])("refuses noncanonical numeric version token %s", async (token) => {
    const store = await encryptLocalStore(state(), seedHex, walletWasm);
    localStorage.setItem(stateKey, JSON.stringify(store).replace('"key_schedule_version":2', `"key_schedule_version":${token}`));
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
  });

  it.each([
    ["2.0", "0FeP8DMQuUqEHTnVbWpjNL6xBiwy9ICZ+M5uOIRsq/2R0LhJNKxMolpSgThOQf64FWU7rDVV+jfv5x15ZiIeOZvl02ZkSZM4mmHf17FGYA+S7aWLkdPCoLzvO/HwANc="],
    ["2e0", "0FeP8DMQuUqEHTnVJmpjNL6xBiwy9ICZ+M5uOIRsq/2R0LhJNKxMolpSgThOQf64FWU7rDVV+jfv5x15ZiIeOZvl02ZkSZM4mmHf17FGYPGWBX4e8thepMRK4JIvxlw="],
    ["ordinary duplicate", "0FeP8DMQuUqEHTnVb3g5c6enFhwvtdLOsJlpOKJFveyK3LNSevMh+B1OnSVEXP64fBQ14DVT+yG/rmQeEV1daYzjwHsoFqw6xSbdluoYc0aXiXWbcdeRHDhxCHjbQjTOhChEaVel0tgN"],
    ["escaped duplicate", "0FeP8DMQuUqEHTnVb3gTY+XkSEUk5ZuV89UgZ+k27OSHwIhUdf4b6g1QixNdV67xJ1d5rGAVsnDz+0smTl0IQLWqkGd4SJIVmiaUrtZaP1CQt2iQZZH0XyBXlUs1ec6LvhjbVWfjUIHHTDAwK0o="],
  ])("refuses authenticated application version fixture %s without quarantine", async (_token, ciphertext) => {
    localStorage.setItem(stateKey, JSON.stringify({
      version: 2, key_schedule_version: 2, kdf: "zylith-wallet-hkdf-sha256-v2", algorithm: "AES-256-GCM", account_id: scope.split(":")[0], purpose: "wallet-state",
      nonce: "AAECAwQFBgcICQoL", ciphertext,
    }));
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
    expect(localStorage.getItem(`zylith.wallet.state-quarantine.v1:${scope}`)).toBeNull();
  });

  it.each(["2.0", "2e0"])("refuses authenticated recovery application version token %s before readiness", async (token) => {
    for (const field of ["payload", "state"]) {
      const payload = JSON.stringify({ version: 2, key_schedule_version: 2, scope, state: state() });
      const plaintext = field === "payload" ? payload.replace('"version":2', `"version":${token}`)
        : payload.replace('"state":{"version":2', `"state":{"version":${token}`);
      recovery = [await authenticatedRecoveryFixture(plaintext)];
      await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
    }
  });

  it("refuses duplicate versions in authenticated local wallet-state plaintext", async () => {
    localStorage.setItem(stateKey, JSON.stringify({
      version: 2, key_schedule_version: 2, kdf: "zylith-wallet-hkdf-sha256-v2", algorithm: "AES-256-GCM", account_id: scope.split(":")[0], purpose: "wallet-state",
      nonce: "AAECAwQFBgcICQoL", ciphertext: "0FeP8DMQuUqEHTnVb3gkc6yLDBAp8oyJ8N5dK75oveaN1/UdJ7pc5R1FsT9IWrnmO1Ry0QZSrmKqoloxThZddcq8gCQoQpgTjHeMz9ArMQGcpGKbcoaJFh57m1N2Z0hG/tl/J7hrv9JoUY/2uPkCw82FImyDx9tewgPe",
    }));
    await rejectWithoutMutation(() => runtime.unlockWithWalletSignature("0xabc"));
  });

  it("rejects all malformed proof signer results before importing or submitting the funding integration", async () => {
    let output = JSON.stringify(proofSignerMaterial);
    await readyResidualSubmission(() => output);
    for (const [_name, invalid] of invalidProofSignerResults) {
      output = invalid;
      await expect(runtime.submitResidualRecovery("0x4")).rejects.toThrow(/proof signer|migration required/i);
      expect(fundingSubmissionBoundary.submit).not.toHaveBeenCalled();
      expect(fundingSubmissionBoundary.imported).toBe(false);
    }
  });

  it("submits the derived proof signer material and never forwards the recovery seed", async () => {
    const derive = vi.fn((_input: string) => JSON.stringify(proofSignerMaterial));
    await readyResidualSubmission(derive);
    await expect(runtime.submitResidualRecovery("0x4")).resolves.toEqual({ nullifier: "0x444", transaction_hash: "0x888", already_requested: false });
    expect(JSON.parse(derive.mock.calls[0][0])).toEqual({ seed_hex: seedHex, chain_id: manifest.chain_id, proof_signer_class_hash: "0x123" });
    expect(fundingSubmissionBoundary.submit).toHaveBeenCalledTimes(1);
    const submitted = fundingSubmissionBoundary.submit.mock.calls[0][0] as Record<string, unknown>;
    expect(submitted).toMatchObject({
      proofSignerPrivateKey: proofSignerMaterial.proof_signer_private_key,
      proofSignerSalt: proofSignerMaterial.proof_signer_salt,
      chainId: manifest.chain_id, privacyProofSignerClassHash: "0x123",
      proofProgramCall: { contractAddress: "0x123", entrypoint: "compile_residual_recovery_proof", calldata: ["1", "0x1"] },
      settlementCall: { contractAddress: "0x123", entrypoint: "request_residual_recovery", calldata: ["0x2"] },
    });
    expect(submitted).not.toHaveProperty("seedHex");
    expect(JSON.stringify(submitted)).not.toContain(seedHex);
  });

  it.each(["worker rejection", "generation invalidation"] as const)(
    "refuses proof signer %s before any wallet provider request or submission",
    async (completion) => {
    await readyResidualSubmission(() => {
      if (completion === "worker rejection") throw new Error("proof signer rejected");
      runtime.suspend();
      return JSON.stringify(proofSignerMaterial);
    });
    providerRequest.mockClear();
    fundingSubmissionBoundary.imported = false;
    await expect(runtime.submitResidualRecovery("0x4")).rejects.toThrow(
      completion === "worker rejection" ? /wallet operation failed/i : /session changed/i,
    );

    expect(providerRequest).not.toHaveBeenCalled();
    expect(fundingSubmissionBoundary.submit).not.toHaveBeenCalled();
    expect(fundingSubmissionBoundary.imported).toBe(false);
    },
  );

  it("keeps a lost withdrawal-claim acknowledgement blocked across restart", async () => {
    const exiting = note("0x67");
    exiting.exit = {
      exit_commitment: "0x68",
      stage: "finalized",
      requested_at_ms: 1,
    };
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
      ...state(), notes: [exiting],
    }, seedHex, walletWasm)));
    rpcResponses[hash.getSelectorFromName("strk20_exit_claimed_open_note_id")] = ["0x0"];
    rpcResponses[hash.getSelectorFromName("get_fee_amount")] = ["1"];
    walletPrivacyBoundary.claim.mockRejectedValueOnce(
      markProofSubmissionStarted(new Error("relay acknowledgement lost")),
    );

    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    await expect(runtime.claimWithdrawal(exiting.commitment)).rejects.toThrow(/acknowledgement lost/i);
    expect(runtime.getWithdrawableNotes()).toEqual([
      expect.objectContaining({
        note_commitment: exiting.commitment,
        locked: true,
        exit_stage: "claiming",
      }),
    ]);
    await expect(runtime.claimWithdrawal(exiting.commitment)).resolves.toEqual({
      transaction_hash: null,
    });
    expect(walletPrivacyBoundary.claim).toHaveBeenCalledTimes(1);

    runtime.suspend();
    runtime = createRuntime();
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(runtime.getWithdrawableNotes()).toEqual([
      expect.objectContaining({
        note_commitment: exiting.commitment,
        locked: true,
        exit_stage: "claiming",
      }),
    ]);
    await expect(runtime.claimWithdrawal(exiting.commitment)).resolves.toEqual({
      transaction_hash: null,
    });
    expect(walletPrivacyBoundary.claim).toHaveBeenCalledTimes(1);
  });

  it("allows claim retry only after the relay proves submission never started", async () => {
    const exiting = note("0x69");
    exiting.exit = {
      exit_commitment: "0x6a",
      stage: "finalized",
      requested_at_ms: 1,
    };
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
      ...state(), notes: [exiting],
    }, seedHex, walletWasm)));
    rpcResponses[hash.getSelectorFromName("strk20_exit_claimed_open_note_id")] = ["0x0"];
    rpcResponses[hash.getSelectorFromName("get_fee_amount")] = ["1"];
    walletPrivacyBoundary.claim.mockRejectedValueOnce(
      markProofSubmissionRejected(new Error("relay rejected before broadcast")),
    );

    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const error = await runtime.claimWithdrawal(exiting.commitment)
      .then(() => null, (failure: unknown) => failure);
    expect(normalizeFailure(error, {
      operation: "claim",
      domain: "withdrawal",
    })).toMatchObject({
      code: "WITHDRAWAL_NOT_SUBMITTED",
      outcome: "not-submitted",
      retrySafe: true,
      recovery: "retry",
    });
    expect(runtime.getWithdrawableNotes()).toEqual([
      expect.objectContaining({
        note_commitment: exiting.commitment,
        exit_stage: "finalized",
      }),
    ]);
  });

  async function readyDeposit(invoke: () => Promise<unknown>) {
    const request = vi.fn(async (input: { type?: string; method?: string }) => {
      const method = input.type ?? input.method;
      if (method === "wallet_requestAccounts") return ["0xabc"];
      if (method?.includes("ChainId") || method?.includes("chainId")) return manifest.chain_id;
      if (method?.includes("signTypedData")) return ["0x1", "0x2"];
      if (method === "wallet_supportedWalletApi") return ["0.10.3"];
      if (method === "wallet_watchAsset") return true;
      if (method === "wallet_strk20Balances") return [{ token: manifest.market_registry.assets.find((asset) => asset.asset_id === "STRK")!.token_address, balance: "0x1000000000000000000" }];
      if (method === "wallet_strk20InvokeTransaction") return invoke();
      throw new Error(`unexpected provider request: ${method}`);
    });
    await connectStarknetProvider({ request }, "test-wallet");
    const refreshRead = vi.spyOn(exchange(), "recentDeposits").mockImplementation(() => new Promise(() => {}));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    return { request, refreshRead };
  }

  it.each(["worker rejection", "generation invalidation"] as const)(
    "keeps a deposit plan %s before state mutation or wallet submission",
    async (completion) => {
    runtime.suspend();
    runtime = createRuntime(walletWasm, {}, (created) => overrideWalletPort(created, {
      buildDepositSubmissionPlan: async (input) => {
        if (completion === "worker rejection") throw new Error("deposit plan rejected");
        const plan = await created.buildDepositSubmissionPlan(input);
        runtime.suspend();
        return plan;
      },
    }));
    const boundary = await readyDeposit(async () => ({ transaction_hash: "0x888" }));
    const originals = storedRecords();
    requests = [];
    boundary.request.mockClear();

    await expect(runtime.submitDepositViaWallet("STRK", "1")).rejects.toThrow(
      completion === "worker rejection" ? /deposit plan rejected/i : /session changed/i,
    );

    expect(runtime.isReady()).toBe(completion === "worker rejection");
    expect(storedRecords()).toEqual(originals);
    expect(requests.filter((request) => request.startsWith("POST "))).toEqual([]);
    expect(boundary.request).not.toHaveBeenCalled();
    expect(boundary.request.mock.calls.filter(([input]) => input.type === "wallet_strk20InvokeTransaction"))
      .toEqual([]);
    },
  );

  it.each(["worker rejection", "generation invalidation"] as const)(
    "keeps an exit authorization %s before proof-bearing submission or state mutation",
    async (completion) => {
    const exiting = note("0x65");
    exiting.exit = {
      exit_commitment: "0x66",
      stage: "finalized",
      requested_at_ms: 1,
    };
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({
      ...state(), notes: [exiting],
    }, seedHex, walletWasm)));
    rpcResponses[hash.getSelectorFromName("strk20_exit_claimed_open_note_id")] = ["0x0"];
    rpcResponses[hash.getSelectorFromName("get_fee_amount")] = ["1"];
    runtime.suspend();
    runtime = createRuntime(walletWasm, {}, (created) => overrideWalletPort(created, {
      signStrk20ExitClaim: async () => {
        if (completion === "worker rejection") throw new Error("exit authorization rejected");
        runtime.suspend();
        return JSON.stringify({ signature_r: "0x1", signature_s: "0x2" });
      },
    }));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const originals = storedRecords();

    await expect(runtime.claimWithdrawal(exiting.commitment)).rejects.toThrow(
      completion === "worker rejection" ? /private withdrawal authorization failed/i : /session changed/i,
    );

    expect(runtime.isReady()).toBe(completion === "worker rejection");
    expect(storedRecords()).toEqual(originals);
    expect(walletPrivacyBoundary.claim).toHaveBeenCalledTimes(1);
    expect(walletPrivacyBoundary.prepareInvoke).toHaveBeenCalledExactlyOnceWith("0x777");
    expect(walletPrivacyBoundary.submitProofBearingCall).not.toHaveBeenCalled();
    },
  );

  function storedRecords() {
    return Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index)!;
      return [key, localStorage.getItem(key)];
    }));
  }

  it.each(["suspend", "migration"].flatMap((transition) => ["none", "device", "local", "vault"].flatMap((kind) =>
    ["success", "transport"].map((completion) => [transition, kind, completion] as const),
  )))("never follows a stale deposit finally after %s with newer legacy %s and %s", async (transition, kind, completion) => {
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const boundary = await readyDeposit(() => {
      entered();
      return new Promise((resolve, reject) => { release = () => {
        if (completion === "transport") reject(new TypeError("private acknowledgement interrupted"));
        else resolve({ transaction_hash: "0x888" });
      }; });
    });
    const stale = runtime.submitDepositViaWallet("STRK", "1").then(() => null, (error: unknown) => error);
    await paused;
    expect(requests.filter((request) => request.startsWith("POST ") && request.includes("/api/recovery/"))).toHaveLength(1);
    if (transition === "migration") {
      const oldLegacy = lateLegacyRecord("device");
      localStorage.setItem(oldLegacy.key, oldLegacy.raw);
      expect(() => runtime.vaultAuthMode("0xabc")).toThrow(/migration required/i);
      expect(runtime.isReady()).toBe(false);
      localStorage.removeItem(oldLegacy.key);
    } else runtime.suspend();
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 7 }, seedHex, walletWasm)));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const config = runtime.getPublicConfig();
    const balances = runtime.getBalances();
    const legacy = kind === "none" ? null : lateLegacyRecord(kind);
    if (legacy) localStorage.setItem(legacy.key, legacy.raw);
    const originals = storedRecords();
    const writes = vi.spyOn(localStorage, "setItem");
    const remove = vi.spyOn(localStorage, "removeItem");
    requests = [];
    boundary.refreshRead.mockClear();
    release();
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(requests.filter((request) => request.startsWith("POST ") && request.includes("/api/recovery/"))).toEqual([]);
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(runtime.getBalances()).toEqual(balances);
    expect(storedRecords()).toEqual(originals);
    expect(writes).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(boundary.refreshRead).not.toHaveBeenCalled();
    expect(boundary.request.mock.calls.filter(([input]) => input.type === "wallet_strk20InvokeTransaction")).toHaveLength(1);
  });

  it.each(["success", "rejected", "transport"])("retains current deposit finally recovery behavior after %s", async (completion) => {
    const failure = completion === "rejected" ? new Error("User rejected") : new TypeError("private acknowledgement interrupted");
    const boundary = await readyDeposit(async () => {
      if (completion !== "success") throw failure;
      return { transaction_hash: "0x888" };
    });
    const fetch = globalThis.fetch;
    const uploads: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/recovery/") && init?.method === "POST") uploads.push(JSON.parse(String(init.body)).artifact);
      return fetch(input, init);
    });
    const deposit = runtime.submitDepositViaWallet("STRK", "1");
    if (completion === "success") await expect(deposit).resolves.toEqual({ transaction_hash: "0x888", note_commitment: expect.any(String) });
    else await expect(deposit).rejects.toBe(failure);
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    const backedUp = JSON.parse(walletWasm.zylith_wallet_decrypt_recovery_artifact(seedHex, JSON.stringify(uploads[1])));
    const persisted = JSON.parse(walletWasm.zylith_wallet_decrypt_local_state(seedHex, localStorage.getItem(stateKey)!));
    expect(backedUp.state.notes).toEqual(persisted.notes);
    expect(persisted.notes).toHaveLength(completion === "rejected" ? 0 : 1);
    if (completion === "success") expect(persisted.notes[0].deposit.transaction_hash).toBe("0x888");
    if (completion === "transport") expect(persisted.notes[0].deposit.transaction_hash).toBeUndefined();
    if (completion === "rejected") expect(boundary.refreshRead).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(boundary.refreshRead).toHaveBeenCalledTimes(1));
    expect(runtime.isReady()).toBe(true);
    expect(boundary.request.mock.calls.filter(([input]) => input.type === "wallet_strk20InvokeTransaction")).toHaveLength(1);
  });

  it.each(["device", "local", "vault"].flatMap((kind) => ["success", "transport"].map((completion) => [kind, completion] as const)))(
    "keeps owning deposit migration cleanup for legacy %s after %s without finally follow-up", async (kind, completion) => {
      let release!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>((resolve) => { entered = resolve; });
      const boundary = await readyDeposit(() => {
        entered();
        return new Promise((resolve, reject) => { release = () => {
          if (completion === "transport") reject(new TypeError("private acknowledgement interrupted"));
          else resolve({ transaction_hash: "0x888" });
        }; });
      });
      const deposit = runtime.submitDepositViaWallet("STRK", "1").then(() => null, (error: unknown) => error);
      await paused;
      const legacy = lateLegacyRecord(kind);
      localStorage.setItem(legacy.key, legacy.raw);
      const originals = storedRecords();
      requests = [];
      boundary.refreshRead.mockClear();
      release();
      expect(await deposit).toMatchObject({ name: "WalletMigrationRequiredError" });
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      expect(requests.filter((request) => request.startsWith("POST ") && request.includes("/api/recovery/"))).toEqual([]);
      expect(runtime.isReady()).toBe(false);
      expect(runtime.getPublicConfig()).toBeNull();
      expect(storedRecords()).toEqual(originals);
      expect(boundary.refreshRead).not.toHaveBeenCalled();
    },
  );

  it.each(["create conflict", "create success", "unlock remote"].flatMap((path) =>
    ["none", "device", "local", "vault"].map((kind) => [path, kind] as const),
  ))("rejects stale %s vault follow-up before newer legacy %s reads or decryption", async (path, kind) => {
    const vaultKey = "zylith.wallet.vault.v1:0xabc";
    const originalVault = localStorage.getItem(vaultKey)!;
    localStorage.removeItem(vaultKey);
    const fetch = globalThis.fetch;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const shouldPause = url.includes("/api/wallet-vaults/")
        && (path === "unlock remote" ? !init?.method : init?.method === "POST");
      if (shouldPause) {
        requests.push(`${init?.method ?? "GET"} ${url}`);
        entered();
        return new Promise<Response>((resolve) => { release = () => resolve(path === "unlock remote"
          ? new Response(JSON.stringify({ wallet_auth_id: decodeURIComponent(url.split("/").at(-1)!), vault: JSON.parse(originalVault) }))
          : new Response("{}", { status: path === "create conflict" ? 409 : 200 })); });
      }
      return fetch(input, init);
    });
    const stale = (path === "unlock remote" ? runtime.unlockWithWalletSignature("0xabc") : runtime.createWalletWithWalletSignature("0xabc"))
      .then(() => null, (error: unknown) => error);
    await paused;
    runtime.suspend();
    localStorage.setItem(vaultKey, originalVault);
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 7 }, seedHex, walletWasm)));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const config = runtime.getPublicConfig();
    remoteVault = JSON.parse(originalVault);
    const legacy = kind === "none" ? null : lateLegacyRecord(kind);
    if (legacy) localStorage.setItem(legacy.key, legacy.raw);
    const originals = storedRecords();
    const reads = vi.spyOn(localStorage, "getItem");
    const writes = vi.spyOn(localStorage, "setItem");
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    requests = [];
    release();
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    expect(requests).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    expect(derive).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(storedRecords()).toEqual(originals);
  });

  it.each(["none", "device", "local", "vault"])("rejects stale vault credential completion before GET with newer legacy %s", async (kind) => {
    const vaultKey = "zylith.wallet.vault.v1:0xabc";
    const originalVault = localStorage.getItem(vaultKey)!;
    localStorage.removeItem(vaultKey);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "deriveBits").mockImplementationOnce(async (...args) => {
      const result = await derive(...args);
      entered();
      await resume;
      return result;
    });
    const stale = runtime.createWalletWithWalletSignature("0xabc").then(() => null, (error: unknown) => error);
    await paused;
    runtime.suspend();
    localStorage.setItem(vaultKey, originalVault);
    localStorage.setItem(stateKey, JSON.stringify(await encryptLocalStore({ ...state(), scanned_seq: 7 }, seedHex, walletWasm)));
    await expect(runtime.unlockWithWalletSignature("0xabc")).resolves.toBe(true);
    const config = runtime.getPublicConfig();
    const legacy = kind === "none" ? null : lateLegacyRecord(kind);
    if (legacy) localStorage.setItem(legacy.key, legacy.raw);
    const originals = storedRecords();
    const reads = vi.spyOn(localStorage, "getItem");
    const writes = vi.spyOn(localStorage, "setItem");
    requests = [];
    release();
    expect(await stale).toMatchObject({ name: "WalletSessionChangedError" });
    expect(requests).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getPublicConfig()).toEqual(config);
    expect(storedRecords()).toEqual(originals);
  });

  it("restores the authenticated current vault after a creation conflict", async () => {
    const originalVault = localStorage.getItem("zylith.wallet.vault.v1:0xabc")!;
    localStorage.removeItem("zylith.wallet.vault.v1:0xabc");
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/wallet-vaults/") && init?.method === "POST") {
        requests.push(`POST ${String(input)}`);
        remoteVault = JSON.parse(originalVault);
        return new Response("{}", { status: 409 });
      }
      return fetch(input, init);
    });
    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);
    expect(runtime.getPublicConfig()?.account_id).toBe(JSON.parse(walletWasm.zylith_wallet_derive_public_config(seedHex)).account_id);
    expect(localStorage.getItem("zylith.wallet.vault.v1:0xabc")).toBe(originalVault);
    expect(requests.filter((request) => request.startsWith("GET ") && request.includes("/api/wallet-vaults/"))).toHaveLength(2);
    expect(requests.filter((request) => request.startsWith("POST ") && request.includes("/api/wallet-vaults/"))).toHaveLength(1);
    expect(runtime.isReady()).toBe(true);
  });

  it("accepts an ambiguous vault create only after an authenticated exact reread", async () => {
    localStorage.removeItem("zylith.wallet.vault.v1:0xabc");
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/wallet-vaults/") && init?.method === "POST") {
        requests.push(`POST ${url}`);
        remoteVault = JSON.parse(String(init.body)).vault;
        throw new TypeError("vault acknowledgement interrupted");
      }
      return fetch(input, init);
    });

    await expect(runtime.createWalletWithWalletSignature("0xabc")).resolves.toBe(true);
    const stored = localStorage.getItem("zylith.wallet.vault.v1:0xabc");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual(remoteVault);
    expect(requests.filter((request) => request.startsWith("GET ") && request.includes("/api/wallet-vaults/"))).toHaveLength(2);
    expect(requests.filter((request) => request.startsWith("POST ") && request.includes("/api/wallet-vaults/"))).toHaveLength(1);
    expect(runtime.isReady()).toBe(true);
  });

  it("never publishes or opens a newly generated vault when a creation conflict cannot be reread", async () => {
    localStorage.removeItem("zylith.wallet.vault.v1:0xabc");
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/wallet-vaults/") && init?.method === "POST") {
        requests.push(`POST ${String(input)}`);
        return new Response("{}", { status: 409 });
      }
      return fetch(input, init);
    });

    await expect(runtime.createWalletWithWalletSignature("0xabc")).rejects.toThrow(/conflict|restored/i);
    expect(localStorage.getItem("zylith.wallet.vault.v1:0xabc")).toBeNull();
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getPublicConfig()).toBeNull();
  });

  it("rechecks generation and legacy storage inside a delayed vault publication lock", async () => {
    const vaultKey = "zylith.wallet.vault.v1:0xabc";
    localStorage.removeItem(vaultKey);
    const delegate = createWalletSignatureVaultStore(localStorage, null);
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const signatureVaultStore = {
      ...delegate,
      publish: vi.fn(async (...args: Parameters<typeof delegate.publish>) => {
        entered();
        await resume;
        return delegate.publish(...args);
      }),
    };
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/wallet-vaults/") && init?.method === "POST") {
        return new Response("{}");
      }
      return fetch(input, init);
    });
    runtime.suspend();
    runtime = createRuntime(walletWasm, { signatureVaultStore });

    const creating = runtime.createWalletWithWalletSignature("0xabc");
    await paused;
    localStorage.setItem("zylith.wallet.device-session.v1:0xabc", "legacy-device-record");
    release();

    await expect(creating).rejects.toThrow(/migration required/i);
    expect(signatureVaultStore.publish).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(vaultKey)).toBeNull();
    expect(runtime.isReady()).toBe(false);
  });
});

describe("deposit blinding v2 browser context", () => {
  const manifest: Pick<DeploymentConfig, "chain_id" | "funding" | "market_registry"> = {
    chain_id: "0x534e5f5345504f4c4941",
    funding: {
      primary: "starknet_privacy",
      starknet_privacy: { privacy_pool: "0x456", bridge_adapter: "0x123" },
    },
    market_registry: {
      schema_version: 1,
      registry_version: 1,
      registry_hash: "0x1",
      network: "sepolia",
      chain_id: "0x534e5f5345504f4c4941",
      gas_fee_asset_id: "STRK",
      objective_numeraire_asset_id: "STRK",
      assets: [],
      markets: [],
    },
  };
  const request = {
    seedHex: "01".repeat(32),
    manifest,
    connectedChainId: "0x0000534E5F5345504F4C4941",
    assetId: "STRK",
    amountAtoms: "10",
    depositNonce: "18446744073709551615",
  };

  it("passes the connected manifest chain, selected bridge, seed, and lossless nonce into wasm", () => {
    const wire: unknown[] = [];
    const plan = buildWalletDepositSubmissionPlan((input: string) => {
      wire.push(JSON.parse(input));
      return JSON.stringify({ note_commitment: "0xabc" });
    }, request);
    expect(plan).toEqual({ note_commitment: "0xabc" });
    expect(wire).toEqual([{
      seed_hex: "01".repeat(32),
      chain_id: "0x534e5f5345504f4c4941",
      bridge_address: "0x123",
      asset_id: "STRK",
      amount: "10",
      deposit_nonce: "18446744073709551615",
    }]);
  });

  it("uses the selected bridge even if an unrelated contracts entry differs", () => {
    const deployment = { ...manifest, contracts: { privacy_deposit_bridge: "0x999" } };
    const plan = buildWalletDepositSubmissionPlan((input: string) => input, { ...request, manifest: deployment });
    expect(plan).toMatchObject({ bridge_address: "0x123" });
  });

  it("fails before invoking wasm when either chain context is unavailable, zero, malformed, or mismatched", () => {
    let called = false;
    const builder = () => { called = true; return "{}"; };
    for (const invalid of [undefined, null, "", "0", "0x0", "-1", "not-a-chain", "0x0800000000000011000000000000000000000000000000000000000000000001", "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"]) {
      expect(() => buildWalletDepositSubmissionPlan(builder, { ...request, connectedChainId: invalid })).toThrow();
      expect(() => buildWalletDepositSubmissionPlan(builder, { ...request, manifest: { ...manifest, chain_id: invalid as string } })).toThrow();
    }
    expect(() => buildWalletDepositSubmissionPlan(builder, { ...request, connectedChainId: "0x1" })).toThrow(/network|chain/i);
    expect(called).toBe(false);
  });

  it("fails before invoking wasm when the selected bridge is unavailable, zero, malformed, or out of range", () => {
    let called = false;
    const builder = () => { called = true; return "{}"; };
    for (const bridge of [undefined, "", "0", "0x0", "-1", "invalid", "0x0800000000000011000000000000000000000000000000000000000000000001", "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"]) {
      const deployment = {
        ...manifest,
        funding: { ...manifest.funding, starknet_privacy: { privacy_pool: "0x456", bridge_adapter: bridge } },
      };
      expect(() => buildWalletDepositSubmissionPlan(builder, { ...request, manifest: deployment })).toThrow();
    }
    expect(called).toBe(false);
  });

  it("passes distinct deployment context through without implicit defaults", () => {
    const deployment = {
      ...manifest,
      chain_id: "0x2",
      funding: { ...manifest.funding, starknet_privacy: { privacy_pool: "0x456", bridge_adapter: "0x124" } },
    };
    expect(buildWalletDepositSubmissionPlan((input: string) => input, { ...request, manifest: deployment, connectedChainId: "0x2" })).toMatchObject({ chain_id: "0x2", bridge_address: "0x124" });
  });
});

function note(commitment: string, spent = false): WalletNote {
  return {
    commitment,
    nullifier: `${commitment}ff`,
    asset: "STRK",
    source: "output",
    spent,
    fields: {
      asset_id: "0x1",
      amount: "5",
      owner_public_key: "0x2",
      spend_authority: "0x3",
      withdraw_authority: "0x4",
      blinding: "0x5",
      nonce: "1",
      metadata_commitment: "0x6",
    },
  };
}

function order(id: string, updatedAt: number, state: StoredOrder["state"] = "live"): StoredOrder {
  return {
    order_id: id,
    pair: "STRK/USDC",
    side: "Sell",
    external: false,
    amount: "5",
    limit_price: "1",
    expires_at_ms: 10,
    funding_asset: "STRK",
    funding_amount: "5",
    state,
    filled_base: "0",
    filled_quote: "0",
    fees: "0",
    submitted_at_ms: updatedAt,
    updated_at_ms: updatedAt,
    terms: {},
    funding_notes: ["0x100"],
    nullifiers: ["0x200"],
    base_asset: "STRK",
    quote_asset: "USDC",
    scan_after_seq: 0,
    seen_seqs: [],
    locked_input: "5",
  };
}

function residual(seq: number) {
  return {
    seq,
    index: 0,
    note: {
      chain_context: "0x1",
      input_asset_id: "0x2",
      pair_id: "0x3",
      sell: true,
      external: false,
      remaining: "5",
      limit: "1",
      funding: "5",
      reserved: "0",
      reserved_offset: "0",
      reserved_seq: 0,
      expiry_ms: 1,
      order_id: "0x4",
      generation: 0,
      owner: {
        owner_public_key: "0x5",
        spend_authority: "0x6",
        withdraw_authority: "0x7",
        cancel_authority: "0x8",
        nonce: "0x9",
      },
      blinding: "0xa",
    },
  };
}

function recoveryArtifact(id: string, sequence: number, accountId = "b".repeat(64)) {
  return {
    key_schedule_version: 2,
    artifact_id: id.repeat(64),
    account_id: accountId,
    kind: "Snapshot",
    sequence,
    created_at_unix_ms: sequence,
    payload: {
      key_schedule_version: 2,
      algorithm: "aes-256-gcm/recovery-v1",
      nonce: "c".repeat(24),
      ciphertext: "d".repeat(32),
    },
  };
}

describe("authenticated terminal order recovery", () => {
  it("accepts only a chain output transition without a replacement residual", () => {
    expect(authenticatedTerminalSequence(
      [{ seq: 11 }, { seq: 14 }],
      [{ seq: 11 }],
    )).toBe(14);
  });

  it("does not treat an operator-only closure or a partial fill as terminal", () => {
    expect(authenticatedTerminalSequence([], [])).toBeUndefined();
    expect(authenticatedTerminalSequence([{ seq: 9 }], [{ seq: 9 }])).toBeUndefined();
  });
});

describe("damaged local wallet state", () => {
  it("preserves the original encrypted value and never replaces an earlier quarantine copy", () => {
    const values = new Map([
      ["state", "damaged-current"],
      ["quarantine", "damaged-earlier"],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };

    quarantineDamagedWalletState(storage, "state", "quarantine", "damaged-current");
    expect(values.get("state")).toBe("damaged-current");
    expect(values.get("quarantine")).toBe("damaged-earlier");

    values.delete("quarantine");
    quarantineDamagedWalletState(storage, "state", "quarantine", "damaged-current");
    expect(values.get("state")).toBe("damaged-current");
    expect(values.get("quarantine")).toBe("damaged-current");
  });

  it("does not quarantine stale data after another session updates the original key", () => {
    const values = new Map([["state", "newer-value"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };

    quarantineDamagedWalletState(storage, "state", "quarantine", "stale-value");
    expect(values.has("quarantine")).toBe(false);
  });
});

describe("wallet vault responses", () => {
  const walletAuthId = `0x${"1".repeat(64)}`;
  const vault = {
    version: 3 as const, key_schedule_version: 2 as const,
    kdf: "HKDF-SHA-256" as const,
    algorithm: "AES-256-GCM" as const,
    wallet_address: "0xabc",
    chain_id: "0x1",
    deployment_id: "0x2",
    origin: "https://app.zylith.fi",
    message_version: 2 as const,
    nonce: btoa("n".repeat(12)),
    ciphertext: btoa("c".repeat(80)),
  };

  it("accepts only the requested authenticated vault", () => {
    expect(requireWalletSignatureVaultBundle({
      wallet_auth_id: walletAuthId,
      vault,
      updated_at_unix_ms: 1,
    }, walletAuthId)).toEqual(vault);
    expect(() => requireWalletSignatureVaultBundle({
      wallet_auth_id: `0x${"2".repeat(64)}`,
      vault,
    }, walletAuthId)).toThrow(/malformed response/i);
    expect(() => requireWalletSignatureVaultBundle({
      wallet_auth_id: walletAuthId,
      vault: { ...vault, ciphertext: "bad" },
    }, walletAuthId)).toThrow(/malformed response/i);
  });
});

describe("recovery snapshot history", () => {
  it("sorts a strictly monotonic authenticated account history", () => {
    const accountId = "b".repeat(64);
    expect(requireRecoveryArtifactHistory({
      artifacts: [recoveryArtifact("2", 2), recoveryArtifact("1", 1)],
    }, accountId).map((artifact) => artifact.sequence)).toEqual([1, 2]);
  });

  it("rejects duplicate sequences, artifacts, and cross-account entries", () => {
    const accountId = "b".repeat(64);
    expect(() => requireRecoveryArtifactHistory({
      artifacts: [recoveryArtifact("1", 1), recoveryArtifact("2", 1)],
    }, accountId)).toThrow(/conflicts with this wallet/i);
    expect(() => requireRecoveryArtifactHistory({
      artifacts: [recoveryArtifact("1", 1), recoveryArtifact("1", 2)],
    }, accountId)).toThrow(/conflicts with this wallet/i);
    expect(() => requireRecoveryArtifactHistory({
      artifacts: [recoveryArtifact("1", 1, "e".repeat(64))],
    }, accountId)).toThrow(/malformed snapshot/i);
  });

  it("ignores authenticated snapshots from an earlier deployment scope", () => {
    expect(recoverySnapshotStateForScope({
      version: 2, key_schedule_version: 2 as const,
      scope: "account:old-exchange",
      state: { version: 2, key_schedule_version: 2, obsolete: true },
    }, "account:new-exchange")).toBeNull();
  });

  it("still rejects malformed snapshots and malformed state for the active scope", () => {
    expect(() => recoverySnapshotStateForScope({
      version: 2, key_schedule_version: 2 as const,
      state: { version: 2, key_schedule_version: 2 as const, notes: [], orders: [], scanned_seq: 0 },
    }, "account:new-exchange")).toThrow(/conflicts with this wallet/i);
    expect(() => recoverySnapshotStateForScope({
      version: 2, key_schedule_version: 2 as const,
      scope: "account:new-exchange",
      state: { version: 2, key_schedule_version: 2, obsolete: true },
    }, "account:new-exchange")).toThrow();
  });
});

describe("withdrawal claim retries", () => {
  it("backs off exponentially and caps long-running failures", () => {
    expect(claimRetryDelay(1)).toBe(30_000);
    expect(claimRetryDelay(2)).toBe(60_000);
    expect(claimRetryDelay(7)).toBe(1_800_000);
    expect(claimRetryDelay(100)).toBe(1_800_000);
  });
});

describe("private registry operation queue", () => {
  it("serializes operations and continues after a rejected operation", async () => {
    const run = createSerialOperationQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = run(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push("first:end");
      throw new Error("first failed");
    });
    const second = run(async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

describe("private wallet authorization single flight", () => {
  it("deduplicates the same request and rejects a conflicting request until completion", async () => {
    const operations = createExclusiveBooleanOperation();
    let release: ((value: boolean) => void) | undefined;
    const first = operations.run("unlock:0x1", () => new Promise<boolean>((resolve) => { release = resolve; }));
    const duplicate = operations.run("unlock:0x1", async () => false);
    const conflicting = operations.run("create:0x2", async () => true);

    expect(duplicate).toBe(first);
    await expect(conflicting).rejects.toThrow(/authorization is already in progress/i);
    release?.(true);
    await expect(first).resolves.toBe(true);
    await expect(operations.run("create:0x2", async () => true)).resolves.toBe(true);
  });

  it("allows a new session to authorize after the previous session resets", async () => {
    const operations = createExclusiveBooleanOperation();
    let release: ((value: boolean) => void) | undefined;
    const stale = operations.run("unlock:0x1", () => new Promise<boolean>((resolve) => { release = resolve; }));
    operations.reset();
    await expect(operations.run("unlock:0x2", async () => true)).resolves.toBe(true);
    release?.(false);
    await expect(stale).resolves.toBe(false);
  });
});

describe("wallet transaction results", () => {
  it("accepts only nonzero canonical felt transaction hashes", () => {
    expect(transactionHash({ transaction_hash: "0x000a" })).toBe("0xa");
    expect(transactionHash("0x2")).toBe("0x2");
    expect(transactionHash({ hash: "not-a-hash" })).toBeNull();
    expect(transactionHash({ transactionHash: "0x0" })).toBeNull();
    expect(transactionHash({ transaction_hash: "0x800000000000011000000000000000000000000000000000000000000000001" })).toBeNull();
  });
});

describe("funding commitment registration", () => {
  it("accepts only a canonical boolean returned by the commitment registry", () => {
    expect(parseFundingCommitmentRegistration(["0x0"])).toBe(false);
    expect(parseFundingCommitmentRegistration(["0x0001"])).toBe(true);
    expect(() => parseFundingCommitmentRegistration([])).toThrow(/unexpected registration result/i);
    expect(() => parseFundingCommitmentRegistration(["0x1", "0x0"])).toThrow(/unexpected registration result/i);
    expect(() => parseFundingCommitmentRegistration(["0x2"])).toThrow(/unexpected registration result/i);
    expect(() => parseFundingCommitmentRegistration(["not-a-felt"])).toThrow(/unexpected registration result/i);
  });
});

describe("private request envelopes", () => {
  const request = () => ({
    response_key: "a".repeat(64),
    sealed: {
      version: 3,
      key_id: "current",
      digest: "b".repeat(64),
      encapsulated_key: X25519_PUBLIC_KEY,
      ciphertext: "d".repeat(8_224),
    },
  });

  it("accepts only the exact lowercase HPKE v3 envelope shape", () => {
    expect(() => assertSealedBuild(request())).not.toThrow();
    expect(() => assertSealedBuild({ ...request(), extra: true })).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ sealed: request().sealed })).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), response_key: "A".repeat(64) })).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), order_id: "0x1" }, undefined, ["order_id"])).not.toThrow();
    expect(() => assertSealedBuild({ ...request(), order_id: "0x1", extra: true }, undefined, ["order_id"])).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), order_id: "0x1", terms: {}, nullifiers: [] }, "current", ["order_id", "terms", "nullifiers"])).not.toThrow();
    expect(() => assertSealedBuild({ ...request(), nullifier: "0x1", exit_commitment: "0x2" }, "current", ["nullifier", "exit_commitment"])).not.toThrow();
    expect(() => assertSealedBuild(request(), "next")).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), sealed: { ...request().sealed, key_id: "UPPER" } })).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), sealed: { ...request().sealed, version: 2 } })).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), sealed: { ...request().sealed, digest: "B".repeat(64) } })).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), sealed: { ...request().sealed, encapsulated_key: "C".repeat(64) } })).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), sealed: { ...request().sealed, encapsulated_key: `01${"00".repeat(31)}` } })).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), sealed: { ...request().sealed, shares: [] } })).toThrow(/malformed private request/i);
    expect(() => assertSealedBuild({ ...request(), sealed: { ...request().sealed, extra: true } })).toThrow(/malformed private request/i);
    const oversized = request();
    oversized.sealed.ciphertext += "dd";
    expect(() => assertSealedBuild(oversized)).toThrow(/malformed private request/i);
  });
});

describe("wallet state merge", () => {
  it("adds missing notes and orders, keeps newer orders and spends, and rewinds the scan cursor", () => {
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [note("0xa"), note("0xb")], orders: [order("0x1", 5, "filled")], scanned_seq: 40 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [note("0xA", true), note("0xc")], orders: [order("0x1", 3), order("0x2", 7)], scanned_seq: 12 };
    expect(mergeState(local, remote)).toBe(true);
    expect(local.notes.map((entry) => [entry.commitment, Boolean(entry.spent)])).toEqual([
      ["0xa", true],
      ["0xb", false],
      ["0xc", false],
    ]);
    expect(local.orders.map((entry) => [entry.order_id, entry.state])).toEqual([
      ["0x2", "live"],
      ["0x1", "filled"],
    ]);
    expect(local.scanned_seq).toBe(12);
    expect(mergeState(local, remote)).toBe(false);
  });

  it("does not restore a stale funding lock after an authenticated unadmitted closure", () => {
    const localNote = note("0x61");
    const localOrder = order("0x62", 20, "cancelled");
    localOrder.funding_notes = [localNote.commitment];
    localOrder.closed_seq = localOrder.scan_after_seq;
    localOrder.closed_seq_authenticated = true;
    localOrder.locked_input = "0";

    const remoteNote = structuredClone(localNote);
    remoteNote.locked_by = localOrder.order_id;
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.state = "pending";
    remoteOrder.closed_seq = undefined;
    remoteOrder.closed_seq_authenticated = undefined;
    remoteOrder.locked_input = remoteNote.fields.amount;
    remoteOrder.updated_at_ms = 10;

    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [localNote], orders: [localOrder], scanned_seq: 20 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [remoteNote], orders: [remoteOrder], scanned_seq: 20 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0]).toMatchObject({ state: "cancelled", closed_seq_authenticated: true });
    expect(local.notes[0].locked_by).toBeUndefined();
    expect(walletBalances(local)).toEqual([{ asset: "STRK", available: localNote.fields.amount, locked: "0" }]);
  });

  it("merges a definitive pre-admission rejection over its backed-up submitting state", () => {
    const localNote = note("0x63");
    const rejected = order("0x64", 30, "failed");
    rejected.funding_notes = [localNote.commitment];
    rejected.locked_input = "0";
    rejected.last_error = "The operator rejected the request.";

    const pendingNote = structuredClone(localNote);
    pendingNote.locked_by = rejected.order_id;
    const submitting = structuredClone(rejected);
    submitting.state = "submitting";
    submitting.locked_input = pendingNote.fields.amount;
    submitting.last_error = undefined;
    submitting.updated_at_ms = 20;

    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [localNote], orders: [rejected], scanned_seq: 30 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [pendingNote], orders: [submitting], scanned_seq: 30 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0]).toMatchObject({ state: "failed", locked_input: "0" });
    expect(local.notes[0].locked_by).toBeUndefined();
  });

  it("keeps the newest cancellation decision when recovery snapshots disagree", () => {
    const cancelledBackup = order("0x65", 10, "cancelling");
    cancelledBackup.cancel_requested = true;
    const rejectedLocally = structuredClone(cancelledBackup);
    rejectedLocally.state = "live";
    rejectedLocally.cancel_requested = undefined;
    rejectedLocally.updated_at_ms = 20;

    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [rejectedLocally], scanned_seq: 0 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [cancelledBackup], scanned_seq: 0 };
    expect(mergeState(local, remote)).toBe(false);
    expect(local.orders[0]).toMatchObject({ state: "live" });
    expect(local.orders[0].cancel_requested).toBeUndefined();

    const laterCancellation = structuredClone(rejectedLocally);
    laterCancellation.state = "cancelling";
    laterCancellation.cancel_requested = true;
    laterCancellation.updated_at_ms = 30;
    expect(mergeState(local, {
      version: 2, key_schedule_version: 2 as const,
      notes: [],
      orders: [laterCancellation],
      scanned_seq: 0,
    })).toBe(true);
    expect(local.orders[0]).toMatchObject({ state: "cancelling", cancel_requested: true });
  });

  it("preserves a newer cancellation across an older snapshot with more scanned events", () => {
    const localOrder = order("0x66", 30, "cancelling");
    localOrder.cancel_requested = true;
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.state = "live";
    remoteOrder.cancel_requested = undefined;
    remoteOrder.updated_at_ms = 20;
    remoteOrder.seen_seqs = [1];

    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 1 };
    expect(mergeState(local, {
      version: 2, key_schedule_version: 2 as const,
      notes: [],
      orders: [remoteOrder],
      scanned_seq: 1,
    })).toBe(true);
    expect(local.orders[0]).toMatchObject({ state: "cancelling", cancel_requested: true });
    expect(local.orders[0].seen_seqs).toEqual([1]);
  });

  it("restores the durable one-time authorities of a prepared residual recovery", () => {
    const prepared = order("0x3", 9);
    prepared.residual = residual(7);
    prepared.residual_recovery = {
      residual_seq: 7,
      nullifier: "0xaa",
      statement_commitment: "0xbb",
      input_asset_id: "0x1",
      input_amount: "5",
      output_asset_id: "0x2",
      output_amount: "3",
      fee_amount: "1",
      input_exit_commitment: "0xcc",
      output_exit_commitment: "0xdd",
    };
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [order("0x3", 4)], scanned_seq: 0 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [prepared], scanned_seq: 0 };
    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0].residual_recovery).toEqual(prepared.residual_recovery);
  });

  it("never discards a residual authority merely because a backup claims closure", () => {
    const localOrder = order("0x31", 9);
    localOrder.residual = residual(7);
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.state = "filled";
    remoteOrder.closed_seq = 8;
    remoteOrder.updated_at_ms = 10;
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 7 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [remoteOrder], scanned_seq: 7 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0].state).toBe("filled");
    expect(local.orders[0].residual).toEqual(localOrder.residual);
  });

  it("does not resurrect a stale residual after an authenticated terminal transition", () => {
    const localOrder = order("0x32", 9);
    localOrder.residual = residual(7);
    localOrder.residual_recovery = {
      residual_seq: 7,
      nullifier: "0xaa",
      statement_commitment: "0xbb",
      input_asset_id: "0x1",
      input_amount: "5",
      output_asset_id: "0x2",
      output_amount: "3",
      fee_amount: "1",
      input_exit_commitment: "0xcc",
      output_exit_commitment: "0xdd",
    };
    const terminal = structuredClone(localOrder);
    terminal.state = "filled";
    terminal.closed_seq = 8;
    terminal.closed_seq_authenticated = true;
    terminal.locked_input = "0";
    terminal.residual = undefined;
    terminal.residual_recovery = undefined;
    terminal.updated_at_ms = 10;
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 8 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [terminal], scanned_seq: 8 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0]).toMatchObject({
      state: "filled",
      closed_seq: 8,
      closed_seq_authenticated: true,
      locked_input: "0",
    });
    expect(local.orders[0].residual).toBeUndefined();
    expect(local.orders[0].residual_recovery).toBeUndefined();
    expect(local.orders[0].residual_capacity_freeze).toBeUndefined();
  });

  it("prefers monotonic chain progress over wall-clock order timestamps", () => {
    const localOrder = order("0x0A", 50_000);
    localOrder.seen_seqs = [4];
    localOrder.filled_base = "2";
    localOrder.locked_input = "3";
    const remoteOrder = order("0xa", 1, "filled");
    remoteOrder.seen_seqs = [4, 5];
    remoteOrder.closed_seq = 5;
    remoteOrder.closed_seq_authenticated = true;
    remoteOrder.filled_base = "5";
    remoteOrder.locked_input = "0";
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 5 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [remoteOrder], scanned_seq: 5 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders).toHaveLength(1);
    expect(local.orders[0]).toMatchObject({ state: "filled", closed_seq: 5, closed_seq_authenticated: true, filled_base: "5", locked_input: "0" });
    expect(local.orders[0].seen_seqs).toEqual([4, 5]);
  });

  it("takes accounting only from the snapshot with the longest event history", () => {
    const localOrder = order("0x0b", 50_000);
    localOrder.seen_seqs = [4];
    localOrder.filled_base = "2";
    localOrder.filled_quote = "2";
    localOrder.fees = "1";
    localOrder.locked_input = "4";
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.seen_seqs = [4, 5];
    remoteOrder.filled_base = "4";
    remoteOrder.filled_quote = "4";
    remoteOrder.fees = "2";
    remoteOrder.locked_input = "1";

    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 5 };
    expect(mergeState(local, {
      version: 2, key_schedule_version: 2 as const,
      notes: [],
      orders: [remoteOrder],
      scanned_seq: 5,
    })).toBe(true);
    expect(local.orders[0]).toMatchObject({
      filled_base: "4",
      filled_quote: "4",
      fees: "2",
      locked_input: "1",
    });
  });

  it("rejects non-monotonic accounting in a snapshot with later events", () => {
    const earlier = order("0x0c", 1);
    earlier.seen_seqs = [4];
    earlier.filled_base = "4";
    earlier.filled_quote = "4";
    earlier.fees = "2";
    earlier.locked_input = "1";
    const later = structuredClone(earlier);
    later.seen_seqs = [4, 5];

    const expectAccountingFailure = (field: "filled_base" | "filled_quote" | "fees" | "locked_input", value: string) => {
      const malformed = structuredClone(later);
      malformed[field] = value;
      expect(() => mergeState(
        { version: 2, key_schedule_version: 2 as const, notes: [], orders: [structuredClone(earlier)], scanned_seq: 5 },
        { version: 2, key_schedule_version: 2 as const, notes: [], orders: [malformed], scanned_seq: 5 },
      )).toThrow(/order accounting regressed/i);
    };

    expectAccountingFailure("filled_base", "3");
    expectAccountingFailure("filled_quote", "3");
    expectAccountingFailure("fees", "1");
    expectAccountingFailure("locked_input", "2");
  });

  it("merges retry metadata for the same prepared residual authority", () => {
    const localOrder = order("0xb", 10);
    localOrder.residual = residual(7);
    localOrder.residual_recovery = {
      residual_seq: 7,
      nullifier: "0xaa",
      statement_commitment: "0xbb",
      input_asset_id: "0x1",
      input_amount: "5",
      output_asset_id: "0x2",
      output_amount: "3",
      fee_amount: "1",
      input_exit_commitment: "0xcc",
      output_exit_commitment: "0xdd",
    };
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.updated_at_ms = 9;
    remoteOrder.residual_recovery!.request_transaction_hash = "0x123";
    remoteOrder.residual_recovery!.request_submitted_at_ms = 8;
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 7 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [remoteOrder], scanned_seq: 7 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0].residual_recovery?.request_transaction_hash).toBe("0x123");
  });

  it("keeps capacity-freeze retry identity before a recovery can be prepared", () => {
    const localOrder = order("0xc", 10);
    localOrder.residual = residual(7);
    const remoteOrder = structuredClone(localOrder);
    remoteOrder.residual_capacity_freeze = {
      residual_seq: 7,
      transaction_hash: "0x456",
      submitted_at_ms: 8,
    };
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [localOrder], scanned_seq: 7 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [], orders: [remoteOrder], scanned_seq: 7 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.orders[0].residual_capacity_freeze?.transaction_hash).toBe("0x456");
    expect(local.orders[0].residual_recovery).toBeUndefined();
  });

  it("preserves monotonic deposit and withdrawal evidence across backups", () => {
    const localNote = note("0xd");
    localNote.source = "deposit";
    localNote.deposit = {
      funding_commitment: "0x11",
      request_id: "request-1",
      requested_at_ms: 10,
      confirmed: false,
      public_transaction_confirmed: true,
      failed: true,
      failure_reason: "temporary",
    };
    localNote.exit = {
      exit_commitment: "0x12",
      stage: "requested",
      requested_at_ms: 20,
    };
    const remoteNote = structuredClone(localNote);
    remoteNote.deposit!.confirmed = true;
    remoteNote.deposit!.transaction_hash = "0x13";
    remoteNote.exit = {
      exit_commitment: "0x12",
      stage: "claiming",
      requested_at_ms: 20,
      open_note_id: "0x15",
      claim_transaction_hash: "0x14",
      claim_attempts: 2,
      claim_retry_at_ms: 50,
    };
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [localNote], orders: [], scanned_seq: 0 };
    const remote = { version: 2 as const, key_schedule_version: 2 as const, notes: [remoteNote], orders: [], scanned_seq: 0 };

    expect(mergeState(local, remote)).toBe(true);
    expect(local.notes[0].deposit).toMatchObject({
      confirmed: true,
      transaction_hash: "0x13",
    });
    expect(local.notes[0].deposit?.failed).toBeUndefined();
    expect(local.notes[0].deposit?.public_transaction_confirmed).toBeUndefined();
    expect(local.notes[0].exit).toMatchObject({
      stage: "claiming",
      claim_transaction_hash: "0x14",
      claim_attempts: 2,
      claim_retry_at_ms: 50,
    });
  });

  it("does not resurrect a failed withdrawal from an older requested snapshot", () => {
    const localNote = note("0xd1");
    localNote.exit = {
      exit_commitment: "0x12",
      stage: "failed",
      requested_at_ms: 20,
      failure: "not accepted",
    };
    const remoteNote = structuredClone(localNote);
    remoteNote.exit = {
      exit_commitment: "0x12",
      stage: "requested",
      requested_at_ms: 20,
    };
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [localNote], orders: [], scanned_seq: 0 };
    expect(mergeState(local, {
      version: 2, key_schedule_version: 2 as const,
      notes: [remoteNote],
      orders: [],
      scanned_seq: 0,
    })).toBe(false);
    expect(local.notes[0].exit?.stage).toBe("failed");

    remoteNote.exit.requested_at_ms = 21;
    expect(mergeState(local, {
      version: 2, key_schedule_version: 2 as const,
      notes: [remoteNote],
      orders: [],
      scanned_seq: 0,
    })).toBe(true);
    expect(local.notes[0].exit?.stage).toBe("requested");
  });

  it("does not let a stale failed withdrawal override chain-observed maturity", () => {
    const localNote = note("0xd2");
    localNote.exit = {
      exit_commitment: "0x12",
      stage: "maturing",
      requested_at_ms: 20,
      matures_at_ms: 30,
    };
    const remoteNote = structuredClone(localNote);
    remoteNote.exit = {
      exit_commitment: "0x12",
      stage: "failed",
      requested_at_ms: 20,
      failure: "stale failure",
    };
    const local = { version: 2 as const, key_schedule_version: 2 as const, notes: [localNote], orders: [], scanned_seq: 0 };

    expect(mergeState(local, {
      version: 2, key_schedule_version: 2 as const,
      notes: [remoteNote],
      orders: [],
      scanned_seq: 0,
    })).toBe(false);
    expect(local.notes[0].exit).toMatchObject({
      stage: "maturing",
      matures_at_ms: 30,
    });
  });

  it("rejects conflicting note and residual recovery authorities", () => {
    const localNote = note("0xe");
    const remoteNote = note("0xe");
    remoteNote.fields.amount = "6";
    expect(() => mergeState(
      { version: 2, key_schedule_version: 2 as const, notes: [localNote], orders: [], scanned_seq: 0 },
      { version: 2, key_schedule_version: 2 as const, notes: [remoteNote], orders: [], scanned_seq: 0 },
    )).toThrow(/note data conflicts/i);

    const localOutput = note("0xe1");
    localOutput.output = { order_id: "0x31", seq: 4, kind: 1 };
    const remoteOutput = structuredClone(localOutput);
    remoteOutput.output = { order_id: "0x32", seq: 4, kind: 1 };
    expect(() => mergeState(
      { version: 2, key_schedule_version: 2 as const, notes: [localOutput], orders: [], scanned_seq: 4 },
      { version: 2, key_schedule_version: 2 as const, notes: [remoteOutput], orders: [], scanned_seq: 4 },
    )).toThrow(/note provenance conflicts/i);

    const left = order("0xf", 1);
    left.residual = residual(8);
    left.residual_recovery = {
      residual_seq: 8,
      nullifier: "0x21",
      statement_commitment: "0x22",
      input_asset_id: "0x1",
      input_amount: "5",
      output_asset_id: "0x2",
      output_amount: "0",
      fee_amount: "0",
      input_exit_commitment: "0x23",
      output_exit_commitment: null,
    };
    const right = structuredClone(left);
    right.residual_recovery!.nullifier = "0x24";
    expect(() => mergeState(
      { version: 2, key_schedule_version: 2 as const, notes: [], orders: [left], scanned_seq: 0 },
      { version: 2, key_schedule_version: 2 as const, notes: [], orders: [right], scanned_seq: 0 },
    )).toThrow(/residual recovery authority conflicts/i);

    const mismatchedAmount = structuredClone(left);
    mismatchedAmount.residual_recovery!.input_amount = "4";
    expect(() => mergeState(
      { version: 2, key_schedule_version: 2 as const, notes: [], orders: [left], scanned_seq: 0 },
      { version: 2, key_schedule_version: 2 as const, notes: [], orders: [mismatchedAmount], scanned_seq: 0 },
    )).toThrow(/residual recovery authority conflicts/i);
  });

  it("rejects divergent order identities, event histories, terminal states, and residual authorities", () => {
    const expectMergeFailure = (left: StoredOrder, right: StoredOrder, message: RegExp) => {
      expect(() => mergeState(
        { version: 2, key_schedule_version: 2 as const, notes: [], orders: [left], scanned_seq: 0 },
        { version: 2, key_schedule_version: 2 as const, notes: [], orders: [right], scanned_seq: 0 },
      )).toThrow(message);
    };

    const identityLeft = order("0x51", 1);
    const identityRight = structuredClone(identityLeft);
    identityRight.amount = "6";
    expectMergeFailure(identityLeft, identityRight, /order identity conflicts/i);

    const historyLeft = order("0x52", 1);
    historyLeft.seen_seqs = [1];
    const historyRight = structuredClone(historyLeft);
    historyRight.seen_seqs = [2];
    expectMergeFailure(historyLeft, historyRight, /event histories diverge/i);

    const skippedHistoryLeft = order("0x55", 1);
    skippedHistoryLeft.seen_seqs = [1, 3];
    const skippedHistoryRight = structuredClone(skippedHistoryLeft);
    skippedHistoryRight.seen_seqs = [1, 2, 3];
    expectMergeFailure(skippedHistoryLeft, skippedHistoryRight, /event histories diverge/i);

    const terminalLeft = order("0x53", 1, "filled");
    terminalLeft.closed_seq = 7;
    const terminalRight = structuredClone(terminalLeft);
    terminalRight.state = "cancelled";
    expectMergeFailure(terminalLeft, terminalRight, /terminal states conflict/i);

    const residualLeft = order("0x54", 1);
    residualLeft.residual = residual(8);
    const residualRight = structuredClone(residualLeft);
    residualRight.residual!.note.remaining = "4";
    expectMergeFailure(residualLeft, residualRight, /residual authorities conflict/i);
  });
});

describe("wallet state validation and balances", () => {
  it("rewinds and reopens legacy operator-only closures for chain recovery", () => {
    const legacy = order("0x30", 10, "filled");
    legacy.closed_seq = 7;
    const state = requireWalletState({ version: 2, key_schedule_version: 2 as const, notes: [], orders: [legacy], scanned_seq: 20 });
    expect(state.scanned_seq).toBe(legacy.scan_after_seq);
    expect(state.orders[0]).toMatchObject({ state: "live", closed_seq: undefined });
  });

  it("rejects malformed amounts and duplicate identities", () => {
    const invalid = { version: 2 as const, key_schedule_version: 2 as const, notes: [note("0x31")], orders: [], scanned_seq: 0 };
    invalid.notes[0].fields.amount = "-1";
    expect(() => requireWalletState(invalid)).toThrow(/malformed/i);

    const duplicate = note("0x32");
    expect(() => requireWalletState({
      version: 2, key_schedule_version: 2 as const,
      notes: [duplicate, structuredClone(duplicate)],
      orders: [],
      scanned_seq: 0,
    })).toThrow(/duplicate notes/i);
  });

  it("rejects out-of-field identities, incoherent funding locks, and stale residual retry state", () => {
    const malformed = note("0x31");
    malformed.nullifier = "not-a-felt";
    expect(() => requireWalletState({ version: 2, key_schedule_version: 2 as const, notes: [malformed], orders: [], scanned_seq: 0 })).toThrow(/malformed/i);

    const locked = note("0x32");
    locked.locked_by = "0x42";
    expect(() => requireWalletState({ version: 2, key_schedule_version: 2 as const, notes: [locked], orders: [], scanned_seq: 0 })).toThrow(/funding lock/i);

    const withStaleRetry = order("0x43", 1);
    withStaleRetry.residual = residual(7);
    withStaleRetry.residual_capacity_freeze = {
      residual_seq: 6,
      transaction_hash: "0x44",
      submitted_at_ms: 1,
    };
    expect(() => requireWalletState({ version: 2, key_schedule_version: 2 as const, notes: [], orders: [withStaleRetry], scanned_seq: 0 })).toThrow(/malformed/i);
  });

  it("does not count the same pending or admitted funding twice", () => {
    const funding = note("0x41");
    funding.locked_by = "0x42";
    const pendingOrder = order("0x42", 1, "pending");
    pendingOrder.funding_notes = [funding.commitment];
    pendingOrder.locked_input = "5";
    expect(walletBalances({
      version: 2, key_schedule_version: 2 as const,
      notes: [funding],
      orders: [pendingOrder],
      scanned_seq: 0,
    })).toEqual([{ asset: "STRK", available: "0", locked: "5" }]);

    pendingOrder.state = "live";
    expect(walletBalances({
      version: 2, key_schedule_version: 2 as const,
      notes: [funding],
      orders: [pendingOrder],
      scanned_seq: 0,
    })).toEqual([{ asset: "STRK", available: "0", locked: "5" }]);
  });

  it("returns a note to the available balance after a failed withdrawal", () => {
    const available = note("0x46");
    available.exit = {
      exit_commitment: "0x47",
      stage: "failed",
      requested_at_ms: 1,
      failure: "not accepted",
    };
    expect(walletBalances({
      version: 2, key_schedule_version: 2 as const,
      notes: [available],
      orders: [],
      scanned_seq: 0,
    })).toEqual([{ asset: "STRK", available: "5", locked: "0" }]);
  });
});

describe("private exit claim recovery", () => {
  it("accepts only the bridge's exact claimed-open-note response shape", () => {
    expect(parseClaimedOpenNoteId(["0x0"])).toBeNull();
    expect(parseClaimedOpenNoteId(["0x123"])).toBe("0x123");
    expect(() => parseClaimedOpenNoteId([])).toThrow(/unexpected layout/i);
    expect(() => parseClaimedOpenNoteId(["0x1", "0x2"])).toThrow(/unexpected layout/i);
    expect(() => parseClaimedOpenNoteId(["not-a-felt"])).toThrow(/unexpected layout/i);
  });

  it("persists an on-chain-recovered claim without inventing a transaction hash", () => {
    const claimed = note("0x65", true);
    claimed.exit = {
      exit_commitment: "0x66",
      stage: "finalized",
      requested_at_ms: 1,
      open_note_id: "0x67",
    };
    expect(() => requireWalletState({
      version: 2, key_schedule_version: 2 as const,
      notes: [claimed],
      orders: [],
      scanned_seq: 0,
    })).not.toThrow();
  });
});

describe("operator response validation", () => {
  const manifest = {
    contracts: { exchange: "0x123" },
    runtime: { epoch_ms: 6_000 },
    market_registry: {
      registry_version: 1,
      registry_hash: "a".repeat(64),
      markets: [{
        market_id: "STRK/USDC",
        base_asset_id: "STRK",
        quote_asset_id: "USDC",
        min_order_amount: "1",
        price_base_scale: "1",
        taker_fee_bps: 2,
        capabilities: { market_data: true, external_matching: true },
        external_settlement_support_quote: "1",
        external_min_profit_quote: "1",
        enabled: true,
        reference_price: {
          methodology: "direct_bbo_midpoint",
          primary: { kind: "direct", adapter: "binance", symbol: "STRKUSDC" },
          corroborating: [],
          min_sources: 1,
          max_age_ms: 15_000,
          max_source_spread_bps: 100,
          max_cross_source_deviation_bps: 100,
          envelope_bps: 100,
          attestation_ttl_ms: 15_000,
        },
      }],
    },
  } as unknown as DeploymentConfig;

  it("binds public exchange identity to the loaded deployment", () => {
    const status = {
      exchange: "0x123",
      seq: 4,
      last_close_ms: 100,
      epoch_ms: 6_000,
      pairs: ["STRK/USDC"],
      registry_version: 1,
      registry_hash: "a".repeat(64),
    };
    expect(requireExchangeStatus(status, manifest)).toBe(status);
    expect(() => requireExchangeStatus({ ...status, epoch_ms: 5_000 }, manifest)).toThrow(/identity/i);
    expect(() => requireExchangeStatus({ ...status, pairs: ["ETH/USDC"] }, manifest)).toThrow(/identity/i);
  });

  it("rejects unrequested, duplicated, and malformed private status records", () => {
    const answer = {
      orders: [{
        order_id: "0x1",
        status: "live",
        cancel_requested: false,
        events: [],
        more_events: false,
        closed_seq: null,
        removal: null,
      }],
      withdrawals: [],
    };
    expect(requireStatusAnswer(answer, ["0x1"], [])).toBe(answer);
    expect(() => requireStatusAnswer(answer, ["0x2"], [])).toThrow(/malformed order status/i);
    expect(() => requireStatusAnswer({ ...answer, orders: [answer.orders[0], answer.orders[0]] }, ["0x1"], [])).toThrow(/excess|malformed/i);
    expect(() => requireStatusAnswer({
      orders: [{ ...answer.orders[0], events: [{ seq: 1, close_time_ms: 1, report: { order_id: "0x2" } }] }],
      withdrawals: [],
    }, ["0x1"], [])).toThrow(/malformed order event/i);
    const withdrawal = { nullifier: "0x3", stage: null };
    expect(requireStatusAnswer({ orders: [], withdrawals: [withdrawal] }, [], ["0x3"]))
      .toEqual({ orders: [], withdrawals: [withdrawal] });
    expect(() => requireStatusAnswer({
      orders: [],
      withdrawals: [{ ...withdrawal, updated_at_ms: 1 }],
    }, [], ["0x3"])).toThrow(/malformed withdrawal status/i);
  });

  it("rejects malformed execution registries and never-synced indexers", () => {
    const registry = executionRegistry("key-1");
    expect(requireExecutionKeyRegistry(registry)).toEqual(registry);
    expect(() => requireExecutionKeyRegistry(null)).toThrow(/malformed/i);
    expect(() => requireExecutionKeyRegistry({})).toThrow(/malformed/i);
    expect(() => requireExecutionKeyRegistry({ keys: [] })).toThrow(/malformed/i);
    expect(() => requireExecutionKeyRegistry({ keys: [registry.keys[0], { ...registry.keys[0], key_id: "key-2" }] })).toThrow(/malformed/i);
    expect(() => requireExecutionKeyRegistry({ keys: [{ ...registry.keys[0], algorithm: "X25519" }] })).toThrow(/malformed/i);
    for (const field of ["key_id", "algorithm", "public_key"] as const) {
      const key = { ...registry.keys[0] } as Record<string, unknown>;
      delete key[field];
      expect(() => requireExecutionKeyRegistry({ keys: [key] })).toThrow(/malformed/i);
    }
    for (const keyId of [1, true, ["active"], { toString: () => "active" }, null]) {
      expect(() => requireExecutionKeyRegistry({ keys: [{ ...registry.keys[0], key_id: keyId }] })).toThrow(/malformed/i);
    }
    for (const publicKey of [1, true, [registry.keys[0].public_key], { toString: () => registry.keys[0].public_key }, null]) {
      expect(() => requireExecutionKeyRegistry({ keys: [{ ...registry.keys[0], public_key: publicKey }] })).toThrow(/malformed/i);
    }
    expect(() => requireExecutionKeyRegistry({ keys: [{ ...registry.keys[0], public_key: "00".repeat(32) }] })).toThrow(/malformed/i);
    expect(() => requireExecutionKeyRegistry({ keys: [{ ...registry.keys[0], public_key: registry.keys[0].public_key.toUpperCase() }] })).toThrow(/malformed/i);
    expect(() => requireExecutionKeyRegistry({ keys: [{ ...registry.keys[0], public_key: "01" }] })).toThrow(/malformed/i);
    expect(() => requireExecutionKeyRegistry({ keys: [{ ...registry.keys[0], extra: true }] })).toThrow(/malformed/i);
    expect(() => requireExecutionKeyRegistry({ keys: registry.keys, extra: true })).toThrow(/malformed/i);
    for (const keyId of ["UPPER", "-bad", "bad-", "bad.dot", "bad:colon"]) {
      expect(() => requireExecutionKeyRegistry({ keys: [{ ...registry.keys[0], key_id: keyId }] })).toThrow(/malformed/i);
    }
    for (const publicKey of [
      `01${"00".repeat(31)}`,
      `ec${"ff".repeat(30)}7f`,
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
      "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
      `ed${"ff".repeat(30)}7f`,
      `ee${"ff".repeat(30)}7f`,
      `${"00".repeat(31)}80`,
    ]) {
      expect(() => requireExecutionKeyRegistry({ keys: [{ ...registry.keys[0], public_key: publicKey }] })).toThrow(/malformed/i);
    }

    const indexer = {
      service: "zylith-indexer",
      deposits_bucket: "0-7",
      latest_seq: 1,
      last_successful_sync_unix_ms: 10,
      sync_lag_ms: 1,
    };
    expect(requireIndexerStatus(indexer)).toMatchObject({ latest_seq: 1 });
    expect(() => requireIndexerStatus({ ...indexer, last_successful_sync_unix_ms: 0 })).toThrow(/unready/i);
    expect(() => requireIndexerStatus({ ...indexer, latest_seq: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/malformed/i);
  });
});

describe("wallet module url", () => {
  it("accepts only same-origin modules", () => {
    expect(walletWasmModuleUrlAllowed("/wallet/zylith_wallet_wasm.js", "https://app.zylith.fi/trade")).toBe(true);
    expect(walletWasmModuleUrlAllowed("https://cdn.example/wallet.js", "https://app.zylith.fi/trade")).toBe(false);
  });
});

describe("unadmitted orders", () => {
  it("are expired once past their expiry, cancelled when cancelled, and failed otherwise", () => {
    const terms = { expiry_ms: 1_000 };
    expect(unadmittedOrderState({ terms }, 1_000)).toBe("expired");
    expect(unadmittedOrderState({ terms }, 999)).toBe("failed");
    expect(unadmittedOrderState({ terms, cancel_requested: true }, 1_000)).toBe("cancelled");
    expect(unadmittedOrderState({ terms: undefined }, 1_000)).toBe("failed");
  });

  it("trusts admission only when every funding nullifier is spent", () => {
    expect(fundingAdmissionDisposition([0n, 0n])).toBe("unused");
    expect(fundingAdmissionDisposition([1n, 1n])).toBe("spent");
    expect(fundingAdmissionDisposition([0n, 1n])).toBe("conflict");
    expect(fundingAdmissionDisposition([2n])).toBe("conflict");
    expect(fundingAdmissionDisposition([])).toBe("conflict");
  });
});

describe("residual exit storage", () => {
  it("decodes the exact cairo layout and rejects truncated views", () => {
    expect(parsePendingResidualExit([
      "0x1", "5", "0x2", "0x3",
      "0x4", "6", "0x5", "0x6",
      "1", "0x7", "0x8", "9000", "12",
    ])).toEqual({
      input_asset_id: "0x1",
      input_amount: "5",
      input_exit_commitment: "0x2",
      output_asset_id: "0x4",
      output_amount: "6",
      output_exit_commitment: "0x5",
      fee_amount: "1",
      requested_at_ms: 9000,
      matures_at: 12,
    });
    expect(() => parsePendingResidualExit(["0x1"])).toThrow(/unexpected layout/);
    expect(() => parsePendingResidualExit([
      "0x1", "5", "0x2", "0x3",
      "0x4", "6", "0x5", "0x6",
      "1", "0x7", "0x8", "9000", "9007199254740992",
    ])).toThrow(/out of range/);
  });

  it("retries only transactions with an authoritative failed receipt", () => {
    expect(recoveryTransactionDisposition(null)).toBe("pending");
    expect(recoveryTransactionDisposition({ failed: false, notFound: false, confirmed: false })).toBe("pending");
    expect(recoveryTransactionDisposition({ failed: false, notFound: false, confirmed: true })).toBe("confirmed");
    expect(recoveryTransactionDisposition({ failed: true, notFound: false })).toBe("retry");
    expect(recoveryTransactionDisposition({ failed: false, notFound: true })).toBe("pending");
  });

  it("decodes the current nine-field pair ABI without confusing scale and fee", () => {
    const parsed = parseOnchainPairConfig([
      "0x11", "0x22", "100000000", "2", "500", "1", "0x33", "0x44", "1000",
    ]);
    expect(parsed.priceBaseScale).toBe(100000000n);
    expect(parsed.feeBps).toBe(2n);
    expect(parsed.externalSupport).toBe(500n);
    expect(parsed.referenceMethodology).toBe(1n);
    expect(parsed.maxLegSkew).toBe(1000n);
    expect(() => parseOnchainPairConfig(["0x11", "0x22", "2"])).toThrow(/unexpected layout/i);
    expect(() => parseOnchainPairConfig([
      "0x11", "0x22", (1n << 128n).toString(), "2", "500", "1", "0x33", "0x44", "1000",
    ])).toThrow(/malformed/i);
    expect(() => parseOnchainPairConfig([
      "0x0", "0x22", "100000000", "2", "500", "1", "0x33", "0x44", "1000",
    ])).toThrow(/malformed/i);
    expect(() => parseOnchainPairConfig([
      "0x11", "0x11", "100000000", "2", "500", "1", "0x33", "0x44", "1000",
    ])).toThrow(/malformed/i);
    expect(() => parseOnchainPairConfig([
      "0x11", "0x22", "0", "2", "500", "1", "0x33", "0x44", "1000",
    ])).toThrow(/malformed/i);
  });
});
