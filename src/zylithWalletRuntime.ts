import { denominationTableForAsset, splitDepositAmount } from "./domain/depositSplitting";
import { selectedStarknetProvider } from "./domain/browserWallet";
import { userFacingErrorMessage } from "./domain/userFacingErrors";
import type { MakerBandAttribution } from "./domain/shieldedBalances";
import {
  submitPrivacyBridgeDeposit,
  warmUpStarknetPrivacyFunding,
  type SubmitPrivacyBridgeDepositResult,
} from "./integrations/starknetPrivacyFunding";
import {
  deserializeStarknetPrivacyRegistry,
  serializeStarknetPrivacyRegistry,
  type SerializedStarknetPrivacyRegistry,
} from "./integrations/starknetPrivacyRegistry";
import type { PrivateRegistry } from "@starkware-libs/starknet-privacy-sdk";

type Side = "Buy" | "Sell";
type OrderMode = "Limit" | "Maker Curve" | "TWAP" | "VWAP" | "Repeat" | "Resting";
type SubmissionTimingPreference = "fast" | "balanced" | "private";
const DIRECT_ORDER_MODES = new Set<OrderMode>(["Limit", "Maker Curve"]);
const STRATEGY_ORDER_MODES = new Set<OrderMode>(["TWAP", "VWAP", "Repeat", "Resting"]);
const MAX_ORDER_FUNDING_INPUTS = 4;
const DEFAULT_STARKNET_PRIVACY_MIN_PROVING_DELAY_BLOCKS = 10;
const SESSION_UNLOCK_CHANNEL = "zylith.wallet.session-unlock.v1";

type WalletBalance = {
  asset: string;
  available: string;
  locked: string;
};

type PendingDeposit = {
  note_commitment: string;
  asset: string;
  amount: string;
  transaction_hash?: string;
  request_id?: string;
  requested_at_unix_ms?: number;
  confirmed: boolean;
  failed?: boolean;
  failure_reason?: string;
};

type FundingNotePreview = {
  note_commitment: string;
  asset: string;
  amount: string;
  source: "deposit" | "settlement_output";
};

type FundingPreview = {
  asset: string;
  required: string;
  selected_total: string;
  expected_change: string;
  notes: FundingNotePreview[];
};

type PrivateOrderDraft = {
  pair: string;
  side: Side;
  mode: OrderMode;
  amount: string;
  limitPrice: string;
  minFill: string;
  fillOrKill: boolean;
  batchId: string;
  childAmount?: string;
  maxChildren?: number;
  durationBatches?: number;
  randomizedSlicing?: boolean;
  randomizedSlicingBps?: number;
  priceBaseScale?: string;
  offlineDelegation?: boolean;
  makerCurvePoints?: Array<{ price: string; baseAmount: string }>;
  makerCurveRotationBps?: number;
  makerInventoryCap?: string;
  submissionTimingPreference?: SubmissionTimingPreference;
  relayMode?: "SelfRelay" | "ZylithRelay";
};

type WalletRuntime = {
  hasVault: () => boolean;
  isReady: () => boolean;
  createWallet: (passphrase: string) => Promise<boolean>;
  replaceWithNewWallet: (passphrase: string) => Promise<boolean>;
  importRecoverySeed: (recoveryPhraseOrSeedHex: string, passphrase: string) => Promise<boolean>;
  replaceRecoverySeed: (recoveryPhraseOrSeedHex: string, passphrase: string) => Promise<boolean>;
  unlockWithPassphrase: (passphrase: string) => Promise<boolean>;
  requestSessionUnlock: () => Promise<boolean>;
  exportRecoverySeed: (passphrase: string) => Promise<string>;
  syncRecoveryArtifacts: () => Promise<boolean>;
  getPublicConfig: () => WalletPublicConfig | null;
  lock: () => void;
  getBalances: () => WalletBalance[];
  getPendingDeposits: () => PendingDeposit[];
  getWithdrawableNotes: () => WithdrawableNote[];
  getPrivateStrategies: () => PrivateStrategySummary[];
  previewFundingNotes: (order: PrivateOrderDraft) => FundingPreview;
  consolidateNotes: (request: NoteConsolidationRequest) => Promise<NoteConsolidationResult>;
  scanNotes: () => Promise<boolean>;
  refreshPrivateState: () => Promise<void>;
  refreshDepositState: () => Promise<boolean>;
  pruneUnsettledSettlementOutputs: () => Promise<boolean>;
  syncSettlementOutputs: () => Promise<boolean>;
  syncPrivateSettlementReports: (requests: PrivateSettlementReportRequest[]) => Promise<PrivateSettlementReport[]>;
  submitDepositViaWallet: (asset: string, amount: string) => Promise<{
    transaction_hash: string;
    note_commitment: string;
    note_commitments: string[];
  }>;
  submitPrivateOrder: (order: PrivateOrderDraft) => Promise<{
    order_id?: string;
    strategy_id?: string;
    order_commitment?: string;
    batch_id?: string;
    cancellation_secret?: string;
    first_child_order_commitment?: string;
    first_child_batch_id?: string;
    first_child_cancellation_secret?: string;
    expected_output_metadata_commitment?: string;
    funding_note_commitments?: string[];
    offline_package?: OfflineRenewalPackage;
    status?: string;
  }>;
  cancelPrivateOrder: (request: {
    batch_id: string;
    order_commitment: string;
    cancellation_secret: string;
  }) => Promise<{ cancelled_at_unix_ms: number }>;
  cancelPrivateStrategy: (strategyId: string) => Promise<{
    cancelled_at_unix_ms: number;
    parent_cancel_transaction_hash?: string;
  }>;
  pausePrivateStrategy: (strategyId: string) => Promise<{ paused_at_unix_ms: number }>;
  resumePrivateStrategy: (strategyId: string) => Promise<{ resumed_at_unix_ms: number }>;
  refreshPrivateStrategyPackage: (strategyId: string) => Promise<OfflineRenewalPackage>;
  recordOfflineRenewalRelayResults: (
    packageId: string,
    results: Array<{
      slot_id?: string;
      order_commitment?: string;
      batch_id?: string;
      epoch_id?: number;
      status?: string;
      accepted?: { order_commitment?: string; batch_id?: string; accepted_at_unix_ms?: number };
    }>,
  ) => Promise<boolean>;
  settlePrivateOrderLock: (
    orderCommitment: string,
    outcome: "released" | "spent",
    fundingFallback?: {
      asset?: string;
      amount?: string;
      batchId?: string;
      noteCommitments?: string[];
    },
  ) => Promise<boolean>;
  createOfflineRenewalPackage: (order: PrivateOrderDraft) => Promise<OfflineRenewalPackage>;
  getOfflineRenewalPackages: () => OfflineRenewalPackage[];
  submitWithdrawalViaPaymaster: (request: unknown) => Promise<{ transaction_hash: string }>;
};

type WalletWasmModule = {
  default?: () => Promise<void>;
  zylith_wallet_generate_seed_hex: () => string;
  zylith_wallet_generate_mnemonic: () => string;
  zylith_wallet_seed_hex_to_mnemonic: (seedHex: string) => string;
  zylith_wallet_mnemonic_to_seed_hex: (phrase: string) => string;
  zylith_wallet_derive_public_config: (seedHex: string) => string;
  zylith_wallet_build_deposit_submission_plan: (inputJson: string) => string;
  zylith_wallet_build_private_order_submission: (inputJson: string) => string;
  zylith_wallet_build_strategy_parent: (inputJson: string) => string;
  zylith_wallet_build_renewal_parent_cancel_submission_plan: (inputJson: string) => string;
  zylith_wallet_build_note_consolidation_draft: (inputJson: string) => string;
  zylith_wallet_sign_note_consolidation_witness: (inputJson: string) => string;
  zylith_wallet_scan_output_bundle: (seedHex: string, bundleJson: string) => string;
  zylith_wallet_scan_output_bundle_with_root: (
    seedHex: string,
    bundleJson: string,
    expectedOutputNoteRoot: string,
  ) => string;
  zylith_wallet_output_recovery_key_tags: (
    seedHex: string,
    batchId: string,
    maxOutputCount: number,
  ) => string;
  zylith_wallet_decrypt_output_recovery_record: (
    seedHex: string,
    batchId: string,
    outputIndex: number,
    recordJson: string,
    expectedOutputNoteRoot: string,
  ) => string;
  zylith_wallet_recovery_auth_tag: (seedHex: string) => string;
  zylith_wallet_create_recovery_snapshot: (inputJson: string) => string;
  zylith_wallet_decrypt_recovery_artifact: (seedHex: string, artifactJson: string) => string;
  zylith_wallet_decrypt_maker_attribution_artifact: (
    seedHex: string,
    artifactJson: string,
  ) => string;
  zylith_wallet_build_withdrawal_submission_plan: (inputJson: string) => string;
  zylith_wallet_build_settlement_output_withdrawal_submission_plan: (inputJson: string) => string;
};

type WalletPublicConfig = {
  account_id: string;
  spend_authority: string;
  note_recognition_public_key: string;
  withdraw_authority: string;
};

type LocalNoteRecord = {
  note_commitment: string;
  deployment_scope?: string;
  batch_id?: string;
  source?: "deposit" | "settlement_output";
  note: {
    asset_id: string;
    amount: string;
    owner_public_key: string;
    spend_authority: string;
    withdraw_authority: string;
    blinding: string;
    nonce: number;
    metadata_commitment: string;
  };
  output_note?: unknown;
  output_proof?: unknown;
  maker_attribution?: MakerBandAttribution;
  locked_by_order?: string;
  pending_deposit_tx?: string;
  deposit_confirmed?: boolean;
  deposit_failed?: boolean;
  deposit_failure_reason?: string;
  deposit_request_id?: string;
  deposit_requested_at_unix_ms?: number;
  spent?: boolean;
  pending_withdrawal_tx?: string;
  withdrawal_requested_at_unix_ms?: number;
};

type WithdrawableNote = {
  note_commitment: string;
  batch_id?: string;
  source: "deposit" | "settlement_output";
  asset: string;
  amount: string;
  locked: boolean;
  spent: boolean;
  pending_withdrawal_tx?: string;
  metadata_commitment: string;
  maker_attribution?: MakerBandAttribution;
};

type NoteConsolidationRequest = {
  sourceNoteCommitments: string[];
  targetAmounts: string[];
};

type NoteConsolidationResult = {
  consolidation_id: string;
  transaction_hash: string;
  finality_status?: string;
  execution_status?: string;
  settled_at_unix_ms?: number;
  output_note_commitments: string[];
};

type MakerAttributionArtifactList = {
  batch_id: string;
  maker_public_key: string;
  artifacts: unknown[];
};

type MakerAttributionPlaintext = {
  version: number;
  batch_id: string;
  pair_id: string;
  epoch_id: number;
  maker_public_key: string;
  curve_commitment: string;
  output_note_commitment: string;
  attribution: MakerBandAttribution;
};

type PrivateStrategySummary = {
  id: string;
  mode: PrivateStrategyRecord["mode"];
  pair: string;
  side: Side;
  status: PrivateStrategyRecord["status"];
  total_amount: string;
  remaining_amount: string;
  child_amount: string;
  limit_price: string;
  price_base_scale?: string;
  min_fill: string;
  fill_or_kill: boolean;
  maker_curve_points?: Array<{ price: string; base_amount: string }>;
  maker_inventory_cap?: string;
  renewal_window_children?: number;
  max_children: number;
  next_child_index: number;
  start_epoch: number;
  end_epoch: number;
  offline_package?: {
    package_id: string;
    package_commitment: string;
    created_at_unix_ms: number;
    start_epoch: number;
    end_epoch: number;
    slot_count: number;
    relay_mode?: "SelfRelay" | "ZylithRelay";
  };
  parent_cancel_transaction_hash?: string;
  last_error?: string;
  submitted_children: Array<{
    parent_child_index: number;
    batch_id: string;
    epoch_id: number;
    order_commitment?: string;
    cancellation_secret?: string;
    expected_output_metadata_commitment?: string;
    funding_note_commitments?: string[];
    submitted_at_unix_ms: number;
    delegated?: boolean;
  }>;
};

type BatchSummary = {
  batch_id: string;
  pair_id: string;
  epoch_id: number;
  close_time_unix_ms: number;
  status: string;
  order_count_bucket: string;
};

type PublishedBatchArtifactList = {
  batches: Array<{
    batch_id: string;
    pair_id: string;
    batch_epoch: number;
    output_note_root: string;
    published_at_unix_ms?: number;
    settled_at_unix_ms?: number | null;
  }>;
};

type ProofJobStatus = {
  batch_id: string;
  state?: string;
  failure?: string | null;
};

type PrivateSettlementReportRequest = {
  batch_id: string;
  order_commitments?: string[];
};

type PrivateOrderExecutionReport = {
  batch_id: string;
  pair_id: string;
  order_commitment: string;
  funding_note_commitment?: string;
  funding_note_commitments?: string[];
  status: string;
  side: Side;
  submitted_amount: string;
  filled_amount: string;
  unfilled_amount: string;
  limit_price: string;
  execution_price?: string | null;
  fee_amount: string;
  output_note_commitment?: string | null;
  output_asset_id?: string | null;
  output_amount: string;
  residual_note_commitment?: string | null;
  residual_asset_id?: string | null;
  residual_amount: string;
};

type PrivateSettlementReport = {
  batch_id: string;
  pair_id: string;
  batch_epoch: number;
  settled_at_unix_ms: number;
  output_note_root: string;
  clearing_price: string;
  price_base_scale: string;
  matched_order_count: number;
  output_recovery_records: Array<{
    output_index: number;
    recovery: unknown;
  }>;
  order_execution_reports: PrivateOrderExecutionReport[];
};

type OutputRecoveryKeyTagList = {
  key_tags: string[];
};

type OwnedOutputNotePayload = {
  version: number;
  batch_id: string;
  output_index: number;
  note: LocalNoteRecord["note"];
  output_note: {
    note_commitment?: string;
    asset_id?: string;
    amount?: string;
    withdraw_authority?: string;
  };
  output_proof?: unknown;
};

type WalletScanState = {
  version: 1;
  scanned_artifact_ids: string[];
  private_report_batch_ids: string[];
};

type IngressResponse = {
  coordinator_submission: unknown;
  receipt: unknown;
};

type CoordinatorAccepted = {
  order_commitment: string;
  batch_id: string;
};

type PaymasterWithdrawalRequest = {
  chain_id?: string;
  paymaster_address?: string;
  signer_address?: string;
  recipient: string;
  shielded_asset_adapter_address?: string;
  auction_verifier_address?: string;
  note_commitment?: string;
  batch_id?: string;
  output_note?: unknown;
  output_proof?: unknown;
  outside_transaction?: unknown;
  relay_nonce?: string;
  proof?: string;
  proof_facts?: string[];
};

type DeploymentConfig = {
  network?: string;
  chain_id?: string;
  rpc_url?: string;
  proof?: {
    native_prover_rpc_url?: string;
  };
  proof_config?: {
    native_prover_rpc_url?: string;
  };
  contracts?: {
    auction_verifier?: string;
    shielded_asset_adapter?: string;
    privacy_deposit_bridge?: string;
  };
  token_addresses?: Record<string, string>;
  funding?: {
    primary?: "starknet_privacy" | string;
    starknet_privacy?: {
      privacy_pool?: string;
      bridge_adapter?: string;
      discovery_url?: string;
      proving_url?: string;
      paymaster_address?: string;
      paymaster_url?: string;
      proof_signer_class_hash?: string;
      shielded_asset_adapter?: string;
      sdk_package?: string;
      sdk_version?: string;
      min_proving_delay_blocks?: number;
    };
  };
  product?: {
    pairs?: Record<string, {
      pair_id: string;
      enabled?: boolean;
    }>;
  };
};

type DepositFundingRail = {
  kind: "starknet_privacy";
  privacyPool?: string;
  bridgeAdapter?: string;
  discoveryUrl?: string;
  provingUrl?: string;
  paymasterAddress?: string;
  paymasterUrl?: string;
  privacyProofSignerClassHash?: string;
  sdkPackage?: string;
  sdkVersion?: string;
  minProvingDelayBlocks?: number;
  shieldedAssetAdapter?: string;
};

type StarknetPrivacyDepositFundingRail = Extract<
  DepositFundingRail,
  { kind: "starknet_privacy" }
>;

const ZAN_STARKNET_SEPOLIA_RPC_URL = "https://api.zan.top/public/starknet-sepolia/rpc/v0_10";
const SELECTED_STARKNET_WALLET_STORAGE_KEY = "zylith:selected-starknet-wallet";
const CONNECTED_STARKNET_ADDRESS_STORAGE_KEY = "zylith:connected-starknet-address";
const rpcSyncedProviders = new WeakSet<StarknetInjectedProvider>();
const CHAIN_ID_ALIASES: Record<string, string> = {
  SN_SEPOLIA: "0x534e5f5345504f4c4941",
  SN_MAIN: "0x534e5f4d41494e",
};

type StarknetWalletCall = {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
};

type LegacyStarknetWalletCall = {
  contract_address: string;
  entry_point: string;
  calldata: string[];
};

type StarknetInjectedProvider = {
  id?: string;
  name?: string;
  chainId?: string;
  enable?: (options?: unknown) => Promise<unknown>;
  request?: (request: { type?: string; method?: string; params?: unknown }) => Promise<unknown>;
  account?: {
    address?: string;
    getChainId?: () => Promise<string>;
    execute?: (calls: StarknetWalletCall[]) => Promise<unknown>;
  };
  selectedAddress?: string;
  isConnected?: boolean;
};

declare global {
  interface Window {
    zylithWallet?: WalletRuntime;
    zylithWalletLoadError?: string;
    starknet?: StarknetInjectedProvider;
    starknet_argentX?: StarknetInjectedProvider;
    starknet_braavos?: StarknetInjectedProvider;
    zylithSelectedStarknetProvider?: StarknetInjectedProvider;
  }
}

type VaultRecord = {
  version: 1;
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
};

type EncryptedLocalStore = {
  version: 1;
  algorithm: "AES-GCM";
  nonce: string;
  ciphertext: string;
};

type RecoveryArtifact = {
  artifact_id: string;
  account_id: string;
  kind: "Snapshot" | "WalletEvent";
  sequence: number;
  created_at_unix_ms: number;
  payload: {
    algorithm: string;
    nonce: string;
    ciphertext: string;
  };
};

type RecoveryArtifactList = {
  artifacts: RecoveryArtifact[];
};

type RecoverySnapshotPayload = {
  version: 1;
  notes: LocalNoteRecord[];
  strategies: PrivateStrategyRecord[];
  created_at_unix_ms: number;
};

type StrategyParentMaterial = {
  parent_authorization_secret: string;
  parent_secret_commitment: string;
  parent_cancel_authority: string;
  parent_order_commitment: string;
};

type StrategyChildRecord = {
  parent_child_index: number;
  batch_id: string;
  epoch_id: number;
  order_commitment: string;
  cancellation_secret: string;
  expected_output_metadata_commitment?: string;
  funding_note_commitments?: string[];
  submitted_at_unix_ms: number;
  delegated?: boolean;
};

type OfflineRenewalPackage = {
  version: 1;
  package_id: string;
  package_commitment: string;
  created_at_unix_ms: number;
  pair: string;
  start_epoch: number;
  end_epoch: number;
  slot_count: number;
  relay_mode?: "SelfRelay" | "ZylithRelay";
  ingress_key_registry_fingerprint?: string;
  relay_policy: {
    prover_url: string;
    coordinator_url: string;
    submission_safety_buffer_ms: number;
    max_submission_delay_ms: number;
  };
  slots: OfflineRenewalSlot[];
};

type OfflineRenewalSlot = {
  slot_id: string;
  pair: string;
  batch_id: string;
  epoch_id: number;
  parent_child_index: number;
  order_commitment: string;
  ingress_request: unknown;
};

type PrivateStrategyRecord = {
  version: 1;
  deployment_scope?: string;
  id: string;
  mode: Exclude<OrderMode, "Limit" | "Maker Curve">;
  pair: string;
  side: Side;
  total_amount: string;
  child_amount: string;
  remaining_amount: string;
  limit_price: string;
  price_base_scale?: string;
  min_fill: string;
  fill_or_kill: boolean;
  submission_timing_preference?: SubmissionTimingPreference;
  max_children: number;
  next_child_index: number;
  start_epoch: number;
  end_epoch: number;
  randomized_slicing: boolean;
  slice_jitter_bps: number;
  maker_curve_points?: Array<{ price: string; base_amount: string }>;
  maker_curve_rotation_bps?: number;
  maker_inventory_cap?: string;
  renewal_window_children?: number;
  parent: StrategyParentMaterial;
  submitted_children: StrategyChildRecord[];
  offline_package?: OfflineRenewalPackage;
  status: "active" | "delegated" | "paused" | "completed" | "failed" | "cancelled";
  parent_cancel_marker?: string;
  parent_cancel_transaction_hash?: string;
  parent_cancelled_at_unix_ms?: number;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
  last_error?: string;
};

