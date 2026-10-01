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
  ResidualRecoveryClaim,
  ResidualRecoveryFinalization,
  ResidualRecoveryPreparation,
  ResidualRecoverySubmission,
  SealedRequest,
  StatusAnswer,
  TraderWalletRuntime,
  TransitionOutputs,
  WalletOrder,
  WithdrawableNote,
} from "@zylith/sdk";
import type { PrivateRegistry } from "@starkware-libs/starknet-privacy-sdk";
import { ExchangeHttpError, ExchangeRejectedError, transitionWindows } from "@zylith/sdk";
import { notifyWalletRuntimeChanged, selectedStarknetProvider, setWalletRuntime } from "./domain/browserWallet";
import {
  BACKUP_URL,
  type DeploymentConfig,
  type PairConfig,
  assertPinnedExecutionKeys,
  enabledPairs,
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
  executeStarknetWalletCall,
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
  zylith_wallet_market_ids: (inputJson: string) => string;
  zylith_wallet_recovery_auth_tag: (seedHex: string) => string;
  zylith_wallet_build_deposit_submission_plan: (inputJson: string) => string;
  zylith_wallet_build_order_request: (inputJson: string) => string;
  zylith_wallet_build_cancel_request: (inputJson: string) => string;
  zylith_wallet_build_withdraw_request: (inputJson: string) => string;
  zylith_wallet_build_status_requests: (inputJson: string) => string;
  zylith_wallet_registry_fingerprint: (registryJson: string) => string;
  zylith_wallet_recover_order_outputs: (inputJson: string) => string;
  zylith_wallet_recover_order_residuals: (inputJson: string) => string;
  zylith_wallet_quote_residual_recovery: (inputJson: string) => string;
  zylith_wallet_build_residual_recovery: (inputJson: string) => string;
  zylith_wallet_build_note_membership: (inputJson: string) => string;
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

type ResidualNote = {
  chain_context: string;
  input_asset_id: string;
  pair_id: string;
  sell: boolean;
  external: boolean;
  remaining: string;
  limit: string;
  funding: string;
  reserved: string;
  reserved_offset: string;
  reserved_seq: number;
  expiry_ms: number;
  order_id: string;
  generation: number;
  owner: {
    owner_public_key: string;
    spend_authority: string;
    withdraw_authority: string;
    cancel_authority: string;
    nonce: string;
  };
  blinding: string;
};

type StoredResidual = {
  seq: number;
  index: number;
  note: ResidualNote;
  note_root?: string;
  membership?: unknown;
};

type RecoveryCapacityView = {
  generation: number;
  status: number;
  total: string;
  consumed_base: string;
  pool_quote: string;
  scale: string;
  opened_at: bigint;
};

export type PendingResidualExitView = {
  input_asset_id: string;
  input_amount: string;
  input_exit_commitment: string;
  output_asset_id: string;
  output_amount: string;
  output_exit_commitment: string;
  fee_amount: string;
  requested_at_ms: number;
  matures_at: number;
};

export class ResidualCapacityFreezeRequiredError extends Error {
  constructor() {
    super("External capacity must fill or be permissionlessly frozen after expiry before recovery.");
    this.name = "ResidualCapacityFreezeRequiredError";
  }
}

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
  /** the latest chain-authenticated residual authority; unchanged epochs do not replace it. */
  residual?: StoredResidual;
  /** durable retry identity for freezing an expired external reservation before recovery. */
  residual_capacity_freeze?: {
    residual_seq: number;
    transaction_hash: string;
    submitted_at_ms: number;
  };
  /** durable one-time exits for the latest prepared permissionless recovery. */
  residual_recovery?: {
    residual_seq: number;
    nullifier: string;
    statement_commitment: string;
    input_asset_id: string;
    input_amount: string;
    output_asset_id: string;
    output_amount: string;
    fee_amount: string;
    input_exit_commitment: string | null;
    output_exit_commitment: string | null;
    request_transaction_hash?: string;
    request_submitted_at_ms?: number;
    matures_at?: number;
    finalization_transaction_hash?: string;
    finalization_submitted_at_ms?: number;
    input_claim_transaction_hash?: string;
    input_claim_submitted_at_ms?: number;
    output_claim_transaction_hash?: string;
    output_claim_submitted_at_ms?: number;
  };
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
  prepareResidualRecovery: (orderId: string) => Promise<ResidualRecoveryPreparation>;
  submitResidualRecovery: (orderId: string) => Promise<ResidualRecoverySubmission>;
  freezeResidualRecoveryCapacity: (orderId: string) => Promise<{ transaction_hash: string | null; already_final: boolean }>;
  finalizeResidualRecovery: (orderId: string) => Promise<ResidualRecoveryFinalization>;
  claimResidualRecovery: (orderId: string) => Promise<ResidualRecoveryClaim>;
};

