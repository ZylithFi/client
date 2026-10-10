// the browser wallet: a seed sealed under the starknet wallet's signature, the notes it owns,
// the persistent orders they fund and the withdrawals that take them back out.
//
// every note the wallet holds is rebuilt from chain data: deposits from the commitment
// registry, fills and refunds from the transition records the exchange verified. the operator
// only says where to look and how an order is doing.

import type {
  ExchangeStatus,
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
import { ExchangeHttpError, ExchangeRejectedError, readSdkResponseText, transitionWindows } from "@zylith/sdk";
import {
  connectedStarknetAddress,
  notifyWalletRuntimeChanged,
  selectedStarknetProvider,
  setWalletRuntime,
} from "./domain/browserWallet";
import { fromAtomicStr } from "./domain/assets";
import {
  BACKUP_URL,
  type DeploymentConfig,
  type PairConfig,
  deploymentManifestIdentity,
  deploymentForExecutionKey,
  enabledPairs,
  exchange,
  loadDeployment,
} from "./domain/deployment";
import {
  markDepositRecordConfirmed,
  markDepositRecordFailed,
  pendingDepositFailureReason,
} from "./domain/depositConfirmationState";
import { STARKNET_FIELD_PRIME, normalizeFeltForComparison, normalizeStrictFelt, requiredNonZeroFelt, requiredString } from "./domain/felt";
import {
  fundingRailTokenAddress,
  selectedDepositFundingRail,
  selectedResidualRecoveryFundingRail,
  strk20WithdrawalEnabledForDeployment,
} from "./domain/fundingRail";
import { setPrivacyFundingStage } from "./domain/privacyFundingStage";
import { RuntimeHttpStatusError, fetchJson, fetchWithTimeout, postJson } from "./domain/runtimeHttp";
import { browserSafeServiceUrl, normalizeUrl } from "./domain/serviceUrls";
import type { PendingDeposit, WalletBalance } from "./domain/shieldedBalances";
import { padRecoverySnapshotPayload } from "./domain/sizeClassPadding";
import { orderQuoteValue } from "./domain/tradeIntent";
import {
  failureText,
  markOperationSubmissionNotStarted,
  markOperationSubmissionRejected,
  markOperationSubmissionStarted,
  normalizeFailure,
} from "./domain/userFacingErrors";
import {
  WALLET_DEVICE_SESSION_DEFAULT_TTL_MS,
  createWalletDeviceRecordStore,
  type WalletDeviceRecordStore,
} from "./domain/walletDeviceSession";
import {
  type VaultRecord,
  type WalletSignatureMessageVersion,
  type WalletSignatureVaultContext,
  type WalletSignatureVaultRecord,
  requireLocalStoreCompatibility,
  isWalletSignatureVaultRecord,
  stableJsonStringify,
} from "./domain/walletLocalCrypto";
import {
  WalletCryptoClient,
  WalletCryptoError,
  createWalletCryptoClient,
  type SignatureVaultPreparation,
  type WalletCryptoClientOptions,
} from "./domain/walletCryptoClient";
import {
  createWalletSignatureVaultStore,
  type WalletSignatureVaultStore,
} from "./domain/walletSignatureVaultStore";
import type { WalletWorkerContext } from "./workers/walletCryptoProtocol";
import { WALLET_KEY_SCHEDULE_VERSION, WalletMigrationRequiredError, parseWalletJson, requireWalletKeyScheduleVersion } from "./domain/walletVersion";
import { proofSubmissionStarted } from "./integrations/starknetPrivacyErrors";
import {
  type TransactionReceiptStatus,
  buildZylithWalletAuthTypedData,
  connectedProviderAddress,
  executeStarknetWalletCall,
  fetchTransactionReceiptStatus,
  readStarknetWalletChainId,
  requestStarknetWalletTypedSignature,
  selectInjectedStarknetProvider,
  starknetCall,
  validateWalletChainMatch,
  walletAuthDeploymentId,
} from "./wallet/starknetProvider";

export { validateWalletChainMatch } from "./wallet/starknetProvider";

type WalletWasmModule = {
  default?: () => Promise<unknown>;
  zylith_wallet_market_ids: (inputJson: string) => string;
  zylith_wallet_registry_fingerprint: (registryJson: string) => string;
  zylith_wallet_transition_output_root: (inputJson: string) => string;
  zylith_wallet_recover_order_outputs: (inputJson: string) => string;
  zylith_wallet_recover_order_residuals: (inputJson: string) => string;
  zylith_wallet_quote_residual_recovery: (inputJson: string) => string;
  zylith_wallet_build_note_membership: (inputJson: string) => string;
  zylith_wallet_note_summary: (noteJson: string) => string;
};

export interface WalletCryptoPort {
  unlockFromDeviceSession(context: WalletWorkerContext): Promise<unknown>;
  revokeDeviceSession(context: WalletWorkerContext): Promise<void>;
  deriveSignatureVaultCredentials(signature: unknown, context: WalletWorkerContext): Promise<{ walletAuthId: string; authToken: string }>;
  prepareSignatureVaultCreate(signature: unknown, context: WalletWorkerContext, rememberDevice?: boolean, deviceTtlMs?: number): Promise<SignatureVaultPreparation>;
  prepareSignatureVaultOpen(signature: unknown, vaultRaw: string, context: WalletWorkerContext, rememberDevice?: boolean, deviceTtlMs?: number): Promise<SignatureVaultPreparation>;
  commitSignatureVault(preparation: SignatureVaultPreparation): Promise<unknown>;
  abortSignatureVault(preparation: SignatureVaultPreparation): Promise<void>;
  finalizeSignatureVault(preparation: SignatureVaultPreparation, rememberDevice?: boolean): Promise<{ remembered: boolean }>;
  publicConfig(): Promise<string>;
  recoveryAuthTag(): Promise<string>;
  deriveProofSigner(inputJson: string): Promise<string>;
  encryptLocalState(inputJson: string): Promise<string>;
  decryptLocalState(inputJson: string): Promise<string>;
  buildDepositSubmissionPlan(inputJson: string): Promise<string>;
  buildOrderRequest(inputJson: string): Promise<string>;
  buildCancelRequest(inputJson: string): Promise<string>;
  buildStatusRequests(inputJson: string): Promise<string>;
  buildWithdrawRequest(inputJson: string): Promise<string>;
  buildResidualRecovery(inputJson: string): Promise<string>;
  createRecoverySnapshot(inputJson: string): Promise<string>;
  decryptRecoveryArtifact(inputJson: string): Promise<string>;
  signStrk20ExitClaim(inputJson: string): Promise<string>;
  lock(): Promise<void>;
  dispose(): void;
}

export interface ZylithWalletRuntimeOptions {
  walletCryptoClientFactory?: (options: Pick<WalletCryptoClientOptions, "deviceRecordStore" | "onInvalidated">) => WalletCryptoPort;
  deviceRecordStore?: WalletDeviceRecordStore;
  signatureVaultStore?: WalletSignatureVaultStore;
  now?: () => number;
}

/** a sealed request and the per-request root from which each answer key is derived. */
type SealedBuild = { sealed: SealedRequest; response_key: string };

const HPKE_PROFILE = "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20Poly1305/base" as const;
const X25519_FIELD_PRIME = `ed${"ff".repeat(30)}7f`;
const X25519_LOW_ORDER_KEYS = new Set([
  `01${"00".repeat(31)}`,
  `ec${"ff".repeat(30)}7f`,
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
]);
type ExecutionKeyRegistry = {
  keys: Array<{ key_id: string; algorithm: typeof HPKE_PROFILE; public_key: string }>;
};

export type WalletPublicConfig = {
  key_schedule_version: 2;
  account_id: string;
  spend_authority: string;
  owner_tag: string;
  withdraw_authority: string;
};

export function requireWalletPublicConfig(value: unknown): WalletPublicConfig {
  requireWalletKeyScheduleVersion(value);
  if (Object.keys(value).length !== 5
    || Object.keys(value).some((key) => !["key_schedule_version", "account_id", "spend_authority", "owner_tag", "withdraw_authority"].includes(key))
    || typeof value.account_id !== "string" || !/^[0-9a-f]{64}$/.test(value.account_id)
    || ![value.spend_authority, value.owner_tag, value.withdraw_authority].every(isNonZeroFelt)) {
    throw new WalletMigrationRequiredError();
  }
  return value as WalletPublicConfig;
}

/** a note as the exchange commits to it. */
type NoteFields = {
  asset_id: string;
  amount: string;
  owner_public_key: string;
  spend_authority: string;
  withdraw_authority: string;
  blinding: string;
  nonce: string;
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
    public_transaction_confirmed?: boolean;
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
    claim_submitted_at_ms?: number;
    claim_attempts?: number;
    claim_retry_at_ms?: number;
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
  /** true only when chain-authenticated output recovery or unused funding proves closure. */
  closed_seq_authenticated?: true;
  /** private operator hint retained only to label a later chain-authenticated closure. */
  reported_removal?: NonNullable<OrderEvent["report"]["removal"]>;
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

export type WalletState = {
  version: 2;
  key_schedule_version: 2;
  notes: WalletNote[];
  orders: StoredOrder[];
  /** the last transition whose outputs were scanned. */
  scanned_seq: number;
};

type RecoveryArtifact = {
  key_schedule_version: 2;
  artifact_id: string;
  account_id: string;
  kind: "Snapshot" | "WalletEvent";
  sequence: number;
  created_at_unix_ms: number;
  payload: { key_schedule_version: 2; algorithm: string; nonce: string; ciphertext: string };
};

function isRecoveryArtifact(value: unknown): value is RecoveryArtifact {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  return value.key_schedule_version === WALLET_KEY_SCHEDULE_VERSION
    && value.payload.key_schedule_version === WALLET_KEY_SCHEDULE_VERSION
    && Object.keys(value).every((key) => ["key_schedule_version", "artifact_id", "account_id", "kind", "sequence", "created_at_unix_ms", "payload"].includes(key))
    && Object.keys(value.payload).every((key) => ["key_schedule_version", "algorithm", "nonce", "ciphertext"].includes(key))
    && typeof value.artifact_id === "string"
    && /^[0-9a-f]{64}$/i.test(value.artifact_id)
    && typeof value.account_id === "string"
    && /^[0-9a-f]{64}$/i.test(value.account_id)
    && (value.kind === "Snapshot" || value.kind === "WalletEvent")
    && isSafeNonNegativeInteger(value.sequence)
    && isSafeNonNegativeInteger(value.created_at_unix_ms)
    && value.payload.algorithm === "aes-256-gcm/recovery-v1"
    && typeof value.payload.nonce === "string"
    && /^[0-9a-f]{24}$/i.test(value.payload.nonce)
    && typeof value.payload.ciphertext === "string"
    && value.payload.ciphertext.length >= 32
    && value.payload.ciphertext.length <= 1_048_576
    && value.payload.ciphertext.length % 2 === 0
    && /^[0-9a-f]+$/i.test(value.payload.ciphertext);
}

export function requireRecoveryArtifactHistory(value: unknown, accountId: string): RecoveryArtifact[] {
  if (!isRecord(value) || !Array.isArray(value.artifacts) || value.artifacts.length > 64) {
    throw new Error("The recovery service returned a malformed snapshot list.");
  }
  for (const artifact of value.artifacts) {
    requireWalletKeyScheduleVersion(artifact);
    requireWalletKeyScheduleVersion(artifact.payload);
  }
  const snapshots = value.artifacts
    .filter((artifact) => isRecoveryArtifact(artifact) && artifact.kind === "Snapshot" && artifact.account_id === accountId)
    .sort((left, right) => left.sequence - right.sequence);
  if (value.artifacts.length !== snapshots.length) {
    throw new Error("The recovery service returned a malformed snapshot.");
  }
  const artifactIds = new Set<string>();
  for (const [index, snapshot] of snapshots.entries()) {
    if (
      artifactIds.has(snapshot.artifact_id)
      || (index > 0 && snapshot.sequence <= snapshots[index - 1].sequence)
    ) {
      throw new RecoveryStateConflictError("The recovery service returned duplicate or non-monotonic snapshots.");
    }
    artifactIds.add(snapshot.artifact_id);
  }
  return snapshots;
}

type WalletSignatureVaultBundle = { wallet_auth_id: string; vault: VaultRecord; updated_at_unix_ms?: number };

export function requireWalletSignatureVaultBundle(
  value: unknown,
  expectedWalletAuthId: string,
): WalletSignatureVaultRecord {
  if (!isRecord(value)) {
    throw new Error("The wallet vault service returned a malformed response.");
  }
  requireWalletKeyScheduleVersion(value.vault);
  if (value.vault.version !== 3) throw new WalletMigrationRequiredError();
  const allowed = new Set(["wallet_auth_id", "vault", "updated_at_unix_ms"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || value.wallet_auth_id !== expectedWalletAuthId
    || !isWalletSignatureVaultRecord(value.vault)
    || (value.updated_at_unix_ms !== undefined && !isSafeNonNegativeInteger(value.updated_at_unix_ms))
  ) {
    throw new Error("The wallet vault service returned a malformed response.");
  }
  return value.vault;
}

class RecoveryStateConflictError extends Error {
  constructor(cause: unknown) {
    super("The encrypted recovery snapshot conflicts with this wallet's local state.", { cause });
    this.name = "RecoveryStateConflictError";
  }
}

class WalletSessionChangedError extends Error {
  constructor() {
    super("Wallet session changed. Retry.");
    this.name = "WalletSessionChangedError";
  }
}

class ExitClaimAuthorizationError extends Error {
  constructor() {
    super("Private withdrawal authorization failed. Retry.");
    this.name = "ExitClaimAuthorizationError";
  }
}

export function recoverySnapshotStateForScope(payload: unknown, targetScope: string): WalletState | null {
  requireWalletKeyScheduleVersion(payload);
  requireWalletKeyScheduleVersion(payload.state);
  if (payload.version !== 2 || !isRecord(payload.state) || payload.state.version !== 2) throw new WalletMigrationRequiredError();
  if (Object.keys(payload).some((key) => !["version", "key_schedule_version", "scope", "state", "padding"].includes(key))) throw new WalletMigrationRequiredError();
  if (
    !isRecord(payload)
    || payload.version !== 2
    || typeof payload.scope !== "string"
    || !("state" in payload)
  ) {
    throw new RecoveryStateConflictError(
      "The recovery service returned a malformed snapshot payload.",
    );
  }
  // recovery history is seed-scoped, while wallet state is deployment-scoped. a redeployment
  // therefore leaves valid older snapshots in the same authenticated history. they remain the
  // append-only history head but must never be merged into the current exchange's local state.
  if (payload.scope !== targetScope) return null;
  return requireWalletState(payload.state);
}

export type WalletRuntime = TraderWalletRuntime & {
  hasVault: (starknetAddress?: string | null) => boolean;
  vaultAuthMode: (starknetAddress?: string | null) => "none" | "device-session" | "wallet-signature";
  isReady: (starknetAddress?: string | null) => boolean;
  createWalletWithWalletSignature: (starknetAddress: string) => Promise<boolean>;
  unlockWithDeviceSession: (starknetAddress: string) => Promise<boolean>;
  unlockWithWalletSignature: (starknetAddress: string) => Promise<boolean>;
  getPublicConfig: () => WalletPublicConfig | null;
  lock: () => void;
  suspend: () => void;
  getPendingDeposits: () => PendingDeposit[];
  getWithdrawableNotes: () => WithdrawableNote[];
  withdrawalAvailable: () => boolean;
  submitDepositViaWallet: (asset: string, amountAtoms: string) => Promise<{ transaction_hash: string; note_commitment: string }>;
  withdraw: (noteCommitment: string) => Promise<{ nullifier: string }>;
  claimWithdrawal: (noteCommitment: string) => Promise<{ transaction_hash: string | null }>;
  prepareResidualRecovery: (orderId: string) => Promise<ResidualRecoveryPreparation>;
  submitResidualRecovery: (orderId: string) => Promise<ResidualRecoverySubmission>;
  freezeResidualRecoveryCapacity: (orderId: string) => Promise<{ transaction_hash: string | null; already_final: boolean }>;
  finalizeResidualRecovery: (orderId: string) => Promise<ResidualRecoveryFinalization>;
  claimResidualRecovery: (orderId: string) => Promise<ResidualRecoveryClaim>;
};

const WALLET_WASM_MODULE_URL = "/wallet/zylith_wallet_wasm.js";
const VAULT_KEY = "zylith.wallet.vault.v1";
const STATE_PREFIX = "zylith.wallet.state.v2:";
const STATE_QUARANTINE_PREFIX = "zylith.wallet.state-quarantine.v1:";
const WALLET_VAULT_REQUEST_TIMEOUT_MS = 10_000;
/** active-work refresh cadence; idle wallets emit no synthetic private traffic. */
const REFRESH_CADENCE_MS = 10_000;
const REFRESH_JITTER_MS = 1_000;
const RECOVERY_SNAPSHOT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_ORDER_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUNDING_NOTES = 4;
const DEPOSIT_CONFIRMATION_STALE_MS = 2 * 60 * 1000;
const DEFAULT_MIN_PROVING_DELAY_BLOCKS = 10;
const UNKNOWN_WITHDRAWAL_GRACE_MS = 2 * 60 * 1000;
const CLAIM_RETRY_BASE_MS = 30_000;
const CLAIM_RETRY_MAX_MS = 30 * 60 * 1000;
/** an unknown order older than this is resolved from its funding nullifiers. */
const UNKNOWN_ORDER_GRACE_MS = 2 * 60 * 1000;
const MAX_STORED_NOTES = 20_000;
const MAX_STORED_ORDERS = 20_000;
const MAX_TRANSITION_SCAN_SEQS = 64;
const MAX_TRANSITION_OUTPUTS = 4_096;

export function quarantineDamagedWalletState(
  storage: Pick<Storage, "getItem" | "setItem">,
  originalKey: string,
  quarantineKey: string,
  encryptedValue: string,
): void {
  if (storage.getItem(originalKey) !== encryptedValue) return;
  if (storage.getItem(quarantineKey) === null) {
    storage.setItem(quarantineKey, encryptedValue);
  }
}

export function claimRetryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(10, attempts - 1));
  return Math.min(CLAIM_RETRY_MAX_MS, CLAIM_RETRY_BASE_MS * (2 ** exponent));
}

export function createSerialOperationQueue() {
  let tail: Promise<void> = Promise.resolve();
  return function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.catch(() => undefined).then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function createExclusiveBooleanOperation() {
  let active: { key: string; promise: Promise<boolean> } | null = null;
  return {
    run(key: string, operation: () => Promise<boolean>): Promise<boolean> {
      if (active?.key === key) return active.promise;
      if (active) {
        return Promise.reject(new Error("Another private-wallet authorization is already in progress."));
      }
      const promise = operation().finally(() => {
        if (active?.promise === promise) active = null;
      });
      active = { key, promise };
      return promise;
    },
    reset() {
      active = null;
    },
  };
}

function claimRetryState(
  exit: NonNullable<WalletNote["exit"]>,
  error: unknown,
  nowMs: number,
): NonNullable<WalletNote["exit"]> {
  const attempts = Math.min((exit.claim_attempts ?? 0) + 1, 10_000);
  return {
    ...exit,
    stage: "finalized",
    claim_attempts: attempts,
    claim_retry_at_ms: nowMs + claimRetryDelay(attempts),
    failure: failureText(normalizeFailure(error, {
      domain: "withdrawal",
      operation: "claim",
      stage: "withdrawal-claim",
      outcome: "failed",
    })).slice(0, 512),
  };
}

export function recoveryTransactionDisposition(
  status: TransactionReceiptStatus | null,
): "confirmed" | "pending" | "retry" {
  if (status?.failed) return "retry";
  if (status?.confirmed) return "confirmed";
  // A missing receipt is not an authoritative negative acknowledgement: the transaction can
  // still be queued, indexed late, or hidden behind an unavailable RPC. Only an on-chain failed
  // receipt proves that replacing the attempt is safe.
  return "pending";
}
const NULLIFIER_UNUSED = 0n;
const NULLIFIER_SPENT = 1n;
const NULLIFIER_EXIT_PENDING = 2n;
const NULLIFIER_EXITED = 3n;

export function fundingAdmissionDisposition(
  states: bigint[],
): "unused" | "spent" | "conflict" {
  if (states.length > 0 && states.every((value) => value === NULLIFIER_UNUSED)) return "unused";
  if (states.length > 0 && states.every((value) => value === NULLIFIER_SPENT)) return "spent";
  return "conflict";
}

const MAX_U64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const OUTPUT_KIND_PROCEEDS = 1;
const OUTPUT_KIND_REFUND = 2;
const CAPACITY_OPEN = 1;
const CAPACITY_FILLED = 2;
const CAPACITY_FROZEN = 4;
const OPEN_STATES = new Set<WalletOrder["state"]>(["submitting", "pending", "live", "cancelling"]);

export function authenticatedTerminalSequence(
  outputs: Array<{ seq: number }>,
  residuals: Array<{ seq: number }>,
) {
  const residualSequences = new Set(residuals.map((residual) => residual.seq));
  return outputs
    .map((output) => output.seq)
    .filter((seq) => !residualSequences.has(seq))
    .sort((left, right) => right - left)[0];
}

function hasActiveExit(note: WalletNote) {
  return Boolean(note.exit && note.exit.stage !== "failed");
}

function isResidualNote(value: unknown): value is ResidualNote {
  if (!value || typeof value !== "object") return false;
  const note = value as Record<string, unknown>;
  const owner = note.owner as Record<string, unknown> | undefined;
  const felt = (field: unknown) => isNonZeroFelt(field);
  const amount = (field: unknown) => isDecimal(field);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string"
    && /^(0|[1-9]\d{0,38})$/.test(value)
    && BigInt(value) <= ((1n << 128n) - 1n);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function assertSealedBuild(
  value: unknown,
  expectedKeyId?: string,
  operationFields: readonly string[] = [],
): asserts value is SealedBuild {
  if (!isRecord(value) || !isRecord(value.sealed)) {
    throw new Error("The wallet produced a malformed private request.");
  }
  const topLevelFields = new Set(["sealed", "response_key", ...operationFields]);
  const sealed = value.sealed;
  if (
    Object.keys(value).length !== topLevelFields.size
    || Object.keys(value).some((key) => !topLevelFields.has(key))
    || value.response_key === undefined
    || typeof value.response_key !== "string"
    || !/^[0-9a-f]{64}$/.test(value.response_key)
    || Object.keys(sealed).length !== 5
    || Object.keys(sealed).some((key) => !["version", "key_id", "digest", "encapsulated_key", "ciphertext"].includes(key))
    || sealed.version !== 3
    || typeof sealed.key_id !== "string"
    || !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(sealed.key_id)
    || (expectedKeyId !== undefined && sealed.key_id !== expectedKeyId)
    || typeof sealed.digest !== "string"
    || !/^[0-9a-f]{64}$/.test(sealed.digest)
    || typeof sealed.encapsulated_key !== "string"
    || !/^[0-9a-f]{64}$/.test(sealed.encapsulated_key)
    || !usableX25519PublicKey(sealed.encapsulated_key)
    || typeof sealed.ciphertext !== "string"
    || !/^[0-9a-f]{8224}$/.test(sealed.ciphertext)
  ) throw new Error("The wallet produced a malformed private request.");
}

function onchainInteger(value: unknown, maximum: bigint): bigint | null {
  const normalized = normalizeStrictFelt(value);
  if (!normalized) return null;
  const integer = BigInt(normalized);
  return integer <= maximum ? integer : null;
}

export function parseOnchainPairConfig(fields: string[]) {
  if (fields.length !== 9) {
    throw new Error("The deployed pair configuration has an unexpected layout.");
  }
  const [
    baseAsset,
    quoteAsset,
    priceBaseScaleValue,
    feeBpsValue,
    externalSupportValue,
    referenceMethodologyValue,
    derivationBaseMarketId,
    derivationQuoteMarketId,
    maxLegSkewValue,
  ] = fields;
  const priceBaseScale = onchainInteger(priceBaseScaleValue, MAX_U128);
  const feeBps = onchainInteger(feeBpsValue, MAX_U128);
  const externalSupport = onchainInteger(externalSupportValue, MAX_U128);
  const referenceMethodology = onchainInteger(referenceMethodologyValue, 1n);
  const maxLegSkew = onchainInteger(maxLegSkewValue, MAX_U64);
  if (
    !isNonZeroFelt(baseAsset)
    || !isNonZeroFelt(quoteAsset)
    || normalizeFeltForComparison(baseAsset) === normalizeFeltForComparison(quoteAsset)
    || priceBaseScale === null
    || priceBaseScale === 0n
    || feeBps === null
    || externalSupport === null
    || referenceMethodology === null
    || !normalizeStrictFelt(derivationBaseMarketId)
    || !normalizeStrictFelt(derivationQuoteMarketId)
    || maxLegSkew === null
  ) throw new Error("The deployed pair configuration is malformed.");
  return {
    baseAsset,
    quoteAsset,
    priceBaseScale,
    feeBps,
    externalSupport,
    referenceMethodology,
    derivationBaseMarketId,
    derivationQuoteMarketId,
    maxLegSkew,
  };
}

function isNonZeroFelt(value: unknown): value is string {
  const normalized = normalizeStrictFelt(value);
  return Boolean(normalized) && normalized !== "0x0";
}

function isBoundedString(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

export function requireExchangeStatus(value: unknown, manifest: DeploymentConfig): ExchangeStatus {
  if (!isRecord(value)) throw new Error("The operator returned malformed exchange status.");
  const expectedPairs = enabledPairs(manifest).map((pair) => pair.pair_id).sort();
  const pairs = Array.isArray(value.pairs) && value.pairs.every((pair) => typeof pair === "string")
    ? [...value.pairs].sort()
    : null;
  if (
    normalizeStrictFelt(value.exchange) !== normalizeStrictFelt(manifest.contracts.exchange)
    || !isSafeNonNegativeInteger(value.seq)
    || !isSafeNonNegativeInteger(value.last_close_ms)
    || value.epoch_ms !== manifest.runtime.epoch_ms
    || !pairs
    || new Set(pairs).size !== pairs.length
    || stableJsonStringify(pairs) !== stableJsonStringify(expectedPairs)
    || value.registry_version !== manifest.market_registry.registry_version
    || value.registry_hash !== manifest.market_registry.registry_hash
  ) throw new Error("The operator exchange identity does not match this deployment.");
  return value as ExchangeStatus;
}

export function requireStatusAnswer(
  value: unknown,
  allowedOrderIds: Iterable<string>,
  allowedNullifiers: Iterable<string>,
): StatusAnswer {
  if (!isRecord(value) || !Array.isArray(value.orders) || !Array.isArray(value.withdrawals)) {
    throw new Error("The operator returned a malformed private status response.");
  }
  const allowedOrders = new Set([...allowedOrderIds].map(normalizeFeltForComparison));
  const allowedExits = new Set([...allowedNullifiers].map(normalizeFeltForComparison));
  if (value.orders.length > allowedOrders.size || value.withdrawals.length > allowedExits.size) {
    throw new Error("The operator returned excess private status records.");
  }
  const seenOrders = new Set<string>();
  for (const candidate of value.orders) {
    if (!isRecord(candidate)) throw new Error("The operator returned a malformed order status.");
    const orderId = normalizeStrictFelt(candidate.order_id);
    if (
      !orderId
      || !allowedOrders.has(orderId)
      || seenOrders.has(orderId)
      || !["pending", "live", "closed", "unknown"].includes(String(candidate.status))
      || typeof candidate.cancel_requested !== "boolean"
      || !Array.isArray(candidate.events)
      || candidate.events.length > 256
      || typeof candidate.more_events !== "boolean"
      || (candidate.closed_seq !== null && !isSafeNonNegativeInteger(candidate.closed_seq))
      || ![null, "Completed", "Cancelled", "Expired", "Recovered"].includes(candidate.removal as never)
    ) throw new Error("The operator returned a malformed order status.");
    seenOrders.add(orderId);
    for (const event of candidate.events) {
      if (!isRecord(event) || !isRecord(event.report)) {
        throw new Error("The operator returned a malformed order event.");
      }
      const report = event.report;
      if (
        !isSafeNonNegativeInteger(event.seq)
        || !isSafeNonNegativeInteger(event.close_time_ms)
        || normalizeStrictFelt(report.order_id) !== orderId
        || typeof report.admitted !== "boolean"
        || !isDecimal(report.external_base)
        || !isDecimal(report.external_quote)
        || !isDecimal(report.fill_base)
        || !isDecimal(report.fill_quote)
        || !isDecimal(report.fee)
        || !isDecimal(report.proceeds)
        || !isDecimal(report.refund)
        || !isDecimal(report.reserved)
        || ![null, "Completed", "Cancelled", "Expired", "Recovered"].includes(report.removal as never)
      ) throw new Error("The operator returned a malformed order event.");
    }
  }
  const seenExits = new Set<string>();
  for (const candidate of value.withdrawals) {
    if (!isRecord(candidate)) throw new Error("The operator returned a malformed withdrawal status.");
    const nullifier = normalizeStrictFelt(candidate.nullifier);
    if (
      !nullifier
      || !allowedExits.has(nullifier)
      || seenExits.has(nullifier)
      || Object.prototype.hasOwnProperty.call(candidate, "updated_at_ms")
      || !validWithdrawalStage(candidate.stage)
    ) throw new Error("The operator returned a malformed withdrawal status.");
    seenExits.add(nullifier);
  }
  return value as StatusAnswer;
}

export function requireExecutionKeyRegistry(value: unknown): ExecutionKeyRegistry {
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || !Array.isArray(value.keys)
    || value.keys.length !== 1
  ) {
    throw new Error("The operator returned a malformed execution-key registry.");
  }
  const keys: ExecutionKeyRegistry["keys"] = value.keys.map((candidate) => {
    if (
      !isRecord(candidate)
      || Object.keys(candidate).length !== 3
      || Object.keys(candidate).some((key) => !["key_id", "algorithm", "public_key"].includes(key))
      || typeof candidate.key_id !== "string"
      || !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(candidate.key_id)
      || candidate.algorithm !== HPKE_PROFILE
      || typeof candidate.public_key !== "string"
      || !/^[0-9a-f]{64}$/.test(candidate.public_key)
      || !usableX25519PublicKey(candidate.public_key)
    ) throw new Error("The operator returned a malformed execution-key registry.");
    return {
      key_id: candidate.key_id,
      algorithm: HPKE_PROFILE,
      public_key: candidate.public_key,
    };
  });
  return { keys };
}

function usableX25519PublicKey(publicKey: string) {
  if (publicKey === "00".repeat(32) || X25519_LOW_ORDER_KEYS.has(publicKey)) return false;
  const bytes = publicKey.match(/../g);
  const prime = X25519_FIELD_PRIME.match(/../g);
  if (!bytes || !prime || (Number.parseInt(bytes[31], 16) & 0x80) !== 0) return false;
  for (let index = 31; index >= 0; index -= 1) {
    const byte = Number.parseInt(bytes[index], 16);
    const primeByte = Number.parseInt(prime[index], 16);
    if (byte !== primeByte) return byte < primeByte;
  }
  return false;
}

export function requireIndexerStatus(value: unknown) {
  if (
    !isRecord(value)
    || value.service !== "zylith-indexer"
    || !isBoundedString(value.deposits_bucket, 32)
    || !isSafeNonNegativeInteger(value.latest_seq)
    || !isSafeNonNegativeInteger(value.last_successful_sync_unix_ms)
    || value.last_successful_sync_unix_ms === 0
    || !isSafeNonNegativeInteger(value.sync_lag_ms)
  ) throw new Error("The chain indexer returned malformed or unready status.");
  return value as unknown as {
    latest_seq: number;
    last_successful_sync_unix_ms: number;
    sync_lag_ms: number;
  };
}

function requireTransitionRange(value: unknown, start: number, end: number): TransitionOutputs[] {
  if (
    !isRecord(value)
    || value.start !== start
    || value.end !== end
    || !isSafeNonNegativeInteger(value.latest_seq)
    || !Array.isArray(value.transitions)
    || value.transitions.length > end - start + 1
  ) throw new Error("The chain indexer returned a malformed transition range.");
  const seen = new Set<number>();
  const transitions = value.transitions.map((candidate) => {
    if (
      !isRecord(candidate)
      || !isSafeNonNegativeInteger(candidate.seq)
      || candidate.seq < start
      || candidate.seq > end
      || seen.has(candidate.seq)
      || !isSafeNonNegativeInteger(candidate.block_number)
      || !isNonZeroFelt(candidate.transaction_hash)
      || !isNonZeroFelt(candidate.new_book_root)
      || !isNonZeroFelt(candidate.note_root)
      || !isNonZeroFelt(candidate.output_root)
      || !isSafeNonNegativeInteger(candidate.note_batch_index)
      || !Array.isArray(candidate.outputs)
      || candidate.outputs.length > MAX_TRANSITION_OUTPUTS
    ) throw new Error("The chain indexer returned a malformed transition.");
    seen.add(candidate.seq);
    for (const output of candidate.outputs) {
      if (!isRecord(output) || ![output.leaf, output.enc, output.enc_remaining, output.enc_reserved, output.enc_reserved_offset].every((field) => Boolean(normalizeStrictFelt(field)))) {
        throw new Error("The chain indexer returned a malformed transition output.");
      }
    }
    return candidate as unknown as TransitionOutputs;
  });
  if (transitions.some((transition) => transition.seq > Number(value.latest_seq))) {
    throw new Error("The chain indexer returned an inconsistent latest sequence.");
  }
  return transitions;
}

function validWithdrawalStage(value: unknown): boolean {
  if (value === null || value === "Proving") return true;
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  if (isRecord(value.Requested)) {
    return isNonZeroFelt(value.Requested.transaction_hash)
      && isSafeNonNegativeInteger(value.Requested.matures_at_ms);
  }
  if (isRecord(value.Finalizing)) return isNonZeroFelt(value.Finalizing.transaction_hash);
  if (isRecord(value.Finalized)) return isNonZeroFelt(value.Finalized.transaction_hash);
  return isRecord(value.Failed) && isBoundedString(value.Failed.reason);
}

function isStoredNote(value: unknown): value is WalletNote {
  if (!isRecord(value) || !isRecord(value.fields)) return false;
  const fields = value.fields;
  const source = value.source;
  if (
    !isNonZeroFelt(value.commitment)
    || !isNonZeroFelt(value.nullifier)
    || typeof value.asset !== "string"
    || value.asset.length === 0
    || value.asset.length > 32
    || (source !== "deposit" && source !== "output")
    || !isDecimal(fields.amount)
    || BigInt(fields.amount) <= 0n
    || !isNonZeroFelt(fields.asset_id)
    || !isNonZeroFelt(fields.owner_public_key)
    || !isNonZeroFelt(fields.spend_authority)
    || !isNonZeroFelt(fields.withdraw_authority)
    || !isNonZeroFelt(fields.blinding)
    || !isDecimal(fields.nonce)
    || BigInt(fields.nonce) === 0n
    || BigInt(fields.nonce) > MAX_U64
    || !normalizeStrictFelt(fields.metadata_commitment)
    || (value.locked_by !== undefined && !isNonZeroFelt(value.locked_by))
    || (value.spent !== undefined && typeof value.spent !== "boolean")
  ) return false;
  if (value.deposit !== undefined) {
    if (
      !isRecord(value.deposit)
      || !isNonZeroFelt(value.deposit.funding_commitment)
      || !isBoundedString(value.deposit.request_id, 256)
      || value.deposit.request_id.length === 0
      || !isSafeNonNegativeInteger(value.deposit.requested_at_ms)
      || typeof value.deposit.confirmed !== "boolean"
      || (value.deposit.transaction_hash !== undefined && !isNonZeroFelt(value.deposit.transaction_hash))
      || (value.deposit.public_transaction_confirmed !== undefined
        && typeof value.deposit.public_transaction_confirmed !== "boolean")
      || (value.deposit.failed !== undefined && typeof value.deposit.failed !== "boolean")
      || (value.deposit.failure_reason !== undefined && !isBoundedString(value.deposit.failure_reason))
    ) return false;
  }
  if (value.exit !== undefined) {
    if (
      !isRecord(value.exit)
      || !isNonZeroFelt(value.exit.exit_commitment)
      || !["requested", "proving", "maturing", "finalized", "claiming", "failed"].includes(String(value.exit.stage))
      || !isSafeNonNegativeInteger(value.exit.requested_at_ms)
      || (value.exit.matures_at_ms !== undefined && !isSafeNonNegativeInteger(value.exit.matures_at_ms))
      || (value.exit.open_note_id !== undefined && !isNonZeroFelt(value.exit.open_note_id))
      || (value.exit.claim_transaction_hash !== undefined && !isNonZeroFelt(value.exit.claim_transaction_hash))
      || (value.exit.claim_submitted_at_ms !== undefined && !isSafeNonNegativeInteger(value.exit.claim_submitted_at_ms))
      || (value.exit.claim_attempts !== undefined && !isSafeNonNegativeInteger(value.exit.claim_attempts))
      || (value.exit.claim_retry_at_ms !== undefined && !isSafeNonNegativeInteger(value.exit.claim_retry_at_ms))
      || (value.exit.failure !== undefined && !isBoundedString(value.exit.failure))
    ) return false;
    if (
      value.exit.stage === "claiming"
      && !value.exit.claim_transaction_hash
      && value.exit.claim_submitted_at_ms === undefined
    ) return false;
  }
  if (value.output !== undefined && (
    !isRecord(value.output)
    || !isNonZeroFelt(value.output.order_id)
    || !isSafeNonNegativeInteger(value.output.seq)
    || !isSafeNonNegativeInteger(value.output.kind)
  )) return false;
  return true;
}

const STORED_ORDER_STATES = new Set([
  "submitting",
  "pending",
  "live",
  "cancelling",
  "failed",
  "cancelled",
  "expired",
  "filled",
]);

function isStoredOrder(value: unknown): value is StoredOrder {
  if (!isRecord(value)) return false;
  if (
    !isNonZeroFelt(value.order_id)
    || !isBoundedString(value.pair, 64)
    || value.pair.length === 0
    || (value.side !== "Buy" && value.side !== "Sell")
    || typeof value.external !== "boolean"
    || !isDecimal(value.amount)
    || BigInt(value.amount) <= 0n
    || !isDecimal(value.limit_price)
    || BigInt(value.limit_price) <= 0n
    || !isSafeNonNegativeInteger(value.expires_at_ms)
    || !isBoundedString(value.funding_asset, 32)
    || value.funding_asset.length === 0
    || !isDecimal(value.funding_amount)
    || BigInt(value.funding_amount) <= 0n
    || !STORED_ORDER_STATES.has(String(value.state))
    || !isDecimal(value.filled_base)
    || !isDecimal(value.filled_quote)
    || !isDecimal(value.fees)
    || !isSafeNonNegativeInteger(value.submitted_at_ms)
    || !isSafeNonNegativeInteger(value.updated_at_ms)
    || !Array.isArray(value.funding_notes)
    || value.funding_notes.length < 1
    || value.funding_notes.length > MAX_FUNDING_NOTES
    || value.funding_notes.some((entry) => !isNonZeroFelt(entry))
    || !Array.isArray(value.nullifiers)
    || value.nullifiers.length !== value.funding_notes.length
    || value.nullifiers.some((entry) => !isNonZeroFelt(entry))
    || !isBoundedString(value.base_asset, 32)
    || value.base_asset.length === 0
    || !isBoundedString(value.quote_asset, 32)
    || value.quote_asset.length === 0
    || value.base_asset === value.quote_asset
    || !isSafeNonNegativeInteger(value.scan_after_seq)
    || !Array.isArray(value.seen_seqs)
    || value.seen_seqs.some((entry) => !isSafeNonNegativeInteger(entry))
    || !isDecimal(value.locked_input)
  ) return false;
  const seenSeqs = value.seen_seqs as number[];
  if (
    BigInt(value.filled_base) > BigInt(value.amount)
    || BigInt(value.locked_input) > BigInt(value.funding_amount)
    || new Set(value.funding_notes.map(normalizeFeltForComparison)).size !== value.funding_notes.length
    || new Set(value.nullifiers.map(normalizeFeltForComparison)).size !== value.nullifiers.length
    || new Set(seenSeqs).size !== seenSeqs.length
    || seenSeqs.some((seq, index) => index > 0 && seq <= seenSeqs[index - 1])
    || (value.cancel_requested !== undefined && typeof value.cancel_requested !== "boolean")
    || (value.last_error !== undefined && !isBoundedString(value.last_error))
  ) return false;
  if (value.closed_seq !== undefined && !isSafeNonNegativeInteger(value.closed_seq)) return false;
  if (value.closed_seq_authenticated !== undefined && value.closed_seq_authenticated !== true) return false;
  if (value.closed_seq_authenticated === true && value.closed_seq === undefined) return false;
  if (value.reported_removal !== undefined && !["Completed", "Cancelled", "Expired", "Recovered"].includes(value.reported_removal as string)) return false;
  let residualSeq: number | undefined;
  if (value.residual !== undefined) {
    try {
      residualSeq = requireStoredResidual(value.residual).seq;
    } catch {
      return false;
    }
  }
  if (!validResidualCapacityFreeze(value.residual_capacity_freeze, residualSeq)) return false;
  if (!validResidualRecovery(value.residual_recovery, residualSeq)) return false;
  return true;
}

function validResidualCapacityFreeze(value: unknown, residualSeq: number | undefined): boolean {
  if (value === undefined) return true;
  return isRecord(value)
    && isSafeNonNegativeInteger(value.residual_seq)
    && value.residual_seq === residualSeq
    && isNonZeroFelt(value.transaction_hash)
    && isSafeNonNegativeInteger(value.submitted_at_ms);
}

function validResidualRecovery(value: unknown, residualSeq: number | undefined): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !isSafeNonNegativeInteger(value.residual_seq) || value.residual_seq !== residualSeq) return false;
  for (const field of ["nullifier", "statement_commitment", "input_asset_id", "output_asset_id"] as const) {
    if (!isNonZeroFelt(value[field])) return false;
  }
  for (const field of ["input_amount", "output_amount", "fee_amount"] as const) {
    if (!isDecimal(value[field])) return false;
  }
  for (const field of ["input_exit_commitment", "output_exit_commitment"] as const) {
    if (value[field] !== null && !isNonZeroFelt(value[field])) return false;
  }
  for (const field of [
    "request_transaction_hash",
    "finalization_transaction_hash",
    "input_claim_transaction_hash",
    "output_claim_transaction_hash",
  ] as const) {
    if (value[field] !== undefined && !isNonZeroFelt(value[field])) return false;
  }
  for (const field of [
    "request_submitted_at_ms",
    "matures_at",
    "finalization_submitted_at_ms",
    "input_claim_submitted_at_ms",
    "output_claim_submitted_at_ms",
  ] as const) {
    if (value[field] !== undefined && !isSafeNonNegativeInteger(value[field])) return false;
  }
  return true;
}

export function requireWalletState(value: unknown): WalletState {
  requireWalletKeyScheduleVersion(value);
  if (!isRecord(value) || value.version !== 2) {
    throw new WalletMigrationRequiredError();
  }
  if (Object.keys(value).some((key) => !["version", "key_schedule_version", "notes", "orders", "scanned_seq"].includes(key))) throw new WalletMigrationRequiredError();
  if (
    !Array.isArray(value.notes)
    || value.notes.length > MAX_STORED_NOTES
    || !value.notes.every(isStoredNote)
    || !Array.isArray(value.orders)
    || value.orders.length > MAX_STORED_ORDERS
    || !value.orders.every(isStoredOrder)
    || !isSafeNonNegativeInteger(value.scanned_seq)
  ) throw new Error("The stored wallet state is malformed.");
  const noteIds = new Set<string>();
  const noteNullifiers = new Set<string>();
  for (const note of value.notes) {
    const id = normalizeFeltForComparison(note.commitment);
    if (!id || noteIds.has(id)) throw new Error("The stored wallet state contains duplicate notes.");
    noteIds.add(id);
    const nullifier = normalizeFeltForComparison(note.nullifier);
    if (!nullifier || noteNullifiers.has(nullifier)) throw new Error("The stored wallet state contains duplicate note nullifiers.");
    noteNullifiers.add(nullifier);
  }
  const orderIds = new Set<string>();
  for (const order of value.orders) {
    const id = normalizeFeltForComparison(order.order_id);
    if (!id || orderIds.has(id)) throw new Error("The stored wallet state contains duplicate orders.");
    orderIds.add(id);
  }
  for (const note of value.notes) {
    if (!note.locked_by) continue;
    const order = value.orders.find((candidate) =>
      normalizeFeltForComparison(candidate.order_id) === normalizeFeltForComparison(note.locked_by),
    );
    if (!order || !OPEN_STATES.has(order.state) || !order.funding_notes.some((commitment) =>
      normalizeFeltForComparison(commitment) === normalizeFeltForComparison(note.commitment),
    )) throw new Error("The stored wallet state contains an invalid funding lock.");
  }
  const state = structuredClone(value) as WalletState;
  for (const order of state.orders) {
    if (order.closed_seq === undefined || order.closed_seq_authenticated === true) continue;
    state.scanned_seq = Math.min(state.scanned_seq, order.scan_after_seq);
    order.closed_seq = undefined;
    if (["filled", "cancelled", "expired"].includes(order.state)) {
      order.state = order.cancel_requested ? "cancelling" : "live";
    }
  }
  return state;
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
  const u128Indexes = [1, 5, 8];
  const feltIndexes = [0, 2, 3, 4, 6, 7, 9, 10];
  if (
    u128Indexes.some((index) => onchainInteger(fields[index], MAX_U128) === null)
    || feltIndexes.some((index) => !normalizeStrictFelt(fields[index]))
  ) throw new Error("The deployed residual exit contains an invalid field.");
  const requestedAtValue = onchainInteger(fields[11], MAX_U64);
  const maturesAtValue = onchainInteger(fields[12], MAX_U64);
  if (requestedAtValue === null || maturesAtValue === null) {
    throw new Error("The deployed residual exit timestamp is out of range.");
  }
  const requestedAtMs = Number(requestedAtValue);
  const maturesAt = Number(maturesAtValue);
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

export function parseClaimedOpenNoteId(fields: string[]): string | null {
  if (fields.length !== 1) {
    throw new Error("The deployed exit-claim state has an unexpected layout.");
  }
  const openNoteId = normalizeStrictFelt(fields[0]);
  if (!openNoteId) {
    throw new Error("The deployed exit-claim state has an unexpected layout.");
  }
  return openNoteId === "0x0" ? null : openNoteId;
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
    setWalletRuntime(null, failureText(normalizeFailure(error, {
      domain: "application",
      operation: "load",
      stage: "private-runtime-load",
      presentation: "inline",
    })));
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

const PROOF_SIGNER_SCALAR_ORDER = 0x800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;

function proofSignerContextFelt(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} must be a nonzero canonical Starknet felt.`);
  }
  const digits = value.replace(/^0x/, "").replace(/^0+/, "");
  if (!digits || digits.length > 64) {
    throw new Error(`${label} must be a nonzero canonical Starknet felt.`);
  }
  const parsed = BigInt(`0x${digits}`);
  if (parsed >= STARKNET_FIELD_PRIME) {
    throw new Error(`${label} must be a nonzero canonical Starknet felt.`);
  }
  return `0x${parsed.toString(16)}`;
}

export function parseWalletProofSignerMaterial(
  encoded: string,
): { proofSignerPrivateKey: string; proofSignerSalt: string } {
  try {
    const material = parseWalletJson(encoded);
    requireWalletKeyScheduleVersion(material);
    const canonicalNonzero = (value: unknown, limit: bigint): value is string =>
      typeof value === "string" && value.length <= 66 && /^0x[1-9a-f][0-9a-f]*$/.test(value) && BigInt(value) < limit;
    if (Object.keys(material).length !== 3
      || Object.keys(material).some((key) => !["key_schedule_version", "proof_signer_private_key", "proof_signer_salt"].includes(key))
      || !canonicalNonzero(material.proof_signer_private_key, PROOF_SIGNER_SCALAR_ORDER)
      || !canonicalNonzero(material.proof_signer_salt, STARKNET_FIELD_PRIME)) {
      throw new Error("invalid material");
    }
    return { proofSignerPrivateKey: material.proof_signer_private_key, proofSignerSalt: material.proof_signer_salt };
  } catch {
    throw new Error("Wallet returned invalid v2 proof signer material.");
  }
}

export function createZylithWalletRuntime(
  core: WalletWasmModule,
  options: ZylithWalletRuntimeOptions = {},
): WalletRuntime {
  const now = options.now ?? Date.now;
  const deviceRecordStore = options.deviceRecordStore ?? createWalletDeviceRecordStore(localStorage);
  const signatureVaultStore = options.signatureVaultStore ?? createWalletSignatureVaultStore(localStorage);
  const walletCryptoClientFactory = options.walletCryptoClientFactory
    ?? ((clientOptions) => createWalletCryptoClient(clientOptions));
  let sessionReady = false;
  let walletClient: WalletCryptoPort | null = null;
  let workerContext: WalletWorkerContext | null = null;
  let activeDeviceSession = false;
  let vaultRecordUnsubscribe: (() => void) | null = null;
  let publicConfig: WalletPublicConfig | null = null;
  let deployment: DeploymentConfig | null = null;
  let scope = "";
  let state: WalletState = emptyState();
  let activeWalletAddress: string | null = null;
  let generation = 0;
  let clearedSessionFailure: { generation: number; error: unknown } | null = null;
  let saveChain: Promise<void> = Promise.resolve();
  let snapshotSaveChain: Promise<boolean> = Promise.resolve(false);
  let timer: number | null = null;
  let workerRunning = false;
  let statusChunkCursor = 0;
  let refreshInFlight: Promise<void> | null = null;
  const vaultOperations = createExclusiveBooleanOperation();
  let lastSnapshotAt = 0;
  let snapshotDirty = false;
  let recoveryHeadArtifactId: string | null = null;
  let recoveryHeadSequence = 0;
  let stateRevision = 0;
  let stateWritesBlocked = false;
  let depositOperationInFlight = false;
  let orderSubmissionInFlight = false;
  const cancellationsInFlight = new Set<string>();
  const withdrawalsInFlight = new Set<string>();
  const residualOperationsInFlight = new Set<string>();
  const authenticatedAdmissions = new Set<string>();
  let registryCache: {
    keys: ExecutionKeyRegistry["keys"];
    loadedAt: number;
  } | null = null;
  let registryLoadInFlight: Promise<ExecutionKeyRegistry> | null = null;
  const claimsInFlight = new Set<string>();

  function call<T>(fn: (input: string) => string, input: unknown): T {
    return JSON.parse(fn(JSON.stringify(input))) as T;
  }

  function sessionContext() {
    if (!walletClient || !workerContext || !publicConfig || !deployment) {
      throw new Error("Wallet session is locked");
    }
    return { client: walletClient, workerContext, publicConfig, deployment };
  }

  function unlocked() {
    if (!sessionReady) throw new Error("Wallet session is locked");
    ensureCurrent(generation);
    return sessionContext();
  }

  function chainContext() {
    return requiredNonZeroFelt(unlocked().deployment.contracts.exchange, "exchange address");
  }

  // local state

  function readCompatibleLocalState(targetScope: string) {
    const raw = localStorage.getItem(`${STATE_PREFIX}${targetScope}`);
    if (raw !== null) requireLocalStoreCompatibility(raw);
    return raw;
  }

  function requireOwnedClient(sessionGeneration: number, client: WalletCryptoPort) {
    if (sessionGeneration !== generation || walletClient !== client) {
      throw new WalletSessionChangedError();
    }
  }

  function translateWalletCryptoError(error: unknown): unknown {
    return error instanceof WalletCryptoError && error.code === "MIGRATION_REQUIRED"
      ? new WalletMigrationRequiredError()
      : error;
  }

async function awaitOwnedClient<T>(
    sessionGeneration: number,
    client: WalletCryptoPort,
    operation: Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation;
      requireOwnedClient(sessionGeneration, client);
      return result;
    } catch (error) {
      requireOwnedClient(sessionGeneration, client);
      throw translateWalletCryptoError(error);
    }
  }

  async function awaitCurrent<T>(sessionGeneration: number, operation: Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await operation;
    } catch (error) {
      requireCurrentFailure(error, sessionGeneration);
      throw error;
    }
    ensureCurrent(sessionGeneration);
    return result;
  }

  type HydrationLocalStateOwnership = {
    readonly generation: number;
    readonly scope: string;
    expectedRaw: string | null;
  };

  function requireHydrationLocalStateOwnership(ownership: HydrationLocalStateOwnership) {
    ensureCurrent(ownership.generation);
    if (scope !== ownership.scope || readCompatibleLocalState(ownership.scope) !== ownership.expectedRaw) {
      throw new WalletSessionChangedError();
    }
  }

  async function loadState() {
    const { client } = sessionContext();
    const sessionGeneration = generation;
    const targetScope = scope;
    const key = `${STATE_PREFIX}${targetScope}`;
    stateWritesBlocked = false;
    state = emptyState();
    const raw = localStorage.getItem(key);
    const ownership: HydrationLocalStateOwnership = { generation: sessionGeneration, scope: targetScope, expectedRaw: raw };
    if (raw === null) return { corrupted: false, ownership };
    try {
      const decrypted = parseWalletJson(
        await awaitOwnedClient(sessionGeneration, client, client.decryptLocalState(raw)),
        ["version"],
      );
      ensureCurrent(sessionGeneration);
      if (scope !== targetScope) throw new Error("Wallet session changed. Retry.");
      requireHydrationLocalStateOwnership(ownership);
      state = requireWalletState(decrypted);
      return { corrupted: false, ownership };
    } catch (error) {
      ensureCurrent(sessionGeneration);
      requireHydrationLocalStateOwnership(ownership);
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      stateWritesBlocked = true;
      const quarantineKey = `${STATE_QUARANTINE_PREFIX}${targetScope}`;
      try {
        quarantineDamagedWalletState(localStorage, key, quarantineKey, raw);
      } catch {
        // the original encrypted value remains untouched when quarantine storage is unavailable.
      }
      state = emptyState();
      return { corrupted: true, ownership };
    }
  }

  async function saveState(ownership?: HydrationLocalStateOwnership) {
    if (!walletClient || !publicConfig) return;
    if (ownership) requireHydrationLocalStateOwnership(ownership);
    if (stateWritesBlocked) {
      throw new Error("The damaged local wallet state is quarantined and cannot be overwritten.");
    }
    const sessionGeneration = generation;
    const targetScope = scope;
    const client = walletClient;
    const snapshot = structuredClone(state);
    const save = saveChain.catch(() => undefined).then(() => preserveSessionOnMigration(sessionGeneration, async () => {
      requireWalletState(snapshot);
      const encryptedRaw = await awaitOwnedClient(
        sessionGeneration,
        client,
        client.encryptLocalState(JSON.stringify({ value: snapshot })),
      );
      const encrypted = parseWalletJson(encryptedRaw, ["version"]);
      ensureCurrent(sessionGeneration);
      requireSessionStorageCompatibility(sessionGeneration);
      if (scope !== targetScope) throw new Error("Wallet session changed. Retry.");
      if (ownership) requireHydrationLocalStateOwnership(ownership);
      const key = `${STATE_PREFIX}${targetScope}`;
      const nextRaw = JSON.stringify(encrypted);
      localStorage.setItem(key, nextRaw);
      if (ownership) ownership.expectedRaw = nextRaw;
      snapshotDirty = true;
      stateRevision += 1;
      notifyWalletRuntimeChanged();
    }));
    saveChain = save.catch(() => undefined);
    await save;
  }

  // session

  async function hydrate(
    client: WalletCryptoPort,
    context: WalletWorkerContext,
    nextDeployment: DeploymentConfig,
    sessionGeneration: number,
  ) {
    ensureCurrent(sessionGeneration);
    clearedSessionFailure = null;
    requireOwnedClient(sessionGeneration, client);
    const nextConfig = requireWalletPublicConfig(parseWalletJson(
      await awaitOwnedClient(sessionGeneration, client, client.publicConfig()),
    ));
    try {
      publicConfig = nextConfig;
      deployment = nextDeployment;
      activeWalletAddress = context.walletAddress;
      scope = `${nextConfig.account_id}:${normalizeFeltForComparison(nextDeployment.contracts.exchange)}`;
      const { corrupted: localStateCorrupted, ownership } = await loadState();
      requireHydrationLocalStateOwnership(ownership);
      const recovered = await pullRecoverySnapshot(ownership).catch((error: unknown) => {
        if (error instanceof RecoveryStateConflictError || error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
        return false;
      });
      requireHydrationLocalStateOwnership(ownership);
      if (localStateCorrupted && !recovered) {
        throw new Error("The encrypted local wallet state is damaged and no valid recovery snapshot was available.");
      }
      ensureCurrent(sessionGeneration);
      requireHydrationLocalStateOwnership(ownership);
      return true;
    } catch (error) {
      if (generation === sessionGeneration) clearSession(false, { generation: sessionGeneration, error });
      throw error;
    }
  }

  function ensureCurrent(sessionGeneration: number) {
    if (sessionGeneration !== generation) throw new WalletSessionChangedError();
    if (sessionReady) requireSessionStorageCompatibility(sessionGeneration);
  }

  function clearMigrationSession(error: unknown, sessionGeneration: number) {
    if (error instanceof WalletMigrationRequiredError && generation === sessionGeneration) {
      clearSession(false, { generation: sessionGeneration, error });
    }
  }

  function requireCurrentFailure(error: unknown, sessionGeneration: number) {
    // only the exact failure that cleared this session may cross its own cleanup boundary.
    if (sessionGeneration !== generation && (
      clearedSessionFailure?.generation !== sessionGeneration
      || clearedSessionFailure.error !== error
      || generation !== sessionGeneration + 1
      || walletClient !== null
    )) throw new WalletSessionChangedError();
  }

  function requireSessionStorageCompatibility(sessionGeneration: number) {
    if (sessionGeneration !== generation) throw new WalletSessionChangedError();
    try {
      if (activeWalletAddress) {
        requireNoLegacyDeviceRecord(activeWalletAddress);
        readVaultSnapshot(activeWalletAddress);
      }
      if (scope) readCompatibleLocalState(scope);
    } catch (error) {
      clearMigrationSession(error, sessionGeneration);
      throw error;
    }
  }

  async function preserveSessionOnMigration<T>(sessionGeneration: number, operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      ensureCurrent(sessionGeneration);
      return result;
    } catch (error) {
      requireCurrentFailure(error, sessionGeneration);
      clearMigrationSession(error, sessionGeneration);
      throw error;
    }
  }

  function guardSessionOperation<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
    return (...args: Args) => preserveSessionOnMigration(generation, () => operation(...args));
  }

  function bestEffortSnapshotFailure(error: unknown): false {
    if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
    return false;
  }

  function clearSession(
    revokeDeviceSession: boolean,
    failure?: { generation: number; error: unknown },
    clientAlreadyInvalidated = false,
  ) {
    clearedSessionFailure = failure ?? null;
    sessionReady = false;
    const detachedClient = walletClient;
    const detachedContext = workerContext;
    const revokeOwnedDevice = revokeDeviceSession && activeDeviceSession;
    walletClient = null;
    workerContext = null;
    activeDeviceSession = false;
    const unsubscribe = vaultRecordUnsubscribe;
    vaultRecordUnsubscribe = null;
    generation += 1;
    workerRunning = false;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    try { unsubscribe?.(); } catch { /* terminal cleanup remains best effort */ }
    refreshInFlight = null;
    saveChain = Promise.resolve();
    snapshotSaveChain = Promise.resolve(false);
    publicConfig = null;
    deployment = null;
    activeWalletAddress = null;
    scope = "";
    state = emptyState();
    registryCache = null;
    registryLoadInFlight = null;
    depositOperationInFlight = false;
    orderSubmissionInFlight = false;
    cancellationsInFlight.clear();
    withdrawalsInFlight.clear();
    residualOperationsInFlight.clear();
    authenticatedAdmissions.clear();
    claimsInFlight.clear();
    vaultOperations.reset();
    stateRevision = 0;
    lastSnapshotAt = 0;
    snapshotDirty = false;
    recoveryHeadArtifactId = null;
    recoveryHeadSequence = 0;
    statusChunkCursor = 0;
    notifyWalletRuntimeChanged();
    if (detachedClient && !clientAlreadyInvalidated) {
      if (revokeOwnedDevice && detachedContext) {
        void detachedClient.revokeDeviceSession(detachedContext).catch(() => {
          detachedClient.dispose();
        });
      } else {
        void detachedClient.lock().catch(() => {
          detachedClient.dispose();
        });
      }
    }
  }

  function lock() {
    clearSession(true);
  }

  function suspend() {
    clearSession(false);
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
    const regularDelay = REFRESH_CADENCE_MS - REFRESH_JITTER_MS + jitter;
    return regularDelay;
  }

  function hasPendingWork() {
    return followedOrders().length > 0
      || state.orders.some((order) => order.state !== "failed" && order.closed_seq_authenticated !== true)
      || followedExits().length > 0
      || state.notes.some((note) => note.deposit && !note.deposit.failed && !note.deposit.confirmed)
      || state.notes.some((note) => note.exit?.stage === "claiming");
  }

  // wallet-signature vault

  function requireNoLegacyDeviceRecord(starknetAddress: string) {
    const walletAddress = normalizeFeltForComparison(starknetAddress);
    try {
      if (
        localStorage.getItem(`zylith.wallet.device-session.v1:${walletAddress}`) !== null
        || localStorage.getItem(`zylith.wallet.device-session.v2:${walletAddress}`) !== null
      ) {
        throw new WalletMigrationRequiredError();
      }
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError) throw error;
      throw new WalletMigrationRequiredError();
    }
  }

  function readVaultSnapshot(starknetAddress: string) {
    requireNoLegacyDeviceRecord(starknetAddress);
    return signatureVaultStore.read(starknetAddress);
  }

  function hasVault(starknetAddress?: string | null) {
    if (!starknetAddress) return false;
    try {
      requireNoLegacyDeviceRecord(starknetAddress);
      return signatureVaultStore.readRaw(starknetAddress) !== null;
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError) throw error;
      // inaccessible storage must never look like permission to create a new seed.
      return true;
    }
  }

  async function vaultContext(
    starknetAddress: string,
    sessionGeneration: number,
    messageVersion: WalletSignatureMessageVersion = 2,
    deploymentId?: string,
  ): Promise<WalletSignatureVaultContext> {
    const provider = selectedStarknetProvider();
    if (!provider) throw new Error("Connect a Starknet wallet first");
    const walletAddress = normalizeFeltForComparison(starknetAddress);
    const connected = connectedStarknetAddress();
    if (connected && normalizeFeltForComparison(connected) !== walletAddress) {
      throw new Error("Connected Starknet wallet changed during private trading authorization");
    }
    const manifest = await awaitCurrent(sessionGeneration, loadDeployment());
    const connectedChainId = await awaitCurrent(
      sessionGeneration,
      readStarknetWalletChainId(provider as never),
    );
    ensureCurrent(sessionGeneration);
    validateWalletChainMatch(manifest.chain_id, connectedChainId, manifest.network);
    const chainId = requiredNonZeroFelt(manifest.chain_id, "chain_id");
    const resolvedDeploymentId = deploymentId
      ?? (await awaitCurrent(sessionGeneration, walletAuthDeploymentId(manifest, messageVersion)));
    const origin = window.location.origin;
    const typedData = await awaitCurrent(sessionGeneration, buildZylithWalletAuthTypedData({
      walletAddress,
      chainId,
      deploymentId: resolvedDeploymentId,
      origin,
      messageVersion,
    }));
    const signature = await awaitCurrent(
      sessionGeneration,
      requestStarknetWalletTypedSignature(provider as never, typedData),
    );
    const confirmedAddress = connectedProviderAddress(provider as never) ?? connectedStarknetAddress();
    if (
      !confirmedAddress
      || normalizeFeltForComparison(confirmedAddress) !== walletAddress
    ) {
      throw new Error("Connected Starknet wallet changed during private trading authorization");
    }
    const confirmedChainId = await awaitCurrent(
      sessionGeneration,
      readStarknetWalletChainId(provider as never),
    );
    if (normalizeFeltForComparison(confirmedChainId) !== normalizeFeltForComparison(chainId)) {
      throw new Error("Connected Starknet wallet chain changed during private trading authorization");
    }
    return {
      signature,
      walletAddress,
      chainId,
      deploymentId: resolvedDeploymentId,
      origin,
      messageVersion,
    };
  }

  async function workerContextFor(
    context: Pick<WalletSignatureVaultContext, "walletAddress" | "chainId" | "deploymentId" | "origin">,
    manifest: DeploymentConfig,
    sessionGeneration: number,
  ): Promise<WalletWorkerContext> {
    const manifestIdentity = await awaitCurrent(sessionGeneration, deploymentManifestIdentity(manifest));
    return {
      walletAddress: normalizeFeltForComparison(context.walletAddress),
      chainId: requiredNonZeroFelt(context.chainId, "chain_id"),
      deploymentId: requiredNonZeroFelt(manifest.contracts.exchange, "exchange address"),
      vaultDeploymentId: requiredNonZeroFelt(context.deploymentId, "vault deployment id"),
      origin: context.origin,
      manifestIdentity,
      manifestVersion: "1",
      expiresAtMs: now() + WALLET_DEVICE_SESSION_DEFAULT_TTL_MS,
    };
  }

  function createOwnedWalletClient(context: WalletWorkerContext, sessionGeneration: number) {
    let candidate: WalletCryptoPort | null = null;
    candidate = walletCryptoClientFactory({
      deviceRecordStore,
      onInvalidated: () => {
        if (generation === sessionGeneration && walletClient === candidate) {
          clearSession(false, undefined, true);
        }
      },
    });
    walletClient = candidate;
    workerContext = context;
    return candidate;
  }

  async function deriveVaultCredentials(
    signature: unknown,
    context: WalletWorkerContext,
    sessionGeneration: number,
  ) {
    const credentialClient = walletCryptoClientFactory({ deviceRecordStore, onInvalidated: () => undefined });
    try {
      const credentials = await awaitCurrent(
        sessionGeneration,
        credentialClient.deriveSignatureVaultCredentials(signature, context),
      );
      return credentials;
    } finally {
      credentialClient.dispose();
    }
  }

  function vaultPath(walletAuthId: string) {
    return `/api/wallet-vaults/${encodeURIComponent(walletAuthId)}`;
  }

  async function pullVault(
    credentials: { walletAuthId: string; authToken: string },
    sessionGeneration: number,
  ): Promise<WalletSignatureVaultRecord | null> {
    ensureCurrent(sessionGeneration);
    if (!BACKUP_URL) return null;
    const path = vaultPath(credentials.walletAuthId);
    let response: Response;
    try {
      response = await fetchWithTimeout(`${BACKUP_URL}${path}`, {
        headers: { accept: "application/json", "x-zylith-wallet-vault-auth": credentials.authToken },
      }, WALLET_VAULT_REQUEST_TIMEOUT_MS);
    } catch {
      ensureCurrent(sessionGeneration);
      throw new Error("Private trading state is unavailable. Retry later.");
    }
    ensureCurrent(sessionGeneration);
    if (response.status === 404) return null;
    if (!response.ok) throw new RuntimeHttpStatusError(path, response.status, "");
    const raw = await awaitCurrent(sessionGeneration, readSdkResponseText(response, {
      timeoutMs: WALLET_VAULT_REQUEST_TIMEOUT_MS,
      label: "Wallet vault response",
    }));
    const bundle = parseWalletJson(raw, ["version", "message_version", "updated_at_unix_ms"]) as WalletSignatureVaultBundle;
    return requireWalletSignatureVaultBundle(bundle, credentials.walletAuthId);
  }

  async function pushVault(
    credentials: { walletAuthId: string; authToken: string },
    vaultRaw: string,
    sessionGeneration: number,
  ) {
    if (!BACKUP_URL) return;
    ensureCurrent(sessionGeneration);
    const path = vaultPath(credentials.walletAuthId);
    const vault = parseWalletJson(vaultRaw, ["version", "message_version"]);
    await awaitCurrent(sessionGeneration, postJson(BACKUP_URL, path, {
      wallet_auth_id: credentials.walletAuthId,
      vault,
      updated_at_unix_ms: now(),
    }, { "x-zylith-wallet-vault-auth": credentials.authToken }));
  }

  async function publishVault(walletAddress: string, raw: string, sessionGeneration: number) {
    ensureCurrent(sessionGeneration);
    const published = await signatureVaultStore.publish(
      walletAddress,
      raw,
      () => {
        if (generation !== sessionGeneration) return false;
        try {
          requireNoLegacyDeviceRecord(walletAddress);
          return true;
        } catch {
          return false;
        }
      },
    );
    ensureCurrent(sessionGeneration);
    requireNoLegacyDeviceRecord(walletAddress);
    return published;
  }

  function installVaultMonitor(
    walletAddress: string,
    expectedRaw: string,
    client: WalletCryptoPort,
    sessionGeneration: number,
  ) {
    let active = true;
    const unsubscribe = signatureVaultStore.subscribe(walletAddress, (nextRaw) => {
      if (!active || nextRaw === expectedRaw) return;
      active = false;
      if (generation === sessionGeneration && walletClient === client) clearSession(false);
    });
    try {
      if (signatureVaultStore.readRaw(walletAddress) !== expectedRaw) {
        throw new WalletSessionChangedError();
      }
    } catch (error) {
      active = false;
      try { unsubscribe(); } catch { /* listener cleanup is best effort */ }
      throw error;
    }
    vaultRecordUnsubscribe = () => {
      active = false;
      unsubscribe();
    };
  }

  async function openPreparedVault(
    client: WalletCryptoPort,
    preparation: SignatureVaultPreparation,
    context: WalletWorkerContext,
    manifest: DeploymentConfig,
    sessionGeneration: number,
  ) {
    let committed = false;
    try {
      await awaitOwnedClient(sessionGeneration, client, client.commitSignatureVault(preparation));
      committed = true;
      await hydrate(client, context, manifest, sessionGeneration);
      installVaultMonitor(context.walletAddress, preparation.vaultRaw, client, sessionGeneration);
      const finalized = await awaitOwnedClient(
        sessionGeneration,
        client,
        client.finalizeSignatureVault(preparation, true),
      );
      if (signatureVaultStore.readRaw(context.walletAddress) !== preparation.vaultRaw) {
        throw new WalletSessionChangedError();
      }
      sessionReady = true;
      activeDeviceSession = finalized.remembered;
      startWorker();
      notifyWalletRuntimeChanged();
      return true;
    } catch (error) {
      if (!committed && generation === sessionGeneration && walletClient === client) {
        walletClient = null;
        workerContext = null;
        try {
          await client.abortSignatureVault(preparation);
        } catch {
          client.dispose();
        }
        ensureCurrent(sessionGeneration);
      }
      if (generation === sessionGeneration && (walletClient === client || walletClient === null)) {
        clearSession(false, { generation: sessionGeneration, error }, walletClient === null);
      }
      throw translateWalletCryptoError(error);
    }
  }

  async function deviceSessionContext(
    starknetAddress: string,
    sessionGeneration: number,
  ): Promise<{ context: WalletWorkerContext; manifest: DeploymentConfig } | null> {
    const provider = selectedStarknetProvider();
    if (!provider) return null;
    const walletAddress = normalizeFeltForComparison(starknetAddress);
    const connected = connectedStarknetAddress();
    if (!connected || normalizeFeltForComparison(connected) !== walletAddress) return null;
    const manifest = await awaitCurrent(sessionGeneration, loadDeployment());
    const expectedChainId = requiredNonZeroFelt(manifest.chain_id, "chain_id");
    let actualChainId: string | null;
    try {
      actualChainId = await awaitCurrent(sessionGeneration, readStarknetWalletChainId(provider as never));
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      actualChainId = null;
    }
    if (!actualChainId || normalizeFeltForComparison(actualChainId) !== normalizeFeltForComparison(expectedChainId)) {
      return null;
    }
    const vaultDeploymentId = await awaitCurrent(sessionGeneration, walletAuthDeploymentId(manifest, 2));
    return {
      context: await workerContextFor({
        walletAddress,
        chainId: expectedChainId,
        deploymentId: vaultDeploymentId,
        origin: window.location.origin,
      }, manifest, sessionGeneration),
      manifest,
    };
  }

  function unlockWithDeviceSession(starknetAddress: string) {
    return vaultOperations.run(`device:${normalizeFeltForComparison(starknetAddress)}`, async () => {
      const sessionGeneration = generation;
      clearedSessionFailure = null;
      ensureCurrent(sessionGeneration);
      if (sessionReady) return activeWalletAddress === normalizeFeltForComparison(starknetAddress);
      const resolved = await deviceSessionContext(starknetAddress, sessionGeneration);
      ensureCurrent(sessionGeneration);
      if (!resolved) return false;
      const snapshot = readVaultSnapshot(resolved.context.walletAddress);
      if (!snapshot) return false;
      const client = createOwnedWalletClient(resolved.context, sessionGeneration);
      try {
        await awaitOwnedClient(
          sessionGeneration,
          client,
          client.unlockFromDeviceSession(resolved.context),
        );
        activeDeviceSession = true;
        await hydrate(client, resolved.context, resolved.manifest, sessionGeneration);
        installVaultMonitor(resolved.context.walletAddress, snapshot.raw, client, sessionGeneration);
        sessionReady = true;
        startWorker();
        notifyWalletRuntimeChanged();
        return true;
      } catch (error) {
        if (error instanceof WalletCryptoError && error.code === "DEVICE_SESSION_MISSING") {
          if (generation === sessionGeneration && walletClient === client) {
            walletClient = null;
            workerContext = null;
            client.dispose();
          }
          return false;
        }
        if (generation === sessionGeneration && walletClient === client) {
          clearSession(false, { generation: sessionGeneration, error });
        }
        throw translateWalletCryptoError(error);
      }
    });
  }

  function createWalletWithWalletSignature(starknetAddress: string) {
    return vaultOperations.run(`create:${normalizeFeltForComparison(starknetAddress)}`, async () => {
      const sessionGeneration = generation;
      clearedSessionFailure = null;
      ensureCurrent(sessionGeneration);
      if (sessionReady) throw new Error("Wallet session already exists");
      const context = await vaultContext(starknetAddress, sessionGeneration);
      ensureCurrent(sessionGeneration);
      if (hasVault(context.walletAddress)) throw new Error("Wallet session already exists");
      const manifest = await awaitCurrent(sessionGeneration, loadDeployment());
      const resolvedWorkerContext = await workerContextFor(context, manifest, sessionGeneration);
      const credentials = await deriveVaultCredentials(context.signature, resolvedWorkerContext, sessionGeneration);
      const remote = await pullVault(credentials, sessionGeneration);
      ensureCurrent(sessionGeneration);
      if (remote) {
        const remoteRaw = JSON.stringify(remote);
        const published = await publishVault(context.walletAddress, remoteRaw, sessionGeneration);
        if (!published) {
          const current = readVaultSnapshot(context.walletAddress);
          if (!current) throw new WalletSessionChangedError();
          return openVaultWithFreshClient(current.raw, context.signature, resolvedWorkerContext, manifest, sessionGeneration);
        }
        return openVaultWithFreshClient(remoteRaw, context.signature, resolvedWorkerContext, manifest, sessionGeneration);
      }
      const client = createOwnedWalletClient(resolvedWorkerContext, sessionGeneration);
      let preparation: SignatureVaultPreparation;
      try {
        preparation = await awaitOwnedClient(
          sessionGeneration,
          client,
          client.prepareSignatureVaultCreate(context.signature, resolvedWorkerContext, true),
        );
      } catch (error) {
        const translated = translateWalletCryptoError(error);
        if (generation === sessionGeneration && walletClient === client) {
          clearSession(false, { generation: sessionGeneration, error: translated });
        }
        throw translated;
      }
      // the remote vault is the wallet's only backup, so a new seed is used only once stored; a
      // conflict means this wallet already stored one elsewhere, which is restored instead.
      try {
        await pushVault(credentials, preparation.vaultRaw, sessionGeneration);
      } catch (error) {
        if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
        ensureCurrent(sessionGeneration);
        if (error instanceof RuntimeHttpStatusError && error.status === 409) {
          if (walletClient === client) {
            walletClient = null;
            workerContext = null;
          }
          try { await client.abortSignatureVault(preparation); } catch { client.dispose(); }
          ensureCurrent(sessionGeneration);
          const existing = await pullVault(credentials, sessionGeneration);
          if (existing) {
            const existingRaw = JSON.stringify(existing);
            const published = await publishVault(context.walletAddress, existingRaw, sessionGeneration);
            const selected = published ? existingRaw : readVaultSnapshot(context.walletAddress)?.raw;
            if (selected) return openVaultWithFreshClient(selected, context.signature, resolvedWorkerContext, manifest, sessionGeneration);
          }
          const conflict = new Error("The existing private trading wallet could not be restored after a backup conflict. Retry.");
          clearSession(false, { generation: sessionGeneration, error: conflict }, true);
          throw conflict;
        } else {
          const existing = await pullVault(credentials, sessionGeneration).catch((readError: unknown) => {
            if (readError instanceof WalletMigrationRequiredError || readError instanceof WalletSessionChangedError) throw readError;
            ensureCurrent(sessionGeneration);
            return null;
          });
          if (existing && stableJsonStringify(existing) === stableJsonStringify(parseWalletJson(preparation.vaultRaw))) {
            // an ambiguous acknowledgement is accepted only after an authenticated exact reread.
          } else {
            try { await client.abortSignatureVault(preparation); } catch { client.dispose(); }
            ensureCurrent(sessionGeneration);
            throw new Error("Could not back up the new private trading wallet. Nothing was created; retry when the service is reachable.", { cause: error });
          }
        }
      }
      const published = await publishVault(context.walletAddress, preparation.vaultRaw, sessionGeneration);
      if (!published && signatureVaultStore.readRaw(context.walletAddress) !== preparation.vaultRaw) {
        if (walletClient === client) {
          walletClient = null;
          workerContext = null;
        }
        try { await client.abortSignatureVault(preparation); } catch { client.dispose(); }
        ensureCurrent(sessionGeneration);
        const current = readVaultSnapshot(context.walletAddress);
        if (!current) throw new WalletSessionChangedError();
        return openVaultWithFreshClient(current.raw, context.signature, resolvedWorkerContext, manifest, sessionGeneration);
      }
      return openPreparedVault(client, preparation, resolvedWorkerContext, manifest, sessionGeneration);
    });
  }

  async function openVaultWithFreshClient(
    vaultRaw: string,
    signature: unknown,
    context: WalletWorkerContext,
    manifest: DeploymentConfig,
    sessionGeneration: number,
  ) {
    ensureCurrent(sessionGeneration);
    const client = createOwnedWalletClient(context, sessionGeneration);
    let preparation: SignatureVaultPreparation;
    try {
      preparation = await awaitOwnedClient(
        sessionGeneration,
        client,
        client.prepareSignatureVaultOpen(signature, vaultRaw, context, true),
      );
    } catch (error) {
      const translated = translateWalletCryptoError(error);
      if (generation === sessionGeneration && walletClient === client) {
        clearSession(false, { generation: sessionGeneration, error: translated });
      }
      throw translated;
    }
    if (preparation.vaultRaw !== vaultRaw) {
      const error = new WalletSessionChangedError();
      if (walletClient === client) {
        walletClient = null;
        workerContext = null;
      }
      try { await client.abortSignatureVault(preparation); } catch { client.dispose(); }
      ensureCurrent(sessionGeneration);
      clearSession(false, { generation: sessionGeneration, error }, true);
      throw error;
    }
    return openPreparedVault(client, preparation, context, manifest, sessionGeneration);
  }

  function unlockWithWalletSignature(starknetAddress: string) {
    return vaultOperations.run(`unlock:${normalizeFeltForComparison(starknetAddress)}`, async () => {
      const sessionGeneration = generation;
      clearedSessionFailure = null;
      ensureCurrent(sessionGeneration);
      if (sessionReady) return activeWalletAddress === normalizeFeltForComparison(starknetAddress);
      const stored = readVaultSnapshot(starknetAddress);
      const context = await vaultContext(
        starknetAddress,
        sessionGeneration,
        stored?.vault.message_version ?? 2,
        stored?.vault.deployment_id,
      );
      ensureCurrent(sessionGeneration);
      const manifest = await awaitCurrent(sessionGeneration, loadDeployment());
      const workerContext = await workerContextFor(context, manifest, sessionGeneration);
      let vaultRaw = stored?.raw ?? null;
      if (vaultRaw === null) {
        const credentials = await deriveVaultCredentials(context.signature, workerContext, sessionGeneration);
        const remote = await pullVault(credentials, sessionGeneration);
        if (!remote) return false;
        const remoteRaw = JSON.stringify(remote);
        const published = await publishVault(context.walletAddress, remoteRaw, sessionGeneration);
        vaultRaw = published ? remoteRaw : readVaultSnapshot(context.walletAddress)?.raw ?? null;
        if (vaultRaw === null) throw new WalletSessionChangedError();
      }
      return openVaultWithFreshClient(vaultRaw, context.signature, workerContext, manifest, sessionGeneration);
    });
  }

  // recovery snapshots

  async function recoveryHeaders(client: WalletCryptoPort, sessionGeneration: number) {
    const authTag = await awaitOwnedClient(sessionGeneration, client, client.recoveryAuthTag());
    return { "x-zylith-recovery-auth": authTag };
  }

  function recoveryPath(accountId: string) {
    return `/api/recovery/${encodeURIComponent(accountId)}/artifacts`;
  }

  async function pullRecoverySnapshot(ownership?: HydrationLocalStateOwnership) {
    if (!BACKUP_URL) return false;
    if (ownership) requireHydrationLocalStateOwnership(ownership);
    const { client, publicConfig: config } = sessionContext();
    const sessionGeneration = generation;
    const targetScope = scope;
    let response: Response;
    try {
      response = await fetchWithTimeout(`${BACKUP_URL}${recoveryPath(config.account_id)}`, {
        headers: { accept: "application/json", ...await recoveryHeaders(client, sessionGeneration) },
      }, WALLET_VAULT_REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      ensureCurrent(sessionGeneration);
      if (ownership) requireHydrationLocalStateOwnership(ownership);
      return false;
    }
    ensureCurrent(sessionGeneration);
    if (ownership) requireHydrationLocalStateOwnership(ownership);
    if (!response.ok) return false;
    const responseRaw = await awaitCurrent(sessionGeneration, readSdkResponseText(response, {
      timeoutMs: WALLET_VAULT_REQUEST_TIMEOUT_MS,
      label: "Recovery snapshot response",
    }));
    if (ownership) requireHydrationLocalStateOwnership(ownership);
    const list = parseWalletJson(responseRaw);
    let snapshots: RecoveryArtifact[];
    try {
      snapshots = requireRecoveryArtifactHistory(list, config.account_id);
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError) throw error;
      throw error instanceof RecoveryStateConflictError
        ? error
        : new RecoveryStateConflictError(error);
    }
    const recoveredState = structuredClone(state);
    let changed = false;
    let applicableSnapshots = 0;
    for (const snapshot of snapshots) {
      let payload: { version?: number; scope?: string; state?: unknown };
      try {
        payload = parseWalletJson(await awaitOwnedClient(
          sessionGeneration,
          client,
          client.decryptRecoveryArtifact(JSON.stringify(snapshot)),
        ), ["version"]) as {
          version?: number;
          scope?: string;
          state?: unknown;
        };
      } catch (error) {
        if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
        ensureCurrent(sessionGeneration);
        throw new RecoveryStateConflictError(error);
      }
      ensureCurrent(sessionGeneration);
      if (scope !== targetScope) throw new Error("Wallet session changed. Retry.");
      if (ownership) requireHydrationLocalStateOwnership(ownership);
      try {
        const snapshotState = recoverySnapshotStateForScope(payload, targetScope);
        if (snapshotState === null) continue;
        applicableSnapshots += 1;
        changed = mergeState(recoveredState, snapshotState) || changed;
      } catch (error) {
        if (error instanceof WalletMigrationRequiredError) throw error;
        throw new RecoveryStateConflictError(error);
      }
    }
    if (applicableSnapshots > 0 && stateWritesBlocked) {
      state = recoveredState;
      stateWritesBlocked = false;
      try {
        await saveState(ownership);
      } catch (error) {
        if (generation === sessionGeneration && scope === targetScope) stateWritesBlocked = true;
        throw error;
      }
    } else if (changed) {
      state = recoveredState;
      await saveState(ownership);
    }
    ensureCurrent(sessionGeneration);
    if (ownership) requireHydrationLocalStateOwnership(ownership);
    recoveryHeadArtifactId = snapshots.at(-1)?.artifact_id ?? null;
    recoveryHeadSequence = snapshots.at(-1)?.sequence ?? 0;
    return applicableSnapshots > 0;
  }

  function pushRecoverySnapshot(force = false) {
    const requestedGeneration = generation;
    const upload = snapshotSaveChain
      .catch(() => false)
      .then(() => {
        ensureCurrent(requestedGeneration);
        return preserveSessionOnMigration(requestedGeneration, () => pushRecoverySnapshotNow(force));
      });
    snapshotSaveChain = upload.catch(() => false);
    return upload;
  }

  async function requireRecoverySnapshot() {
    if (!(await pushRecoverySnapshot(true))) {
      throw new Error("Encrypted recovery backup is unavailable. No funds were moved.");
    }
  }

  async function pushRecoverySnapshotNow(force = false) {
    if (!BACKUP_URL || !walletClient || !publicConfig) return false;
    if (!force && (!snapshotDirty || Date.now() - lastSnapshotAt < RECOVERY_SNAPSHOT_MIN_INTERVAL_MS)) return false;
    const sessionGeneration = generation;
    requireSessionStorageCompatibility(sessionGeneration);
    const targetScope = scope;
    const client = walletClient;
    const accountId = publicConfig.account_id;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = Math.max(Date.now(), recoveryHeadSequence + 1);
      const revision = stateRevision;
      const stateSnapshot = structuredClone(state);
      requireWalletState(stateSnapshot);
      const artifact = JSON.parse(await awaitOwnedClient(
        sessionGeneration,
        client,
        client.createRecoverySnapshot(JSON.stringify({
          sequence: now,
          created_at_unix_ms: now,
          payload_json: JSON.stringify(padRecoverySnapshotPayload({ version: 2, key_schedule_version: WALLET_KEY_SCHEDULE_VERSION, scope: targetScope, state: stateSnapshot })),
        })),
      )) as unknown;
      if (!isRecoveryArtifact(artifact) || artifact.account_id !== accountId) {
        throw new Error("The wallet produced a malformed recovery snapshot.");
      }
      try {
        const stored = await awaitCurrent(sessionGeneration, postJson<unknown>(BACKUP_URL, recoveryPath(accountId), {
          artifact,
          previous_artifact_id: recoveryHeadArtifactId,
        }, await recoveryHeaders(client, sessionGeneration)));
        if (!isRecoveryArtifact(stored) || stableJsonStringify(stored) !== stableJsonStringify(artifact)) {
          throw new Error("The recovery service returned a mismatched snapshot acknowledgement.");
        }
      } catch (error) {
        if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
        ensureCurrent(sessionGeneration);
        if (!(error instanceof RuntimeHttpStatusError) || error.status !== 409 || attempt !== 0) throw error;
        await pullRecoverySnapshot();
        ensureCurrent(sessionGeneration);
        continue;
      }
      ensureCurrent(sessionGeneration);
      if (scope !== targetScope) throw new Error("Wallet session changed. Retry.");
      recoveryHeadArtifactId = artifact.artifact_id;
      recoveryHeadSequence = artifact.sequence;
      lastSnapshotAt = now;
      if (stateRevision === revision) snapshotDirty = false;
      return true;
    }
    return false;
  }

  // notes and balances

  function noteByCommitment(commitment: string) {
    const key = normalizeFeltForComparison(commitment);
    return state.notes.find((note) => normalizeFeltForComparison(note.commitment) === key);
  }

  function spendable(note: WalletNote) {
    return !note.spent
      && !note.locked_by
      && !hasActiveExit(note)
      && (note.source === "output" || note.deposit?.confirmed === true);
  }

  function addNote(fields: NoteFields, asset: string, source: WalletNote["source"], extra: Partial<WalletNote>) {
    const summary = JSON.parse(core.zylith_wallet_note_summary(JSON.stringify(fields))) as { commitment: string; nullifier: string };
    const note = { commitment: summary.commitment, nullifier: summary.nullifier, asset, fields, source, ...extra };
    if (!isStoredNote(note)) throw new Error("The wallet produced a malformed private note.");
    const existing = noteByCommitment(summary.commitment);
    if (existing) {
      const merged = mergeNoteState(existing, note);
      if (merged === existing) return false;
      Object.assign(existing, merged);
      return true;
    }
    if (state.notes.some((candidate) => normalizeFeltForComparison(candidate.nullifier) === normalizeFeltForComparison(note.nullifier))) {
      throw new Error("The wallet produced a duplicate private-note nullifier.");
    }
    state.notes.push(note);
    return true;
  }

  function getBalances(): WalletBalance[] {
    return walletBalances(state);
  }

  function getPendingDeposits(): PendingDeposit[] {
    return state.notes
      .filter((note) => note.source === "deposit" && note.deposit && !(note.deposit.failed && !note.deposit.transaction_hash))
      .map((note) => ({
        note_commitment: note.commitment,
        asset: note.asset,
        amount: note.fields.amount,
        transaction_hash: note.deposit!.transaction_hash,
        public_transaction_confirmed: note.deposit!.public_transaction_confirmed,
        request_id: note.deposit!.request_id,
        requested_at_unix_ms: note.deposit!.requested_at_ms,
        confirmed: note.deposit!.confirmed,
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
    if (depositOperationInFlight) throw new Error("A deposit is already in progress.");
    depositOperationInFlight = true;
    const sessionGeneration = generation;
    try {
      const { client, deployment: manifest } = unlocked();
      if (!isDecimal(amountAtoms)) throw new Error("Deposit amount is invalid");
      const amount = BigInt(amountAtoms);
      if (amount <= 0n) throw new Error("Deposit amount must be greater than zero");
      const rail = selectedDepositFundingRail(manifest);
      const bridgeAddress = requiredNonZeroFelt(rail.bridgeAdapter, "privacy_deposit_bridge_address");
      const tokenAddress = fundingRailTokenAddress(manifest, asset);
      const plan = parseWalletJson(await awaitOwnedClient(
        sessionGeneration,
        client,
        client.buildDepositSubmissionPlan(JSON.stringify({
          bridge_address: bridgeAddress,
          asset_id: asset,
          amount: amount.toString(),
          deposit_nonce: randomU64(),
        })),
      )) as {
      note_commitment: string;
      note_fields: NoteFields;
      encoded_args: Record<"funding_commitments" | "deposit_roots" | "encrypted_note_activations" | "note_commitments" | "asset_ids" | "amounts" | "withdraw_authorities", string[]>;
    };
    const encodedFields = [
      "funding_commitments",
      "deposit_roots",
      "encrypted_note_activations",
      "note_commitments",
      "asset_ids",
      "amounts",
      "withdraw_authorities",
    ] as const;
    if (
      !isRecord(plan)
      || !isRecord(plan.encoded_args)
      || encodedFields.some((field) => !Array.isArray(plan.encoded_args[field]) || plan.encoded_args[field].length !== 1)
    ) throw new Error("The wallet produced a malformed deposit plan.");
    const summary = call<{ commitment: string; nullifier: string }>(core.zylith_wallet_note_summary, plan.note_fields);
    const expectedAssetId = call<{ base_asset_id: string }>(core.zylith_wallet_market_ids, {
      pair: "deposit",
      base_asset: asset,
      quote_asset: asset,
    }).base_asset_id;
    if (
      !isNonZeroFelt(summary.commitment)
      || !isNonZeroFelt(summary.nullifier)
      || normalizeFeltForComparison(summary.commitment) !== normalizeFeltForComparison(plan.note_commitment)
      || normalizeFeltForComparison(plan.encoded_args.note_commitments[0]) !== normalizeFeltForComparison(plan.note_commitment)
      || normalizeFeltForComparison(plan.encoded_args.asset_ids[0]) !== normalizeFeltForComparison(expectedAssetId)
      || normalizeFeltForComparison(plan.note_fields.asset_id) !== normalizeFeltForComparison(expectedAssetId)
      || plan.encoded_args.amounts[0] !== amount.toString()
      || plan.note_fields.amount !== amount.toString()
      || normalizeFeltForComparison(plan.encoded_args.withdraw_authorities[0])
        !== normalizeFeltForComparison(plan.note_fields.withdraw_authority)
      || !isNonZeroFelt(plan.encoded_args.funding_commitments[0])
      || !isNonZeroFelt(plan.encoded_args.deposit_roots[0])
      || !isNonZeroFelt(plan.encoded_args.encrypted_note_activations[0])
    ) throw new Error("The wallet produced an inconsistent deposit plan.");
    setPrivacyFundingStage("Connecting Starknet wallet and checking network");
    const provider = await awaitCurrent(
      sessionGeneration,
      selectInjectedStarknetProvider(activeWalletAddress, () => ensureCurrent(sessionGeneration)),
    );
    const connectedChainId = await awaitCurrent(
      sessionGeneration,
      readStarknetWalletChainId(provider as never),
    );
    if (normalizeStrictFelt(requiredNonZeroFelt(connectedChainId, "connected_chain_id"))
      !== normalizeStrictFelt(requiredNonZeroFelt(manifest.chain_id, "chain_id"))) {
      throw new Error("Connected Starknet wallet chain does not match the deployment network.");
    }
    const depositWalletAddress = requiredNonZeroFelt(
      activeWalletAddress,
      "connected_wallet_address",
    );
    const requestId = randomFeltHex();
    if (!addNote(plan.note_fields, asset, "deposit", {
      deposit: { funding_commitment: plan.encoded_args.funding_commitments[0], request_id: requestId, requested_at_ms: Date.now(), confirmed: false },
    })) throw new Error("The wallet produced a duplicate deposit note.");
    const note = noteByCommitment(plan.note_commitment);
    if (!note) throw new Error("The wallet produced an inconsistent deposit note.");
    await saveState();
    try {
      await requireRecoverySnapshot();
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      ensureCurrent(sessionGeneration);
      state.notes = state.notes.filter(
        (candidate) => normalizeFeltForComparison(candidate.commitment) !== normalizeFeltForComparison(note.commitment),
      );
      await saveState();
      throw error;
    }
    let submitted = false;
    let walletSubmissionStarted = false;
    let walletTransactionOutstanding = false;
    let walletSubmissionMayHaveLanded = (_error: unknown) => true;
    try {
      const [
        walletPrivacy,
        { privacyBridgeDepositFlatCalldata },
      ] = await awaitCurrent(sessionGeneration, Promise.all([
        import("./integrations/starknetWalletPrivacy"),
        import("./integrations/starknetPrivacyFunding"),
      ]));
      walletSubmissionMayHaveLanded = walletPrivacy.walletPrivateSubmissionMayHaveLanded;
      const depositAsset = manifest.market_registry.assets.find(
        (candidate) => candidate.asset_id === asset,
      );
      if (!depositAsset) throw new Error(`${asset} is not configured for deposits.`);
      const result = await awaitCurrent(sessionGeneration, walletPrivacy.fundZylithFromWallet({
        provider: provider as never,
        tokenAddress,
        tokenMetadata: {
          name: asset,
          symbol: asset,
          decimals: depositAsset.decimals,
        },
        amount,
        amountLabel: `${fromAtomicStr(amount.toString(), asset)} ${asset}`,
        bridgeAddress,
        bridgeCalldata: privacyBridgeDepositFlatCalldata({
          amount,
          encodedArgs: plan.encoded_args,
        }),
        onStage: (stage) => {
          ensureCurrent(sessionGeneration);
          setPrivacyFundingStage(stage);
        },
        transactionStatus: async (hash) => {
          const status = await awaitCurrent(
            sessionGeneration,
            fetchTransactionReceiptStatus(hash, manifest),
          );
          if (status?.failed) return "failed";
          if (status?.confirmed) return "confirmed";
          return "pending";
        },
        assertWalletContext: () => {
          ensureCurrent(sessionGeneration);
          const currentAddress = connectedStarknetAddress();
          if (
            !currentAddress
            || normalizeFeltForComparison(currentAddress)
              !== normalizeFeltForComparison(depositWalletAddress)
          ) {
            throw new Error("Connected Starknet wallet changed during the deposit.");
          }
        },
        onPrivateDepositSubmissionStarted: () => {
          ensureCurrent(sessionGeneration);
          walletSubmissionStarted = true;
        },
        onWalletTransactionSubmissionStarted: () => {
          ensureCurrent(sessionGeneration);
          walletTransactionOutstanding = true;
        },
        onWalletTransactionResolved: () => {
          ensureCurrent(sessionGeneration);
          walletTransactionOutstanding = false;
        },
      }));
      note.deposit!.transaction_hash = result.transactionHash;
      submitted = true;
      await saveState();
      return { transaction_hash: result.transactionHash, note_commitment: note.commitment };
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      ensureCurrent(sessionGeneration);
      // once the wallet submission begins, a missing or malformed acknowledgement cannot prove the
      // transaction did not land. keep the deterministic note until chain recovery resolves it.
      const ambiguous = submitted
        || ((walletSubmissionStarted || walletTransactionOutstanding)
          && walletSubmissionMayHaveLanded(error));
      if (!ambiguous) state.notes = state.notes.filter((candidate) => candidate !== note);
      await saveState();
      throw ambiguous ? markOperationSubmissionStarted(error) : error;
    } finally {
      if (generation === sessionGeneration) {
        void pushRecoverySnapshot(true).catch(() => false);
        kick();
      }
    }
    } finally {
      if (generation === sessionGeneration) depositOperationInFlight = false;
    }
  }

  async function refreshDeposits() {
    const sessionGeneration = generation;
    const pending = state.notes.filter((note) => note.deposit && !note.deposit.confirmed && !note.deposit.failed);
    if (pending.length === 0) return false;
    // every wallet reads the same recent list and matches locally.
    const recent = await awaitCurrent(sessionGeneration, exchange().recentDeposits());
    if (
      !isRecord(recent)
      || !Array.isArray(recent.recent_funding_commitments)
      || recent.recent_funding_commitments.length > 512
      || recent.recent_funding_commitments.some((commitment) => !isNonZeroFelt(commitment))
      || new Set(recent.recent_funding_commitments.map(normalizeFeltForComparison)).size !== recent.recent_funding_commitments.length
      || !isSafeNonNegativeInteger(recent.last_successful_sync_unix_ms)
      || recent.last_successful_sync_unix_ms === 0
      || !isSafeNonNegativeInteger(recent.sync_lag_ms)
    ) throw new Error("The chain indexer returned malformed deposit status.");
    const confirmed = new Set(recent.recent_funding_commitments.map(normalizeFeltForComparison));
    const stale = !recent.last_successful_sync_unix_ms || recent.sync_lag_ms > DEPOSIT_CONFIRMATION_STALE_MS;
    let changed = false;
    for (const note of pending) {
      const record = depositRecord(note);
      if (confirmed.has(normalizeFeltForComparison(note.deposit!.funding_commitment))) {
        markDepositRecordConfirmed(record);
      } else if (!stale) {
        const status = note.deposit!.transaction_hash
          ? await receipt(note.deposit!.transaction_hash, sessionGeneration)
          : null;
        if (status?.confirmed) {
          note.deposit = { ...note.deposit!, public_transaction_confirmed: true };
          changed = true;
          const registered = await fundingCommitmentRegistration(
            note.deposit!.funding_commitment,
            sessionGeneration,
          ).catch((error: unknown) => {
            if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
            return null;
          });
          if (registered === true) {
            markDepositRecordConfirmed(record);
            note.deposit = {
              ...note.deposit!,
              confirmed: true,
              public_transaction_confirmed: undefined,
              failed: undefined,
              failure_reason: undefined,
              transaction_hash: undefined,
            };
            changed = true;
            continue;
          }
          if (registered === null) continue;
        }
        const reason = pendingDepositFailureReason({
          record,
          status,
        });
        if (!reason) continue;
        markDepositRecordFailed(record, reason);
      } else {
        continue;
      }
      note.deposit = {
        ...note.deposit!,
        confirmed: record.deposit_confirmed === true,
        failed: record.deposit_failed,
        failure_reason: record.deposit_failure_reason,
        transaction_hash: record.pending_deposit_tx,
        public_transaction_confirmed: record.public_transaction_confirmed,
      };
      changed = true;
    }
    return changed;
  }

  async function fundingCommitmentRegistration(fundingCommitment: string, sessionGeneration: number) {
    const { deployment: manifest } = unlocked();
    const fields = await awaitCurrent(sessionGeneration, starknetCall(
      manifest.rpc_url,
      manifest.contracts.commitment_registry,
      "is_funding_commitment_registered",
      [fundingCommitment],
    ));
    return parseFundingCommitmentRegistration(fields);
  }

  function depositRecord(note: WalletNote) {
    return {
      source: "deposit" as const,
      deposit_confirmed: note.deposit!.confirmed,
      deposit_failed: note.deposit!.failed,
      deposit_failure_reason: note.deposit!.failure_reason,
      funding_commitment: note.deposit!.funding_commitment,
      pending_deposit_tx: note.deposit!.transaction_hash,
      public_transaction_confirmed: note.deposit!.public_transaction_confirmed,
      deposit_request_id: note.deposit!.request_id,
      deposit_requested_at_unix_ms: note.deposit!.requested_at_ms,
    };
  }

  async function receipt(
    transactionHash: string,
    sessionGeneration: number,
  ): Promise<TransactionReceiptStatus | null> {
    const manifest = unlocked().deployment;
    try {
      return await awaitCurrent(
        sessionGeneration,
        fetchTransactionReceiptStatus(transactionHash, manifest),
      );
    } catch {
      ensureCurrent(sessionGeneration);
      return null;
    }
  }

  async function recoveryTransactionState(
    transactionHash: string,
    _submittedAtMs: number,
    sessionGeneration: number,
  ) {
    return recoveryTransactionDisposition(
      await receipt(transactionHash, sessionGeneration),
    );
  }

  // orders

  function pairConfig(pair: string): PairConfig {
    const config = enabledPairs(unlocked().deployment).find((market) => market.pair_id === pair);
    if (!config) throw new Error(`${pair} is not traded`);
    return config;
  }

  async function executionKeys() {
    if (registryCache && Date.now() - registryCache.loadedAt < 60_000) {
      return { keys: registryCache.keys };
    }
    if (!registryLoadInFlight) {
      const sessionGeneration = generation;
      const pending = (async () => {
        const sessionDeployment = unlocked().deployment;
        const registry = requireExecutionKeyRegistry(
          await awaitCurrent(sessionGeneration, exchange().executionKeys()),
        );
        const fingerprint = core.zylith_wallet_registry_fingerprint(JSON.stringify(registry));
        const trustedDeployment = await awaitCurrent(
          sessionGeneration,
          deploymentForExecutionKey(fingerprint, sessionDeployment, (accepted) => {
            ensureCurrent(sessionGeneration);
            deployment = accepted;
          }),
        );
        deployment = trustedDeployment;
        registryCache = { ...registry, loadedAt: Date.now() };
        return { keys: registryCache.keys };
      })();
      registryLoadInFlight = pending;
    }
    const pending = registryLoadInFlight;
    try {
      return await pending;
    } finally {
      if (registryLoadInFlight === pending) registryLoadInFlight = null;
    }
  }

  /** sealed requests are already one fixed size: the envelope pads inside, in wasm. */
  async function submitSealed(built: SealedBuild, sessionGeneration: number) {
    const responseKey = built.response_key;
    let submission: ReturnType<ReturnType<typeof exchange>["submit"]>;
    try {
      submission = exchange().submit(built.sealed, responseKey);
    } finally {
      built.response_key = "";
    }
    return awaitCurrent(sessionGeneration, submission);
  }

  /** the input an order locks: its base for a sell, its quote at the limit for a buy. */
  function fundingRequirement(draft: OrderDraft, pair: PairConfig) {
    const amount = BigInt(draft.amount);
    return draft.side === "Sell" ? amount : orderQuoteValue(draft.amount, draft.limitPrice, pair);
  }

  /** the fewest spendable notes covering `required`, largest first. */
  function selectFunding(asset: string, required: bigint) {
    const candidates = state.notes
      .filter((note) => note.asset === asset && spendable(note))
      .sort((left, right) => {
        const leftAmount = BigInt(left.fields.amount);
        const rightAmount = BigInt(right.fields.amount);
        if (leftAmount !== rightAmount) return leftAmount > rightAmount ? -1 : 1;
        return normalizeFeltForComparison(left.commitment).localeCompare(
          normalizeFeltForComparison(right.commitment),
        );
      });
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
    if (orderSubmissionInFlight) throw new Error("An order submission is already in progress.");
    orderSubmissionInFlight = true;
    const sessionGeneration = generation;
    let sealedBuild: SealedBuild | null = null;
    try {
    const { client } = unlocked();
    if (
      !isBoundedString(draft.pair, 64)
      || draft.pair.length === 0
      || (draft.side !== "Buy" && draft.side !== "Sell")
      || typeof draft.external !== "boolean"
      || !isDecimal(draft.amount)
      || BigInt(draft.amount) === 0n
      || !isDecimal(draft.limitPrice)
      || BigInt(draft.limitPrice) === 0n
      || (draft.expiresAtMs !== undefined && !isSafeNonNegativeInteger(draft.expiresAtMs))
    ) throw new Error("Order details are invalid");
    const pair = pairConfig(draft.pair);
    if (draft.external && !pair.external_match_enabled) throw new Error("External execution is disabled for this pair");
    if (BigInt(draft.amount) < BigInt(pair.min_order_amount)) throw new Error("Order is below the pair's minimum size");
    if (orderQuoteValue(draft.amount, draft.limitPrice, pair) < BigInt(pair.min_order_quote_amount)) {
      throw new Error("Order is below the pair's minimum value");
    }
    const fundingAsset = draft.side === "Sell" ? pair.base_asset_id : pair.quote_asset_id;
    const funding = selectFunding(fundingAsset, fundingRequirement(draft, pair));
    const [registry, rawStatus] = await Promise.all([
      executionKeys(),
      awaitCurrent(sessionGeneration, exchange().exchangeStatus()),
    ]);
    ensureCurrent(sessionGeneration);
    const status = requireExchangeStatus(rawStatus, unlocked().deployment);
    const expiresAt = draft.expiresAtMs ?? Date.now() + DEFAULT_ORDER_LIFETIME_MS;
    if (expiresAt <= Date.now()) throw new Error("Order expiry must be in the future");
    const built = parseWalletJson(await awaitOwnedClient(
      sessionGeneration,
      client,
      client.buildOrderRequest(JSON.stringify({
      pair: draft.pair,
      sell: draft.side === "Sell",
      external: draft.external,
      amount: draft.amount,
      limit: draft.limitPrice,
      expiry_ms: expiresAt,
      funding: funding.map((note) => note.fields),
      registry,
      })),
    )) as SealedBuild & { order_id: string; terms: unknown; nullifiers: string[] };
    sealedBuild = built;
    assertSealedBuild(built, registry.keys[0].key_id, ["order_id", "terms", "nullifiers"]);
    const terms = isRecord(built.terms) ? built.terms : null;
    const owner = terms && isRecord(terms.owner) ? terms.owner : null;
    const expectedPairId = call<{ pair_id: string }>(core.zylith_wallet_market_ids, {
      pair: pair.pair_id,
      base_asset: pair.base_asset_id,
      quote_asset: pair.quote_asset_id,
    }).pair_id;
    const expectedNullifiers = funding.map((note) => normalizeFeltForComparison(note.nullifier)).sort();
    const builtNullifiers = Array.isArray(built.nullifiers)
      ? built.nullifiers.map(normalizeFeltForComparison).sort()
      : [];
    if (
      !isNonZeroFelt(built.order_id)
      || !terms
      || !owner
      || normalizeStrictFelt(terms.pair_id) !== normalizeFeltForComparison(expectedPairId)
      || terms.sell !== (draft.side === "Sell")
      || terms.external !== draft.external
      || terms.amount !== draft.amount
      || terms.limit !== draft.limitPrice
      || terms.expiry_ms !== expiresAt
      || [owner.owner_public_key, owner.spend_authority, owner.withdraw_authority, owner.cancel_authority, owner.nonce]
        .some((field) => !isNonZeroFelt(field))
      || builtNullifiers.length !== expectedNullifiers.length
      || new Set(builtNullifiers).size !== builtNullifiers.length
      || stableJsonStringify(builtNullifiers) !== stableJsonStringify(expectedNullifiers)
    ) throw new Error("The wallet produced an inconsistent private order.");
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
    try {
      await requireRecoverySnapshot();
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      ensureCurrent(sessionGeneration);
      const current = orderById(order.order_id) ?? order;
      releaseFunding(current);
      state.orders = state.orders.filter(
        (candidate) => normalizeFeltForComparison(candidate.order_id) !== normalizeFeltForComparison(order.order_id),
      );
      await saveState();
      throw error;
    }
    const persistedOrder = orderById(order.order_id);
    if (!persistedOrder) throw new Error("The backed-up order is missing from local state.");
    try {
      await submitSealed(built, sessionGeneration);
      ensureCurrent(sessionGeneration);
      setOrder(persistedOrder, { state: "pending" });
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      ensureCurrent(sessionGeneration);
      if (definitiveRejection(error)) {
        const markedError = markDefinitiveSubmissionFailure(error);
        releaseFunding(persistedOrder);
        setOrder(persistedOrder, {
          state: "failed",
          last_error: failureText(normalizeFailure(markedError, {
            domain: "order",
            operation: "order",
            stage: "order-submission",
          })),
        });
        await saveState();
        await pushRecoverySnapshot(true).catch(bestEffortSnapshotFailure);
        throw markedError;
      }
      // the operator may have accepted it; the next refresh settles which.
    }
    await saveState();
    kick();
    return { order_id: persistedOrder.order_id };
    } finally {
      if (sealedBuild) sealedBuild.response_key = "";
      if (generation === sessionGeneration) orderSubmissionInFlight = false;
    }
  }

  async function cancelOrder(orderId: string) {
    const operationId = normalizeFeltForComparison(orderId);
    if (cancellationsInFlight.has(operationId)) throw new Error("This order cancellation is already in progress.");
    cancellationsInFlight.add(operationId);
    const sessionGeneration = generation;
    let sealedBuild: SealedBuild | null = null;
    try {
    const { client } = unlocked();
    const order = orderById(orderId);
    if (!order || !OPEN_STATES.has(order.state)) throw new Error("The order is not open");
    const registry = await executionKeys();
    ensureCurrent(sessionGeneration);
    const built = parseWalletJson(await awaitOwnedClient(
      sessionGeneration,
      client,
      client.buildCancelRequest(JSON.stringify({
      order_id: order.order_id,
      registry,
      })),
    )) as SealedBuild;
    sealedBuild = built;
    assertSealedBuild(built, registry.keys[0].key_id);
    const previousState = order.state;
    const previousCancelRequested = order.cancel_requested;
    setOrder(order, { state: "cancelling", cancel_requested: true });
    const cancellationRevision = order.updated_at_ms;
    await saveState();
    ensureCurrent(sessionGeneration);
    await pushRecoverySnapshot(true).catch(bestEffortSnapshotFailure);
    ensureCurrent(sessionGeneration);
    try {
      await submitSealed(built, sessionGeneration);
      ensureCurrent(sessionGeneration);
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      ensureCurrent(sessionGeneration);
      if (definitiveRejection(error)) {
        const markedError = markDefinitiveSubmissionFailure(error);
        const current = orderById(order.order_id);
        if (
          current?.state === "cancelling"
          && current.cancel_requested === true
          && current.updated_at_ms === cancellationRevision
        ) {
          setOrder(current, { state: previousState, cancel_requested: previousCancelRequested });
          await saveState();
          await pushRecoverySnapshot(true).catch(bestEffortSnapshotFailure);
        }
        throw markedError;
      }
      // an interrupted acknowledgement cannot prove the operator did not accept the
      // cancellation. private status reconciles the durable intent on the next refresh.
    }
    kick();
    } finally {
      if (sealedBuild) sealedBuild.response_key = "";
      if (generation === sessionGeneration) cancellationsInFlight.delete(operationId);
    }
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
    let changed = false;
    for (const commitment of order.funding_notes) {
      const note = noteByCommitment(commitment);
      if (note) {
        changed ||= !note.spent || note.locked_by !== undefined;
        note.spent = true;
        note.locked_by = undefined;
      }
    }
    return changed;
  }

  function recordOrderRemoval(order: StoredOrder, removal: NonNullable<OrderEvent["report"]["removal"]>) {
    order.reported_removal = removal;
    if (removal === "Cancelled" || removal === "Recovered") {
      order.cancel_requested = true;
      order.state = "cancelling";
    }
    order.updated_at_ms = Date.now();
  }

  /** folds the operator's report of each transition into the order. */
  function applyEvents(order: StoredOrder, events: OrderEvent[]) {
    validateOrderEvents(order, events);
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
        recordOrderRemoval(order, report.removal);
      } else if (order.state === "pending" || order.state === "submitting") {
        order.state = "live";
      }
      order.updated_at_ms = Date.now();
      changed = true;
    }
    return changed;
  }

  function validateOrderEvents(order: StoredOrder, events: OrderEvent[]) {
    const fields = [
      "external_base",
      "external_quote",
      "fill_base",
      "fill_quote",
      "fee",
      "proceeds",
      "refund",
      "reserved",
    ] as const;
    let lastSeq = order.seen_seqs.length > 0 ? Math.max(...order.seen_seqs) : 0;
    let filledBase = BigInt(order.filled_base);
    let lockedInput = BigInt(order.locked_input);
    for (const event of events) {
      if (order.seen_seqs.includes(event.seq)) continue;
      if (
        !Number.isSafeInteger(event.seq)
        || event.seq <= lastSeq
        || !Number.isSafeInteger(event.close_time_ms)
        || event.close_time_ms < 0
        || normalizeFeltForComparison(event.report.order_id)
          !== normalizeFeltForComparison(order.order_id)
        || fields.some((field) => !isDecimal(event.report[field]))
      ) throw new Error("The operator returned a malformed order event.");
      const baseFill = BigInt(event.report.fill_base) + BigInt(event.report.external_base);
      const inputFill = order.side === "Sell"
        ? baseFill
        : BigInt(event.report.fill_quote) + BigInt(event.report.external_quote);
      filledBase += baseFill;
      if (filledBase > BigInt(order.amount) || inputFill > lockedInput) {
        throw new Error("The operator returned an order fill beyond the authorized amount.");
      }
      lockedInput -= inputFill;
      lastSeq = event.seq;
    }
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
    const sessionGeneration = generation;
    const { client } = unlocked();
    const orders = followedOrders();
    const exits = followedExits();
    if (orders.length === 0 && exits.length === 0) return null;
    const registry = await executionKeys();
    ensureCurrent(sessionGeneration);
    const built = parseWalletJson(await awaitOwnedClient(
      sessionGeneration,
      client,
      client.buildStatusRequests(JSON.stringify({
      registry,
      orders: orders.map((order) => ({ order_id: order.order_id, after_seq: order.seen_seqs.length > 0 ? Math.max(...order.seen_seqs) : 0 })),
      nullifiers: exits.map((note) => note.nullifier),
      })),
    )) as SealedBuild[];
    try {
      if (!Array.isArray(built) || built.length === 0 || built.length > Math.ceil((orders.length + exits.length) / 8)) {
        throw new Error("The wallet did not build a valid status request set.");
      }
      const request = built[statusChunkCursor % built.length];
      assertSealedBuild(request, registry.keys[0].key_id);
      statusChunkCursor = (statusChunkCursor + 1) % built.length;
      const statusRequest = exchange().status(request.sealed, request.response_key);
      const answer = await awaitCurrent(sessionGeneration, statusRequest);
      return requireStatusAnswer(
        answer,
        orders.map((order) => order.order_id),
        exits.map((note) => note.nullifier),
      );
    } finally {
      if (Array.isArray(built)) {
        for (const candidate of built) {
          if (isRecord(candidate) && typeof candidate.response_key === "string") {
            candidate.response_key = "";
          }
        }
      }
    }
  }

  async function refreshOrders(status: StatusAnswer | null) {
    if (!status) return false;
    const sessionGeneration = generation;
    const byId = new Map(status.orders.map((entry) => [normalizeFeltForComparison(entry.order_id), entry]));
    let changed = false;
    for (const order of followedOrders()) {
      const entry = byId.get(normalizeFeltForComparison(order.order_id));
      if (!entry) continue;
      if (entry.status === "unknown") {
        changed = (await resolveUnknownOrder(order, sessionGeneration)) || changed;
        continue;
      }
      const admissionClaimed = entry.status === "live"
        || entry.status === "closed"
        || entry.events.length > 0;
      if (admissionClaimed && !authenticatedAdmissions.has(normalizeFeltForComparison(order.order_id))) {
        const admission = await fundingAdmissionState(order, sessionGeneration);
        ensureCurrent(sessionGeneration);
        if (admission === "unused") {
          if (entry.status === "closed") {
            releaseFunding(order);
            const nextState = unadmittedOrderState(order, Date.now());
            setOrder(order, {
              state: nextState,
              closed_seq: order.scan_after_seq,
              closed_seq_authenticated: true,
              last_error: nextState === "failed" ? "The operator reported a closure that was not applied on-chain." : undefined,
            });
            changed = true;
          } else if (entry.cancel_requested && !order.cancel_requested) {
            setOrder(order, { state: "cancelling", cancel_requested: true });
            changed = true;
          }
          continue;
        }
        if (admission === "conflict") {
          setOrder(order, {
            state: "failed",
            last_error: "The funding notes have conflicting on-chain spend states. Restore this wallet from a known-good recovery snapshot before moving funds.",
          });
          changed = true;
          continue;
        }
        authenticatedAdmissions.add(normalizeFeltForComparison(order.order_id));
        changed = spendFunding(order) || changed;
      }
      changed = applyEvents(order, entry.events) || changed;
      // a closed order whose removing event the wallet never saw (its history was pruned, or
      // the wallet was restored from an old backup) closes from the operator's tombstone.
      if (entry.status === "closed" && !entry.more_events && entry.removal && OPEN_STATES.has(order.state)) {
        recordOrderRemoval(order, entry.removal);
        changed = true;
        continue;
      }
      if (entry.status === "live" || entry.status === "pending") {
        const nextCancelRequested = entry.cancel_requested;
        const nextState = nextCancelRequested
          ? "cancelling"
          : entry.status === "live"
            ? "live"
            : "pending";
        if (order.cancel_requested !== nextCancelRequested || order.state !== nextState) {
          setOrder(order, {
            cancel_requested: nextCancelRequested || undefined,
            state: nextState,
          });
          changed = true;
        }
      }
    }
    return changed;
  }

  /** an order the operator does not know: its funding nullifiers say whether it was ever admitted. */
  async function resolveUnknownOrder(order: StoredOrder, sessionGeneration: number) {
    if (Date.now() - order.submitted_at_ms < UNKNOWN_ORDER_GRACE_MS && !order.cancel_requested) return false;
    const admission = await fundingAdmissionState(order, sessionGeneration);
    if (admission === "unused") {
      releaseFunding(order);
      const state = unadmittedOrderState(order, Date.now());
      setOrder(order, { state, closed_seq: order.scan_after_seq, closed_seq_authenticated: true, last_error: state === "failed" ? "The operator did not accept this order." : undefined });
      return true;
    }
    if (admission === "conflict") {
      setOrder(order, {
        state: "failed",
        last_error: "The funding notes have conflicting on-chain spend states. Restore this wallet from a known-good recovery snapshot before moving funds.",
      });
      return true;
    }
    // admitted on chain: its outputs arrive through the transition scan. past its expiry it
    // cannot still rest, whatever closed it.
    spendFunding(order);
    authenticatedAdmissions.add(normalizeFeltForComparison(order.order_id));
    const expiry = Number((order.terms as { expiry_ms?: number } | undefined)?.expiry_ms);
    if (expiry <= Date.now()) {
      order.locked_input = "0";
      setOrder(order, { state: "expired" });
    } else if (order.state !== "live") {
      setOrder(order, { state: "live" });
    }
    return true;
  }

  async function fundingAdmissionState(
    order: StoredOrder,
    sessionGeneration: number,
  ): Promise<"unused" | "spent" | "conflict"> {
    const states = await Promise.all(
      order.nullifiers.map((nullifier) => nullifierState(nullifier, sessionGeneration)),
    );
    return fundingAdmissionDisposition(states);
  }

  async function nullifierState(nullifier: string, sessionGeneration: number) {
    const { deployment: manifest } = unlocked();
    const values = await awaitCurrent(
      sessionGeneration,
      starknetCall(manifest.rpc_url, manifest.contracts.exchange, "nullifier_state", [nullifier]),
    );
    if (values.length !== 1 || !normalizeStrictFelt(values[0])) {
      throw new Error("The deployed nullifier state has an unexpected layout.");
    }
    const value = BigInt(values[0]);
    if (value < NULLIFIER_UNUSED || value > NULLIFIER_EXITED) {
      throw new Error("The deployed nullifier state is out of range.");
    }
    return value;
  }

  async function pendingExit(note: WalletNote, sessionGeneration: number) {
    const { deployment: manifest } = unlocked();
    const fields = await awaitCurrent(sessionGeneration, starknetCall(
      manifest.rpc_url,
      manifest.contracts.exchange,
      "pending_exit",
      [note.nullifier],
    ));
    if (fields.length !== 5) throw new Error("The deployed pending exit has an unexpected layout.");
    const amount = onchainInteger(fields[1], MAX_U128);
    const maturesAt = onchainInteger(fields[4], MAX_U64);
    if (
      normalizeFeltForComparison(fields[0]) !== normalizeFeltForComparison(note.fields.asset_id)
      || amount !== BigInt(note.fields.amount)
      || normalizeFeltForComparison(fields[2]) !== normalizeFeltForComparison(note.exit?.exit_commitment)
      || !isNonZeroFelt(fields[3])
      || maturesAt === null
      || maturesAt > BigInt(Number.MAX_SAFE_INTEGER / 1_000)
    ) throw new Error("The deployed pending exit does not match this withdrawal.");
    return Number(maturesAt) * 1_000;
  }

  async function claimedOpenNoteId(exitCommitment: string, sessionGeneration: number) {
    const { deployment: manifest } = unlocked();
    const fields = await awaitCurrent(sessionGeneration, starknetCall(
      manifest.rpc_url,
      manifest.contracts.privacy_deposit_bridge,
      "strk20_exit_claimed_open_note_id",
      [exitCommitment],
    ));
    return parseClaimedOpenNoteId(fields);
  }

  async function readRecoveryCapacity(
    note: ResidualNote,
    sessionGeneration: number,
  ): Promise<RecoveryCapacityView> {
    const { deployment: manifest } = unlocked();
    const fields = await awaitCurrent(
      sessionGeneration,
      starknetCall(manifest.rpc_url, manifest.contracts.exchange, "capacity", [
        String(note.reserved_seq),
        note.pair_id,
        note.sell ? "0x1" : "0x0",
      ]),
    );
    if (fields.length !== 9) throw new Error("The deployed recovery capacity has an unexpected layout.");
    const boundedAmounts = fields.slice(0, 3).concat(fields.slice(4, 7));
    const openedAtValue = onchainInteger(fields[3], MAX_U64);
    const statusValue = onchainInteger(fields[7], 4n);
    const generationValue = onchainInteger(fields[8], MAX_U64);
    if (
      boundedAmounts.some((value) => onchainInteger(value, MAX_U128) === null)
      || openedAtValue === null
      || statusValue === null
      || generationValue === null
    ) {
      throw new Error("The deployed recovery capacity is out of range.");
    }
    const generation = Number(generationValue);
    const status = Number(statusValue);
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(status)) {
      throw new Error("The deployed recovery capacity is out of range.");
    }
    return {
      generation,
      status,
      total: BigInt(fields[1]).toString(),
      scale: BigInt(fields[2]).toString(),
      opened_at: openedAtValue,
      consumed_base: BigInt(fields[4]).toString(),
      pool_quote: BigInt(fields[5]).toString(),
    };
  }

  /** builds the exact public recovery statement from chain-indexed data only. */
  async function prepareResidualRecovery(orderId: string): Promise<ResidualRecoveryPreparation> {
    const sessionGeneration = generation;
    const { client, deployment: manifest } = unlocked();
    const order = orderById(orderId);
    if (!order?.residual) throw new Error("This order has no recoverable residual state.");

    const residual = requireStoredResidual(order.residual);
    const pairFields = await awaitCurrent(sessionGeneration, starknetCall(
      manifest.rpc_url,
      manifest.contracts.exchange,
      "pair_config",
      [residual.note.pair_id],
    ));
    const configuredPair = pairConfig(order.pair);
    const registryPair = manifest.market_registry.markets.find(
      (candidate) => candidate.market_id === configuredPair.pair_id,
    );
    if (!registryPair?.enabled) {
      throw new Error("The manifest omits the recovery market.");
    }
    const {
      baseAsset,
      quoteAsset,
      priceBaseScale,
      feeBps,
      externalSupport,
      referenceMethodology,
      derivationBaseMarketId,
      derivationQuoteMarketId,
      maxLegSkew,
    } = parseOnchainPairConfig(pairFields);
    const marketIds = call<{ pair_id: string; base_asset_id: string; quote_asset_id: string }>(core.zylith_wallet_market_ids, {
      pair: configuredPair.pair_id,
      base_asset: configuredPair.base_asset_id,
      quote_asset: configuredPair.quote_asset_id,
    });
    const reference = registryPair.reference_price;
    const synthetic = reference.methodology === "synthetic_cross_bbo_midpoint";
    const marketId = (pairId: string) => {
      const market = manifest.market_registry.markets.find((candidate) => candidate.market_id === pairId);
      if (!market) throw new Error("The manifest omits a recovery reference market.");
      return call<{ pair_id: string }>(core.zylith_wallet_market_ids, {
        pair: market.market_id,
        base_asset: market.base_asset_id,
        quote_asset: market.quote_asset_id,
      }).pair_id;
    };
    const expectedDerivationBase = synthetic ? marketId(reference.base_market_id) : "0x0";
    const expectedDerivationQuote = synthetic ? marketId(reference.quote_market_id) : "0x0";
    const expectedMaxLegSkew = synthetic ? BigInt(reference.max_leg_skew_ms) : 0n;
    if (
      normalizeFeltForComparison(baseAsset ?? "0") !== normalizeFeltForComparison(marketIds.base_asset_id)
      || normalizeFeltForComparison(quoteAsset ?? "0") !== normalizeFeltForComparison(marketIds.quote_asset_id)
      || normalizeFeltForComparison(residual.note.pair_id) !== normalizeFeltForComparison(marketIds.pair_id)
      || normalizeFeltForComparison(residual.note.input_asset_id) !== normalizeFeltForComparison(
        residual.note.sell ? marketIds.base_asset_id : marketIds.quote_asset_id,
      )
      || priceBaseScale !== BigInt(configuredPair.price_base_scale)
      || externalSupport !== BigInt(configuredPair.external_settlement_support_quote)
      || referenceMethodology !== (synthetic ? 1n : 0n)
      || normalizeFeltForComparison(derivationBaseMarketId) !== normalizeFeltForComparison(expectedDerivationBase)
      || normalizeFeltForComparison(derivationQuoteMarketId) !== normalizeFeltForComparison(expectedDerivationQuote)
      || maxLegSkew !== expectedMaxLegSkew
    ) {
      throw new Error("The deployed pair configuration does not match this wallet's manifest.");
    }
    if (feeBps > 100n || feeBps !== BigInt(configuredPair.taker_fee_bps)) {
      throw new Error("The deployed recovery fee does not match this wallet's manifest.");
    }

    let membership: { note_root: string; membership: unknown };
    if (residual.note_root && residual.membership !== undefined) {
      membership = { note_root: residual.note_root, membership: residual.membership };
    } else {
      // local state restored without cached membership reconstructs it from the
      // exact on-chain note-batch history through this transition.
      const [windowStart, windowEnd] = transitionWindows(residual.seq, residual.seq)[0];
      const transitionList = await awaitCurrent(
        sessionGeneration,
        exchange().transitions(windowStart, windowEnd),
      );
      const transition = requireTransitionRange(transitionList, windowStart, windowEnd)
        .find((entry) => entry.seq === residual.seq);
      if (!transition) throw new Error("The public chain index is missing the residual transition.");
      await authenticateTransitionOutputRoots([transition], sessionGeneration);
      ensureCurrent(sessionGeneration);
      const batchRoots = await noteBatchRootsThrough(transition.note_batch_index, sessionGeneration);
      ensureCurrent(sessionGeneration);
      membership = call(core.zylith_wallet_build_note_membership, {
        batch_roots: batchRoots,
        batch_index: transition.note_batch_index,
        batch_leaves: transition.outputs.map((record) => record.leaf),
        leaf_index: residual.index,
      });
      residual.note_root = membership.note_root;
      residual.membership = membership.membership;
      await saveState();
      await pushRecoverySnapshot(true).catch(bestEffortSnapshotFailure);
    }
    let capacity = { generation: 0, status: 0, total: "0", consumed_base: "0", pool_quote: "0", scale: "0" };
    if (BigInt(residual.note.reserved) !== 0n) {
      const view = await readRecoveryCapacity(residual.note, sessionGeneration);
      ensureCurrent(sessionGeneration);
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
    const built = parseWalletJson(await awaitOwnedClient(
      sessionGeneration,
      client,
      client.buildResidualRecovery(JSON.stringify({
        note_root: membership.note_root,
        note: residual.note,
        membership: membership.membership,
        output_asset_id: outputAssetId,
        fee_bps: feeBps.toString(),
        capacity,
        input_exit_commitment: prepared?.input_exit_commitment ?? undefined,
        output_exit_commitment: prepared?.output_exit_commitment ?? undefined,
      })),
    )) as {
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
    };
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
    await requireRecoverySnapshot();
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
        calldata: [String(built.witness.length), ...built.witness],
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

  async function pendingResidualExit(nullifier: string, sessionGeneration: number) {
    const { deployment: manifest } = unlocked();
    return parsePendingResidualExit(
      await awaitCurrent(sessionGeneration, starknetCall(
        manifest.rpc_url,
        manifest.contracts.exchange,
        "pending_residual_exit",
        [nullifier],
      )),
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
    const sessionGeneration = generation;
    const { client, deployment: manifest } = unlocked();
    const prepared = await prepareResidualRecovery(orderId);
    ensureCurrent(sessionGeneration);
    const order = orderById(orderId);
    if (!order?.residual_recovery) throw new Error("The residual recovery was not persisted.");
    const persisted = order.residual_recovery;
    const current = await nullifierState(prepared.nullifier, sessionGeneration);
    ensureCurrent(sessionGeneration);
    if (current === NULLIFIER_EXIT_PENDING || current === NULLIFIER_EXITED) {
      const pending = await pendingResidualExit(prepared.nullifier, sessionGeneration);
      ensureCurrent(sessionGeneration);
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
        sessionGeneration,
      );
      ensureCurrent(sessionGeneration);
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
    if (persisted.request_submitted_at_ms) {
      return {
        nullifier: prepared.nullifier,
        transaction_hash: null,
        already_requested: true,
      };
    }
    const rail = selectedResidualRecoveryFundingRail(manifest);
    const chainId = proofSignerContextFelt(manifest.chain_id, "chain_id");
    const recoveryWalletAddress = requiredNonZeroFelt(
      activeWalletAddress,
      "connected_wallet_address",
    );
    const proofSignerMaterial = parseWalletProofSignerMaterial(await awaitOwnedClient(
      sessionGeneration,
      client,
      client.deriveProofSigner(JSON.stringify({
        proof_signer_class_hash: proofSignerContextFelt(
          rail.privacyProofSignerClassHash,
          "privacy_proof_signer_class_hash",
        ),
      })),
    ));
    let result: { transactionHash: string };
    try {
      try {
        ensureCurrent(sessionGeneration);
        const provider = await awaitCurrent(
          sessionGeneration,
          selectInjectedStarknetProvider(activeWalletAddress, () => ensureCurrent(sessionGeneration)),
        );
        const connectedChainId = await awaitCurrent(
          sessionGeneration,
          readStarknetWalletChainId(provider as never),
        );
        if (proofSignerContextFelt(connectedChainId, "connected_chain_id") !== chainId) {
          throw new Error("Connected Starknet wallet chain does not match the deployment network.");
        }
        const { submitResidualRecovery: submit } = await awaitCurrent(
          sessionGeneration,
          import("./integrations/starknetPrivacyFunding"),
        );
        result = await awaitCurrent(sessionGeneration, submit({
          provider: provider as never,
          ...proofSignerMaterial,
          chainId: proofSignerContextFelt(manifest.chain_id, "chain_id"),
          rpcUrl: requiredString(manifest.rpc_url, "rpc_url"),
          provingUrl: serviceUrl(rail.provingUrl, "/starknet-privacy-prover"),
          provingOhttpPolicy: rail.provingOhttpPolicy,
          paymasterAddress: requiredNonZeroFelt(rail.paymasterAddress, "privacy_paymaster_address"),
          paymasterUrl: requiredString(rail.paymasterUrl, "privacy_paymaster_url"),
          privacyProofSignerClassHash: proofSignerContextFelt(
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
          assertWalletContext: async () => {
            ensureCurrent(sessionGeneration);
            const currentAddress = connectedProviderAddress(provider as never)
              ?? connectedStarknetAddress();
            if (
              !currentAddress
              || normalizeFeltForComparison(currentAddress)
                !== normalizeFeltForComparison(recoveryWalletAddress)
            ) {
              throw new Error("Connected Starknet wallet changed during residual recovery.");
            }
            const currentChainId = await awaitCurrent(
              sessionGeneration,
              readStarknetWalletChainId(provider as never),
            );
            if (proofSignerContextFelt(currentChainId, "connected_chain_id") !== chainId) {
              throw new Error("Connected Starknet wallet chain changed during residual recovery.");
            }
          },
        }));
      } finally {
        proofSignerMaterial.proofSignerPrivateKey = "";
      }
    } catch (error) {
      ensureCurrent(sessionGeneration);
      if (proofSubmissionStarted(error)) {
        persisted.request_submitted_at_ms = Date.now();
        order.updated_at_ms = persisted.request_submitted_at_ms;
        await saveState();
        void pushRecoverySnapshot(true).catch(() => false);
      }
      throw error;
    }
    ensureCurrent(sessionGeneration);
    persisted.request_transaction_hash = result.transactionHash;
    persisted.request_submitted_at_ms = Date.now();
    order.updated_at_ms = persisted.request_submitted_at_ms;
    await saveState();
    await pushRecoverySnapshot(true).catch(bestEffortSnapshotFailure);
    return {
      nullifier: prepared.nullifier,
      transaction_hash: result.transactionHash,
      already_requested: false,
    };
  }

  /** finalizes a mature residual exit; any caller may submit this ordinary transaction. */
  async function finalizeResidualRecovery(orderId: string): Promise<ResidualRecoveryFinalization> {
    const sessionGeneration = generation;
    const { deployment: manifest } = unlocked();
    const order = orderById(orderId);
    const prepared = order?.residual_recovery;
    if (!order || !prepared) throw new Error("Prepare and request this residual recovery first.");
    const current = await nullifierState(prepared.nullifier, sessionGeneration);
    const pending = await pendingResidualExit(prepared.nullifier, sessionGeneration);
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
        sessionGeneration,
      );
      ensureCurrent(sessionGeneration);
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
    const provider = await awaitCurrent(
      sessionGeneration,
      selectInjectedStarknetProvider(activeWalletAddress, () => ensureCurrent(sessionGeneration)),
    );
    const result = await awaitCurrent(sessionGeneration, executeStarknetWalletCall(provider, {
      contractAddress: manifest.contracts.exchange,
      entrypoint: "finalize_residual_recovery",
      calldata: [prepared.nullifier],
    }));
    const finalizationHash = transactionHash(result);
    if (!finalizationHash) throw new Error("The wallet did not return a recovery-finalization transaction hash.");
    prepared.finalization_transaction_hash = finalizationHash;
    prepared.finalization_submitted_at_ms = Date.now();
    order.updated_at_ms = prepared.finalization_submitted_at_ms;
    await saveState();
    await pushRecoverySnapshot(true).catch(bestEffortSnapshotFailure);
    return {
      nullifier: prepared.nullifier,
      transaction_hash: prepared.finalization_transaction_hash ?? null,
      already_final: false,
      matures_at: pending.matures_at,
    };
  }

  /** claims the user-owned legs staged by a finalized residual recovery. */
  async function claimResidualRecovery(orderId: string): Promise<ResidualRecoveryClaim> {
    const sessionGeneration = generation;
    const { deployment: manifest } = unlocked();
    const order = orderById(orderId);
    const prepared = order?.residual_recovery;
    if (!order || !prepared) throw new Error("This order has no prepared residual recovery.");
    if ((await nullifierState(prepared.nullifier, sessionGeneration)) !== NULLIFIER_EXITED) {
      throw new Error("Finalize the residual recovery before claiming its assets.");
    }
    const pending = await pendingResidualExit(prepared.nullifier, sessionGeneration);
    assertPendingResidualMatches(prepared, pending);
    const outputAsset = order.side === "Sell" ? order.quote_asset : order.base_asset;

    const claim = async (
      asset: string,
      assetId: string,
      amount: string,
      exitCommitment: string | null,
      onSubmitted: (result: { transactionHash: string }) => Promise<void>,
    ) => {
      if (BigInt(amount) === 0n) return null;
      if (!exitCommitment) throw new Error("A nonzero residual leg is missing its exit authority.");
      const alreadyClaimed = await claimedOpenNoteId(exitCommitment, sessionGeneration);
      if (alreadyClaimed) return null;
      const result = await submitExitClaimToWallet({
        manifest,
        asset,
        assetId,
        amount,
        exitCommitment,
        sessionGeneration,
      });
      ensureCurrent(sessionGeneration);
      await onSubmitted(result);
      return result;
    };

    if (prepared.input_claim_transaction_hash) {
      const disposition = await recoveryTransactionState(
        prepared.input_claim_transaction_hash,
        prepared.input_claim_submitted_at_ms ?? order.updated_at_ms,
        sessionGeneration,
      );
      ensureCurrent(sessionGeneration);
      if (disposition === "retry") {
        prepared.input_claim_transaction_hash = undefined;
        prepared.input_claim_submitted_at_ms = undefined;
      }
    }
    if (!prepared.input_claim_transaction_hash) {
      const result = await claim(
        order.funding_asset,
        prepared.input_asset_id,
        prepared.input_amount,
        prepared.input_exit_commitment,
        async (submitted) => {
          prepared.input_claim_transaction_hash = submitted.transactionHash;
          prepared.input_claim_submitted_at_ms = Date.now();
          order.updated_at_ms = prepared.input_claim_submitted_at_ms;
          await saveState();
          void pushRecoverySnapshot(true).catch(() => false);
        },
      );
      prepared.input_claim_transaction_hash = result?.transactionHash;
      prepared.input_claim_submitted_at_ms = prepared.input_claim_transaction_hash ? Date.now() : undefined;
      order.updated_at_ms = prepared.input_claim_submitted_at_ms ?? Date.now();
      await saveState();
      if (result) {
        void pushRecoverySnapshot(true).catch(() => false);
      }
    }
    if (prepared.output_claim_transaction_hash) {
      const disposition = await recoveryTransactionState(
        prepared.output_claim_transaction_hash,
        prepared.output_claim_submitted_at_ms ?? order.updated_at_ms,
        sessionGeneration,
      );
      ensureCurrent(sessionGeneration);
      if (disposition === "retry") {
        prepared.output_claim_transaction_hash = undefined;
        prepared.output_claim_submitted_at_ms = undefined;
      }
    }
    if (!prepared.output_claim_transaction_hash) {
      const result = await claim(
        outputAsset,
        prepared.output_asset_id,
        prepared.output_amount,
        prepared.output_exit_commitment,
        async (submitted) => {
          prepared.output_claim_transaction_hash = submitted.transactionHash;
          prepared.output_claim_submitted_at_ms = Date.now();
          order.updated_at_ms = prepared.output_claim_submitted_at_ms;
          await saveState();
          void pushRecoverySnapshot(true).catch(() => false);
        },
      );
      prepared.output_claim_transaction_hash = result?.transactionHash;
      prepared.output_claim_submitted_at_ms = prepared.output_claim_transaction_hash ? Date.now() : undefined;
      order.updated_at_ms = prepared.output_claim_submitted_at_ms ?? Date.now();
      await saveState();
      if (result) {
        void pushRecoverySnapshot(true).catch(() => false);
      }
    }
    order.updated_at_ms = Date.now();
    await pushRecoverySnapshot(true).catch(bestEffortSnapshotFailure);
    return {
      input_transaction_hash: prepared.input_claim_transaction_hash ?? null,
      output_transaction_hash: prepared.output_claim_transaction_hash ?? null,
    };
  }

  /** establishes the permissionless on-chain cutoff for an expired external reservation. */
  async function freezeResidualRecoveryCapacity(orderId: string) {
    const sessionGeneration = generation;
    const { deployment: manifest } = unlocked();
    const order = orderById(orderId);
    const residual = order?.residual ? requireStoredResidual(order.residual) : undefined;
    if (!order || !residual || BigInt(residual.note.reserved) === 0n) {
      throw new Error("This order has no external capacity to freeze.");
    }
    const capacity = await readRecoveryCapacity(residual.note, sessionGeneration);
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
        sessionGeneration,
      );
      ensureCurrent(sessionGeneration);
      if (disposition !== "retry") {
        return {
          transaction_hash: pendingFreeze.transaction_hash,
          already_final: false,
        };
      }
      order.residual_capacity_freeze = undefined;
      await saveState();
    }
    const provider = await awaitCurrent(
      sessionGeneration,
      selectInjectedStarknetProvider(activeWalletAddress, () => ensureCurrent(sessionGeneration)),
    );
    const result = await awaitCurrent(sessionGeneration, executeStarknetWalletCall(provider, {
      contractAddress: manifest.contracts.exchange,
      entrypoint: "freeze_expired_capacity",
      calldata: [
        String(residual.note.reserved_seq),
        residual.note.pair_id,
        residual.note.sell ? "0x1" : "0x0",
        String(capacity.generation),
      ],
    }));
    const hash = transactionHash(result);
    if (!hash) throw new Error("The wallet did not return a capacity-freeze transaction hash.");
    order.residual_capacity_freeze = {
      residual_seq: residual.seq,
      transaction_hash: hash,
      submitted_at_ms: Date.now(),
    };
    order.updated_at_ms = order.residual_capacity_freeze.submitted_at_ms;
    await saveState();
    await pushRecoverySnapshot(true).catch(bestEffortSnapshotFailure);
    return {
      transaction_hash: hash,
      already_final: false,
    };
  }

  /** recovers every open order's outputs from the transitions settled since the last scan. */
  async function scanTransitions() {
    const sessionGeneration = generation;
    // only orders that can still have unrecovered outputs are scanned, from the earliest seq
    // any of them still needs.
    const scanning = state.orders.filter(
      (order) => order.state !== "failed" && order.closed_seq_authenticated !== true,
    );
    if (scanning.length === 0) return false;
    const from = Math.min(...scanning.map((order) => Math.max(order.scan_after_seq, state.scanned_seq)));
    const status = requireIndexerStatus(
      await awaitCurrent(sessionGeneration, exchange().indexerStatus()),
    );
    if (status.latest_seq <= from) return false;
    const latestSeq = Math.min(status.latest_seq, from + MAX_TRANSITION_SCAN_SEQS);
    const transitions: TransitionOutputs[] = [];
    for (const [windowStart, windowEnd] of transitionWindows(from + 1, latestSeq)) {
      const range = await awaitCurrent(
        sessionGeneration,
        exchange().transitions(windowStart, windowEnd),
      );
      transitions.push(...requireTransitionRange(range, windowStart, windowEnd)
        .filter((transition) => transition.seq > from && transition.seq <= latestSeq));
    }
    transitions.sort((left, right) => left.seq - right.seq);
    transitions.forEach((transition, index) => {
      if (transition.seq !== from + index + 1) {
        throw new Error("The chain indexer is missing a settled transition.");
      }
    });
    if (transitions.length !== latestSeq - from) {
      throw new Error("The chain indexer is missing a settled transition.");
    }
    await authenticateTransitionOutputRoots(transitions, sessionGeneration);
    ensureCurrent(sessionGeneration);
    let changed = false;
    const maxBatchIndex = Math.max(...transitions.map((transition) => transition.note_batch_index));
    let batchRoots: Promise<string[]> | undefined;
    const recoveryBatchRoots = () => {
      batchRoots ??= noteBatchRootsThrough(maxBatchIndex, sessionGeneration);
      return batchRoots;
    };
    for (const order of scanning) {
      const relevant = transitions.filter(
        (transition) => transition.seq > Math.max(order.scan_after_seq, state.scanned_seq),
      );
      if (relevant.length === 0) continue;
      changed = (await recoverOutputs(order, relevant, recoveryBatchRoots, sessionGeneration)) || changed;
    }
    ensureCurrent(sessionGeneration);
    state.scanned_seq = Math.max(state.scanned_seq, latestSeq);
    return changed || transitions.length > 0;
  }

  async function authenticateTransitionOutputRoots(
    transitions: TransitionOutputs[],
    sessionGeneration: number,
  ) {
    const indexes = [...new Set(transitions.map((transition) => transition.note_batch_index))]
      .sort((left, right) => left - right);
    const roots = new Map<number, string>();
    for (let offset = 0; offset < indexes.length;) {
      const start = indexes[offset];
      let end = start;
      while (offset + 1 < indexes.length && indexes[offset + 1] === end + 1 && end - start < 255) {
        offset += 1;
        end = indexes[offset];
      }
      const batch = await readOnchainNoteBatchRoots(start, end, sessionGeneration);
      batch.forEach((root, index) => roots.set(start + index, root));
      offset += 1;
    }
    for (const transition of transitions) {
      const computed = call<string>(core.zylith_wallet_transition_output_root, {
        outputs: transition.outputs,
      });
      if (
        normalizeFeltForComparison(computed) !== normalizeFeltForComparison(transition.output_root)
        || normalizeFeltForComparison(roots.get(transition.note_batch_index))
          !== normalizeFeltForComparison(transition.output_root)
      ) throw new Error("The chain indexer transition does not match the deployed output root.");
    }
  }

  async function noteBatchRootsThrough(lastIndex: number, sessionGeneration: number) {
    if (!isSafeNonNegativeInteger(lastIndex)) {
      throw new Error("The note-batch membership position is invalid.");
    }
    const { deployment: manifest } = unlocked();
    const countFields = await awaitCurrent(sessionGeneration, starknetCall(
      manifest.rpc_url,
      manifest.contracts.exchange,
      "note_batch_count",
      [],
    ));
    if (countFields.length !== 1 || !normalizeStrictFelt(countFields[0])) {
      throw new Error("The deployed note-batch count has an unexpected layout.");
    }
    const count = BigInt(countFields[0]);
    if (BigInt(lastIndex) >= count) {
      throw new Error("The requested note batch is not present on-chain.");
    }
    const roots: string[] = [];
    for (let start = 0; start <= lastIndex; start += 256) {
      const end = Math.min(start + 255, lastIndex);
      roots.push(...await readOnchainNoteBatchRoots(start, end, sessionGeneration));
    }
    return roots;
  }

  async function readOnchainNoteBatchRoots(
    start: number,
    end: number,
    sessionGeneration: number,
  ) {
    const { deployment: manifest } = unlocked();
    const fields = await awaitCurrent(sessionGeneration, starknetCall(
      manifest.rpc_url,
      manifest.contracts.exchange,
      "note_batch_roots",
      [String(start), String(end)],
    ));
    const expected = end - start + 1;
    if (
      fields.length !== expected + 1
      || !normalizeStrictFelt(fields[0])
      || BigInt(fields[0]) !== BigInt(expected)
      || fields.slice(1).some((root) => !normalizeStrictFelt(root))
    ) throw new Error("The deployed note-batch roots have an unexpected layout.");
    return fields.slice(1);
  }

  async function recoverOutputs(
    order: StoredOrder,
    transitions: TransitionOutputs[],
    recoveryBatchRoots: () => Promise<string[]>,
    sessionGeneration: number,
  ) {
    const recovered = call<Array<{ seq: number; kind: number; index: number; note: NoteFields }>>(core.zylith_wallet_recover_order_outputs, {
      terms: order.terms,
      base_asset: order.base_asset,
      quote_asset: order.quote_asset,
      transitions: transitions.map((transition) => ({ seq: transition.seq, outputs: transition.outputs as OutputRecord[] })),
    });
    if (!Array.isArray(recovered) || recovered.length > transitions.length * 2) {
      throw new Error("The wallet returned malformed recovered outputs.");
    }
    const transitionBySeq = new Map(transitions.map((transition) => [transition.seq, transition]));
    const recoveredIndexes = new Set<string>();
    for (const output of recovered) {
      const transition = transitionBySeq.get(output.seq);
      const outputKey = `${output.seq}:${output.index}`;
      if (
        !transition
        || !isSafeNonNegativeInteger(output.index)
        || output.index >= transition.outputs.length
        || (output.kind !== OUTPUT_KIND_PROCEEDS && output.kind !== OUTPUT_KIND_REFUND)
        || recoveredIndexes.has(outputKey)
      ) throw new Error("The wallet returned malformed recovered outputs.");
      recoveredIndexes.add(outputKey);
    }
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
    residuals.sort((left, right) => right.seq - left.seq || right.index - left.index);
    if (residuals.length > 1 && residuals[0].seq === residuals[1].seq) {
      throw new Error("The wallet recovered conflicting residual authorities for one transition.");
    }
    const latestResidual = residuals[0];
    if (latestResidual && (!order.residual || latestResidual.seq > order.residual.seq)) {
      const transition = transitions.find((entry) => entry.seq === latestResidual.seq);
      if (!transition) throw new Error("The public chain index omitted the residual transition.");
      const batchRoots = await recoveryBatchRoots();
      ensureCurrent(sessionGeneration);
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
    const terminalSequence = authenticatedTerminalSequence(recovered, residuals);
    if (terminalSequence !== undefined) {
      order.closed_seq = terminalSequence;
      order.closed_seq_authenticated = true;
      order.locked_input = "0";
      order.residual = undefined;
      if (OPEN_STATES.has(order.state)) {
        const terminalOutputs = recovered.filter((output) => output.seq === terminalSequence);
        const reported = order.reported_removal;
        const hasProceeds = terminalOutputs.some((output) => output.kind === OUTPUT_KIND_PROCEEDS);
        const expiry = Number((order.terms as { expiry_ms?: number } | undefined)?.expiry_ms);
        order.state = reported === "Cancelled" || reported === "Recovered" || order.cancel_requested
          ? "cancelled"
          : reported === "Expired" || (!hasProceeds && Number.isSafeInteger(expiry) && expiry <= Date.now())
            ? "expired"
            : "filled";
      }
      order.reported_removal = undefined;
      order.updated_at_ms = Date.now();
      changed = true;
    }
    if (recovered.length > 0 || residuals.length > 0) {
      authenticatedAdmissions.add(normalizeFeltForComparison(order.order_id));
      changed = spendFunding(order) || changed;
    }
    return changed;
  }

  // withdrawals

  function withdrawalAvailable() {
    return Boolean(deployment && strk20WithdrawalEnabledForDeployment(deployment));
  }

  async function withdraw(noteCommitment: string) {
    const operationId = normalizeFeltForComparison(noteCommitment);
    if (withdrawalsInFlight.has(operationId)) throw new Error("This withdrawal is already in progress.");
    withdrawalsInFlight.add(operationId);
    const sessionGeneration = generation;
    let sealedBuild: SealedBuild | null = null;
    try {
    const { client } = unlocked();
    if (!withdrawalAvailable()) throw new Error("Withdrawals are not configured for this deployment.");
    const note = noteByCommitment(noteCommitment);
    if (!note || !(spendable(note) || note.exit?.stage === "failed")) throw new Error("This note cannot be withdrawn");
    const previousExit = note.exit ? structuredClone(note.exit) : undefined;
    const registry = await executionKeys();
    ensureCurrent(sessionGeneration);
    const built = parseWalletJson(await awaitOwnedClient(
      sessionGeneration,
      client,
      client.buildWithdrawRequest(JSON.stringify({
      note: note.fields,
      exit_commitment: note.exit?.exit_commitment,
      registry,
      })),
    )) as SealedBuild & { nullifier: string; exit_commitment: string };
    sealedBuild = built;
    assertSealedBuild(built, registry.keys[0].key_id, ["nullifier", "exit_commitment"]);
    if (
      normalizeFeltForComparison(built.nullifier) !== normalizeFeltForComparison(note.nullifier)
      || !isNonZeroFelt(built.exit_commitment)
      || (note.exit?.exit_commitment
        && normalizeFeltForComparison(built.exit_commitment) !== normalizeFeltForComparison(note.exit.exit_commitment))
    ) throw new Error("The wallet produced an inconsistent withdrawal request.");
    note.exit = { exit_commitment: built.exit_commitment, stage: "requested", requested_at_ms: Date.now() };
    await saveState();
    try {
      await requireRecoverySnapshot();
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      ensureCurrent(sessionGeneration);
      const current = noteByCommitment(note.commitment);
      if (current) current.exit = previousExit;
      await saveState();
      throw error;
    }
    try {
      await submitSealed(built, sessionGeneration);
      ensureCurrent(sessionGeneration);
    } catch (error) {
      if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
      ensureCurrent(sessionGeneration);
      if (definitiveRejection(error)) {
        const markedError = markDefinitiveSubmissionFailure(error);
        note.exit = {
          ...note.exit,
          stage: "failed",
          failure: failureText(normalizeFailure(markedError, {
            domain: "withdrawal",
            operation: "withdrawal",
            stage: "withdrawal-submission",
          })),
        };
        await saveState();
        await pushRecoverySnapshot(true).catch(bestEffortSnapshotFailure);
        throw markedError;
      }
      throw error;
    }
    kick();
    return { nullifier: built.nullifier };
    } finally {
      if (sealedBuild) sealedBuild.response_key = "";
      if (generation === sessionGeneration) withdrawalsInFlight.delete(operationId);
    }
  }

  async function refreshWithdrawals(status: StatusAnswer | null) {
    const sessionGeneration = generation;
    const byNullifier = new Map((status?.withdrawals ?? []).map((entry) => [normalizeFeltForComparison(entry.nullifier), entry]));
    let changed = false;
    for (const note of state.notes.filter((candidate) => candidate.exit && !candidate.spent && candidate.exit.stage !== "failed")) {
      const exit = note.exit!;
      if (exit.stage === "claiming") {
        changed = (await settleClaim(note, sessionGeneration)) || changed;
        continue;
      }
      if (exit.stage !== "finalized") {
        const statusEntry = byNullifier.get(normalizeFeltForComparison(note.nullifier));
        const stage = statusEntry?.stage;
        if (stage && typeof stage === "object" && "Failed" in stage) {
          const chainState = await nullifierState(note.nullifier, sessionGeneration);
          if (chainState === NULLIFIER_UNUSED) {
            note.exit = { ...exit, stage: "failed", failure: stage.Failed.reason };
            changed = true;
            continue;
          }
          if (chainState === NULLIFIER_EXITED) {
            note.exit = { ...exit, stage: "finalized" };
            changed = true;
          } else if (chainState !== NULLIFIER_EXIT_PENDING) {
            throw new Error("The withdrawal status conflicts with its on-chain nullifier state.");
          }
        }
        if (stage && typeof stage === "object" && "Requested" in stage && exit.stage !== "maturing") {
          note.exit = { ...exit, stage: "maturing", matures_at_ms: stage.Requested.matures_at_ms };
          changed = true;
        } else if (stage === "Proving" && exit.stage === "requested") {
          note.exit = { ...exit, stage: "proving" };
          changed = true;
        }
        const shouldReadChain = statusEntry !== undefined
          || Date.now() - exit.requested_at_ms >= UNKNOWN_WITHDRAWAL_GRACE_MS;
        if (note.exit!.stage !== "finalized" && shouldReadChain) {
          const chainState = await nullifierState(note.nullifier, sessionGeneration);
          if (chainState === NULLIFIER_EXITED) {
            note.exit = { ...note.exit!, stage: "finalized" };
            changed = true;
          } else if (chainState === NULLIFIER_EXIT_PENDING) {
            const maturesAtMs = await pendingExit(note, sessionGeneration);
            if (note.exit!.stage !== "maturing" || note.exit!.matures_at_ms !== maturesAtMs) {
              note.exit = { ...note.exit!, stage: "maturing", matures_at_ms: maturesAtMs };
              changed = true;
            }
          } else if (chainState === NULLIFIER_SPENT) {
            note.spent = true;
            note.exit = { ...note.exit!, stage: "failed", failure: "This note was spent before its withdrawal completed." };
            changed = true;
          } else if (
            chainState === NULLIFIER_UNUSED
            && Date.now() - exit.requested_at_ms >= UNKNOWN_WITHDRAWAL_GRACE_MS
          ) {
            note.exit = { ...note.exit!, stage: "failed", failure: "The operator did not accept this withdrawal. Retry it." };
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  /** moves a matured exit into the connected wallet's shielded balance. */
  async function claimWithdrawal(noteCommitment: string) {
    unlocked();
    const operationId = normalizeFeltForComparison(noteCommitment);
    if (claimsInFlight.has(operationId)) {
      throw new Error("This private withdrawal is already being received.");
    }
    const note = noteByCommitment(noteCommitment);
    if (!note?.exit || note.spent) throw new Error("This withdrawal is no longer available.");
    if (note.exit.stage === "claiming") {
      return { transaction_hash: note.exit.claim_transaction_hash ?? null };
    }
    if (note.exit.stage !== "finalized") {
      throw new Error("This withdrawal is not ready to receive yet.");
    }
    claimsInFlight.add(operationId);
    const sessionGeneration = generation;
    try {
      return { transaction_hash: await claimExit(note, sessionGeneration) };
    } catch (error) {
      const failedBeforeProofSubmission = error instanceof ExitClaimAuthorizationError
        || error instanceof WalletMigrationRequiredError
        || error instanceof WalletSessionChangedError;
      if (!failedBeforeProofSubmission && sessionGeneration === generation) {
        const current = noteByCommitment(note.commitment);
        if (current?.exit?.stage === "finalized" && proofSubmissionStarted(error)) {
          current.exit = {
            ...current.exit,
            stage: "claiming",
            claim_transaction_hash: undefined,
            claim_submitted_at_ms: Date.now(),
            claim_retry_at_ms: undefined,
            failure: failureText(normalizeFailure(error, {
              domain: "withdrawal",
              operation: "claim",
              stage: "withdrawal-claim",
              outcome: "unknown",
            })).slice(0, 512),
          };
          await saveState();
          void pushRecoverySnapshot(true).catch(() => false);
        } else if (current?.exit?.stage === "finalized") {
          current.exit = claimRetryState(current.exit, error, Date.now());
          await saveState();
        }
      }
      throw error;
    } finally {
      if (generation === sessionGeneration) claimsInFlight.delete(operationId);
    }
  }

  /** claims a finalized exit into the privacy pool as an open note the wallet owns. */
  async function claimExit(note: WalletNote, sessionGeneration: number) {
    const { deployment: manifest } = unlocked();
    const exit = note.exit!;
    const alreadyClaimed = await claimedOpenNoteId(exit.exit_commitment, sessionGeneration);
    if (alreadyClaimed) {
      note.spent = true;
      note.exit = {
        ...exit,
        open_note_id: alreadyClaimed,
        claim_retry_at_ms: undefined,
        failure: undefined,
      };
      await saveState();
      void pushRecoverySnapshot(true).catch(() => false);
      return null;
    }
    const result = await submitExitClaimToWallet({
      manifest,
      asset: note.asset,
      assetId: note.asset,
      amount: note.fields.amount,
      exitCommitment: exit.exit_commitment,
      sessionGeneration,
    });
    ensureCurrent(sessionGeneration);
    note.exit = {
      ...exit,
      stage: "claiming",
      open_note_id: undefined,
      claim_transaction_hash: result.transactionHash,
      claim_submitted_at_ms: Date.now(),
      claim_retry_at_ms: undefined,
      failure: undefined,
    };
    await saveState();
    void pushRecoverySnapshot(true).catch(() => false);
    return result.transactionHash;
  }

  async function submitExitClaimToWallet(input: {
    manifest: DeploymentConfig;
    asset: string;
    assetId: string;
    amount: string;
    exitCommitment: string;
    sessionGeneration: number;
  }) {
    const rail = selectedDepositFundingRail(input.manifest);
    const privacyPoolAddress = requiredNonZeroFelt(rail.privacyPool, "privacy_pool_address");
    const bridgeAddress = requiredNonZeroFelt(rail.bridgeAdapter, "privacy_deposit_bridge_address");
    const paymasterAddress = requiredNonZeroFelt(rail.paymasterAddress, "privacy_paymaster_address");
    const paymasterUrl = requiredString(rail.paymasterUrl, "privacy_paymaster_url");
    const tokenAddress = fundingRailTokenAddress(input.manifest, input.asset);
    const feeTokenAddress = fundingRailTokenAddress(
      input.manifest,
      input.manifest.market_registry.gas_fee_asset_id,
    );
    const chainId = requiredNonZeroFelt(input.manifest.chain_id, "chain_id");
    const feeResult = await awaitCurrent(input.sessionGeneration, starknetCall(
      input.manifest.rpc_url,
      privacyPoolAddress,
      "get_fee_amount",
      [],
    ));
    const feeAmount = BigInt(requiredNonZeroFelt(feeResult[0], "privacy_pool_fee"));
    const provider = await awaitCurrent(
      input.sessionGeneration,
      selectInjectedStarknetProvider(activeWalletAddress, () => ensureCurrent(input.sessionGeneration)),
    );
    const walletAddress = connectedStarknetAddress();
    if (!walletAddress || normalizeFeltForComparison(walletAddress) !== activeWalletAddress) {
      throw new Error("Connected Starknet wallet changed during the private withdrawal.");
    }
    const [
      { claimZylithExitToWallet },
      {
        privacyBridgeStrk20ExitAuthorizationCall,
        privacyBridgeStrk20ExitClaimFlatCalldata,
      },
    ] = await awaitCurrent(input.sessionGeneration, Promise.all([
      import("./integrations/starknetWalletPrivacy"),
      import("./integrations/starknetPrivacyFunding"),
    ]));
    const result = await awaitCurrent(input.sessionGeneration, claimZylithExitToWallet({
      provider: provider as never,
      walletAddress,
      chainId,
      paymasterAddress,
      paymasterUrl,
      privacyPoolAddress,
      tokenAddress,
      feeTokenAddress,
      feeAmount,
      bridgeAddress,
      bridgeCalldata: privacyBridgeStrk20ExitClaimFlatCalldata({
        exitCommitment: input.exitCommitment,
        openNoteId: "${openNoteIds[0]}",
      }),
      assertWalletContext: () => {
        ensureCurrent(input.sessionGeneration);
        const currentAddress = connectedStarknetAddress();
        if (
          !currentAddress
          || normalizeFeltForComparison(currentAddress) !== activeWalletAddress
        ) {
          throw new Error("Connected Starknet wallet changed during the private withdrawal.");
        }
      },
      buildAuthorizationCall: async (openNoteId) => {
        try {
          ensureCurrent(input.sessionGeneration);
          const { client } = unlocked();
          const signature = parseWalletJson(await awaitOwnedClient(
            input.sessionGeneration,
            client,
            client.signStrk20ExitClaim(JSON.stringify({
              bridge_address: bridgeAddress,
              privacy_pool_address: privacyPoolAddress,
              asset_id: input.assetId,
              token_address: tokenAddress,
              amount: input.amount,
              exit_commitment: input.exitCommitment,
              claim_account: paymasterAddress,
              open_note_id: openNoteId,
            })),
          )) as { signature_r: string; signature_s: string };
          return privacyBridgeStrk20ExitAuthorizationCall({
            bridgeAddress,
            exitCommitment: input.exitCommitment,
            openNoteId,
            signature,
          });
        } catch (error) {
          if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) {
            throw error;
          }
          throw new ExitClaimAuthorizationError();
        }
      },
    }));
    return result;
  }

  async function settleClaim(note: WalletNote, sessionGeneration: number) {
    const alreadyClaimed = await claimedOpenNoteId(
      note.exit!.exit_commitment,
      sessionGeneration,
    );
    if (alreadyClaimed) {
      note.spent = true;
      note.exit = {
        ...note.exit!,
        open_note_id: alreadyClaimed,
        claim_retry_at_ms: undefined,
        failure: undefined,
      };
      return true;
    }
    if (!note.exit!.claim_transaction_hash) {
      // The relay accepted the request boundary but no transaction hash was acknowledged. Keep
      // the claim durably blocked while the on-chain exit-claim index is reconciled.
      return false;
    }
    const status = await receipt(note.exit!.claim_transaction_hash!, sessionGeneration);
    if (status?.confirmed && !status.failed) {
      note.spent = true;
      return true;
    }
    if (status?.failed) {
      note.exit = claimRetryState({
        ...note.exit!,
        stage: "finalized",
        claim_transaction_hash: undefined,
        claim_submitted_at_ms: undefined,
        open_note_id: undefined,
      }, "The private withdrawal transaction failed on-chain.", Date.now());
      return true;
    }
    return false;
  }

  // refresh

  function refresh() {
    if (!sessionReady) return Promise.reject(new Error("Wallet session is locked"));
    ensureCurrent(generation);
    refreshInFlight ??= (async () => {
      const sessionGeneration = generation;
      try {
        let firstError: unknown;
        let status: StatusAnswer | null = null;
        try {
          status = await fetchStatus();
        } catch (error) {
          if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
          firstError = error;
        }
        ensureCurrent(sessionGeneration);
        const steps = [refreshDeposits, () => refreshOrders(status), scanTransitions, () => refreshWithdrawals(status)];
        let changed = false;
        for (const step of steps) {
          try {
            changed = (await step()) || changed;
          } catch (error) {
            if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
            firstError ??= error;
          }
          ensureCurrent(sessionGeneration);
        }
        if (changed) await saveState();
        try {
          await pushRecoverySnapshot();
        } catch (error) {
          if (error instanceof WalletMigrationRequiredError || error instanceof WalletSessionChangedError) throw error;
          firstError ??= error;
        }
        ensureCurrent(sessionGeneration);
        if (firstError) throw firstError;
      } catch (error) {
        requireCurrentFailure(error, sessionGeneration);
        clearMigrationSession(error, sessionGeneration);
        throw error;
      } finally {
        if (generation === sessionGeneration) refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  function serviceUrl(url: string | undefined, sameOriginPath: string) {
    const resolved = browserSafeServiceUrl(normalizeUrl(url), sameOriginPath);
    if (!resolved) throw new Error("Private funding service URLs are required");
    return resolved;
  }

  function runResidualOperation<T>(orderId: string, operation: () => Promise<T>) {
    const key = normalizeFeltForComparison(orderId);
    const sessionGeneration = generation;
    if (residualOperationsInFlight.has(key)) {
      return Promise.reject(new Error("A recovery operation for this order is already in progress."));
    }
    residualOperationsInFlight.add(key);
    return operation().finally(() => {
      if (generation === sessionGeneration) residualOperationsInFlight.delete(key);
    });
  }

  return {
    hasVault,
    vaultAuthMode: (starknetAddress) => {
      const sessionGeneration = generation;
      try {
        ensureCurrent(sessionGeneration);
        if (starknetAddress) requireNoLegacyDeviceRecord(starknetAddress);
        if (starknetAddress && deviceRecordStore.read(starknetAddress)) return "device-session";
        return hasVault(starknetAddress) ? "wallet-signature" : "none";
      } catch (error) {
        clearMigrationSession(error, sessionGeneration);
        throw error;
      }
    },
    isReady: (starknetAddress) => Boolean(
      sessionReady
      && publicConfig
      && (!starknetAddress
        || activeWalletAddress === normalizeFeltForComparison(starknetAddress)),
    ),
    createWalletWithWalletSignature: guardSessionOperation(createWalletWithWalletSignature),
    unlockWithDeviceSession: guardSessionOperation(unlockWithDeviceSession),
    unlockWithWalletSignature: guardSessionOperation(unlockWithWalletSignature),
    getPublicConfig: () => publicConfig,
    lock,
    suspend,
    getBalances,
    getPendingDeposits,
    getWithdrawableNotes,
    getOrders: () => state.orders.map((order) => ({
      ...order,
      residual_recovery_available: Boolean(order.residual),
    })),
    withdrawalAvailable,
    submitDepositViaWallet: guardSessionOperation(submitDepositViaWallet),
    submitOrder: guardSessionOperation(submitOrder),
    cancelOrder: guardSessionOperation(cancelOrder),
    prepareResidualRecovery: guardSessionOperation((orderId: string) => runResidualOperation(orderId, () => prepareResidualRecovery(orderId))),
    submitResidualRecovery: guardSessionOperation((orderId: string) =>
      runResidualOperation(orderId, () => submitResidualRecovery(orderId))),
    freezeResidualRecoveryCapacity: guardSessionOperation((orderId: string) => runResidualOperation(orderId, () => freezeResidualRecoveryCapacity(orderId))),
    finalizeResidualRecovery: guardSessionOperation((orderId: string) => runResidualOperation(orderId, () => finalizeResidualRecovery(orderId))),
    claimResidualRecovery: guardSessionOperation((orderId: string) => runResidualOperation(orderId, () => claimResidualRecovery(orderId))),
    withdraw: guardSessionOperation(withdraw),
    claimWithdrawal: guardSessionOperation(claimWithdrawal),
    refresh: guardSessionOperation(refresh),
  };
}

/** folds a backed-up state into the local one; true when anything was added or advanced. */
export function mergeState(local: WalletState, remote: WalletState) {
  requireWalletState(local);
  requireWalletState(remote);
  let changed = false;
  for (const note of remote.notes) {
    const key = normalizeFeltForComparison(note.commitment);
    const existing = local.notes.find((candidate) => normalizeFeltForComparison(candidate.commitment) === key);
    if (!existing) {
      local.notes.push(structuredClone(note));
      changed = true;
    } else {
      const merged = mergeNoteState(existing, note);
      if (merged !== existing) {
        Object.assign(existing, merged);
        changed = true;
      }
    }
  }
  for (const order of remote.orders) {
    const orderId = normalizeFeltForComparison(order.order_id);
    const index = local.orders.findIndex(
      (candidate) => normalizeFeltForComparison(candidate.order_id) === orderId,
    );
    if (index === -1) local.orders.push(structuredClone(order));
    else {
      const merged = mergeOrderState(local.orders[index], order);
      if (merged === local.orders[index]) continue;
      local.orders[index] = merged;
    }
    changed = true;
  }
  for (const note of local.notes) {
    if (!note.locked_by) continue;
    const order = local.orders.find((candidate) =>
      normalizeFeltForComparison(candidate.order_id) === normalizeFeltForComparison(note.locked_by),
    );
    if (order && !OPEN_STATES.has(order.state)) {
      note.locked_by = undefined;
      changed = true;
    }
  }
  for (const order of local.orders) {
    if (order.state !== "submitting" && order.state !== "pending") continue;
    for (const commitment of order.funding_notes) {
      const note = local.notes.find(
        (candidate) => normalizeFeltForComparison(candidate.commitment)
          === normalizeFeltForComparison(commitment),
      );
      if (!note || note.spent || hasActiveExit(note)) continue;
      if (note.locked_by && normalizeFeltForComparison(note.locked_by) !== normalizeFeltForComparison(order.order_id)) {
        throw new Error("A funding note is assigned to conflicting orders.");
      }
      if (!note.locked_by) {
        note.locked_by = order.order_id;
        changed = true;
      }
    }
  }
  // rescanning is idempotent, so the earlier cursor wins.
  if (remote.scanned_seq < local.scanned_seq) {
    local.scanned_seq = remote.scanned_seq;
    changed = true;
  }
  local.orders.sort((left, right) => right.submitted_at_ms - left.submitted_at_ms);
  return changed;
}

export function walletBalances(walletState: WalletState): WalletBalance[] {
  const balances = new Map<string, { available: bigint; locked: bigint }>();
  const admittedOrders = new Set(
    walletState.orders
      .filter((order) => order.state === "live" || order.state === "cancelling")
      .map((order) => normalizeFeltForComparison(order.order_id)),
  );
  const entry = (asset: string) => {
    const current = balances.get(asset) ?? { available: 0n, locked: 0n };
    balances.set(asset, current);
    return current;
  };
  for (const note of walletState.notes) {
    if (
      note.spent
      || (note.source === "deposit" && note.deposit?.confirmed !== true)
    ) continue;
    const activeExit = hasActiveExit(note);
    const isSpendable = !note.locked_by
      && !activeExit
      && (note.source === "output" || note.deposit?.confirmed === true);
    if (
      note.locked_by
      && admittedOrders.has(normalizeFeltForComparison(note.locked_by))
    ) continue;
    if (isSpendable) entry(note.asset).available += BigInt(note.fields.amount);
    else if (note.locked_by || activeExit) {
      entry(note.asset).locked += BigInt(note.fields.amount);
    }
  }
  for (const order of walletState.orders) {
    if (order.state === "live" || order.state === "cancelling") {
      entry(order.funding_asset).locked += BigInt(order.locked_input);
    }
  }
  return [...balances].map(([asset, balance]) => ({
    asset,
    available: balance.available.toString(),
    locked: balance.locked.toString(),
  }));
}

function noteImmutableIdentity(note: WalletNote) {
  const fields = note.fields;
  return JSON.stringify({
    nullifier: normalizeFeltForComparison(note.nullifier),
    asset: note.asset,
    source: note.source,
    fields: {
      asset_id: normalizeFeltForComparison(fields.asset_id),
      amount: fields.amount,
      owner_public_key: normalizeFeltForComparison(fields.owner_public_key),
      spend_authority: normalizeFeltForComparison(fields.spend_authority),
      withdraw_authority: normalizeFeltForComparison(fields.withdraw_authority),
      blinding: normalizeFeltForComparison(fields.blinding),
      nonce: fields.nonce,
      metadata_commitment: normalizeFeltForComparison(fields.metadata_commitment),
    },
  });
}

function mergeNoteState(local: WalletNote, remote: WalletNote): WalletNote {
  if (noteImmutableIdentity(local) !== noteImmutableIdentity(remote)) {
    throw new Error("Backed-up note data conflicts with local note data.");
  }
  if (
    local.locked_by
    && remote.locked_by
    && normalizeFeltForComparison(local.locked_by) !== normalizeFeltForComparison(remote.locked_by)
  ) throw new Error("A note is locked by conflicting orders.");
  if (
    local.output
    && remote.output
    && (
      normalizeFeltForComparison(local.output.order_id)
        !== normalizeFeltForComparison(remote.output.order_id)
      || local.output.seq !== remote.output.seq
      || local.output.kind !== remote.output.kind
    )
  ) throw new Error("Backed-up note provenance conflicts with local state.");
  const deposit = mergeDepositState(local.deposit, remote.deposit);
  const exit = mergeExitState(local.exit, remote.exit);
  const merged: WalletNote = {
    ...local,
    spent: Boolean(local.spent || remote.spent),
    locked_by: local.locked_by ?? remote.locked_by,
    deposit,
    exit,
    output: local.output ?? remote.output,
  };
  if (merged.spent || hasActiveExit(merged)) merged.locked_by = undefined;
  return JSON.stringify(merged) === JSON.stringify(local) ? local : merged;
}

function mergeDepositState(local: WalletNote["deposit"], remote: WalletNote["deposit"]) {
  if (!local) return remote ? structuredClone(remote) : undefined;
  if (!remote) return local;
  if (
    normalizeFeltForComparison(local.funding_commitment)
      !== normalizeFeltForComparison(remote.funding_commitment)
    || local.request_id !== remote.request_id
  ) throw new Error("Backed-up deposit identity conflicts with local state.");
  const confirmed = local.confirmed || remote.confirmed;
  return {
    ...local,
    requested_at_ms: Math.min(local.requested_at_ms, remote.requested_at_ms),
    transaction_hash: local.transaction_hash ?? remote.transaction_hash,
    confirmed,
    public_transaction_confirmed: confirmed
      ? undefined
      : local.public_transaction_confirmed || remote.public_transaction_confirmed || undefined,
    failed: confirmed ? undefined : local.failed || remote.failed || undefined,
    failure_reason: confirmed
      ? undefined
      : local.failure_reason ?? remote.failure_reason,
  };
}

function mergeExitState(local: WalletNote["exit"], remote: WalletNote["exit"]) {
  if (!local) return remote ? structuredClone(remote) : undefined;
  if (!remote) return local;
  if (
    normalizeFeltForComparison(local.exit_commitment)
      !== normalizeFeltForComparison(remote.exit_commitment)
  ) throw new Error("Backed-up withdrawal authority conflicts with local state.");
  const rank: Record<ExitStage, number> = {
    requested: 0,
    proving: 1,
    failed: 2,
    maturing: 3,
    finalized: 4,
    claiming: 5,
  };
  const localSucceeded = local.stage === "finalized" || local.stage === "claiming";
  const remoteSucceeded = remote.stage === "finalized" || remote.stage === "claiming";
  const primary = (remoteSucceeded && !localSucceeded)
    || (remoteSucceeded === localSucceeded && remote.requested_at_ms > local.requested_at_ms)
    || (remoteSucceeded === localSucceeded
      && remote.requested_at_ms === local.requested_at_ms
      && rank[remote.stage] > rank[local.stage])
    ? remote
    : local;
  const secondary = primary === remote ? local : remote;
  return {
    ...secondary,
    ...primary,
    matures_at_ms: primary.matures_at_ms ?? secondary.matures_at_ms,
    open_note_id: primary.open_note_id ?? secondary.open_note_id,
    claim_transaction_hash:
      primary.claim_transaction_hash ?? secondary.claim_transaction_hash,
    claim_submitted_at_ms:
      primary.claim_submitted_at_ms ?? secondary.claim_submitted_at_ms,
    claim_attempts: Math.max(primary.claim_attempts ?? 0, secondary.claim_attempts ?? 0) || undefined,
    claim_retry_at_ms: Math.max(primary.claim_retry_at_ms ?? 0, secondary.claim_retry_at_ms ?? 0) || undefined,
    failure: primary.stage === "failed"
      ? primary.failure ?? secondary.failure
      : undefined,
  };
}

function mergeOrderState(local: StoredOrder, remote: StoredOrder): StoredOrder {
  const immutableOrderIdentity = (order: StoredOrder) => stableJsonStringify({
    order_id: normalizeFeltForComparison(order.order_id),
    pair: order.pair,
    side: order.side,
    external: order.external,
    amount: order.amount,
    limit_price: order.limit_price,
    expires_at_ms: order.expires_at_ms,
    funding_asset: order.funding_asset,
    funding_amount: order.funding_amount,
    terms: order.terms,
    funding_notes: order.funding_notes.map(normalizeFeltForComparison).sort(),
    nullifiers: order.nullifiers.map(normalizeFeltForComparison).sort(),
    base_asset: order.base_asset,
    quote_asset: order.quote_asset,
    scan_after_seq: order.scan_after_seq,
  });
  if (immutableOrderIdentity(local) !== immutableOrderIdentity(remote)) {
    throw new Error("Backed-up order identity conflicts with local state.");
  }
  const sharedLength = Math.min(local.seen_seqs.length, remote.seen_seqs.length);
  const sharedPrefixMatches = local.seen_seqs
    .slice(0, sharedLength)
    .every((seq, index) => seq === remote.seen_seqs[index]);
  const localIsPrefix = sharedPrefixMatches && local.seen_seqs.length <= remote.seen_seqs.length;
  const remoteIsPrefix = sharedPrefixMatches && remote.seen_seqs.length <= local.seen_seqs.length;
  if (!localIsPrefix && !remoteIsPrefix) {
    throw new Error("Backed-up order event histories diverge from local state.");
  }
  if (
    localIsPrefix
    && remoteIsPrefix
    && (local.filled_base !== remote.filled_base
      || local.filled_quote !== remote.filled_quote
      || local.fees !== remote.fees)
  ) throw new Error("Backed-up order accounting conflicts with local state.");
  if (localIsPrefix && remoteIsPrefix && local.locked_input !== remote.locked_input) {
    const authenticatedRelease = [local, remote].some(
      (order) => order.locked_input === "0" && (
        order.closed_seq_authenticated === true
        || (order.state === "failed" && order.seen_seqs.length === 0 && !order.residual)
      ),
    );
    if (!authenticatedRelease) {
      throw new Error("Backed-up order accounting conflicts with local state.");
    }
  }
  const accountingPrimary = localIsPrefix && !remoteIsPrefix
    ? remote
    : remoteIsPrefix && !localIsPrefix
      ? local
      : undefined;
  const accountingSecondary = accountingPrimary === remote
    ? local
    : accountingPrimary === local
      ? remote
      : undefined;
  if (
    accountingPrimary
    && accountingSecondary
    && (
      BigInt(accountingPrimary.filled_base) < BigInt(accountingSecondary.filled_base)
      || BigInt(accountingPrimary.filled_quote) < BigInt(accountingSecondary.filled_quote)
      || BigInt(accountingPrimary.fees) < BigInt(accountingSecondary.fees)
      || BigInt(accountingPrimary.locked_input) > BigInt(accountingSecondary.locked_input)
    )
  ) throw new Error("Backed-up order accounting regressed despite later events.");
  const terminal = new Set<StoredOrder["state"]>(["failed", "cancelled", "expired", "filled"]);
  if (terminal.has(local.state) && terminal.has(remote.state) && local.state !== remote.state) {
    throw new Error("Backed-up order terminal states conflict with local state.");
  }
  if (
    local.residual
    && remote.residual
    && local.residual.seq === remote.residual.seq
    && stableJsonStringify(local.residual) !== stableJsonStringify(remote.residual)
  ) throw new Error("Backed-up residual authorities conflict with local state.");
  const progress = (order: StoredOrder) => Math.max(
    order.scan_after_seq,
    order.closed_seq_authenticated ? order.closed_seq ?? 0 : 0,
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
    || (remoteProgress === localProgress
      && remote.updated_at_ms > local.updated_at_ms)
    || (remoteProgress === localProgress
      && remote.updated_at_ms === local.updated_at_ms
      && stateRank[remote.state] > stateRank[local.state]);
  const primary = remoteIsAhead ? remote : local;
  const secondary = remoteIsAhead ? local : remote;
  const cancellationSource = remote.updated_at_ms > local.updated_at_ms
    ? remote
    : local.updated_at_ms > remote.updated_at_ms
      ? local
      : primary;
  const seenSeqs = [...new Set([...local.seen_seqs, ...remote.seen_seqs])].sort((left, right) => left - right);
  const decimalMin = (left: string, right: string) => (BigInt(left) <= BigInt(right) ? left : right);
  let residual: StoredResidual | undefined = [local.residual, remote.residual]
    .filter((value): value is StoredResidual => Boolean(value))
    .sort((left, right) => right.seq - left.seq)[0];
  const localClosedSeq = local.closed_seq_authenticated ? local.closed_seq : undefined;
  const remoteClosedSeq = remote.closed_seq_authenticated ? remote.closed_seq : undefined;
  if (localClosedSeq !== undefined && remoteClosedSeq !== undefined && localClosedSeq !== remoteClosedSeq) {
    throw new Error("Backed-up order terminal transitions conflict with local state.");
  }
  const authenticatedClosedSeq = localClosedSeq ?? remoteClosedSeq;
  if (authenticatedClosedSeq !== undefined && residual) {
    if (residual.seq >= authenticatedClosedSeq) {
      throw new Error("Backed-up residual authority conflicts with the authenticated terminal transition.");
    }
    residual = undefined;
  }
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
  const cancelRequested = cancellationSource.cancel_requested || undefined;
  let mergedState = primary.state;
  if (authenticatedClosedSeq === undefined && OPEN_STATES.has(primary.state)) {
    if (cancelRequested) mergedState = "cancelling";
    else if (primary.state === "cancelling" && OPEN_STATES.has(cancellationSource.state)) {
      mergedState = cancellationSource.state === "cancelling" ? "live" : cancellationSource.state;
    }
  }
  const merged: StoredOrder = {
    ...primary,
    state: mergedState,
    seen_seqs: seenSeqs,
    scan_after_seq: Math.min(local.scan_after_seq, remote.scan_after_seq),
    filled_base: accountingPrimary?.filled_base ?? primary.filled_base,
    filled_quote: accountingPrimary?.filled_quote ?? primary.filled_quote,
    fees: accountingPrimary?.fees ?? primary.fees,
    locked_input: accountingPrimary?.locked_input ?? decimalMin(local.locked_input, remote.locked_input),
    cancel_requested: cancelRequested,
    closed_seq: authenticatedClosedSeq,
    closed_seq_authenticated: authenticatedClosedSeq === undefined ? undefined : true,
    reported_removal: primary.reported_removal ?? secondary.reported_removal,
    residual,
    residual_capacity_freeze: residualCapacityFreeze,
    residual_recovery: residualRecovery,
    updated_at_ms: Math.max(local.updated_at_ms, remote.updated_at_ms),
  };
  if (merged.closed_seq_authenticated) {
    merged.locked_input = "0";
  } else if (!remoteIsAhead && secondary.last_error && !merged.last_error) {
    merged.last_error = secondary.last_error;
  }
  const unchanged = stableJsonStringify(merged) === stableJsonStringify(local);
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
  const feltFields = ["nullifier", "statement_commitment", "input_asset_id", "output_asset_id"] as const;
  const decimalFields = ["input_amount", "output_amount", "fee_amount"] as const;
  const nullableFeltFields = ["input_exit_commitment", "output_exit_commitment"] as const;
  if (
    feltFields.some((field) => normalizeFeltForComparison(left[field]) !== normalizeFeltForComparison(right[field]))
    || decimalFields.some((field) => left[field] !== right[field])
    || nullableFeltFields.some((field) =>
      normalizeFeltForComparison(left[field] ?? "0x0")
        !== normalizeFeltForComparison(right[field] ?? "0x0"))
  ) {
    throw new Error("Backed-up residual recovery authority conflicts with local state.");
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
  return { version: 2, key_schedule_version: WALLET_KEY_SCHEDULE_VERSION, notes: [], orders: [], scanned_seq: 0 };
}

function definitiveRejection(error: unknown) {
  try {
    if (error instanceof ExchangeRejectedError) return true;
    return error instanceof ExchangeHttpError
      && error.status >= 400
      && error.status < 500
      && error.status !== 408;
  } catch {
    return false;
  }
}

function markDefinitiveSubmissionFailure(error: unknown) {
  try {
    return error instanceof ExchangeHttpError
      ? markOperationSubmissionNotStarted(error)
      : markOperationSubmissionRejected(error);
  } catch {
    return markOperationSubmissionRejected(error);
  }
}

function maxZero(value: bigint) {
  return value < 0n ? 0n : value;
}

function randomU64() {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(words[0]) << 32n) | BigInt(words[1])).toString();
}

function randomFeltHex() {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    bytes[0] &= 0x07;
    if (bytes.some((byte) => byte !== 0)) {
      return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
  }
}

export function parseFundingCommitmentRegistration(fields: string[]) {
  if (fields.length !== 1) {
    throw new Error("The commitment registry returned an unexpected registration result.");
  }
  const value = normalizeStrictFelt(fields[0]);
  if (value === "0x0") return false;
  if (value === "0x1") return true;
  throw new Error("The commitment registry returned an unexpected registration result.");
}

export function transactionHash(value: unknown): string | null {
  if (typeof value === "string") return nonZeroFelt(value);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["transaction_hash", "transactionHash", "hash"]) {
    if (typeof record[key] === "string") return nonZeroFelt(record[key]);
  }
  return null;
}

function nonZeroFelt(value: string): string | null {
  const normalized = normalizeStrictFelt(value);
  return normalized && normalized !== "0x0" ? normalized : null;
}