const coordinatorUrl = normalizeUrl(import.meta.env.VITE_ZYLITH_COORDINATOR_URL || localServiceUrl(3000));
const proverUrl = normalizeUrl(
  import.meta.env.VITE_ZYLITH_PRIVATE_INGRESS_URL || import.meta.env.VITE_ZYLITH_PROVER_URL || localServiceUrl(3200),
);
const indexerUrl = normalizeUrl(import.meta.env.VITE_ZYLITH_INDEXER_URL || localServiceUrl(3300));
const configuredPaymasterUrl = normalizeUrl(import.meta.env.VITE_ZYLITH_PAYMASTER_URL || localServiceUrl(8787));
const configuredChainId = normalizeText(import.meta.env.VITE_ZYLITH_CHAIN_ID);
const configuredPaymasterAddress = normalizeText(import.meta.env.VITE_ZYLITH_PAYMASTER_ADDRESS);
const configuredAuctionVerifierAddress = normalizeText(import.meta.env.VITE_ZYLITH_AUCTION_VERIFIER_ADDRESS);
const configuredShieldedAssetAdapterAddress = normalizeText(
  import.meta.env.VITE_ZYLITH_SHIELDED_ASSET_ADAPTER_ADDRESS,
);
const walletWasmModuleUrl = normalizeUrl(
  import.meta.env.VITE_ZYLITH_WALLET_WASM_MODULE_URL || "/wallet/zylith_wallet_wasm.js",
);
const ingressKeyPin = normalizeText(import.meta.env.VITE_ZYLITH_INGRESS_KEY_REGISTRY_PIN);
const scanEpochLookback = positiveInteger(import.meta.env.VITE_ZYLITH_WALLET_SCAN_EPOCH_LOOKBACK, 128);
const PBKDF2_ITERATIONS = 310_000;
const VAULT_KEY = "zylith.wallet.vault.v1";
const NOTES_PREFIX = "zylith.wallet.notes.v1:";
const STRATEGIES_PREFIX = "zylith.wallet.strategies.v1:";
const SCAN_STATE_PREFIX = "zylith.wallet.scan-state.v1:";
const STARKNET_PRIVACY_REGISTRY_PREFIX = "zylith.wallet.starknet-privacy-registry.v1:";
const STRATEGY_WORKER_INTERVAL_MS = 12_000;
const PRIVATE_SUBMISSION_MAX_DELAY_MS = 7_000;
const BATCH_SUBMISSION_SAFETY_BUFFER_MS = 15_000;
const LATEST_EPOCH_CACHE_TTL_MS = 15_000;
const PRIVATE_REPORT_OUTPUT_TAG_COUNT = boundedInteger(
  import.meta.env.VITE_ZYLITH_PRIVATE_REPORT_OUTPUT_TAG_COUNT,
  128,
  8,
  512,
);
const MAX_STRATEGY_CHILDREN = boundedInteger(
  import.meta.env.VITE_ZYLITH_MAX_STRATEGY_CHILDREN,
  86_400,
  1,
  100_000,
); // 90d at the production 90s epoch cadence.
const PENDING_DEPOSIT_FAILURE_GRACE_MS = 10 * 60 * 1000;
const CONFIRMED_DEPOSIT_REGISTRATION_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_MAKER_CURVE_ROTATION_BPS = boundedInteger(
  import.meta.env.VITE_ZYLITH_MAKER_CURVE_ROTATION_BPS,
  250,
  0,
  1_000,
);
const RECOVERY_SNAPSHOT_MIN_INTERVAL_MS = 60_000;

export async function installConfiguredZylithWalletRuntime() {
  if (typeof window === "undefined" || !walletWasmModuleUrl) return;
  try {
    const runtimeImport = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;
    const mod = (await runtimeImport(walletWasmModuleUrl)) as WalletWasmModule;
    if (typeof mod.default === "function") await mod.default();
    window.zylithWallet = createZylithWalletRuntime(mod);
    window.zylithWalletLoadError = undefined;
  } catch (error) {
    window.zylithWallet = undefined;
    window.zylithWalletLoadError = userFacingErrorMessage(error, "Failed to load Zylith wallet runtime.");
  } finally {
    window.dispatchEvent(new CustomEvent("zylith-wallet-runtime-ready"));
  }
}