const WALLET_WASM_MODULE_URL = "/wallet/zylith_wallet_wasm.js";
const VAULT_KEY = "zylith.wallet.vault.v1";
const STATE_PREFIX = "zylith.wallet.state.v2:";
const PRIVACY_REGISTRY_PREFIX = "zylith.wallet.starknet-privacy-registry.v1:";
const WALLET_VAULT_REQUEST_TIMEOUT_MS = 10_000;
/** active-work refresh cadence; idle wallets emit no synthetic private traffic. */
const REFRESH_CADENCE_MS = 10_000;
const REFRESH_JITTER_MS = 1_000;
const RECOVERY_SNAPSHOT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_ORDER_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUNDING_NOTES = 4;
const PENDING_DEPOSIT_FAILURE_GRACE_MS = 10 * 60 * 1000;
const CONFIRMED_DEPOSIT_REGISTRATION_GRACE_MS = 10 * 60 * 1000;
const RECOVERY_TRANSACTION_MISSING_GRACE_MS = 10 * 60 * 1000;
const DEPOSIT_CONFIRMATION_STALE_MS = 2 * 60 * 1000;
const DEFAULT_MIN_PROVING_DELAY_BLOCKS = 10;
/** an unknown order older than this is resolved from its funding nullifiers. */
const UNKNOWN_ORDER_GRACE_MS = 2 * 60 * 1000;

export function recoveryTransactionDisposition(
  status: TransactionReceiptStatus | null,
  submittedAtMs: number,
  nowMs: number,
  missingGraceMs: number,
): "confirmed" | "pending" | "retry" {
  if (status?.failed) return "retry";
  if (status?.confirmed) return "confirmed";
  if (status?.notFound && nowMs - submittedAtMs >= missingGraceMs) return "retry";
  return "pending";
}
const NULLIFIER_UNUSED = 0n;
const NULLIFIER_EXIT_PENDING = 2n;
const NULLIFIER_EXITED = 3n;
const OUTPUT_KIND_PROCEEDS = 1;
const CAPACITY_OPEN = 1;
const CAPACITY_FILLED = 2;
const CAPACITY_FROZEN = 4;
const OPEN_STATES = new Set<WalletOrder["state"]>(["submitting", "pending", "live", "cancelling"]);

function isResidualNote(value: unknown): value is ResidualNote {
  if (!value || typeof value !== "object") return false;
  const note = value as Record<string, unknown>;
  const owner = note.owner as Record<string, unknown> | undefined;
  const felt = (field: unknown) => typeof field === "string" && /^0x[0-9a-f]+$/i.test(field);
  const amount = (field: unknown) => typeof field === "string" && /^\d+$/.test(field);
  const integer = (field: unknown) => typeof field === "number" && Number.isSafeInteger(field) && field >= 0;
  return felt(note.chain_context)
    && felt(note.input_asset_id)
    && felt(note.pair_id)
    && typeof note.sell === "boolean"
    && typeof note.external === "boolean"
    && amount(note.remaining)
    && amount(note.limit)
    && amount(note.funding)
    && amount(note.reserved)
    && amount(note.reserved_offset)
    && integer(note.reserved_seq)
    && integer(note.expiry_ms)
    && felt(note.order_id)
    && integer(note.generation)
    && felt(note.blinding)
    && Boolean(owner)
    && felt(owner?.owner_public_key)
    && felt(owner?.spend_authority)
    && felt(owner?.withdraw_authority)
    && felt(owner?.cancel_authority)
    && felt(owner?.nonce);
}

function requireStoredResidual(value: unknown): StoredResidual {
  if (!value || typeof value !== "object") throw new Error("The stored residual authority is malformed.");
  const residual = value as Record<string, unknown>;
  if (
    typeof residual.seq !== "number"
    || !Number.isSafeInteger(residual.seq)
    || residual.seq < 0
    || typeof residual.index !== "number"
    || !Number.isSafeInteger(residual.index)
    || residual.index < 0
    || !isResidualNote(residual.note)
    || ((residual.note_root === undefined) !== (residual.membership === undefined))
    || (residual.note_root !== undefined
      && (typeof residual.note_root !== "string" || !/^0x[0-9a-f]+$/i.test(residual.note_root)))
  ) {
    throw new Error("The stored residual authority is malformed.");
  }
  return residual as StoredResidual;
}

