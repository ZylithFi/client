// the browser wallet: a seed sealed under the starknet wallet's signature, the notes it owns,
// the persistent orders they fund and the withdrawals that take them back out.
//
// every note the wallet holds is rebuilt from chain data: deposits from the commitment
// registry, fills and refunds from the transition records the exchange verified. the operator
// only says where to look and how an order is doing.

import type {
  OrderDraft,
  OrderEvent,
  OutputRecord,
  SealedRequest,
  StatusAnswer,
  TraderWalletRuntime,
  TransitionOutputs,
  WalletOrder,
  WithdrawableNote,
} from "@zylith/sdk";
import type { PrivateRegistry } from "@starkware-libs/starknet-privacy-sdk";
import { ExchangeHttpError, ExchangeRejectedError } from "@zylith/sdk";
import { notifyWalletRuntimeChanged, selectedStarknetProvider, setWalletRuntime } from "./domain/browserWallet";
import {
  BACKUP_URL,
  type DeploymentConfig,
  type PairConfig,
  assertPinnedExecutionKeys,
  exchange,
  loadDeployment,
} from "./domain/deployment";
import {
  markDepositRecordConfirmed,
  markDepositRecordFailed,
  pendingDepositFailureReason,
} from "./domain/depositConfirmationState";
import { normalizeFeltForComparison, requiredNonZeroFelt, requiredString } from "./domain/felt";
import {
  fundingRailTokenAddress,
  selectedDepositFundingRail,
  strk20WithdrawalEnabledForDeployment,
} from "./domain/fundingRail";
import { setPrivacyFundingStage } from "./domain/privacyFundingStage";
import { RuntimeHttpStatusError, fetchJson, fetchWithTimeout, postJson } from "./domain/runtimeHttp";
import { browserSafeServiceUrl, normalizeUrl } from "./domain/serviceUrls";
import type { PendingDeposit, WalletBalance } from "./domain/shieldedBalances";
import { padRecoverySnapshotPayload } from "./domain/sizeClassPadding";
import { userFacingErrorMessage } from "./domain/userFacingErrors";
import {
  type EncryptedLocalStore,
  type VaultRecord,
  type WalletSignatureMessageVersion,
  type WalletSignatureVaultContext,
  type WalletSignatureVaultRecord,
  decryptLocalStore,
  decryptSeedWithWalletSignature,
  encryptLocalStore,
  encryptSeedWithWalletSignature,
  isWalletSignatureVaultRecord,
  walletSignatureVaultAuthToken,
  walletSignatureVaultId,
  walletSignatureVaultMetadataMatches,
} from "./domain/walletLocalCrypto";
import type { SerializedStarknetPrivacyRegistry } from "./integrations/starknetPrivacyRegistry";
import {
  type TransactionReceiptStatus,
  buildZylithWalletAuthTypedData,
  connectedProviderAddress,
  ensureWalletChain,
  fetchTransactionReceiptStatus,
  requestStarknetWalletTypedSignature,
  selectInjectedStarknetProvider,
  starknetCall,
  walletAuthDeploymentId,
} from "./wallet/starknetProvider";

export { validateWalletChainMatch } from "./wallet/starknetProvider";

type WalletWasmModule = {
  default?: () => Promise<void>;
  zylith_wallet_generate_seed_hex: () => string;
  zylith_wallet_derive_public_config: (seedHex: string) => string;
  zylith_wallet_recovery_auth_tag: (seedHex: string) => string;
  zylith_wallet_build_deposit_submission_plan: (inputJson: string) => string;
  zylith_wallet_build_order_request: (inputJson: string) => string;
  zylith_wallet_build_cancel_request: (inputJson: string) => string;
  zylith_wallet_build_withdraw_request: (inputJson: string) => string;
  zylith_wallet_build_status_requests: (inputJson: string) => string;
  zylith_wallet_registry_fingerprint: (registryJson: string) => string;
  zylith_wallet_recover_order_outputs: (inputJson: string) => string;
  zylith_wallet_note_summary: (noteJson: string) => string;
  zylith_wallet_create_recovery_snapshot: (inputJson: string) => string;
  zylith_wallet_decrypt_recovery_artifact: (seedHex: string, artifactJson: string) => string;
  zylith_wallet_sign_strk20_exit_claim: (inputJson: string) => string;
};

/** a sealed request and the one-time key its answer opens with. */
type SealedBuild = { sealed: SealedRequest; response_key: string };

export type WalletPublicConfig = {
  account_id: string;
  spend_authority: string;
  note_recognition_public_key: string;
  withdraw_authority: string;
};

/** a note as the exchange commits to it. */
type NoteFields = {
  asset_id: string;
  amount: string;
  owner_public_key: string;
  spend_authority: string;
  withdraw_authority: string;
  blinding: string;
  nonce: number;
  metadata_commitment: string;
};

type ExitStage = NonNullable<WithdrawableNote["exit_stage"]>;

export type WalletNote = {
  commitment: string;
  nullifier: string;
  asset: string;
  fields: NoteFields;
  source: "deposit" | "output";
  deposit?: {
    funding_commitment: string;
    request_id: string;
    requested_at_ms: number;
    transaction_hash?: string;
    confirmed: boolean;
    failed?: boolean;
    failure_reason?: string;
  };
  /** the order and transition that created an output. */
  output?: { order_id: string; seq: number; kind: number };
  /** the order this note funds, until the order is admitted or dropped. */
  locked_by?: string;
  exit?: {
    exit_commitment: string;
    stage: ExitStage;
    requested_at_ms: number;
    matures_at_ms?: number;
    open_note_id?: string;
    claim_transaction_hash?: string;
    failure?: string;
  };
  spent?: boolean;
};

/** an order and what the wallet needs to follow it and recover its outputs. */
export type StoredOrder = WalletOrder & {
  terms: unknown;
  funding_notes: string[];
  nullifiers: string[];
  base_asset: string;
  quote_asset: string;
  /** outputs are recovered from transitions after this seq. */
  scan_after_seq: number;
  /** the transition that removed the order, once known. */
  closed_seq?: number;
  seen_seqs: number[];
  cancel_requested?: boolean;
  /** input still held by the book: funding less what fills consumed. */
  locked_input: string;
};

type WalletState = {
  version: 2;
  notes: WalletNote[];
  orders: StoredOrder[];
  /** the last transition whose outputs were scanned. */
  scanned_seq: number;
};

type RecoveryArtifact = {
  artifact_id: string;
  account_id: string;
  kind: "Snapshot" | "WalletEvent";
  sequence: number;
  created_at_unix_ms: number;
  payload: { algorithm: string; nonce: string; ciphertext: string };
};

type WalletSignatureVaultBundle = { wallet_auth_id: string; vault: VaultRecord; updated_at_unix_ms?: number };