export function createZylithWalletRuntime(core: WalletWasmModule): WalletRuntime {
  let seedHex: string | null = null;
  let publicConfig: WalletPublicConfig | null = null;
  let notes: LocalNoteRecord[] = [];
  let strategies: PrivateStrategyRecord[] = [];
  let deploymentScope = "unbound";
  let strategyTimer: number | null = null;
  let strategyWorkerInFlight = false;
  let recoverySyncInFlight = false;
  let postUnlockSyncInFlight = false;
  let privacyWarmupInFlight = false;
  let sessionChannel: BroadcastChannel | null = null;
  let pendingSessionUnlock: {
    nonce: string;
    resolve: (value: boolean) => void;
    timeout: number;
  } | null = null;
  let lastRecoverySnapshotAtUnixMs = 0;
  let scanState: WalletScanState = {
    version: 1,
    scanned_artifact_ids: [],
    private_report_batch_ids: [],
  };
  let latestEpochCache: { value: number | null; expiresAt: number } | null = null;

  function requireUnlocked() {
    if (!seedHex || !publicConfig) {
      throw new Error("Zylith wallet is locked");
    }
    return { seedHex, publicConfig };
  }

  function setupSessionUnlockChannel() {
    if (typeof BroadcastChannel === "undefined" || sessionChannel) return;
    sessionChannel = new BroadcastChannel(SESSION_UNLOCK_CHANNEL);
    sessionChannel.onmessage = (event) => {
      const message = event.data as { type?: string; nonce?: string; seed_hex?: string } | null;
      if (!message || typeof message !== "object") return;
      if (message.type === "request-unlock" && message.nonce && seedHex) {
        sessionChannel?.postMessage({
          type: "unlock-response",
          nonce: message.nonce,
          seed_hex: seedHex,
        });
        return;
      }
      if (
        message.type === "unlock-response" &&
        pendingSessionUnlock &&
        message.nonce === pendingSessionUnlock.nonce &&
        typeof message.seed_hex === "string"
      ) {
        const pending = pendingSessionUnlock;
        pendingSessionUnlock = null;
        window.clearTimeout(pending.timeout);
        void hydrateFromSeed(message.seed_hex)
          .then(() => pending.resolve(true))
          .catch(() => pending.resolve(false));
      }
    };
  }

  function requestSessionUnlock(): Promise<boolean> {
    if (seedHex && publicConfig) return Promise.resolve(true);
    if (!hasVault() || typeof BroadcastChannel === "undefined") return Promise.resolve(false);
    setupSessionUnlockChannel();
    if (!sessionChannel) return Promise.resolve(false);
    if (pendingSessionUnlock) return Promise.resolve(false);
    return new Promise((resolve) => {
      const nonce = randomFeltHex();
      const timeout = window.setTimeout(() => {
        if (pendingSessionUnlock?.nonce === nonce) {
          pendingSessionUnlock = null;
          resolve(false);
        }
      }, 900);
      pendingSessionUnlock = { nonce, resolve, timeout };
      sessionChannel?.postMessage({ type: "request-unlock", nonce });
    });
  }

  async function loadNotes() {
    if (!seedHex || !publicConfig) {
      notes = [];
      return;
    }
    const key = `${NOTES_PREFIX}${localStateScope()}`;
    const stored = readJson<EncryptedLocalStore>(key);
    if (!stored) {
      notes = [];
      return;
    }
    try {
      notes = (await decryptLocalStore<LocalNoteRecord[]>(
        stored,
        seedHex,
        publicConfig.account_id,
        "notes",
      ))
        .filter(record => record.deployment_scope === deploymentScope)
        .map(normalizeLocalNoteRecord);
      compactLocalNotes();
    } catch {
      quarantineLocalStore(key);
      notes = [];
    }
  }

  async function saveNotes() {
    if (!seedHex || !publicConfig) return;
    compactLocalNotes();
    const encrypted = await encryptLocalStore(
      notes.map(note => ({ ...note, deployment_scope: deploymentScope })),
      seedHex,
      publicConfig.account_id,
      "notes",
    );
    localStorage.setItem(`${NOTES_PREFIX}${localStateScope()}`, JSON.stringify(encrypted));
  }

  async function loadStrategies() {
    const unlocked = requireUnlocked();
    const key = `${STRATEGIES_PREFIX}${localStateScope()}`;
    const stored = readJson<EncryptedLocalStore>(key);
    if (!stored) {
      strategies = [];
      return;
    }
    try {
      strategies = (await decryptLocalStore<PrivateStrategyRecord[]>(
        stored,
        unlocked.seedHex,
        unlocked.publicConfig.account_id,
        "strategies",
      )).filter(strategy => strategy.deployment_scope === deploymentScope);
    } catch {
      quarantineLocalStore(key);
      strategies = [];
    }
  }

  async function saveStrategies() {
    if (!seedHex || !publicConfig) return;
    const encrypted = await encryptLocalStore(
      strategies.map(strategy => ({ ...strategy, deployment_scope: deploymentScope })),
      seedHex,
      publicConfig.account_id,
      "strategies",
    );
    localStorage.setItem(`${STRATEGIES_PREFIX}${localStateScope()}`, JSON.stringify(encrypted));
  }

  async function loadScanState() {
    if (!seedHex || !publicConfig) {
      scanState = { version: 1, scanned_artifact_ids: [], private_report_batch_ids: [] };
      return;
    }
    const key = `${SCAN_STATE_PREFIX}${localStateScope()}`;
    const stored = readJson<EncryptedLocalStore>(key);
    if (!stored) {
      scanState = { version: 1, scanned_artifact_ids: [], private_report_batch_ids: [] };
      return;
    }
    try {
      const decoded = await decryptLocalStore<Partial<WalletScanState>>(
        stored,
        seedHex,
        publicConfig.account_id,
        "scan-state",
      );
      scanState = {
        version: 1,
        scanned_artifact_ids: uniqueStrings(decoded.scanned_artifact_ids),
        private_report_batch_ids: uniqueStrings(decoded.private_report_batch_ids),
      };
    } catch {
      quarantineLocalStore(key);
      scanState = { version: 1, scanned_artifact_ids: [], private_report_batch_ids: [] };
    }
  }

  async function saveScanState() {
    if (!seedHex || !publicConfig) return;
    const encrypted = await encryptLocalStore(scanState, seedHex, publicConfig.account_id, "scan-state");
    localStorage.setItem(`${SCAN_STATE_PREFIX}${localStateScope()}`, JSON.stringify(encrypted));
  }

  async function loadStarknetPrivacySdkRegistry(): Promise<PrivateRegistry | undefined> {
    const unlocked = requireUnlocked();
    const key = `${STARKNET_PRIVACY_REGISTRY_PREFIX}${localStateScope()}`;
    const stored = readJson<EncryptedLocalStore>(key);
    if (!stored) return undefined;
    try {
      const serialized = await decryptLocalStore<SerializedStarknetPrivacyRegistry>(
        stored,
        unlocked.seedHex,
        unlocked.publicConfig.account_id,
        "starknet-privacy-registry",
      );
      return deserializeStarknetPrivacyRegistry(serialized);
    } catch {
      quarantineLocalStore(key);
      return undefined;
    }
  }

  async function saveStarknetPrivacySdkRegistry(registry: PrivateRegistry) {
    if (!seedHex || !publicConfig) return;
    const encrypted = await encryptLocalStore(
      serializeStarknetPrivacyRegistry(registry),
      seedHex,
      publicConfig.account_id,
      "starknet-privacy-registry",
    );
    localStorage.setItem(`${STARKNET_PRIVACY_REGISTRY_PREFIX}${localStateScope()}`, JSON.stringify(encrypted));
  }

  async function hydrateFromSeed(nextSeedHex: string) {
    seedHex = normalizeRecoverySeed(nextSeedHex);
    publicConfig = JSON.parse(core.zylith_wallet_derive_public_config(seedHex)) as WalletPublicConfig;
    deploymentScope = await resolveDeploymentScope();
    await loadNotes();
    await loadStrategies();
    await loadScanState();
    void warmUpStarknetPrivacyFundingForDeployment().catch(() => undefined);
    void runPostUnlockSync();
    startStrategyWorker();
    return true;
  }

  async function runPostUnlockSync() {
    if (postUnlockSyncInFlight || !seedHex || !publicConfig) return;
    postUnlockSyncInFlight = true;
    try {
      await refreshDepositConfirmations().catch(() => false);
      await syncRecoveryArtifacts({ pushSnapshot: false }).catch(() => false);
      await pruneUnsettledSettlementOutputs().catch(() => false);
      await scanNotes().catch(() => undefined);
      await pushRecoverySnapshot(false).catch(() => undefined);
    } finally {
      postUnlockSyncInFlight = false;
    }
  }

  async function warmUpStarknetPrivacyFundingForDeployment() {
    if (privacyWarmupInFlight || !seedHex) return;
    privacyWarmupInFlight = true;
    try {
      const deployment = await loadDeploymentConfig();
      const fundingRail = selectedDepositFundingRail(deployment);
      const privacyPoolAddress = requiredNonZeroFelt(fundingRail.privacyPool, "privacy_pool_address");
      const chainId = requiredString(configuredChainId || deployment.chain_id, "chain_id");
      const rpcUrl = requiredString(deployment.rpc_url || ZAN_STARKNET_SEPOLIA_RPC_URL, "rpc_url");
      const paymasterUrl = fundingRail.paymasterUrl || configuredPaymasterUrl;
      const tokenAddresses = Object.values(deployment.token_addresses ?? {})
        .map((address) => normalizeText(address))
        .filter((address): address is string => Boolean(address));
      if (!paymasterUrl || !fundingRail.privacyProofSignerClassHash || tokenAddresses.length === 0) {
        return;
      }
      await warmUpStarknetPrivacyFunding({
        seedHex,
        chainId,
        rpcUrl,
        privacyPoolAddress,
        tokenAddresses,
        paymasterUrl,
        privacyProofSignerClassHash: fundingRail.privacyProofSignerClassHash,
        minProvingDelayBlocks:
          fundingRail.minProvingDelayBlocks ?? DEFAULT_STARKNET_PRIVACY_MIN_PROVING_DELAY_BLOCKS,
      });
    } finally {
      privacyWarmupInFlight = false;
    }
  }

  function parseRecoverySeedInput(value: string) {
    const normalized = value.trim();
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(normalized)) {
      return normalizeRecoverySeed(normalized);
    }
    return normalizeRecoverySeed(core.zylith_wallet_mnemonic_to_seed_hex(normalized));
  }

  function hasVault() {
    return Boolean(readJson<VaultRecord>(VAULT_KEY));
  }

  async function createWallet(passphrase: string) {
    validateWalletPassphrase(passphrase);
    if (hasVault()) {
      throw new Error("Zylith wallet already exists");
    }
    return writeNewWalletVault(passphrase);
  }

  async function replaceWithNewWallet(passphrase: string) {
    validateWalletPassphrase(passphrase);
    lock();
    return writeNewWalletVault(passphrase);
  }

  async function writeNewWalletVault(passphrase: string) {
    const mnemonic = core.zylith_wallet_generate_mnemonic();
    const nextSeedHex = core.zylith_wallet_mnemonic_to_seed_hex(mnemonic);
    const nextVault = await encryptSeed(nextSeedHex, passphrase);
    localStorage.setItem(VAULT_KEY, JSON.stringify(nextVault));
    return hydrateFromSeed(nextSeedHex);
  }

  async function importRecoverySeed(recoveryPhraseOrSeedHex: string, passphrase: string) {
    validateWalletPassphrase(passphrase);
    if (hasVault()) {
      throw new Error("Zylith wallet already exists");
    }
    return writeRecoverySeedVault(recoveryPhraseOrSeedHex, passphrase);
  }

  async function replaceRecoverySeed(recoveryPhraseOrSeedHex: string, passphrase: string) {
    validateWalletPassphrase(passphrase);
    lock();
    return writeRecoverySeedVault(recoveryPhraseOrSeedHex, passphrase);
  }

  async function writeRecoverySeedVault(recoveryPhraseOrSeedHex: string, passphrase: string) {
    const nextSeedHex = parseRecoverySeedInput(recoveryPhraseOrSeedHex);
    core.zylith_wallet_derive_public_config(nextSeedHex);
    const nextVault = await encryptSeed(nextSeedHex, passphrase);
    localStorage.setItem(VAULT_KEY, JSON.stringify(nextVault));
    return hydrateFromSeed(nextSeedHex);
  }

  async function unlockWithPassphrase(passphrase: string) {
    if (seedHex && publicConfig) return true;
    const vault = readJson<VaultRecord>(VAULT_KEY);
    if (!vault) return false;
    let nextSeedHex: string;
    try {
      nextSeedHex = await decryptSeed(vault, passphrase);
    } catch {
      return false;
    }
    return hydrateFromSeed(nextSeedHex);
  }

  async function exportRecoverySeed(passphrase: string) {
    const vault = readJson<VaultRecord>(VAULT_KEY);
    if (!vault) throw new Error("Create or import a Zylith wallet first");
    return core.zylith_wallet_seed_hex_to_mnemonic(await decryptSeed(vault, passphrase));
  }

  function lock() {
    if (pendingSessionUnlock) {
      window.clearTimeout(pendingSessionUnlock.timeout);
      pendingSessionUnlock.resolve(false);
      pendingSessionUnlock = null;
    }
    if (strategyTimer !== null) {
      window.clearInterval(strategyTimer);
      strategyTimer = null;
    }
    strategyWorkerInFlight = false;
    postUnlockSyncInFlight = false;
    seedHex = null;
    publicConfig = null;
    deploymentScope = "unbound";
    notes = [];
    strategies = [];
    scanState = { version: 1, scanned_artifact_ids: [], private_report_batch_ids: [] };
    latestEpochCache = null;
  }

  async function scanNotes() {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (!indexerUrl) return false;
    const artifacts = await fetchVisibleArtifacts();
    let notesChanged = false;
    let scanStateChanged = false;
    const scannedArtifactIds = new Set(scanState.scanned_artifact_ids);
    const knownNoteCommitments = new Set(
      notes.map((record) => normalizeFeltForComparison(record.note_commitment)),
    );
    const pendingArtifacts = artifacts.filter((artifact) =>
      artifact.settled_at_unix_ms && !scannedArtifactIds.has(artifact.batch_id),
    );
    const fetchedBundles = await mapWithConcurrency(pendingArtifacts, 4, async (artifact) => ({
      artifact,
      bundle: await fetchOutputBundle(artifact.batch_id).catch(() => null),
    }));
    for (const { artifact, bundle } of fetchedBundles) {
      if (!bundle) continue;
      const scanned = JSON.parse(
        artifact.output_note_root
          ? core.zylith_wallet_scan_output_bundle_with_root(
              unlockedSeed,
              JSON.stringify(bundle),
              artifact.output_note_root,
            )
          : core.zylith_wallet_scan_output_bundle(unlockedSeed, JSON.stringify(bundle)),
      ) as {
        notes: Array<{
          batch_id: string;
          note_commitment: string;
          note: LocalNoteRecord["note"];
          output_note?: unknown;
          output_proof?: unknown;
        }>;
      };
      const attributionByOutput = await fetchMakerAttributionForScannedNotes(
        unlockedSeed,
        artifact.batch_id,
        scanned.notes,
      );
      for (const scannedNote of scanned.notes) {
        const normalizedCommitment = normalizeFeltForComparison(scannedNote.note_commitment);
        if (knownNoteCommitments.has(normalizedCommitment)) {
          continue;
        }
        notes.push({
          note_commitment: scannedNote.note_commitment,
          deployment_scope: deploymentScope,
          batch_id: scannedNote.batch_id,
          source: "settlement_output",
          note: scannedNote.note,
          output_note: scannedNote.output_note,
          output_proof: scannedNote.output_proof,
          maker_attribution: attributionByOutput.get(scannedNote.note_commitment),
        });
        knownNoteCommitments.add(normalizedCommitment);
        notesChanged = true;
      }
      scannedArtifactIds.add(artifact.batch_id);
      scanStateChanged = true;
    }
    if (scanStateChanged) {
      scanState.scanned_artifact_ids = [...scannedArtifactIds].slice(-512);
      await saveScanState();
    }
    if (notesChanged) {
      await saveNotes();
      scheduleRecoverySnapshot(false);
    }
    return notesChanged;
  }

  async function refreshPrivateState() {
    await refreshDepositState();
    await syncSettlementOutputs();
  }

  async function refreshDepositState() {
    return refreshDepositConfirmations().catch(() => false);
  }

  async function syncSettlementOutputs() {
    const pruned = await pruneUnsettledSettlementOutputs().catch(() => false);
    const scanned = await scanNotes().catch(() => false);
    return pruned || scanned;
  }

  async function syncPrivateSettlementReports(requests: PrivateSettlementReportRequest[]) {
    const { seedHex: unlockedSeed, publicConfig: unlockedConfig } = requireUnlocked();
    if (!coordinatorUrl || requests.length === 0) return [];
    const reports: PrivateSettlementReport[] = [];
    let notesChanged = false;
    let scanStateChanged = false;
    const syncedBatchIds = new Set(scanState.private_report_batch_ids);
    for (const request of requests) {
      const batchId = request.batch_id?.trim();
      if (!batchId) continue;
      const keyTags = JSON.parse(
        core.zylith_wallet_output_recovery_key_tags(
          unlockedSeed,
          batchId,
          PRIVATE_REPORT_OUTPUT_TAG_COUNT,
        ),
      ) as OutputRecoveryKeyTagList;
      const report = await postJson<PrivateSettlementReport>(
        coordinatorUrl,
        `/api/recovery/${encodeURIComponent(unlockedConfig.account_id)}/settlement-reports/${encodeURIComponent(batchId)}`,
        {
          output_recovery_key_tags: keyTags.key_tags,
          order_commitments: uniqueStrings(request.order_commitments),
        },
        recoveryHeaders(unlockedSeed),
      ).catch(() => null);
      if (!report) continue;
      reports.push(report);
      for (const execution of report.order_execution_reports ?? []) {
        if (BigInt(execution.filled_amount || "0") <= 0n) continue;
        const fundingCommitments = uniqueStrings([
          ...(execution.funding_note_commitments ?? []),
          execution.funding_note_commitment,
        ]);
        if (fundingCommitments.length === 0) continue;
        const normalizedCommitments = new Set(fundingCommitments.map(normalizeFeltForComparison));
        notes = notes.map((note) => {
          if (!normalizedCommitments.has(normalizeFeltForComparison(note.note_commitment))) return note;
          notesChanged = true;
          return {
            ...note,
            locked_by_order: undefined,
            spent: true,
          };
        });
      }
      for (const record of report.output_recovery_records ?? []) {
        try {
          const payload = JSON.parse(
            core.zylith_wallet_decrypt_output_recovery_record(
              unlockedSeed,
              report.batch_id,
              record.output_index,
              JSON.stringify(record.recovery),
              report.output_note_root,
            ),
          ) as OwnedOutputNotePayload;
          if (!payload.output_note?.note_commitment) continue;
          const noteCommitment = normalizeNoteCommitment(payload.output_note.note_commitment);
          if (notes.some((note) => normalizeFeltForComparison(note.note_commitment) === normalizeFeltForComparison(noteCommitment))) {
            continue;
          }
          notes.push({
            note_commitment: noteCommitment,
            deployment_scope: deploymentScope,
            batch_id: report.batch_id,
            source: "settlement_output",
            note: payload.note,
            output_note: payload.output_note,
            output_proof: payload.output_proof,
          });
          notesChanged = true;
        } catch {
          // A report may include recovery slots that do not decrypt under the current wallet after rotation.
        }
      }
      if (!syncedBatchIds.has(report.batch_id)) {
        syncedBatchIds.add(report.batch_id);
        scanStateChanged = true;
      }
    }
    if (scanStateChanged) {
      scanState.private_report_batch_ids = [...syncedBatchIds].slice(-512);
      await saveScanState();
    }
    if (notesChanged) {
      await saveNotes();
      scheduleRecoverySnapshot(false);
    }
    return reports;
  }

  async function syncRecoveryArtifacts(options: { pushSnapshot?: boolean } = {}) {
    requireUnlocked();
    if (!coordinatorUrl) return false;
    if (recoverySyncInFlight) return false;
    recoverySyncInFlight = true;
    try {
      const merged = await pullRecoverySnapshots();
      if (merged) {
        await saveNotes();
        await saveStrategies();
      }
      if (options.pushSnapshot ?? true) {
        await pushRecoverySnapshot(true);
      }
      return true;
    } finally {
      recoverySyncInFlight = false;
    }
  }

  async function consolidateNotes(request: NoteConsolidationRequest): Promise<NoteConsolidationResult> {
    const { seedHex: unlockedSeed } = requireUnlocked();
    const sourceCommitments = request.sourceNoteCommitments
      .map(normalizeFeltForComparison)
      .filter((commitment): commitment is string => Boolean(commitment));
    if (sourceCommitments.length < 2) {
      throw new Error("Select at least two notes to consolidate");
    }
    const sourceSet = new Set(sourceCommitments);
    const inputRecords = notes.filter((record) =>
      sourceSet.has(normalizeFeltForComparison(record.note_commitment)) &&
      !record.spent &&
      !record.locked_by_order &&
      !(record.source === "deposit" && record.deposit_confirmed !== true) &&
      !record.pending_withdrawal_tx,
    );
    if (inputRecords.length !== sourceSet.size) {
      throw new Error("One or more selected notes are no longer available");
    }
    const targetAmounts = request.targetAmounts
      .map((amount) => amount.trim())
      .filter(Boolean);
    if (targetAmounts.length === 0) {
      throw new Error("Consolidation target notes are missing");
    }
    const consolidationId = `consolidation-${Date.now()}-${randomFeltHex().slice(2, 14)}`;
    const draft = JSON.parse(
      core.zylith_wallet_build_note_consolidation_draft(
        JSON.stringify({
          seed_hex: unlockedSeed,
          consolidation_id: consolidationId,
          input_notes: inputRecords.map((record) => record.note),
          target_amounts: targetAmounts,
        }),
      ),
    ) as {
      consolidation_id: string;
      output_notes: unknown[];
      output_note_preimages: LocalNoteRecord["note"][];
      output_recovery_records: unknown[];
      output_recovery_dummy_commitments: string[];
      output_ciphertext_bundle_ref: string;
      outputs: Array<{
        batch_id: string;
        note_commitment: string;
        note: LocalNoteRecord["note"];
        output_note: unknown;
        output_proof: unknown;
      }>;
    };
    const prepared = await postJson<{ witness: unknown }>(
      proverUrl,
      "/api/private/note-consolidations/prepare",
      {
        consolidation_id: consolidationId,
        input_notes: inputRecords.map((record) => record.note),
        output_notes: draft.output_notes,
        output_note_preimages: draft.output_note_preimages,
        output_recovery_records: draft.output_recovery_records,
        output_recovery_dummy_commitments: draft.output_recovery_dummy_commitments,
        output_ciphertext_bundle_ref: draft.output_ciphertext_bundle_ref,
      },
    );
    const signedWitness = JSON.parse(
      core.zylith_wallet_sign_note_consolidation_witness(
        JSON.stringify({
          seed_hex: unlockedSeed,
          witness: prepared.witness,
        }),
      ),
    );
    const submitted = await postJson<NoteConsolidationResult>(
      proverUrl,
      "/api/private/note-consolidations/submit",
      { witness: signedWitness },
    );
    if (String(submitted.execution_status ?? "").toUpperCase() === "REVERTED") {
      throw new Error("Note consolidation transaction reverted");
    }
    const outputNotes = draft.outputs.map((output) => ({
      note_commitment: normalizeNoteCommitment(output.note_commitment),
      deployment_scope: deploymentScope,
      batch_id: consolidationId,
      source: "settlement_output" as const,
      note: output.note,
      output_note: output.output_note,
      output_proof: output.output_proof,
    }));
    notes = notes.map((record) => {
      if (!sourceSet.has(normalizeFeltForComparison(record.note_commitment))) return record;
      return { ...record, locked_by_order: undefined, spent: true };
    });
    for (const output of outputNotes) {
      mergeRecoveredNote(output);
    }
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    return submitted;
  }

  async function submitDepositViaWallet(asset: string, amount: string) {
    requireUnlocked();
    const normalizedAsset = normalizeAssetId(asset);
    const rawAmount = parseRawAmount(amount, "deposit amount");
    const deployment = await loadDeploymentConfig();
    const fundingRail = selectedDepositFundingRail(deployment);
    return submitDepositViaStarknetPrivacySdk(
      fundingRail,
      deployment,
      normalizedAsset,
      rawAmount,
    );
  }

  async function submitDepositViaStarknetPrivacySdk(
    fundingRail: StarknetPrivacyDepositFundingRail,
    deployment: DeploymentConfig,
    asset: string,
    rawAmount: bigint,
  ): Promise<{
    transaction_hash: string;
    note_commitment: string;
    note_commitments: string[];
  }> {
    const { seedHex: unlockedSeed } = requireUnlocked();
    const privacyPoolAddress = requiredNonZeroFelt(fundingRail.privacyPool, "privacy_pool_address");
    const bridgeAddress = requiredNonZeroFelt(fundingRail.bridgeAdapter, "privacy_deposit_bridge_address");
    const shieldedAssetAdapterAddress = requiredNonZeroFelt(
      fundingRail.shieldedAssetAdapter || configuredShieldedAssetAdapterAddress,
      "shielded_asset_adapter_address",
    );
    const tokenAddress = requiredNonZeroFelt(
      deployment.token_addresses?.[asset],
      `${asset} token address`,
    );
    const chainId = requiredString(configuredChainId || deployment.chain_id, "chain_id");
    const rpcUrl = requiredString(deployment.rpc_url || ZAN_STARKNET_SEPOLIA_RPC_URL, "rpc_url");
    const discoveryUrl = normalizeUrl(fundingRail.discoveryUrl);
    const provingUrl = normalizeUrl(fundingRail.provingUrl);
    if (!discoveryUrl || !provingUrl) {
      throw new Error("Private deposit service URLs are required");
    }
    if (rawAmount <= 0n) {
      throw new Error("Deposit amount must be greater than zero");
    }
    const provider = await selectInjectedStarknetProvider();
    const depositRequestId = randomFeltHex();
    const depositChunks = splitDepositAmount(rawAmount, asset, assetDecimals(asset));
    const plans = depositChunks.map((depositChunk) => JSON.parse(
      core.zylith_wallet_build_deposit_submission_plan(
        JSON.stringify({
          seed_hex: unlockedSeed,
          asset_id: asset,
          amount: depositChunk.toString(),
          deposit_nonce: randomU64(),
          deposit_authority_address: bridgeAddress,
          token_address: tokenAddress,
          shielded_asset_adapter_address: shieldedAssetAdapterAddress,
        }),
      ),
    ) as {
      note: LocalNoteRecord["note"];
      note_commitment: string | { value?: string };
      encoded_args: {
        asset_id: string;
        amount: string;
        deposit_nonce: string;
        note_commitment: string;
        withdraw_authority: string;
      };
    });

    if (plans.length === 0) {
      throw new Error("Deposit split produced no notes");
    }
    const noteCommitments = plans.map((plan) => normalizeNoteCommitment(plan.note_commitment));
    const totalDepositAmount = plans.reduce(
      (sum, plan) => sum + BigInt(plan.encoded_args.amount),
      0n,
    );
    if (totalDepositAmount !== rawAmount) {
      throw new Error("Deposit split total does not match requested amount");
    }
    if (plans.some((plan) => plan.encoded_args.asset_id !== plans[0]?.encoded_args.asset_id)) {
      throw new Error("Deposit split produced mixed assets");
    }
    const requestTime = Date.now();
    for (const plan of plans) {
      const noteCommitment = normalizeNoteCommitment(plan.note_commitment);
      const existing = notes.find((record) => record.note_commitment === noteCommitment);
      if (!existing) {
        notes.push({
          note_commitment: noteCommitment,
          deployment_scope: deploymentScope,
          source: "deposit",
          note: plan.note,
          deposit_confirmed: false,
          deposit_request_id: depositRequestId,
          deposit_requested_at_unix_ms: requestTime,
        });
      }
    }
    await saveNotes();
    await pushRecoverySnapshot(true);
    const sdkRegistry = await loadStarknetPrivacySdkRegistry().catch(() => undefined);
    let depositResult: SubmitPrivacyBridgeDepositResult;
    try {
      depositResult = await submitPrivacyBridgeDeposit({
        provider: provider as never,
        seedHex: unlockedSeed,
        chainId,
        rpcUrl,
        privacyPoolAddress,
        bridgeAddress,
        tokenAddress,
        discoveryUrl,
        provingUrl,
        paymasterAddress: fundingRail.paymasterAddress || configuredPaymasterAddress,
        paymasterUrl: fundingRail.paymasterUrl || configuredPaymasterUrl,
        privacyProofSignerClassHash: fundingRail.privacyProofSignerClassHash,
        minProvingDelayBlocks:
          fundingRail.minProvingDelayBlocks ?? DEFAULT_STARKNET_PRIVACY_MIN_PROVING_DELAY_BLOCKS,
        sdkRegistry,
        plan: {
          amount: totalDepositAmount,
          encodedArgs: {
            asset_id: plans[0]?.encoded_args.asset_id ?? asset,
            total_amount: totalDepositAmount.toString(),
            amounts: plans.map((plan) => plan.encoded_args.amount),
            deposit_nonces: plans.map((plan) => plan.encoded_args.deposit_nonce),
            note_commitments: plans.map((plan) => plan.encoded_args.note_commitment),
            withdraw_authorities: plans.map((plan) => plan.encoded_args.withdraw_authority),
          },
        },
      });
    } catch (error) {
      const plannedCommitments = new Set(noteCommitments);
      notes = notes.filter((record) =>
        !plannedCommitments.has(record.note_commitment) ||
        record.pending_deposit_tx ||
        record.deposit_confirmed === true,
      );
      await saveNotes();
      scheduleRecoverySnapshot(false);
      throw error;
    }
    await saveStarknetPrivacySdkRegistry(depositResult.sdkRegistry).catch(() => undefined);
    const transactionHash = depositResult.transactionHash;
    for (const noteCommitment of noteCommitments) {
      const record = notes.find((entry) => entry.note_commitment === noteCommitment);
      if (!record) continue;
      record.pending_deposit_tx = transactionHash;
      record.deposit_failed = undefined;
      record.deposit_failure_reason = undefined;
    }
    await saveNotes();
    scheduleRecoverySnapshot(false);
    void (async () => {
      await waitForStarknetTransaction(transactionHash, deployment, "Private deposit");
      await refreshDepositConfirmations().catch(() => false);
    })().catch((error) => {
      console.warn("Deposit confirmation polling failed", error);
    });
    return {
      transaction_hash: transactionHash,
      note_commitment: noteCommitments[0] ?? "",
      note_commitments: noteCommitments,
    };
  }

  async function waitForStarknetTransaction(
    transactionHash: string,
    deployment: DeploymentConfig,
    label: string,
  ) {
    const deadline = Date.now() + 180_000;
    let lastStatus: { failed?: boolean; reason?: string; confirmed?: boolean } | null = null;
    while (Date.now() < deadline) {
      lastStatus = await fetchTransactionReceiptStatus(transactionHash, deployment).catch(() => null);
      if (lastStatus?.failed) {
        throw new Error(`${label} failed: ${lastStatus.reason ?? "transaction reverted"}`);
      }
      if (lastStatus?.confirmed) return;
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
    }
    throw new Error(
      `${label} was submitted but is not confirmed yet. Please retry later after the network confirms it.`,
    );
  }

  async function refreshDepositConfirmations() {
    if (!indexerUrl) return false;
    const pending = notes.filter(
      (record) =>
        record.source === "deposit" &&
        record.deposit_confirmed !== true &&
        !record.spent,
    );
    if (pending.length === 0) return false;
    const pendingCommitments = pending.map((record) => normalizeNoteCommitment(record.note_commitment));
    const confirmedCommitments = await fetchConfirmedDepositCommitments(pendingCommitments);
    let changed = false;
    for (const record of pending) {
      if (!confirmedCommitments.has(normalizeNoteCommitment(record.note_commitment))) continue;
      record.deposit_confirmed = true;
      record.pending_deposit_tx = undefined;
      record.deposit_failed = undefined;
      record.deposit_failure_reason = undefined;
      changed = true;
    }
    const unconfirmed = pending.filter(
      (record) =>
        !record.deposit_failed &&
        !confirmedCommitments.has(normalizeNoteCommitment(record.note_commitment)),
    );
    if (await markFailedPendingDeposits(unconfirmed)) {
      changed = true;
    }
    if (changed) {
      await saveNotes();
      scheduleRecoverySnapshot(false);
    }
    return changed;
  }

  async function fetchConfirmedDepositCommitments(noteCommitments: string[]) {
    const confirmedCommitments = new Set<string>();
    const confirmations = await postJson<{
      confirmed?: Array<{ note_commitment?: string | { value?: string } }>;
    }>(
      indexerUrl,
      "/api/deposits/confirmations",
      { note_commitments: noteCommitments },
    ).catch((error) => {
      console.warn("Deposit confirmation lookup failed", error);
      return null;
    });
    for (const record of confirmations?.confirmed ?? []) {
      try {
        if (record.note_commitment) {
          confirmedCommitments.add(normalizeNoteCommitment(record.note_commitment));
        }
      } catch {
        // Ignore malformed indexer rows and keep the deposit pending until the receipt reconciliation handles it.
      }
    }
    const missingCommitments = noteCommitments.filter((commitment) => !confirmedCommitments.has(commitment));
    if (missingCommitments.length === 0) return confirmedCommitments;
    const individualLookups = await Promise.all(
      missingCommitments.map(async (commitment) => {
        const record = await fetchJson<{ note_commitment?: string | { value?: string } }>(
          indexerUrl,
          `/api/deposits/${encodeURIComponent(commitment)}`,
        ).catch(() => null);
        try {
          return record?.note_commitment ? normalizeNoteCommitment(record.note_commitment) : null;
        } catch {
          return null;
        }
      }),
    );
    for (const commitment of individualLookups) {
      if (commitment) confirmedCommitments.add(commitment);
    }
    return confirmedCommitments;
  }

  async function markFailedPendingDeposits(pending: LocalNoteRecord[]) {
    if (pending.length === 0) return false;
    const deployment = await loadDeploymentConfig();
    let changed = false;
    for (const record of pending) {
      const ageMs = Date.now() - (record.deposit_requested_at_unix_ms ?? Date.now());
      if (!record.pending_deposit_tx) {
        if (ageMs >= PENDING_DEPOSIT_FAILURE_GRACE_MS) {
          record.spent = true;
          changed = true;
        }
        continue;
      }
      const status = await fetchTransactionReceiptStatus(record.pending_deposit_tx, deployment).catch(() => null);
      if (status?.failed) {
        record.deposit_failed = true;
        record.deposit_failure_reason = status.reason ?? "Deposit transaction failed.";
        changed = true;
        continue;
      }
      if (status?.notFound && ageMs >= PENDING_DEPOSIT_FAILURE_GRACE_MS) {
        record.deposit_failed = true;
        record.deposit_failure_reason = "Deposit transaction was not found on Starknet.";
        changed = true;
        continue;
      }
      if (status?.confirmed && ageMs >= CONFIRMED_DEPOSIT_REGISTRATION_GRACE_MS) {
        record.deposit_failed = true;
        record.deposit_failure_reason = "Deposit transaction confirmed, but no Zylith note was registered.";
        changed = true;
      }
    }
    return changed;
  }

  async function submitPrivateOrder(draft: PrivateOrderDraft) {
    requireUnlocked();
    if (STRATEGY_ORDER_MODES.has(draft.mode)) {
      if (draft.offlineDelegation) {
        const offlinePackage = await createOfflineRenewalPackage(draft);
        return {
          order_id: offlinePackage.package_id,
          offline_package: offlinePackage,
          status: `offline renewal package prepared with ${offlinePackage.slot_count} exact child slots`,
        };
      }
      return createPrivateStrategy(draft);
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error("Coordinator and private ingress URLs are required for private order submission");
    }
    const batch = await fetchCurrentPairBatch(draft.pair);
    if (!batch || batch.batch_id !== draft.batchId || batch.status !== "Open") {
      throw new Error("Order batch is no longer open");
    }
    const registry = await fetchIngressRegistry();
    const submitted = await submitSinglePrivateOrder(draft, batch, registry);
    return {
      order_id: submitted.order_commitment,
      order_commitment: submitted.order_commitment,
      batch_id: submitted.batch_id,
      cancellation_secret: submitted.cancellation_secret,
      expected_output_metadata_commitment: submitted.expected_output_metadata_commitment,
      funding_note_commitments: submitted.funding_note_commitments,
      status: "private ingress accepted",
    };
  }

  async function cancelPrivateOrder(request: {
    batch_id: string;
    order_commitment: string;
    cancellation_secret: string;
  }) {
    requireUnlocked();
    const accepted = await postJson<{
      cancelled_at_unix_ms: number;
    }>(coordinatorUrl, "/api/orders/cancel", {
      batch_id: request.batch_id,
      order_commitment: request.order_commitment,
      cancellation_secret: request.cancellation_secret,
    });
    const orderCommitment = normalizeFeltForComparison(request.order_commitment);
    notes = notes.map((note) =>
      normalizeFeltForComparison(note.locked_by_order) === orderCommitment
        ? { ...note, locked_by_order: undefined }
        : note,
    );
    await saveNotes();
    scheduleRecoverySnapshot(false);
    return accepted;
  }

  async function settlePrivateOrderLock(
    orderCommitment: string,
    outcome: "released" | "spent",
    fundingFallback?: { asset?: string; amount?: string; batchId?: string; noteCommitments?: string[] },
  ) {
    requireUnlocked();
    const expectedOrderCommitment = normalizeFeltForComparison(orderCommitment);
    let changed = false;
    notes = notes.map((note) => {
      if (normalizeFeltForComparison(note.locked_by_order) !== expectedOrderCommitment) return note;
      changed = true;
      return {
        ...note,
        locked_by_order: undefined,
        spent: outcome === "spent" ? true : note.spent,
      };
    });
    if (outcome === "spent" && fundingFallback?.noteCommitments?.length) {
      const commitments = new Set(
        fundingFallback.noteCommitments.map(normalizeFeltForComparison),
      );
      notes = notes.map((note) => {
        if (!commitments.has(normalizeFeltForComparison(note.note_commitment))) return note;
        changed = true;
        return {
          ...note,
          locked_by_order: undefined,
          spent: true,
        };
      });
    }
    if (!changed && outcome === "spent" && !spentFallbackAlreadyApplied(expectedOrderCommitment)) {
      changed = markSpentByFundingFallback(fundingFallback);
      if (changed) markSpentFallbackApplied(expectedOrderCommitment);
    }
    if (!changed) return false;
    await saveNotes();
    scheduleRecoverySnapshot(false);
    return true;
  }

  function markSpentByFundingFallback(fundingFallback?: { asset?: string; amount?: string; batchId?: string }) {
    const asset = fundingFallback?.asset?.trim();
    const amount = fundingFallback?.amount?.trim();
    if (!asset || !amount) return false;
    const required = parseHumanAmount(amount, asset);
    if (required <= 0n) return false;
    const candidates = notes
      .filter((record) =>
        !record.spent &&
        !record.locked_by_order &&
        record.note.asset_id === asset &&
        (record.source !== "deposit" || record.deposit_confirmed === true) &&
        !(record.source === "settlement_output" && record.batch_id === fundingFallback?.batchId),
      )
      .sort((left, right) => {
        const leftAmount = BigInt(left.note.amount);
        const rightAmount = BigInt(right.note.amount);
        if (leftAmount < rightAmount) return -1;
        if (leftAmount > rightAmount) return 1;
        return left.note_commitment.localeCompare(right.note_commitment);
      });
    const selected = smallestSufficientNoteSet(candidates, required, "balanced");
    if (selected.length === 0) return false;
    for (const note of selected) {
      note.spent = true;
      note.locked_by_order = undefined;
    }
    return true;
  }

  function spentFallbackKey(orderCommitment: string) {
    return `zylith.spent-fallback.${localStateScope()}.${orderCommitment}`;
  }

  function spentFallbackAlreadyApplied(orderCommitment: string) {
    try {
      return localStorage.getItem(spentFallbackKey(orderCommitment)) === "1";
    } catch {
      return false;
    }
  }

  function markSpentFallbackApplied(orderCommitment: string) {
    try {
      localStorage.setItem(spentFallbackKey(orderCommitment), "1");
    } catch {
      /* noop */
    }
  }

  async function submitRenewalParentCancelMarker(strategy: PrivateStrategyRecord) {
    const { seedHex: unlockedSeed } = requireUnlocked();
    const deployment = await loadDeploymentConfig();
    const chainId = requiredString(configuredChainId || deployment.chain_id, "chain_id");
    const auctionVerifierAddress = requiredNonZeroFelt(
      deployment.contracts?.auction_verifier || configuredAuctionVerifierAddress,
      "auction_verifier_address",
    );
    const plan = JSON.parse(
      core.zylith_wallet_build_renewal_parent_cancel_submission_plan(
        JSON.stringify({
          seed_hex: unlockedSeed,
          chain_id: chainId,
          auction_verifier_address: auctionVerifierAddress,
          parent_secret_commitment: strategy.parent.parent_secret_commitment,
          parent_cancel_authority: strategy.parent.parent_cancel_authority,
          prior_renewal_entries: [],
        }),
      ),
    ) as {
      starknet_call: { contract_address: string; entrypoint: string; calldata: string[] };
      encoded_args: { cancel_marker: string };
    };
    const transactionHash = await executeInjectedStarknetCalls([plan.starknet_call]);
    return {
      transactionHash,
      cancelMarker: plan.encoded_args.cancel_marker,
    };
  }

  async function cancelPrivateStrategy(strategyId: string) {
    requireUnlocked();
    const strategy = strategies.find((entry) => entry.id === strategyId);
    if (!strategy) throw new Error("Strategy not found");
    const parentCancel = await submitRenewalParentCancelMarker(strategy);
    const cancelledAt = Date.now();
    strategy.status = "cancelled";
    strategy.parent_cancel_marker = parentCancel.cancelMarker;
    strategy.parent_cancel_transaction_hash = parentCancel.transactionHash;
    strategy.parent_cancelled_at_unix_ms = cancelledAt;
    strategy.updated_at_unix_ms = cancelledAt;
    for (const child of strategy.submitted_children) {
      if (!child.order_commitment || !child.cancellation_secret || !coordinatorUrl) continue;
      await postJson(coordinatorUrl, "/api/orders/cancel", {
        batch_id: child.batch_id,
        order_commitment: child.order_commitment,
        cancellation_secret: child.cancellation_secret,
      }).catch(() => undefined);
    }
    const childCommitments = new Set(
      strategy.submitted_children
        .map((child) => normalizeFeltForComparison(child.order_commitment))
        .filter(Boolean),
    );
    const strategyLockRef = strategyFundingLockRef(strategy);
    notes = notes.map((note) =>
      note.locked_by_order && (
        childCommitments.has(normalizeFeltForComparison(note.locked_by_order)) ||
        normalizeFeltForComparison(note.locked_by_order) === strategyLockRef
      )
        ? { ...note, locked_by_order: undefined }
        : note,
    );
    await saveNotes();
    await saveStrategies();
    scheduleRecoverySnapshot(false);
    return {
      cancelled_at_unix_ms: cancelledAt,
      parent_cancel_transaction_hash: parentCancel.transactionHash,
    };
  }

  async function pausePrivateStrategy(strategyId: string) {
    requireUnlocked();
    const strategy = strategies.find((entry) => entry.id === strategyId);
    if (!strategy) throw new Error("Strategy not found");
    if (strategy.status === "cancelled" || strategy.status === "completed") {
      throw new Error("Finished strategies cannot be paused");
    }
    const pausedAt = Date.now();
    strategy.status = "paused";
    strategy.updated_at_unix_ms = pausedAt;
    await saveStrategies();
    scheduleRecoverySnapshot(false);
    return { paused_at_unix_ms: pausedAt };
  }

  async function resumePrivateStrategy(strategyId: string) {
    requireUnlocked();
    const strategy = strategies.find((entry) => entry.id === strategyId);
    if (!strategy) throw new Error("Strategy not found");
    if (strategy.status !== "paused") {
      throw new Error("Only paused strategies can be resumed");
    }
    const batch = await fetchCurrentPairBatch(strategy.pair).catch(() => null);
    const resumedAt = Date.now();
    if (batch && batch.status === "Open") {
      const nextEpoch = batch.close_time_unix_ms - Date.now() > BATCH_SUBMISSION_SAFETY_BUFFER_MS
        ? batch.epoch_id
        : batch.epoch_id + 1;
      const remainingSlots = Math.max(1, strategy.max_children - strategy.next_child_index + 1);
      if (nextEpoch > strategy.end_epoch) {
        strategy.start_epoch = nextEpoch;
        strategy.end_epoch = nextEpoch + remainingSlots - 1;
      }
    }
    strategy.status = strategy.offline_package ? "delegated" : "active";
    strategy.updated_at_unix_ms = resumedAt;
    await saveStrategies();
    scheduleRecoverySnapshot(false);
    startStrategyWorker();
    if (strategy.status === "active") {
      await runStrategyWorkerOnce().catch(() => undefined);
    }
    return { resumed_at_unix_ms: resumedAt };
  }

  async function refreshPrivateStrategyPackage(strategyId: string) {
    requireUnlocked();
    const strategy = strategies.find((entry) => entry.id === strategyId);
    if (!strategy) throw new Error("Strategy not found");
    if (strategy.status === "cancelled") throw new Error("Cancelled strategies cannot be refreshed");
    if (strategy.mode !== "Resting") {
      throw new Error("Renewal package refresh is only supported for resting maker curves");
    }
    const offlinePackage = await createOfflineRenewalPackageForStrategy(strategy);
    strategy.status = "delegated";
    strategy.updated_at_unix_ms = Date.now();
    await saveNotes();
    await saveStrategies();
    await pushRecoverySnapshot(true);
    return offlinePackage;
  }

  async function recordOfflineRenewalRelayResults(
    packageId: string,
    results: Array<{
      slot_id?: string;
      order_commitment?: string;
      batch_id?: string;
      epoch_id?: number;
      status?: string;
      accepted?: { order_commitment?: string; batch_id?: string; accepted_at_unix_ms?: number };
    }>,
  ): Promise<boolean> {
    requireUnlocked();
    const strategy = strategies.find((entry) => entry.id === packageId);
    if (!strategy || results.length === 0) return false;
    let changed = false;
    for (const result of results) {
      if (result.status !== "submitted" && result.status !== "already_submitted") continue;
      const commitment = result.accepted?.order_commitment ?? result.order_commitment;
      const child = strategy.submitted_children.find((entry) =>
        (commitment && entry.order_commitment === commitment) ||
        (result.order_commitment && entry.order_commitment === result.order_commitment) ||
        (result.slot_id && result.slot_id === `${strategy.id}:${entry.parent_child_index}`),
      );
      if (!child) continue;
      const acceptedAt = result.accepted?.accepted_at_unix_ms ?? Date.now();
      if (commitment && child.order_commitment !== commitment) {
        child.order_commitment = commitment;
        changed = true;
      }
      if (result.accepted?.batch_id && child.batch_id !== result.accepted.batch_id) {
        child.batch_id = result.accepted.batch_id;
        changed = true;
      } else if (result.batch_id && child.batch_id !== result.batch_id) {
        child.batch_id = result.batch_id;
        changed = true;
      }
      if (typeof result.epoch_id === "number" && child.epoch_id !== result.epoch_id) {
        child.epoch_id = result.epoch_id;
        changed = true;
      }
      if (child.submitted_at_unix_ms <= 0) {
        child.submitted_at_unix_ms = acceptedAt;
        changed = true;
      }
      if (!child.delegated) {
        child.delegated = true;
        changed = true;
      }
    }
    if (!changed) return false;
    strategy.updated_at_unix_ms = Date.now();
    strategy.last_error = undefined;
    await saveStrategies();
    scheduleRecoverySnapshot(false);
    return true;
  }

  async function submitSinglePrivateOrder(
    draft: PrivateOrderDraft,
    batch: BatchSummary,
    registry: unknown,
    parent?: { material: StrategyParentMaterial; childIndex: number },
  ) {
    if (!DIRECT_ORDER_MODES.has(draft.mode)) {
      throw new Error(`${draft.mode} must be materialized as a parent-bound child order`);
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error("Coordinator and private ingress URLs are required for private order submission");
    }
    if (batch.status !== "Open") {
      throw new Error("Order batch is no longer open");
    }
    if (batch.close_time_unix_ms - Date.now() <= BATCH_SUBMISSION_SAFETY_BUFFER_MS) {
      throw new Error("Batch is inside the submission safety buffer");
    }
    const materializedDraft = materializeMakerCurveDraft(draft);
    const fundingNotes = selectFundingNotes(materializedDraft);
    const built = buildPrivateOrderForSlot(materializedDraft, batch, fundingNotes, registry, parent);
    await delay(privateSubmissionDelayMs(batch.close_time_unix_ms, draft.submissionTimingPreference));
    if (batch.close_time_unix_ms - Date.now() <= BATCH_SUBMISSION_SAFETY_BUFFER_MS) {
      throw new Error("Batch entered the submission safety buffer before private ingress submission");
    }
    const ingress = await postJson<IngressResponse>(
      proverUrl,
      "/api/private/orders",
      built.ingress_request,
    );
    const accepted = await postJson<CoordinatorAccepted>(
      coordinatorUrl,
      "/api/orders",
      ingress.coordinator_submission,
    );
    const acceptedOrderCommitment = normalizeFeltForComparison(
      accepted.order_commitment ?? built.order_commitment,
    );
    for (const fundingNote of fundingNotes) {
      fundingNote.locked_by_order = acceptedOrderCommitment;
    }
    await saveNotes();
    scheduleRecoverySnapshot(false);
    return {
      order_commitment: acceptedOrderCommitment,
      cancellation_secret: built.cancellation_secret,
      expected_output_metadata_commitment: built.expected_output_metadata_commitment,
      funding_note_commitments: fundingNotes.map((note) => note.note_commitment),
      batch_id: accepted.batch_id ?? batch.batch_id,
    };
  }

  async function createPrivateStrategy(draft: PrivateOrderDraft) {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (!STRATEGY_ORDER_MODES.has(draft.mode)) {
      throw new Error("Strategy worker only supports TWAP, VWAP, Repeat, and Resting");
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error("Coordinator and private ingress URLs are required for strategy submission");
    }
    const batch = await fetchCurrentPairBatch(draft.pair);
    if (!batch || batch.batch_id !== draft.batchId || batch.status !== "Open") {
      throw new Error("Strategy batch is no longer open");
    }
    const isResting = draft.mode === "Resting";
    const makerCurvePoints = isResting ? normalizeMakerCurvePoints(draft) : [];
    if (isResting && makerCurvePoints.length === 0) {
      throw new Error("Resting maker strategy requires maker curve points");
    }
    const makerCurveBaseAmount = makerCurveTotalBaseAmount(makerCurvePoints);
    const totalAmount = isResting
      ? (parseOptionalRawAmount(draft.makerInventoryCap, "maker inventory cap")
        ?? parseOptionalRawAmount(draft.amount, "strategy amount")
        ?? makerCurveBaseAmount)
      : parseRawAmount(draft.amount, "strategy amount");
    const maxChildren = clampStrategyChildren(
      draft.maxChildren ?? draft.durationBatches ?? defaultStrategyChildren(draft.mode),
    );
    const childAmount = isResting
      ? makerCurveBaseAmount
      : (parseOptionalRawAmount(draft.childAmount, "child amount")
        ?? ceilDiv(totalAmount, BigInt(maxChildren)));
    if (childAmount <= 0n || childAmount > totalAmount) {
      throw new Error("Child amount must be positive and not exceed strategy amount");
    }
    const limitPrice = isResting
      ? makerCurveEnvelopePrice(draft.side, makerCurvePoints)
      : parseRawAmount(draft.limitPrice, "limit price");
    const minFill = normalizeOrderMinFill(draft, childAmount);
    const parent = JSON.parse(
      core.zylith_wallet_build_strategy_parent(
        JSON.stringify({
          seed_hex: unlockedSeed,
          parent_authorization_secret: randomFeltHex(),
        }),
      ),
    ) as StrategyParentMaterial;
    const strategy: PrivateStrategyRecord = {
      version: 1,
      deployment_scope: deploymentScope,
      id: crypto.randomUUID(),
      mode: draft.mode as PrivateStrategyRecord["mode"],
      pair: draft.pair,
      side: draft.side,
      total_amount: totalAmount.toString(),
      child_amount: childAmount.toString(),
      remaining_amount: totalAmount.toString(),
      limit_price: limitPrice.toString(),
      price_base_scale: draftPriceBaseScale(draft).toString(),
      min_fill: minFill.toString(),
      fill_or_kill: draft.fillOrKill,
      submission_timing_preference: draft.submissionTimingPreference ?? "balanced",
      max_children: maxChildren,
      next_child_index: 1,
      start_epoch: batch.epoch_id,
      end_epoch: batch.epoch_id + maxChildren - 1,
      randomized_slicing: draft.randomizedSlicing ?? true,
      slice_jitter_bps: normalizeJitterBps(draft.randomizedSlicingBps),
      maker_curve_points: isResting ? serializeMakerCurvePoints(makerCurvePoints) : undefined,
      maker_curve_rotation_bps: isResting ? makerCurveRotationBps(draft) : 0,
      maker_inventory_cap: isResting ? totalAmount.toString() : undefined,
      renewal_window_children: maxChildren,
      parent,
      submitted_children: [],
      status: "active",
      created_at_unix_ms: Date.now(),
      updated_at_unix_ms: Date.now(),
    };
    strategies.push(strategy);
    await saveStrategies();
    scheduleRecoverySnapshot(false);
    startStrategyWorker();
    await runStrategyWorkerOnce();
    return {
      order_id: strategy.id,
      strategy_id: strategy.id,
      first_child_order_commitment: strategy.submitted_children[0]?.order_commitment,
      first_child_batch_id: strategy.submitted_children[0]?.batch_id,
      first_child_cancellation_secret: strategy.submitted_children[0]?.cancellation_secret,
      expected_output_metadata_commitment: strategy.submitted_children[0]?.expected_output_metadata_commitment,
      funding_note_commitments: strategy.submitted_children[0]?.funding_note_commitments,
      status:
        strategy.submitted_children.length > 0
          ? "Strategy active; first child submitted"
          : "Strategy active; waiting for next safe batch window",
    };
  }

  async function createOfflineRenewalPackage(draft: PrivateOrderDraft): Promise<OfflineRenewalPackage> {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (!STRATEGY_ORDER_MODES.has(draft.mode)) {
      throw new Error("Offline renewal packages only support TWAP, VWAP, Repeat, and Resting strategies");
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error("Coordinator and private ingress URLs are required for offline renewal packages");
    }
    const currentBatch = await fetchCurrentPairBatch(draft.pair);
    if (!currentBatch || currentBatch.status !== "Open") {
      throw new Error("Current batch is unavailable; cannot anchor offline renewal slots");
    }
    const registry = await fetchIngressRegistry();
    const isResting = draft.mode === "Resting";
    const makerCurvePoints = isResting ? normalizeMakerCurvePoints(draft) : [];
    if (isResting && makerCurvePoints.length === 0) {
      throw new Error("Resting maker strategy requires maker curve points");
    }
    const makerCurveBaseAmount = makerCurveTotalBaseAmount(makerCurvePoints);
    const totalAmount = isResting
      ? (parseOptionalRawAmount(draft.makerInventoryCap, "maker inventory cap")
        ?? parseOptionalRawAmount(draft.amount, "strategy amount")
        ?? makerCurveBaseAmount)
      : parseRawAmount(draft.amount, "strategy amount");
    const maxChildren = clampStrategyChildren(
      draft.maxChildren ?? draft.durationBatches ?? defaultStrategyChildren(draft.mode),
    );
    const childAmount = isResting
      ? makerCurveBaseAmount
      : (parseOptionalRawAmount(draft.childAmount, "child amount")
        ?? ceilDiv(totalAmount, BigInt(maxChildren)));
    if (childAmount <= 0n || childAmount > totalAmount) {
      throw new Error("Child amount must be positive and not exceed strategy amount");
    }
    const limitPrice = isResting
      ? makerCurveEnvelopePrice(draft.side, makerCurvePoints)
      : parseRawAmount(draft.limitPrice, "limit price");
    const minFill = normalizeOrderMinFill(draft, childAmount);
    const firstEpoch =
      currentBatch.close_time_unix_ms - Date.now() > BATCH_SUBMISSION_SAFETY_BUFFER_MS
        ? currentBatch.epoch_id
        : currentBatch.epoch_id + 1;
    const parent = JSON.parse(
      core.zylith_wallet_build_strategy_parent(
        JSON.stringify({
          seed_hex: unlockedSeed,
          parent_authorization_secret: randomFeltHex(),
        }),
      ),
    ) as StrategyParentMaterial;
    const strategy: PrivateStrategyRecord = {
      version: 1,
      deployment_scope: deploymentScope,
      id: crypto.randomUUID(),
      mode: draft.mode as PrivateStrategyRecord["mode"],
      pair: draft.pair,
      side: draft.side,
      total_amount: totalAmount.toString(),
      child_amount: childAmount.toString(),
      remaining_amount: totalAmount.toString(),
      limit_price: limitPrice.toString(),
      price_base_scale: draftPriceBaseScale(draft).toString(),
      min_fill: minFill.toString(),
      fill_or_kill: draft.fillOrKill,
      submission_timing_preference: draft.submissionTimingPreference ?? "balanced",
      max_children: maxChildren,
      next_child_index: 1,
      start_epoch: firstEpoch,
      end_epoch: firstEpoch + maxChildren - 1,
      randomized_slicing: draft.randomizedSlicing ?? true,
      slice_jitter_bps: normalizeJitterBps(draft.randomizedSlicingBps),
      maker_curve_points: isResting ? serializeMakerCurvePoints(makerCurvePoints) : undefined,
      maker_curve_rotation_bps: isResting ? makerCurveRotationBps(draft) : 0,
      maker_inventory_cap: isResting ? totalAmount.toString() : undefined,
      renewal_window_children: maxChildren,
      parent,
      submitted_children: [],
      status: "delegated",
      created_at_unix_ms: Date.now(),
      updated_at_unix_ms: Date.now(),
    };
    const slots: OfflineRenewalSlot[] = [];
    const reservedNotes = new Set<string>();
    let restingFundingNotes: LocalNoteRecord[] | null = null;
    const fundingLocks: Array<{ notes: LocalNoteRecord[]; orderCommitment: string }> = [];
    for (let offset = 0; offset < maxChildren; offset += 1) {
      const amount = strategyChildAmount(strategy);
      if (amount <= 0n) break;
      const epoch = firstEpoch + offset;
      const batch = syntheticBatchForEpoch(draft.pair, epoch);
      const childIndex = strategy.next_child_index;
      const childDraft: PrivateOrderDraft = {
        pair: strategy.pair,
        side: strategy.side,
        mode: strategy.mode === "Resting" ? "Maker Curve" : "Limit",
        amount: amount.toString(),
        limitPrice: strategy.limit_price,
        priceBaseScale: strategy.price_base_scale,
        minFill: min(BigInt(strategy.min_fill), amount).toString(),
        fillOrKill: strategy.fill_or_kill,
        batchId: batch.batch_id,
        makerCurvePoints: strategy.mode === "Resting" ? strategyMakerCurveDraftPoints(strategy) : undefined,
        makerCurveRotationBps: strategy.mode === "Resting" ? strategy.maker_curve_rotation_bps : undefined,
        makerInventoryCap: strategy.mode === "Resting" ? strategy.maker_inventory_cap : undefined,
        submissionTimingPreference: strategy.submission_timing_preference,
        relayMode: draft.relayMode ?? "SelfRelay",
      };
      const materializedChildDraft = materializeMakerCurveDraft(childDraft);
      const fundingNotes = strategy.mode === "Resting"
        ? (restingFundingNotes ??= selectFundingNotes(
            materializedChildDraft,
            new Set<string>(),
            strategyFundingLockRef(strategy),
          ))
        : selectFundingNotes(materializedChildDraft, reservedNotes);
      if (strategy.mode !== "Resting") {
        for (const fundingNote of fundingNotes) {
          reservedNotes.add(fundingNote.note_commitment);
        }
      }
      const built = buildPrivateOrderForSlot(materializedChildDraft, batch, fundingNotes, registry, {
        material: strategy.parent,
        childIndex,
      });
      if (strategy.mode !== "Resting" || fundingLocks.length === 0) {
        fundingLocks.push({ notes: fundingNotes, orderCommitment: built.order_commitment });
      }
      strategy.submitted_children.push({
        parent_child_index: childIndex,
        batch_id: batch.batch_id,
        epoch_id: batch.epoch_id,
        order_commitment: built.order_commitment,
        cancellation_secret: built.cancellation_secret,
        expected_output_metadata_commitment: built.expected_output_metadata_commitment,
        funding_note_commitments: fundingNotes.map((note) => note.note_commitment),
        submitted_at_unix_ms: 0,
        delegated: true,
      });
      slots.push({
        slot_id: `${strategy.id}:${childIndex}`,
        pair: strategy.pair,
        batch_id: batch.batch_id,
        epoch_id: batch.epoch_id,
        parent_child_index: childIndex,
        order_commitment: built.order_commitment,
        ingress_request: built.ingress_request,
      });
      if (strategy.mode !== "Resting") {
        strategy.remaining_amount = (BigInt(strategy.remaining_amount) - amount).toString();
      }
      strategy.next_child_index += 1;
      if (strategy.mode !== "Resting" && BigInt(strategy.remaining_amount) <= 0n) break;
    }
    if (slots.length === 0) {
      throw new Error("Offline renewal package did not produce any child slots");
    }
    const packageWithoutCommitment = {
      version: 1 as const,
      package_id: strategy.id,
      package_commitment: "",
      created_at_unix_ms: Date.now(),
      pair: strategy.pair,
      start_epoch: slots[0]?.epoch_id ?? firstEpoch,
      end_epoch: slots[slots.length - 1]?.epoch_id ?? firstEpoch,
      slot_count: slots.length,
      relay_mode: draft.relayMode ?? "SelfRelay",
      ingress_key_registry_fingerprint: ingressKeyPin || undefined,
      relay_policy: {
        prover_url: proverUrl,
        coordinator_url: coordinatorUrl,
        submission_safety_buffer_ms: BATCH_SUBMISSION_SAFETY_BUFFER_MS,
        max_submission_delay_ms: submissionDelayCapMs(draft.submissionTimingPreference),
      },
      slots,
    };
    const offlinePackage: OfflineRenewalPackage = {
      ...packageWithoutCommitment,
      package_commitment: await sha256Json({
        ...packageWithoutCommitment,
        package_commitment: undefined,
      }),
    };
    strategy.offline_package = offlinePackage;
    strategies.push(strategy);
    for (const lock of fundingLocks) {
      const lockRef = strategy.mode === "Resting"
        ? strategyFundingLockRef(strategy)
        : normalizeFeltForComparison(lock.orderCommitment);
      for (const note of lock.notes) {
        note.locked_by_order = lockRef;
      }
    }
    await saveNotes();
    await saveStrategies();
    await pushRecoverySnapshot(true);
    return offlinePackage;
  }

  async function createOfflineRenewalPackageForStrategy(
    strategy: PrivateStrategyRecord,
  ): Promise<OfflineRenewalPackage> {
    if (!coordinatorUrl || !proverUrl) {
      throw new Error("Coordinator and private ingress URLs are required for offline renewal packages");
    }
    const currentBatch = await fetchCurrentPairBatch(strategy.pair);
    if (!currentBatch || currentBatch.status !== "Open") {
      throw new Error("Current batch is unavailable; cannot refresh renewal slots");
    }
    const registry = await fetchIngressRegistry();
    const makerCurvePoints = strategy.mode === "Resting" ? strategyMakerCurveDraftPoints(strategy) : [];
    if (strategy.mode === "Resting" && makerCurvePoints.length === 0) {
      throw new Error("Resting maker strategy requires maker curve points");
    }
    const firstSafeEpoch =
      currentBatch.close_time_unix_ms - Date.now() > BATCH_SUBMISSION_SAFETY_BUFFER_MS
        ? currentBatch.epoch_id
        : currentBatch.epoch_id + 1;
    const firstEpoch = Math.max(firstSafeEpoch, strategy.end_epoch + 1);
    const slotCount = clampStrategyChildren(
      strategy.renewal_window_children ??
        strategy.offline_package?.slot_count ??
        defaultStrategyChildren(strategy.mode),
    );
    const slots: OfflineRenewalSlot[] = [];
    const reservedNotes = new Set<string>();
    let restingFundingNotes: LocalNoteRecord[] | null = null;
    const fundingLocks: Array<{ notes: LocalNoteRecord[]; orderCommitment: string }> = [];
    for (let offset = 0; offset < slotCount; offset += 1) {
      const amount = strategy.mode === "Resting"
        ? makerCurveTotalBaseAmount(normalizeMakerCurvePoints({
            pair: strategy.pair,
            side: strategy.side,
            mode: "Maker Curve",
            amount: strategy.child_amount,
            limitPrice: strategy.limit_price,
            minFill: strategy.min_fill,
            fillOrKill: strategy.fill_or_kill,
            batchId: "",
            makerCurvePoints: makerCurvePoints,
          }))
        : strategyChildAmount(strategy);
      if (amount <= 0n) break;
      const epoch = firstEpoch + offset;
      const batch = syntheticBatchForEpoch(strategy.pair, epoch);
      const childIndex = strategy.next_child_index;
      const childDraft: PrivateOrderDraft = {
        pair: strategy.pair,
        side: strategy.side,
        mode: strategy.mode === "Resting" ? "Maker Curve" : "Limit",
        amount: amount.toString(),
        limitPrice: strategy.limit_price,
        priceBaseScale: strategy.price_base_scale,
        minFill: min(BigInt(strategy.min_fill), amount).toString(),
        fillOrKill: strategy.fill_or_kill,
        batchId: batch.batch_id,
        makerCurvePoints: strategy.mode === "Resting" ? makerCurvePoints : undefined,
        makerCurveRotationBps: strategy.mode === "Resting" ? strategy.maker_curve_rotation_bps : undefined,
        makerInventoryCap: strategy.mode === "Resting" ? strategy.maker_inventory_cap : undefined,
        submissionTimingPreference: strategy.submission_timing_preference,
        relayMode: strategy.offline_package?.relay_mode ?? "SelfRelay",
      };
      const materializedChildDraft = materializeMakerCurveDraft(childDraft);
      const fundingNotes = strategy.mode === "Resting"
        ? (restingFundingNotes ??= selectFundingNotes(
            materializedChildDraft,
            new Set<string>(),
            strategyFundingLockRef(strategy),
          ))
        : selectFundingNotes(materializedChildDraft, reservedNotes);
      if (strategy.mode !== "Resting") {
        for (const fundingNote of fundingNotes) {
          reservedNotes.add(fundingNote.note_commitment);
        }
      }
      const built = buildPrivateOrderForSlot(materializedChildDraft, batch, fundingNotes, registry, {
        material: strategy.parent,
        childIndex,
      });
      if (strategy.mode !== "Resting" || fundingLocks.length === 0) {
        fundingLocks.push({ notes: fundingNotes, orderCommitment: built.order_commitment });
      }
      strategy.submitted_children.push({
        parent_child_index: childIndex,
        batch_id: batch.batch_id,
        epoch_id: batch.epoch_id,
        order_commitment: built.order_commitment,
        cancellation_secret: built.cancellation_secret,
        expected_output_metadata_commitment: built.expected_output_metadata_commitment,
        funding_note_commitments: fundingNotes.map((note) => note.note_commitment),
        submitted_at_unix_ms: 0,
        delegated: true,
      });
      slots.push({
        slot_id: `${strategy.id}:${childIndex}`,
        pair: strategy.pair,
        batch_id: batch.batch_id,
        epoch_id: batch.epoch_id,
        parent_child_index: childIndex,
        order_commitment: built.order_commitment,
        ingress_request: built.ingress_request,
      });
      if (strategy.mode !== "Resting") {
        strategy.remaining_amount = (BigInt(strategy.remaining_amount) - amount).toString();
      }
      strategy.next_child_index += 1;
      if (strategy.mode !== "Resting" && BigInt(strategy.remaining_amount) <= 0n) break;
    }
    if (slots.length === 0) {
      throw new Error("Offline renewal package did not produce any child slots");
    }
    const packageWithoutCommitment = {
      version: 1 as const,
      package_id: strategy.id,
      package_commitment: "",
      created_at_unix_ms: Date.now(),
      pair: strategy.pair,
      start_epoch: slots[0]?.epoch_id ?? firstEpoch,
      end_epoch: slots[slots.length - 1]?.epoch_id ?? firstEpoch,
      slot_count: slots.length,
      relay_mode: strategy.offline_package?.relay_mode ?? "SelfRelay",
      ingress_key_registry_fingerprint: ingressKeyPin || undefined,
      relay_policy: {
        prover_url: proverUrl,
        coordinator_url: coordinatorUrl,
        submission_safety_buffer_ms: BATCH_SUBMISSION_SAFETY_BUFFER_MS,
        max_submission_delay_ms: submissionDelayCapMs(strategy.submission_timing_preference),
      },
      slots,
    };
    const offlinePackage: OfflineRenewalPackage = {
      ...packageWithoutCommitment,
      package_commitment: await sha256Json({
        ...packageWithoutCommitment,
        package_commitment: undefined,
      }),
    };
    strategy.offline_package = offlinePackage;
    strategy.max_children = Math.max(strategy.max_children, strategy.next_child_index - 1);
    strategy.renewal_window_children = slotCount;
    strategy.end_epoch = offlinePackage.end_epoch;
    strategy.last_error = undefined;
    for (const lock of fundingLocks) {
      const lockRef = strategy.mode === "Resting"
        ? strategyFundingLockRef(strategy)
        : normalizeFeltForComparison(lock.orderCommitment);
      for (const note of lock.notes) {
        note.locked_by_order = lockRef;
      }
    }
    return offlinePackage;
  }

  function startStrategyWorker() {
    if (strategyTimer !== null) return;
    strategyTimer = window.setInterval(() => {
      void runStrategyWorkerOnce();
    }, STRATEGY_WORKER_INTERVAL_MS);
  }

  async function runStrategyWorkerOnce() {
    requireUnlocked();
    if (strategyWorkerInFlight) return;
    const active = strategies.filter((strategy) => strategy.status === "active");
    if (active.length === 0) return;
    strategyWorkerInFlight = true;
    try {
      for (const strategy of active) {
        await materializeStrategyChildIfDue(strategy);
      }
      await saveStrategies();
      scheduleRecoverySnapshot(false);
    } finally {
      strategyWorkerInFlight = false;
    }
  }

  async function materializeStrategyChildIfDue(strategy: PrivateStrategyRecord) {
    if (strategy.next_child_index > strategy.max_children) {
      strategy.status = "completed";
      strategy.updated_at_unix_ms = Date.now();
      return;
    }
    const batch = await fetchCurrentPairBatch(strategy.pair);
    if (!batch || batch.status !== "Open") return;
    if (batch.epoch_id < strategy.start_epoch || batch.epoch_id > strategy.end_epoch) {
      if (batch.epoch_id > strategy.end_epoch) strategy.status = "completed";
      strategy.updated_at_unix_ms = Date.now();
      return;
    }
    if (strategy.submitted_children.some((child) => child.batch_id === batch.batch_id)) {
      return;
    }
    if (batch.close_time_unix_ms - Date.now() <= BATCH_SUBMISSION_SAFETY_BUFFER_MS) {
      return;
    }
    const amount = strategyChildAmount(strategy);
    if (amount <= 0n) {
      strategy.status = "completed";
      strategy.updated_at_unix_ms = Date.now();
      return;
    }
    const minFill = BigInt(strategy.min_fill);
    const draft: PrivateOrderDraft = {
      pair: strategy.pair,
      side: strategy.side,
      mode: strategy.mode === "Resting" ? "Maker Curve" : "Limit",
      amount: amount.toString(),
      limitPrice: strategy.limit_price,
      priceBaseScale: strategy.price_base_scale,
      minFill: (minFill > amount ? amount : minFill).toString(),
      fillOrKill: strategy.fill_or_kill,
      batchId: batch.batch_id,
        makerCurvePoints: strategy.mode === "Resting" ? strategyMakerCurveDraftPoints(strategy) : undefined,
        makerCurveRotationBps: strategy.mode === "Resting" ? strategy.maker_curve_rotation_bps : undefined,
        makerInventoryCap: strategy.mode === "Resting" ? strategy.maker_inventory_cap : undefined,
        submissionTimingPreference: strategy.submission_timing_preference,
      };
    try {
      const registry = await fetchIngressRegistry();
      const childIndex = strategy.next_child_index;
      const submitted = await submitSinglePrivateOrder(draft, batch, registry, {
        material: strategy.parent,
        childIndex,
      });
      strategy.submitted_children.push({
        parent_child_index: childIndex,
        batch_id: submitted.batch_id,
        epoch_id: batch.epoch_id,
        order_commitment: submitted.order_commitment,
        cancellation_secret: submitted.cancellation_secret,
        expected_output_metadata_commitment: submitted.expected_output_metadata_commitment,
        funding_note_commitments: submitted.funding_note_commitments,
        submitted_at_unix_ms: Date.now(),
      });
      if (strategy.mode !== "Resting") {
        strategy.remaining_amount = (BigInt(strategy.remaining_amount) - amount).toString();
      }
      strategy.next_child_index += 1;
      strategy.last_error = undefined;
      if (
        strategy.next_child_index > strategy.max_children ||
        (strategy.mode !== "Resting" && BigInt(strategy.remaining_amount) <= 0n)
      ) {
        strategy.status = "completed";
      }
      strategy.updated_at_unix_ms = Date.now();
    } catch (error) {
      strategy.last_error = userFacingErrorMessage(error, "Strategy child submission failed.");
      strategy.updated_at_unix_ms = Date.now();
    }
  }

  async function submitWithdrawalViaPaymaster(rawRequest: unknown) {
    const request = rawRequest as PaymasterWithdrawalRequest;
    const { seedHex: unlockedSeed, publicConfig: unlockedConfig } = requireUnlocked();
    const note = selectWithdrawableNote(request.note_commitment);
    const deployment = await loadDeploymentConfig();
    const fundingRail = selectedDepositFundingRail(deployment);
    const paymasterEndpointUrl = normalizeUrl(
      configuredPaymasterUrl || deployment.funding?.starknet_privacy?.paymaster_url,
    );
    if (!paymasterEndpointUrl) throw new Error("Paymaster URL is not configured");
    const chainId = requiredString(
      request.chain_id || configuredChainId || deployment.chain_id,
      "chain_id",
    );
    const paymasterAddress = requiredNonZeroFelt(
      request.paymaster_address ||
        configuredPaymasterAddress ||
        deployment.funding?.starknet_privacy?.paymaster_address,
      "paymaster_address",
    );
    const shieldedAssetAdapterAddress = requiredNonZeroFelt(
      request.shielded_asset_adapter_address ||
        fundingRail.shieldedAssetAdapter ||
        configuredShieldedAssetAdapterAddress,
      "shielded_asset_adapter_address",
    );
    const auctionVerifierAddress = request.auction_verifier_address ||
      deployment.contracts?.auction_verifier ||
      configuredAuctionVerifierAddress;
    const outputNote = request.output_note ?? note.output_note;
    const outputProof = request.output_proof ?? note.output_proof;
    const batchId = request.batch_id ?? note.batch_id;
    const plan = outputNote && outputProof && batchId
      ? JSON.parse(
          core.zylith_wallet_build_settlement_output_withdrawal_submission_plan(
            JSON.stringify({
              seed_hex: unlockedSeed,
              batch_id: batchId,
              output_note: outputNote,
              output_proof: outputProof,
              recipient: request.recipient,
              auction_verifier_address: requiredNonZeroFelt(
                auctionVerifierAddress,
                "auction_verifier_address",
              ),
              shielded_asset_adapter_address: shieldedAssetAdapterAddress,
              chain_id: chainId,
            }),
          ),
        )
      : JSON.parse(
          core.zylith_wallet_build_withdrawal_submission_plan(
            JSON.stringify({
              seed_hex: unlockedSeed,
              note_commitment: note.note_commitment,
              recipient: request.recipient,
              shielded_asset_adapter_address: shieldedAssetAdapterAddress,
              chain_id: chainId,
            }),
          ),
        );
    const result = await postJson<{ transaction_hash: string }>(
      paymasterEndpointBase(paymasterEndpointUrl),
      paymasterEndpointPath(paymasterEndpointUrl),
      {
        chain_id: chainId,
        signer_address: request.signer_address || unlockedConfig.withdraw_authority,
        paymaster_address: paymasterAddress,
        call: plan.starknet_call,
        outside_transaction: request.outside_transaction,
        relay_nonce: request.relay_nonce || randomFeltHex(),
        proof: request.proof,
        proof_facts: request.proof_facts,
      },
    );
    note.spent = true;
    note.pending_withdrawal_tx = result.transaction_hash;
    note.withdrawal_requested_at_unix_ms = Date.now();
    await saveNotes();
    await pushRecoverySnapshot(true);
    return result;
  }

  function getBalances() {
    const balances = new Map<string, { available: bigint; locked: bigint }>();
    for (const record of notes) {
      if (record.spent) continue;
      if (record.source === "deposit" && record.deposit_confirmed !== true) continue;
      const asset = record.note.asset_id;
      const current = balances.get(asset) ?? { available: 0n, locked: 0n };
      if (record.locked_by_order) {
        current.locked += BigInt(record.note.amount);
      } else {
        current.available += BigInt(record.note.amount);
      }
      balances.set(asset, current);
    }
    return Array.from(balances.entries()).map(([asset, balance]) => ({
      asset,
      available: balance.available.toString(),
      locked: balance.locked.toString(),
    }));
  }

  function getPendingDeposits() {
    return notes
      .filter((record) =>
        record.source === "deposit" &&
        record.deposit_confirmed !== true &&
        !record.spent &&
        !(record.deposit_failed === true && !record.pending_deposit_tx)
      )
      .map((record) => ({
        note_commitment: record.note_commitment,
        asset: record.note.asset_id,
        amount: record.note.amount,
        transaction_hash: record.pending_deposit_tx,
        request_id: record.deposit_request_id,
        requested_at_unix_ms: record.deposit_requested_at_unix_ms,
        confirmed: record.deposit_confirmed === true,
        failed: record.deposit_failed === true,
        failure_reason: record.deposit_failure_reason,
      }));
  }

  function getWithdrawableNotes() {
    return notes.filter(
      (record) => !(record.source === "deposit" && record.deposit_failed === true),
    ).map((record) => ({
      note_commitment: record.note_commitment,
      batch_id: record.batch_id,
      source: record.source ?? "deposit",
      asset: record.note.asset_id,
      amount: record.note.amount,
      locked: Boolean(record.locked_by_order || (record.source === "deposit" && record.deposit_confirmed !== true)),
      spent: Boolean(record.spent),
      pending_withdrawal_tx: record.pending_withdrawal_tx,
      metadata_commitment: record.note.metadata_commitment,
      maker_attribution: record.maker_attribution,
    }));
  }

  function getPrivateStrategies(): PrivateStrategySummary[] {
    return strategies.map((strategy) => ({
      id: strategy.id,
      mode: strategy.mode,
      pair: strategy.pair,
      side: strategy.side,
      status: strategy.status,
      total_amount: strategy.total_amount,
      remaining_amount: strategy.remaining_amount,
      child_amount: strategy.child_amount,
      limit_price: strategy.limit_price,
      price_base_scale: strategy.price_base_scale,
      min_fill: strategy.min_fill,
      fill_or_kill: strategy.fill_or_kill,
      maker_curve_points: strategy.maker_curve_points,
      maker_inventory_cap: strategy.maker_inventory_cap,
      renewal_window_children: strategy.renewal_window_children,
      max_children: strategy.max_children,
      next_child_index: strategy.next_child_index,
      start_epoch: strategy.start_epoch,
      end_epoch: strategy.end_epoch,
      offline_package: strategy.offline_package ? {
        package_id: strategy.offline_package.package_id,
        package_commitment: strategy.offline_package.package_commitment,
        created_at_unix_ms: strategy.offline_package.created_at_unix_ms,
        start_epoch: strategy.offline_package.start_epoch,
        end_epoch: strategy.offline_package.end_epoch,
        slot_count: strategy.offline_package.slot_count,
        relay_mode: strategy.offline_package.relay_mode,
      } : undefined,
      parent_cancel_transaction_hash: strategy.parent_cancel_transaction_hash,
      last_error: strategy.last_error,
      submitted_children: strategy.submitted_children.map((child) => ({
        parent_child_index: child.parent_child_index,
        batch_id: child.batch_id,
        epoch_id: child.epoch_id,
        order_commitment: child.order_commitment,
        cancellation_secret: child.cancellation_secret,
        expected_output_metadata_commitment: child.expected_output_metadata_commitment,
        funding_note_commitments: child.funding_note_commitments,
        submitted_at_unix_ms: child.submitted_at_unix_ms,
        delegated: child.delegated,
      })),
    }));
  }

  function previewFundingNotes(draft: PrivateOrderDraft): FundingPreview {
    const materializedDraft = materializeMakerCurveDraft(draft);
    const selected = selectFundingNotes(materializedDraft);
    const required = fundingRequirement(materializedDraft);
    const selectedTotal = selected.reduce((total, record) => total + BigInt(record.note.amount), 0n);
    return {
      asset: fundingAssetForDraft(materializedDraft),
      required: required.toString(),
      selected_total: selectedTotal.toString(),
      expected_change: (selectedTotal - required).toString(),
      notes: selected.map((record) => ({
        note_commitment: record.note_commitment,
        asset: record.note.asset_id,
        amount: record.note.amount,
        source: record.source ?? "deposit",
      })),
    };
  }

  setupSessionUnlockChannel();
  void requestSessionUnlock();

  return {
    hasVault,
    isReady: () => Boolean(seedHex && publicConfig),
    createWallet,
    replaceWithNewWallet,
    importRecoverySeed,
    replaceRecoverySeed,
    unlockWithPassphrase,
    requestSessionUnlock,
    exportRecoverySeed,
    syncRecoveryArtifacts,
    getPublicConfig: () => publicConfig,
    lock,
    getBalances,
    getPendingDeposits,
    getWithdrawableNotes,
    getPrivateStrategies,
    previewFundingNotes,
    consolidateNotes,
    scanNotes,
    refreshPrivateState,
    refreshDepositState,
    pruneUnsettledSettlementOutputs,
    syncSettlementOutputs,
    syncPrivateSettlementReports,
    submitDepositViaWallet,
    submitPrivateOrder,
    cancelPrivateOrder,
    cancelPrivateStrategy,
    pausePrivateStrategy,
    resumePrivateStrategy,
    refreshPrivateStrategyPackage,
    recordOfflineRenewalRelayResults,
    settlePrivateOrderLock,
    createOfflineRenewalPackage,
    getOfflineRenewalPackages: () =>
      strategies
        .filter((strategy) => strategy.status === "delegated")
        .map((strategy) => strategy.offline_package)
        .filter((offlinePackage): offlinePackage is OfflineRenewalPackage => Boolean(offlinePackage)),
    submitWithdrawalViaPaymaster,
  };

  async function fetchIngressRegistry() {
    const registry = await fetchJson<unknown>(proverUrl, "/api/public/auction-keys");
    if (!registry) throw new Error("Private ingress key registry is unavailable");
    if (ingressKeyPin) {
      const fingerprint = await fetchJson<{ fingerprint?: string }>(
        proverUrl,
        "/api/public/auction-keys/fingerprint",
      );
      if (fingerprint?.fingerprint !== ingressKeyPin) {
        throw new Error("Private ingress key registry pin mismatch");
      }
    }
    return registry;
  }

  async function fetchVisibleArtifacts() {
    const latestEpoch = await fetchLatestEpoch();
    if (latestEpoch === null) return [];
    const start = Math.max(0, latestEpoch - scanEpochLookback + 1);
    const artifactList = await fetchJson<PublishedBatchArtifactList>(
      indexerUrl,
      `/api/batches/artifacts/epochs/${start}/${latestEpoch}`,
    );
    return artifactList?.batches ?? [];
  }

  async function fetchAllVisibleArtifacts() {
    if (!indexerUrl) return [];
    const artifactList = await fetchJson<PublishedBatchArtifactList>(
      indexerUrl,
      "/api/batches/artifacts",
    );
    return artifactList?.batches ?? [];
  }

  async function pruneUnsettledSettlementOutputs() {
    if (notes.length === 0) return false;
    const pendingSettlementBatchIds = uniqueStrings(
      notes
        .filter(record => record.source === "settlement_output" && record.batch_id)
        .map(record => record.batch_id),
    );
    if (pendingSettlementBatchIds.length === 0) return false;
    const syncedBatchIds = new Set(scanState.private_report_batch_ids);
    const removableBatchIds = new Set<string>();
    await Promise.all(
      pendingSettlementBatchIds.map(async (batchId) => {
        if (syncedBatchIds.has(batchId)) return;
        const status = await fetchJson<ProofJobStatus>(
          proverUrl,
          `/api/public/proof-jobs/${encodeURIComponent(batchId)}`,
        ).catch(() => null);
        if (!status?.failure) return;
        removableBatchIds.add(batchId);
      }),
    );
    if (removableBatchIds.size === 0) return false;
    const nextNotes = notes.filter(record =>
      record.source !== "settlement_output" ||
      !record.batch_id ||
      !removableBatchIds.has(record.batch_id),
    );
    if (nextNotes.length === notes.length) return false;
    notes = nextNotes;
    await saveNotes();
    await pushRecoverySnapshot(true);
    return true;
  }

  async function fetchLatestEpoch() {
    const now = Date.now();
    if (latestEpochCache && latestEpochCache.expiresAt > now) {
      return latestEpochCache.value;
    }
    const listedBatches = await fetchJson<BatchSummary[]>(coordinatorUrl, "/api/batches")
      .catch(() => null);
    if (Array.isArray(listedBatches) && listedBatches.length > 0) {
      const epochs = listedBatches
        .map((batch) => batch?.epoch_id)
        .filter((epoch): epoch is number => typeof epoch === "number");
      const value = epochs.length > 0 ? Math.max(...epochs) : null;
      latestEpochCache = { value, expiresAt: now + LATEST_EPOCH_CACHE_TTL_MS };
      return value;
    }
    const pairIds = await enabledPairIds();
    const batches = await Promise.all(
      pairIds.map(fetchCurrentPairBatch),
    );
    const epochs = batches
      .map((batch) => batch?.epoch_id)
      .filter((epoch): epoch is number => typeof epoch === "number");
    const value = epochs.length > 0 ? Math.max(...epochs) : null;
    latestEpochCache = { value, expiresAt: now + LATEST_EPOCH_CACHE_TTL_MS };
    return value;
  }

  async function fetchCurrentPairBatch(pair: string) {
    const [base, quote] = pair.split("/");
    return fetchJson<BatchSummary>(
      coordinatorUrl,
      `/api/pairs/${base}/${quote}/batches/current`,
    );
  }

  async function enabledPairIds() {
    const deployment = await loadDeploymentConfig();
    const pairs = Object.values(deployment.product?.pairs ?? {})
      .filter((pair) => pair?.enabled !== false)
      .map((pair) => pair.pair_id)
      .filter((pair): pair is string => Boolean(pair));
    return pairs;
  }

  async function fetchOutputBundle(batchId: string) {
    return fetchJson<unknown>(indexerUrl, `/api/batches/${batchId}/output-bundle`);
  }

  async function fetchMakerAttributionForScannedNotes(
    unlockedSeed: string,
    batchId: string,
    scannedNotes: Array<{ note_commitment: string; note: LocalNoteRecord["note"] }>,
  ) {
    const attributionByOutput = new Map<string, MakerBandAttribution>();
    if (!indexerUrl || !scannedNotes.length) return attributionByOutput;
    const makerPublicKeys = [...new Set(scannedNotes.map((note) => note.note.owner_public_key))];
    for (const makerPublicKey of makerPublicKeys) {
      const list = await fetchJson<MakerAttributionArtifactList>(
        indexerUrl,
        `/api/attribution/${encodeURIComponent(batchId)}/${encodeURIComponent(makerPublicKey)}`,
      ).catch(() => null);
      if (!list?.artifacts?.length) continue;
      for (const artifact of list.artifacts) {
        try {
          const decrypted = JSON.parse(
            core.zylith_wallet_decrypt_maker_attribution_artifact(
              unlockedSeed,
              JSON.stringify(artifact),
            ),
          ) as MakerAttributionPlaintext;
          if (decrypted?.output_note_commitment && decrypted?.attribution) {
            attributionByOutput.set(decrypted.output_note_commitment, decrypted.attribution);
          }
        } catch {
          // Attribution artifacts are analytics-only. Ignore non-matching or malformed artifacts.
        }
      }
    }
    return attributionByOutput;
  }

  async function pullRecoverySnapshots() {
    const { seedHex: unlockedSeed, publicConfig: unlockedConfig } = requireUnlocked();
    const list = await fetchJson<RecoveryArtifactList>(
      coordinatorUrl,
      `/api/recovery/${encodeURIComponent(unlockedConfig.account_id)}/artifacts`,
      recoveryHeaders(unlockedSeed),
    );
    if (!list?.artifacts?.length) return false;
    const artifacts = [...list.artifacts].sort(
      (left, right) => left.sequence - right.sequence || left.created_at_unix_ms - right.created_at_unix_ms,
    );
    const snapshots = artifacts.filter(
      artifact => artifact.kind === "Snapshot" && artifact.account_id === unlockedConfig.account_id,
    );
    const latest = snapshots[snapshots.length - 1];
    if (!latest) return false;

    const payload = JSON.parse(
      core.zylith_wallet_decrypt_recovery_artifact(
        unlockedSeed,
        JSON.stringify(latest),
      ),
    ) as Partial<RecoverySnapshotPayload>;
    if (payload.version !== 1) return false;

    let changed = false;
    if (Array.isArray(payload.notes)) {
      for (const remoteNote of payload.notes) {
        changed = mergeRecoveredNote(remoteNote) || changed;
      }
    }
    if (Array.isArray(payload.strategies)) {
      for (const remoteStrategy of payload.strategies) {
        changed = mergeRecoveredStrategy(remoteStrategy) || changed;
      }
    }
    return changed;
  }

  async function pushRecoverySnapshot(force: boolean) {
    if (!coordinatorUrl || !seedHex || !publicConfig) return false;
    const now = Date.now();
    if (!force && now - lastRecoverySnapshotAtUnixMs < RECOVERY_SNAPSHOT_MIN_INTERVAL_MS) {
      return false;
    }
    const payload: RecoverySnapshotPayload = {
      version: 1,
      notes,
      strategies,
      created_at_unix_ms: now,
    };
    const artifact = JSON.parse(
      core.zylith_wallet_create_recovery_snapshot(
        JSON.stringify({
          seed_hex: seedHex,
          sequence: now,
          created_at_unix_ms: now,
          payload_json: JSON.stringify(payload),
        }),
      ),
    ) as RecoveryArtifact;
    await postJson(
      coordinatorUrl,
      `/api/recovery/${encodeURIComponent(publicConfig.account_id)}/artifacts`,
      { artifact },
      recoveryHeaders(seedHex),
    );
    lastRecoverySnapshotAtUnixMs = now;
    return true;
  }

  function scheduleRecoverySnapshot(force: boolean) {
    void pushRecoverySnapshot(force).catch(() => undefined);
  }

  function recoveryHeaders(unlockedSeed: string) {
    return {
      "x-zylith-recovery-auth": core.zylith_wallet_recovery_auth_tag(unlockedSeed),
    };
  }

  function compactLocalNotes() {
    if (notes.length < 2) return false;
    const compacted = new Map<string, LocalNoteRecord>();
    let changed = false;
    for (const rawNote of notes) {
      const note = normalizeLocalNoteRecord(rawNote);
      const key = normalizeFeltForComparison(note.note_commitment);
      const existing = compacted.get(key);
      if (!existing) {
        compacted.set(key, note);
        if (note !== rawNote || note.note_commitment !== rawNote.note_commitment) changed = true;
        continue;
      }
      changed = mergeLocalNoteRecord(existing, note) || changed;
      changed = true;
    }
    if (changed) {
      notes = [...compacted.values()];
    }
    return changed;
  }

  function mergeRecoveredNote(remoteNote: LocalNoteRecord) {
    if (!remoteNote?.note_commitment || !remoteNote.note) return false;
    if (remoteNote.deployment_scope !== deploymentScope) return false;
    const normalizedRemoteNote = normalizeLocalNoteRecord(remoteNote);
    const remoteCommitment = normalizeFeltForComparison(normalizedRemoteNote.note_commitment);
    const existing = notes.find((note) =>
      normalizeFeltForComparison(note.note_commitment) === remoteCommitment
    );
    if (!existing) {
      notes.push(normalizedRemoteNote);
      return true;
    }
    return mergeLocalNoteRecord(existing, normalizedRemoteNote);
  }

  function mergeRecoveredStrategy(remoteStrategy: PrivateStrategyRecord) {
    if (!remoteStrategy?.id) return false;
    if (remoteStrategy.deployment_scope !== deploymentScope) return false;
    const index = strategies.findIndex((strategy) => strategy.id === remoteStrategy.id);
    if (index === -1) {
      strategies.push(remoteStrategy);
      return true;
    }
    const local = strategies[index];
    if ((remoteStrategy.updated_at_unix_ms ?? 0) > (local.updated_at_unix_ms ?? 0)) {
      strategies[index] = remoteStrategy;
      return true;
    }
    return false;
  }

  async function loadDeploymentConfig() {
    try {
      const response = await fetch("/deployment.json", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return {};
      return (await response.json()) as DeploymentConfig;
    } catch {
      return {};
    }
  }

  async function resolveDeploymentScope() {
    const deployment = await loadDeploymentConfig();
    const chainId = configuredChainId || deployment.chain_id || "unknown-chain";
    const verifier = deployment.contracts?.auction_verifier || configuredAuctionVerifierAddress || "unknown-verifier";
    const fundingRail = selectedDepositFundingRail(deployment);
    const privacyBridge = fundingRail.bridgeAdapter || "unknown-privacy-bridge";
    const shieldedAssetAdapter = fundingRail.shieldedAssetAdapter || "unknown-shielded-adapter";
    return `${chainId}:${verifier}:${privacyBridge}:${shieldedAssetAdapter}`;
  }

  function localStateScope() {
    return `${publicConfig?.account_id ?? "locked"}:${deploymentScope}`;
  }

  function selectFundingNotes(
    draft: PrivateOrderDraft,
    reservedNoteCommitments = new Set<string>(),
    allowedLockedBy?: string,
  ) {
    const asset = fundingAssetForDraft(draft);
    const required = fundingRequirement(draft);
    const allowedLockRef = allowedLockedBy ? normalizeFeltForComparison(allowedLockedBy) : "";
    const candidates = notes
      .filter((record) =>
        !record.spent &&
        (!record.locked_by_order || (
          allowedLockRef !== "" &&
          normalizeFeltForComparison(record.locked_by_order) === allowedLockRef
        )) &&
        (record.source !== "deposit" || record.deposit_confirmed === true) &&
        !reservedNoteCommitments.has(record.note_commitment) &&
        record.note.asset_id === asset,
      )
      .sort((left, right) => {
        const leftAmount = BigInt(left.note.amount);
        const rightAmount = BigInt(right.note.amount);
        if (leftAmount < rightAmount) return -1;
        if (leftAmount > rightAmount) return 1;
        return left.note_commitment.localeCompare(right.note_commitment);
      });
    const selected = smallestSufficientNoteSet(
      candidates,
      required,
      draft.submissionTimingPreference ?? "balanced",
    );
    if (selected.length === 0) {
      throw new Error(`No unlocked ${asset} note can fund this order`);
    }
    return selected;
  }

  function selectWithdrawableNote(noteCommitment?: string) {
    const note = notes.find(
      (record) =>
        !record.spent &&
        !record.locked_by_order &&
        (!noteCommitment || record.note_commitment === noteCommitment),
    );
    if (!note) {
      throw new Error(
        noteCommitment
          ? "Selected note is not withdrawable"
          : "No unlocked note is available to withdraw",
      );
    }
    return note;
  }

  function buildPrivateOrderForSlot(
    draft: PrivateOrderDraft,
    batch: BatchSummary,
    fundingNotes: LocalNoteRecord[],
    registry: unknown,
    parent?: { material: StrategyParentMaterial; childIndex: number },
  ) {
    const { seedHex: unlockedSeed } = requireUnlocked();
    const order = buildOrderIntent(draft, batch, fundingNotes[0], parent);
    return JSON.parse(
      core.zylith_wallet_build_private_order_submission(
        JSON.stringify({
          seed_hex: unlockedSeed,
          registry,
          funding_note: fundingNotes[0].note,
          funding_notes: fundingNotes.map((record) => record.note),
          order,
          padding: randomPadding(2048),
        }),
      ),
    ) as {
      order_commitment: string;
      cancellation_secret: string;
      expected_output_metadata_commitment: string;
      ingress_request: unknown;
    };
  }

  function buildOrderIntent(
    draft: PrivateOrderDraft,
    batch: BatchSummary,
    fundingNote: LocalNoteRecord,
    parent?: { material: StrategyParentMaterial; childIndex: number },
  ) {
    const makerCurvePoints = normalizeMakerCurvePoints(draft);
    const amount =
      draft.mode === "Maker Curve" && makerCurvePoints.length > 0
        ? makerCurvePoints.reduce((total, point) => total + point.base_amount, 0n)
        : parseRawAmount(draft.amount, "amount");
    const limitPrice =
      draft.mode === "Maker Curve" && makerCurvePoints.length > 0
        ? makerCurveEnvelopePrice(draft.side, makerCurvePoints)
        : parseRawAmount(draft.limitPrice, "limit price");
    const minFill = normalizeOrderMinFill(draft, amount);
    const orderType = draft.mode === "Maker Curve" ? "MakerCurve" : "LimitBatch";
    const makerCurve =
      draft.mode === "Maker Curve"
        ? {
            points:
              makerCurvePoints.length > 0
                ? makerCurvePoints.map((point) => ({
                    price: point.price.toString(),
                    base_amount: point.base_amount.toString(),
                  }))
                : [{ price: limitPrice.toString(), base_amount: amount.toString() }],
          }
        : undefined;
    return {
      pair_id: draft.pair,
      batch_id: batch.batch_id,
      side: draft.side,
      order_type: orderType,
      relay_mode: draft.relayMode ?? "SelfRelay",
      maker_curve: makerCurve,
      limit_price: limitPrice.toString(),
      amount: amount.toString(),
      min_fill: minFill.toString(),
      time_in_force: draft.fillOrKill ? "FillOrKill" : "CurrentBatchOnly",
      expiry_epoch: batch.epoch_id,
      order_nonce: randomU64(),
      parent_order_commitment: parent?.material.parent_order_commitment ?? "0x0",
      parent_child_index: parent?.childIndex ?? 0,
      parent_secret_commitment: parent?.material.parent_secret_commitment ?? "0x0",
      parent_cancel_authority: parent?.material.parent_cancel_authority ?? "0x0",
      parent_authorization_secret: parent?.material.parent_authorization_secret ?? "0x0",
      funding_note_ref: fundingNote.note_commitment,
      funding_nullifier: "0x0",
      recipient_owner_public_key: "",
      recipient_spend_authority: "0x0",
      recipient_withdraw_authority: "0x0",
      recipient_residual_withdraw_authority: "0x0",
      auditor_view_allowed: false,
    };
  }
}