/** decodes the cairo storage view and rejects truncation before recovery state is trusted. */
export function parsePendingResidualExit(fields: string[]): PendingResidualExitView {
  if (fields.length !== 13) {
    throw new Error("The deployed residual exit has an unexpected layout.");
  }
  const requestedAtMs = Number(BigInt(fields[11]));
  const maturesAt = Number(BigInt(fields[12]));
  if (!Number.isSafeInteger(requestedAtMs) || !Number.isSafeInteger(maturesAt)) {
    throw new Error("The deployed residual exit timestamp is out of range.");
  }
  return {
    input_asset_id: fields[0],
    input_amount: BigInt(fields[1]).toString(),
    input_exit_commitment: fields[2],
    output_asset_id: fields[4],
    output_amount: BigInt(fields[5]).toString(),
    output_exit_commitment: fields[6],
    fee_amount: BigInt(fields[8]).toString(),
    requested_at_ms: requestedAtMs,
    matures_at: maturesAt,
  };
}

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
    if (hasPendingWork()) kick();
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
        if (!workerRunning || sessionGeneration !== generation || timer !== null || !hasPendingWork()) return;
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

  function hasPendingWork() {
    return followedOrders().length > 0
      || followedExits().length > 0
      || state.notes.some((note) => note.deposit && !note.deposit.failed && !note.deposit.confirmed)
      || state.notes.some((note) => note.exit?.stage === "claiming");
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
        requested_at_unix_ms: note.exit?.requested_at_ms,
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
    const feeTokenAddress = fundingRailTokenAddress(
      manifest,
      manifest.market_registry.gas_fee_asset_id,
    );
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
        feeTokenAddress,
        connectedWalletFeeReserveAmount: BigInt(
          manifest.market_registry.connected_wallet_fee_reserve_amount,
        ),
        discoveryUrl: serviceUrl(rail.discoveryUrl, "/starknet-privacy-discovery"),
        provingUrl: serviceUrl(rail.provingUrl, "/starknet-privacy-prover"),
        provingOhttpPolicy: rail.provingOhttpPolicy,
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

  async function recoveryTransactionState(transactionHash: string, submittedAtMs: number) {
    return recoveryTransactionDisposition(
      await receipt(transactionHash),
      submittedAtMs,
      Date.now(),
      RECOVERY_TRANSACTION_MISSING_GRACE_MS,
    );
  }

  // orders

  function pairConfig(pair: string): PairConfig {
    const config = enabledPairs(unlocked().deployment).find((market) => market.pair_id === pair);
    if (!config) throw new Error(`${pair} is not traded`);
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
    order.state = removal === "Cancelled" || removal === "Recovered" ? "cancelled" : removal === "Expired" ? "expired" : "filled";
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

  /** one fixed-size sealed status request while private work is active. multiple chunks rotate
   * across refreshes; an idle wallet does not send an empty synthetic request. */
  async function fetchStatus(): Promise<StatusAnswer | null> {
    const orders = followedOrders();
    const exits = followedExits();
    if (orders.length === 0 && exits.length === 0) return null;
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

  async function readRecoveryCapacity(note: ResidualNote): Promise<RecoveryCapacityView> {
    const { deployment: manifest } = unlocked();
    const fields = await starknetCall(manifest.rpc_url, manifest.contracts.exchange, "capacity", [
      String(note.reserved_seq),
      note.pair_id,
      note.sell ? "0x1" : "0x0",
    ]);
    if (fields.length !== 9) throw new Error("The deployed recovery capacity has an unexpected layout.");
    const generation = Number(BigInt(fields[8]));
    const status = Number(BigInt(fields[7]));
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(status)) {
      throw new Error("The deployed recovery capacity is out of range.");
    }
    return {
      generation,
      status,
      total: BigInt(fields[1]).toString(),
      scale: BigInt(fields[2]).toString(),
      opened_at: BigInt(fields[3]),
      consumed_base: BigInt(fields[4]).toString(),
      pool_quote: BigInt(fields[5]).toString(),
    };
  }

  /** builds the exact public recovery statement from chain-indexed data only. */
  async function prepareResidualRecovery(orderId: string): Promise<ResidualRecoveryPreparation> {
    const { seedHex: seed, deployment: manifest } = unlocked();
    const order = orderById(orderId);
    if (!order?.residual) throw new Error("This order has no recoverable residual state.");

    const residual = requireStoredResidual(order.residual);
    const pairFields = await starknetCall(
      manifest.rpc_url,
      manifest.contracts.exchange,
      "pair_config",
      [residual.note.pair_id],
    );
    const configuredPair = pairConfig(order.pair);
    const [baseAsset, quoteAsset, feeBpsValue] = pairFields;
    const marketIds = call<{ pair_id: string; base_asset_id: string; quote_asset_id: string }>(core.zylith_wallet_market_ids, {
      pair: configuredPair.pair_id,
      base_asset: configuredPair.base_asset_id,
      quote_asset: configuredPair.quote_asset_id,
    });
    if (
      normalizeFeltForComparison(baseAsset ?? "0") !== normalizeFeltForComparison(marketIds.base_asset_id)
      || normalizeFeltForComparison(quoteAsset ?? "0") !== normalizeFeltForComparison(marketIds.quote_asset_id)
      || normalizeFeltForComparison(residual.note.pair_id) !== normalizeFeltForComparison(marketIds.pair_id)
      || normalizeFeltForComparison(residual.note.input_asset_id) !== normalizeFeltForComparison(
        residual.note.sell ? marketIds.base_asset_id : marketIds.quote_asset_id,
      )
    ) {
      throw new Error("The deployed pair configuration does not match this wallet's manifest.");
    }
    const feeBps = BigInt(feeBpsValue ?? "0");
    if (feeBps < 0n || feeBps > 100n || feeBps !== BigInt(configuredPair.taker_fee_bps)) {
      throw new Error("The deployed recovery fee does not match this wallet's manifest.");
    }

    let membership: { note_root: string; membership: unknown };
    if (residual.note_root && residual.membership !== undefined) {
      membership = { note_root: residual.note_root, membership: residual.membership };
    } else {
      // legacy local state can reconstruct the same public material from any chain indexer.
      const [windowStart, windowEnd] = transitionWindows(residual.seq, residual.seq)[0];
      const [transitionList, batchRoots] = await Promise.all([
        exchange().transitions(windowStart, windowEnd),
        exchange().allNoteBatchRoots(),
      ]);
      const transition = transitionList.transitions.find((entry) => entry.seq === residual.seq);
      if (!transition) throw new Error("The public chain index is missing the residual transition.");
      if (transition.note_batch_index >= batchRoots.length) {
        throw new Error("The public chain index is missing the residual note batch.");
      }
      membership = call(core.zylith_wallet_build_note_membership, {
        batch_roots: batchRoots,
        batch_index: transition.note_batch_index,
        batch_leaves: transition.outputs.map((record) => record.leaf),
        leaf_index: residual.index,
      });
      residual.note_root = membership.note_root;
      residual.membership = membership.membership;
      await saveState();
      await pushRecoverySnapshot(true).catch(() => false);
    }
    let capacity = { generation: 0, status: 0, total: "0", consumed_base: "0", pool_quote: "0", scale: "0" };
    if (BigInt(residual.note.reserved) !== 0n) {
      const view = await readRecoveryCapacity(residual.note);
      if (view.status !== CAPACITY_FILLED && view.status !== CAPACITY_FROZEN) {
        throw new ResidualCapacityFreezeRequiredError();
      }
      capacity = {
        generation: view.generation,
        status: view.status,
        total: view.total,
        scale: view.scale,
        consumed_base: view.consumed_base,
        pool_quote: view.pool_quote,
      };
    }
    const outputAssetId = residual.note.sell ? quoteAsset : baseAsset;
    const prepared = order.residual_recovery?.residual_seq === residual.seq
      ? order.residual_recovery
      : undefined;
    const built = call<{
      public: {
        nullifier: string;
        commitment: string;
        input_asset_id: string;
        input_amount: string;
        output_asset_id: string;
        output_amount: string;
        fee_amount: string;
      };
      witness: string[];
      calldata: string[];
      input_exit_commitment?: string | null;
      output_exit_commitment?: string | null;
    }>(core.zylith_wallet_build_residual_recovery, {
      seed_hex: seed,
      note_root: membership.note_root,
      note: residual.note,
      membership: membership.membership,
      output_asset_id: outputAssetId,
      fee_bps: feeBps.toString(),
      capacity,
      input_exit_commitment: prepared?.input_exit_commitment ?? undefined,
      output_exit_commitment: prepared?.output_exit_commitment ?? undefined,
    });
    order.residual_recovery = {
      ...(prepared ?? {}),
      residual_seq: residual.seq,
      nullifier: built.public.nullifier,
      statement_commitment: built.public.commitment,
      input_asset_id: built.public.input_asset_id,
      input_amount: built.public.input_amount,
      output_asset_id: built.public.output_asset_id,
      output_amount: built.public.output_amount,
      fee_amount: built.public.fee_amount,
      input_exit_commitment: built.input_exit_commitment ?? null,
      output_exit_commitment: built.output_exit_commitment ?? null,
    };
    order.residual_capacity_freeze = undefined;
    order.updated_at_ms = Date.now();
    await saveState();
    await pushRecoverySnapshot(true).catch(() => false);
    return {
      order_id: order.order_id,
      residual_seq: residual.seq,
      note_root: membership.note_root,
      nullifier: built.public.nullifier,
      statement_commitment: built.public.commitment,
      input_asset_id: built.public.input_asset_id,
      input_amount: built.public.input_amount,
      output_asset_id: built.public.output_asset_id,
      output_amount: built.public.output_amount,
      fee_amount: built.public.fee_amount,
      witness: built.witness,
      recovery_calldata: built.calldata,
      proof_program_call: {
        contract_address: manifest.proof.residual_recovery_proof_program_address,
        entrypoint: "compile_residual_recovery_proof",
        calldata: [manifest.contracts.exchange, String(built.witness.length), ...built.witness],
      },
      settlement_call: {
        contract_address: manifest.contracts.exchange,
        entrypoint: "request_residual_recovery",
        calldata: built.calldata,
      },
      input_exit_commitment: built.input_exit_commitment ?? null,
      output_exit_commitment: built.output_exit_commitment ?? null,
    };
  }

  async function pendingResidualExit(nullifier: string) {
    const { deployment: manifest } = unlocked();
    return parsePendingResidualExit(
      await starknetCall(
        manifest.rpc_url,
        manifest.contracts.exchange,
        "pending_residual_exit",
        [nullifier],
      ),
    );
  }

  function assertPendingResidualMatches(
    prepared: NonNullable<StoredOrder["residual_recovery"]>,
    pending: PendingResidualExitView,
  ) {
    const feltMatches = (actual: string, expected: string | null) =>
      normalizeFeltForComparison(actual) === normalizeFeltForComparison(expected ?? "0x0");
    if (
      !feltMatches(pending.input_asset_id, prepared.input_asset_id)
      || !feltMatches(pending.output_asset_id, prepared.output_asset_id)
      || !feltMatches(pending.input_exit_commitment, prepared.input_exit_commitment)
      || !feltMatches(pending.output_exit_commitment, prepared.output_exit_commitment)
      || pending.input_amount !== prepared.input_amount
      || pending.output_amount !== prepared.output_amount
      || pending.fee_amount !== prepared.fee_amount
    ) {
      throw new Error("The on-chain residual exit does not match the prepared recovery.");
    }
  }

  /** proves and requests the exact prepared residual exit without operator cooperation. */
  async function submitResidualRecovery(orderId: string): Promise<ResidualRecoverySubmission> {
    const { seedHex: seed, deployment: manifest } = unlocked();
    const prepared = await prepareResidualRecovery(orderId);
    const order = orderById(orderId);
    if (!order?.residual_recovery) throw new Error("The residual recovery was not persisted.");
    const persisted = order.residual_recovery;
    const current = await nullifierState(prepared.nullifier);
    if (current === NULLIFIER_EXIT_PENDING || current === NULLIFIER_EXITED) {
      const pending = await pendingResidualExit(prepared.nullifier);
      assertPendingResidualMatches(persisted, pending);
      persisted.matures_at = pending.matures_at;
      await saveState();
      return {
        nullifier: prepared.nullifier,
        transaction_hash: persisted.request_transaction_hash ?? null,
        already_requested: true,
      };
    }
    if (current !== NULLIFIER_UNUSED) {
      throw new Error("This residual authority was already consumed by a fill or cancellation.");
    }
    if (persisted.request_transaction_hash) {
      const disposition = await recoveryTransactionState(
        persisted.request_transaction_hash,
        persisted.request_submitted_at_ms ?? order.updated_at_ms,
      );
      if (disposition !== "retry") {
        return {
          nullifier: prepared.nullifier,
          transaction_hash: persisted.request_transaction_hash,
          already_requested: false,
        };
      }
      persisted.request_transaction_hash = undefined;
      persisted.request_submitted_at_ms = undefined;
      await saveState();
    }
    const rail = selectedDepositFundingRail(manifest);
    const provider = await selectInjectedStarknetProvider();
    const { submitResidualRecovery: submit } = await import("./integrations/starknetPrivacyFunding");
    const result = await submit({
      provider: provider as never,
      sponsorAddress: connectedProviderAddress(provider) ?? undefined,
      seedHex: seed,
      chainId: requiredNonZeroFelt(manifest.chain_id, "chain_id"),
      rpcUrl: requiredString(manifest.rpc_url, "rpc_url"),
      provingUrl: serviceUrl(rail.provingUrl, "/starknet-privacy-prover"),
      provingOhttpPolicy: rail.provingOhttpPolicy,
      paymasterAddress: requiredNonZeroFelt(rail.paymasterAddress, "privacy_paymaster_address"),
      paymasterUrl: requiredString(rail.paymasterUrl, "privacy_paymaster_url"),
      privacyProofSignerClassHash: requiredNonZeroFelt(
        rail.privacyProofSignerClassHash,
        "privacy_proof_signer_class_hash",
      ),
      minProvingDelayBlocks: rail.minProvingDelayBlocks ?? DEFAULT_MIN_PROVING_DELAY_BLOCKS,
      proofProgramCall: {
        contractAddress: prepared.proof_program_call.contract_address,
        entrypoint: prepared.proof_program_call.entrypoint,
        calldata: prepared.proof_program_call.calldata,
      },
      settlementCall: {
        contractAddress: prepared.settlement_call.contract_address,
        entrypoint: prepared.settlement_call.entrypoint,
        calldata: prepared.settlement_call.calldata,
      },
    });
    persisted.request_transaction_hash = result.transactionHash;
    persisted.request_submitted_at_ms = Date.now();
    order.updated_at_ms = persisted.request_submitted_at_ms;
    await saveState();
    await pushRecoverySnapshot(true).catch(() => false);
    return {
      nullifier: prepared.nullifier,
      transaction_hash: result.transactionHash,
      already_requested: false,
    };
  }

  /** finalizes a mature residual exit; any caller may submit this ordinary transaction. */
  async function finalizeResidualRecovery(orderId: string): Promise<ResidualRecoveryFinalization> {
    const { deployment: manifest } = unlocked();
    const order = orderById(orderId);
    const prepared = order?.residual_recovery;
    if (!order || !prepared) throw new Error("Prepare and request this residual recovery first.");
    const current = await nullifierState(prepared.nullifier);
    const pending = await pendingResidualExit(prepared.nullifier);
    assertPendingResidualMatches(prepared, pending);
    prepared.matures_at = pending.matures_at;
    if (current === NULLIFIER_EXITED) {
      await saveState();
      return {
        nullifier: prepared.nullifier,
        transaction_hash: prepared.finalization_transaction_hash ?? null,
        already_final: true,
        matures_at: pending.matures_at,
      };
    }
    if (current !== NULLIFIER_EXIT_PENDING) {
      throw new Error("The residual recovery is not pending or it lost a race to settlement.");
    }
    if (Math.floor(Date.now() / 1000) < pending.matures_at) {
      throw new Error(`The residual recovery matures at Unix time ${pending.matures_at}.`);
    }
    if (prepared.finalization_transaction_hash) {
      const disposition = await recoveryTransactionState(
        prepared.finalization_transaction_hash,
        prepared.finalization_submitted_at_ms ?? order.updated_at_ms,
      );
      if (disposition !== "retry") {
        return {
          nullifier: prepared.nullifier,
          transaction_hash: prepared.finalization_transaction_hash,
          already_final: disposition === "confirmed",
          matures_at: pending.matures_at,
        };
      }
      prepared.finalization_transaction_hash = undefined;
      prepared.finalization_submitted_at_ms = undefined;
      await saveState();
    }
    const provider = await selectInjectedStarknetProvider();
    const result = await executeStarknetWalletCall(provider, {
      contractAddress: manifest.contracts.exchange,
      entrypoint: "finalize_residual_recovery",
      calldata: [prepared.nullifier],
    });
    prepared.finalization_transaction_hash = transactionHash(result) ?? undefined;
    prepared.finalization_submitted_at_ms = Date.now();
    order.updated_at_ms = prepared.finalization_submitted_at_ms;
    await saveState();
    await pushRecoverySnapshot(true).catch(() => false);
    return {
      nullifier: prepared.nullifier,
      transaction_hash: prepared.finalization_transaction_hash ?? null,
      already_final: false,
      matures_at: pending.matures_at,
    };
  }

  /** claims the user-owned legs staged by a finalized residual recovery. */
  async function claimResidualRecovery(orderId: string): Promise<ResidualRecoveryClaim> {
    const { seedHex: seed, deployment: manifest } = unlocked();
    const order = orderById(orderId);
    const prepared = order?.residual_recovery;
    if (!order || !prepared) throw new Error("This order has no prepared residual recovery.");
    if ((await nullifierState(prepared.nullifier)) !== NULLIFIER_EXITED) {
      throw new Error("Finalize the residual recovery before claiming its assets.");
    }
    const pending = await pendingResidualExit(prepared.nullifier);
    assertPendingResidualMatches(prepared, pending);
    const rail = selectedDepositFundingRail(manifest);
    const privacyPoolAddress = requiredNonZeroFelt(rail.privacyPool, "privacy_pool_address");
    const bridgeAddress = requiredNonZeroFelt(rail.bridgeAdapter, "privacy_deposit_bridge_address");
    const chainId = requiredNonZeroFelt(manifest.chain_id, "chain_id");
    const outputAsset = order.side === "Sell" ? order.quote_asset : order.base_asset;
    const { submitPrivacyOpenNoteWithdrawal } = await import("./integrations/starknetPrivacyFunding");

    const claim = async (
      asset: string,
      assetId: string,
      amount: string,
      exitCommitment: string | null,
    ) => {
      if (BigInt(amount) === 0n) return null;
      if (!exitCommitment) throw new Error("A nonzero residual leg is missing its exit authority.");
      const tokenAddress = fundingRailTokenAddress(manifest, asset);
      const result = await submitPrivacyOpenNoteWithdrawal({
        seedHex: seed,
        chainId,
        rpcUrl: requiredString(manifest.rpc_url, "rpc_url"),
        privacyPoolAddress,
        bridgeAddress,
        tokenAddress,
        discoveryUrl: serviceUrl(rail.discoveryUrl, "/starknet-privacy-discovery"),
        provingUrl: serviceUrl(rail.provingUrl, "/starknet-privacy-prover"),
        provingOhttpPolicy: rail.provingOhttpPolicy,
        paymasterAddress: requiredNonZeroFelt(rail.paymasterAddress, "privacy_paymaster_address"),
        paymasterUrl: requiredString(rail.paymasterUrl, "privacy_paymaster_url"),
        privacyProofSignerClassHash: rail.privacyProofSignerClassHash,
        minProvingDelayBlocks: rail.minProvingDelayBlocks ?? DEFAULT_MIN_PROVING_DELAY_BLOCKS,
        sdkRegistry: await loadPrivacyRegistry(),
        exitCommitment,
        signExitClaim: (openNoteId) =>
          call(core.zylith_wallet_sign_strk20_exit_claim, {
            seed_hex: seed,
            chain_id: chainId,
            bridge_address: bridgeAddress,
            privacy_pool_address: privacyPoolAddress,
            exchange_address: chainContext(),
            asset_id: assetId,
            token_address: tokenAddress,
            amount,
            exit_commitment: exitCommitment,
            open_note_id: openNoteId,
          }),
      });
      await savePrivacyRegistry(result.sdkRegistry);
      return result.transactionHash;
    };

    if (prepared.input_claim_transaction_hash) {
      const disposition = await recoveryTransactionState(
        prepared.input_claim_transaction_hash,
        prepared.input_claim_submitted_at_ms ?? order.updated_at_ms,
      );
      if (disposition === "retry") {
        prepared.input_claim_transaction_hash = undefined;
        prepared.input_claim_submitted_at_ms = undefined;
      }
    }
    if (!prepared.input_claim_transaction_hash) {
      prepared.input_claim_transaction_hash =
        (await claim(order.funding_asset, prepared.input_asset_id, prepared.input_amount, prepared.input_exit_commitment))
        ?? undefined;
      prepared.input_claim_submitted_at_ms = prepared.input_claim_transaction_hash ? Date.now() : undefined;
      order.updated_at_ms = prepared.input_claim_submitted_at_ms ?? Date.now();
      await saveState();
    }
    if (prepared.output_claim_transaction_hash) {
      const disposition = await recoveryTransactionState(
        prepared.output_claim_transaction_hash,
        prepared.output_claim_submitted_at_ms ?? order.updated_at_ms,
      );
      if (disposition === "retry") {
        prepared.output_claim_transaction_hash = undefined;
        prepared.output_claim_submitted_at_ms = undefined;
      }
    }
    if (!prepared.output_claim_transaction_hash) {
      prepared.output_claim_transaction_hash =
        (await claim(outputAsset, prepared.output_asset_id, prepared.output_amount, prepared.output_exit_commitment))
        ?? undefined;
      prepared.output_claim_submitted_at_ms = prepared.output_claim_transaction_hash ? Date.now() : undefined;
      order.updated_at_ms = prepared.output_claim_submitted_at_ms ?? Date.now();
      await saveState();
    }
    order.updated_at_ms = Date.now();
    await pushRecoverySnapshot(true).catch(() => false);
    return {
      input_transaction_hash: prepared.input_claim_transaction_hash ?? null,
      output_transaction_hash: prepared.output_claim_transaction_hash ?? null,
    };
  }

  /** establishes the permissionless on-chain cutoff for an expired external reservation. */
  async function freezeResidualRecoveryCapacity(orderId: string) {
    const { deployment: manifest } = unlocked();
    const order = orderById(orderId);
    const residual = order?.residual ? requireStoredResidual(order.residual) : undefined;
    if (!order || !residual || BigInt(residual.note.reserved) === 0n) {
      throw new Error("This order has no external capacity to freeze.");
    }
    const capacity = await readRecoveryCapacity(residual.note);
    if (capacity.status === CAPACITY_FILLED || capacity.status === CAPACITY_FROZEN) {
      return { transaction_hash: null, already_final: true };
    }
    if (capacity.status !== CAPACITY_OPEN) throw new Error("The external capacity is no longer open.");
    const expiresAt = capacity.opened_at + BigInt(manifest.runtime.external_window_seconds);
    if (BigInt(Math.floor(Date.now() / 1000)) < expiresAt) {
      throw new Error("The external capacity has not expired yet.");
    }
    const pendingFreeze = order.residual_capacity_freeze?.residual_seq === residual.seq
      ? order.residual_capacity_freeze
      : undefined;
    if (pendingFreeze) {
      const disposition = await recoveryTransactionState(
        pendingFreeze.transaction_hash,
        pendingFreeze.submitted_at_ms,
      );
      if (disposition !== "retry") {
        return {
          transaction_hash: pendingFreeze.transaction_hash,
          already_final: false,
        };
      }
      order.residual_capacity_freeze = undefined;
      await saveState();
    }
    const provider = await selectInjectedStarknetProvider();
    const result = await executeStarknetWalletCall(provider, {
      contractAddress: manifest.contracts.exchange,
      entrypoint: "freeze_expired_capacity",
      calldata: [
        String(residual.note.reserved_seq),
        residual.note.pair_id,
        residual.note.sell ? "0x1" : "0x0",
        String(capacity.generation),
      ],
    });
    const hash = transactionHash(result);
    if (!hash) throw new Error("The wallet did not return a capacity-freeze transaction hash.");
    order.residual_capacity_freeze = {
      residual_seq: residual.seq,
      transaction_hash: hash,
      submitted_at_ms: Date.now(),
    };
    order.updated_at_ms = order.residual_capacity_freeze.submitted_at_ms;
    await saveState();
    await pushRecoverySnapshot(true).catch(() => false);
    return {
      transaction_hash: hash,
      already_final: false,
    };
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
    let batchRoots: Promise<string[]> | undefined;
    const recoveryBatchRoots = () => {
      batchRoots ??= exchange().allNoteBatchRoots();
      return batchRoots;
    };
    for (const order of scanning) {
      const relevant = transitions.filter((transition) => transition.seq > Math.max(order.scan_after_seq, state.scanned_seq) && transition.seq <= (order.closed_seq ?? Infinity));
      if (relevant.length === 0) continue;
      changed = (await recoverOutputs(order, relevant, recoveryBatchRoots)) || changed;
    }
    state.scanned_seq = Math.max(state.scanned_seq, latestSeq);
    return changed || transitions.length > 0;
  }

  async function recoverOutputs(
    order: StoredOrder,
    transitions: TransitionOutputs[],
    recoveryBatchRoots: () => Promise<string[]>,
  ) {
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
    const recoveredResiduals = call<unknown>(core.zylith_wallet_recover_order_residuals, {
      chain_context: chainContext(),
      terms: order.terms,
      base_asset: order.base_asset,
      quote_asset: order.quote_asset,
      transitions: transitions.map((transition) => ({ seq: transition.seq, outputs: transition.outputs as OutputRecord[] })),
    });
    if (!Array.isArray(recoveredResiduals)) throw new Error("The wallet returned malformed residual authorities.");
    const residuals = recoveredResiduals.map(requireStoredResidual);
    const latestResidual = residuals.at(-1);
    if (latestResidual && (!order.residual || latestResidual.seq > order.residual.seq)) {
      const transition = transitions.find((entry) => entry.seq === latestResidual.seq);
      if (!transition) throw new Error("The public chain index omitted the residual transition.");
      const batchRoots = await recoveryBatchRoots();
      if (transition.note_batch_index >= batchRoots.length) {
        throw new Error("The public chain index omitted the residual note batch.");
      }
      const membership = call<{ note_root: string; membership: unknown }>(
        core.zylith_wallet_build_note_membership,
        {
          batch_roots: batchRoots,
          batch_index: transition.note_batch_index,
          batch_leaves: transition.outputs.map((record) => record.leaf),
          leaf_index: latestResidual.index,
        },
      );
      order.residual = {
        ...latestResidual,
        note_root: membership.note_root,
        membership: membership.membership,
      };
      if (order.residual_recovery?.residual_seq !== latestResidual.seq) {
        order.residual_recovery = undefined;
      }
      if (order.residual_capacity_freeze?.residual_seq !== latestResidual.seq) {
        order.residual_capacity_freeze = undefined;
      }
      order.updated_at_ms = Date.now();
      changed = true;
    }
    if (order.closed_seq !== undefined && order.residual) {
      order.residual = undefined;
      changed = true;
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
      provingOhttpPolicy: rail.provingOhttpPolicy,
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
    getOrders: () => state.orders.map((order) => ({
      ...order,
      residual_recovery_available: Boolean(order.residual),
    })),
    withdrawalAvailable,
    submitDepositViaWallet,
    submitOrder,
    cancelOrder,
    prepareResidualRecovery,
    submitResidualRecovery,
    freezeResidualRecoveryCapacity,
    finalizeResidualRecovery,
    claimResidualRecovery,
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
    const orderId = normalizeFeltForComparison(order.order_id);
    const index = local.orders.findIndex(
      (candidate) => normalizeFeltForComparison(candidate.order_id) === orderId,
    );
    if (index === -1) local.orders.push(order);
    else {
      const merged = mergeOrderState(local.orders[index], order);
      if (merged === local.orders[index]) continue;
      local.orders[index] = merged;
    }
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

function mergeOrderState(local: StoredOrder, remote: StoredOrder): StoredOrder {
  const progress = (order: StoredOrder) => Math.max(
    order.scan_after_seq,
    order.closed_seq ?? 0,
    order.residual?.seq ?? 0,
    ...order.seen_seqs,
  );
  const stateRank: Record<StoredOrder["state"], number> = {
    submitting: 0,
    pending: 1,
    live: 2,
    cancelling: 3,
    failed: 4,
    cancelled: 4,
    expired: 4,
    filled: 4,
  };
  const localProgress = progress(local);
  const remoteProgress = progress(remote);
  const remoteIsAhead = remoteProgress > localProgress
    || (remoteProgress === localProgress && stateRank[remote.state] > stateRank[local.state])
    || (remoteProgress === localProgress
      && stateRank[remote.state] === stateRank[local.state]
      && remote.updated_at_ms > local.updated_at_ms);
  const primary = remoteIsAhead ? remote : local;
  const secondary = remoteIsAhead ? local : remote;
  const seenSeqs = [...new Set([...local.seen_seqs, ...remote.seen_seqs])].sort((left, right) => left - right);
  const decimalMax = (left: string, right: string) => (BigInt(left) >= BigInt(right) ? left : right);
  const decimalMin = (left: string, right: string) => (BigInt(left) <= BigInt(right) ? left : right);
  const residual = !primary.closed_seq
    ? [local.residual, remote.residual]
      .filter((value): value is StoredResidual => Boolean(value))
      .sort((left, right) => right.seq - left.seq)[0]
    : undefined;
  const residualRecovery = mergeResidualRecovery(
    local.residual_recovery,
    remote.residual_recovery,
    residual?.seq,
  );
  const residualCapacityFreeze = mergeResidualCapacityFreeze(
    local.residual_capacity_freeze,
    remote.residual_capacity_freeze,
    residual?.seq,
  );
  const merged: StoredOrder = {
    ...primary,
    seen_seqs: seenSeqs,
    scan_after_seq: Math.min(local.scan_after_seq, remote.scan_after_seq),
    filled_base: decimalMax(local.filled_base, remote.filled_base),
    filled_quote: decimalMax(local.filled_quote, remote.filled_quote),
    fees: decimalMax(local.fees, remote.fees),
    locked_input: decimalMin(local.locked_input, remote.locked_input),
    cancel_requested: local.cancel_requested || remote.cancel_requested || undefined,
    closed_seq: Math.max(local.closed_seq ?? 0, remote.closed_seq ?? 0) || undefined,
    residual,
    residual_capacity_freeze: residualCapacityFreeze,
    residual_recovery: residualRecovery,
    updated_at_ms: Math.max(local.updated_at_ms, remote.updated_at_ms),
  };
  if (merged.closed_seq !== undefined) {
    merged.residual = undefined;
    merged.residual_capacity_freeze = undefined;
    merged.residual_recovery = undefined;
    merged.locked_input = "0";
  } else if (!remoteIsAhead && secondary.last_error && !merged.last_error) {
    merged.last_error = secondary.last_error;
  }
  const unchanged = JSON.stringify(merged) === JSON.stringify(local);
  return unchanged ? local : merged;
}

function mergeResidualCapacityFreeze(
  local: StoredOrder["residual_capacity_freeze"],
  remote: StoredOrder["residual_capacity_freeze"],
  residualSeq: number | undefined,
) {
  if (residualSeq === undefined) return undefined;
  const candidates = [local, remote].filter(
    (value): value is NonNullable<StoredOrder["residual_capacity_freeze"]> =>
      value?.residual_seq === residualSeq,
  );
  return candidates.sort((left, right) => right.submitted_at_ms - left.submitted_at_ms)[0];
}

function mergeResidualRecovery(
  local: StoredOrder["residual_recovery"],
  remote: StoredOrder["residual_recovery"],
  residualSeq: number | undefined,
) {
  const eligible = [local, remote].filter(
    (value): value is NonNullable<StoredOrder["residual_recovery"]> =>
      Boolean(value && value.residual_seq === residualSeq),
  );
  if (eligible.length < 2) return eligible[0];
  const [left, right] = eligible;
  if (
    normalizeFeltForComparison(left.nullifier) !== normalizeFeltForComparison(right.nullifier)
    || left.input_exit_commitment !== right.input_exit_commitment
    || left.output_exit_commitment !== right.output_exit_commitment
  ) {
    const evidence = (value: NonNullable<StoredOrder["residual_recovery"]>) => [
      value.request_transaction_hash,
      value.finalization_transaction_hash,
      value.input_claim_transaction_hash,
      value.output_claim_transaction_hash,
    ].filter(Boolean).length + (value.matures_at === undefined ? 0 : 1);
    return evidence(right) > evidence(left) ? right : left;
  }
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value !== undefined && merged[key as keyof typeof merged] === undefined) {
      Object.assign(merged, { [key]: value });
    }
  }
  return merged;
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

function transactionHash(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["transaction_hash", "transactionHash", "hash"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key];
  }
  return null;
}