export type WalletRuntime = TraderWalletRuntime & {
  hasVault: (starknetAddress?: string | null) => boolean;
  vaultAuthMode: (starknetAddress?: string | null) => "none" | "wallet-signature";
  isReady: () => boolean;
  createWalletWithWalletSignature: (starknetAddress: string) => Promise<boolean>;
  unlockWithWalletSignature: (starknetAddress: string) => Promise<boolean>;
  getPublicConfig: () => WalletPublicConfig | null;
  lock: () => void;
  getPendingDeposits: () => PendingDeposit[];
  getWithdrawableNotes: () => WithdrawableNote[];
  withdrawalAvailable: () => boolean;
  submitDepositViaWallet: (asset: string, amountAtoms: string) => Promise<{ transaction_hash: string; note_commitment: string }>;
  withdraw: (noteCommitment: string) => Promise<{ nullifier: string }>;
};

const WALLET_WASM_MODULE_URL = "/wallet/zylith_wallet_wasm.js";
const VAULT_KEY = "zylith.wallet.vault.v1";
const STATE_PREFIX = "zylith.wallet.state.v2:";
const PRIVACY_REGISTRY_PREFIX = "zylith.wallet.starknet-privacy-registry.v1:";
const WALLET_VAULT_REQUEST_TIMEOUT_MS = 10_000;
/** state-independent private heartbeat cadence. jitter avoids synchronized wallet bursts without
 * revealing whether this wallet currently follows an order or withdrawal. */
const REFRESH_CADENCE_MS = 10_000;
const REFRESH_JITTER_MS = 1_000;
const RECOVERY_SNAPSHOT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_ORDER_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUNDING_NOTES = 4;
const PENDING_DEPOSIT_FAILURE_GRACE_MS = 10 * 60 * 1000;
const CONFIRMED_DEPOSIT_REGISTRATION_GRACE_MS = 10 * 60 * 1000;
const DEPOSIT_CONFIRMATION_STALE_MS = 2 * 60 * 1000;
const DEFAULT_MIN_PROVING_DELAY_BLOCKS = 10;
/** an unknown order older than this is resolved from its funding nullifiers. */
const UNKNOWN_ORDER_GRACE_MS = 2 * 60 * 1000;
const NULLIFIER_UNUSED = 0n;
const NULLIFIER_EXITED = 3n;
const OUTPUT_KIND_PROCEEDS = 1;
const OPEN_STATES = new Set<WalletOrder["state"]>(["submitting", "pending", "live", "cancelling"]);

export async function installConfiguredZylithWalletRuntime() {
  if (typeof window === "undefined") return;
  try {
    if (!walletWasmModuleUrlAllowed(WALLET_WASM_MODULE_URL, window.location.href)) {
      throw new Error("Wallet runtime module must be served from the current origin.");
    }
    const module = (await import(/* @vite-ignore */ new URL(WALLET_WASM_MODULE_URL, window.location.href).href)) as WalletWasmModule;
    if (typeof module.default === "function") await module.default();
    setWalletRuntime(createZylithWalletRuntime(module));
  } catch (error) {
    setWalletRuntime(null, userFacingErrorMessage(error, "Failed to load private trading runtime."));
  }
}

/** the final state of an order the operator no longer knows and never admitted. */
export function unadmittedOrderState(order: Pick<StoredOrder, "cancel_requested" | "terms">, nowMs: number): "cancelled" | "expired" | "failed" {
  if (order.cancel_requested) return "cancelled";
  // the operator drops a pending order once it expires unadmitted.
  const expiry = Number((order.terms as { expiry_ms?: number } | undefined)?.expiry_ms);
  return expiry <= nowMs ? "expired" : "failed";
}

export function walletWasmModuleUrlAllowed(moduleUrl: string, pageUrl: string): boolean {
  if (!moduleUrl.trim()) return false;
  try {
    const page = new URL(pageUrl.trim() || "http://localhost/");
    return new URL(moduleUrl.trim(), page).origin === page.origin;
  } catch {
    return false;
  }
}