function fundingAssetForDraft(draft: PrivateOrderDraft) {
  const [base, quote] = draft.pair.split("/");
  return draft.side === "Buy" ? quote : base;
}

function fundingRequirement(draft: PrivateOrderDraft) {
  const priceBaseScale = draftPriceBaseScale(draft);
  const makerCurvePoints = normalizeMakerCurvePoints(draft);
  if (draft.mode === "Maker Curve" && makerCurvePoints.length > 0) {
    if (draft.side === "Sell") {
      return makerCurvePoints.reduce((total, point) => total + point.base_amount, 0n);
    }
    return makerCurvePoints.reduce(
      (total, point) => total + quoteAmountForBase(point.base_amount, point.price, priceBaseScale),
      0n,
    );
  }
  const amount = parseRawAmount(draft.amount, "amount");
  if (draft.side === "Sell") return amount;
  return quoteAmountForBase(amount, parseRawAmount(draft.limitPrice, "limit price"), priceBaseScale);
}

function smallestSufficientNoteSet(
  candidates: LocalNoteRecord[],
  required: bigint,
  preference: SubmissionTimingPreference = "balanced",
) {
  if (required <= 0n) return [];
  const boundedCandidates = fundingCandidateSearchPool(candidates, required);
  let best: LocalNoteRecord[] = [];
  let bestTotal: bigint | null = null;
  let bestNonStandardCount = -1;

  function consider(selection: LocalNoteRecord[], total: bigint) {
    if (total < required) return;
    const nonStandardCount = selection.filter(record => !isStandardNoteAmount(record)).length;
    const shouldReplace = preference === "fast"
      ? bestTotal === null ||
        selection.length < best.length ||
        (selection.length === best.length && total < bestTotal) ||
        (selection.length === best.length && total === bestTotal && nonStandardCount > bestNonStandardCount)
      : bestTotal === null ||
        total < bestTotal ||
        (total === bestTotal && selection.length < best.length) ||
        (total === bestTotal && selection.length === best.length && nonStandardCount > bestNonStandardCount);
    if (shouldReplace) {
      best = [...selection];
      bestTotal = total;
      bestNonStandardCount = nonStandardCount;
    }
  }

  function search(start: number, selection: LocalNoteRecord[], total: bigint) {
    consider(selection, total);
    if (selection.length >= MAX_ORDER_FUNDING_INPUTS || start >= boundedCandidates.length) return;
    if (bestTotal !== null && preference !== "fast" && total >= bestTotal) return;
    if (bestTotal !== null && preference === "fast" && selection.length >= best.length && total >= bestTotal) {
      return;
    }
    for (let index = start; index < boundedCandidates.length; index += 1) {
      const note = boundedCandidates[index];
      search(index + 1, [...selection, note], total + BigInt(note.note.amount));
    }
  }

  search(0, [], 0n);
  return best.sort((left, right) => {
    const leftAmount = BigInt(left.note.amount);
    const rightAmount = BigInt(right.note.amount);
    if (leftAmount > rightAmount) return -1;
    if (leftAmount < rightAmount) return 1;
    return left.note_commitment.localeCompare(right.note_commitment);
  });
}

function fundingCandidateSearchPool(candidates: LocalNoteRecord[], required: bigint) {
  if (candidates.length <= 48) return candidates;
  const byCommitment = new Map<string, LocalNoteRecord>();
  const add = (record: LocalNoteRecord) => {
    byCommitment.set(normalizeFeltForComparison(record.note_commitment), record);
  };
  candidates.slice(0, 24).forEach(add);
  candidates.slice(-24).forEach(add);
  candidates
    .filter((record) => BigInt(record.note.amount) >= required)
    .slice(0, 16)
    .forEach(add);
  candidates
    .filter((record) => !isStandardNoteAmount(record))
    .slice(0, 16)
    .forEach(add);
  [...candidates]
    .sort((left, right) => {
      const leftDelta = absBigInt(BigInt(left.note.amount) - required);
      const rightDelta = absBigInt(BigInt(right.note.amount) - required);
      if (leftDelta < rightDelta) return -1;
      if (leftDelta > rightDelta) return 1;
      const leftAmount = BigInt(left.note.amount);
      const rightAmount = BigInt(right.note.amount);
      if (leftAmount < rightAmount) return -1;
      if (leftAmount > rightAmount) return 1;
      return left.note_commitment.localeCompare(right.note_commitment);
    })
    .slice(0, 24)
    .forEach(add);
  return [...byCommitment.values()].sort((left, right) => {
    const leftAmount = BigInt(left.note.amount);
    const rightAmount = BigInt(right.note.amount);
    if (leftAmount < rightAmount) return -1;
    if (leftAmount > rightAmount) return 1;
    return left.note_commitment.localeCompare(right.note_commitment);
  });
}