export function createZylithWalletRuntime(core: WalletWasmModule): WalletRuntime {
  let seedHex: string | null = null;
  let publicConfig: WalletPublicConfig | null = null;
  let deployment: DeploymentConfig | null = null;
  let scope = "";
  let state: WalletState = emptyState();
  let generation = 0;
  let timer: number | null = null;
  let workerRunning = false;
  let statusChunkCursor = 0;
  let refreshInFlight: Promise<void> | null = null;
  let vaultOperation: { key: string; promise: Promise<boolean> } | null = null;
  let lastSnapshotAt = 0;
  let snapshotDirty = false;
  let depositInFlight: string | null = null;
  let registryCache: { keys: Array<{ key_id: string; public_key: string }> } | null = null;
  const claimsInFlight = new Set<string>();

  function call<T>(fn: (input: string) => string, input: unknown): T {
    return JSON.parse(fn(JSON.stringify(input))) as T;
  }

  function unlocked() {
    if (!seedHex || !publicConfig || !deployment) throw new Error("Wallet session is locked");
    return { seedHex, publicConfig, deployment };
  }

  function chainContext() {
    return requiredNonZeroFelt(unlocked().deployment.contracts.exchange, "exchange address");
  }

  // local state

  async function loadState() {
    const { seedHex: seed, publicConfig: config } = unlocked();
    const key = `${STATE_PREFIX}${scope}`;
    const stored = readJson<EncryptedLocalStore>(key);
    state = emptyState();
    if (!stored) return;
    try {
      state = await decryptLocalStore<WalletState>(stored, seed, config.account_id, "wallet-state");
    } catch {
      localStorage.removeItem(key);
    }
  }

  async function saveState() {
    if (!seedHex || !publicConfig) return;
    const encrypted = await encryptLocalStore(state, seedHex, publicConfig.account_id, "wallet-state");
    localStorage.setItem(`${STATE_PREFIX}${scope}`, JSON.stringify(encrypted));
    snapshotDirty = true;
    notifyWalletRuntimeChanged();
  }

  async function loadPrivacyRegistry(): Promise<PrivateRegistry | undefined> {
    const { seedHex: seed, publicConfig: config } = unlocked();
    const stored = readJson<EncryptedLocalStore>(`${PRIVACY_REGISTRY_PREFIX}${scope}`);
    if (!stored) return undefined;
    try {
      const serialized = await decryptLocalStore<SerializedStarknetPrivacyRegistry>(stored, seed, config.account_id, "starknet-privacy-registry");
      const { deserializeStarknetPrivacyRegistry } = await import("./integrations/starknetPrivacyRegistry");
      return deserializeStarknetPrivacyRegistry(serialized);
    } catch {
      localStorage.removeItem(`${PRIVACY_REGISTRY_PREFIX}${scope}`);
      return undefined;
    }
  }

  async function savePrivacyRegistry(registry: PrivateRegistry) {
    const { seedHex: seed, publicConfig: config } = unlocked();
    const { serializeStarknetPrivacyRegistry } = await import("./integrations/starknetPrivacyRegistry");
    const encrypted = await encryptLocalStore(serializeStarknetPrivacyRegistry(registry), seed, config.account_id, "starknet-privacy-registry");
    localStorage.setItem(`${PRIVACY_REGISTRY_PREFIX}${scope}`, JSON.stringify(encrypted));
  }

  // session

  async function hydrate(nextSeedHex: string, sessionGeneration: number) {
    ensureCurrent(sessionGeneration);
    const nextDeployment = await loadDeployment();
    const nextConfig = JSON.parse(core.zylith_wallet_derive_public_config(nextSeedHex)) as WalletPublicConfig;
    ensureCurrent(sessionGeneration);
    seedHex = nextSeedHex;
    publicConfig = nextConfig;
    deployment = nextDeployment;
    scope = `${nextConfig.account_id}:${normalizeFeltForComparison(nextDeployment.contracts.exchange)}`;
    await loadState();
    ensureCurrent(sessionGeneration);
    await pullRecoverySnapshot().catch(() => false);
    startWorker();
    notifyWalletRuntimeChanged();
    return true;
  }

  function ensureCurrent(sessionGeneration: number) {
    if (sessionGeneration !== generation) throw new Error("Wallet session changed. Retry.");
  }

  function lock() {
    generation += 1;
    vaultOperation = null;
    workerRunning = false;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    refreshInFlight = null;
    seedHex = null;
    publicConfig = null;
    deployment = null;
    scope = "";
    state = emptyState();
    registryCache = null;
    depositInFlight = null;
    statusChunkCursor = 0;
    notifyWalletRuntimeChanged();
  }

  function startWorker() {
    workerRunning = true;
    kick();
  }

  /** refreshes now and schedules the next refresh by what is in motion. */
  function kick() {
    if (!workerRunning) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    const sessionGeneration = generation;
    void refresh()
      .catch(() => undefined)
      .finally(() => {
        if (!workerRunning || sessionGeneration !== generation || timer !== null) return;
        timer = window.setTimeout(() => {
          timer = null;
          kick();
        }, refreshDelay());
      });
  }

  function refreshDelay() {
    const jitter = crypto.getRandomValues(new Uint32Array(1))[0] % (2 * REFRESH_JITTER_MS + 1);
    return REFRESH_CADENCE_MS - REFRESH_JITTER_MS + jitter;
  }

  // wallet-signature vault

  function vaultStorageKey(starknetAddress?: string | null) {
    const normalized = starknetAddress ? normalizeFeltForComparison(starknetAddress) : "";
    return normalized ? `${VAULT_KEY}:${normalized}` : VAULT_KEY;
  }

  function readVault(starknetAddress?: string | null) {
    return readJson<VaultRecord>(vaultStorageKey(starknetAddress));
  }

  function hasVault(starknetAddress?: string | null) {
    return isWalletSignatureVaultRecord(readVault(starknetAddress));
  }

  function runVaultOperation(key: string, operation: () => Promise<boolean>) {
    if (vaultOperation?.key === key) return vaultOperation.promise;
    const promise = operation().finally(() => {
      if (vaultOperation?.promise === promise) vaultOperation = null;
    });
    vaultOperation = { key, promise };
    return promise;
  }

  async function vaultContext(starknetAddress: string, messageVersion: WalletSignatureMessageVersion = 1, deploymentId?: string): Promise<WalletSignatureVaultContext> {
    const provider = selectedStarknetProvider();
    if (!provider) throw new Error("Connect a Starknet wallet first");
    const walletAddress = normalizeFeltForComparison(starknetAddress);
    const connected = connectedProviderAddress(provider as never);
    if (connected && normalizeFeltForComparison(connected) !== walletAddress) {
      throw new Error("Connected Starknet wallet changed during private trading authorization");
    }
    const manifest = await loadDeployment();
    await ensureWalletChain(provider as never, manifest);
    const chainId = requiredNonZeroFelt(manifest.chain_id, "chain_id");
    const resolvedDeploymentId = deploymentId?.trim().toLowerCase() || (await walletAuthDeploymentId(manifest, messageVersion));
    const origin = window.location?.origin || "zylith://local";
    const typedData = await buildZylithWalletAuthTypedData({ walletAddress, chainId, deploymentId: resolvedDeploymentId, origin, messageVersion });
    const signature = await requestStarknetWalletTypedSignature(provider as never, typedData);
    return { signature, walletAddress, chainId, deploymentId: resolvedDeploymentId, origin, messageVersion };
  }

  async function vaultRequest(context: WalletSignatureVaultContext) {
    const [walletAuthId, authToken] = await Promise.all([walletSignatureVaultId(context), walletSignatureVaultAuthToken(context)]);
    return { walletAuthId, authToken, path: `/api/wallet-vaults/${encodeURIComponent(walletAuthId)}` };
  }

  async function pullVault(context: WalletSignatureVaultContext): Promise<WalletSignatureVaultRecord | null> {
    if (!BACKUP_URL) return null;
    const { walletAuthId, authToken, path } = await vaultRequest(context);
    let response: Response;
    try {
      response = await fetchWithTimeout(`${BACKUP_URL}${path}`, { headers: { accept: "application/json", "x-zylith-wallet-vault-auth": authToken } }, WALLET_VAULT_REQUEST_TIMEOUT_MS);
    } catch {
      throw new Error("Private trading state is unavailable. Retry later.");
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new RuntimeHttpStatusError(path, response.status, "");
    const bundle = (await response.json()) as WalletSignatureVaultBundle;
    return bundle.wallet_auth_id === walletAuthId && isWalletSignatureVaultRecord(bundle.vault) ? bundle.vault : null;
  }

  async function pushVault(context: WalletSignatureVaultContext, vault: VaultRecord) {
    if (!BACKUP_URL) return;
    const { walletAuthId, authToken, path } = await vaultRequest(context);
    await postJson(BACKUP_URL, path, { wallet_auth_id: walletAuthId, vault, updated_at_unix_ms: Date.now() }, { "x-zylith-wallet-vault-auth": authToken });
  }

  async function openVault(vault: WalletSignatureVaultRecord, context: WalletSignatureVaultContext, sessionGeneration: number) {
    if (!walletSignatureVaultMetadataMatches(vault, context)) return false;
    let nextSeedHex: string;
    try {
      nextSeedHex = await decryptSeedWithWalletSignature(vault, context);
    } catch {
      return false;
    }
    ensureCurrent(sessionGeneration);
    localStorage.setItem(vaultStorageKey(vault.wallet_address), JSON.stringify(vault));
    return hydrate(normalizeSeed(nextSeedHex), sessionGeneration);
  }

  function createWalletWithWalletSignature(starknetAddress: string) {
    return runVaultOperation(`create:${normalizeFeltForComparison(starknetAddress)}`, async () => {
      const sessionGeneration = generation;
      const context = await vaultContext(starknetAddress);
      ensureCurrent(sessionGeneration);
      if (hasVault(context.walletAddress)) throw new Error("Wallet session already exists");
      const remote = await pullVault(context);
      if (remote) return openVault(remote, context, sessionGeneration);
      const nextSeedHex = normalizeSeed(core.zylith_wallet_generate_seed_hex());
      const vault = await encryptSeedWithWalletSignature(nextSeedHex, context);
      ensureCurrent(sessionGeneration);
      // the remote vault is the wallet's only backup, so a new seed is used only once stored; a
      // conflict means this wallet already stored one elsewhere, which is restored instead.
      try {
        await pushVault(context, vault);
      } catch (error) {
        if (error instanceof RuntimeHttpStatusError && error.status === 409) {
          const existing = await pullVault(context);
          if (existing) return openVault(existing, context, sessionGeneration);
        }
        throw new Error("Could not back up the new private trading wallet. Nothing was created; retry when the service is reachable.", { cause: error });
      }
      return openVault(vault, context, sessionGeneration);
    });
  }

  function unlockWithWalletSignature(starknetAddress: string) {
    return runVaultOperation(`unlock:${normalizeFeltForComparison(starknetAddress)}`, async () => {
      const sessionGeneration = generation;
      if (seedHex) return true;
      const stored = readVault(starknetAddress);
      const storedVault = isWalletSignatureVaultRecord(stored) ? stored : null;
      const context = await vaultContext(starknetAddress, storedVault?.message_version ?? 1, storedVault?.deployment_id);
      ensureCurrent(sessionGeneration);
      const vault = storedVault ?? (await pullVault(context));
      return vault ? openVault(vault, context, sessionGeneration) : false;
    });
  }

  // recovery snapshots

  function recoveryHeaders(seed: string) {
    return { "x-zylith-recovery-auth": core.zylith_wallet_recovery_auth_tag(seed) };
  }

  function recoveryPath(accountId: string) {
    return `/api/recovery/${encodeURIComponent(accountId)}/artifacts`;
  }

  async function pullRecoverySnapshot() {
    if (!BACKUP_URL) return false;
    const { seedHex: seed, publicConfig: config } = unlocked();
    const list = await fetchJson<{ artifacts?: RecoveryArtifact[] }>(BACKUP_URL, recoveryPath(config.account_id), recoveryHeaders(seed));
    const latest = (list?.artifacts ?? [])
      .filter((artifact) => artifact.kind === "Snapshot" && artifact.account_id === config.account_id)
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
    if (!latest) return false;
    const payload = JSON.parse(core.zylith_wallet_decrypt_recovery_artifact(seed, JSON.stringify(latest))) as { version?: number; scope?: string; state?: WalletState };
    if (payload.version !== 2 || payload.scope !== scope || !payload.state) return false;
    if (!mergeState(state, payload.state)) return false;
    await saveState();
    return true;
  }

  async function pushRecoverySnapshot(force = false) {
    if (!BACKUP_URL || !seedHex || !publicConfig) return false;
    const now = Date.now();
    if (!force && (!snapshotDirty || now - lastSnapshotAt < RECOVERY_SNAPSHOT_MIN_INTERVAL_MS)) return false;
    const artifact = core.zylith_wallet_create_recovery_snapshot(
      JSON.stringify({
        seed_hex: seedHex,
        sequence: now,
        created_at_unix_ms: now,
        payload_json: JSON.stringify(padRecoverySnapshotPayload({ version: 2, scope, state })),
      })
    );
    await postJson(BACKUP_URL, recoveryPath(publicConfig.account_id), { artifact: JSON.parse(artifact) }, recoveryHeaders(seedHex));
    lastSnapshotAt = now;
    snapshotDirty = false;
    return true;
  }

  // notes and balances

  function noteByCommitment(commitment: string) {
    const key = normalizeFeltForComparison(commitment);
    return state.notes.find((note) => normalizeFeltForComparison(note.commitment) === key);
  }

  function spendable(note: WalletNote) {
    return !note.spent && !note.locked_by && !note.exit && (note.source === "output" || note.deposit?.confirmed === true);
  }

  function addNote(fields: NoteFields, asset: string, source: WalletNote["source"], extra: Partial<WalletNote>) {
    const summary = JSON.parse(core.zylith_wallet_note_summary(JSON.stringify(fields))) as { commitment: string; nullifier: string };
    if (noteByCommitment(summary.commitment)) return false;
    state.notes.push({ commitment: summary.commitment, nullifier: summary.nullifier, asset, fields, source, ...extra });
    return true;
  }

  function getBalances(): WalletBalance[] {
    const balances = new Map<string, { available: bigint; locked: bigint }>();
    const entry = (asset: string) => {
      const current = balances.get(asset) ?? { available: 0n, locked: 0n };
      balances.set(asset, current);
      return current;
    };
    for (const note of state.notes) {
      if (note.spent || (note.source === "deposit" && note.deposit?.confirmed !== true)) continue;
      if (spendable(note)) entry(note.asset).available += BigInt(note.fields.amount);
      else if (note.locked_by || note.exit) entry(note.asset).locked += BigInt(note.fields.amount);
    }
    for (const order of state.orders) {
      if (OPEN_STATES.has(order.state) && order.state !== "submitting") entry(order.funding_asset).locked += BigInt(order.locked_input);
    }
    return [...balances].map(([asset, balance]) => ({ asset, available: balance.available.toString(), locked: balance.locked.toString() }));
  }

  function getPendingDeposits(): PendingDeposit[] {
    return state.notes
      .filter((note) => note.source === "deposit" && note.deposit && !note.deposit.confirmed && !(note.deposit.failed && !note.deposit.transaction_hash))
      .map((note) => ({
        note_commitment: note.commitment,
        asset: note.asset,
        amount: note.fields.amount,
        transaction_hash: note.deposit!.transaction_hash,
        request_id: note.deposit!.request_id,
        requested_at_unix_ms: note.deposit!.requested_at_ms,
        confirmed: false,
        failed: note.deposit!.failed === true,
        failure_reason: note.deposit!.failure_reason,
      }));
  }

  function getWithdrawableNotes(): WithdrawableNote[] {
    return state.notes
      .filter((note) => note.source === "output" || note.deposit?.confirmed)
      .map((note) => ({
        note_commitment: note.commitment,
        source: note.source,
        asset: note.asset,
        amount: note.fields.amount,
        locked: Boolean(note.locked_by || (note.exit && note.exit.stage !== "failed")),
        spent: Boolean(note.spent),
        exit_stage: note.exit?.stage,
      }));
  }

  // deposits

  async function submitDepositViaWallet(asset: string, amountAtoms: string) {
    const { seedHex: seed, deployment: manifest } = unlocked();
    const amount = BigInt(amountAtoms);
    if (amount <= 0n) throw new Error("Deposit amount must be greater than zero");
    const rail = selectedDepositFundingRail(manifest);
    const privacyPoolAddress = requiredNonZeroFelt(rail.privacyPool, "privacy_pool_address");
    const bridgeAddress = requiredNonZeroFelt(rail.bridgeAdapter, "privacy_deposit_bridge_address");
    const tokenAddress = fundingRailTokenAddress(manifest, asset);
    setPrivacyFundingStage("Connecting Starknet wallet and checking network");
    const provider = await selectInjectedStarknetProvider();
    const plan = call<{
      note_commitment: string;
      note_fields: NoteFields;
      encoded_args: Record<"funding_commitments" | "deposit_roots" | "encrypted_note_activations" | "note_commitments" | "asset_ids" | "amounts" | "withdraw_authorities", string[]>;
    }>(core.zylith_wallet_build_deposit_submission_plan, { seed_hex: seed, asset_id: asset, amount: amount.toString(), deposit_nonce: randomU64() });
    const requestId = randomFeltHex();
    addNote(plan.note_fields, asset, "deposit", {
      deposit: { funding_commitment: plan.encoded_args.funding_commitments[0], request_id: requestId, requested_at_ms: Date.now(), confirmed: false },
    });
    const note = noteByCommitment(plan.note_commitment)!;
    await saveState();
    await pushRecoverySnapshot(true).catch(() => false);
    depositInFlight = requestId;
    let started = false;
    try {
      const sdkRegistry = await loadPrivacyRegistry();
      const { submitPrivacyBridgeDeposit } = await import("./integrations/starknetPrivacyFunding");
      started = true;
      const result = await submitPrivacyBridgeDeposit({
        provider: provider as never,
        seedHex: seed,
        chainId: requiredString(manifest.chain_id, "chain_id"),
        rpcUrl: requiredString(manifest.rpc_url, "rpc_url"),
        privacyPoolAddress,
        bridgeAddress,
        tokenAddress,
        discoveryUrl: serviceUrl(rail.discoveryUrl, "/starknet-privacy-discovery"),
        provingUrl: serviceUrl(rail.provingUrl, "/starknet-privacy-prover"),
        provingOhttpEnabled: rail.provingOhttpEnabled,
        paymasterAddress: requiredNonZeroFelt(rail.paymasterAddress, "privacy_paymaster_address"),
        paymasterUrl: requiredString(rail.paymasterUrl, "privacy_paymaster_url"),
        privacyProofSignerClassHash: rail.privacyProofSignerClassHash,
        minProvingDelayBlocks: rail.minProvingDelayBlocks ?? DEFAULT_MIN_PROVING_DELAY_BLOCKS,
        sdkRegistry,
        plan: { amount, encodedArgs: plan.encoded_args },
      });
      await savePrivacyRegistry(result.sdkRegistry).catch(() => undefined);
      note.deposit!.transaction_hash = result.transactionHash;
      await saveState();
      return { transaction_hash: result.transactionHash, note_commitment: note.commitment };
    } catch (error) {
      // an ambiguous network failure may still land; anything else never submitted.
      const message = error instanceof Error ? error.message : String(error);
      const ambiguous = started && /(network request failed|failed to fetch|service is unavailable|timed out)/i.test(message);
      if (!ambiguous) state.notes = state.notes.filter((candidate) => candidate !== note);
      await saveState();
      throw error;
    } finally {
      depositInFlight = null;
      void pushRecoverySnapshot(true).catch(() => false);
      kick();
    }
  }

  async function refreshDeposits() {
    const pending = state.notes.filter((note) => note.deposit && !note.deposit.confirmed && !note.deposit.failed);
    if (pending.length === 0) return false;
    // every wallet reads the same recent list and matches locally.
    const recent = await exchange().recentDeposits();
    const confirmed = new Set(recent.recent_funding_commitments.map(normalizeFeltForComparison));
    const stale = !recent.last_successful_sync_unix_ms || recent.sync_lag_ms > DEPOSIT_CONFIRMATION_STALE_MS;
    let changed = false;
    for (const note of pending) {
      const record = depositRecord(note);
      if (confirmed.has(normalizeFeltForComparison(note.deposit!.funding_commitment))) {
        markDepositRecordConfirmed(record);
      } else if (!stale) {
        const status = note.deposit!.transaction_hash ? await receipt(note.deposit!.transaction_hash) : null;
        const reason = pendingDepositFailureReason({
          record,
          status,
          nowUnixMs: Date.now(),
          inFlightRequestId: depositInFlight,
          failureGraceMs: PENDING_DEPOSIT_FAILURE_GRACE_MS,
          confirmedRegistrationGraceMs: CONFIRMED_DEPOSIT_REGISTRATION_GRACE_MS,
        });
        if (!reason) continue;
        markDepositRecordFailed(record, reason);
      } else {
        continue;
      }
      note.deposit = { ...note.deposit!, confirmed: record.deposit_confirmed === true, failed: record.deposit_failed, failure_reason: record.deposit_failure_reason, transaction_hash: record.pending_deposit_tx };
      changed = true;
    }
    return changed;
  }

  function depositRecord(note: WalletNote) {
    return {
      source: "deposit" as const,
      deposit_confirmed: note.deposit!.confirmed,
      deposit_failed: note.deposit!.failed,
      deposit_failure_reason: note.deposit!.failure_reason,
      funding_commitment: note.deposit!.funding_commitment,
      pending_deposit_tx: note.deposit!.transaction_hash,
      deposit_request_id: note.deposit!.request_id,
      deposit_requested_at_unix_ms: note.deposit!.requested_at_ms,
    };
  }

  async function receipt(transactionHash: string): Promise<TransactionReceiptStatus | null> {
    return fetchTransactionReceiptStatus(transactionHash, unlocked().deployment).catch(() => null);
  }

  // orders

  function pairConfig(pair: string): PairConfig {
    const config = unlocked().deployment.product.pairs[pair];
    if (!config?.enabled) throw new Error(`${pair} is not traded`);
    return config;
  }

  async function executionKeys() {
    if (!registryCache) {
      const registry = await exchange().executionKeys();
      assertPinnedExecutionKeys(core.zylith_wallet_registry_fingerprint(JSON.stringify(registry)), unlocked().deployment);
      registryCache = registry;
    }
    return registryCache;
  }

  /** sealed requests are already one fixed size: the envelope pads inside, in wasm. */
  async function submitSealed(built: SealedBuild) {
    return exchange().submit(built.sealed, built.response_key);
  }

  /** the input an order locks: its base for a sell, its quote at the limit for a buy. */
  function fundingRequirement(draft: OrderDraft, pair: PairConfig) {
    const amount = BigInt(draft.amount);
    return draft.side === "Sell" ? amount : ceilDiv(amount * BigInt(draft.limitPrice), BigInt(pair.price_base_scale));
  }

  /** the fewest spendable notes covering `required`, largest first. */
  function selectFunding(asset: string, required: bigint) {
    const candidates = state.notes.filter((note) => note.asset === asset && spendable(note)).sort((left, right) => (BigInt(right.fields.amount) > BigInt(left.fields.amount) ? 1 : -1));
    const selected: WalletNote[] = [];
    let total = 0n;
    for (const note of candidates) {
      if (total >= required || selected.length === MAX_FUNDING_NOTES) break;
      selected.push(note);
      total += BigInt(note.fields.amount);
    }
    if (total < required) {
      const available = candidates.reduce((sum, note) => sum + BigInt(note.fields.amount), 0n);
      throw new Error(
        available >= required
          ? `An order is funded by at most ${MAX_FUNDING_NOTES} notes. Place a smaller order first; its refund merges your notes.`
          : `Insufficient ${asset} balance.`
      );
    }
    return selected;
  }

  async function submitOrder(draft: OrderDraft) {
    const { seedHex: seed } = unlocked();
    const pair = pairConfig(draft.pair);
    if (draft.external && !pair.external_match_enabled) throw new Error("External execution is disabled for this pair");
    if (BigInt(draft.amount) < BigInt(pair.min_order_amount)) throw new Error("Order is below the pair's minimum size");
    const fundingAsset = draft.side === "Sell" ? pair.base_asset_id : pair.quote_asset_id;
    const funding = selectFunding(fundingAsset, fundingRequirement(draft, pair));
    const [registry, status] = await Promise.all([executionKeys(), exchange().exchangeStatus()]);
    const expiresAt = draft.expiresAtMs ?? Date.now() + DEFAULT_ORDER_LIFETIME_MS;
    const built = call<SealedBuild & { order_id: string; terms: unknown; nullifiers: string[] }>(core.zylith_wallet_build_order_request, {
      seed_hex: seed,
      chain_context: chainContext(),
      pair: draft.pair,
      sell: draft.side === "Sell",
      external: draft.external,
      amount: draft.amount,
      limit: draft.limitPrice,
      expiry_ms: expiresAt,
      funding: funding.map((note) => note.fields),
      registry,
    });
    const fundingAmount = funding.reduce((sum, note) => sum + BigInt(note.fields.amount), 0n).toString();
    const now = Date.now();
    const order: StoredOrder = {
      order_id: built.order_id,
      pair: draft.pair,
      side: draft.side,
      external: draft.external,
      amount: draft.amount,
      limit_price: draft.limitPrice,
      expires_at_ms: expiresAt,
      funding_asset: fundingAsset,
      funding_amount: fundingAmount,
      state: "submitting",
      filled_base: "0",
      filled_quote: "0",
      fees: "0",
      submitted_at_ms: now,
      updated_at_ms: now,
      terms: built.terms,
      funding_notes: funding.map((note) => note.commitment),
      nullifiers: built.nullifiers,
      base_asset: pair.base_asset_id,
      quote_asset: pair.quote_asset_id,
      scan_after_seq: status.seq,
      seen_seqs: [],
      locked_input: fundingAmount,
    };
    for (const note of funding) note.locked_by = order.order_id;
    state.orders.unshift(order);
    await saveState();
    await pushRecoverySnapshot(true).catch(() => false);
    try {
      await submitSealed(built);
      setOrder(order, { state: "pending" });
    } catch (error) {
      if (definitiveRejection(error)) {
        releaseFunding(order);
        setOrder(order, { state: "failed", last_error: userFacingErrorMessage(error) });
        await saveState();
        throw error;
      }
      // the operator may have accepted it; the next refresh settles which.
    }
    await saveState();
    kick();
    return { order_id: order.order_id };
  }

  async function cancelOrder(orderId: string) {
    const { seedHex: seed } = unlocked();
    const order = orderById(orderId);
    if (!order || !OPEN_STATES.has(order.state)) throw new Error("The order is not open");
    const built = call<SealedBuild>(core.zylith_wallet_build_cancel_request, { seed_hex: seed, chain_context: chainContext(), order_id: order.order_id, registry: await executionKeys() });
    await submitSealed(built);
    setOrder(order, { state: "cancelling", cancel_requested: true });
    await saveState();
    kick();
  }

  function orderById(orderId: string) {
    const key = normalizeFeltForComparison(orderId);
    return state.orders.find((order) => normalizeFeltForComparison(order.order_id) === key);
  }

  function setOrder(order: StoredOrder, update: Partial<StoredOrder>) {
    Object.assign(order, update, { updated_at_ms: Date.now() });
  }

  function releaseFunding(order: StoredOrder) {
    for (const note of state.notes) if (note.locked_by === order.order_id) note.locked_by = undefined;
    order.locked_input = "0";
  }

  function spendFunding(order: StoredOrder) {
    for (const commitment of order.funding_notes) {
      const note = noteByCommitment(commitment);
      if (note) {
        note.spent = true;
        note.locked_by = undefined;
      }
    }
  }

  function closeOrder(order: StoredOrder, removal: NonNullable<OrderEvent["report"]["removal"]>, closedSeq: number | undefined) {
    order.closed_seq = closedSeq;
    order.locked_input = "0";
    order.state = removal === "Cancelled" ? "cancelled" : removal === "Expired" ? "expired" : "filled";
    order.updated_at_ms = Date.now();
  }

  /** folds the operator's report of each transition into the order. */
  function applyEvents(order: StoredOrder, events: OrderEvent[]) {
    let changed = false;
    for (const event of events) {
      if (order.seen_seqs.includes(event.seq)) continue;
      const report = event.report;
      const sell = order.side === "Sell";
      const consumed = BigInt(sell ? report.fill_base : report.fill_quote) + BigInt(sell ? report.external_base : report.external_quote);
      order.seen_seqs.push(event.seq);
      order.filled_base = (BigInt(order.filled_base) + BigInt(report.fill_base) + BigInt(report.external_base)).toString();
      order.filled_quote = (BigInt(order.filled_quote) + BigInt(report.fill_quote) + BigInt(report.external_quote)).toString();
      order.fees = (BigInt(order.fees) + BigInt(report.fee)).toString();
      order.locked_input = maxZero(BigInt(order.locked_input) - consumed).toString();
      if (report.admitted) spendFunding(order);
      if (report.removal) {
        closeOrder(order, report.removal, event.seq);
      } else if (order.state === "pending" || order.state === "submitting") {
        order.state = "live";
      }
      order.updated_at_ms = Date.now();
      changed = true;
    }
    return changed;
  }

  /** open orders, and exits the operator is still carrying out. */
  function followedOrders() {
    return state.orders.filter((order) => OPEN_STATES.has(order.state));
  }

  function followedExits() {
    return state.notes.filter((note) => note.exit && !note.spent && note.exit.stage !== "failed" && note.exit.stage !== "finalized" && note.exit.stage !== "claiming");
  }

  /** one fixed-size sealed status request per heartbeat. multiple chunks rotate across heartbeats,
   * so neither traffic cadence nor request count reveals how much state this wallet follows. */
  async function fetchStatus(): Promise<StatusAnswer | null> {
    const orders = followedOrders();
    const exits = followedExits();
    const built = call<SealedBuild[]>(core.zylith_wallet_build_status_requests, {
      registry: await executionKeys(),
      orders: orders.map((order) => ({ order_id: order.order_id, after_seq: order.seen_seqs.length > 0 ? Math.max(...order.seen_seqs) : 0 })),
      nullifiers: exits.map((note) => note.nullifier),
    });
    const request = built[statusChunkCursor % built.length];
    statusChunkCursor = (statusChunkCursor + 1) % built.length;
    const answer = await exchange().status(request.sealed, request.response_key);
    return answer;
  }

  async function refreshOrders(status: StatusAnswer | null) {
    if (!status) return false;
    const byId = new Map(status.orders.map((entry) => [normalizeFeltForComparison(entry.order_id), entry]));
    let changed = false;
    for (const order of followedOrders()) {
      const entry = byId.get(normalizeFeltForComparison(order.order_id));
      if (!entry) continue;
      if (entry.status === "unknown") {
        changed = (await resolveUnknownOrder(order)) || changed;
        continue;
      }
      changed = applyEvents(order, entry.events) || changed;
      // a closed order whose removing event the wallet never saw (its history was pruned, or
      // the wallet was restored from an old backup) closes from the operator's tombstone.
      if (entry.status === "closed" && !entry.more_events && entry.removal && OPEN_STATES.has(order.state)) {
        closeOrder(order, entry.removal, entry.closed_seq ?? undefined);
        changed = true;
        continue;
      }
      if (entry.status === "live" && (order.state === "pending" || order.state === "submitting")) {
        spendFunding(order);
        setOrder(order, { state: order.cancel_requested ? "cancelling" : "live" });
        changed = true;
      } else if (entry.status === "pending" && order.state === "submitting") {
        setOrder(order, { state: "pending" });
        changed = true;
      }
    }
    return changed;
  }

  /** an order the operator does not know: its funding nullifiers say whether it was ever admitted. */
  async function resolveUnknownOrder(order: StoredOrder) {
    if (Date.now() - order.submitted_at_ms < UNKNOWN_ORDER_GRACE_MS && !order.cancel_requested) return false;
    const states = await Promise.all(order.nullifiers.map((nullifier) => nullifierState(nullifier)));
    if (states.every((value) => value === NULLIFIER_UNUSED)) {
      releaseFunding(order);
      const state = unadmittedOrderState(order, Date.now());
      setOrder(order, { state, closed_seq: order.scan_after_seq, last_error: state === "failed" ? "The operator did not accept this order." : undefined });
      return true;
    }
    // admitted on chain: its outputs arrive through the transition scan. past its expiry it
    // cannot still rest, whatever closed it.
    spendFunding(order);
    const expiry = Number((order.terms as { expiry_ms?: number } | undefined)?.expiry_ms);
    if (expiry <= Date.now()) {
      order.locked_input = "0";
      setOrder(order, { state: "expired" });
    } else if (order.state !== "live") {
      setOrder(order, { state: "live" });
    }
    return true;
  }

  async function nullifierState(nullifier: string) {
    const { deployment: manifest } = unlocked();
    const [value] = await starknetCall(manifest.rpc_url, manifest.contracts.exchange, "nullifier_state", [nullifier]);
    return BigInt(value ?? "0");
  }

  /** recovers every open order's outputs from the transitions settled since the last scan. */
  async function scanTransitions() {
    // only orders that can still have unrecovered outputs are scanned, from the earliest seq
    // any of them still needs.
    const scanning = state.orders.filter(
      (order) => (order.state !== "failed" || order.closed_seq !== undefined) && (order.closed_seq === undefined || order.closed_seq > Math.max(order.scan_after_seq, state.scanned_seq))
    );
    if (scanning.length === 0) return false;
    const from = Math.min(...scanning.map((order) => Math.max(order.scan_after_seq, state.scanned_seq)));
    const status = await exchange().indexerStatus();
    if (status.latest_seq <= from) return false;
    const { latestSeq, transitions } = await exchange().transitionsAfter(from);
    let changed = false;
    for (const order of scanning) {
      const relevant = transitions.filter((transition) => transition.seq > Math.max(order.scan_after_seq, state.scanned_seq) && transition.seq <= (order.closed_seq ?? Infinity));
      if (relevant.length === 0) continue;
      changed = recoverOutputs(order, relevant) || changed;
    }
    state.scanned_seq = Math.max(state.scanned_seq, latestSeq);
    return changed || transitions.length > 0;
  }

  function recoverOutputs(order: StoredOrder, transitions: TransitionOutputs[]) {
    const recovered = call<Array<{ seq: number; kind: number; index: number; note: NoteFields }>>(core.zylith_wallet_recover_order_outputs, {
      terms: order.terms,
      base_asset: order.base_asset,
      quote_asset: order.quote_asset,
      transitions: transitions.map((transition) => ({ seq: transition.seq, outputs: transition.outputs as OutputRecord[] })),
    });
    let changed = false;
    for (const output of recovered) {
      const proceeds = output.kind === OUTPUT_KIND_PROCEEDS;
      const asset = proceeds === (order.side === "Sell") ? order.quote_asset : order.base_asset;
      changed = addNote(output.note, asset, "output", { output: { order_id: order.order_id, seq: output.seq, kind: output.kind } }) || changed;
    }
    if (recovered.length > 0) spendFunding(order);
    return changed;
  }

  // withdrawals

  function withdrawalAvailable() {
    return Boolean(deployment && strk20WithdrawalEnabledForDeployment(deployment));
  }

  async function withdraw(noteCommitment: string) {
    const { seedHex: seed } = unlocked();
    if (!withdrawalAvailable()) throw new Error("Withdrawals are not configured for this deployment.");
    const note = noteByCommitment(noteCommitment);
    if (!note || !(spendable(note) || note.exit?.stage === "failed")) throw new Error("This note cannot be withdrawn");
    const built = call<SealedBuild & { nullifier: string; exit_commitment: string }>(core.zylith_wallet_build_withdraw_request, {
      seed_hex: seed,
      chain_context: chainContext(),
      note: note.fields,
      exit_commitment: note.exit?.exit_commitment,
      registry: await executionKeys(),
    });
    note.exit = { exit_commitment: built.exit_commitment, stage: "requested", requested_at_ms: Date.now() };
    await saveState();
    await pushRecoverySnapshot(true).catch(() => false);
    try {
      await submitSealed(built);
    } catch (error) {
      if (definitiveRejection(error)) {
        note.exit = { ...note.exit, stage: "failed", failure: userFacingErrorMessage(error) };
        await saveState();
      }
      throw error;
    }
    kick();
    return { nullifier: built.nullifier };
  }

  async function refreshWithdrawals(status: StatusAnswer | null) {
    const byNullifier = new Map((status?.withdrawals ?? []).map((entry) => [normalizeFeltForComparison(entry.nullifier), entry]));
    let changed = false;
    for (const note of state.notes.filter((candidate) => candidate.exit && !candidate.spent && candidate.exit.stage !== "failed")) {
      const exit = note.exit!;
      if (exit.stage === "claiming") {
        changed = (await settleClaim(note)) || changed;
        continue;
      }
      if (exit.stage !== "finalized") {
        const stage = byNullifier.get(normalizeFeltForComparison(note.nullifier))?.stage;
        if (stage && typeof stage === "object" && "Failed" in stage) {
          note.exit = { ...exit, stage: "failed", failure: stage.Failed.reason };
          changed = true;
          continue;
        }
        if (stage && typeof stage === "object" && "Requested" in stage && exit.stage !== "maturing") {
          note.exit = { ...exit, stage: "maturing", matures_at_ms: stage.Requested.matures_at_ms };
          changed = true;
        } else if (stage === "Proving" && exit.stage === "requested") {
          note.exit = { ...exit, stage: "proving" };
          changed = true;
        }
        // the chain confirms the exit once the operator has sent it, or when it no longer knows it.
        const sent = stage === null || stage === undefined || (typeof stage === "object" && ("Finalizing" in stage || "Finalized" in stage));
        if (!sent || (await nullifierState(note.nullifier).catch(() => 0n)) !== NULLIFIER_EXITED) continue;
        note.exit = { ...note.exit!, stage: "finalized" };
        changed = true;
      }
      startClaim(note);
    }
    return changed;
  }

  /** a claim proves in the privacy pool for minutes, so it runs beside the refresh loop. */
  function startClaim(note: WalletNote) {
    if (claimsInFlight.has(note.commitment)) return;
    claimsInFlight.add(note.commitment);
    const sessionGeneration = generation;
    void claimExit(note)
      .then(() => (sessionGeneration === generation ? saveState() : undefined))
      .catch(() => undefined)
      .finally(() => claimsInFlight.delete(note.commitment));
  }

  /** claims a finalized exit into the privacy pool as an open note the wallet owns. */
  async function claimExit(note: WalletNote) {
    const { seedHex: seed, deployment: manifest } = unlocked();
    const rail = selectedDepositFundingRail(manifest);
    const privacyPoolAddress = requiredNonZeroFelt(rail.privacyPool, "privacy_pool_address");
    const bridgeAddress = requiredNonZeroFelt(rail.bridgeAdapter, "privacy_deposit_bridge_address");
    const tokenAddress = fundingRailTokenAddress(manifest, note.asset);
    const chainId = requiredNonZeroFelt(manifest.chain_id, "chain_id");
    const exit = note.exit!;
    const { submitPrivacyOpenNoteWithdrawal } = await import("./integrations/starknetPrivacyFunding");
    const result = await submitPrivacyOpenNoteWithdrawal({
      seedHex: seed,
      chainId,
      rpcUrl: requiredString(manifest.rpc_url, "rpc_url"),
      privacyPoolAddress,
      bridgeAddress,
      tokenAddress,
      discoveryUrl: serviceUrl(rail.discoveryUrl, "/starknet-privacy-discovery"),
      provingUrl: serviceUrl(rail.provingUrl, "/starknet-privacy-prover"),
      provingOhttpEnabled: rail.provingOhttpEnabled,
      paymasterAddress: requiredNonZeroFelt(rail.paymasterAddress, "privacy_paymaster_address"),
      paymasterUrl: requiredString(rail.paymasterUrl, "privacy_paymaster_url"),
      privacyProofSignerClassHash: rail.privacyProofSignerClassHash,
      minProvingDelayBlocks: rail.minProvingDelayBlocks ?? DEFAULT_MIN_PROVING_DELAY_BLOCKS,
      sdkRegistry: await loadPrivacyRegistry(),
      exitCommitment: exit.exit_commitment,
      signExitClaim: (openNoteId) =>
        call(core.zylith_wallet_sign_strk20_exit_claim, {
          seed_hex: seed,
          chain_id: chainId,
          bridge_address: bridgeAddress,
          privacy_pool_address: privacyPoolAddress,
          exchange_address: chainContext(),
          asset_id: note.asset,
          token_address: tokenAddress,
          amount: note.fields.amount,
          exit_commitment: exit.exit_commitment,
          open_note_id: openNoteId,
        }),
    });
    await savePrivacyRegistry(result.sdkRegistry).catch(() => undefined);
    note.exit = { ...exit, stage: "claiming", open_note_id: result.openNoteId, claim_transaction_hash: result.transactionHash };
    return true;
  }

  async function settleClaim(note: WalletNote) {
    const status = await receipt(note.exit!.claim_transaction_hash!);
    if (status?.confirmed && !status.failed) {
      note.spent = true;
      return true;
    }
    if (status?.failed) {
      note.exit = { ...note.exit!, stage: "finalized", claim_transaction_hash: undefined, open_note_id: undefined };
      return true;
    }
    return false;
  }

  // refresh

  function refresh() {
    refreshInFlight ??= (async () => {
      const sessionGeneration = generation;
      try {
        const status = await fetchStatus().catch(() => null);
        if (sessionGeneration !== generation) return;
        const steps = [refreshDeposits, () => refreshOrders(status), scanTransitions, () => refreshWithdrawals(status)];
        let changed = false;
        for (const step of steps) {
          changed = (await step().catch(() => false)) || changed;
          if (sessionGeneration !== generation) return;
        }
        if (changed) await saveState();
        await pushRecoverySnapshot().catch(() => false);
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  function serviceUrl(url: string | undefined, sameOriginPath: string) {
    const resolved = browserSafeServiceUrl(normalizeUrl(url), sameOriginPath);
    if (!resolved) throw new Error("Private funding service URLs are required");
    return resolved;
  }

  return {
    hasVault,
    vaultAuthMode: (starknetAddress) => (hasVault(starknetAddress) ? "wallet-signature" : "none"),
    isReady: () => Boolean(seedHex && publicConfig),
    createWalletWithWalletSignature,
    unlockWithWalletSignature,
    getPublicConfig: () => publicConfig,
    lock,
    getBalances,
    getPendingDeposits,
    getWithdrawableNotes,
    getOrders: () => state.orders.map((order) => ({ ...order })),
    withdrawalAvailable,
    submitDepositViaWallet,
    submitOrder,
    cancelOrder,
    withdraw,
    refresh,
  };
}

/** folds a backed-up state into the local one; true when anything was added or advanced. */
export function mergeState(local: WalletState, remote: WalletState) {
  let changed = false;
  for (const note of remote.notes ?? []) {
    const key = normalizeFeltForComparison(note.commitment);
    const existing = local.notes.find((candidate) => normalizeFeltForComparison(candidate.commitment) === key);
    if (!existing) {
      local.notes.push(note);
      changed = true;
    } else if (note.spent && !existing.spent) {
      existing.spent = true;
      changed = true;
    }
  }
  for (const order of remote.orders ?? []) {
    const index = local.orders.findIndex((candidate) => candidate.order_id === order.order_id);
    if (index === -1) local.orders.push(order);
    else if (order.updated_at_ms > local.orders[index].updated_at_ms) local.orders[index] = order;
    else continue;
    changed = true;
  }
  // rescanning is idempotent, so the earlier cursor wins.
  if (remote.scanned_seq < local.scanned_seq) {
    local.scanned_seq = remote.scanned_seq;
    changed = true;
  }
  local.orders.sort((left, right) => right.submitted_at_ms - left.submitted_at_ms);
  return changed;
}

function emptyState(): WalletState {
  return { version: 2, notes: [], orders: [], scanned_seq: 0 };
}

function definitiveRejection(error: unknown) {
  if (error instanceof ExchangeRejectedError) return true;
  return error instanceof ExchangeHttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

function ceilDiv(numerator: bigint, denominator: bigint) {
  return (numerator + denominator - 1n) / denominator;
}

function maxZero(value: bigint) {
  return value < 0n ? 0n : value;
}

function normalizeSeed(value: string) {
  const normalized = value.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("Recovery seed must be 64 hex characters");
  return normalized;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function randomU64() {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(words[0]) << 32n) | BigInt(words[1])).toString();
}

function randomFeltHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  bytes[0] &= 0x07;
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