function absBigInt(value: bigint) {
  return value < 0n ? -value : value;
}

function isStandardNoteAmount(record: LocalNoteRecord) {
  const denominations = denominationTableForAsset(
    record.note.asset_id,
    assetDecimals(record.note.asset_id),
  );
  return denominations.some(denomination => denomination === BigInt(record.note.amount));
}

function quoteAmountForBase(baseAmount: bigint, price: bigint, priceBaseScale: bigint) {
  if (priceBaseScale <= 0n) throw new Error("Price base scale must be non-zero");
  return (baseAmount * price) / priceBaseScale;
}

function normalizeOrderMinFill(draft: PrivateOrderDraft, amount: bigint) {
  if (amount <= 0n) throw new Error("Order amount must be positive");
  if (draft.fillOrKill) return amount;
  const parsed = parseOptionalRawAmount(draft.minFill, "minimum fill");
  return min(parsed ?? 1n, amount);
}

function draftPriceBaseScale(draft: PrivateOrderDraft) {
  const explicit = parseOptionalRawAmount(draft.priceBaseScale, "price base scale");
  return explicit ?? pairPriceBaseScale(draft.pair);
}

function pairPriceBaseScale(pair: string) {
  const [base] = pair.split("/");
  return 10n ** BigInt(assetDecimals(base));
}

function assetDecimals(asset: string) {
  if (asset === "USDC" || asset === "USDT") return 6;
  if (asset === "strkBTC" || asset === "WBTC") return 8;
  return 18;
}

function normalizeJitterBps(value: number | undefined) {
  if (!Number.isFinite(value ?? NaN)) return 1_500;
  return Math.max(0, Math.min(5_000, Math.round(value ?? 0)));
}

type NormalizedMakerCurvePoint = { price: bigint; base_amount: bigint };

function normalizeMakerCurvePoints(draft: PrivateOrderDraft) {
  return (draft.makerCurvePoints ?? [])
    .filter((point) => point.price.trim() && point.baseAmount.trim())
    .map((point) => ({
      price: parseRawAmount(point.price, "maker curve price"),
      base_amount: parseRawAmount(point.baseAmount, "maker curve base amount"),
    }))
    .sort((left, right) => (left.price < right.price ? -1 : left.price > right.price ? 1 : 0));
}

function materializeMakerCurveDraft(draft: PrivateOrderDraft): PrivateOrderDraft {
  if (draft.mode !== "Maker Curve") return draft;
  const points = normalizeMakerCurvePoints(draft);
  if (points.length === 0) return draft;
  const rotated = rotateMakerCurvePoints(points, makerCurveRotationBps(draft));
  const amount = makerCurveTotalBaseAmount(rotated);
  const minFill = normalizeOrderMinFill(draft, amount);
  return {
    ...draft,
    amount: amount.toString(),
    limitPrice: makerCurveEnvelopePrice(draft.side, rotated).toString(),
    minFill: minFill.toString(),
    makerCurvePoints: rotated.map((point) => ({
      price: point.price.toString(),
      baseAmount: point.base_amount.toString(),
    })),
  };
}

function rotateMakerCurvePoints(
  points: NormalizedMakerCurvePoint[],
  maxAbsoluteBps: number,
): NormalizedMakerCurvePoint[] {
  if (maxAbsoluteBps <= 0) return enforceStrictMakerCurvePrices(points);
  const priceFactor = BigInt(randomBasisPointsJitter(maxAbsoluteBps));
  return enforceStrictMakerCurvePrices(
    points.map((point) => ({
      price: applyBasisPointFactor(point.price, priceFactor),
      base_amount: applyBasisPointFactor(
        point.base_amount,
        BigInt(randomBasisPointsJitter(maxAbsoluteBps)),
      ),
    })),
  );
}

function enforceStrictMakerCurvePrices(points: NormalizedMakerCurvePoint[]) {
  const sorted = points
    .map((point) => ({
      price: point.price <= 0n ? 1n : point.price,
      base_amount: point.base_amount <= 0n ? 1n : point.base_amount,
    }))
    .sort((left, right) => (left.price < right.price ? -1 : left.price > right.price ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].price <= sorted[index - 1].price) {
      sorted[index] = { ...sorted[index], price: sorted[index - 1].price + 1n };
    }
  }
  return sorted;
}

function applyBasisPointFactor(value: bigint, factorBps: bigint) {
  const adjusted = (value * factorBps) / 10_000n;
  return adjusted <= 0n ? 1n : adjusted;
}

function makerCurveTotalBaseAmount(points: NormalizedMakerCurvePoint[]) {
  return points.reduce((total, point) => total + point.base_amount, 0n);
}

function serializeMakerCurvePoints(points: NormalizedMakerCurvePoint[]) {
  return points.map((point) => ({
    price: point.price.toString(),
    base_amount: point.base_amount.toString(),
  }));
}

function strategyMakerCurveDraftPoints(strategy: PrivateStrategyRecord) {
  return (strategy.maker_curve_points ?? []).map((point) => ({
    price: point.price,
    baseAmount: point.base_amount,
  }));
}

function strategyFundingLockRef(strategy: PrivateStrategyRecord) {
  return normalizeFeltForComparison(strategy.parent.parent_order_commitment);
}

function makerCurveRotationBps(draft: PrivateOrderDraft) {
  return boundedInteger(
    draft.makerCurveRotationBps,
    DEFAULT_MAKER_CURVE_ROTATION_BPS,
    0,
    1_000,
  );
}

function makerCurveEnvelopePrice(
  side: Side,
  points: NormalizedMakerCurvePoint[],
) {
  const envelope = side === "Buy" ? points[points.length - 1] : points[0];
  if (!envelope) throw new Error("Maker curve must contain at least one point");
  return envelope.price;
}

function syntheticBatchForEpoch(pair: string, epoch: number): BatchSummary {
  return {
    batch_id: batchIdForPairEpoch(pair, epoch),
    pair_id: pair,
    epoch_id: epoch,
    close_time_unix_ms: Number.MAX_SAFE_INTEGER,
    status: "Open",
    order_count_bucket: "offline-preauthorized",
  };
}

function batchIdForPairEpoch(pair: string, epoch: number) {
  return `batch-${pair.toLowerCase().replace("/", "-")}-${epoch}`;
}

function strategyChildAmount(strategy: PrivateStrategyRecord) {
  const remaining = BigInt(strategy.remaining_amount);
  if (remaining <= 0n) return 0n;
  if (strategy.mode === "Resting") {
    const points = strategyMakerCurveDraftPoints(strategy);
    const total = makerCurveTotalBaseAmount(
      points.map((point) => ({
        price: parseRawAmount(point.price, "maker curve price"),
        base_amount: parseRawAmount(point.baseAmount, "maker curve base amount"),
      })),
    );
    return total > 0n ? total : BigInt(strategy.child_amount);
  }
  const remainingSlots = Math.max(1, strategy.max_children - strategy.next_child_index + 1);
  let amount = BigInt(strategy.child_amount);
  if (strategy.mode === "TWAP") {
    amount = ceilDiv(remaining, BigInt(remainingSlots));
  } else if (strategy.mode === "VWAP") {
    const weights = [80n, 95n, 120n, 115n, 90n];
    const weight = weights[strategy.submitted_children.length % weights.length] ?? 100n;
    amount = (amount * weight) / 100n;
  }
  if (strategy.randomized_slicing) {
    amount = (amount * BigInt(randomBasisPointsJitter(strategy.slice_jitter_bps ?? 1_500))) / 10_000n;
  }
  if (amount <= 0n) amount = 1n;
  const futureSlots = BigInt(Math.max(0, remainingSlots - 1));
  const maxCurrent = remaining > futureSlots ? remaining - futureSlots : remaining;
  return amount > maxCurrent ? maxCurrent : amount;
}

function defaultStrategyChildren(mode: OrderMode) {
  if (mode === "Resting") return 24;
  if (mode === "Repeat") return 8;
  return 6;
}

function clampStrategyChildren(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Strategy child count must be a positive integer");
  }
  return Math.min(value, MAX_STRATEGY_CHILDREN);
}

function ceilDiv(numerator: bigint, denominator: bigint) {
  return (numerator + denominator - 1n) / denominator;
}

function min(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function parseRawAmount(value: string, label: string) {
  const trimmed = value.trim();
  const field = label ? label[0].toUpperCase() + label.slice(1) : "Value";
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`${field} must be a raw integer amount`);
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) throw new Error(`${field} must be positive`);
  return parsed;
}

function parseOptionalRawAmount(value: string | undefined, label: string) {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || /^0+$/.test(trimmed)) return null;
  return parseRawAmount(value, label);
}

function parseHumanAmount(value: string, asset: string) {
  const trimmed = value.trim();
  if (!trimmed || !/^\d*(\.\d*)?$/.test(trimmed) || trimmed === ".") return 0n;
  const decimals = assetDecimals(asset);
  const [whole = "0", fractional = ""] = trimmed.split(".");
  const fractionalAtomic = fractional.padEnd(decimals, "0").slice(0, decimals) || "0";
  return (BigInt(whole || "0") * 10n ** BigInt(decimals)) + BigInt(fractionalAtomic);
}

function normalizeRecoverySeed(value: string) {
  const normalized = value.trim().replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Recovery seed must be 64 hex characters");
  }
  return normalized;
}

function validateWalletPassphrase(passphrase: string) {
  if (typeof passphrase !== "string" || passphrase.trim().length === 0) {
    throw new Error("Zylith wallet passphrase cannot be blank");
  }
}

function normalizeAssetId(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_:-]+$/.test(normalized)) {
    throw new Error("Asset ID contains unsupported characters");
  }
  return normalized;
}

function normalizeNoteCommitment(value: string | { value?: string }) {
  const raw = typeof value === "string" ? value : value.value;
  if (!raw || typeof raw !== "string") {
    throw new Error("Deposit plan is missing a note commitment");
  }
  const normalized = raw.trim().toLowerCase();
  return normalized.startsWith("0x") ? normalized : `0x${normalized}`;
}

function normalizeFeltForComparison(value: string | undefined | null) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return `0x${BigInt(trimmed).toString(16)}`;
  } catch {
    const normalized = trimmed.toLowerCase();
    const hex = normalized.startsWith("0x") ? normalized.slice(2) : normalized;
    return `0x${hex.replace(/^0+/, "") || "0"}`;
  }
}

function normalizeLocalNoteRecord(record: LocalNoteRecord): LocalNoteRecord {
  return {
    ...record,
    note_commitment: normalizeFeltForComparison(record.note_commitment) || normalizeNoteCommitment(record.note_commitment),
    locked_by_order: record.locked_by_order
      ? normalizeFeltForComparison(record.locked_by_order)
      : undefined,
  };
}

function mergeLocalNoteRecord(existing: LocalNoteRecord, incoming: LocalNoteRecord): boolean {
  let changed = false;
  const normalizedIncoming = normalizeLocalNoteRecord(incoming);
  const normalizedExistingCommitment =
    normalizeFeltForComparison(existing.note_commitment) || existing.note_commitment;
  if (existing.note_commitment !== normalizedExistingCommitment) {
    existing.note_commitment = normalizedExistingCommitment;
    changed = true;
  }
  if (normalizedIncoming.deployment_scope && existing.deployment_scope !== normalizedIncoming.deployment_scope) {
    existing.deployment_scope = normalizedIncoming.deployment_scope;
    changed = true;
  }
  if (normalizedIncoming.source === "settlement_output" && existing.source !== "settlement_output") {
    existing.source = "settlement_output";
    changed = true;
  } else if (!existing.source && normalizedIncoming.source) {
    existing.source = normalizedIncoming.source;
    changed = true;
  }
  if (normalizedIncoming.batch_id && existing.batch_id !== normalizedIncoming.batch_id) {
    existing.batch_id = normalizedIncoming.batch_id;
    changed = true;
  }
  if (normalizedIncoming.output_note && !existing.output_note) {
    existing.output_note = normalizedIncoming.output_note;
    changed = true;
  }
  if (normalizedIncoming.output_proof && !existing.output_proof) {
    existing.output_proof = normalizedIncoming.output_proof;
    changed = true;
  }
  if (normalizedIncoming.maker_attribution && !existing.maker_attribution) {
    existing.maker_attribution = normalizedIncoming.maker_attribution;
    changed = true;
  }
  if (normalizedIncoming.pending_deposit_tx && !existing.pending_deposit_tx) {
    existing.pending_deposit_tx = normalizedIncoming.pending_deposit_tx;
    changed = true;
  }
  if (normalizedIncoming.deposit_confirmed && !existing.deposit_confirmed) {
    existing.deposit_confirmed = true;
    changed = true;
  }
  if (normalizedIncoming.deposit_failed && !existing.deposit_failed) {
    existing.deposit_failed = true;
    existing.deposit_failure_reason = normalizedIncoming.deposit_failure_reason;
    changed = true;
  }
  if (normalizedIncoming.spent && !existing.spent) {
    existing.spent = true;
    existing.locked_by_order = undefined;
    changed = true;
  }
  if (!existing.spent && normalizedIncoming.locked_by_order && !existing.locked_by_order) {
    existing.locked_by_order = normalizedIncoming.locked_by_order;
    changed = true;
  }
  if (normalizedIncoming.pending_withdrawal_tx && !existing.pending_withdrawal_tx) {
    existing.pending_withdrawal_tx = normalizedIncoming.pending_withdrawal_tx;
    existing.withdrawal_requested_at_unix_ms = normalizedIncoming.withdrawal_requested_at_unix_ms;
    changed = true;
  }
  return changed;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  )];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }));
  return results;
}

function selectedDepositFundingRail(deployment: DeploymentConfig): DepositFundingRail {
  const primary = deployment.funding?.primary || "starknet_privacy";
  if (primary !== "starknet_privacy") {
    throw new Error(`Unsupported funding rail: ${primary}`);
  }
  const selected: DepositFundingRail = {
    kind: "starknet_privacy",
    privacyPool: deployment.funding?.starknet_privacy?.privacy_pool,
    bridgeAdapter:
      deployment.funding?.starknet_privacy?.bridge_adapter ||
      deployment.contracts?.privacy_deposit_bridge,
    discoveryUrl: deployment.funding?.starknet_privacy?.discovery_url,
    provingUrl: deployment.funding?.starknet_privacy?.proving_url,
    paymasterAddress: deployment.funding?.starknet_privacy?.paymaster_address,
    paymasterUrl: deployment.funding?.starknet_privacy?.paymaster_url,
    privacyProofSignerClassHash: deployment.funding?.starknet_privacy?.proof_signer_class_hash,
    sdkPackage: deployment.funding?.starknet_privacy?.sdk_package,
    sdkVersion: deployment.funding?.starknet_privacy?.sdk_version,
    minProvingDelayBlocks: deployment.funding?.starknet_privacy?.min_proving_delay_blocks,
    shieldedAssetAdapter:
      deployment.funding?.starknet_privacy?.shielded_asset_adapter ||
      deployment.contracts?.shielded_asset_adapter,
  };
  if (
    selected.privacyPool &&
    selected.bridgeAdapter &&
    selected.discoveryUrl &&
    selected.provingUrl &&
    selected.shieldedAssetAdapter
  ) {
    return selected;
  }
  throw new Error("Private deposit funding is not fully configured");
}

async function executeInjectedStarknetCalls(
  calls: Array<{ contract_address: string; entrypoint: string; calldata: string[] }>,
) {
  try {
    const provider = await selectInjectedStarknetProvider();
    const accountCalls = calls.map((call) => ({
      contractAddress: call.contract_address,
      entrypoint: call.entrypoint,
      calldata: call.calldata,
    }));
    const walletCalls = calls.map((call) => ({
      contract_address: call.contract_address,
      entry_point: call.entrypoint,
      calldata: call.calldata,
    }));
    const result = provider.request
      ? await requestWalletInvokeWithAccountFallback(provider, walletCalls, accountCalls)
      : await executeWalletCalls(provider, accountCalls, walletCalls);
    const transactionHash = extractTransactionHash(result);
    if (!transactionHash) {
      throw new Error("Starknet wallet did not return a transaction hash");
    }
    return transactionHash;
  } catch (error) {
    throw normalizeWalletTransactionError(error);
  }
}

function isWalletCallShapeError(error: unknown) {
  const message = walletErrorMessage(error);
  return /invalid_union|invalid input|contractAddress|contract_address|entrypoint|entry_point/i.test(message);
}

function isUserRejectedWalletError(error: unknown) {
  return /user rejected|user denied|user abort|rejected by user|cancelled|canceled/i.test(walletErrorMessage(error));
}

function isWalletRequestUnavailableError(error: unknown) {
  return /method not found|not supported|unsupported|not implemented|unknown method|wallet_addInvokeTransaction/i.test(walletErrorMessage(error));
}

async function executeWalletCalls(
  provider: StarknetInjectedProvider,
  accountCalls: StarknetWalletCall[],
  walletCalls: LegacyStarknetWalletCall[],
) {
  try {
    return await provider.account?.execute?.(accountCalls);
  } catch (error) {
    if (!isWalletCallShapeError(error)) throw error;
    return provider.account?.execute?.(walletCalls as unknown as StarknetWalletCall[]);
  }
}

async function requestWalletInvokeWithAccountFallback(
  provider: StarknetInjectedProvider,
  walletCalls: LegacyStarknetWalletCall[],
  accountCalls: StarknetWalletCall[],
) {
  try {
    return await requestWalletInvoke(provider, walletCalls, accountCalls);
  } catch (error) {
    if (
      !provider.account?.execute ||
      isUserRejectedWalletError(error) ||
      !isWalletRequestUnavailableError(error)
    ) {
      throw error;
    }
    return executeWalletCalls(provider, accountCalls, walletCalls);
  }
}

async function requestWalletInvoke(
  provider: StarknetInjectedProvider,
  walletCalls: LegacyStarknetWalletCall[],
  accountCalls: StarknetWalletCall[],
) {
  if (!provider.request) return undefined;
  try {
    return await provider.request({
      type: "wallet_addInvokeTransaction",
      params: { calls: walletCalls },
    });
  } catch (error) {
    if (!isWalletCallShapeError(error)) throw error;
    return provider.request({
      type: "wallet_addInvokeTransaction",
      params: { calls: accountCalls },
    });
  }
}

function runtimeAddressFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const address = runtimeAddressFromUnknown(item);
      if (address) return address;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return runtimeAddressFromUnknown(record.address)
    ?? runtimeAddressFromUnknown(record.selectedAddress)
    ?? runtimeAddressFromUnknown(record.account)
    ?? runtimeAddressFromUnknown(record.accounts);
}

function providerHasConnectedAddress(provider: StarknetInjectedProvider) {
  return Boolean(
    runtimeAddressFromUnknown(provider.account?.address)
      ?? runtimeAddressFromUnknown(provider.selectedAddress),
  );
}

function connectedProviderAddress(provider: StarknetInjectedProvider) {
  return runtimeAddressFromUnknown(provider.account?.address)
    ?? runtimeAddressFromUnknown(provider.selectedAddress);
}

function rememberProviderAddress(provider: StarknetInjectedProvider, address: string) {
  try {
    provider.selectedAddress = provider.selectedAddress || address;
  } catch {
    // Some injected wallet objects expose read-only properties.
  }
  if (provider.account && !provider.account.address) {
    try {
      provider.account.address = address;
    } catch {
      // Some account wrappers expose read-only properties.
    }
  }
  try {
    window.localStorage.setItem(SELECTED_STARKNET_WALLET_STORAGE_KEY, providerIdFor("selected", provider));
    window.localStorage.setItem(CONNECTED_STARKNET_ADDRESS_STORAGE_KEY, address);
  } catch {
    // Local storage can be unavailable; mutating the in-memory provider is sufficient for this session.
  }
}

async function ensureWalletAccountAccess(provider: StarknetInjectedProvider) {
  const existing = connectedProviderAddress(provider);
  if (existing) return existing;
  if (provider.request) {
    const silent = await provider.request({
      type: "wallet_requestAccounts",
      params: { silent_mode: true },
    }).catch(() => null);
    const silentAddress = runtimeAddressFromUnknown(silent) || connectedProviderAddress(provider);
    if (silentAddress) {
      rememberProviderAddress(provider, silentAddress);
      return silentAddress;
    }
    const interactive = await provider.request({
      type: "wallet_requestAccounts",
      params: { silent_mode: false },
    }).catch(() => null);
    const interactiveAddress = runtimeAddressFromUnknown(interactive) || connectedProviderAddress(provider);
    if (interactiveAddress) {
      rememberProviderAddress(provider, interactiveAddress);
      return interactiveAddress;
    }
  } else if (provider.enable) {
    const enabled = await provider.enable().catch(() => null);
    const enabledAddress = runtimeAddressFromUnknown(enabled) || connectedProviderAddress(provider);
    if (enabledAddress) {
      rememberProviderAddress(provider, enabledAddress);
      return enabledAddress;
    }
  }
  throw new Error("Connect a Starknet wallet before submitting this transaction");
}

function providerSearchText(key: string, provider: StarknetInjectedProvider) {
  return `${key} ${provider.id ?? ""} ${provider.name ?? ""}`.toLowerCase();
}

function providerIdFor(key: string, provider: StarknetInjectedProvider) {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("braavos")) return "braavos";
  if (normalized.includes("argent")) return "argent-x";
  if (normalized.includes("ready")) return "ready";
  return provider.id?.trim() || key;
}

function providerPriorityFor(key: string, provider: StarknetInjectedProvider) {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("braavos")) return 0;
  if (normalized.includes("argent")) return 1;
  if (key === "starknet") return 4;
  if (normalized.includes("ready")) return 5;
  return 2;
}

function isSupportedRuntimeWalletProvider(key: string, provider: StarknetInjectedProvider) {
  const normalized = providerSearchText(key, provider);
  return normalized.includes("braavos") ||
    normalized.includes("argent") ||
    normalized.includes("ready");
}

function selectedWalletId() {
  try {
    return window.localStorage.getItem(SELECTED_STARKNET_WALLET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function discoverRuntimeStarknetProviders() {
  const win = window as unknown as Window & Record<string, unknown>;
  const candidates: Array<{ key: string; provider: StarknetInjectedProvider; order: number }> = [];
  const safeWindowValue = (key: string) => {
    try {
      return win[key];
    } catch {
      return undefined;
    }
  };
  const windowPropertyNames = () => {
    try {
      return Object.getOwnPropertyNames(win);
    } catch {
      return Object.keys(win);
    }
  };
  const add = (key: string, value: unknown) => {
    if (!value || typeof value !== "object") return;
    const provider = value as StarknetInjectedProvider;
    if (typeof provider.request !== "function" && typeof provider.enable !== "function") return;
    if (candidates.some(entry => entry.provider === provider)) return;
    candidates.push({ key, provider, order: candidates.length });
  };
  const addRegistryEntry = (key: string, value: unknown) => {
    add(key, value);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const nestedKey of ["provider", "wallet", "starknet", "connector", "walletProvider", "starknetProvider"]) {
      add(`${key}_${nestedKey}`, record[nestedKey]);
      const nested = record[nestedKey];
      if (nested && typeof nested === "object") {
        const nestedRecord = nested as Record<string, unknown>;
        add(`${key}_${nestedKey}_provider`, nestedRecord.provider);
        add(`${key}_${nestedKey}_starknet`, nestedRecord.starknet);
      }
    }
  };

  add("selected", window.zylithSelectedStarknetProvider);
  addRegistryEntry("starknet_argentX", window.starknet_argentX);
  addRegistryEntry("starknet_braavos", window.starknet_braavos);
  addRegistryEntry("braavosStarknet", safeWindowValue("braavosStarknet"));
  addRegistryEntry("braavos", safeWindowValue("braavos"));
  addRegistryEntry("argentX", safeWindowValue("argentX"));
  addRegistryEntry("starknet_argent", safeWindowValue("starknet_argent"));
  addRegistryEntry("argent", safeWindowValue("argent"));
  addRegistryEntry("starknet_ready", safeWindowValue("starknet_ready"));
  addRegistryEntry("readyWallet", safeWindowValue("readyWallet"));
  addRegistryEntry("ready", safeWindowValue("ready"));
  const providerRegistry = win.starknetProviders;
  if (Array.isArray(providerRegistry)) {
    providerRegistry.forEach((provider, index) => {
      const meta = provider as StarknetInjectedProvider;
      addRegistryEntry(`starknet_provider_${meta?.id || meta?.name || index}`, provider);
    });
  } else if (providerRegistry && typeof providerRegistry === "object") {
    Object.entries(providerRegistry as Record<string, unknown>).forEach(([key, provider]) => {
      addRegistryEntry(`starknet_provider_${key}`, provider);
    });
  }
  for (const key of windowPropertyNames()) {
    if (key.startsWith("starknet") || /braavos|argent/i.test(key)) {
      addRegistryEntry(key, safeWindowValue(key));
    }
  }
  add("starknet", window.starknet);

  const storedId = selectedWalletId();
  return candidates
    .filter(({ key, provider }) => isSupportedRuntimeWalletProvider(key, provider))
    .sort((left, right) => {
      const leftSelected = storedId && providerIdFor(left.key, left.provider) === storedId;
      const rightSelected = storedId && providerIdFor(right.key, right.provider) === storedId;
      if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
      const leftPriority = providerPriorityFor(left.key, left.provider);
      const rightPriority = providerPriorityFor(right.key, right.provider);
      return leftPriority === rightPriority ? left.order - right.order : leftPriority - rightPriority;
    });
}

async function selectInjectedStarknetProvider() {
  const preferredProvider = selectedStarknetProvider();
  const discovered = discoverRuntimeStarknetProviders();
  const orderedProviders = preferredProvider
    ? [
        { provider: preferredProvider },
        ...discovered.filter(({ provider }) => provider !== preferredProvider),
      ]
    : discovered;
  for (const { provider } of orderedProviders) {
    try {
      await ensureWalletAccountAccess(provider);
    } catch {
      continue;
    }
    if (provider.account?.execute || provider.request) {
      const deployment = await loadWalletDeploymentConfig();
      await syncWalletRpcProvider(provider, deployment).catch(() => undefined);
      await ensureWalletChain(provider, deployment);
      return provider;
    }
  }
  throw new Error("Connect a Starknet wallet before submitting this transaction");
}

async function loadWalletDeploymentConfig(): Promise<DeploymentConfig> {
  try {
    const response = await fetch("/deployment.json", { headers: { accept: "application/json" } });
    if (!response.ok) return {};
    return (await response.json()) as DeploymentConfig;
  } catch {
    return {};
  }
}

async function syncWalletRpcProvider(provider: StarknetInjectedProvider, deployment?: DeploymentConfig) {
  if (!provider.request) return;
  if (rpcSyncedProviders.has(provider)) return;
  rpcSyncedProviders.add(provider);
  deployment = deployment ?? await loadWalletDeploymentConfig();
  const chainId = deployment.chain_id || "0x534e5f5345504f4c4941";
  const rpcUrl =
    deployment.rpc_url ||
    deployment.proof?.native_prover_rpc_url ||
    deployment.proof_config?.native_prover_rpc_url ||
    ZAN_STARKNET_SEPOLIA_RPC_URL;
  if (!chainId || !rpcUrl || !/^https?:\/\//i.test(rpcUrl)) return;
  const network = deployment.network || "starknet";
  await provider.request({
    type: "wallet_addStarknetChain",
    params: {
      id: `zylith-${network}`,
      chain_id: chainId,
      chain_name: `Zylith ${network}`,
      rpc_urls: [rpcUrl],
    },
  }).catch(() => undefined);
  await provider.request({
    type: "wallet_switchStarknetChain",
    params: { chainId },
  }).catch(() => undefined);
}

async function ensureWalletChain(provider: StarknetInjectedProvider, deployment: DeploymentConfig) {
  const expected = normalizeRuntimeChainId(deployment.chain_id || "0x534e5f5345504f4c4941");
  const actual = normalizeRuntimeChainId(await requestWalletChainId(provider));
  if (!expected || !actual || actual === expected) return;
  const networkName = deployment.network === "sepolia" ? "Starknet Sepolia" : deployment.network || "the configured Starknet network";
  throw new Error(`Wrong Starknet network. Select ${networkName} in your wallet and retry.`);
}

async function requestWalletChainId(provider: StarknetInjectedProvider): Promise<string | null> {
  if (provider.request) {
    const typed = await provider.request({ type: "wallet_requestChainId" }).catch(() => null);
    if (typeof typed === "string" && typed.trim()) return typed;
    const method = await provider.request({ method: "wallet_requestChainId" }).catch(() => null);
    if (typeof method === "string" && method.trim()) return method;
  }
  if (provider.account?.getChainId) {
    const value = await provider.account.getChainId().catch(() => null);
    if (typeof value === "string" && value.trim()) return value;
  }
  return provider.chainId ?? null;
}

function normalizeRuntimeChainId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const alias = CHAIN_ID_ALIASES[trimmed.toUpperCase()];
  if (alias) return alias;
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

function walletErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeWalletTransactionError(error: unknown) {
  if (import.meta.env.DEV) {
    console.warn("Zylith wallet transaction failed", error);
  }
  const message = walletErrorMessage(error);
  if (/too many requests|onfinality|rate limit|-32029/i.test(message)) {
    return new Error("Wallet could not prepare the transaction. Please retry later.");
  }
  if (/requested contract address .*not deployed|contract_not_found|contract address .*is not deployed/i.test(message)) {
    return new Error("Zylith contracts are unavailable on the selected wallet network. Select Starknet Sepolia and retry.");
  }
  return error instanceof Error ? error : new Error(message);
}

function extractTransactionHash(result: unknown): string | null {
  if (typeof result === "string" && result.trim()) return result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  for (const key of ["transaction_hash", "transactionHash", "hash"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

async function fetchTransactionReceiptStatus(
  transactionHash: string,
  deployment: DeploymentConfig,
): Promise<{ failed: boolean; notFound: boolean; confirmed?: boolean; reason?: string } | null> {
  const rpcUrl =
    deployment.rpc_url ||
    deployment.proof?.native_prover_rpc_url ||
    deployment.proof_config?.native_prover_rpc_url ||
    ZAN_STARKNET_SEPOLIA_RPC_URL;
  if (!rpcUrl || !/^https?:\/\//i.test(rpcUrl)) return null;

  type ReceiptResponse = { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
  let receipt: ReceiptResponse = await starknetRpc<ReceiptResponse>(
    rpcUrl,
    "starknet_getTransactionReceipt",
    { transaction_hash: transactionHash },
  ).catch(async () => starknetRpc<ReceiptResponse>(
    rpcUrl,
    "starknet_getTransactionReceipt",
    [transactionHash],
  ));
  if (receipt.error && /invalid.?params|invalid.?request/i.test(receipt.error.message ?? "")) {
    receipt = await starknetRpc<ReceiptResponse>(
      rpcUrl,
      "starknet_getTransactionReceipt",
      [transactionHash],
    );
  }

  if (receipt.error) {
    const message = `${receipt.error.message ?? ""} ${JSON.stringify(receipt.error.data ?? "")}`;
    if (/not.?found|unknown/i.test(message) || receipt.error.code === 29) {
      return { failed: false, notFound: true };
    }
    return null;
  }

  const result = receipt.result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const executionStatus = String(record.execution_status ?? record.executionStatus ?? record.status ?? "").toUpperCase();
  const finalityStatus = String(record.finality_status ?? record.finalityStatus ?? record.status ?? "").toUpperCase();
  const revertReason = typeof record.revert_reason === "string"
    ? record.revert_reason
    : typeof record.revertReason === "string"
      ? record.revertReason
      : undefined;
  if (/REVERT|REJECT/.test(executionStatus) || /REVERT|REJECT/.test(finalityStatus)) {
    return { failed: true, notFound: false, reason: revertReason || "Deposit transaction reverted." };
  }
  const confirmed = /ACCEPTED|SUCCEEDED/.test(executionStatus) || /ACCEPTED|SUCCEEDED/.test(finalityStatus);
  return { failed: false, notFound: false, confirmed };
}

async function starknetRpc<T>(rpcUrl: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Starknet network request failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function fetchJson<T>(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<T | null> {
  if (!baseUrl) return null;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    headers: { accept: "application/json", ...headers },
  });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  if (!baseUrl) throw new Error("Target service is not configured");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Request to ${path} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function encryptSeed(seedHex: string, passphrase: string): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(seedHex);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
  return {
    version: 1,
    kdf: "pbkdf2-sha256",
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptSeed(vault: VaultRecord, passphrase: string): Promise<string> {
  const salt = base64ToBytes(vault.salt);
  const nonce = base64ToBytes(vault.nonce);
  const ciphertext = base64ToBytes(vault.ciphertext);
  const key = await deriveVaultKey(passphrase, salt, vault.iterations);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
  const seedHex = new TextDecoder().decode(plaintext);
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error("Zylith wallet decrypted to an invalid seed");
  }
  return seedHex;
}

async function encryptLocalStore(
  value: unknown,
  seedHex: string,
  accountId: string,
  label: string,
): Promise<EncryptedLocalStore> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveLocalStoreKey(seedHex, accountId, label);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
  return {
    version: 1,
    algorithm: "AES-GCM",
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptLocalStore<T>(
  store: EncryptedLocalStore,
  seedHex: string,
  accountId: string,
  label: string,
): Promise<T> {
  const key = await deriveLocalStoreKey(seedHex, accountId, label);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(store.nonce) },
    key,
    base64ToBytes(store.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

async function deriveLocalStoreKey(seedHex: string, accountId: string, label: string) {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`zylith/local-store/${label}/${accountId}/${seedHex}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sha256Json(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: asArrayBuffer(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function readJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function quarantineLocalStore(key: string) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      localStorage.setItem(`${key}.corrupt.${Date.now()}`, raw);
    }
    localStorage.removeItem(key);
  } catch {
    // Local cache is recoverable from recovery artifacts or rescanning visible outputs.
  }
}

function randomU64() {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return (bytes[0] & 0x1f_ffff) * 0x1_0000_0000 + bytes[1];
}

function randomFeltHex() {
  const bytes = new Uint8Array(32);
  do {
    crypto.getRandomValues(bytes);
    bytes[0] &= 0x07;
  } while (bytes.every((byte) => byte === 0));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function randomBasisPointsJitter(maxAbsoluteBps: number) {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const span = maxAbsoluteBps * 2 + 1;
  return 10_000 - maxAbsoluteBps + (random[0] % span);
}

function submissionDelayCapMs(preference: SubmissionTimingPreference = "balanced") {
  if (preference === "fast") return 0;
  if (preference === "private") return PRIVATE_SUBMISSION_MAX_DELAY_MS;
  return Math.floor(PRIVATE_SUBMISSION_MAX_DELAY_MS / 2);
}

function privateSubmissionDelayMs(
  closeTimeUnixMs?: number,
  preference: SubmissionTimingPreference = "balanced",
) {
  if (!closeTimeUnixMs) return 0;
  const timeUntilClose = closeTimeUnixMs - Date.now();
  const maxDelay = Math.min(
    submissionDelayCapMs(preference),
    timeUntilClose - BATCH_SUBMISSION_SAFETY_BUFFER_MS,
  );
  if (maxDelay <= 0) return 0;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return Math.floor((random[0] / 0x1_0000_0000) * maxDelay);
}

function delay(ms: number) {
  return ms > 0 ? new Promise((resolve) => window.setTimeout(resolve, ms)) : Promise.resolve();
}

function randomPadding(targetBytes: number) {
  const bytes = new Uint8Array(targetBytes);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim() === "") {
    const field = label ? label[0].toUpperCase() + label.slice(1) : "Value";
    throw new Error(`${field} is required`);
  }
  return value;
}

function requiredNonZeroFelt(value: unknown, label: string) {
  const felt = requiredString(value, label).trim();
  const normalized = felt.startsWith("0x") || felt.startsWith("0X")
    ? felt.slice(2)
    : felt;
  if (/^0*$/i.test(normalized)) {
    const field = label ? label[0].toUpperCase() + label.slice(1) : "Value";
    throw new Error(`${field} must be configured`);
  }
  return felt;
}

function normalizeUrl(value: unknown) {
  return typeof value === "string" ? value.replace(/\/+$/, "") : "";
}

function localServiceUrl(port: number) {
  if (typeof window === "undefined") return "";
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return `http://${host}:${port}`;
  }
  return "";
}

function paymasterEndpointBase(endpointUrl: string) {
  return endpointUrl.replace(/\/execute-outside$/, "");
}

function paymasterEndpointPath(endpointUrl: string) {
  return endpointUrl.endsWith("/execute-outside") ? "/execute-outside" : "/execute-outside";
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value: unknown, fallback: number, minValue: number, maxValue: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minValue, Math.min(maxValue, parsed));
}
