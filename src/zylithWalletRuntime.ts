import {
  attachOrderIngressTelemetry,
  batchSubmissionSafetyBufferMs,
  delay,
  elapsedMs,
  firstRenewalSlotEpoch,
  hasBatchSubmissionSafetyWindow,
  hostedRelayLeadEpochs,
  privateSubmissionDelayMs,
  remainingBatchMs,
  renewalPackageMaxSubmissionDelayMs,
  type OrderIngressTelemetry,
} from "./domain/batchSubmission";
export {
  attachOrderIngressTelemetry,
  batchSubmissionSafetyBufferMs,
  firstRenewalSlotEpoch,
  hasBatchSubmissionSafetyWindow,
  hostedRelayLeadEpochs,
  renewalPackageMaxSubmissionDelayMs,
} from "./domain/batchSubmission";
import { assetDecimals } from "./domain/assets";
import {
  assertBatchSummary,
  assertCurrentDeploymentManifestShape,
  type BatchSummary,
} from "./domain/auctionEpoch";
import {
  denominationTableForAsset,
  splitDepositAmount,
} from "./domain/depositSplitting";
import {
  depositRecordMatchesConfirmedFunding,
  markDepositRecordFailed,
  markDepositRecordConfirmed,
  pendingDepositFailureReason,
  pendingDepositFundingCommitments,
  pendingDepositRecords,
} from "./domain/depositConfirmationState";
import {
  normalizeFeltForComparison,
  normalizeOptionalFelt,
  requiredNonZeroFelt,
  requiredString,
} from "./domain/felt";
import {
  fundingRailTokenAddress,
  noteConsolidationEnabledForDeployment,
  selectedDepositFundingRail,
  strk20WithdrawalEnabledForDeployment,
  type StarknetPrivacyDepositFundingRail,
} from "./domain/fundingRail";
export {
  noteConsolidationEnabledForDeployment,
  strk20WithdrawalEnabledForDeployment,
} from "./domain/fundingRail";
import {
  connectStarknetProvider,
  discoverStarknetWallets,
  notifyWalletRuntimeChanged,
  selectedStarknetProvider,
  setWalletRuntime,
} from "./domain/browserWallet";
import {
  bytesToBase64,
  decryptLocalStore,
  decryptSeedWithWalletSignature,
  encryptSeedWithWalletSignature,
  encryptLocalStore,
  isWalletSignatureVaultRecord,
  walletSignatureVaultMetadataMatches,
  stableJsonStringify,
  walletSignatureVaultId,
  walletSignatureVaultAuthToken,
  type EncryptedLocalStore,
  type VaultRecord,
  type WalletSignatureVaultRecord,
  type WalletSignatureVaultContext,
} from "./domain/walletLocalCrypto";
import {
  RuntimeHttpStatusError,
  fetchJson,
  fetchWithTimeout,
  postJson,
  starknetRpc,
} from "./domain/runtimeHttp";
import { setPrivacyFundingStage } from "./domain/privacyFundingStage";
import { notifyPrivateSettlementReports } from "./domain/privateSettlementReportEvents";
import {
  browserSafeServiceUrl,
  defaultServiceUrlForHost,
  localServiceUrl,
  normalizeUrl,
} from "./domain/serviceUrls";
export {
  defaultServiceUrlForHost,
} from "./domain/serviceUrls";
import {
  applyStrk20ExitClaimReceipt,
  applyStrk20ExitStagingReceipt,
  isRetryableStrk20ExitClaim,
  isSpendableLocalNote,
  isWithdrawableNoteLocked,
} from "./domain/strk20ExitState";
export { applyStrk20ExitClaimReceipt } from "./domain/strk20ExitState";
import { userFacingErrorMessage } from "./domain/userFacingErrors";
import {
  normalizeLocalOrder,
  type LocalOrder,
  type LocalOrderStatus,
} from "./domain/orderLifecycle";
import type { LiquidityBandAttribution } from "./domain/shieldedBalances";
import type {
  PrivateLiquidityPositionCloseRequest,
  PrivateLiquidityPositionOpenRequest,
  PrivateLiquidityPositionReconfigureRequest,
} from "@zylith/sdk";
import {
  submitPrivacyBridgeDeposit,
  submitPrivacyOpenNoteWithdrawal,
  type SubmitPrivacyBridgeDepositResult,
} from "./integrations/starknetPrivacyFunding";
import {
  deserializeStarknetPrivacyRegistry,
  serializeStarknetPrivacyRegistry,
  type SerializedStarknetPrivacyRegistry,
} from "./integrations/starknetPrivacyRegistry";
import type { PrivateRegistry } from "@starkware-libs/starknet-privacy-sdk";
import { hash as starknetHash } from "starknet";

type Side = "Buy" | "Sell";
type OrderMode =
  | "Limit"
  | "Liquidity Position"
  | "TWAP"
  | "VWAP"
  | "Repeat"
  | "Resting";
const DIRECT_ORDER_MODES = new Set<OrderMode>(["Limit"]);
const STRATEGY_ORDER_MODES = new Set<OrderMode>([
  "TWAP",
  "VWAP",
  "Repeat",
]);
const MAX_ORDER_FUNDING_INPUTS = 4;
const DEFAULT_STARKNET_PRIVACY_MIN_PROVING_DELAY_BLOCKS = 10;
const WALLET_SIGNATURE_REQUEST_TIMEOUT_MS = 90_000;
const STARKNET_WALLET_INVOKE_TIMEOUT_MS = 3 * 60_000;
const STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS = 10_000;
const DEPLOYMENT_MANIFEST_REQUEST_TIMEOUT_MS = 10_000;
const REQUIRED_COORDINATOR_FETCH_TIMEOUT_MS = 20_000;
const WALLET_VAULT_REQUEST_TIMEOUT_MS = 10_000;
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

export type PrivateLiquidityPositionLifecycleAuthorizationRequest = {
  position_id: string;
  prior_position_commitment?: string;
  output_position_commitment?: string;
  epoch: string;
  base_amount: string;
  quote_amount: string;
};

export type PrivateLiquidityPositionLifecycleAuthorization = {
  signature_r: string;
  signature_s: string;
};

export type PrivateLiquidityPositionOpenResult = {
  lifecycle_id: string;
  position_commitment: string;
  transition_commitment: string;
  funding_note_commitments: string[];
  batch_id: string;
  epoch_id: number;
  submission_ambiguous?: boolean;
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
  batchWindowMs?: number;
  childAmount?: string;
  maxChildren?: number;
  durationBatches?: number;
  randomizedSlicing?: boolean;
  randomizedSlicingBps?: number;
  priceBaseScale?: string;
  offlineDelegation?: boolean;
  relayMode?: "SelfRelay" | "ZylithRelay";
};

export type WalletRuntime = {
  hasVault: (starknetAddress?: string | null) => boolean;
  vaultAuthMode: (starknetAddress?: string | null) => "none" | "wallet-signature";
  isReady: () => boolean;
  createWalletWithWalletSignature: (starknetAddress: string) => Promise<boolean>;
  unlockWithWalletSignature: (starknetAddress: string) => Promise<boolean>;
  syncRecoveryArtifacts: () => Promise<boolean>;
  getPublicConfig: () => WalletPublicConfig | null;
  lock: () => void;
  getBalances: () => WalletBalance[];
  getPendingDeposits: () => PendingDeposit[];
  getWithdrawableNotes: () => WithdrawableNote[];
  getPrivateStrategies: () => PrivateStrategySummary[];
  strk20WithdrawalAvailable: () => boolean;
  noteConsolidationAvailable: () => boolean;
  loadLocalOrders: () => Promise<LocalOrder[]>;
  saveLocalOrders: (orders: LocalOrder[]) => Promise<void>;
  previewFundingNotes: (order: PrivateOrderDraft) => FundingPreview;
  consolidateNotes: (
    request: NoteConsolidationRequest
  ) => Promise<NoteConsolidationResult>;
  scanNotes: () => Promise<boolean>;
  refreshPrivateState: () => Promise<void>;
  refreshDepositState: () => Promise<boolean>;
  pruneUnsettledSettlementOutputs: () => Promise<boolean>;
  syncSettlementOutputs: () => Promise<boolean>;
  syncPrivateSettlementReports: (
    requests: PrivateSettlementReportRequest[]
  ) => Promise<PrivateSettlementReport[]>;
  submitDepositViaWallet: (
    asset: string,
    amount: string
  ) => Promise<{
    transaction_hash: string;
    note_commitment: string;
    note_commitments: string[];
  }>;
  submitPrivateOrder: (order: PrivateOrderDraft) => Promise<{
    order_id?: string;
    strategy_id?: string;
    order_commitment?: string;
    batch_id?: string;
    epoch_id?: number;
    cancellation_secret?: string;
    first_child_order_commitment?: string;
    first_child_batch_id?: string;
    first_child_epoch_id?: number;
    first_child_cancellation_secret?: string;
    expected_output_metadata_commitment?: string;
    funding_note_commitments?: string[];
    offline_package?: OfflineRenewalPackage;
    submission_ambiguous?: boolean;
    status?: string;
  }>;
  cancelPrivateOrder: (request: {
    batch_id: string;
    order_commitment: string;
    cancellation_secret: string;
  }) => Promise<{ cancelled_at_unix_ms: number }>;
  markPrivateStrategyRelayRegistered: (
    strategyId: string,
    relayStatus?: { access_token?: string }
  ) => Promise<boolean>;
  cancelPrivateStrategy: (strategyId: string) => Promise<{
    cancelled_at_unix_ms: number;
    parent_cancel_transaction_hash?: string;
  }>;
  discardPreparedPrivateStrategy: (strategyId: string) => Promise<boolean>;
  pausePrivateStrategy: (
    strategyId: string
  ) => Promise<{ paused_at_unix_ms: number }>;
  resumePrivateStrategy: (
    strategyId: string
  ) => Promise<{ resumed_at_unix_ms: number }>;
  refreshPrivateStrategyPackage: (
    strategyId: string
  ) => Promise<OfflineRenewalPackage>;
  verifyOfflineRenewalPackage: (
    renewalPackage: OfflineRenewalPackage
  ) => Promise<boolean>;
  recordOfflineRenewalRelayResults: (
    packageId: string,
    results: Array<{
      slot_id?: string;
      order_commitment?: string;
      batch_id?: string;
      epoch_id?: number;
      status?: string;
      accepted?: {
        order_commitment?: string;
        batch_id?: string;
        accepted_at_unix_ms?: number;
      };
    }>
  ) => Promise<boolean>;
  settlePrivateOrderLock: (
    orderCommitment: string,
    outcome: "released" | "spent",
    settlementFunding?: {
      asset?: string;
      amount?: string;
      batchId?: string;
      noteCommitments?: string[];
    }
  ) => Promise<boolean>;
  createOfflineRenewalPackage: (
    order: PrivateOrderDraft
  ) => Promise<OfflineRenewalPackage>;
  openPrivateLiquidityPosition: (
    request: PrivateLiquidityPositionOpenRequest,
    batch?: BatchSummary
  ) => Promise<PrivateLiquidityPositionOpenResult>;
  reconfigurePrivateLiquidityPosition: (
    request: PrivateLiquidityPositionReconfigureRequest,
    batch?: BatchSummary
  ) => Promise<PrivateLiquidityPositionLifecycleResult>;
  closePrivateLiquidityPosition: (
    request: PrivateLiquidityPositionCloseRequest,
    batch?: BatchSummary
  ) => Promise<PrivateLiquidityPositionLifecycleResult>;
  getPrivateLiquidityPositions: () => LocalLiquidityPositionRecord[];
  authorizePrivateLiquidityPositionOpen: (
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest
  ) => PrivateLiquidityPositionLifecycleAuthorization;
  authorizePrivateLiquidityPositionReconfigure: (
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest
  ) => PrivateLiquidityPositionLifecycleAuthorization;
  authorizePrivateLiquidityPositionClose: (
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest
  ) => PrivateLiquidityPositionLifecycleAuthorization;
  getOfflineRenewalPackages: () => OfflineRenewalPackage[];
  submitStrk20Withdrawal: (
    request: unknown
  ) => Promise<{ transaction_hash: string }>;
};

type WalletWasmModule = {
  default?: () => Promise<void>;
  zylith_wallet_generate_seed_hex: () => string;
  zylith_wallet_derive_public_config: (seedHex: string) => string;
  zylith_wallet_build_deposit_submission_plan: (inputJson: string) => string;
  zylith_wallet_build_private_order_submission: (inputJson: string) => string;
  zylith_wallet_build_private_liquidity_position_open: (
    inputJson: string
  ) => string;
  zylith_wallet_prepare_private_liquidity_position_reconfigure: (
    inputJson: string
  ) => string;
  zylith_wallet_build_private_liquidity_position_reconfigure: (
    inputJson: string
  ) => string;
  zylith_wallet_prepare_private_liquidity_position_close: (
    inputJson: string
  ) => string;
  zylith_wallet_build_private_liquidity_position_close: (
    inputJson: string
  ) => string;
  zylith_wallet_authorize_liquidity_position_open: (inputJson: string) => string;
  zylith_wallet_authorize_liquidity_position_reconfigure: (
    inputJson: string
  ) => string;
  zylith_wallet_authorize_liquidity_position_close: (inputJson: string) => string;
  zylith_wallet_build_strategy_parent: (inputJson: string) => string;
  zylith_wallet_build_renewal_parent_cancel_submission_plan: (
    inputJson: string
  ) => string;
  zylith_wallet_sign_renewal_relay_package_authorization: (
    inputJson: string
  ) => string;
  zylith_wallet_verify_renewal_relay_package: (packageJson: string) => string;
  zylith_wallet_build_note_consolidation_draft: (inputJson: string) => string;
  zylith_wallet_sign_note_consolidation_witness: (inputJson: string) => string;
  zylith_wallet_scan_output_bundle: (
    seedHex: string,
    bundleJson: string
  ) => string;
  zylith_wallet_scan_output_bundle_with_root: (
    seedHex: string,
    bundleJson: string,
    expectedOutputNoteRoot: string
  ) => string;
  zylith_wallet_output_recovery_key_tags: (
    seedHex: string,
    batchId: string,
    maxOutputCount: number
  ) => string;
  zylith_wallet_output_recovery_key_tags_range: (
    seedHex: string,
    batchId: string,
    startOutputIndex: number,
    outputCount: number
  ) => string;
  zylith_wallet_decrypt_output_recovery_record: (
    seedHex: string,
    batchId: string,
    outputIndex: number,
    recordJson: string,
    expectedOutputNoteRoot: string
  ) => string;
  zylith_wallet_decrypt_liquidity_attribution_artifact: (
    seedHex: string,
    artifactJson: string
  ) => string;
  zylith_wallet_recovery_auth_tag: (seedHex: string) => string;
  zylith_wallet_create_recovery_snapshot: (inputJson: string) => string;
  zylith_wallet_decrypt_recovery_artifact: (
    seedHex: string,
    artifactJson: string
  ) => string;
  zylith_wallet_build_settlement_output_withdrawal_submission_plan: (
    inputJson: string
  ) => string;
  zylith_wallet_sign_settlement_output_withdrawal_witness: (
    inputJson: string
  ) => string;
  zylith_wallet_sign_strk20_exit_claim: (inputJson: string) => string;
};

type WalletPublicConfig = {
  account_id: string;
  spend_authority: string;
  note_recognition_public_key: string;
  withdraw_authority: string;
};

export type LocalNoteRecord = {
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
  liquidity_provider_attribution?: LiquidityBandAttribution;
  locked_by_order?: string;
  pending_deposit_tx?: string;
  deposit_confirmed?: boolean;
  funding_commitment?: string;
  deposit_root?: string;
  encrypted_note_activation?: string;
  deposit_failed?: boolean;
  deposit_failure_reason?: string;
  deposit_request_id?: string;
  deposit_requested_at_unix_ms?: number;
  spent?: boolean;
  pending_withdrawal_tx?: string;
  pending_strk20_open_note_tx?: string;
  strk20_exit_commitment?: string;
  strk20_open_note_id?: string;
  withdrawal_requested_at_unix_ms?: number;
  pending_consolidation?: PendingConsolidationRecord;
};

export type TransactionReceiptStatus = {
  failed: boolean;
  notFound: boolean;
  confirmed?: boolean;
  reason?: string;
};

export type PendingConsolidationRecord = {
  consolidation_id: string;
  transaction_hash?: string;
  output_note_root: string;
  source_note_commitments: string[];
  outputs: Array<{
    note_commitment: string;
    note: LocalNoteRecord["note"];
    output_note: unknown;
    output_proof: unknown;
  }>;
  submitted_at_unix_ms: number;
};

export function applyPendingConsolidationRoot(
  records: LocalNoteRecord[],
  pending: PendingConsolidationRecord,
  chainOutputRoot: string | null | undefined,
  deploymentScope: string
): {
  records: LocalNoteRecord[];
  outputRecords: LocalNoteRecord[];
  changed: boolean;
} {
  if (
    !chainOutputRoot ||
    normalizeFeltForComparison(chainOutputRoot) !==
      normalizeFeltForComparison(pending.output_note_root)
  ) {
    return { records, outputRecords: [], changed: false };
  }
  const sourceSet = new Set(
    pending.source_note_commitments.map(normalizeFeltForComparison)
  );
  let changed = false;
  const nextRecords = records.map((record) => {
    if (
      record.pending_consolidation?.consolidation_id !==
        pending.consolidation_id &&
      !sourceSet.has(normalizeFeltForComparison(record.note_commitment))
    ) {
      return record;
    }
    changed = true;
    return {
      ...record,
      locked_by_order: undefined,
      pending_consolidation: undefined,
      spent: true,
    };
  });
  const outputRecords = pending.outputs.map((output) => ({
    note_commitment: normalizeNoteCommitment(output.note_commitment),
    deployment_scope: deploymentScope,
    batch_id: pending.consolidation_id,
    source: "settlement_output" as const,
    note: output.note,
    output_note: output.output_note,
    output_proof: output.output_proof,
  }));
  return {
    records: nextRecords,
    outputRecords,
    changed: changed || outputRecords.length > 0,
  };
}

type WithdrawableNote = {
  note_commitment: string;
  batch_id?: string;
  source: "deposit" | "settlement_output";
  asset: string;
  amount: string;
  locked: boolean;
  spent: boolean;
  pending_withdrawal_tx?: string;
  pending_strk20_open_note_tx?: string;
  strk20_exit_commitment?: string;
  strk20_open_note_id?: string;
  metadata_commitment: string;
  liquidity_provider_attribution?: LiquidityBandAttribution;
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

type RenewalCancelWitnessResponse = {
  cancel_marker: string;
  prior_renewal_entries: string[];
  renewal_cancel_sparse_witness: {
    key_low: string;
    key_high: string;
    merkle_path: string[];
    merkle_directions: string[];
  };
};

type PrivateStrategySummary = {
  id: string;
  parent_order_commitment?: string;
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
    parent_cancel_authority?: string;
    relay_authorization?: OfflineRenewalPackage["relay_authorization"];
    access_token?: string;
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

type PublishedBatchArtifactList = {
  batches: Array<{
    batch_id: string;
    pair_id: string;
    batch_epoch: number;
    output_note_root: string;
    published_at_unix_ms?: number;
    settled_at_unix_ms?: number | null;
  }>;
  complete_through_epoch?: number | null;
};

type ProofJobStatus = {
  batch_id: string;
  state?: string;
  failure?: string | null;
};

type PrivateSettlementReportRequest = {
  batch_id: string;
  orders?: Array<{
    order_commitment: string;
    cancellation_secret: string;
  }>;
  liquidity_position_transition_commitments?: string[];
  liquidity_provider_public_keys?: string[];
};

type PrivateSettlementReportOrderAuth = {
  order_commitment: string;
  order_report_auth_tag: string;
};

type PrivateOrderExecutionReport = {
  batch_id: string;
  pair_id: string;
  order_commitment: string;
  order_report_auth_tag?: string | null;
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
  matched_order_count_bucket?: string;
  output_recovery_records: Array<{
    output_index: number;
    recovery: unknown;
  }>;
  order_execution_reports: PrivateOrderExecutionReport[];
  liquidity_position_lifecycle_reports?: PrivateLiquidityPositionLifecycleReport[];
  liquidity_provider_attribution_artifacts?: unknown[];
};

type LiquidityAttributionPlaintext = {
  version: number;
  batch_id: string;
  pair_id: string;
  epoch_id: number;
  liquidity_provider_public_key: string;
  curve_commitment: string;
  output_note_commitment: string;
  attribution: LiquidityBandAttribution;
};

type PrivateLiquidityPositionLifecycleReport = {
  transition_commitment: string;
  kind: "Open" | "Update" | "Close" | "Reconfigure";
  consumed_position_commitment?: string | { 0?: string } | null;
  output_position_commitment?: string | { 0?: string } | null;
};

type OutputRecoveryKeyTagList = {
  key_tags: string[];
};

async function taggedSha256Hex(tag: string, data: string): Promise<string> {
  const payload = new TextEncoder().encode(`${tag}${data}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function orderCancellationAuthTag(
  cancellationSecret: string
): Promise<string> {
  return taggedSha256Hex("zylith/order-cancel-tag", cancellationSecret);
}

async function orderExecutionReportAuthTag(
  batchId: string,
  orderCommitment: string,
  cancellationSecret: string
): Promise<string | null> {
  const normalizedCommitment = normalizeFeltForComparison(orderCommitment);
  const trimmedSecret = cancellationSecret.trim();
  if (!batchId.trim() || !normalizedCommitment || !trimmedSecret) return null;
  const cancellationAuthTag = await orderCancellationAuthTag(trimmedSecret);
  return taggedSha256Hex(
    "zylith/order-report-auth-tag",
    `${batchId.trim()}:${normalizedCommitment}:${cancellationAuthTag.toLowerCase()}`
  );
}

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
  liquidity_attribution_batch_ids: string[];
  artifact_epoch_cursor: number;
};

type IngressResponse = {
  coordinator_submission: unknown;
  receipt: unknown;
};

type CoordinatorAccepted = {
  order_commitment: string;
  batch_id: string;
};

type PrivateLiquidityPositionOpenBuild = {
  lifecycle_id: string;
  position?: ProtocolPrivateLiquidityPosition;
  position_commitment: string;
  transition_commitment: string;
  funding_note_commitments: string[];
  ingress_request: unknown;
};

type PrivateLiquidityPositionLifecycleBuild = {
  lifecycle_id: string;
  position_id: string;
  prior_position_commitment: string;
  output_position?: ProtocolPrivateLiquidityPosition;
  output_position_commitment?: string;
  transition_commitment: string;
  output_notes?: unknown[];
  ingress_request: unknown;
};

type ProtocolPrivateLiquidityPosition = Record<string, unknown> & {
  position_id?: string;
  pair_id?: string;
  base_asset_id?: string;
  quote_asset_id?: string;
};

type LocalLiquidityPositionStatus =
  | "pending_open"
  | "active"
  | "pending_reconfigure"
  | "pending_close"
  | "closed";

type LocalLiquidityPositionRecord = {
  id: string;
  position: ProtocolPrivateLiquidityPosition;
  position_commitment: string;
  pair_id: string;
  status: LocalLiquidityPositionStatus;
  deployment_scope?: string;
  last_lifecycle_id?: string;
  last_transition_commitment?: string;
  last_batch_id?: string;
  last_epoch_id?: number;
  opened_at_unix_ms?: number;
  updated_at_unix_ms?: number;
  fill_attributions?: LiquidityAttributionPlaintext[];
};

type PrivateLiquidityPositionLifecycleResult = {
  lifecycle_id: string;
  position_id: string;
  prior_position_commitment: string;
  output_position_commitment?: string;
  transition_commitment: string;
  output_notes?: unknown[];
  batch_id: string;
  epoch_id: number;
  submission_ambiguous?: boolean;
};

type LiquidityPositionInsertionWitnessResponse = {
  prior_liquidity_position_root: string;
  new_liquidity_position_root: string;
  active_position_count: number;
  state_update: unknown;
};

type LiquidityPositionStateResponse = {
  prior_liquidity_position_root: string;
  position: ProtocolPrivateLiquidityPosition;
  position_commitment: string;
  active_position_count: number;
};

type LiquidityPositionLifecycleAccepted = {
  lifecycle_id: string;
  transition_commitment: string;
  batch_id: string;
  accepted_at_unix_ms: number;
};

type StarknetCallPayload = {
  contract_address: string;
  entrypoint: string;
  calldata: string[];
};

type Strk20WithdrawalRequest = {
  chain_id?: string;
  shielded_asset_adapter_address?: string;
  auction_verifier_address?: string;
  note_commitment?: string;
  batch_id?: string;
  output_note?: unknown;
  output_proof?: unknown;
};

type DeploymentConfig = {
  network?: string;
  chain_id?: string;
  rpc_url?: string;
  proof?: {
    native_tx_prover_url?: string;
    note_consolidation_statement_program_address?: string;
    withdrawal_statement_program_address?: string;
  };
  contracts?: {
    auction_verifier?: string;
    shielded_asset_adapter?: string;
  };
  token_addresses?: Record<string, string>;
  funding?: {
    primary?: "starknet_privacy" | string;
    assets?: Record<
      string,
      {
        token_address?: string;
        rail_token_address?: string;
      }
    >;
    starknet_privacy?: {
      privacy_pool?: string;
      bridge_adapter?: string;
      discovery_url?: string;
      proving_url?: string;
      paymaster_address?: string;
      paymaster_url?: string;
      proof_signer_class_hash?: string;
      sdk_package?: string;
      sdk_version?: string;
      min_proving_delay_blocks?: number;
      ingress_key_registry_fingerprint?: string;
    };
  };
  product?: {
    pairs?: Record<
      string,
      {
        pair_id: string;
        enabled?: boolean;
      }
    >;
    assets?: Record<
      string,
      {
        token_address?: string;
      }
    >;
  };
};

const CHAIN_ID_ALIASES: Record<string, string> = {
  SN_SEPOLIA: "0x534e5f5345504f4c4941",
  SN_MAIN: "0x534e5f4d41494e",
};

type StarknetWalletCall = {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
};

type WalletRequestInvokeCall = {
  contract_address: string;
  entry_point: string;
  calldata: string[];
};

type StarknetInjectedProvider = {
  id?: string;
  name?: string;
  chainId?: string;
  getChainId?: () => Promise<string> | string;
  enable?: (options?: unknown) => Promise<unknown>;
  request?: (request: {
    type?: string;
    method?: string;
    params?: unknown;
  }) => Promise<unknown>;
  account?: {
    address?: string;
    getChainId?: () => Promise<string>;
    execute?: (calls: StarknetWalletCall[]) => Promise<unknown>;
    signMessage?: (typedData: unknown) => Promise<unknown>;
  };
  selectedAddress?: string;
  isConnected?: boolean;
};

declare global {
  interface Window {
    starknet?: StarknetInjectedProvider;
    starknet_ready?: StarknetInjectedProvider;
    starknet_xverse?: StarknetInjectedProvider;
    xverse?: StarknetInjectedProvider;
  }
}

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
  liquidity_positions?: LocalLiquidityPositionRecord[];
  orders?: LocalOrder[];
  created_at_unix_ms: number;
};

type WalletSignatureVaultBundle = {
  wallet_auth_id: string;
  vault: VaultRecord;
  updated_at_unix_ms?: number;
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
  relay_status?: string;
  relay_detail?: string;
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
  parent_cancel_authority: string;
  parent_cancel_marker: string;
  relay_authorization?: {
    signer_public_key: string;
    signature_r: string;
    signature_s: string;
  };
  access_token?: string;
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
  funding_note_commitments?: string[];
  ingress_request: unknown;
};

type PrivateStrategyRecord = {
  version: 1;
  deployment_scope?: string;
  id: string;
  mode: Exclude<OrderMode, "Limit" | "Liquidity Position">;
  pair: string;
  side: Side;
  total_amount: string;
  child_amount: string;
  remaining_amount: string;
  limit_price: string;
  price_base_scale?: string;
  min_fill: string;
  fill_or_kill: boolean;
  batch_window_ms?: number;
  max_children: number;
  next_child_index: number;
  start_epoch: number;
  end_epoch: number;
  randomized_slicing: boolean;
  slice_jitter_bps: number;
  renewal_window_children?: number;
  parent: StrategyParentMaterial;
  submitted_children: StrategyChildRecord[];
  offline_package?: OfflineRenewalPackage;
  status:
    | "active"
    | "delegated"
    | "pending_relay"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";
  parent_cancel_marker?: string;
  parent_cancel_transaction_hash?: string;
  parent_cancelled_at_unix_ms?: number;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
  last_error?: string;
};

const coordinatorUrl = normalizeUrl(
  browserSafeServiceUrl(
    normalizeUrl(import.meta.env.VITE_ZYLITH_COORDINATOR_URL) ||
      localServiceUrl(3000, "coordinator"),
    "coordinator"
  )
);
const proverUrl = normalizeUrl(
  browserSafeServiceUrl(
    normalizeUrl(import.meta.env.VITE_ZYLITH_PRIVATE_INGRESS_URL) ||
      localServiceUrl(3200, "prover"),
    "prover"
  )
);
const indexerUrl = normalizeUrl(
  browserSafeServiceUrl(
    normalizeUrl(import.meta.env.VITE_ZYLITH_INDEXER_URL) ||
      localServiceUrl(3300, "indexer"),
    "indexer"
  )
);
const walletWasmModuleUrl = "/wallet/zylith_wallet_wasm.js";
const ingressKeyPin = normalizeText(
  import.meta.env.VITE_ZYLITH_INGRESS_KEY_REGISTRY_PIN
);
const scanEpochLookback = positiveInteger(
  import.meta.env.VITE_ZYLITH_WALLET_SCAN_EPOCH_LOOKBACK,
  128
);
const scanEpochBackfillStep = positiveInteger(
  import.meta.env.VITE_ZYLITH_WALLET_SCAN_EPOCH_BACKFILL_STEP,
  Math.max(scanEpochLookback, 512)
);
const VAULT_KEY = "zylith.wallet.vault.v4";
const NOTES_PREFIX = "zylith.wallet.notes.v1:";
const STRATEGIES_PREFIX = "zylith.wallet.strategies.v1:";
const LIQUIDITY_POSITIONS_PREFIX = "zylith.wallet.liquidity-positions.v1:";
const ORDERS_PREFIX = "zylith.wallet.orders.v1:";
const SCAN_STATE_PREFIX = "zylith.wallet.scan-state.v1:";
const STARKNET_PRIVACY_REGISTRY_PREFIX =
  "zylith.wallet.starknet-privacy-registry.v1:";
const STRATEGY_WORKER_INTERVAL_MS = 12_000;
const DEPOSIT_CONFIRMATION_WORKER_INTERVAL_MS = 5_000;
const LATEST_EPOCH_CACHE_TTL_MS = 15_000;
const PRIVATE_REPORT_OUTPUT_TAG_COUNT = boundedInteger(
  import.meta.env.VITE_ZYLITH_PRIVATE_REPORT_OUTPUT_TAG_COUNT,
  4_096,
  256,
  8_192
);
const PRIVATE_REPORT_OUTPUT_TAG_PAGE_SIZE = 1_024;
const MAX_STRATEGY_CHILDREN = boundedInteger(
  import.meta.env.VITE_ZYLITH_MAX_STRATEGY_CHILDREN,
  86_400,
  1,
  100_000
);
const PENDING_DEPOSIT_FAILURE_GRACE_MS = 10 * 60 * 1000;
const CONFIRMED_DEPOSIT_REGISTRATION_GRACE_MS = 10 * 60 * 1000;
const DEPOSIT_CONFIRMATION_STALE_MS = 2 * 60 * 1000;
const STRK20_WITHDRAWAL_PREPARE_TIMEOUT_MS = 2 * 60 * 1000;
const STRK20_WITHDRAWAL_SUBMIT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_LIQUIDITY_POSITION_BATCH_WINDOW_MS = 20_000;
const RECOVERY_SNAPSHOT_MIN_INTERVAL_MS = 60_000;
const PENDING_LIQUIDITY_POSITION_OPEN_RELEASE_GRACE_MS = 30 * 60_000;

export async function installConfiguredZylithWalletRuntime() {
  if (typeof window === "undefined" || !walletWasmModuleUrl) return;
  try {
    if (
      !walletWasmModuleUrlAllowed(
        walletWasmModuleUrl,
        window.location.href
      )
    ) {
      throw new Error(
        "Wallet runtime module must be served from the current origin."
      );
    }
    const resolvedModuleUrl = new URL(
      walletWasmModuleUrl,
      window.location.href
    ).href;
    const mod = (await import(
      /* @vite-ignore */ resolvedModuleUrl
    )) as WalletWasmModule;
    if (typeof mod.default === "function") await mod.default();
    setWalletRuntime(createZylithWalletRuntime(mod));
  } catch (error) {
    const loadError = userFacingErrorMessage(
      error,
      "Failed to load private trading runtime."
    );
    setWalletRuntime(null, loadError);
  }
}

export function walletWasmModuleUrlAllowed(
  moduleUrl: string,
  pageUrl: string
): boolean {
  const trimmedModuleUrl = moduleUrl.trim();
  if (!trimmedModuleUrl) return false;
  try {
    const baseUrl = pageUrl.trim() || "http://localhost/";
    const page = new URL(baseUrl);
    const resolved = new URL(trimmedModuleUrl, page);
    return resolved.origin === page.origin;
  } catch {
    return false;
  }
}

export function createZylithWalletRuntime(
  core: WalletWasmModule
): WalletRuntime {
  let seedHex: string | null = null;
  let publicConfig: WalletPublicConfig | null = null;
  let notes: LocalNoteRecord[] = [];
  let strategies: PrivateStrategyRecord[] = [];
  let liquidityPositions: LocalLiquidityPositionRecord[] = [];
  let deploymentScope = "unbound";
  let strategyTimer: number | null = null;
  let depositConfirmationTimer: number | null = null;
  let strategyWorkerInFlight = false;
  let depositConfirmationWorkerInFlight = false;
  let depositSubmissionInFlightRequestId: string | null = null;
  let recoverySyncInFlight = false;
  let postUnlockSyncInFlight = false;
  let walletSignatureVaultOperation:
    | { key: string; promise: Promise<boolean> }
    | null = null;
  let walletSessionGeneration = 0;
  let lastRecoverySnapshotAtUnixMs = 0;
  let deploymentConfigCache: DeploymentConfig | null = null;
  let scanState: WalletScanState = {
    version: 1,
    scanned_artifact_ids: [],
    private_report_batch_ids: [],
    liquidity_attribution_batch_ids: [],
    artifact_epoch_cursor: 0,
  };
  let latestEpochCache: { value: number | null; expiresAt: number } | null =
    null;
  let coordinatorBatchWindowCache: { value: number | null; expiresAt: number } | null =
    null;
  let ingressRegistryCache: unknown | null = null;

  function requireUnlocked() {
    if (!seedHex || !publicConfig) {
      throw new Error("Wallet session is locked");
    }
    return { seedHex, publicConfig };
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
      notes = (
        await decryptLocalStore<LocalNoteRecord[]>(
          stored,
          seedHex,
          publicConfig.account_id,
          "notes"
        )
      )
        .filter((record) => record.deployment_scope === deploymentScope)
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
      notes.map((note) => ({ ...note, deployment_scope: deploymentScope })),
      seedHex,
      publicConfig.account_id,
      "notes"
    );
    localStorage.setItem(
      `${NOTES_PREFIX}${localStateScope()}`,
      JSON.stringify(encrypted)
    );
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
      strategies = (
        await decryptLocalStore<PrivateStrategyRecord[]>(
          stored,
          unlocked.seedHex,
          unlocked.publicConfig.account_id,
          "strategies"
        )
      ).filter((strategy) => strategy.deployment_scope === deploymentScope);
    } catch {
      quarantineLocalStore(key);
      strategies = [];
    }
  }

  async function saveStrategies() {
    if (!seedHex || !publicConfig) return;
    const encrypted = await encryptLocalStore(
      strategies.map((strategy) =>
        compactStrategyForLocalStore({
          ...strategy,
          deployment_scope: deploymentScope,
        })
      ),
      seedHex,
      publicConfig.account_id,
      "strategies"
    );
    localStorage.setItem(
      `${STRATEGIES_PREFIX}${localStateScope()}`,
      JSON.stringify(encrypted)
    );
  }

  async function loadLiquidityPositions() {
    const unlocked = requireUnlocked();
    const key = `${LIQUIDITY_POSITIONS_PREFIX}${localStateScope()}`;
    const stored = readJson<EncryptedLocalStore>(key);
    if (!stored) {
      liquidityPositions = [];
      return;
    }
    try {
      const decoded = await decryptLocalStore<unknown>(
        stored,
        unlocked.seedHex,
        unlocked.publicConfig.account_id,
        "liquidity-positions"
      );
      liquidityPositions = Array.isArray(decoded)
        ? decoded
            .map(normalizeLocalLiquidityPositionRecord)
            .filter(
              (position) => position.deployment_scope === deploymentScope
            )
        : [];
    } catch {
      quarantineLocalStore(key);
      liquidityPositions = [];
    }
  }

  async function saveLiquidityPositions() {
    if (!seedHex || !publicConfig) return;
    const encrypted = await encryptLocalStore(
      liquidityPositions.map((position) =>
        normalizeLocalLiquidityPositionRecord({
          ...position,
          deployment_scope: deploymentScope,
        })
      ),
      seedHex,
      publicConfig.account_id,
      "liquidity-positions"
    );
    localStorage.setItem(
      `${LIQUIDITY_POSITIONS_PREFIX}${localStateScope()}`,
      JSON.stringify(encrypted)
    );
  }

  async function loadLocalOrders(): Promise<LocalOrder[]> {
    const unlocked = requireUnlocked();
    const key = `${ORDERS_PREFIX}${localStateScope()}`;
    const stored = readJson<EncryptedLocalStore>(key);
    if (!stored) return [];
    try {
      const decoded = await decryptLocalStore<unknown>(
        stored,
        unlocked.seedHex,
        unlocked.publicConfig.account_id,
        "orders"
      );
      return Array.isArray(decoded)
        ? (decoded as LocalOrder[])
            .map(normalizeLocalOrder)
            .filter((order) => order.deployment_scope === deploymentScope)
        : [];
    } catch {
      quarantineLocalStore(key);
      return [];
    }
  }

  async function saveLocalOrders(orders: LocalOrder[]) {
    if (!seedHex || !publicConfig) return;
    const encrypted = await encryptLocalStore(
      orders
        .map((order) =>
          normalizeLocalOrder({ ...order, deployment_scope: deploymentScope })
        )
        .filter((order) => order.deployment_scope === deploymentScope),
      seedHex,
      publicConfig.account_id,
      "orders"
    );
    localStorage.setItem(
      `${ORDERS_PREFIX}${localStateScope()}`,
      JSON.stringify(encrypted)
    );
  }

  function compactStrategyForLocalStore(
    strategy: PrivateStrategyRecord
  ): PrivateStrategyRecord {
    if (
      !strategy.offline_package ||
      !["pending_relay", "delegated"].includes(strategy.status)
    )
      return strategy;
    if (
      strategy.status !== "delegated" ||
      strategy.offline_package.relay_mode !== "ZylithRelay"
    ) {
      return strategy;
    }
    return {
      ...strategy,
      offline_package: {
        ...strategy.offline_package,
        slots: strategy.offline_package.slots.map((slot) => ({
          ...slot,
          ingress_request: undefined,
        })),
      },
    };
  }

  async function loadScanState() {
    if (!seedHex || !publicConfig) {
      scanState = {
        version: 1,
        scanned_artifact_ids: [],
        private_report_batch_ids: [],
        liquidity_attribution_batch_ids: [],
        artifact_epoch_cursor: 0,
      };
      return;
    }
    const key = `${SCAN_STATE_PREFIX}${localStateScope()}`;
    const stored = readJson<EncryptedLocalStore>(key);
    if (!stored) {
      scanState = {
        version: 1,
        scanned_artifact_ids: [],
        private_report_batch_ids: [],
        liquidity_attribution_batch_ids: [],
        artifact_epoch_cursor: 0,
      };
      return;
    }
    try {
      const decoded = await decryptLocalStore<Partial<WalletScanState>>(
        stored,
        seedHex,
        publicConfig.account_id,
        "scan-state"
      );
      scanState = {
        version: 1,
        scanned_artifact_ids: uniqueStrings(decoded.scanned_artifact_ids),
        private_report_batch_ids: uniqueStrings(
          decoded.private_report_batch_ids
        ),
        liquidity_attribution_batch_ids: uniqueStrings(
          decoded.liquidity_attribution_batch_ids
        ),
        artifact_epoch_cursor: nonNegativeInteger(
          decoded.artifact_epoch_cursor,
          0
        ),
      };
    } catch {
      quarantineLocalStore(key);
      scanState = {
        version: 1,
        scanned_artifact_ids: [],
        private_report_batch_ids: [],
        liquidity_attribution_batch_ids: [],
        artifact_epoch_cursor: 0,
      };
    }
  }

  async function saveScanState() {
    if (!seedHex || !publicConfig) return;
    const encrypted = await encryptLocalStore(
      scanState,
      seedHex,
      publicConfig.account_id,
      "scan-state"
    );
    localStorage.setItem(
      `${SCAN_STATE_PREFIX}${localStateScope()}`,
      JSON.stringify(encrypted)
    );
  }

  async function loadStarknetPrivacySdkRegistry(): Promise<
    PrivateRegistry | undefined
  > {
    const unlocked = requireUnlocked();
    const key = `${STARKNET_PRIVACY_REGISTRY_PREFIX}${localStateScope()}`;
    const stored = readJson<EncryptedLocalStore>(key);
    if (!stored) return undefined;
    try {
      const serialized =
        await decryptLocalStore<SerializedStarknetPrivacyRegistry>(
          stored,
          unlocked.seedHex,
          unlocked.publicConfig.account_id,
          "starknet-privacy-registry"
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
      "starknet-privacy-registry"
    );
    localStorage.setItem(
      `${STARKNET_PRIVACY_REGISTRY_PREFIX}${localStateScope()}`,
      JSON.stringify(encrypted)
    );
  }

  async function hydrateFromSeed(
    nextSeedHex: string,
    generation = walletSessionGeneration
  ) {
    ensureWalletSignatureOperationCurrent(generation);
    seedHex = normalizeRecoverySeed(nextSeedHex);
    publicConfig = JSON.parse(
      core.zylith_wallet_derive_public_config(seedHex)
    ) as WalletPublicConfig;
    deploymentScope = await resolveDeploymentScope();
    ensureWalletSignatureOperationCurrent(generation);
    await loadNotes();
    ensureWalletSignatureOperationCurrent(generation);
    await loadStrategies();
    ensureWalletSignatureOperationCurrent(generation);
    await loadLiquidityPositions();
    ensureWalletSignatureOperationCurrent(generation);
    await loadScanState();
    ensureWalletSignatureOperationCurrent(generation);
    void runPostUnlockSync();
    startDepositConfirmationWorker();
    startStrategyWorker();
    notifyWalletRuntimeChanged();
    return true;
  }

  async function runPostUnlockSync() {
    if (postUnlockSyncInFlight || !seedHex || !publicConfig) return;
    postUnlockSyncInFlight = true;
    try {
      await refreshDepositConfirmations().catch(() => false);
      await syncRecoveryArtifacts({ pushSnapshot: false }).catch(() => false);
      await pruneUnsettledSettlementOutputs().catch(() => false);
      await syncLiquidityPositionLifecycleState().catch(() => false);
      await releaseStalePendingLiquidityPositionOpens().catch(() => false);
      await scanNotes().catch(() => undefined);
      await pushRecoverySnapshot(false).catch(() => undefined);
    } finally {
      postUnlockSyncInFlight = false;
    }
  }

  function walletVaultStorageKey(starknetAddress?: string | null) {
    const normalized = starknetAddress
      ? normalizeFeltForComparison(starknetAddress)
      : "";
    return normalized ? `${VAULT_KEY}:${normalized}` : VAULT_KEY;
  }

  function readWalletSignatureVault(starknetAddress?: string | null) {
    return readJson<VaultRecord>(walletVaultStorageKey(starknetAddress));
  }

  function writeWalletSignatureVault(vault: WalletSignatureVaultRecord) {
    localStorage.setItem(
      walletVaultStorageKey(vault.wallet_address),
      JSON.stringify(vault)
    );
  }

  function removeWalletSignatureVault(starknetAddress?: string | null) {
    localStorage.removeItem(walletVaultStorageKey(starknetAddress));
  }

  function hasVault(starknetAddress?: string | null) {
    return isWalletSignatureVaultRecord(readWalletSignatureVault(starknetAddress));
  }

  function vaultAuthMode(starknetAddress?: string | null): "none" | "wallet-signature" {
    const vault = readWalletSignatureVault(starknetAddress);
    if (isWalletSignatureVaultRecord(vault)) return "wallet-signature";
    return "none";
  }

  async function createWalletWithWalletSignature(starknetAddress: string) {
    return runWalletSignatureVaultOperation(
      `create:${normalizeFeltForComparison(starknetAddress)}`,
      async () => {
        const generation = walletSessionGeneration;
        const context = await requestWalletSignatureVaultContext(starknetAddress);
        ensureWalletSignatureOperationCurrent(generation);
        if (hasVault(context.walletAddress)) {
          throw new Error("Wallet session already exists");
        }
        if (await restoreWalletSignatureVaultFromRemote(context, generation))
          return true;
        return writeNewWalletSignatureVault(starknetAddress, context, generation);
      }
    );
  }

  async function writeNewWalletSignatureVault(
    starknetAddress: string,
    context?: WalletSignatureVaultContext,
    generation = walletSessionGeneration
  ) {
    const nextSeedHex = normalizeRecoverySeed(core.zylith_wallet_generate_seed_hex());
    return writeWalletSignatureSeedVault(
      nextSeedHex,
      starknetAddress,
      context,
      generation
    );
  }

  async function writeWalletSignatureSeedVault(
    nextSeedHex: string,
    starknetAddress: string,
    context?: WalletSignatureVaultContext,
    generation = walletSessionGeneration
  ) {
    const vaultContext =
      context ?? (await requestWalletSignatureVaultContext(starknetAddress));
    const nextVault = await encryptSeedWithWalletSignature(
      nextSeedHex,
      vaultContext
    );
    ensureWalletSignatureOperationCurrent(generation);
    writeWalletSignatureVault(nextVault);
    await pushWalletSignatureVaultBundle(vaultContext, nextVault).catch(
      () => undefined
    );
    ensureWalletSignatureOperationCurrent(generation);
    return hydrateFromSeed(nextSeedHex, generation);
  }

  async function unlockWithWalletSignature(starknetAddress: string) {
    return runWalletSignatureVaultOperation(
      `unlock:${normalizeFeltForComparison(starknetAddress)}`,
      async () => {
        const generation = walletSessionGeneration;
        if (seedHex && publicConfig) return true;
        const context = await requestWalletSignatureVaultContext(starknetAddress);
        ensureWalletSignatureOperationCurrent(generation);
        let vault = readWalletSignatureVault(context.walletAddress);
        if (!vault) {
          const remote = await pullWalletSignatureVaultBundle(context);
          if (remote?.vault && isWalletSignatureVaultRecord(remote.vault)) {
            if (walletSignatureVaultMetadataMatches(remote.vault, context)) {
              vault = remote.vault;
              writeWalletSignatureVault(remote.vault);
            } else {
              removeWalletSignatureVault(context.walletAddress);
            }
          }
        }
        if (!isWalletSignatureVaultRecord(vault)) return false;
        if (!walletSignatureVaultMetadataMatches(vault, context)) {
          removeWalletSignatureVault(context.walletAddress);
          return false;
        }
        let nextSeedHex: string;
        try {
          nextSeedHex = await decryptSeedWithWalletSignature(vault, context);
        } catch {
          return false;
        }
        ensureWalletSignatureOperationCurrent(generation);
        return hydrateFromSeed(nextSeedHex, generation);
      }
    );
  }

  function ensureWalletSignatureOperationCurrent(generation: number) {
    if (generation !== walletSessionGeneration) {
      throw new Error("Wallet session changed. Retry.");
    }
  }

  function runWalletSignatureVaultOperation(
    key: string,
    operation: () => Promise<boolean>
  ): Promise<boolean> {
    if (walletSignatureVaultOperation?.key === key) {
      return walletSignatureVaultOperation.promise;
    }
    const promise = operation().finally(() => {
      if (walletSignatureVaultOperation?.promise === promise) {
        walletSignatureVaultOperation = null;
      }
    });
    walletSignatureVaultOperation = { key, promise };
    return promise;
  }

  async function requestWalletSignatureVaultContext(
    starknetAddress: string
  ): Promise<WalletSignatureVaultContext> {
    const provider = selectedStarknetProvider();
    if (!provider) {
      throw new Error("Connect a Starknet wallet first");
    }
    const connected = connectedProviderAddress(provider);
    const expectedAddress = normalizeFeltForComparison(starknetAddress);
    if (connected && normalizeFeltForComparison(connected) !== expectedAddress) {
      throw new Error("Connected Starknet wallet changed during private trading authorization");
    }
    const deployment = await loadDeploymentConfig();
    await ensureWalletChain(provider, deployment);
    const chainId = requiredNonZeroFelt(deployment.chain_id, "chain_id");
    const deploymentId = await zylithWalletAuthDeploymentId(deployment, chainId);
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "zylith://local";
    const typedData = await buildZylithWalletAuthTypedData({
      walletAddress: expectedAddress,
      chainId,
      deploymentId,
      origin,
    });
    const signature = await requestStarknetWalletTypedSignature(
      provider,
      typedData
    );
    return {
      signature,
      walletAddress: expectedAddress,
      chainId,
      deploymentId,
      origin,
      messageVersion: 2,
    };
  }

  async function restoreWalletSignatureVaultFromRemote(
    context: WalletSignatureVaultContext,
    generation = walletSessionGeneration
  ) {
    const remote = await pullWalletSignatureVaultBundle(context);
    if (!remote?.vault || !isWalletSignatureVaultRecord(remote.vault)) {
      return false;
    }
    let nextSeedHex: string;
    try {
      nextSeedHex = await decryptSeedWithWalletSignature(remote.vault, context);
    } catch {
      return false;
    }
    ensureWalletSignatureOperationCurrent(generation);
    writeWalletSignatureVault(remote.vault);
    return hydrateFromSeed(nextSeedHex, generation);
  }

  async function pullWalletSignatureVaultBundle(
    context: WalletSignatureVaultContext
  ): Promise<WalletSignatureVaultBundle | null> {
    if (!coordinatorUrl) return null;
    const [walletAuthId, walletAuthToken] = await Promise.all([
      walletSignatureVaultId(context),
      walletSignatureVaultAuthToken(context),
    ]);
    const path = `/api/wallet-vaults/${encodeURIComponent(walletAuthId)}`;
    const bundle = await fetchWalletSignatureVaultBundle(
      coordinatorUrl,
      path,
      walletAuthToken
    );
    if (bundle?.wallet_auth_id !== walletAuthId) return null;
    return bundle;
  }

  async function fetchWalletSignatureVaultBundle(
    baseUrl: string,
    path: string,
    walletAuthToken: string
  ): Promise<WalletSignatureVaultBundle | null> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${baseUrl.replace(/\/+$/, "")}${path}`,
        {
          headers: {
            accept: "application/json",
            "x-zylith-wallet-vault-auth": walletAuthToken,
          },
        },
        WALLET_VAULT_REQUEST_TIMEOUT_MS
      );
    } catch {
      throw new Error("Private trading state is unavailable. Retry later.");
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new RuntimeHttpStatusError(path, response.status, "");
    }
    return (await response.json()) as WalletSignatureVaultBundle;
  }

  async function pushWalletSignatureVaultBundle(
    context: WalletSignatureVaultContext,
    vault: VaultRecord
  ) {
    if (!coordinatorUrl) return;
    const [walletAuthId, walletAuthToken] = await Promise.all([
      walletSignatureVaultId(context),
      walletSignatureVaultAuthToken(context),
    ]);
    await postJson<WalletSignatureVaultBundle>(
      coordinatorUrl,
      `/api/wallet-vaults/${encodeURIComponent(walletAuthId)}`,
      {
        wallet_auth_id: walletAuthId,
        vault,
        updated_at_unix_ms: Date.now(),
      },
      { "x-zylith-wallet-vault-auth": walletAuthToken }
    );
  }

  function lock() {
    walletSessionGeneration += 1;
    walletSignatureVaultOperation = null;
    if (strategyTimer !== null) {
      window.clearInterval(strategyTimer);
      strategyTimer = null;
    }
    if (depositConfirmationTimer !== null) {
      window.clearInterval(depositConfirmationTimer);
      depositConfirmationTimer = null;
    }
    strategyWorkerInFlight = false;
    depositConfirmationWorkerInFlight = false;
    depositSubmissionInFlightRequestId = null;
    recoverySyncInFlight = false;
    postUnlockSyncInFlight = false;
    seedHex = null;
    publicConfig = null;
    deploymentScope = "unbound";
    notes = [];
    strategies = [];
    liquidityPositions = [];
    scanState = {
      version: 1,
      scanned_artifact_ids: [],
      private_report_batch_ids: [],
      liquidity_attribution_batch_ids: [],
      artifact_epoch_cursor: 0,
    };
    latestEpochCache = null;
    coordinatorBatchWindowCache = null;
    notifyWalletRuntimeChanged();
  }

  async function scanNotes() {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (!indexerUrl) return false;
    const {
      batches: artifacts,
      stable_cursor: stableCursor,
      cursor_artifact_ids: cursorArtifactIds,
    } = await fetchVisibleArtifacts();
    let notesChanged = false;
    let scanStateChanged = false;
    const scannedArtifactIds = new Set(scanState.scanned_artifact_ids);
    const knownNoteCommitments = new Set(
      notes.map((record) => normalizeFeltForComparison(record.note_commitment))
    );
    const pendingArtifacts = artifacts.filter(
      (artifact) =>
        artifact.settled_at_unix_ms &&
        !scannedArtifactIds.has(artifact.batch_id)
    );
    const fetchedBundles = await mapWithConcurrency(
      pendingArtifacts,
      4,
      async (artifact) => {
        const rootVerified = await verifyArtifactOutputRoot(artifact).catch(
          () => false
        );
        return {
          artifact,
          bundle: rootVerified
            ? await fetchOutputBundle(artifact.batch_id).catch(() => null)
            : null,
        };
      }
    );
    for (const { artifact, bundle } of fetchedBundles) {
      if (!bundle) continue;
      const scanned = JSON.parse(
        artifact.output_note_root
          ? core.zylith_wallet_scan_output_bundle_with_root(
              unlockedSeed,
              JSON.stringify(bundle),
              artifact.output_note_root
            )
          : core.zylith_wallet_scan_output_bundle(
              unlockedSeed,
              JSON.stringify(bundle)
            )
      ) as {
        notes: Array<{
          batch_id: string;
          note_commitment: string;
          note: LocalNoteRecord["note"];
          output_note?: unknown;
          output_proof?: unknown;
        }>;
      };
      for (const scannedNote of scanned.notes) {
        const normalizedCommitment = normalizeFeltForComparison(
          scannedNote.note_commitment
        );
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
        });
        knownNoteCommitments.add(normalizedCommitment);
        notesChanged = true;
      }
      scannedArtifactIds.add(artifact.batch_id);
      scanStateChanged = true;
    }
    if (scanStateChanged) {
      scanState.scanned_artifact_ids = [...scannedArtifactIds].slice(-512);
    }
    const cursorRangeFullyScanned = cursorArtifactIds.every((batchId) =>
      scannedArtifactIds.has(batchId)
    );
    if (
      stableCursor > scanState.artifact_epoch_cursor &&
      cursorRangeFullyScanned
    ) {
      scanState.artifact_epoch_cursor = stableCursor;
      scanStateChanged = true;
    }
    if (scanStateChanged) await saveScanState();
    if (notesChanged) {
      await saveNotes();
      scheduleRecoverySnapshot(false);
    }
    return notesChanged;
  }

  async function refreshPrivateState() {
    await refreshDepositState();
    await syncWithdrawalState();
    await finalizePendingConsolidations();
    await syncSettlementOutputs();
    await syncLiquidityProviderAttributionReports();
    await syncActiveLiquidityPositionStates();
    await syncLiquidityPositionLifecycleState();
    await releaseStalePendingLiquidityPositionOpens();
  }

  async function refreshDepositState() {
    return refreshDepositConfirmations().catch(() => false);
  }

  async function syncWithdrawalState() {
    const pending = notes.filter(
      (record) => record.pending_withdrawal_tx && !record.spent
    );
    if (pending.length === 0) return false;
    const deployment = await loadDeploymentConfig();
    let changed = false;
    await Promise.all(
      pending.map(async (record) => {
        if (record.strk20_exit_commitment) {
          if (!record.pending_strk20_open_note_tx) {
            const stagedTx = record.pending_withdrawal_tx;
            if (!stagedTx) return;
            const status = await fetchTransactionReceiptStatus(
              stagedTx,
              deployment
            ).catch(() => null);
            if (applyStrk20ExitStagingReceipt(record, status)) {
              changed = true;
            }
            return;
          }
          const status = await fetchTransactionReceiptStatus(
            record.pending_strk20_open_note_tx,
            deployment
          ).catch(() => null);
          if (applyStrk20ExitClaimReceipt(record, status)) {
            changed = true;
          }
          return;
        }
      })
    );
    if (!changed) return false;
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    return true;
  }

  async function finalizePendingConsolidations() {
    const pendingById = new Map<string, PendingConsolidationRecord>();
    for (const record of notes) {
      const pending = record.pending_consolidation;
      if (pending?.consolidation_id) {
        pendingById.set(pending.consolidation_id, pending);
      }
    }
    if (pendingById.size === 0) return false;
    let changed = false;
    for (const pending of pendingById.values()) {
      const chainOutputRoot = await fetchOnchainOutputNoteRoot(
        pending.consolidation_id
      ).catch(() => null);
      if (
        !chainOutputRoot ||
        chainOutputRoot !== normalizeFeltForComparison(pending.output_note_root)
      ) {
        continue;
      }
      const finalized = applyPendingConsolidationRoot(
        notes,
        pending,
        chainOutputRoot,
        deploymentScope
      );
      if (!finalized.changed) continue;
      notes = finalized.records;
      changed = true;
      for (const output of finalized.outputRecords) {
        changed =
          mergeRecoveredNote(output) || changed;
      }
    }
    if (!changed) return false;
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    return true;
  }

  async function syncSettlementOutputs() {
    const pruned = await pruneUnsettledSettlementOutputs().catch(() => false);
    const scanned = await scanNotes().catch(() => false);
    return pruned || scanned;
  }

  async function syncLiquidityPositionLifecycleState() {
    if (!coordinatorUrl) return false;
    const requestsByBatch = new Map<string, PrivateSettlementReportRequest>();
    for (const position of liquidityPositions) {
      if (!isPendingLiquidityPositionStatus(position.status)) continue;
      const batchId = normalizeText(position.last_batch_id);
      const transitionCommitment = normalizeFeltForComparison(
        position.last_transition_commitment
      );
      if (!batchId || !transitionCommitment) continue;
      const request =
        requestsByBatch.get(batchId) ??
        ({
          batch_id: batchId,
          orders: [],
          liquidity_position_transition_commitments: [],
        } satisfies PrivateSettlementReportRequest);
      request.liquidity_position_transition_commitments?.push(
        transitionCommitment
      );
      requestsByBatch.set(batchId, request);
    }
    if (requestsByBatch.size === 0) return false;
    const before = JSON.stringify(liquidityPositions);
    await syncPrivateSettlementReports([...requestsByBatch.values()]);
    return before !== JSON.stringify(liquidityPositions);
  }

  async function syncLiquidityProviderAttributionReports() {
    const { publicConfig: unlockedConfig } = requireUnlocked();
    if (!coordinatorUrl || !indexerUrl) return false;
    const ownerPublicKey = normalizeText(
      unlockedConfig.note_recognition_public_key
    );
    if (!ownerPublicKey) return false;
    if (!liquidityPositions.some((position) => position.status !== "closed")) {
      return false;
    }
    const { batches } = await fetchVisibleArtifacts();
    const syncedBatchIds = new Set(scanState.liquidity_attribution_batch_ids);
    const requests = batches
      .filter(
        (batch) => batch.settled_at_unix_ms && !syncedBatchIds.has(batch.batch_id)
      )
      .map((batch) => ({
        batch_id: batch.batch_id,
        liquidity_provider_public_keys: [ownerPublicKey],
      }));
    if (requests.length === 0) return false;
    const before = JSON.stringify(liquidityPositions);
    await syncPrivateSettlementReports(requests);
    for (const request of requests) {
      syncedBatchIds.add(request.batch_id);
    }
    scanState.liquidity_attribution_batch_ids = [...syncedBatchIds].slice(-512);
    await saveScanState();
    return before !== JSON.stringify(liquidityPositions);
  }

  async function syncActiveLiquidityPositionStates() {
    if (!proverUrl) return false;
    const active = liquidityPositions.filter(
      (position) => position.status === "active"
    );
    if (active.length === 0) return false;
    const before = JSON.stringify(liquidityPositions);
    for (const position of active) {
      await refreshLocalLiquidityPositionState(position).catch(() => position);
    }
    return before !== JSON.stringify(liquidityPositions);
  }

  async function releaseStalePendingLiquidityPositionOpens() {
    if (!coordinatorUrl) return false;
    const now = Date.now();
    let notesChanged = false;
    let positionsChanged = false;
    for (let index = 0; index < liquidityPositions.length; index += 1) {
      const position = liquidityPositions[index];
      if (position.status !== "pending_open") continue;
      const batchId = normalizeText(position.last_batch_id);
      const lifecycleId = normalizeText(position.last_lifecycle_id);
      if (!batchId || !lifecycleId) continue;
      const batch = await fetchBatchById(batchId).catch(() => null);
      if (!shouldReleasePendingLiquidityPositionOpen(batch, now)) continue;
      const outputRoot = await fetchOnchainOutputNoteRoot(batchId).catch(
        () => null
      );
      if (outputRoot && outputRoot !== "0x0") continue;
      const lockRef = liquidityPositionLifecycleLockRef(lifecycleId);
      notes = notes.map((note) => {
        if (
          normalizeFeltForComparison(note.locked_by_order) !==
          normalizeFeltForComparison(lockRef)
        ) {
          return note;
        }
        notesChanged = true;
        return { ...note, locked_by_order: undefined };
      });
      liquidityPositions[index] = {
        ...position,
        status: "closed",
        updated_at_unix_ms: now,
      };
      positionsChanged = true;
    }
    if (notesChanged) await saveNotes();
    if (positionsChanged) await saveLiquidityPositions();
    if (notesChanged || positionsChanged) {
      await pushRecoverySnapshot(true).catch(() => false);
      notifyWalletRuntimeChanged();
    }
    return notesChanged || positionsChanged;
  }

  async function syncPrivateSettlementReports(
    requests: PrivateSettlementReportRequest[]
  ) {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (!coordinatorUrl || requests.length === 0) return [];
    const reports: PrivateSettlementReport[] = [];
    let notesChanged = false;
    let ordersChanged = false;
    let liquidityPositionsChanged = false;
    let localOrders: LocalOrder[] | null = null;
    let scanStateChanged = false;
    const syncedBatchIds = new Set(scanState.private_report_batch_ids);
    async function mutableLocalOrders() {
      if (!localOrders) {
        localOrders = await loadLocalOrders().catch(() => [] as LocalOrder[]);
      }
      return localOrders;
    }
    function outputRecoveryKeyTags(batchId: string) {
      const tags: string[] = [];
      for (
        let start = 0;
        start < PRIVATE_REPORT_OUTPUT_TAG_COUNT;
        start += PRIVATE_REPORT_OUTPUT_TAG_PAGE_SIZE
      ) {
        const count = Math.min(
          PRIVATE_REPORT_OUTPUT_TAG_PAGE_SIZE,
          PRIVATE_REPORT_OUTPUT_TAG_COUNT - start
        );
        const page = JSON.parse(
          core.zylith_wallet_output_recovery_key_tags_range(
            unlockedSeed,
            batchId,
            start,
            count
          )
        ) as OutputRecoveryKeyTagList;
        tags.push(...page.key_tags);
      }
      return uniqueStrings(tags);
    }
    for (const request of requests) {
      const batchId = request.batch_id?.trim();
      if (!batchId) continue;
      const orderReportAuths: PrivateSettlementReportOrderAuth[] = [];
      for (const order of request.orders ?? []) {
        const orderCommitment = normalizeFeltForComparison(
          order.order_commitment
        );
        if (!orderCommitment) continue;
        const authTag = await orderExecutionReportAuthTag(
          batchId,
          orderCommitment,
          order.cancellation_secret
        );
        if (!authTag) continue;
        orderReportAuths.push({
          order_commitment: orderCommitment,
          order_report_auth_tag: authTag,
        });
      }
      const keyTags = outputRecoveryKeyTags(batchId);
      const liquidityPositionTransitionCommitments = uniqueStrings(
        request.liquidity_position_transition_commitments
          ?.map(normalizeFeltForComparison)
          .filter((commitment): commitment is string => Boolean(commitment)) ??
          []
      );
      const liquidityProviderPublicKeys = uniqueStrings(
        request.liquidity_provider_public_keys
          ?.map(normalizeText)
          .filter((publicKey): publicKey is string => Boolean(publicKey)) ??
          []
      );
      if (
        orderReportAuths.length === 0 &&
        keyTags.length === 0 &&
        liquidityPositionTransitionCommitments.length === 0 &&
        liquidityProviderPublicKeys.length === 0
      ) {
        continue;
      }
      const report = await postJson<PrivateSettlementReport>(
        coordinatorUrl,
        `/api/settlement-reports/${encodeURIComponent(batchId)}`,
        {
          output_recovery_key_tags: keyTags,
          order_report_auths: orderReportAuths,
          liquidity_position_transition_commitments:
            liquidityPositionTransitionCommitments,
          liquidity_provider_public_keys: liquidityProviderPublicKeys,
        }
      ).catch(() => null);
      if (!report) continue;
      if (report.batch_id !== batchId) continue;
      const chainRoot = await fetchOnchainOutputNoteRoot(batchId).catch(
        () => null
      );
      if (
        !chainRoot ||
        chainRoot !== normalizeFeltForComparison(report.output_note_root)
      ) {
        continue;
      }
      reports.push(report);
      for (const execution of report.order_execution_reports ?? []) {
        const orderCommitment = normalizeFeltForComparison(
          execution.order_commitment
        );
        const fundingCommitments = uniqueStrings([
          ...(execution.funding_note_commitments ?? []),
        ]);
        const normalizedFundingCommitments = new Set(
          fundingCommitments
            .map(normalizeFeltForComparison)
            .filter((commitment): commitment is string => Boolean(commitment))
        );
        let filledAmount = 0n;
        let unfilledAmount = 0n;
        try {
          filledAmount = BigInt(execution.filled_amount || "0");
          unfilledAmount = BigInt(execution.unfilled_amount || "0");
        } catch {
          continue;
        }
        if (orderCommitment) {
          const ordersForMutation = await mutableLocalOrders();
          const nextStatus: LocalOrderStatus =
            filledAmount <= 0n
              ? "no_fill"
              : unfilledAmount > 0n
              ? "partial"
              : "filled";
          const clearingPrice =
            execution.execution_price ?? report.clearing_price;
          for (let index = 0; index < ordersForMutation.length; index += 1) {
            const order = ordersForMutation[index];
            if (
              normalizeFeltForComparison(order.orderCommitment) !==
                orderCommitment ||
              order.batchId !== report.batch_id
            ) {
              continue;
            }
            const nextOrder: LocalOrder = {
              ...order,
              status: nextStatus,
              clearingPrice,
              filledAmount:
                filledAmount > 0n ? execution.filled_amount : order.filledAmount,
            };
            if (JSON.stringify(order) !== JSON.stringify(nextOrder)) {
              ordersForMutation[index] = nextOrder;
              ordersChanged = true;
            }
          }
        }
        if (!orderCommitment && normalizedFundingCommitments.size === 0) {
          continue;
        }
        let matchedFundingNote = false;
        const normalizedCommitments = new Set(
          fundingCommitments.map(normalizeFeltForComparison)
        );
        notes = notes.map((note) => {
          if (
            !(
              (orderCommitment &&
                normalizeFeltForComparison(note.locked_by_order) ===
                  orderCommitment) ||
              normalizedCommitments.has(
                normalizeFeltForComparison(note.note_commitment)
              )
            )
          )
            return note;
          matchedFundingNote = true;
          notesChanged = true;
          return {
            ...note,
            locked_by_order: undefined,
            spent: filledAmount > 0n ? true : note.spent,
          };
        });
        if (
          filledAmount > 0n &&
          !matchedFundingNote &&
          normalizedFundingCommitments.size > 0
        ) {
          notes = notes.map((note) => {
            if (
              !normalizedFundingCommitments.has(
                normalizeFeltForComparison(note.note_commitment)
              )
            ) {
              return note;
            }
            notesChanged = true;
            return { ...note, locked_by_order: undefined, spent: true };
          });
        }
      }
      for (const record of report.output_recovery_records ?? []) {
        try {
          const payload = JSON.parse(
            core.zylith_wallet_decrypt_output_recovery_record(
              unlockedSeed,
              report.batch_id,
              record.output_index,
              JSON.stringify(record.recovery),
              report.output_note_root
            )
          ) as OwnedOutputNotePayload;
          if (!payload.output_note?.note_commitment) continue;
          const noteCommitment = normalizeNoteCommitment(
            payload.output_note.note_commitment
          );
          if (
            notes.some(
              (note) =>
                normalizeFeltForComparison(note.note_commitment) ===
                normalizeFeltForComparison(noteCommitment)
            )
          ) {
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
      if (applyLiquidityProviderAttributionArtifacts(report, unlockedSeed)) {
        liquidityPositionsChanged = true;
      }
      if (applyLiquidityPositionLifecycleReports(report)) {
        liquidityPositionsChanged = true;
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
    if (ordersChanged && localOrders) {
      await saveLocalOrders(localOrders);
      scheduleRecoverySnapshot(false);
    }
    if (liquidityPositionsChanged) {
      await saveLiquidityPositions();
      scheduleRecoverySnapshot(false);
    }
    notifyPrivateSettlementReports(reports.length);
    return reports;
  }

  async function syncRecoveryArtifacts(
    options: { pushSnapshot?: boolean } = {}
  ) {
    requireUnlocked();
    if (!coordinatorUrl) return false;
    if (recoverySyncInFlight) return false;
    recoverySyncInFlight = true;
    try {
      const merged = await pullRecoverySnapshots().catch(() => false);
      if (merged) {
        await saveNotes();
        await saveStrategies();
      }
      if (options.pushSnapshot ?? true) {
        await pushRecoverySnapshot(true).catch(() => false);
      }
      return true;
    } finally {
      recoverySyncInFlight = false;
    }
  }

  async function consolidateNotes(
    request: NoteConsolidationRequest
  ): Promise<NoteConsolidationResult> {
    const deployment = await loadDeploymentConfig();
    if (!noteConsolidationEnabledForDeployment(deployment)) {
      throw new Error(
        "Note consolidation is not available in this deployment."
      );
    }
    const { seedHex: unlockedSeed } = requireUnlocked();
    const sourceCommitments = request.sourceNoteCommitments
      .map(normalizeFeltForComparison)
      .filter((commitment): commitment is string => Boolean(commitment));
    if (sourceCommitments.length < 1) {
      throw new Error("Select at least one note to convert or consolidate");
    }
    const sourceSet = new Set(sourceCommitments);
    const inputRecords = notes.filter(
      (record) =>
        sourceSet.has(normalizeFeltForComparison(record.note_commitment)) &&
        !record.spent &&
        !record.locked_by_order &&
        !(record.source === "deposit" && record.deposit_confirmed !== true) &&
        !record.pending_withdrawal_tx &&
        !record.pending_consolidation
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
    const consolidationId = `consolidation-${Date.now()}-${randomFeltHex().slice(
      2,
      14
    )}`;
    const draft = JSON.parse(
      core.zylith_wallet_build_note_consolidation_draft(
        JSON.stringify({
          seed_hex: unlockedSeed,
          consolidation_id: consolidationId,
          input_notes: inputRecords.map((record) => record.note),
          target_amounts: targetAmounts,
        })
      )
    ) as {
      consolidation_id: string;
      output_notes: unknown[];
      output_note_preimages: LocalNoteRecord["note"][];
      output_recovery_records: unknown[];
      output_recovery_dummy_commitments: string[];
      output_note_root: string;
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
        output_recovery_dummy_commitments:
          draft.output_recovery_dummy_commitments,
        output_ciphertext_bundle_ref: draft.output_ciphertext_bundle_ref,
      }
    );
    const signedWitness = JSON.parse(
      core.zylith_wallet_sign_note_consolidation_witness(
        JSON.stringify({
          seed_hex: unlockedSeed,
          expected_draft: draft,
          witness: prepared.witness,
        })
      )
    );
    const pending: PendingConsolidationRecord = {
      consolidation_id: consolidationId,
      output_note_root: draft.output_note_root,
      source_note_commitments: sourceCommitments,
      outputs: draft.outputs.map((output) => ({
        note_commitment: normalizeNoteCommitment(output.note_commitment),
        note: output.note,
        output_note: output.output_note,
        output_proof: output.output_proof,
      })),
      submitted_at_unix_ms: Date.now(),
    };
    notes = notes.map((record) => {
      if (!sourceSet.has(normalizeFeltForComparison(record.note_commitment)))
        return record;
      return {
        ...record,
        locked_by_order: `consolidation:${consolidationId}`,
        pending_consolidation: pending,
      };
    });
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    let submitted: NoteConsolidationResult;
    try {
      submitted = await postJson<NoteConsolidationResult>(
        proverUrl,
        "/api/private/note-consolidations/submit",
        { witness: signedWitness }
      );
    } catch (error) {
      if (isDefiniteNoteConsolidationSubmitRejection(error)) {
        notes = notes.map((record) => {
          if (!sourceSet.has(normalizeFeltForComparison(record.note_commitment)))
            return record;
          return {
            ...record,
            locked_by_order: undefined,
            pending_consolidation: undefined,
          };
        });
        await saveNotes();
        await pushRecoverySnapshot(true).catch(() => false);
      }
      throw error;
    }
    if (String(submitted.execution_status ?? "").toUpperCase() === "REVERTED") {
      notes = notes.map((record) => {
        if (!sourceSet.has(normalizeFeltForComparison(record.note_commitment)))
          return record;
        return {
          ...record,
          locked_by_order: undefined,
          pending_consolidation: undefined,
        };
      });
      await saveNotes();
      await pushRecoverySnapshot(true).catch(() => false);
      throw new Error("Note consolidation transaction reverted");
    }
    pending.transaction_hash = submitted.transaction_hash;
    notes = notes.map((record) =>
      sourceSet.has(normalizeFeltForComparison(record.note_commitment)) &&
      record.pending_consolidation?.consolidation_id === consolidationId
        ? { ...record, pending_consolidation: pending }
        : record
    );
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    await finalizePendingConsolidations().catch(() => false);
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
      rawAmount
    );
  }

  async function submitDepositViaStarknetPrivacySdk(
    fundingRail: StarknetPrivacyDepositFundingRail,
    deployment: DeploymentConfig,
    asset: string,
    rawAmount: bigint
  ): Promise<{
    transaction_hash: string;
    note_commitment: string;
    note_commitments: string[];
  }> {
    const { seedHex: unlockedSeed } = requireUnlocked();
    const privacyPoolAddress = requiredNonZeroFelt(
      fundingRail.privacyPool,
      "privacy_pool_address"
    );
    const bridgeAddress = requiredNonZeroFelt(
      fundingRail.bridgeAdapter,
      "privacy_deposit_bridge_address"
    );
    const shieldedAssetAdapterAddress = requiredNonZeroFelt(
      fundingRail.shieldedAssetAdapter,
      "shielded_asset_adapter_address"
    );
    const tokenAddress = fundingRailTokenAddress(deployment, asset);
    const chainId = requiredString(deployment.chain_id, "chain_id");
    const rpcUrl = requiredString(deployment.rpc_url, "rpc_url");
    const discoveryUrl = browserSafeServiceUrl(
      normalizeUrl(fundingRail.discoveryUrl),
      "/starknet-privacy-discovery"
    );
    const provingUrl = browserSafeServiceUrl(
      normalizeUrl(fundingRail.provingUrl),
      "/starknet-privacy-prover"
    );
    if (!discoveryUrl || !provingUrl) {
      throw new Error("Private deposit service URLs are required");
    }
    if (rawAmount <= 0n) {
      throw new Error("Deposit amount must be greater than zero");
    }
    setRuntimePrivacyFundingStage("Connecting Starknet wallet and checking network");
    const provider = await selectInjectedStarknetProvider();
    const depositRequestId = randomFeltHex();
    const depositChunks = splitDepositAmount(
      rawAmount,
      asset,
      assetDecimals(asset)
    );
    const plans = depositChunks.map(
      (depositChunk) =>
        JSON.parse(
          core.zylith_wallet_build_deposit_submission_plan(
            JSON.stringify({
              seed_hex: unlockedSeed,
              asset_id: asset,
              amount: depositChunk.toString(),
              deposit_nonce: randomU64(),
              deposit_authority_address: bridgeAddress,
              token_address: tokenAddress,
              shielded_asset_adapter_address: shieldedAssetAdapterAddress,
            })
          )
        ) as {
          note: LocalNoteRecord["note"];
          note_commitment: string | { value?: string };
          encoded_args: {
            funding_commitments: string[];
            deposit_roots: string[];
            encrypted_note_activations: string[];
            note_commitments: string[];
            asset_ids: string[];
            amounts: string[];
            withdraw_authorities: string[];
          };
        }
    );

    if (plans.length === 0) {
      throw new Error("Deposit split produced no notes");
    }
    if (
      plans.some(
        (plan) =>
          !plan.encoded_args.funding_commitments?.[0] ||
          !plan.encoded_args.deposit_roots?.[0] ||
          !plan.encoded_args.encrypted_note_activations?.[0] ||
          !plan.encoded_args.note_commitments?.[0] ||
          !plan.encoded_args.asset_ids?.[0] ||
          !plan.encoded_args.amounts?.[0] ||
          !plan.encoded_args.withdraw_authorities?.[0]
      )
    ) {
      throw new Error("Deposit plan is missing private funding activation fields");
    }
    const noteCommitments = plans.map((plan) =>
      normalizeNoteCommitment(plan.note_commitment)
    );
    const totalDepositAmount = plans.reduce(
      (sum, plan) => sum + BigInt(plan.note.amount),
      0n
    );
    if (totalDepositAmount !== rawAmount) {
      throw new Error("Deposit split total does not match requested amount");
    }
    if (
      plans.some(
        (plan) => plan.note.asset_id !== plans[0]?.note.asset_id
      )
    ) {
      throw new Error("Deposit split produced mixed assets");
    }
    const requestTime = Date.now();
    depositSubmissionInFlightRequestId = depositRequestId;
    let depositResult: SubmitPrivacyBridgeDepositResult;
    let externalDepositSubmissionStarted = false;
    try {
      for (const plan of plans) {
        const noteCommitment = normalizeNoteCommitment(plan.note_commitment);
        const existing = notes.find(
          (record) => record.note_commitment === noteCommitment
        );
        if (!existing) {
          notes.push({
            note_commitment: noteCommitment,
            deployment_scope: deploymentScope,
            source: "deposit",
            note: plan.note,
            deposit_confirmed: false,
            funding_commitment: plan.encoded_args.funding_commitments[0],
            deposit_root: plan.encoded_args.deposit_roots[0],
            encrypted_note_activation: plan.encoded_args.encrypted_note_activations[0],
            deposit_request_id: depositRequestId,
            deposit_requested_at_unix_ms: requestTime,
          });
        }
      }
      await saveNotes();
      await pushRecoverySnapshot(true).catch(() => false);
      const sdkRegistry = await loadStarknetPrivacySdkRegistry().catch(
        () => undefined
      );
      externalDepositSubmissionStarted = true;
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
        provingOhttpEnabled: fundingRail.provingOhttpEnabled,
        paymasterAddress: requiredNonZeroFelt(
          fundingRail.paymasterAddress,
          "privacy_paymaster_address"
        ),
        paymasterUrl: requiredString(
          fundingRail.paymasterUrl,
          "privacy_paymaster_url"
        ),
        privacyProofSignerClassHash: fundingRail.privacyProofSignerClassHash,
        minProvingDelayBlocks:
          fundingRail.minProvingDelayBlocks ??
          DEFAULT_STARKNET_PRIVACY_MIN_PROVING_DELAY_BLOCKS,
        sdkRegistry,
        plan: {
          amount: totalDepositAmount,
          encodedArgs: {
            funding_commitments: plans.map(
              (plan) => plan.encoded_args.funding_commitments[0]
            ),
            deposit_roots: plans.map((plan) => plan.encoded_args.deposit_roots[0]),
            encrypted_note_activations: plans.map(
              (plan) => plan.encoded_args.encrypted_note_activations[0]
            ),
            note_commitments: plans.map((plan) => plan.encoded_args.note_commitments[0]),
            asset_ids: plans.map((plan) => plan.encoded_args.asset_ids[0]),
            amounts: plans.map((plan) => plan.encoded_args.amounts[0]),
            withdraw_authorities: plans.map(
              (plan) => plan.encoded_args.withdraw_authorities[0]
            ),
          },
        },
      });
    } catch (error) {
      depositSubmissionInFlightRequestId = null;
      const message = error instanceof Error ? error.message : String(error);
      const ambiguousSubmission =
        externalDepositSubmissionStarted &&
        /private deposit submission failed/i.test(message) &&
        /(network request failed|failed to fetch|service is unavailable|unreadable error|timed out)/i.test(
          message
        );
      if (!ambiguousSubmission) {
        const plannedCommitments = new Set(noteCommitments);
        notes = notes.filter(
          (record) =>
            !plannedCommitments.has(record.note_commitment) ||
            record.pending_deposit_tx ||
            record.deposit_confirmed === true
        );
        await saveNotes();
        await pushRecoverySnapshot(true).catch(() => false);
      }
      throw error;
    }
    await saveStarknetPrivacySdkRegistry(depositResult.sdkRegistry).catch(
      () => undefined
    );
    const transactionHash = depositResult.transactionHash;
    for (const noteCommitment of noteCommitments) {
      const record = notes.find(
        (entry) => entry.note_commitment === noteCommitment
      );
      if (!record) continue;
      record.pending_deposit_tx = transactionHash;
      record.deposit_failed = undefined;
      record.deposit_failure_reason = undefined;
    }
    depositSubmissionInFlightRequestId = null;
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    startDepositConfirmationWorker();
    try {
      await waitForStarknetTransaction(
        transactionHash,
        deployment,
        "Private deposit"
      );
      await refreshDepositConfirmations().catch(() => false);
    } catch (error) {
      if (isSubmittedTransactionFailure(error)) {
        const reason =
          submittedTransactionFailureReason(error) ??
          "Deposit transaction failed.";
        for (const noteCommitment of noteCommitments) {
          const record = notes.find(
            (entry) => entry.note_commitment === noteCommitment
          );
          if (!record) continue;
          markDepositRecordFailed(record, reason);
        }
        await saveNotes();
        await pushRecoverySnapshot(true).catch(() => false);
      }
      throw error;
    }
    return {
      transaction_hash: transactionHash,
      note_commitment: noteCommitments[0] ?? "",
      note_commitments: noteCommitments,
    };
  }

  async function waitForStarknetTransaction(
    transactionHash: string,
    deployment: DeploymentConfig,
    label: string
  ) {
    const deadline = Date.now() + 12 * 60_000;
    let lastStatus: {
      failed?: boolean;
      reason?: string;
      confirmed?: boolean;
    } | null = null;
    while (Date.now() < deadline) {
      lastStatus = await fetchTransactionReceiptStatus(
        transactionHash,
        deployment
      ).catch(() => null);
      if (lastStatus?.failed) {
        const reason = lastStatus.reason ?? "transaction reverted";
        const error = new Error(`${label} failed: ${reason}`);
        (
          error as Error & {
            transactionFailed?: boolean;
            transactionFailureReason?: string;
          }
        ).transactionFailed = true;
        (
          error as Error & {
            transactionFailed?: boolean;
            transactionFailureReason?: string;
          }
        ).transactionFailureReason = reason;
        throw error;
      }
      if (lastStatus?.confirmed) return;
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
    }
    throw new Error(
      `${label} was submitted but is not confirmed yet. Please retry later after the network confirms it.`
    );
  }

  function isSubmittedTransactionFailure(error: unknown) {
    return (
      Boolean(error) &&
      typeof error === "object" &&
      (error as { transactionFailed?: unknown }).transactionFailed === true
    );
  }

  function submittedTransactionFailureReason(error: unknown) {
    return error && typeof error === "object"
      ? (error as { transactionFailureReason?: string }).transactionFailureReason
      : undefined;
  }

  async function refreshDepositConfirmations() {
    const pending = pendingDepositRecords(notes);
    if (pending.length === 0) return false;
    const pendingFundingCommitments = pendingDepositFundingCommitments(pending);
    if (pendingFundingCommitments.length === 0) return false;
    const confirmationState = await fetchConfirmedDepositCommitments(
      pendingFundingCommitments
    );
    const confirmedFundingCommitments =
      confirmationState.confirmedFundingCommitments;
    let changed = false;
    for (const record of pending) {
      if (!depositRecordMatchesConfirmedFunding(record, confirmedFundingCommitments))
        continue;
      markDepositRecordConfirmed(record);
      changed = true;
    }
    const unconfirmed = pending.filter(
      (record) =>
        !record.deposit_failed &&
        !depositRecordMatchesConfirmedFunding(record, confirmedFundingCommitments)
    );
    if (unconfirmed.length > 0) {
      const deployment = await loadDeploymentConfig().catch(() => null);
      if (deployment) {
        const transactionConfirmed = await confirmDepositsFromSubmittedTransactions(
          unconfirmed,
          deployment
        );
        if (transactionConfirmed.size > 0) {
          for (const commitment of transactionConfirmed) {
            confirmedFundingCommitments.add(commitment);
          }
          for (const record of pending) {
            const fundingCommitment = normalizeOptionalFelt(record.funding_commitment);
            if (!fundingCommitment || !transactionConfirmed.has(fundingCommitment))
              continue;
            markDepositRecordConfirmed(record);
            changed = true;
          }
        }
      }
    }
    const stillUnconfirmed = pending.filter(
      (record) =>
        !record.deposit_failed &&
        !depositRecordMatchesConfirmedFunding(record, confirmedFundingCommitments)
    );
    if (
      !confirmationState.indexerStale &&
      (await markFailedPendingDeposits(stillUnconfirmed))
    ) {
      changed = true;
    }
    if (changed) {
      await saveNotes();
      scheduleRecoverySnapshot(false);
    }
    return changed;
  }

  async function fetchConfirmedDepositCommitments(fundingCommitments: string[]) {
    const confirmedFundingCommitments = new Set<string>();
    if (!indexerUrl) {
      return { confirmedFundingCommitments, indexerStale: true };
    }
    const confirmations = await postJson<{
      confirmed?: Array<{ funding_commitment?: string }>;
      last_successful_sync_unix_ms?: number;
      sync_lag_ms?: number;
    }>(indexerUrl, "/api/deposits/confirmations", {
      funding_commitments: fundingCommitments,
    }).catch((error) => {
      if (import.meta.env.DEV) {
        console.warn(
          "Deposit confirmation lookup failed",
          safeDebugErrorMessage(error)
        );
      }
      return null;
    });
    const indexerStale =
      !confirmations?.last_successful_sync_unix_ms ||
      (confirmations.sync_lag_ms ?? Number.MAX_SAFE_INTEGER) >
        DEPOSIT_CONFIRMATION_STALE_MS;
    for (const record of confirmations?.confirmed ?? []) {
      try {
        if (record.funding_commitment) {
          const fundingCommitment = normalizeOptionalFelt(record.funding_commitment);
          if (fundingCommitment) confirmedFundingCommitments.add(fundingCommitment);
        }
      } catch {
        // Ignore malformed indexer rows and keep the deposit pending until the receipt reconciliation handles it.
      }
    }
    return { confirmedFundingCommitments, indexerStale };
  }

  async function markFailedPendingDeposits(pending: LocalNoteRecord[]) {
    if (pending.length === 0) return false;
    const deployment = await loadDeploymentConfig();
    let changed = false;
    for (const record of pending) {
      const status = record.pending_deposit_tx
        ? await fetchTransactionReceiptStatus(
            record.pending_deposit_tx,
            deployment
          ).catch(() => null)
        : null;
      const failureReason = pendingDepositFailureReason({
        record,
        status,
        nowUnixMs: Date.now(),
        inFlightRequestId: depositSubmissionInFlightRequestId,
        failureGraceMs: PENDING_DEPOSIT_FAILURE_GRACE_MS,
        confirmedRegistrationGraceMs: CONFIRMED_DEPOSIT_REGISTRATION_GRACE_MS,
      });
      if (failureReason) {
        markDepositRecordFailed(record, failureReason);
        changed = true;
      }
    }
    return changed;
  }

  async function submitPrivateOrder(draft: PrivateOrderDraft) {
    requireUnlocked();
    const timedDraft = await withCoordinatorBatchWindow(draft);
    if (
      timedDraft.mode === "Liquidity Position" ||
      timedDraft.mode === "Resting"
    ) {
      throw new Error(
        "Private liquidity must be opened through the private liquidity position lifecycle"
      );
    }
    if (STRATEGY_ORDER_MODES.has(timedDraft.mode)) {
      if (timedDraft.offlineDelegation) {
        const offlinePackage = await createOfflineRenewalPackage(timedDraft);
        return {
          order_id: offlinePackage.package_id,
          offline_package: offlinePackage,
          status: `offline renewal package prepared with ${offlinePackage.slot_count} exact child slots`,
        };
      }
      return createPrivateStrategy(timedDraft);
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error(
        "Coordinator and private ingress URLs are required for private order submission"
      );
    }
    const registry = await fetchIngressRegistry();
    const submitted = await submitSinglePrivateOrderWithFreshBatch(
      timedDraft,
      registry
    );
    return {
      order_id: submitted.order_commitment,
      order_commitment: submitted.order_commitment,
      batch_id: submitted.batch_id,
      epoch_id: submitted.epoch_id,
      cancellation_secret: submitted.cancellation_secret,
      expected_output_metadata_commitment:
        submitted.expected_output_metadata_commitment,
      funding_note_commitments: submitted.funding_note_commitments,
      submission_ambiguous: submitted.submission_ambiguous,
      status: submitted.submission_ambiguous
        ? "private submission pending reconciliation"
        : "private ingress accepted",
    };
  }

  async function openPrivateLiquidityPosition(
    request: PrivateLiquidityPositionOpenRequest,
    candidateBatch?: BatchSummary
  ): Promise<PrivateLiquidityPositionOpenResult> {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (request.kind !== "OpenPrivateLiquidityPosition") {
      throw new Error("Unsupported liquidity position lifecycle request");
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error(
        "Coordinator and private ingress URLs are required for liquidity position opening"
      );
    }
    const batchWindowMs =
      (await fetchCoordinatorBatchWindowMs()) ??
      coordinatorBatchWindowCache?.value ??
      DEFAULT_LIQUIDITY_POSITION_BATCH_WINDOW_MS;
    const batch =
      candidateBatch ??
      (await resolveSubmittablePairBatch(request.pairId, batchWindowMs));
    if (!batch || batch.status !== "Open") {
      throw new Error("Liquidity position auction window is no longer open");
    }
    if (batch.pair_id !== request.pairId) {
      throw new Error(
        "Liquidity position batch does not match the requested pair"
      );
    }
    const submissionSafetyBufferMs = batchSubmissionSafetyBufferMs(batchWindowMs);
    if (
      batch.close_time_unix_ms - Date.now() <=
      submissionSafetyBufferMs
    ) {
      throw new Error(
        "Liquidity position auction window is inside the submission safety buffer"
      );
    }
    const priorLiquidityPositionRoot = await fetchOnchainLiquidityPositionRoot();

    const fundingNotes = selectLiquidityPositionFundingNotes(request);
    const durationBatches = liquidityPositionDurationBatches(
      request,
      batchWindowMs
    );
    const telemetryStart = performance.now();
    const positionNonce = randomU64();
    const buildOpenInput = (
      priorRoot: string,
      stateUpdate?: unknown
    ): Record<string, unknown> => {
      const input: Record<string, unknown> = {
          seed_hex: unlockedSeed,
          pair_id: request.pairId,
          batch_id: batch.batch_id,
          epoch_id: batch.epoch_id.toString(),
          funding_notes: fundingNotes.map((record) => record.note),
          base_asset_id: request.baseAssetId,
          quote_asset_id: request.quoteAssetId,
          base_reserve: request.baseReserveAtomic,
          quote_reserve: request.quoteReserveAtomic,
          price_lower_bound: request.priceLowerBoundAtomic,
          price_upper_bound: request.priceUpperBoundAtomic,
          max_fill_base_per_batch: request.maxFillBasePerBatchAtomic,
          curve_policy: {
            kind: request.curvePolicy.kind,
            band_count: request.curvePolicy.bandCount.toString(),
            spread_bps: request.curvePolicy.spreadBps.toString(),
            target_base_ratio_bps:
              request.curvePolicy.targetBaseRatioBps.toString(),
            inventory_skew_bps:
              request.curvePolicy.inventorySkewBps.toString(),
            max_price_deviation_bps:
              request.curvePolicy.maxPriceDeviationBps.toString(),
          },
          rotation_policy: {
            max_price_rotation_bps:
              request.rotationPolicy.maxPriceRotationBps.toString(),
            max_depth_rotation_bps:
              request.rotationPolicy.maxDepthRotationBps.toString(),
            skip_epoch_bps: request.rotationPolicy.skipEpochBps.toString(),
          },
          oracle_guard: request.oracleGuard
            ? {
                oracle_id: request.oracleGuard.oracleId,
                max_staleness_ms:
                  request.oracleGuard.maxStalenessMs.toString(),
                max_divergence_bps:
                  request.oracleGuard.maxDivergenceBps.toString(),
              }
            : undefined,
          expiry_epoch: (batch.epoch_id + durationBatches).toString(),
          position_nonce: positionNonce,
          prior_liquidity_position_root: priorRoot,
          padding: randomPadding(2048),
        };
      if (stateUpdate !== undefined) input.state_update = stateUpdate;
      return input;
    };
    const preview = JSON.parse(
      core.zylith_wallet_build_private_liquidity_position_open(
        JSON.stringify(buildOpenInput("0x0"))
      )
    ) as PrivateLiquidityPositionOpenBuild;
    let built = preview;
    if (priorLiquidityPositionRoot !== "0x0") {
      const positionId = normalizeText(preview.position?.position_id);
      if (!positionId) {
        throw new Error(
          "Liquidity position preview did not return a position id"
        );
      }
      const insertionWitness =
        await postJson<LiquidityPositionInsertionWitnessResponse>(
          proverUrl,
          "/api/private/liquidity-positions/insertion-witness",
          {
            position_id: positionId,
            output_commitment: preview.position_commitment,
            prior_liquidity_position_root: priorLiquidityPositionRoot,
            padding: randomPadding(2048),
          }
        );
      const witnessedPriorRoot = normalizeFeltForComparison(
        insertionWitness.prior_liquidity_position_root
      );
      if (witnessedPriorRoot !== priorLiquidityPositionRoot) {
        throw new Error(
          "Liquidity position insertion witness was built against a stale root"
        );
      }
      built = JSON.parse(
        core.zylith_wallet_build_private_liquidity_position_open(
          JSON.stringify(
            buildOpenInput(priorLiquidityPositionRoot, insertionWitness.state_update)
          )
        )
      ) as PrivateLiquidityPositionOpenBuild;
    }
    const buildCompletedAt = performance.now();
    const lockRef = liquidityPositionLifecycleLockRef(built.lifecycle_id);
    for (const fundingNote of fundingNotes) {
      fundingNote.locked_by_order = lockRef;
    }
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);

    let privateIngressStarted = false;
    let coordinatorSubmissionStarted = false;
    try {
      const submissionDelayMs = privateSubmissionDelayMs(
        batch.close_time_unix_ms,
        submissionSafetyBufferMs
      );
      await delay(submissionDelayMs);
      if (
        batch.close_time_unix_ms - Date.now() <=
        submissionSafetyBufferMs
      ) {
        throw new Error(
          "Liquidity position auction window entered the submission safety buffer before private ingress submission"
        );
      }
      const beforePrivateIngress = performance.now();
      const ingressTelemetry: OrderIngressTelemetry = {
        version: 1,
        client_build_ms: elapsedMs(telemetryStart, buildCompletedAt),
        private_submission_delay_ms: submissionDelayMs,
        client_elapsed_before_private_ingress_ms: elapsedMs(
          telemetryStart,
          beforePrivateIngress
        ),
        batch_time_remaining_before_private_ingress_ms:
          remainingBatchMs(batch.close_time_unix_ms),
        submission_safety_buffer_ms: submissionSafetyBufferMs,
      };
      privateIngressStarted = true;
      const ingress = await postJson<IngressResponse>(
        proverUrl,
        "/api/private/liquidity-positions/lifecycle",
        attachOrderIngressTelemetry(built.ingress_request, ingressTelemetry)
      );
      const afterPrivateIngress = performance.now();
      const coordinatorTelemetry: OrderIngressTelemetry = {
        ...ingressTelemetry,
        private_ingress_roundtrip_ms: elapsedMs(
          beforePrivateIngress,
          afterPrivateIngress
        ),
        client_elapsed_before_coordinator_ms: elapsedMs(
          telemetryStart,
          afterPrivateIngress
        ),
        batch_time_remaining_before_coordinator_ms:
          remainingBatchMs(batch.close_time_unix_ms),
      };
      coordinatorSubmissionStarted = true;
      const accepted = await postJson<LiquidityPositionLifecycleAccepted>(
        coordinatorUrl,
        "/api/liquidity-positions/lifecycle",
        attachOrderIngressTelemetry(
          ingress.coordinator_submission,
          coordinatorTelemetry
        )
      );
      storeLocalLiquidityPosition({
        position: built.position,
        positionCommitment: built.position_commitment,
        status: "pending_open",
        lifecycleId: accepted.lifecycle_id ?? built.lifecycle_id,
        transitionCommitment:
          accepted.transition_commitment ?? built.transition_commitment,
        batchId: accepted.batch_id ?? batch.batch_id,
        epochId: batch.epoch_id,
      });
      await saveLiquidityPositions();
      scheduleRecoverySnapshot(true);
      return {
        lifecycle_id: accepted.lifecycle_id ?? built.lifecycle_id,
        position_commitment: built.position_commitment,
        transition_commitment:
          accepted.transition_commitment ?? built.transition_commitment,
        funding_note_commitments: fundingNotes.map(
          (note) => note.note_commitment
        ),
        batch_id: accepted.batch_id ?? batch.batch_id,
        epoch_id: batch.epoch_id,
      };
    } catch (error) {
      if (
        isAmbiguousPrivateLiquidityPositionSubmissionError(
          error,
          coordinatorSubmissionStarted
            ? "coordinator_submission"
            : privateIngressStarted
              ? "private_ingress"
              : "pre_ingress"
        )
      ) {
        storeLocalLiquidityPosition({
          position: built.position,
          positionCommitment: built.position_commitment,
          status: "pending_open",
          lifecycleId: built.lifecycle_id,
          transitionCommitment: built.transition_commitment,
          batchId: batch.batch_id,
          epochId: batch.epoch_id,
        });
        await saveLiquidityPositions();
        await pushRecoverySnapshot(true).catch(() => false);
        return {
          lifecycle_id: built.lifecycle_id,
          position_commitment: built.position_commitment,
          transition_commitment: built.transition_commitment,
          funding_note_commitments: fundingNotes.map(
            (note) => note.note_commitment
          ),
          batch_id: batch.batch_id,
          epoch_id: batch.epoch_id,
          submission_ambiguous: true,
        };
      }
      for (const fundingNote of fundingNotes) {
        if (
          normalizeFeltForComparison(fundingNote.locked_by_order) ===
          normalizeFeltForComparison(lockRef)
        ) {
          fundingNote.locked_by_order = undefined;
        }
      }
      await saveNotes();
      await pushRecoverySnapshot(true).catch(() => false);
      throw error;
    }
  }

  async function confirmDepositsFromSubmittedTransactions(
    pending: LocalNoteRecord[],
    deployment: DeploymentConfig
  ) {
    const confirmed = new Set<string>();
    const byTransaction = new Map<string, LocalNoteRecord[]>();
    for (const record of pending) {
      if (!record.pending_deposit_tx) continue;
      const fundingCommitment = normalizeOptionalFelt(record.funding_commitment);
      const depositRoot = normalizeOptionalFelt(record.deposit_root);
      const activation = normalizeOptionalFelt(record.encrypted_note_activation);
      if (!fundingCommitment || !depositRoot || !activation) continue;
      const tx = normalizeFeltForComparison(record.pending_deposit_tx);
      if (!tx) continue;
      const group = byTransaction.get(tx) ?? [];
      group.push(record);
      byTransaction.set(tx, group);
    }
    for (const [transactionHash, records] of byTransaction) {
      const status = await fetchTransactionReceiptStatus(
        transactionHash,
        deployment
      ).catch(() => null);
      if (!status?.confirmed || status.failed) continue;
      const calldata = await fetchTransactionCalldata(
        transactionHash,
        deployment
      ).catch(() => null);
      if (!calldata) continue;
      const calldataSet = new Set(calldata.map(normalizeFeltForComparison));
      const bridgeAddress = normalizeOptionalFelt(
        deployment.funding?.starknet_privacy?.bridge_adapter
      );
      for (const record of records) {
        const fundingCommitment = normalizeOptionalFelt(record.funding_commitment);
        const depositRoot = normalizeOptionalFelt(record.deposit_root);
        const activation = normalizeOptionalFelt(record.encrypted_note_activation);
        if (
          transactionCalldataContainsDepositActivation(calldataSet, {
            bridgeAddress,
            fundingCommitment,
            depositRoot,
            activation,
          })
        ) {
          confirmed.add(fundingCommitment!);
        }
      }
    }
    return confirmed;
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
    const orderCommitment = normalizeFeltForComparison(
      request.order_commitment
    );
    notes = notes.map((note) =>
      normalizeFeltForComparison(note.locked_by_order) === orderCommitment
        ? { ...note, locked_by_order: undefined }
        : note
    );
    await saveNotes();
    scheduleRecoverySnapshot(false);
    return accepted;
  }

  async function markPrivateStrategyRelayRegistered(
    strategyId: string,
    relayStatus?: { access_token?: string }
  ) {
    requireUnlocked();
    const strategy = strategies.find((entry) => entry.id === strategyId);
    if (!strategy || !strategy.offline_package) return false;
    if (strategy.status !== "pending_relay") return false;
    if (relayStatus?.access_token) {
      strategy.offline_package.access_token = relayStatus.access_token;
    }
    strategy.status = "delegated";
    strategy.updated_at_unix_ms = Date.now();
    await saveStrategies();
    scheduleRecoverySnapshot(false);
    return true;
  }

  async function settlePrivateOrderLock(
    orderCommitment: string,
    outcome: "released" | "spent",
    settlementFunding?: {
      asset?: string;
      amount?: string;
      batchId?: string;
      noteCommitments?: string[];
    }
  ) {
    requireUnlocked();
    const expectedOrderCommitment = normalizeFeltForComparison(orderCommitment);
    let changed = false;
    notes = notes.map((note) => {
      if (
        normalizeFeltForComparison(note.locked_by_order) !==
        expectedOrderCommitment
      )
        return note;
      changed = true;
      return {
        ...note,
        locked_by_order: undefined,
        spent: outcome === "spent" ? true : note.spent,
      };
    });
    if (outcome === "spent" && settlementFunding?.noteCommitments?.length) {
      const commitments = new Set(
        settlementFunding.noteCommitments.map(normalizeFeltForComparison)
      );
      notes = notes.map((note) => {
        if (!commitments.has(normalizeFeltForComparison(note.note_commitment)))
          return note;
        changed = true;
        return {
          ...note,
          locked_by_order: undefined,
          spent: true,
        };
      });
    }
    if (
      !changed &&
      outcome === "spent" &&
      (await settlementSpendAlreadyRecorded(expectedOrderCommitment))
    ) {
      return false;
    }
    if (!changed) return false;
    if (outcome === "spent")
      await recordSettlementSpend(expectedOrderCommitment);
    await saveNotes();
    scheduleRecoverySnapshot(false);
    return true;
  }

  async function settlementSpendKey(orderCommitment: string) {
    const { seedHex: unlockedSeed } = requireUnlocked();
    const digest = await sha256Json({
      domain: "zylith/settlement-spend-key-v1",
      scope: localStateScope(),
      seed_hex: unlockedSeed,
      order_commitment: normalizeFeltForComparison(orderCommitment),
    });
    return `zylith.settlement-spend.${localStateScope()}.${digest}`;
  }

  async function settlementSpendAlreadyRecorded(orderCommitment: string) {
    try {
      return (
        localStorage.getItem(await settlementSpendKey(orderCommitment)) === "1"
      );
    } catch {
      return false;
    }
  }

  async function recordSettlementSpend(orderCommitment: string) {
    try {
      localStorage.setItem(await settlementSpendKey(orderCommitment), "1");
    } catch {
      /* noop */
    }
  }

  async function submitRenewalParentCancelMarker(
    strategy: PrivateStrategyRecord
  ) {
    const { seedHex: unlockedSeed } = requireUnlocked();
    const deployment = await loadDeploymentConfig();
    const chainId = requiredString(deployment.chain_id, "chain_id");
    const auctionVerifierAddress = requiredNonZeroFelt(
      deployment.contracts?.auction_verifier,
      "auction_verifier_address"
    );
    const basePlanRequest = {
      seed_hex: unlockedSeed,
      chain_id: chainId,
      auction_verifier_address: auctionVerifierAddress,
      parent_secret_commitment: strategy.parent.parent_secret_commitment,
      parent_cancel_authority: strategy.parent.parent_cancel_authority,
      prior_renewal_entries: [],
    };
    const markerPlan = JSON.parse(
      core.zylith_wallet_build_renewal_parent_cancel_submission_plan(
        JSON.stringify(basePlanRequest)
      )
    ) as {
      starknet_call: StarknetCallPayload;
      encoded_args: { cancel_marker: string };
    };
    const witness = await fetchRenewalCancelWitness(
      markerPlan.encoded_args.cancel_marker
    );
    const plan = JSON.parse(
      core.zylith_wallet_build_renewal_parent_cancel_submission_plan(
        JSON.stringify({
          ...basePlanRequest,
          prior_renewal_entries: witness.prior_renewal_entries,
          renewal_cancel_sparse_witness: witness.renewal_cancel_sparse_witness,
        })
      )
    ) as {
      starknet_call: StarknetCallPayload;
      encoded_args: { cancel_marker: string };
    };
    const transactionHash = await executeInjectedStarknetCalls([plan.starknet_call]);
    await recordRenewalCancelMarkerWithCoordinator(
      plan.encoded_args.cancel_marker,
      auctionVerifierAddress,
      transactionHash
    );
    return {
      transactionHash,
      cancelMarker: plan.encoded_args.cancel_marker,
    };
  }

  async function deriveRenewalParentCancelMarker(
    unlockedSeed: string,
    strategy: PrivateStrategyRecord
  ) {
    const deployment = await loadDeploymentConfig();
    const chainId = requiredString(deployment.chain_id, "chain_id");
    const auctionVerifierAddress = requiredNonZeroFelt(
      deployment.contracts?.auction_verifier,
      "auction_verifier_address"
    );
    const markerPlan = JSON.parse(
      core.zylith_wallet_build_renewal_parent_cancel_submission_plan(
        JSON.stringify({
          seed_hex: unlockedSeed,
          chain_id: chainId,
          auction_verifier_address: auctionVerifierAddress,
          parent_secret_commitment: strategy.parent.parent_secret_commitment,
          parent_cancel_authority: strategy.parent.parent_cancel_authority,
          prior_renewal_entries: [],
        })
      )
    ) as { encoded_args: { cancel_marker: string } };
    return markerPlan.encoded_args.cancel_marker;
  }

  async function recordRenewalCancelMarkerWithCoordinator(
    cancelMarker: string,
    auctionVerifierAddress: string,
    transactionHash?: string
  ) {
    if (!coordinatorUrl) return false;
    const payload = {
      cancel_marker: cancelMarker,
      auction_verifier_address: auctionVerifierAddress,
      transaction_hash: transactionHash,
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await postJson(coordinatorUrl, "/api/renewal/cancel-markers", payload);
        return true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Renewal cancellation marker was not indexed yet");
  }

  async function fetchRenewalCancelWitness(cancelMarker: string) {
    if (!coordinatorUrl) {
      throw new Error("Cancellation witness service is not configured");
    }
    const witness = await fetchJson<RenewalCancelWitnessResponse>(
      coordinatorUrl,
      `/api/renewal/cancel-witness/${encodeURIComponent(cancelMarker)}`
    ).catch(() => null);
    if (!witness?.renewal_cancel_sparse_witness) {
      throw new Error(
        "Cancellation witness is not available yet. Please retry after the current settlement syncs."
      );
    }
    if (
      normalizeFeltForComparison(witness.cancel_marker) !==
      normalizeFeltForComparison(cancelMarker)
    ) {
      throw new Error("Cancellation witness does not match this curve");
    }
    return witness;
  }

  function signRenewalRelayPackageAuthorization(
    unlockedSeed: string,
    packageCommitment: string,
    parentSecretCommitment: string,
    parentCancelAuthority: string
  ) {
    return JSON.parse(
      core.zylith_wallet_sign_renewal_relay_package_authorization(
        JSON.stringify({
          seed_hex: unlockedSeed,
          package_commitment: packageCommitment,
          parent_secret_commitment: parentSecretCommitment,
          parent_cancel_authority: parentCancelAuthority,
        })
      )
    ) as OfflineRenewalPackage["relay_authorization"];
  }

  async function verifyOfflineRenewalPackage(
    renewalPackage: OfflineRenewalPackage
  ) {
    const result = JSON.parse(
      core.zylith_wallet_verify_renewal_relay_package(
        JSON.stringify(renewalPackage)
      )
    ) as { verified?: boolean };
    return result.verified === true;
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
    const cancelledChildCommitments = new Set<string>();
    const unresolvedChildCommitments = new Set<string>();
    for (const child of strategy.submitted_children) {
      const commitment = normalizeFeltForComparison(child.order_commitment);
      if (
        !child.order_commitment ||
        !child.cancellation_secret ||
        !coordinatorUrl
      ) {
        if (commitment) unresolvedChildCommitments.add(commitment);
        continue;
      }
      try {
        await postJson(coordinatorUrl, "/api/orders/cancel", {
          batch_id: child.batch_id,
          order_commitment: child.order_commitment,
          cancellation_secret: child.cancellation_secret,
        });
        cancelledChildCommitments.add(commitment);
        child.relay_status = "cancelled";
        child.relay_detail = undefined;
      } catch (error) {
        unresolvedChildCommitments.add(commitment);
        child.relay_status = "cancel_pending";
        child.relay_detail = userFacingErrorMessage(
          error,
          "Child cancellation is pending retry."
        );
      }
    }
    const strategyLockRef = strategyFundingLockRef(strategy);
    const releaseStrategyLock = unresolvedChildCommitments.size === 0;
    notes = notes.map((note) =>
      note.locked_by_order &&
      (cancelledChildCommitments.has(
        normalizeFeltForComparison(note.locked_by_order)
      ) ||
        (releaseStrategyLock &&
          normalizeFeltForComparison(note.locked_by_order) === strategyLockRef))
        ? { ...note, locked_by_order: undefined }
        : note
    );
    await saveNotes();
    await saveStrategies();
    scheduleRecoverySnapshot(false);
    return {
      cancelled_at_unix_ms: cancelledAt,
      parent_cancel_transaction_hash: parentCancel.transactionHash,
    };
  }

  async function discardPreparedPrivateStrategy(strategyId: string) {
    requireUnlocked();
    const strategy = strategies.find((entry) => entry.id === strategyId);
    if (!strategy || !strategy.offline_package) return false;
    const hasSubmittedChild = strategy.submitted_children.some(
      (child) => child.submitted_at_unix_ms > 0
    );
    if (hasSubmittedChild || strategy.parent_cancel_marker) {
      return false;
    }
    const childCommitments = new Set(
      strategy.submitted_children
        .map((child) => normalizeFeltForComparison(child.order_commitment))
        .filter(Boolean)
    );
    const strategyLockRef = strategyFundingLockRef(strategy);
    notes = notes.map((note) =>
      note.locked_by_order &&
      (childCommitments.has(normalizeFeltForComparison(note.locked_by_order)) ||
        normalizeFeltForComparison(note.locked_by_order) === strategyLockRef)
        ? { ...note, locked_by_order: undefined }
        : note
    );
    strategies = strategies.filter((entry) => entry.id !== strategyId);
    await saveNotes();
    await saveStrategies();
    scheduleRecoverySnapshot(false);
    return true;
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
    const batch = await fetchSubmittablePairBatch(strategy.pair).catch(
      () => null
    );
    const resumedAt = Date.now();
    if (batch && batch.status === "Open") {
      const nextEpoch = firstRenewalSlotEpoch(
        batch,
        strategy.offline_package?.relay_mode ?? "SelfRelay"
      );
      const remainingSlots = Math.max(
        1,
        strategy.max_children - strategy.next_child_index + 1
      );
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
    if (strategy.status === "cancelled")
      throw new Error("Cancelled strategies cannot be refreshed");
    if (strategy.mode === "Resting") {
      throw new Error(
        "Legacy resting liquidity automation is disabled; open a private liquidity position instead."
      );
    }
    if (!STRATEGY_ORDER_MODES.has(strategy.mode)) {
      throw new Error(
        "Renewal package refresh is only supported for TWAP, VWAP, and Repeat strategies"
      );
    }
    const offlinePackage = await createOfflineRenewalPackageForStrategy(
      strategy
    );
    strategy.status =
      offlinePackage.relay_mode === "ZylithRelay"
        ? "pending_relay"
        : "delegated";
    strategy.updated_at_unix_ms = Date.now();
    await saveNotes();
    await saveStrategies();
    await pushRecoverySnapshot(true).catch(() => false);
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
      detail?: string;
      accepted?: {
        order_commitment?: string;
        batch_id?: string;
        accepted_at_unix_ms?: number;
      };
    }>
  ): Promise<boolean> {
    requireUnlocked();
    const strategy = strategies.find((entry) => entry.id === packageId);
    if (!strategy || results.length === 0) return false;
    let changed = false;
    let relayNeedsRefresh = false;
    for (const result of results) {
      const commitment =
        result.accepted?.order_commitment ?? result.order_commitment;
      const child = strategy.submitted_children.find(
        (entry) =>
          (commitment && entry.order_commitment === commitment) ||
          (result.order_commitment &&
            entry.order_commitment === result.order_commitment) ||
          (result.slot_id &&
            result.slot_id === `${strategy.id}:${entry.parent_child_index}`)
      );
      if (!child) continue;
      if (result.status && child.relay_status !== result.status) {
        child.relay_status = result.status;
        changed = true;
      }
      if (child.relay_detail !== result.detail) {
        child.relay_detail = result.detail;
        changed = true;
      }
      if (result.status === "awaiting_wallet_refresh") {
        relayNeedsRefresh = true;
        continue;
      }
      if (
        result.status !== "submitted" &&
        result.status !== "already_submitted"
      )
        continue;
      const acceptedAt = result.accepted?.accepted_at_unix_ms ?? Date.now();
      if (commitment && child.order_commitment !== commitment) {
        child.order_commitment = commitment;
        changed = true;
      }
      if (
        result.accepted?.batch_id &&
        child.batch_id !== result.accepted.batch_id
      ) {
        child.batch_id = result.accepted.batch_id;
        changed = true;
      } else if (result.batch_id && child.batch_id !== result.batch_id) {
        child.batch_id = result.batch_id;
        changed = true;
      }
      if (
        typeof result.epoch_id === "number" &&
        child.epoch_id !== result.epoch_id
      ) {
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
    if (relayNeedsRefresh) {
      if (strategy.status !== "paused") {
        strategy.status = "paused";
      }
      strategy.last_error =
        "Renewal relay is paused until this package is refreshed from the wallet.";
    } else {
      if (strategy.status === "pending_relay") {
        strategy.status = "delegated";
      }
      strategy.last_error = undefined;
    }
    await saveStrategies();
    scheduleRecoverySnapshot(false);
    return true;
  }

  async function submitSinglePrivateOrder(
    draft: PrivateOrderDraft,
    batch: BatchSummary,
    registry: unknown,
    parent?: { material: StrategyParentMaterial; childIndex: number }
  ) {
    const telemetryStart = performance.now();
    const submissionSafetyBufferMs = batchSubmissionSafetyBufferMs(
      draft.batchWindowMs
    );
    if (!DIRECT_ORDER_MODES.has(draft.mode)) {
      throw new Error(
        `${draft.mode} must be materialized as a parent-bound child order`
      );
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error(
        "Coordinator and private ingress URLs are required for private order submission"
      );
    }
    if (batch.status !== "Open") {
      throw new Error("Auction window is no longer open");
    }
    if (
      batch.close_time_unix_ms - Date.now() <=
      submissionSafetyBufferMs
    ) {
      throw new Error("Auction window is inside the submission safety buffer");
    }
    const fundingNotes = selectFundingNotes(draft);
    const built = buildPrivateOrderForSlot(
      draft,
      batch,
      fundingNotes,
      registry,
      parent
    );
    const buildCompletedAt = performance.now();
    const pendingOrderCommitment = normalizeFeltForComparison(
      built.order_commitment
    );
    for (const fundingNote of fundingNotes) {
      fundingNote.locked_by_order = pendingOrderCommitment;
    }
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    let privateIngressStarted = false;
    let coordinatorSubmissionStarted = false;
    try {
      const submissionDelayMs = privateSubmissionDelayMs(
        batch.close_time_unix_ms,
        submissionSafetyBufferMs
      );
      await delay(submissionDelayMs);
      if (
        batch.close_time_unix_ms - Date.now() <=
        submissionSafetyBufferMs
      ) {
        throw new Error(
          "Auction window entered the submission safety buffer before private ingress submission"
        );
      }
      const beforePrivateIngress = performance.now();
      const ingressTelemetry: OrderIngressTelemetry = {
        version: 1,
        client_build_ms: elapsedMs(telemetryStart, buildCompletedAt),
        private_submission_delay_ms: submissionDelayMs,
        client_elapsed_before_private_ingress_ms: elapsedMs(
          telemetryStart,
          beforePrivateIngress
        ),
        batch_time_remaining_before_private_ingress_ms:
          remainingBatchMs(batch.close_time_unix_ms),
        submission_safety_buffer_ms: submissionSafetyBufferMs,
      };
      privateIngressStarted = true;
      const ingress = await postJson<IngressResponse>(
        proverUrl,
        "/api/private/orders",
        attachOrderIngressTelemetry(built.ingress_request, ingressTelemetry)
      );
      const afterPrivateIngress = performance.now();
      const coordinatorTelemetry: OrderIngressTelemetry = {
        ...ingressTelemetry,
        private_ingress_roundtrip_ms: elapsedMs(
          beforePrivateIngress,
          afterPrivateIngress
        ),
        client_elapsed_before_coordinator_ms: elapsedMs(
          telemetryStart,
          afterPrivateIngress
        ),
        batch_time_remaining_before_coordinator_ms:
          remainingBatchMs(batch.close_time_unix_ms),
      };
      coordinatorSubmissionStarted = true;
      const accepted = await postJson<CoordinatorAccepted>(
        coordinatorUrl,
        "/api/orders",
        attachOrderIngressTelemetry(
          ingress.coordinator_submission,
          coordinatorTelemetry
        )
      );
      const acceptedOrderCommitment = normalizeFeltForComparison(
        accepted.order_commitment ?? built.order_commitment
      );
      if (acceptedOrderCommitment !== pendingOrderCommitment) {
        for (const fundingNote of fundingNotes) {
          if (
            normalizeFeltForComparison(fundingNote.locked_by_order) ===
            pendingOrderCommitment
          ) {
            fundingNote.locked_by_order = acceptedOrderCommitment;
          }
        }
        await saveNotes();
        await pushRecoverySnapshot(true).catch(() => false);
      }
      return {
        order_commitment: acceptedOrderCommitment,
        cancellation_secret: built.cancellation_secret,
        expected_output_metadata_commitment:
          built.expected_output_metadata_commitment,
        funding_note_commitments: fundingNotes.map(
          (note) => note.note_commitment
        ),
        batch_id: accepted.batch_id ?? batch.batch_id,
        epoch_id: batch.epoch_id,
      };
    } catch (error) {
      if (
        isAmbiguousPrivateOrderSubmissionError(
          error,
          coordinatorSubmissionStarted
            ? "coordinator_submission"
            : privateIngressStarted
              ? "private_ingress"
              : "pre_ingress"
        )
      ) {
        return {
          order_commitment: pendingOrderCommitment,
          cancellation_secret: built.cancellation_secret,
          expected_output_metadata_commitment:
            built.expected_output_metadata_commitment,
          funding_note_commitments: fundingNotes.map(
            (note) => note.note_commitment
          ),
          batch_id: batch.batch_id,
          epoch_id: batch.epoch_id,
          submission_ambiguous: true,
        };
      }
      for (const fundingNote of fundingNotes) {
        if (
          normalizeFeltForComparison(fundingNote.locked_by_order) ===
          pendingOrderCommitment
        ) {
          fundingNote.locked_by_order = undefined;
        }
      }
      await saveNotes();
      await pushRecoverySnapshot(true).catch(() => false);
      throw error;
    }
  }

  async function submitSinglePrivateOrderWithFreshBatch(
    draft: PrivateOrderDraft,
    registry: unknown,
    parent?: { material: StrategyParentMaterial; childIndex: number }
  ) {
    if (draft.batchId?.trim()) {
      const batch = await resolveExplicitPairBatch(draft);
      return submitSinglePrivateOrder(draft, batch, registry, parent);
    }
    let lastRolloverError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const batch = await resolveSubmittablePairBatch(
        draft.pair,
        draft.batchWindowMs
      );
      if (!batch || batch.status !== "Open") {
        lastRolloverError = new Error("Auction window is no longer open");
        await delay(250);
        continue;
      }
      try {
        return await submitSinglePrivateOrder(draft, batch, registry, parent);
      } catch (error) {
        if (!isBatchRolloverError(error)) throw error;
        lastRolloverError = error;
        await delay(250);
      }
    }
    throw lastRolloverError instanceof Error
      ? lastRolloverError
      : new Error("Auction window is no longer open");
  }

  async function createPrivateStrategy(draft: PrivateOrderDraft) {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (!STRATEGY_ORDER_MODES.has(draft.mode)) {
      throw new Error("Strategy worker only supports TWAP, VWAP, and Repeat");
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error(
        "Coordinator and private ingress URLs are required for strategy submission"
      );
    }
    const batch = await resolveSubmittablePairBatch(
      draft.pair,
      draft.batchWindowMs
    );
    if (!batch || batch.status !== "Open") {
      throw new Error("Strategy auction window is no longer open");
    }
    const totalAmount = parseRawAmount(draft.amount, "strategy amount");
    const maxChildren = clampStrategyChildren(
      draft.maxChildren ??
        draft.durationBatches ??
        defaultStrategyChildren(draft.mode)
    );
    const childAmount =
      parseOptionalRawAmount(draft.childAmount, "child amount") ??
      ceilDiv(totalAmount, BigInt(maxChildren));
    if (childAmount <= 0n || childAmount > totalAmount) {
      throw new Error(
        "Child amount must be positive and not exceed strategy amount"
      );
    }
    const limitPrice = parseRawAmount(draft.limitPrice, "limit price");
    const minFill = normalizeOrderMinFill(draft, childAmount);
    const parent = JSON.parse(
      core.zylith_wallet_build_strategy_parent(
        JSON.stringify({
          seed_hex: unlockedSeed,
          parent_authorization_secret: randomFeltHex(),
        })
      )
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
      batch_window_ms: draft.batchWindowMs,
      max_children: maxChildren,
      next_child_index: 1,
      start_epoch: batch.epoch_id,
      end_epoch: batch.epoch_id + maxChildren - 1,
      randomized_slicing: draft.randomizedSlicing ?? true,
      slice_jitter_bps: normalizeJitterBps(draft.randomizedSlicingBps),
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
      first_child_order_commitment:
        strategy.submitted_children[0]?.order_commitment,
      first_child_batch_id: strategy.submitted_children[0]?.batch_id,
      first_child_epoch_id: strategy.submitted_children[0]?.epoch_id,
      first_child_cancellation_secret:
        strategy.submitted_children[0]?.cancellation_secret,
      expected_output_metadata_commitment:
        strategy.submitted_children[0]?.expected_output_metadata_commitment,
      funding_note_commitments:
        strategy.submitted_children[0]?.funding_note_commitments,
      status:
        strategy.submitted_children.length > 0
          ? "Strategy active; first child submitted"
          : "Strategy active; waiting for next safe batch window",
    };
  }

  async function createOfflineRenewalPackage(
    draft: PrivateOrderDraft
  ): Promise<OfflineRenewalPackage> {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (!STRATEGY_ORDER_MODES.has(draft.mode)) {
      throw new Error(
        "Offline renewal packages only support TWAP, VWAP, and Repeat strategies"
      );
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error(
        "Coordinator and private ingress URLs are required for offline renewal packages"
      );
    }
    const anchorBatch = await resolveSubmittablePairBatch(
      draft.pair,
      draft.batchWindowMs
    );
    if (!anchorBatch || anchorBatch.status !== "Open") {
      throw new Error(
        "No safe auction window is available; cannot anchor offline renewal slots"
      );
    }
    const registry = await fetchIngressRegistry();
    const totalAmount = parseRawAmount(draft.amount, "strategy amount");
    const maxChildren = clampStrategyChildren(
      draft.maxChildren ??
        draft.durationBatches ??
        defaultStrategyChildren(draft.mode)
    );
    const childAmount =
      parseOptionalRawAmount(draft.childAmount, "child amount") ??
      ceilDiv(totalAmount, BigInt(maxChildren));
    if (childAmount <= 0n || childAmount > totalAmount) {
      throw new Error(
        "Child amount must be positive and not exceed strategy amount"
      );
    }
    const limitPrice = parseRawAmount(draft.limitPrice, "limit price");
    const minFill = normalizeOrderMinFill(draft, childAmount);
    const firstEpoch = firstRenewalSlotEpoch(
      anchorBatch,
      draft.relayMode ?? "SelfRelay",
      Date.now(),
      draft.batchWindowMs
    );
    const parent = JSON.parse(
      core.zylith_wallet_build_strategy_parent(
        JSON.stringify({
          seed_hex: unlockedSeed,
          parent_authorization_secret: randomFeltHex(),
        })
      )
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
      batch_window_ms: draft.batchWindowMs,
      max_children: maxChildren,
      next_child_index: 1,
      start_epoch: firstEpoch,
      end_epoch: firstEpoch + maxChildren - 1,
      randomized_slicing: draft.randomizedSlicing ?? true,
      slice_jitter_bps: normalizeJitterBps(draft.randomizedSlicingBps),
      renewal_window_children: maxChildren,
      parent,
      submitted_children: [],
      status: draft.relayMode === "ZylithRelay" ? "pending_relay" : "delegated",
      created_at_unix_ms: Date.now(),
      updated_at_unix_ms: Date.now(),
    };
    const slots: OfflineRenewalSlot[] = [];
    const reservedNotes = new Set<string>();
    const fundingLocks: Array<{
      notes: LocalNoteRecord[];
      orderCommitment: string;
    }> = [];
    const fundingLabelSalt = randomFeltHex();
    for (let offset = 0; offset < maxChildren; offset += 1) {
      const amount = strategyChildAmount(strategy);
      if (amount <= 0n) break;
      const epoch = firstEpoch + offset;
      const batch = syntheticBatchForEpoch(draft.pair, epoch);
      const childIndex = strategy.next_child_index;
      const childDraft: PrivateOrderDraft = {
        pair: strategy.pair,
        side: strategy.side,
        mode: "Limit",
        amount: amount.toString(),
        limitPrice: strategy.limit_price,
        priceBaseScale: strategy.price_base_scale,
        minFill: min(BigInt(strategy.min_fill), amount).toString(),
        fillOrKill: strategy.fill_or_kill,
        batchId: batch.batch_id,
        relayMode: draft.relayMode ?? "SelfRelay",
      };
      const fundingNotes = selectFundingNotes(childDraft, reservedNotes);
      for (const fundingNote of fundingNotes) {
        reservedNotes.add(fundingNote.note_commitment);
      }
      const built = buildPrivateOrderForSlot(
        childDraft,
        batch,
        fundingNotes,
        registry,
        {
          material: strategy.parent,
          childIndex,
        }
      );
      const fundingLabels = await renewalFundingNoteLabels(
        strategy,
        fundingNotes,
        fundingLabelSalt
      );
      fundingLocks.push({
        notes: fundingNotes,
        orderCommitment: built.order_commitment,
      });
      strategy.submitted_children.push({
        parent_child_index: childIndex,
        batch_id: batch.batch_id,
        epoch_id: batch.epoch_id,
        order_commitment: built.order_commitment,
        cancellation_secret: built.cancellation_secret,
        expected_output_metadata_commitment:
          built.expected_output_metadata_commitment,
        funding_note_commitments: fundingNotes.map(
          (note) => note.note_commitment
        ),
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
        funding_note_commitments: fundingLabels,
        ingress_request: built.ingress_request,
      });
      strategy.remaining_amount = (
        BigInt(strategy.remaining_amount) - amount
      ).toString();
      strategy.next_child_index += 1;
      if (BigInt(strategy.remaining_amount) <= 0n) break;
    }
    if (slots.length === 0) {
      throw new Error(
        "Offline renewal package did not produce any child slots"
      );
    }
    const packageIngressKeyPin = await ingressRegistryFingerprintPin();
    const parentCancelMarker = await deriveRenewalParentCancelMarker(
      unlockedSeed,
      strategy
    );
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
      parent_cancel_authority: strategy.parent.parent_cancel_authority,
      parent_cancel_marker: parentCancelMarker,
      ingress_key_registry_fingerprint: packageIngressKeyPin || undefined,
      relay_policy: {
        prover_url: proverUrl,
        coordinator_url: coordinatorUrl,
        submission_safety_buffer_ms: batchSubmissionSafetyBufferMs(
          draft.batchWindowMs
        ),
        max_submission_delay_ms: renewalPackageMaxSubmissionDelayMs(
          draft.relayMode ?? "SelfRelay"
        ),
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
    offlinePackage.relay_authorization = signRenewalRelayPackageAuthorization(
      unlockedSeed,
      offlinePackage.package_commitment,
      strategy.parent.parent_secret_commitment,
      offlinePackage.parent_cancel_authority
    );
    strategy.offline_package = offlinePackage;
    strategies.push(strategy);
    for (const lock of fundingLocks) {
      const lockRef = normalizeFeltForComparison(lock.orderCommitment);
      for (const note of lock.notes) {
        note.locked_by_order = lockRef;
      }
    }
    await saveNotes();
    await saveStrategies();
    await pushRecoverySnapshot(true).catch(() => false);
    return offlinePackage;
  }

  async function createOfflineRenewalPackageForStrategy(
    strategy: PrivateStrategyRecord
  ): Promise<OfflineRenewalPackage> {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (strategy.mode === "Resting") {
      throw new Error(
        "Legacy resting liquidity automation is disabled; open a private liquidity position instead."
      );
    }
    if (!coordinatorUrl || !proverUrl) {
      throw new Error(
        "Coordinator and private ingress URLs are required for offline renewal packages"
      );
    }
    const anchorBatch = await resolveSubmittablePairBatch(
      strategy.pair,
      strategy.batch_window_ms
    );
    if (!anchorBatch || anchorBatch.status !== "Open") {
      throw new Error(
        "No safe auction window is available; cannot refresh renewal slots"
      );
    }
    const registry = await fetchIngressRegistry();
    const firstSafeEpoch = firstRenewalSlotEpoch(
      anchorBatch,
      strategy.offline_package?.relay_mode ?? "SelfRelay",
      Date.now(),
      strategy.batch_window_ms
    );
    const firstEpoch = Math.max(firstSafeEpoch, strategy.end_epoch + 1);
    const slotCount = clampStrategyChildren(
      strategy.renewal_window_children ??
        strategy.offline_package?.slot_count ??
        defaultStrategyChildren(strategy.mode)
    );
    const slots: OfflineRenewalSlot[] = [];
    const reservedNotes = new Set<string>();
    const fundingLocks: Array<{
      notes: LocalNoteRecord[];
      orderCommitment: string;
    }> = [];
    const fundingLabelSalt = randomFeltHex();
    for (let offset = 0; offset < slotCount; offset += 1) {
      const amount = strategyChildAmount(strategy);
      if (amount <= 0n) break;
      const epoch = firstEpoch + offset;
      const batch = syntheticBatchForEpoch(strategy.pair, epoch);
      const childIndex = strategy.next_child_index;
      const childDraft: PrivateOrderDraft = {
        pair: strategy.pair,
        side: strategy.side,
        mode: "Limit",
        amount: amount.toString(),
        limitPrice: strategy.limit_price,
        priceBaseScale: strategy.price_base_scale,
        minFill: min(BigInt(strategy.min_fill), amount).toString(),
        fillOrKill: strategy.fill_or_kill,
        batchId: batch.batch_id,
        relayMode: strategy.offline_package?.relay_mode ?? "SelfRelay",
      };
      const fundingNotes = selectFundingNotes(childDraft, reservedNotes);
      for (const fundingNote of fundingNotes) {
        reservedNotes.add(fundingNote.note_commitment);
      }
      const built = buildPrivateOrderForSlot(
        childDraft,
        batch,
        fundingNotes,
        registry,
        {
          material: strategy.parent,
          childIndex,
        }
      );
      const fundingLabels = await renewalFundingNoteLabels(
        strategy,
        fundingNotes,
        fundingLabelSalt
      );
      fundingLocks.push({
        notes: fundingNotes,
        orderCommitment: built.order_commitment,
      });
      strategy.submitted_children.push({
        parent_child_index: childIndex,
        batch_id: batch.batch_id,
        epoch_id: batch.epoch_id,
        order_commitment: built.order_commitment,
        cancellation_secret: built.cancellation_secret,
        expected_output_metadata_commitment:
          built.expected_output_metadata_commitment,
        funding_note_commitments: fundingNotes.map(
          (note) => note.note_commitment
        ),
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
        funding_note_commitments: fundingLabels,
        ingress_request: built.ingress_request,
      });
      strategy.remaining_amount = (
        BigInt(strategy.remaining_amount) - amount
      ).toString();
      strategy.next_child_index += 1;
      if (BigInt(strategy.remaining_amount) <= 0n) break;
    }
    if (slots.length === 0) {
      throw new Error(
        "Offline renewal package did not produce any child slots"
      );
    }
    const packageIngressKeyPin = await ingressRegistryFingerprintPin();
    const parentCancelMarker = await deriveRenewalParentCancelMarker(
      unlockedSeed,
      strategy
    );
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
      parent_cancel_authority: strategy.parent.parent_cancel_authority,
      parent_cancel_marker: parentCancelMarker,
      ingress_key_registry_fingerprint: packageIngressKeyPin || undefined,
      relay_policy: {
        prover_url: proverUrl,
        coordinator_url: coordinatorUrl,
        submission_safety_buffer_ms: batchSubmissionSafetyBufferMs(
          strategy.batch_window_ms
        ),
        max_submission_delay_ms: renewalPackageMaxSubmissionDelayMs(
          strategy.offline_package?.relay_mode ?? "SelfRelay"
        ),
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
    offlinePackage.relay_authorization = signRenewalRelayPackageAuthorization(
      unlockedSeed,
      offlinePackage.package_commitment,
      strategy.parent.parent_secret_commitment,
      offlinePackage.parent_cancel_authority
    );
    strategy.offline_package = offlinePackage;
    strategy.max_children = Math.max(
      strategy.max_children,
      strategy.next_child_index - 1
    );
    strategy.renewal_window_children = slotCount;
    strategy.end_epoch = offlinePackage.end_epoch;
    strategy.last_error = undefined;
    for (const lock of fundingLocks) {
      const lockRef = normalizeFeltForComparison(lock.orderCommitment);
      for (const note of lock.notes) {
        note.locked_by_order = lockRef;
      }
    }
    return offlinePackage;
  }

  function startStrategyWorker() {
    if (strategyTimer !== null) return;
    strategyTimer = window.setInterval(() => {
      void runStrategyWorkerOnce().catch(() => undefined);
    }, STRATEGY_WORKER_INTERVAL_MS);
  }

  function startDepositConfirmationWorker() {
    if (depositConfirmationTimer !== null) return;
    depositConfirmationTimer = window.setInterval(() => {
      void runDepositConfirmationWorkerOnce();
    }, DEPOSIT_CONFIRMATION_WORKER_INTERVAL_MS);
    void runDepositConfirmationWorkerOnce();
  }

  async function runDepositConfirmationWorkerOnce() {
    if (!seedHex || !publicConfig || depositConfirmationWorkerInFlight) return;
    const hasPendingDeposit = hasRecoverablePendingDeposit(notes);
    if (!hasPendingDeposit) return;
    depositConfirmationWorkerInFlight = true;
    try {
      await refreshDepositConfirmations().catch(() => false);
    } finally {
      depositConfirmationWorkerInFlight = false;
    }
  }

  async function runStrategyWorkerOnce() {
    requireUnlocked();
    if (strategyWorkerInFlight) return;
    const active = strategies.filter(
      (strategy) => strategy.status === "active"
    );
    if (active.length === 0) return;
    strategyWorkerInFlight = true;
    try {
      for (const strategy of active) {
        if (strategy.mode === "Resting") {
          strategy.status = "paused";
          strategy.last_error =
            "Legacy resting liquidity automation is disabled; open a private liquidity position instead.";
          strategy.updated_at_unix_ms = Date.now();
          continue;
        }
        await materializeStrategyChildIfDue(strategy);
      }
      await saveStrategies();
      scheduleRecoverySnapshot(false);
    } finally {
      strategyWorkerInFlight = false;
    }
  }

  async function materializeStrategyChildIfDue(
    strategy: PrivateStrategyRecord
  ) {
    if (strategy.mode === "Resting") {
      strategy.status = "paused";
      strategy.last_error =
        "Legacy resting liquidity automation is disabled; open a private liquidity position instead.";
      strategy.updated_at_unix_ms = Date.now();
      return;
    }
    if (strategy.next_child_index > strategy.max_children) {
      strategy.status = "completed";
      strategy.updated_at_unix_ms = Date.now();
      return;
    }
    const batch = await resolveSubmittablePairBatch(
      strategy.pair,
      strategy.batch_window_ms
    );
    if (!batch || batch.status !== "Open") return;
    if (
      batch.epoch_id < strategy.start_epoch ||
      batch.epoch_id > strategy.end_epoch
    ) {
      if (batch.epoch_id > strategy.end_epoch) strategy.status = "completed";
      strategy.updated_at_unix_ms = Date.now();
      return;
    }
    if (
      strategy.submitted_children.some(
        (child) => child.batch_id === batch.batch_id
      )
    ) {
      return;
    }
    if (
      batch.close_time_unix_ms - Date.now() <=
      batchSubmissionSafetyBufferMs(strategy.batch_window_ms)
    ) {
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
      mode: "Limit",
      amount: amount.toString(),
      limitPrice: strategy.limit_price,
      priceBaseScale: strategy.price_base_scale,
      minFill: (minFill > amount ? amount : minFill).toString(),
      fillOrKill: strategy.fill_or_kill,
      batchId: batch.batch_id,
      batchWindowMs: strategy.batch_window_ms,
    };
    try {
      const registry = await fetchIngressRegistry();
      const childIndex = strategy.next_child_index;
      const submitted = await submitSinglePrivateOrderWithFreshBatch(
        draft,
        registry,
        {
          material: strategy.parent,
          childIndex,
        }
      );
      strategy.submitted_children.push({
        parent_child_index: childIndex,
        batch_id: submitted.batch_id,
        epoch_id: submitted.epoch_id ?? batch.epoch_id,
        order_commitment: submitted.order_commitment,
        cancellation_secret: submitted.cancellation_secret,
        expected_output_metadata_commitment:
          submitted.expected_output_metadata_commitment,
        funding_note_commitments: submitted.funding_note_commitments,
        submitted_at_unix_ms: Date.now(),
      });
      strategy.remaining_amount = (
        BigInt(strategy.remaining_amount) - amount
      ).toString();
      strategy.next_child_index += 1;
      strategy.last_error = undefined;
      if (
        strategy.next_child_index > strategy.max_children ||
        BigInt(strategy.remaining_amount) <= 0n
      ) {
        strategy.status = "completed";
      }
      strategy.updated_at_unix_ms = Date.now();
    } catch (error) {
      strategy.last_error = userFacingErrorMessage(
        error,
        "Strategy child submission failed."
      );
      strategy.updated_at_unix_ms = Date.now();
    }
  }

  async function submitStrk20Withdrawal(rawRequest: unknown) {
    const deployment = await loadDeploymentConfig();
    if (!strk20WithdrawalEnabledForDeployment(deployment)) {
      throw new Error("STRK20 withdrawals are not configured for this deployment.");
    }
    const request = rawRequest as Strk20WithdrawalRequest;
    const { seedHex: unlockedSeed } = requireUnlocked();
    const note = selectWithdrawableNote(request.note_commitment);
    const noteCommitment = note.note_commitment;
    const currentWithdrawalNote = () =>
      notes.find((record) => record.note_commitment === noteCommitment) || note;
    if (note.source !== "settlement_output") {
      throw new Error(
        "This note cannot be withdrawn until it is converted into a settlement output."
      );
    }
    const outputNote = request.output_note ?? note.output_note;
    const outputProof = request.output_proof ?? note.output_proof;
    const batchId = request.batch_id ?? note.batch_id;
    if (!outputNote || !outputProof || !batchId) {
      throw new Error(
        "Withdrawal proof data is missing. Refresh private state and retry."
      );
    }
    const fundingRail = selectedDepositFundingRail(deployment);
    const privacyPoolAddress = requiredNonZeroFelt(
      fundingRail.privacyPool,
      "privacy_pool_address"
    );
    const bridgeAddress = requiredNonZeroFelt(
      fundingRail.bridgeAdapter,
      "privacy_deposit_bridge_address"
    );
    const auctionVerifierAddress = requiredNonZeroFelt(
      deployment.contracts?.auction_verifier,
      "auction_verifier_address"
    );
    const shieldedAssetAdapterAddress = requiredNonZeroFelt(
      fundingRail.shieldedAssetAdapter,
      "shielded_asset_adapter_address"
    );
    if (
      normalizeFeltForComparison(bridgeAddress) !==
      normalizeFeltForComparison(shieldedAssetAdapterAddress)
    ) {
      throw new Error(
        "STRK20 open-note withdrawals require the privacy bridge to be the shielded adapter."
      );
    }
    const chainId = requiredNonZeroFelt(deployment.chain_id, "chain_id");
    const tokenAddress = fundingRailTokenAddress(deployment, note.note.asset_id);
    const rpcUrl = requiredString(deployment.rpc_url, "rpc_url");
    const discoveryUrl = browserSafeServiceUrl(
      normalizeUrl(fundingRail.discoveryUrl),
      "/starknet-privacy-discovery"
    );
    const provingUrl = browserSafeServiceUrl(
      normalizeUrl(fundingRail.provingUrl),
      "/starknet-privacy-prover"
    );
    if (!discoveryUrl || !provingUrl) {
      throw new Error("Private withdrawal service URLs are required");
    }
    const strk20ExitCommitment = note.strk20_exit_commitment
      ? requiredNonZeroFelt(
          note.strk20_exit_commitment,
          "strk20_exit_commitment"
        )
      : randomFeltHex();
    let stagedTransactionHash = note.pending_withdrawal_tx;
    if (!stagedTransactionHash) {
      const prepared = await postJson<{ witness: unknown }>(
        proverUrl,
        "/api/private/withdrawals/prepare",
        {
          batch_id: batchId,
          output_note: outputNote,
          output_note_preimage: note.note,
          output_proof: outputProof,
          strk20_exit_commitment: strk20ExitCommitment,
        },
        {},
        { timeoutMs: STRK20_WITHDRAWAL_PREPARE_TIMEOUT_MS }
      );
      const signedWitness = JSON.parse(
        core.zylith_wallet_sign_settlement_output_withdrawal_witness(
          JSON.stringify({
            seed_hex: unlockedSeed,
            expected: {
              batch_id: batchId,
              output_note: outputNote,
              output_note_preimage: note.note,
              output_proof: outputProof,
              strk20_exit_commitment: strk20ExitCommitment,
              auction_verifier_address: auctionVerifierAddress,
              shielded_asset_adapter_address: shieldedAssetAdapterAddress,
              chain_id: chainId,
            },
            witness: prepared.witness,
          })
        )
      );
      const result = await postJson<{ transaction_hash: string }>(
        proverUrl,
        "/api/private/withdrawals/submit",
        { witness: signedWitness },
        {},
        { timeoutMs: STRK20_WITHDRAWAL_SUBMIT_TIMEOUT_MS }
      );
      stagedTransactionHash = result.transaction_hash;
      const latestNote = currentWithdrawalNote();
      latestNote.pending_withdrawal_tx = stagedTransactionHash;
      latestNote.strk20_exit_commitment = strk20ExitCommitment;
      latestNote.withdrawal_requested_at_unix_ms = Date.now();
      await saveNotes();
      await pushRecoverySnapshot(true).catch(() => false);
    }
    const confirmedStagedTransactionHash = requiredString(
      stagedTransactionHash,
      "staged withdrawal transaction"
    );
    await waitForStarknetTransaction(
      confirmedStagedTransactionHash,
      deployment,
      "Zylith STRK20 exit staging"
    ).catch(async (error) => {
      const status = await fetchTransactionReceiptStatus(
        confirmedStagedTransactionHash,
        deployment
      ).catch(() => null);
      if (applyStrk20ExitStagingReceipt(currentWithdrawalNote(), status)) {
        await saveNotes();
        await pushRecoverySnapshot(true).catch(() => false);
      }
      throw error;
    });

    const latestStagedNote = currentWithdrawalNote();
    if (latestStagedNote.pending_strk20_open_note_tx) {
      const pendingClaimTx = latestStagedNote.pending_strk20_open_note_tx;
      const status = await fetchTransactionReceiptStatus(
        pendingClaimTx,
        deployment
      ).catch(() => null);
      if (status?.confirmed && !status.failed) {
        applyStrk20ExitClaimReceipt(currentWithdrawalNote(), status);
        await saveNotes();
        await pushRecoverySnapshot(true).catch(() => false);
        return {
          transaction_hash: pendingClaimTx,
          staged_transaction_hash: confirmedStagedTransactionHash,
          open_note_id: currentWithdrawalNote().strk20_open_note_id,
        };
      }
      if (!status?.failed) {
        throw new Error(
          "STRK20 open-note claim is already pending confirmation."
        );
      }
      applyStrk20ExitClaimReceipt(latestStagedNote, status);
      await saveNotes();
      await pushRecoverySnapshot(true).catch(() => false);
    }

    const sdkRegistry = await loadStarknetPrivacySdkRegistry().catch(
      () => undefined
    );
    const claimResult = await submitPrivacyOpenNoteWithdrawal({
      seedHex: unlockedSeed,
      chainId,
      rpcUrl,
      privacyPoolAddress,
      bridgeAddress,
      tokenAddress,
      discoveryUrl,
      provingUrl,
      provingOhttpEnabled: fundingRail.provingOhttpEnabled,
      paymasterAddress: requiredNonZeroFelt(
        fundingRail.paymasterAddress,
        "privacy_paymaster_address"
      ),
      paymasterUrl: requiredString(
        fundingRail.paymasterUrl,
        "privacy_paymaster_url"
      ),
      privacyProofSignerClassHash: fundingRail.privacyProofSignerClassHash,
      minProvingDelayBlocks:
        fundingRail.minProvingDelayBlocks ??
        DEFAULT_STARKNET_PRIVACY_MIN_PROVING_DELAY_BLOCKS,
      sdkRegistry,
      exitCommitment: strk20ExitCommitment,
      signExitClaim: (openNoteId) =>
        JSON.parse(
          core.zylith_wallet_sign_strk20_exit_claim(
            JSON.stringify({
              seed_hex: unlockedSeed,
              chain_id: chainId,
              bridge_address: bridgeAddress,
              privacy_pool_address: privacyPoolAddress,
              auction_verifier_address: auctionVerifierAddress,
              asset_id: note.note.asset_id,
              token_address: tokenAddress,
              amount: note.note.amount,
              exit_commitment: strk20ExitCommitment,
              open_note_id: openNoteId,
            })
          )
        ) as { signature_r: string; signature_s: string },
    });
    const latestClaimNote = currentWithdrawalNote();
    latestClaimNote.pending_strk20_open_note_tx = claimResult.transactionHash;
    latestClaimNote.strk20_open_note_id = claimResult.openNoteId;
    await saveStarknetPrivacySdkRegistry(claimResult.sdkRegistry);
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    try {
      await waitForStarknetTransaction(
        claimResult.transactionHash,
        deployment,
        "STRK20 open-note withdrawal claim"
      );
    } catch (error) {
      const status = await fetchTransactionReceiptStatus(
        claimResult.transactionHash,
        deployment
      ).catch(() => null);
      if (status?.failed) {
        applyStrk20ExitClaimReceipt(currentWithdrawalNote(), status);
        await saveNotes();
        await pushRecoverySnapshot(true).catch(() => false);
      }
      throw error;
    }
    applyStrk20ExitClaimReceipt(currentWithdrawalNote(), {
      failed: false,
      notFound: false,
      confirmed: true,
    });
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    return {
      transaction_hash: claimResult.transactionHash,
      staged_transaction_hash: confirmedStagedTransactionHash,
      open_note_id: claimResult.openNoteId,
    };
  }

  function getBalances() {
    const balances = new Map<string, { available: bigint; locked: bigint }>();
    for (const record of notes) {
      if (record.spent) continue;
      if (record.source === "deposit" && record.deposit_confirmed !== true)
        continue;
      const asset = record.note.asset_id;
      const current = balances.get(asset) ?? { available: 0n, locked: 0n };
      if (record.locked_by_order || !isSpendableLocalNote(record)) {
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
      .filter(
        (record) =>
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

  function strk20WithdrawalAvailable() {
    return strk20WithdrawalEnabledForDeployment(deploymentConfigCache ?? {});
  }

  function noteConsolidationAvailable() {
    return noteConsolidationEnabledForDeployment(
      deploymentConfigCache ?? {}
    );
  }

  function getWithdrawableNotes() {
    return notes
      .filter(
        (record) =>
          !(record.source === "deposit" && record.deposit_failed === true)
      )
      .map((record) => {
        const retryableStrk20Exit = isRetryableStrk20ExitClaim(record);
        return {
          note_commitment: record.note_commitment,
          batch_id: record.batch_id,
          source: record.source ?? "deposit",
          asset: record.note.asset_id,
          amount: record.note.amount,
          locked: isWithdrawableNoteLocked(record),
          spent: Boolean(record.spent),
          pending_withdrawal_tx: record.pending_withdrawal_tx,
          pending_strk20_open_note_tx: record.pending_strk20_open_note_tx,
          strk20_exit_commitment: record.strk20_exit_commitment,
          strk20_open_note_id: record.strk20_open_note_id,
          metadata_commitment: record.note.metadata_commitment,
          liquidity_provider_attribution: record.liquidity_provider_attribution,
        };
      });
  }

  function getPrivateStrategies(): PrivateStrategySummary[] {
    return strategies.map((strategy) => ({
      id: strategy.id,
      parent_order_commitment: strategy.parent.parent_order_commitment,
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
      renewal_window_children: strategy.renewal_window_children,
      max_children: strategy.max_children,
      next_child_index: strategy.next_child_index,
      start_epoch: strategy.start_epoch,
      end_epoch: strategy.end_epoch,
      offline_package: strategy.offline_package
        ? {
            package_id: strategy.offline_package.package_id,
            package_commitment: strategy.offline_package.package_commitment,
            created_at_unix_ms: strategy.offline_package.created_at_unix_ms,
            start_epoch: strategy.offline_package.start_epoch,
            end_epoch: strategy.offline_package.end_epoch,
            slot_count: strategy.offline_package.slot_count,
            relay_mode: strategy.offline_package.relay_mode,
            parent_cancel_authority:
              strategy.offline_package.parent_cancel_authority,
            relay_authorization: strategy.offline_package.relay_authorization,
            access_token: strategy.offline_package.access_token,
          }
        : undefined,
      parent_cancel_transaction_hash: strategy.parent_cancel_transaction_hash,
      last_error: strategy.last_error,
      submitted_children: strategy.submitted_children.map((child) => ({
        parent_child_index: child.parent_child_index,
        batch_id: child.batch_id,
        epoch_id: child.epoch_id,
        order_commitment: child.order_commitment,
        cancellation_secret: child.cancellation_secret,
        expected_output_metadata_commitment:
          child.expected_output_metadata_commitment,
        funding_note_commitments: child.funding_note_commitments,
        relay_status: child.relay_status,
        relay_detail: child.relay_detail,
        submitted_at_unix_ms: child.submitted_at_unix_ms,
        delegated: child.delegated,
      })),
    }));
  }

  function previewFundingNotes(draft: PrivateOrderDraft): FundingPreview {
    if (draft.mode === "Liquidity Position" || draft.mode === "Resting") {
      throw new Error(
        "Private liquidity must be opened through the private liquidity position lifecycle"
      );
    }
    const selected = selectFundingNotes(draft);
    const required = fundingRequirement(draft);
    const selectedTotal = selected.reduce(
      (total, record) => total + BigInt(record.note.amount),
      0n
    );
    return {
      asset: fundingAssetForDraft(draft),
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

  function authorizePrivateLiquidityPositionLifecycle(
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest,
    signer: (inputJson: string) => string
  ): PrivateLiquidityPositionLifecycleAuthorization {
    const { seedHex: unlockedSeed } = requireUnlocked();
    return JSON.parse(
      signer(
        JSON.stringify({
          seed_hex: unlockedSeed,
          ...request,
        })
      )
    ) as PrivateLiquidityPositionLifecycleAuthorization;
  }

  function authorizePrivateLiquidityPositionOpen(
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest
  ): PrivateLiquidityPositionLifecycleAuthorization {
    return authorizePrivateLiquidityPositionLifecycle(
      request,
      core.zylith_wallet_authorize_liquidity_position_open
    );
  }

  function authorizePrivateLiquidityPositionReconfigure(
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest
  ): PrivateLiquidityPositionLifecycleAuthorization {
    return authorizePrivateLiquidityPositionLifecycle(
      request,
      core.zylith_wallet_authorize_liquidity_position_reconfigure
    );
  }

  function authorizePrivateLiquidityPositionClose(
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest
  ): PrivateLiquidityPositionLifecycleAuthorization {
    return authorizePrivateLiquidityPositionLifecycle(
      request,
      core.zylith_wallet_authorize_liquidity_position_close
    );
  }

  function getPrivateLiquidityPositions() {
    return liquidityPositions.map((position) =>
      normalizeLocalLiquidityPositionRecord(position)
    );
  }

  async function reconfigurePrivateLiquidityPosition(
    request: PrivateLiquidityPositionReconfigureRequest,
    candidateBatch?: BatchSummary
  ): Promise<PrivateLiquidityPositionLifecycleResult> {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (request.kind !== "ReconfigurePrivateLiquidityPosition") {
      throw new Error("Unsupported liquidity position lifecycle request");
    }
    const record = await requireFreshLocalLiquidityPosition(request.positionId);
    const { batch, submissionSafetyBufferMs } =
      await resolveLiquidityPositionLifecycleBatch(record.pair_id, candidateBatch);
    const lifecycleInput = {
      seed_hex: unlockedSeed,
      pair_id: record.pair_id,
      batch_id: batch.batch_id,
      epoch_id: batch.epoch_id.toString(),
      prior_position: record.position,
      price_lower_bound: request.priceLowerBoundAtomic,
      price_upper_bound: request.priceUpperBoundAtomic,
      max_fill_base_per_batch: request.maxFillBasePerBatchAtomic,
      curve_policy: liquidityPositionCurvePolicyForWasm(request.curvePolicy),
      oracle_guard: liquidityPositionOracleGuardForWasm(request.oracleGuard),
      rotation_policy: liquidityPositionRotationPolicyForWasm(
        request.rotationPolicy
      ),
      expiry_epoch: decimalString(
        request.expiryEpoch ?? record.position.expiry_epoch,
        "liquidity position expiry epoch"
      ),
      lifecycle_nonce: randomU64(),
    };
    const prepared = JSON.parse(
      core.zylith_wallet_prepare_private_liquidity_position_reconfigure(
        JSON.stringify(lifecycleInput)
      )
    ) as PrivateLiquidityPositionLifecycleBuild;
    return submitPreparedLiquidityPositionLifecycle({
      batch,
      submissionSafetyBufferMs,
      prepared,
      lifecycleInput,
      stateWitnessKind: "reconfigure",
      builder: core.zylith_wallet_build_private_liquidity_position_reconfigure,
      pendingStatus: "pending_reconfigure",
    });
  }

  async function closePrivateLiquidityPosition(
    request: PrivateLiquidityPositionCloseRequest,
    candidateBatch?: BatchSummary
  ): Promise<PrivateLiquidityPositionLifecycleResult> {
    const { seedHex: unlockedSeed } = requireUnlocked();
    if (request.kind !== "ClosePrivateLiquidityPosition") {
      throw new Error("Unsupported liquidity position lifecycle request");
    }
    const record = await requireFreshLocalLiquidityPosition(request.positionId);
    const { batch, submissionSafetyBufferMs } =
      await resolveLiquidityPositionLifecycleBatch(record.pair_id, candidateBatch);
    const lifecycleInput = {
      seed_hex: unlockedSeed,
      pair_id: record.pair_id,
      batch_id: batch.batch_id,
      epoch_id: batch.epoch_id.toString(),
      prior_position: record.position,
      lifecycle_nonce: randomU64(),
    };
    const prepared = JSON.parse(
      core.zylith_wallet_prepare_private_liquidity_position_close(
        JSON.stringify(lifecycleInput)
      )
    ) as PrivateLiquidityPositionLifecycleBuild;
    return submitPreparedLiquidityPositionLifecycle({
      batch,
      submissionSafetyBufferMs,
      prepared,
      lifecycleInput,
      stateWitnessKind: "close",
      builder: core.zylith_wallet_build_private_liquidity_position_close,
      pendingStatus: "pending_close",
    });
  }

  async function resolveLiquidityPositionLifecycleBatch(
    pairId: string,
    candidateBatch?: BatchSummary
  ) {
    if (!coordinatorUrl || !proverUrl) {
      throw new Error(
        "Coordinator and private ingress URLs are required for liquidity position lifecycle operations"
      );
    }
    const batchWindowMs =
      (await fetchCoordinatorBatchWindowMs()) ??
      coordinatorBatchWindowCache?.value ??
      DEFAULT_LIQUIDITY_POSITION_BATCH_WINDOW_MS;
    const batch =
      candidateBatch ?? (await resolveSubmittablePairBatch(pairId, batchWindowMs));
    if (!batch || batch.status !== "Open") {
      throw new Error("Liquidity position auction window is no longer open");
    }
    if (batch.pair_id !== pairId) {
      throw new Error(
        "Liquidity position batch does not match the stored position pair"
      );
    }
    const submissionSafetyBufferMs = batchSubmissionSafetyBufferMs(batchWindowMs);
    if (
      batch.close_time_unix_ms - Date.now() <=
      submissionSafetyBufferMs
    ) {
      throw new Error(
        "Liquidity position auction window is inside the submission safety buffer"
      );
    }
    return { batch, batchWindowMs, submissionSafetyBufferMs };
  }

  async function submitPreparedLiquidityPositionLifecycle({
    batch,
    submissionSafetyBufferMs,
    prepared,
    lifecycleInput,
    stateWitnessKind,
    builder,
    pendingStatus,
  }: {
    batch: BatchSummary;
    submissionSafetyBufferMs: number;
    prepared: PrivateLiquidityPositionLifecycleBuild;
    lifecycleInput: Record<string, unknown>;
    stateWitnessKind: "reconfigure" | "close";
    builder: (inputJson: string) => string;
    pendingStatus: LocalLiquidityPositionStatus;
  }): Promise<PrivateLiquidityPositionLifecycleResult> {
    const priorLiquidityPositionRoot = await fetchOnchainLiquidityPositionRoot();
    const stateWitness =
      await postJson<LiquidityPositionInsertionWitnessResponse>(
        proverUrl,
        "/api/private/liquidity-positions/state-update-witness",
        {
          kind: stateWitnessKind,
          position_id: prepared.position_id,
          prior_commitment: prepared.prior_position_commitment,
          output_commitment: prepared.output_position_commitment,
          prior_liquidity_position_root: priorLiquidityPositionRoot,
          padding: randomPadding(2048),
        }
      );
    const witnessedPriorRoot = normalizeFeltForComparison(
      stateWitness.prior_liquidity_position_root
    );
    if (witnessedPriorRoot !== priorLiquidityPositionRoot) {
      throw new Error(
        "Liquidity position state witness was built against a stale root"
      );
    }
    const built = JSON.parse(
      builder(
        JSON.stringify({
          ...lifecycleInput,
          prior_liquidity_position_root: priorLiquidityPositionRoot,
          state_update: stateWitness.state_update,
          padding: randomPadding(2048),
        })
      )
    ) as PrivateLiquidityPositionLifecycleBuild;
    const telemetryStart = performance.now();
    const buildCompletedAt = telemetryStart;
    let privateIngressStarted = false;
    let coordinatorSubmissionStarted = false;
    try {
      const submissionDelayMs = privateSubmissionDelayMs(
        batch.close_time_unix_ms,
        submissionSafetyBufferMs
      );
      await delay(submissionDelayMs);
      if (
        batch.close_time_unix_ms - Date.now() <=
        submissionSafetyBufferMs
      ) {
        throw new Error(
          "Liquidity position auction window entered the submission safety buffer before private ingress submission"
        );
      }
      const beforePrivateIngress = performance.now();
      const ingressTelemetry: OrderIngressTelemetry = {
        version: 1,
        client_build_ms: elapsedMs(telemetryStart, buildCompletedAt),
        private_submission_delay_ms: submissionDelayMs,
        client_elapsed_before_private_ingress_ms: elapsedMs(
          telemetryStart,
          beforePrivateIngress
        ),
        batch_time_remaining_before_private_ingress_ms:
          remainingBatchMs(batch.close_time_unix_ms),
        submission_safety_buffer_ms: submissionSafetyBufferMs,
      };
      privateIngressStarted = true;
      const ingress = await postJson<IngressResponse>(
        proverUrl,
        "/api/private/liquidity-positions/lifecycle",
        attachOrderIngressTelemetry(built.ingress_request, ingressTelemetry)
      );
      const afterPrivateIngress = performance.now();
      const coordinatorTelemetry: OrderIngressTelemetry = {
        ...ingressTelemetry,
        private_ingress_roundtrip_ms: elapsedMs(
          beforePrivateIngress,
          afterPrivateIngress
        ),
        client_elapsed_before_coordinator_ms: elapsedMs(
          telemetryStart,
          afterPrivateIngress
        ),
        batch_time_remaining_before_coordinator_ms:
          remainingBatchMs(batch.close_time_unix_ms),
      };
      coordinatorSubmissionStarted = true;
      const accepted = await postJson<LiquidityPositionLifecycleAccepted>(
        coordinatorUrl,
        "/api/liquidity-positions/lifecycle",
        attachOrderIngressTelemetry(
          ingress.coordinator_submission,
          coordinatorTelemetry
        )
      );
      updateLocalLiquidityPositionAfterLifecycle(
        built,
        pendingStatus,
        accepted.lifecycle_id ?? built.lifecycle_id,
        accepted.transition_commitment ?? built.transition_commitment,
        accepted.batch_id ?? batch.batch_id,
        batch.epoch_id
      );
      await saveLiquidityPositions();
      scheduleRecoverySnapshot(true);
      return liquidityPositionLifecycleResultFromBuild(
        built,
        batch,
        accepted.lifecycle_id,
        accepted.transition_commitment
      );
    } catch (error) {
      if (
        isAmbiguousPrivateLiquidityPositionSubmissionError(
          error,
          coordinatorSubmissionStarted
            ? "coordinator_submission"
            : privateIngressStarted
              ? "private_ingress"
              : "pre_ingress"
        )
      ) {
        updateLocalLiquidityPositionAfterLifecycle(
          built,
          pendingStatus,
          built.lifecycle_id,
          built.transition_commitment,
          batch.batch_id,
          batch.epoch_id
        );
        await saveLiquidityPositions();
        await pushRecoverySnapshot(true).catch(() => false);
        return {
          ...liquidityPositionLifecycleResultFromBuild(built, batch),
          submission_ambiguous: true,
        };
      }
      throw error;
    }
  }

  function requireLocalLiquidityPosition(positionId: string) {
    const normalized = normalizeFeltForComparison(positionId);
    if (!normalized) throw new Error("Liquidity position id is invalid");
    const record = liquidityPositions.find(
      (position) => position.id === normalized
    );
    if (!record || record.status === "closed") {
      throw new Error("Private liquidity position is not available locally");
    }
    if (record.status === "pending_close") {
      throw new Error("Private liquidity position close is already pending");
    }
    return normalizeLocalLiquidityPositionRecord(record);
  }

  async function requireFreshLocalLiquidityPosition(positionId: string) {
    const record = requireLocalLiquidityPosition(positionId);
    if (!proverUrl) return record;
    if (isPendingLiquidityPositionStatus(record.status)) return record;
    return refreshLocalLiquidityPositionState(record);
  }

  async function refreshLocalLiquidityPositionState(
    record: LocalLiquidityPositionRecord
  ) {
    const ownerAuthority =
      typeof record.position.owner_authority === "string"
        ? normalizeFeltForComparison(record.position.owner_authority)
        : "";
    if (!ownerAuthority) return record;
    const priorLiquidityPositionRoot = await fetchOnchainLiquidityPositionRoot();
    const response = await postJson<LiquidityPositionStateResponse>(
      proverUrl,
      "/api/private/liquidity-positions/state",
      {
        position_id: record.id,
        owner_authority: ownerAuthority,
        prior_liquidity_position_root: priorLiquidityPositionRoot,
        padding: randomPadding(2048),
      }
    );
    const witnessedPriorRoot = normalizeFeltForComparison(
      response.prior_liquidity_position_root
    );
    if (witnessedPriorRoot !== priorLiquidityPositionRoot) {
      throw new Error("Liquidity position state was built against a stale root");
    }
    const positionCommitment = normalizeCommitmentLike(
      response.position_commitment
    );
    const position = normalizeProtocolPrivateLiquidityPosition(response.position);
    const normalized = normalizeLocalLiquidityPositionRecord({
      ...record,
      id: protocolLiquidityPositionId(position),
      position,
      position_commitment: positionCommitment,
      pair_id: protocolLiquidityPairId(position),
      status: "active",
      updated_at_unix_ms: Date.now(),
    });
    const index = liquidityPositions.findIndex(
      (existing) => existing.id === normalized.id
    );
    if (index !== -1 && JSON.stringify(liquidityPositions[index]) !== JSON.stringify(normalized)) {
      liquidityPositions[index] = normalized;
      await saveLiquidityPositions();
      scheduleRecoverySnapshot(false);
    }
    return normalized;
  }

  function applyLiquidityProviderAttributionArtifacts(
    report: PrivateSettlementReport,
    unlockedSeed: string
  ) {
    let changed = false;
    for (const artifact of report.liquidity_provider_attribution_artifacts ?? []) {
      let attribution: LiquidityAttributionPlaintext;
      try {
        attribution = normalizeLiquidityAttributionPlaintext(
          JSON.parse(
            core.zylith_wallet_decrypt_liquidity_attribution_artifact(
              unlockedSeed,
              JSON.stringify(artifact)
            )
          )
        );
      } catch {
        continue;
      }
      if (attribution.batch_id !== report.batch_id) continue;
      const priorCommitment = normalizeCommitmentLike(
        attribution.attribution.funding_note_ref
      );
      const outputCommitment = normalizeCommitmentLike(
        attribution.output_note_commitment
      );
      const transitionCommitment = normalizeFeltForComparison(
        attribution.attribution.order_commitment
      );
      if (!priorCommitment || !outputCommitment || !transitionCommitment) {
        continue;
      }
      for (let index = 0; index < liquidityPositions.length; index += 1) {
        const position = liquidityPositions[index];
        if (position.status === "closed" || position.pair_id !== attribution.pair_id) {
          continue;
        }
        const knownCommitments = new Set(
          [
            normalizeFeltForComparison(position.position_commitment),
            ...((position.fill_attributions ?? []).flatMap((entry) => [
              normalizeCommitmentLike(entry.attribution.funding_note_ref),
              normalizeCommitmentLike(entry.output_note_commitment),
            ])),
          ].filter((commitment): commitment is string => Boolean(commitment))
        );
        if (
          !knownCommitments.has(priorCommitment) &&
          !knownCommitments.has(outputCommitment)
        ) {
          continue;
        }
        const existing = position.fill_attributions ?? [];
        if (
          existing.some(
            (entry) =>
              entry.batch_id === attribution.batch_id &&
              normalizeFeltForComparison(entry.attribution.order_commitment) ===
                transitionCommitment
          )
        ) {
          continue;
        }
        liquidityPositions[index] = normalizeLocalLiquidityPositionRecord({
          ...position,
          fill_attributions: [...existing, attribution].slice(-512),
          updated_at_unix_ms: report.settled_at_unix_ms,
        });
        changed = true;
      }
    }
    return changed;
  }

  function applyLiquidityPositionLifecycleReports(
    report: PrivateSettlementReport
  ) {
    let changed = false;
    for (const lifecycle of report.liquidity_position_lifecycle_reports ?? []) {
      const transitionCommitment = normalizeFeltForComparison(
        lifecycle.transition_commitment
      );
      if (!transitionCommitment) continue;
      const outputCommitment = normalizeCommitmentLike(
        lifecycle.output_position_commitment
      );
      for (let index = 0; index < liquidityPositions.length; index += 1) {
        const position = liquidityPositions[index];
        if (!isPendingLiquidityPositionStatus(position.status)) continue;
        if (
          normalizeText(position.last_batch_id) !== report.batch_id ||
          normalizeFeltForComparison(position.last_transition_commitment) !==
            transitionCommitment
        ) {
          continue;
        }
        if (position.status === "pending_close") {
          if (lifecycle.kind !== "Close" || outputCommitment) continue;
          liquidityPositions[index] = {
            ...position,
            status: "closed",
            updated_at_unix_ms: report.settled_at_unix_ms,
          };
          changed = true;
          continue;
        }
        if (lifecycle.kind === "Close") continue;
        if (
          outputCommitment &&
          outputCommitment !==
            normalizeFeltForComparison(position.position_commitment)
        ) {
          continue;
        }
        liquidityPositions[index] = {
          ...position,
          status: "active",
          updated_at_unix_ms: report.settled_at_unix_ms,
        };
        changed = true;
      }
    }
    return changed;
  }

  function storeLocalLiquidityPosition({
    position,
    positionCommitment,
    status,
    lifecycleId,
    transitionCommitment,
    batchId,
    epochId,
  }: {
    position?: ProtocolPrivateLiquidityPosition;
    positionCommitment: string;
    status: LocalLiquidityPositionStatus;
    lifecycleId: string;
    transitionCommitment: string;
    batchId?: string;
    epochId?: number;
  }) {
    if (!position) {
      throw new Error("Liquidity position build did not return a position");
    }
    const normalized = normalizeLocalLiquidityPositionRecord({
      id: protocolLiquidityPositionId(position),
      position,
      position_commitment: positionCommitment,
      pair_id: protocolLiquidityPairId(position),
      status,
      deployment_scope: deploymentScope,
      last_lifecycle_id: lifecycleId,
      last_transition_commitment: transitionCommitment,
      last_batch_id: batchId,
      last_epoch_id: epochId,
      opened_at_unix_ms: Date.now(),
      updated_at_unix_ms: Date.now(),
    });
    const index = liquidityPositions.findIndex(
      (existing) => existing.id === normalized.id
    );
    if (index === -1) {
      liquidityPositions.push(normalized);
    } else {
      liquidityPositions[index] = {
        ...liquidityPositions[index],
        ...normalized,
        opened_at_unix_ms:
          liquidityPositions[index].opened_at_unix_ms ??
          normalized.opened_at_unix_ms,
      };
    }
  }

  function updateLocalLiquidityPositionAfterLifecycle(
    built: PrivateLiquidityPositionLifecycleBuild,
    status: LocalLiquidityPositionStatus,
    lifecycleId: string,
    transitionCommitment: string,
    batchId?: string,
    epochId?: number
  ) {
    const existing = requireLocalLiquidityPosition(built.position_id);
    const nextPosition = built.output_position ?? existing.position;
    const nextCommitment =
      built.output_position_commitment ?? existing.position_commitment;
    storeLocalLiquidityPosition({
      position: nextPosition,
      positionCommitment: nextCommitment,
      status,
      lifecycleId,
      transitionCommitment,
      batchId,
      epochId,
    });
  }

  function liquidityPositionLifecycleResultFromBuild(
    built: PrivateLiquidityPositionLifecycleBuild,
    batch: BatchSummary,
    acceptedLifecycleId?: string,
    acceptedTransitionCommitment?: string
  ): PrivateLiquidityPositionLifecycleResult {
    return {
      lifecycle_id: acceptedLifecycleId ?? built.lifecycle_id,
      position_id: built.position_id,
      prior_position_commitment: built.prior_position_commitment,
      output_position_commitment: built.output_position_commitment,
      transition_commitment:
        acceptedTransitionCommitment ?? built.transition_commitment,
      output_notes: built.output_notes,
      batch_id: batch.batch_id,
      epoch_id: batch.epoch_id,
    };
  }

  function liquidityPositionCurvePolicyForWasm(
    policy: PrivateLiquidityPositionOpenRequest["curvePolicy"]
  ) {
    return {
      kind: policy.kind,
      band_count: policy.bandCount.toString(),
      spread_bps: policy.spreadBps.toString(),
      target_base_ratio_bps: policy.targetBaseRatioBps.toString(),
      inventory_skew_bps: policy.inventorySkewBps.toString(),
      max_price_deviation_bps: policy.maxPriceDeviationBps.toString(),
    };
  }

  function liquidityPositionRotationPolicyForWasm(
    policy: PrivateLiquidityPositionOpenRequest["rotationPolicy"]
  ) {
    return {
      max_price_rotation_bps: policy.maxPriceRotationBps.toString(),
      max_depth_rotation_bps: policy.maxDepthRotationBps.toString(),
      skip_epoch_bps: policy.skipEpochBps.toString(),
    };
  }

  function liquidityPositionOracleGuardForWasm(
    guard: PrivateLiquidityPositionOpenRequest["oracleGuard"] | undefined
  ) {
    return guard
      ? {
          oracle_id: guard.oracleId,
          max_staleness_ms: guard.maxStalenessMs.toString(),
          max_divergence_bps: guard.maxDivergenceBps.toString(),
        }
      : undefined;
  }

  return {
    hasVault,
    vaultAuthMode,
    isReady: () => Boolean(seedHex && publicConfig),
    createWalletWithWalletSignature,
    unlockWithWalletSignature,
    syncRecoveryArtifacts,
    getPublicConfig: () => publicConfig,
    lock,
    getBalances,
    getPendingDeposits,
    getWithdrawableNotes,
    getPrivateStrategies,
    strk20WithdrawalAvailable,
    noteConsolidationAvailable,
    loadLocalOrders,
    saveLocalOrders,
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
    markPrivateStrategyRelayRegistered,
    cancelPrivateStrategy,
    discardPreparedPrivateStrategy,
    pausePrivateStrategy,
    resumePrivateStrategy,
    refreshPrivateStrategyPackage,
    verifyOfflineRenewalPackage,
    recordOfflineRenewalRelayResults,
    settlePrivateOrderLock,
    createOfflineRenewalPackage,
    openPrivateLiquidityPosition,
    reconfigurePrivateLiquidityPosition,
    closePrivateLiquidityPosition,
    getPrivateLiquidityPositions,
    authorizePrivateLiquidityPositionOpen,
    authorizePrivateLiquidityPositionReconfigure,
    authorizePrivateLiquidityPositionClose,
    getOfflineRenewalPackages: () =>
      strategies
        .filter((strategy) => strategy.status === "delegated")
        .map((strategy) => strategy.offline_package)
        .filter((offlinePackage): offlinePackage is OfflineRenewalPackage =>
          Boolean(offlinePackage)
        ),
    submitStrk20Withdrawal,
  };

  async function fetchIngressRegistry() {
    if (ingressRegistryCache) return ingressRegistryCache;
    let registry: unknown | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      registry = await fetchJson<unknown>(
        proverUrl,
        "/api/public/auction-keys",
        {},
        { timeoutMs: 20_000 }
      );
      if (registry) break;
      await delay(250 * (attempt + 1));
    }
    if (!registry) {
      throw new Error("Private ingress key registry is unavailable");
    }
    const expectedFingerprint = await ingressRegistryFingerprintPin();
    if (!expectedFingerprint && !import.meta.env.DEV) {
      throw new Error("Private ingress key registry pin is not configured");
    }
    if (expectedFingerprint) {
      let fingerprint: { fingerprint?: string } | null = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        fingerprint = await fetchJson<{ fingerprint?: string }>(
          proverUrl,
          "/api/public/auction-keys/fingerprint",
          {},
          { timeoutMs: 20_000 }
        );
        if (fingerprint) break;
        await delay(250 * (attempt + 1));
      }
      if (fingerprint?.fingerprint !== expectedFingerprint) {
        throw new Error("Private ingress key registry pin mismatch");
      }
    }
    ingressRegistryCache = registry;
    return registry;
  }

  async function ingressRegistryFingerprintPin() {
    if (ingressKeyPin) return ingressKeyPin;
    const deployment = await loadDeploymentConfig();
    return normalizeText(
      deployment.funding?.starknet_privacy?.ingress_key_registry_fingerprint
    );
  }

  async function fetchVisibleArtifacts() {
    const latestEpoch = await fetchLatestEpoch();
    if (latestEpoch === null) {
      return {
        batches: [],
        stable_cursor: scanState.artifact_epoch_cursor,
        cursor_artifact_ids: [] as string[],
      };
    }
    const stableEnd =
      latestEpoch >= scanEpochLookback ? latestEpoch - scanEpochLookback : -1;
    const cursor = Math.max(
      0,
      Math.min(scanState.artifact_epoch_cursor, latestEpoch + 1)
    );
    const ranges: Array<{
      start: number;
      end: number;
      advancesCursor: boolean;
    }> = [];
    if (stableEnd >= cursor) {
      ranges.push({
        start: cursor,
        end: Math.min(stableEnd, cursor + scanEpochBackfillStep - 1),
        advancesCursor: true,
      });
    }
    ranges.push({
      start: Math.max(0, latestEpoch - scanEpochLookback + 1),
      end: latestEpoch,
      advancesCursor: false,
    });

    const batchesById = new Map<
      string,
      PublishedBatchArtifactList["batches"][number]
    >();
    let stableCursor = scanState.artifact_epoch_cursor;
    const cursorArtifactIds: string[] = [];
    for (const range of ranges) {
      if (range.end < range.start) continue;
      const artifactList = await fetchJson<PublishedBatchArtifactList>(
        indexerUrl,
        `/api/batches/artifacts/epochs/${range.start}/${range.end}`
      );
      const completeThroughRaw = artifactList?.complete_through_epoch;
      const completeThrough =
        completeThroughRaw === null || completeThroughRaw === undefined
          ? null
          : Number(completeThroughRaw);
      for (const batch of artifactList?.batches ?? []) {
        if (batch?.batch_id) batchesById.set(batch.batch_id, batch);
        if (
          range.advancesCursor &&
          completeThrough !== null &&
          Number.isFinite(completeThrough) &&
          Number(batch.batch_epoch) <= completeThrough &&
          batch?.batch_id &&
          batch.settled_at_unix_ms &&
          batch.output_note_root
        ) {
          cursorArtifactIds.push(batch.batch_id);
        }
      }
      if (
        range.advancesCursor &&
        completeThrough !== null &&
        Number.isFinite(completeThrough) &&
        completeThrough >= range.start
      ) {
        stableCursor = Math.max(
          stableCursor,
          Math.min(range.end, completeThrough) + 1
        );
      }
    }
    return {
      batches: [...batchesById.values()],
      stable_cursor: stableCursor,
      cursor_artifact_ids: cursorArtifactIds,
    };
  }

  async function fetchAllVisibleArtifacts() {
    if (!indexerUrl) return [];
    const artifactList = await fetchJson<PublishedBatchArtifactList>(
      indexerUrl,
      "/api/batches/artifacts"
    );
    return artifactList?.batches ?? [];
  }

  async function pruneUnsettledSettlementOutputs() {
    if (notes.length === 0) return false;
    const pendingSettlementBatchIds = uniqueStrings(
      notes
        .filter(
          (record) => record.source === "settlement_output" && record.batch_id
        )
        .map((record) => record.batch_id)
    );
    if (pendingSettlementBatchIds.length === 0) return false;
    const syncedBatchIds = new Set(scanState.private_report_batch_ids);
    const removableBatchIds = new Set<string>();
    await Promise.all(
      pendingSettlementBatchIds.map(async (batchId) => {
        if (syncedBatchIds.has(batchId)) return;
        const status = await fetchJson<ProofJobStatus>(
          proverUrl,
          `/api/public/proof-jobs/${encodeURIComponent(batchId)}`
        ).catch(() => null);
        if (!status?.failure) return;
        removableBatchIds.add(batchId);
      })
    );
    if (removableBatchIds.size === 0) return false;
    const nextNotes = notes.filter(
      (record) =>
        record.source !== "settlement_output" ||
        !record.batch_id ||
        !removableBatchIds.has(record.batch_id)
    );
    if (nextNotes.length === notes.length) return false;
    notes = nextNotes;
    await saveNotes();
    await pushRecoverySnapshot(true).catch(() => false);
    return true;
  }

  async function fetchLatestEpoch() {
    const now = Date.now();
    if (latestEpochCache && latestEpochCache.expiresAt > now) {
      return latestEpochCache.value;
    }
    const listedBatches = await fetchJson<unknown>(
      coordinatorUrl,
      "/api/batches"
    ).catch(() => null);
    if (Array.isArray(listedBatches) && listedBatches.length > 0) {
      const epochs = listedBatches
        .map((batch) => {
          try {
            return assertBatchSummary(batch, "Coordinator batch").epoch_id;
          } catch {
            return null;
          }
        })
        .filter((epoch): epoch is number => typeof epoch === "number");
      const value = epochs.length > 0 ? Math.max(...epochs) : null;
      latestEpochCache = { value, expiresAt: now + LATEST_EPOCH_CACHE_TTL_MS };
      return value;
    }
    const pairIds = await enabledPairIds();
    const batches = (
      await Promise.allSettled(pairIds.map(fetchSubmittablePairBatch))
    )
      .filter(
        (entry): entry is PromiseFulfilledResult<BatchSummary> =>
          entry.status === "fulfilled"
      )
      .map((entry) => entry.value);
    const epochs = batches
      .map((batch) => batch?.epoch_id)
      .filter((epoch): epoch is number => typeof epoch === "number");
    const value = epochs.length > 0 ? Math.max(...epochs) : null;
    latestEpochCache = { value, expiresAt: now + LATEST_EPOCH_CACHE_TTL_MS };
    return value;
  }

  async function withCoordinatorBatchWindow(
    draft: PrivateOrderDraft
  ): Promise<PrivateOrderDraft> {
    const parsed = Number(draft.batchWindowMs);
    if (Number.isFinite(parsed) && parsed > 0) return draft;
    const batchWindowMs = await fetchCoordinatorBatchWindowMs();
    return batchWindowMs ? { ...draft, batchWindowMs } : draft;
  }

  async function fetchCoordinatorBatchWindowMs() {
    const now = Date.now();
    if (
      coordinatorBatchWindowCache &&
      coordinatorBatchWindowCache.expiresAt > now
    ) {
      return coordinatorBatchWindowCache.value;
    }
    const status = await fetchJson<{ batch_window_ms?: number }>(
      coordinatorUrl,
      "/health"
    ).catch(() => null);
    const parsed = Number(status?.batch_window_ms);
    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    coordinatorBatchWindowCache = {
      value,
      expiresAt: now + LATEST_EPOCH_CACHE_TTL_MS,
    };
    return value;
  }

  async function fetchSubmittablePairBatch(pair: string) {
    const [base, quote] = pair.split("/");
    const path = `/api/pairs/${encodeURIComponent(base)}/${encodeURIComponent(
      quote
    )}/batches/submittable`;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${coordinatorUrl.replace(/\/+$/, "")}${path}`,
        { headers: { accept: "application/json" } },
        REQUIRED_COORDINATOR_FETCH_TIMEOUT_MS
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : "";
      if (
        /runtime request timed out|signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted|failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
          message
        )
      ) {
        throw new Error("Network request failed. Check your connection and retry.");
      }
      throw error;
    }
    if (!response.ok) {
      throw new RuntimeHttpStatusError(path, response.status, "");
    }
    const batch = await response.json();
    return assertBatchSummary(batch, "Coordinator submittable batch");
  }

  async function fetchBatchById(batchId: string) {
    const path = `/api/batches/${encodeURIComponent(batchId)}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${coordinatorUrl.replace(/\/+$/, "")}${path}`,
        { headers: { accept: "application/json" } },
        REQUIRED_COORDINATOR_FETCH_TIMEOUT_MS
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : "";
      if (
        /runtime request timed out|signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted|failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
          message
        )
      ) {
        throw new Error("Network request failed. Check your connection and retry.");
      }
      throw error;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new RuntimeHttpStatusError(path, response.status, "");
    }
    return assertBatchSummary(
      await response.json(),
      "Coordinator explicit batch"
    );
  }

  async function resolveExplicitPairBatch(draft: PrivateOrderDraft) {
    const batchId = draft.batchId?.trim();
    if (!batchId) throw new Error("Explicit auction batch ID is required");
    const submissionSafetyBufferMs = batchSubmissionSafetyBufferMs(
      draft.batchWindowMs
    );
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const batch = await fetchBatchById(batchId).catch((error) => {
        lastError = error;
        return null;
      });
      if (!batch) {
        await delay(1_000);
        continue;
      }
      if (batch.pair_id !== draft.pair) {
        throw new Error("Explicit auction batch does not match the order pair");
      }
      if (batch.status !== "Open") {
        throw new Error("Explicit auction batch is no longer open");
      }
      if (
        batch.close_time_unix_ms - Date.now() <=
        submissionSafetyBufferMs
      ) {
        throw new Error("Explicit auction batch is inside the submission safety buffer");
      }
      return batch;
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error("Explicit auction batch is not available for submission");
  }

  async function resolveSubmittablePairBatch(
    pair: string,
    batchWindowMs?: number
  ) {
    let lastBatch: BatchSummary | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const batch = await fetchSubmittablePairBatch(pair).catch((error) => {
        lastError = error;
        return null;
      });
      if (batch) lastBatch = batch;
      if (isSubmittableBatch(batch, batchWindowMs)) return batch;
      await delay(250 * (attempt + 1));
    }
    if (lastBatch) return null;
    if (lastError instanceof Error) throw lastError;
    return null;
  }

  function isSubmittableBatch(
    batch: BatchSummary | null | undefined,
    batchWindowMs?: number
  ) {
    return Boolean(
      batch &&
        batch.status === "Open" &&
        hasBatchSubmissionSafetyWindow(
          batch.close_time_unix_ms,
          Date.now(),
          batchWindowMs
        )
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
    return fetchJson<unknown>(
      indexerUrl,
      `/api/batches/${batchId}/output-bundle`
    );
  }

  async function verifyArtifactOutputRoot(
    artifact: PublishedBatchArtifactList["batches"][number]
  ): Promise<boolean> {
    const artifactRoot = normalizeFeltForComparison(artifact.output_note_root);
    if (!artifactRoot) return false;
    const chainRoot = await fetchOnchainOutputNoteRoot(artifact.batch_id).catch(
      () => null
    );
    return Boolean(chainRoot && chainRoot === artifactRoot);
  }

  async function fetchOnchainOutputNoteRoot(
    batchIdText: string
  ): Promise<string | null> {
    const deployment = await loadDeploymentConfig();
    const rpcUrl = normalizeUrl(deployment.rpc_url);
    const verifier = normalizeText(deployment.contracts?.auction_verifier);
    const batchId = await encodeStarknetFelt(
      batchIdText.startsWith("consolidation-")
        ? "note-consolidation-id"
        : "batch-id",
      batchIdText
    );
    if (!rpcUrl || !verifier || !batchId) return null;
    const response = await starknetRpc<{ result?: string[]; error?: unknown }>(
      rpcUrl,
      "starknet_call",
      {
        request: {
          contract_address: verifier,
          entry_point_selector:
            starknetHash.getSelectorFromName("output_note_root"),
          calldata: [batchId],
        },
        block_id: "pre_confirmed",
      }
    );
    return normalizeFeltForComparison(response.result?.[0]) || null;
  }

  async function fetchOnchainLiquidityPositionRoot(): Promise<string> {
    const deployment = await loadDeploymentConfig();
    const rpcUrl = normalizeUrl(deployment.rpc_url);
    const verifier = normalizeText(deployment.contracts?.auction_verifier);
    if (!rpcUrl || !verifier) {
      throw new Error(
        "Deployment manifest is missing the RPC URL or auction verifier"
      );
    }
    const response = await starknetRpc<{ result?: string[]; error?: unknown }>(
      rpcUrl,
      "starknet_call",
      {
        request: {
          contract_address: verifier,
          entry_point_selector:
            starknetHash.getSelectorFromName("current_liquidity_position_root"),
          calldata: [],
        },
        block_id: "pre_confirmed",
      }
    );
    return normalizeFeltForComparison(response.result?.[0]) || "0x0";
  }

  async function pullRecoverySnapshots() {
    const { seedHex: unlockedSeed, publicConfig: unlockedConfig } =
      requireUnlocked();
    const list = await fetchJson<RecoveryArtifactList>(
      coordinatorUrl,
      `/api/recovery/${encodeURIComponent(
        unlockedConfig.account_id
      )}/artifacts`,
      recoveryHeaders(unlockedSeed)
    );
    if (!list?.artifacts?.length) return false;
    const artifacts = [...list.artifacts].sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.created_at_unix_ms - right.created_at_unix_ms
    );
    const snapshots = artifacts.filter(
      (artifact) =>
        artifact.kind === "Snapshot" &&
        artifact.account_id === unlockedConfig.account_id
    );
    const latest = snapshots[snapshots.length - 1];
    if (!latest) return false;

    const payload = JSON.parse(
      core.zylith_wallet_decrypt_recovery_artifact(
        unlockedSeed,
        JSON.stringify(latest)
      )
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
    if (Array.isArray(payload.liquidity_positions)) {
      for (const remotePosition of payload.liquidity_positions) {
        changed = mergeRecoveredLiquidityPosition(remotePosition) || changed;
      }
      if (changed) await saveLiquidityPositions();
    }
    if (Array.isArray(payload.orders)) {
      const localOrders = await loadLocalOrders();
      const byCommitment = new Map(
        localOrders.map((order) => [
          normalizeFeltForComparison(order.orderCommitment),
          order,
        ])
      );
      for (const remoteOrder of payload.orders) {
        if (remoteOrder.deployment_scope !== deploymentScope) continue;
        const key = normalizeFeltForComparison(remoteOrder.orderCommitment);
        if (!key) continue;
        const existing = byCommitment.get(key);
        if (
          !existing ||
          (remoteOrder.submittedAt ?? 0) > (existing.submittedAt ?? 0)
        ) {
          byCommitment.set(key, remoteOrder);
          changed = true;
        }
      }
      if (changed) await saveLocalOrders([...byCommitment.values()]);
    }
    return changed;
  }

  async function pushRecoverySnapshot(force: boolean) {
    if (!coordinatorUrl || !seedHex || !publicConfig) return false;
    const now = Date.now();
    if (
      !force &&
      now - lastRecoverySnapshotAtUnixMs < RECOVERY_SNAPSHOT_MIN_INTERVAL_MS
    ) {
      return false;
    }
    const payload: RecoverySnapshotPayload = {
      version: 1,
      notes,
      strategies: recoverySnapshotStrategies(),
      liquidity_positions: recoverySnapshotLiquidityPositions(),
      orders: await loadLocalOrders(),
      created_at_unix_ms: now,
    };
    const artifact = JSON.parse(
      core.zylith_wallet_create_recovery_snapshot(
        JSON.stringify({
          seed_hex: seedHex,
          sequence: now,
          created_at_unix_ms: now,
          payload_json: JSON.stringify(payload),
        })
      )
    ) as RecoveryArtifact;
    await postJson(
      coordinatorUrl,
      `/api/recovery/${encodeURIComponent(publicConfig.account_id)}/artifacts`,
      { artifact },
      recoveryHeaders(seedHex)
    );
    lastRecoverySnapshotAtUnixMs = now;
    return true;
  }

  function recoverySnapshotStrategies(): PrivateStrategyRecord[] {
    return strategies.map((strategy) => {
      if (!strategy.offline_package?.slots?.length) return strategy;
      if (strategy.offline_package.relay_mode === "SelfRelay") return strategy;
      return {
        ...strategy,
        offline_package: {
          ...strategy.offline_package,
          slots: strategy.offline_package.slots.map((slot) => ({
            ...slot,
            ingress_request: undefined,
          })),
        },
      };
    });
  }

  function recoverySnapshotLiquidityPositions(): LocalLiquidityPositionRecord[] {
    return liquidityPositions.map((position) =>
      normalizeLocalLiquidityPositionRecord({
        ...position,
        deployment_scope: deploymentScope,
      })
    );
  }

  function scheduleRecoverySnapshot(force: boolean) {
    void pushRecoverySnapshot(force).catch(() => undefined);
  }

  function recoveryHeaders(unlockedSeed: string) {
    return {
      "x-zylith-recovery-auth":
        core.zylith_wallet_recovery_auth_tag(unlockedSeed),
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
        if (
          note !== rawNote ||
          note.note_commitment !== rawNote.note_commitment
        )
          changed = true;
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
    const remoteCommitment = normalizeFeltForComparison(
      normalizedRemoteNote.note_commitment
    );
    const existing = notes.find(
      (note) =>
        normalizeFeltForComparison(note.note_commitment) === remoteCommitment
    );
    if (!existing) {
      const staleUnsubmittedDepositPlan =
        normalizedRemoteNote.source === "deposit" &&
        normalizedRemoteNote.deposit_confirmed !== true &&
        !normalizedRemoteNote.pending_deposit_tx &&
        Date.now() -
          (normalizedRemoteNote.deposit_requested_at_unix_ms ?? 0) >=
          PENDING_DEPOSIT_FAILURE_GRACE_MS;
      if (staleUnsubmittedDepositPlan) return false;
      notes.push(normalizedRemoteNote);
      return true;
    }
    return mergeLocalNoteRecord(existing, normalizedRemoteNote);
  }

  function mergeRecoveredStrategy(remoteStrategy: PrivateStrategyRecord) {
    if (!remoteStrategy?.id) return false;
    if (remoteStrategy.deployment_scope !== deploymentScope) return false;
    const index = strategies.findIndex(
      (strategy) => strategy.id === remoteStrategy.id
    );
    if (index === -1) {
      strategies.push(remoteStrategy);
      return true;
    }
    const local = strategies[index];
    if (
      (remoteStrategy.updated_at_unix_ms ?? 0) > (local.updated_at_unix_ms ?? 0)
    ) {
      strategies[index] = remoteStrategy;
      return true;
    }
    return false;
  }

  function mergeRecoveredLiquidityPosition(remotePosition: unknown) {
    const position = normalizeLocalLiquidityPositionRecord(remotePosition);
    if (!position.id || position.deployment_scope !== deploymentScope)
      return false;
    const index = liquidityPositions.findIndex(
      (existing) => existing.id === position.id
    );
    if (index === -1) {
      liquidityPositions.push(position);
      return true;
    }
    const local = liquidityPositions[index];
    if ((position.updated_at_unix_ms ?? 0) > (local.updated_at_unix_ms ?? 0)) {
      liquidityPositions[index] = position;
      return true;
    }
    return false;
  }

  async function loadDeploymentConfig() {
    if (deploymentConfigCache) return deploymentConfigCache;
    try {
      const deployment = await requestDeploymentConfig();
      deploymentConfigCache = deployment;
      return deployment;
    } catch (error) {
      if (deploymentConfigCache) return deploymentConfigCache;
      throw error instanceof Error
        ? error
        : new Error("Deployment manifest is unavailable");
    }
  }

  async function resolveDeploymentScope() {
    const deployment = await loadDeploymentConfig();
    const chainId = requiredString(deployment.chain_id, "chain_id");
    const verifier = requiredNonZeroFelt(
      deployment.contracts?.auction_verifier,
      "auction_verifier_address"
    );
    const fundingRail = selectedDepositFundingRail(deployment);
    const privacyBridge = requiredNonZeroFelt(
      fundingRail.bridgeAdapter,
      "privacy_deposit_bridge_address"
    );
    const shieldedAssetAdapter = requiredNonZeroFelt(
      fundingRail.shieldedAssetAdapter,
      "shielded_asset_adapter_address"
    );
    return `${chainId}:${verifier}:${privacyBridge}:${shieldedAssetAdapter}`;
  }

  function localStateScope() {
    return `${publicConfig?.account_id ?? "locked"}:${deploymentScope}`;
  }

  function selectFundingNotes(
    draft: PrivateOrderDraft,
    reservedNoteCommitments = new Set<string>(),
    allowedLockedBy?: string
  ) {
    const asset = fundingAssetForDraft(draft);
    const required = fundingRequirement(draft);
    const allowedLockRef = allowedLockedBy
      ? normalizeFeltForComparison(allowedLockedBy)
      : "";
    const candidates = notes
      .filter(
        (record) =>
          !record.spent &&
          (!record.locked_by_order ||
            (allowedLockRef !== "" &&
              normalizeFeltForComparison(record.locked_by_order) ===
                allowedLockRef)) &&
          isSpendableLocalNote(record) &&
          !reservedNoteCommitments.has(record.note_commitment) &&
          record.note.asset_id === asset
      )
      .sort((left, right) => {
        const leftAmount = BigInt(left.note.amount);
        const rightAmount = BigInt(right.note.amount);
        if (leftAmount < rightAmount) return -1;
        if (leftAmount > rightAmount) return 1;
        return left.note_commitment.localeCompare(right.note_commitment);
      });
    const selected = smallestSufficientNoteSet(candidates, required);
    if (selected.length === 0) {
      throw new Error(`No available ${asset} balance can fund this order`);
    }
    return selected;
  }

  function selectLiquidityPositionFundingNotes(
    request: PrivateLiquidityPositionOpenRequest
  ) {
    const requiredByAsset = new Map<string, bigint>();
    addLiquidityPositionFundingRequirement(
      requiredByAsset,
      request.baseAssetId,
      parseNonNegativeRawAmount(request.baseReserveAtomic, "base reserve")
    );
    addLiquidityPositionFundingRequirement(
      requiredByAsset,
      request.quoteAssetId,
      parseNonNegativeRawAmount(request.quoteReserveAtomic, "quote reserve")
    );
    const selected: LocalNoteRecord[] = [];
    const reserved = new Set<string>();
    for (const [asset, required] of requiredByAsset) {
      if (required <= 0n) continue;
      const candidates = notes
        .filter(
          (record) =>
            !record.spent &&
            !record.locked_by_order &&
            isSpendableLocalNote(record) &&
            !reserved.has(record.note_commitment) &&
            record.note.asset_id === asset
        )
        .sort((left, right) => {
          const leftAmount = BigInt(left.note.amount);
          const rightAmount = BigInt(right.note.amount);
          if (leftAmount < rightAmount) return -1;
          if (leftAmount > rightAmount) return 1;
          return left.note_commitment.localeCompare(right.note_commitment);
        });
      const assetSelection = smallestSufficientNoteSet(candidates, required);
      if (assetSelection.length === 0) {
        throw new Error(
          `No available ${asset} balance can fund this liquidity position`
        );
      }
      for (const record of assetSelection) {
        selected.push(record);
        reserved.add(record.note_commitment);
      }
    }
    if (selected.length === 0) {
      throw new Error(
        "Liquidity position requires a positive base or quote reserve"
      );
    }
    return selected;
  }

  function selectWithdrawableNote(noteCommitment?: string) {
    const note = notes.find(
      (record) =>
        !record.spent &&
        !record.locked_by_order &&
        (isSpendableLocalNote(record) ||
          isRetryableStrk20ExitClaim(record)) &&
        (!noteCommitment || record.note_commitment === noteCommitment)
    );
    if (!note) {
      throw new Error(
        noteCommitment
          ? "Selected note is not withdrawable"
          : "No available note can be withdrawn"
      );
    }
    return note;
  }

  function buildPrivateOrderForSlot(
    draft: PrivateOrderDraft,
    batch: BatchSummary,
    fundingNotes: LocalNoteRecord[],
    registry: unknown,
    parent?: { material: StrategyParentMaterial; childIndex: number }
  ) {
    const { seedHex: unlockedSeed } = requireUnlocked();
    const order = buildOrderIntent(draft, batch, fundingNotes[0], parent);
    return JSON.parse(
      core.zylith_wallet_build_private_order_submission(
        JSON.stringify({
          seed_hex: unlockedSeed,
          registry,
          funding_notes: fundingNotes.map((record) => record.note),
          order,
          padding: randomPadding(2048),
        })
      )
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
    parent?: { material: StrategyParentMaterial; childIndex: number }
  ) {
    if (draft.mode === "Liquidity Position" || draft.mode === "Resting") {
      throw new Error(
        "Private liquidity must be opened through the private liquidity position lifecycle"
      );
    }
    const amount = parseRawAmount(draft.amount, "amount");
    const limitPrice = parseRawAmount(draft.limitPrice, "limit price");
    const minFill = normalizeOrderMinFill(draft, amount);
    return {
      pair_id: draft.pair,
      batch_id: batch.batch_id,
      side: draft.side,
      order_type: "LimitBatch",
      relay_mode: draft.relayMode ?? "SelfRelay",
      limit_price: limitPrice.toString(),
      amount: amount.toString(),
      min_fill: minFill.toString(),
      time_in_force: draft.fillOrKill ? "FillOrKill" : "CurrentBatchOnly",
      expiry_epoch: batch.epoch_id,
      order_nonce: randomU64(),
      parent_order_commitment:
        parent?.material.parent_order_commitment ?? "0x0",
      parent_child_index: parent?.childIndex ?? 0,
      parent_secret_commitment:
        parent?.material.parent_secret_commitment ?? "0x0",
      parent_cancel_authority:
        parent?.material.parent_cancel_authority ?? "0x0",
      parent_authorization_secret:
        parent?.material.parent_authorization_secret ?? "0x0",
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

export function hasRecoverablePendingDeposit(records: LocalNoteRecord[]) {
  return records.some(
    (record) =>
      record.source === "deposit" &&
      record.deposit_confirmed !== true &&
      !record.spent &&
      record.deposit_failed !== true
  );
}

export function transactionCalldataContainsDepositActivation(
  calldataSet: Set<string>,
  activation: {
    bridgeAddress?: string | null;
    fundingCommitment?: string | null;
    depositRoot?: string | null;
    activation?: string | null;
  }
) {
  const bridgeAddress = normalizeOptionalFelt(activation.bridgeAddress);
  const fundingCommitment = normalizeOptionalFelt(activation.fundingCommitment);
  const depositRoot = normalizeOptionalFelt(activation.depositRoot);
  const encryptedActivation = normalizeOptionalFelt(activation.activation);
  return Boolean(
    bridgeAddress &&
      calldataSet.has(bridgeAddress) &&
      fundingCommitment &&
      depositRoot &&
      encryptedActivation &&
      calldataSet.has(fundingCommitment) &&
      calldataSet.has(depositRoot) &&
      calldataSet.has(encryptedActivation)
  );
}

function fundingAssetForDraft(draft: PrivateOrderDraft) {
  const [base, quote] = draft.pair.split("/");
  return draft.side === "Buy" ? quote : base;
}

function fundingRequirement(draft: PrivateOrderDraft) {
  if (draft.mode === "Liquidity Position" || draft.mode === "Resting") {
    throw new Error(
      "Private liquidity must be opened through the private liquidity position lifecycle"
    );
  }
  const priceBaseScale = draftPriceBaseScale(draft);
  const amount = parseRawAmount(draft.amount, "amount");
  if (draft.side === "Sell") return amount;
  return quoteAmountForBase(
    amount,
    parseRawAmount(draft.limitPrice, "limit price"),
    priceBaseScale
  );
}

function smallestSufficientNoteSet(
  candidates: LocalNoteRecord[],
  required: bigint
) {
  if (required <= 0n) return [];
  const boundedCandidates = fundingCandidateSearchPool(candidates, required);
  let best: LocalNoteRecord[] = [];
  let bestTotal: bigint | null = null;
  let bestNonStandardCount = -1;

  function consider(selection: LocalNoteRecord[], total: bigint) {
    if (total < required) return;
    const nonStandardCount = selection.filter(
      (record) => !isStandardNoteAmount(record)
    ).length;
    const shouldReplace =
      bestTotal === null ||
      total < bestTotal ||
      (total === bestTotal && selection.length < best.length) ||
      (total === bestTotal &&
        selection.length === best.length &&
        nonStandardCount > bestNonStandardCount);
    if (shouldReplace) {
      best = [...selection];
      bestTotal = total;
      bestNonStandardCount = nonStandardCount;
    }
  }

  function search(start: number, selection: LocalNoteRecord[], total: bigint) {
    consider(selection, total);
    if (
      selection.length >= MAX_ORDER_FUNDING_INPUTS ||
      start >= boundedCandidates.length
    )
      return;
    if (bestTotal !== null && total >= bestTotal) return;
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

function fundingCandidateSearchPool(
  candidates: LocalNoteRecord[],
  required: bigint
) {
  if (candidates.length <= 48) return candidates;
  const byCommitment = new Map<string, LocalNoteRecord>();
  const add = (record: LocalNoteRecord) => {
    byCommitment.set(
      normalizeFeltForComparison(record.note_commitment),
      record
    );
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
    assetDecimals(record.note.asset_id)
  );
  return denominations.some(
    (denomination) => denomination === BigInt(record.note.amount)
  );
}

function quoteAmountForBase(
  baseAmount: bigint,
  price: bigint,
  priceBaseScale: bigint
) {
  if (priceBaseScale <= 0n)
    throw new Error("Price base scale must be non-zero");
  return (baseAmount * price) / priceBaseScale;
}

function normalizeOrderMinFill(draft: PrivateOrderDraft, amount: bigint) {
  if (amount <= 0n) throw new Error("Order amount must be positive");
  if (draft.fillOrKill) return amount;
  const parsed = parseOptionalRawAmount(draft.minFill, "minimum fill");
  return min(parsed ?? 1n, amount);
}

function draftPriceBaseScale(draft: PrivateOrderDraft) {
  const explicit = parseOptionalRawAmount(
    draft.priceBaseScale,
    "price base scale"
  );
  return explicit ?? pairPriceBaseScale(draft.pair);
}

function pairPriceBaseScale(pair: string) {
  const [base] = pair.split("/");
  return 10n ** BigInt(assetDecimals(base));
}

function normalizeJitterBps(value: number | undefined) {
  if (!Number.isFinite(value ?? NaN)) return 1_500;
  return Math.max(0, Math.min(5_000, Math.round(value ?? 0)));
}

function strategyFundingLockRef(strategy: PrivateStrategyRecord) {
  return normalizeFeltForComparison(strategy.parent.parent_order_commitment);
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
  const remainingSlots = Math.max(
    1,
    strategy.max_children - strategy.next_child_index + 1
  );
  let amount = BigInt(strategy.child_amount);
  if (strategy.mode === "TWAP") {
    amount = ceilDiv(remaining, BigInt(remainingSlots));
  } else if (strategy.mode === "VWAP") {
    const weights = [80n, 95n, 120n, 115n, 90n];
    const weight =
      weights[strategy.submitted_children.length % weights.length] ?? 100n;
    amount = (amount * weight) / 100n;
  }
  if (strategy.randomized_slicing) {
    amount =
      (amount *
        BigInt(randomBasisPointsJitter(strategy.slice_jitter_bps ?? 1_500))) /
      10_000n;
  }
  if (amount <= 0n) amount = 1n;
  const futureSlots = BigInt(Math.max(0, remainingSlots - 1));
  const maxCurrent =
    remaining > futureSlots ? remaining - futureSlots : remaining;
  return amount > maxCurrent ? maxCurrent : amount;
}

function defaultStrategyChildren(mode: OrderMode) {
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

function parseNonNegativeRawAmount(value: string, label: string) {
  const trimmed = value.trim();
  const field = label ? label[0].toUpperCase() + label.slice(1) : "Value";
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`${field} must be a raw integer amount`);
  }
  return BigInt(trimmed);
}

function parseOptionalRawAmount(value: string | undefined, label: string) {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || /^0+$/.test(trimmed)) return null;
  return parseRawAmount(value, label);
}

function addLiquidityPositionFundingRequirement(
  requiredByAsset: Map<string, bigint>,
  asset: string,
  amount: bigint
) {
  if (amount <= 0n) return;
  const current = requiredByAsset.get(asset) ?? 0n;
  requiredByAsset.set(asset, current + amount);
}

function liquidityPositionDurationBatches(
  request: PrivateLiquidityPositionOpenRequest,
  batchWindowMs: number
) {
  const durationHours = Number(request.durationHours);
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    throw new Error("Liquidity position duration must be positive");
  }
  const parsedWindow = Number(batchWindowMs);
  const effectiveWindowMs =
    Number.isFinite(parsedWindow) && parsedWindow > 0
      ? parsedWindow
      : DEFAULT_LIQUIDITY_POSITION_BATCH_WINDOW_MS;
  return Math.max(
    1,
    Math.ceil((durationHours * 3_600_000) / effectiveWindowMs)
  );
}

function liquidityPositionLifecycleLockRef(lifecycleId: string) {
  return `liquidity-position:${lifecycleId}`;
}

function parseHumanAmount(value: string, asset: string) {
  const trimmed = value.trim();
  if (!trimmed || !/^\d*(\.\d*)?$/.test(trimmed) || trimmed === ".") return 0n;
  const decimals = assetDecimals(asset);
  const [whole = "0", fractional = ""] = trimmed.split(".");
  const fractionalAtomic =
    fractional.padEnd(decimals, "0").slice(0, decimals) || "0";
  return (
    BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fractionalAtomic)
  );
}

async function zylithWalletAuthDeploymentId(
  deployment: DeploymentConfig,
  chainId: string
) {
  const fundingRail = selectedDepositFundingRail(deployment);
  return sha256Hex(
    stableJsonStringify({
      chain_id: chainId,
      auction_verifier: requiredNonZeroFelt(
        deployment.contracts?.auction_verifier,
        "auction_verifier_address"
      ),
      privacy_deposit_bridge: requiredNonZeroFelt(
        fundingRail.bridgeAdapter,
        "privacy_deposit_bridge_address"
      ),
      shielded_asset_adapter: requiredNonZeroFelt(
        fundingRail.shieldedAssetAdapter,
        "shielded_asset_adapter_address"
      ),
      funding_primary: deployment.funding?.primary,
      auth_message_version: 2,
    })
  );
}

async function buildZylithWalletAuthTypedData(input: {
  walletAddress: string;
  chainId: string;
  deploymentId: string;
  origin: string;
}) {
  return {
    types: {
      StarkNetDomain: [
        { name: "name", type: "felt" },
        { name: "version", type: "felt" },
        { name: "chainId", type: "felt" },
      ],
      ZylithSession: [
        { name: "action", type: "felt" },
        { name: "wallet", type: "felt" },
        { name: "origin", type: "felt" },
        { name: "deployment", type: "felt" },
        { name: "version", type: "felt" },
      ],
    },
    primaryType: "ZylithSession",
    domain: {
      name: shortStringFelt("Zylith"),
      version: shortStringFelt("1"),
      chainId: input.chainId,
    },
    message: {
      action: shortStringFelt("Authorize"),
      wallet: input.walletAddress,
      origin: await feltHashForText(input.origin),
      deployment: feltFromHexHash(input.deploymentId),
      version: "2",
    },
  };
}

async function requestStarknetWalletTypedSignature(
  provider: StarknetInjectedProvider,
  typedData: unknown
) {
  if (provider.request) {
    const requests = [
      { type: "wallet_signTypedData", params: typedData },
      { method: "wallet_signTypedData", params: typedData },
      { method: "starknet_signTypedData", params: typedData },
    ];
    for (const request of requests) {
      try {
        const result = await withWalletSignatureTimeout(
          provider.request.call(provider, request)
        );
        if (result !== null && result !== undefined) return result;
      } catch (error) {
        if (isUserRejectedWalletError(error) || !isWalletSignRequestShapeError(error)) {
          throw error;
        }
      }
    }
  }
  if (typeof provider.account?.signMessage === "function") {
    try {
      return await withWalletSignatureTimeout(
        provider.account.signMessage(typedData)
      );
    } catch (error) {
      if (isWalletSignRequestShapeError(error)) {
        throw new Error("Selected Starknet wallet cannot sign Zylith messages");
      }
      throw error;
    }
  }
  throw new Error("Selected Starknet wallet cannot sign Zylith messages");
}

async function withWalletSignatureTimeout<T>(request: Promise<T>): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(
        new Error(
          "Wallet signature request timed out. Open your Starknet wallet, approve the signature, and retry."
        )
      );
    }, WALLET_SIGNATURE_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function isBatchRolloverError(error: unknown) {
  if (
    error instanceof RuntimeHttpStatusError &&
    error.path === "/api/orders" &&
    error.status === 409
  ) {
    return true;
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /submission window moved|auction window.*(no longer open|safety buffer|rolled forward)|submission safety buffer|no safe auction window is available/i.test(message);
}

function isDefiniteCoordinatorOrderRejection(error: unknown) {
  return (
    error instanceof RuntimeHttpStatusError &&
    error.path === "/api/orders" &&
    error.status >= 400 &&
    error.status < 500
  );
}

function isDefiniteCoordinatorLiquidityPositionRejection(error: unknown) {
  return (
    error instanceof RuntimeHttpStatusError &&
    error.path === "/api/liquidity-positions/lifecycle" &&
    error.status >= 400 &&
    error.status < 500
  );
}

function isDefinitePrivateIngressRejection(error: unknown) {
  return (
    error instanceof RuntimeHttpStatusError &&
    error.path === "/api/private/orders" &&
    error.status >= 400 &&
    error.status < 500
  );
}

function isDefinitePrivateLiquidityPositionIngressRejection(error: unknown) {
  return (
    error instanceof RuntimeHttpStatusError &&
    error.path === "/api/private/liquidity-positions/lifecycle" &&
    error.status >= 400 &&
    error.status < 500
  );
}

export function isDefiniteNoteConsolidationSubmitRejection(error: unknown) {
  return (
    error instanceof RuntimeHttpStatusError &&
    error.path === "/api/private/note-consolidations/submit" &&
    error.status >= 400 &&
    error.status < 500
  );
}

export function isAmbiguousPrivateOrderSubmissionError(
  error: unknown,
  phase: "pre_ingress" | "private_ingress" | "coordinator_submission"
) {
  if (phase === "pre_ingress") return false;
  if (phase === "private_ingress") {
    return !isDefinitePrivateIngressRejection(error);
  }
  return !isDefiniteCoordinatorOrderRejection(error);
}

function isAmbiguousPrivateLiquidityPositionSubmissionError(
  error: unknown,
  phase: "pre_ingress" | "private_ingress" | "coordinator_submission"
) {
  if (phase === "pre_ingress") return false;
  if (phase === "private_ingress") {
    return !isDefinitePrivateLiquidityPositionIngressRejection(error);
  }
  return !isDefiniteCoordinatorLiquidityPositionRejection(error);
}

function isWalletSignRequestShapeError(error: unknown) {
  return /method not found|not supported|unsupported|not implemented|unknown method|invalid input|invalid_union|typed.?data|sign.?message/i.test(
    walletErrorMessage(error)
  );
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return `0x${bytesToHex(new Uint8Array(digest))}`;
}

async function feltHashForText(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return `0x${bytesToHex(new Uint8Array(digest).slice(0, 31))}`;
}

function feltFromHexHash(value: string) {
  const normalized = value.trim().replace(/^0x/i, "").toLowerCase();
  return `0x${normalized.slice(0, 62) || "0"}`;
}

function shortStringFelt(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 31) {
    throw new Error("Wallet auth label is too long");
  }
  return `0x${bytesToHex(bytes) || "0"}`;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

function normalizeRecoverySeed(value: string) {
  const normalized = value
    .trim()
    .replace(/^0x/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Recovery seed must be 64 hex characters");
  }
  return normalized;
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

async function encodeStarknetFelt(kind: string, value: string) {
  const data = new TextEncoder().encode(`zylith/starknet-felt${kind}:${value}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  digest[0] &= 0x03;
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `0x${BigInt(`0x${hex}`).toString(16)}`;
}

function normalizeLocalNoteRecord(record: LocalNoteRecord): LocalNoteRecord {
  return {
    ...record,
    note_commitment:
      normalizeFeltForComparison(record.note_commitment) ||
      normalizeNoteCommitment(record.note_commitment),
    locked_by_order: record.locked_by_order
      ? normalizeFeltForComparison(record.locked_by_order)
      : undefined,
  };
}

export function mergeLocalNoteRecord(
  existing: LocalNoteRecord,
  incoming: LocalNoteRecord
): boolean {
  let changed = false;
  const normalizedIncoming = normalizeLocalNoteRecord(incoming);
  const normalizedExistingCommitment =
    normalizeFeltForComparison(existing.note_commitment) ||
    existing.note_commitment;
  if (existing.note_commitment !== normalizedExistingCommitment) {
    existing.note_commitment = normalizedExistingCommitment;
    changed = true;
  }
  if (
    normalizedIncoming.deployment_scope &&
    existing.deployment_scope !== normalizedIncoming.deployment_scope
  ) {
    existing.deployment_scope = normalizedIncoming.deployment_scope;
    changed = true;
  }
  if (
    normalizedIncoming.source === "settlement_output" &&
    existing.source !== "settlement_output"
  ) {
    existing.source = "settlement_output";
    changed = true;
  } else if (!existing.source && normalizedIncoming.source) {
    existing.source = normalizedIncoming.source;
    changed = true;
  }
  if (
    normalizedIncoming.batch_id &&
    existing.batch_id !== normalizedIncoming.batch_id
  ) {
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
  if (normalizedIncoming.liquidity_provider_attribution && !existing.liquidity_provider_attribution) {
    existing.liquidity_provider_attribution = normalizedIncoming.liquidity_provider_attribution;
    changed = true;
  }
  if (normalizedIncoming.pending_deposit_tx && !existing.pending_deposit_tx) {
    existing.pending_deposit_tx = normalizedIncoming.pending_deposit_tx;
    changed = true;
  }
  if (normalizedIncoming.funding_commitment && !existing.funding_commitment) {
    existing.funding_commitment = normalizedIncoming.funding_commitment;
    changed = true;
  }
  if (normalizedIncoming.deposit_root && !existing.deposit_root) {
    existing.deposit_root = normalizedIncoming.deposit_root;
    changed = true;
  }
  if (
    normalizedIncoming.encrypted_note_activation &&
    !existing.encrypted_note_activation
  ) {
    existing.encrypted_note_activation =
      normalizedIncoming.encrypted_note_activation;
    changed = true;
  }
  if (normalizedIncoming.deposit_confirmed && !existing.deposit_confirmed) {
    existing.deposit_confirmed = true;
    existing.deposit_failed = undefined;
    existing.deposit_failure_reason = undefined;
    changed = true;
  }
  if (
    normalizedIncoming.deposit_failed &&
    !existing.deposit_failed &&
    existing.deposit_confirmed !== true
  ) {
    existing.deposit_failed = true;
    existing.deposit_failure_reason = normalizedIncoming.deposit_failure_reason;
    changed = true;
  }
  if (normalizedIncoming.spent && !existing.spent) {
    existing.spent = true;
    existing.locked_by_order = undefined;
    existing.pending_consolidation = undefined;
    existing.pending_withdrawal_tx = undefined;
    existing.pending_strk20_open_note_tx = undefined;
    existing.withdrawal_requested_at_unix_ms = undefined;
    existing.strk20_open_note_id =
      normalizedIncoming.strk20_open_note_id ?? existing.strk20_open_note_id;
    changed = true;
  }
  if (
    !existing.spent &&
    normalizedIncoming.locked_by_order &&
    !existing.locked_by_order
  ) {
    existing.locked_by_order = normalizedIncoming.locked_by_order;
    changed = true;
  }
  if (
    normalizedIncoming.pending_withdrawal_tx &&
    !existing.pending_withdrawal_tx &&
    !existing.spent
  ) {
    existing.pending_withdrawal_tx = normalizedIncoming.pending_withdrawal_tx;
    existing.withdrawal_requested_at_unix_ms =
      normalizedIncoming.withdrawal_requested_at_unix_ms;
    changed = true;
  }
  if (
    normalizedIncoming.pending_strk20_open_note_tx &&
    !existing.pending_strk20_open_note_tx &&
    !existing.spent
  ) {
    existing.pending_strk20_open_note_tx =
      normalizedIncoming.pending_strk20_open_note_tx;
    existing.strk20_open_note_id =
      normalizedIncoming.strk20_open_note_id ?? existing.strk20_open_note_id;
    existing.withdrawal_requested_at_unix_ms =
      normalizedIncoming.withdrawal_requested_at_unix_ms ??
      existing.withdrawal_requested_at_unix_ms;
    changed = true;
  }
  if (
    normalizedIncoming.pending_consolidation &&
    !existing.pending_consolidation &&
    !existing.spent
  ) {
    existing.pending_consolidation = normalizedIncoming.pending_consolidation;
    existing.locked_by_order =
      normalizedIncoming.locked_by_order ?? existing.locked_by_order;
    changed = true;
  }
  return changed;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    })
  );
  return results;
}

async function executeInjectedStarknetCalls(
  calls: Array<{
    contract_address: string;
    entrypoint: string;
    calldata: string[];
  }>
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
      ? await requestWalletInvokeWithAccountExecuteRecovery(
          provider,
          walletCalls,
          accountCalls
        )
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
  return /invalid_union|invalid input|contractAddress|contract_address|entrypoint|entry_point/i.test(
    message
  );
}

function isUserRejectedWalletError(error: unknown) {
  return /user rejected|user denied|user abort|rejected by user|cancelled|canceled/i.test(
    walletErrorMessage(error)
  );
}

function isWalletRequestUnavailableError(error: unknown) {
  return /method not found|not supported|unsupported|not implemented|unknown method|wallet_addInvokeTransaction/i.test(
    walletErrorMessage(error)
  );
}

async function executeWalletCalls(
  provider: StarknetInjectedProvider,
  accountCalls: StarknetWalletCall[],
  walletCalls: WalletRequestInvokeCall[]
) {
  try {
    return await withStarknetWalletInvokeTimeout(
      provider.account?.execute?.(accountCalls)
    );
  } catch (error) {
    if (!isWalletCallShapeError(error)) throw error;
    return withStarknetWalletInvokeTimeout(
      provider.account?.execute?.(
        walletCalls as unknown as StarknetWalletCall[]
      )
    );
  }
}

async function requestWalletInvokeWithAccountExecuteRecovery(
  provider: StarknetInjectedProvider,
  walletCalls: WalletRequestInvokeCall[],
  accountCalls: StarknetWalletCall[]
) {
  try {
    return await requestWalletInvoke(provider, walletCalls);
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
  walletCalls: WalletRequestInvokeCall[]
) {
  if (!provider.request) return undefined;
  try {
    return await withStarknetWalletInvokeTimeout(
      provider.request({
        type: "wallet_addInvokeTransaction",
        params: { calls: walletCalls },
      })
    );
  } catch (error) {
    if (isUserRejectedWalletError(error)) throw error;
    if (!isWalletCallShapeError(error) && !isWalletRequestUnavailableError(error)) {
      throw error;
    }
    throw error instanceof Error
      ? error
      : new Error("Selected Starknet wallet rejected the transaction shape");
  }
}

async function withStarknetWalletInvokeTimeout<T>(
  request: Promise<T | undefined> | undefined
): Promise<T | undefined> {
  if (!request) return undefined;
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(
        new Error(
          "Starknet wallet transaction timed out. Open your wallet, approve the transaction, and retry."
        )
      );
    }, STARKNET_WALLET_INVOKE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
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
  return (
    runtimeAddressFromUnknown(record.address) ??
    runtimeAddressFromUnknown(record.selectedAddress) ??
    runtimeAddressFromUnknown(record.account) ??
    runtimeAddressFromUnknown(record.accounts)
  );
}

function connectedProviderAddress(provider: StarknetInjectedProvider) {
  return (
    runtimeAddressFromUnknown(provider.account?.address) ??
    runtimeAddressFromUnknown(provider.selectedAddress)
  );
}

async function selectInjectedStarknetProvider() {
  const preferredProvider = selectedStarknetProvider();
  const discovered = discoverStarknetWallets();
  const deployment = await loadWalletDeploymentConfig();
  const preferredWallet = preferredProvider
    ? discovered.find(({ provider }) => provider === preferredProvider) ?? null
    : null;
  const orderedProviders = preferredProvider
    ? [
        { id: preferredWallet?.id, provider: preferredProvider },
        ...discovered.filter(({ provider }) => provider !== preferredProvider),
      ]
    : discovered;
  for (const { id, provider } of orderedProviders) {
    try {
      await connectStarknetProvider(provider as never, id);
    } catch (error) {
      if (isUserRejectedWalletError(error)) throw error;
      continue;
    }
    if (provider.account?.execute || provider.request) {
      await ensureWalletChain(provider, deployment);
      return provider;
    }
  }
  throw new Error(
    "Connect a Starknet wallet before submitting this transaction"
  );
}

function setRuntimePrivacyFundingStage(stage: string) {
  setPrivacyFundingStage(stage);
}

async function loadWalletDeploymentConfig(): Promise<DeploymentConfig> {
  return requestDeploymentConfig();
}

async function requestDeploymentConfig(): Promise<DeploymentConfig> {
  try {
    const response = await fetchWithTimeout(
      "/deployment.json",
      { headers: { accept: "application/json" } },
      DEPLOYMENT_MANIFEST_REQUEST_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`Deployment manifest request failed with HTTP ${response.status}`);
    }
    const deployment = await response.json();
    assertCurrentDeploymentManifestShape(deployment);
    return deployment as DeploymentConfig;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (
      /runtime request timed out|signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted|failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
        message
      )
    ) {
      throw new Error(
        "Deployment manifest is unavailable. Check your connection and retry."
      );
    }
    throw error instanceof Error
      ? error
      : new Error("Deployment manifest is unavailable");
  }
}

async function ensureWalletChain(
  provider: StarknetInjectedProvider,
  deployment: DeploymentConfig
) {
  const expected = normalizeRuntimeChainId(deployment.chain_id);
  if (!expected) {
    throw new Error("Deployment manifest is missing the Starknet chain ID.");
  }
  const current = await requestWalletChainId(provider);
  if (normalizeRuntimeChainId(current) === expected) return;
  const switchAccepted = await requestWalletChainSwitch(provider, expected);
  const switched = await requestWalletChainId(provider);
  if (normalizeRuntimeChainId(switched) === expected) return;
  if (!normalizeRuntimeChainId(current) && !normalizeRuntimeChainId(switched) && switchAccepted) {
    return;
  }
  validateWalletChainMatch(deployment.chain_id, switched, deployment.network);
}

export function validateWalletChainMatch(
  deploymentChainId: unknown,
  walletChainId: unknown,
  deploymentNetwork?: string
) {
  const expected = normalizeRuntimeChainId(deploymentChainId);
  const actual = normalizeRuntimeChainId(walletChainId);
  if (!expected) {
    throw new Error("Deployment manifest is missing the Starknet chain ID.");
  }
  if (!actual) {
    throw new Error("Connected Starknet wallet did not report its network.");
  }
  if (actual === expected) return;
  const networkName =
    deploymentNetwork === "sepolia"
      ? "Starknet Sepolia"
      : deploymentNetwork || "the configured Starknet network";
  throw new Error(
    `Wrong Starknet network. Switch to ${networkName} in your wallet and retry.`
  );
}

async function requestWalletChainSwitch(
  provider: StarknetInjectedProvider,
  chainId: string
): Promise<boolean> {
  if (!provider.request) return false;
  const requests = [
    { type: "wallet_switchStarknetChain", params: { chainId } },
    { method: "wallet_switchStarknetChain", params: { chainId } },
  ];
  for (const request of requests) {
    try {
      await withStarknetWalletRequestTimeout(
        provider.request.call(provider, request),
        STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
      );
      return true;
    } catch (error) {
      if (isUserRejectedWalletError(error)) throw error;
      if (!isWalletRequestUnavailableError(error) && !isWalletCallShapeError(error)) {
        return true;
      }
    }
  }
  return false;
}

async function requestWalletChainId(
  provider: StarknetInjectedProvider
): Promise<string | null> {
  if (provider.request) {
    const requests = [
      { type: "wallet_requestChainId" },
      { method: "wallet_requestChainId" },
      { type: "starknet_chainId" },
      { method: "starknet_chainId" },
    ];
    for (const request of requests) {
      const result = await withStarknetWalletRequestTimeout(
        provider.request.call(provider, request),
        STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
      ).catch(() => null);
      const chainId = chainIdFromUnknown(result);
      if (chainId) return chainId;
    }
  }
  if (provider.getChainId) {
    const value = await withStarknetWalletRequestTimeout(
      Promise.resolve(provider.getChainId()),
      STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
    ).catch(() => null);
    const chainId = chainIdFromUnknown(value);
    if (chainId) return chainId;
  }
  if (provider.account?.getChainId) {
    const value = await withStarknetWalletRequestTimeout(
      provider.account.getChainId(),
      STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
    ).catch(() => null);
    const chainId = chainIdFromUnknown(value);
    if (chainId) return chainId;
  }
  return chainIdFromUnknown(provider.chainId);
}

async function withStarknetWalletRequestTimeout<T>(
  request: Promise<T | undefined> | undefined,
  timeoutMs: number
): Promise<T | undefined> {
  if (!request) return undefined;
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error("Starknet wallet request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function chainIdFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const chainId = chainIdFromUnknown(item);
      if (chainId) return chainId;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return (
    chainIdFromUnknown(record.chainId) ??
    chainIdFromUnknown(record.chain_id) ??
    chainIdFromUnknown(record.id)
  );
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

function safeDebugErrorMessage(error: unknown) {
  const message = walletErrorMessage(error)
    .replace(/0x[0-9a-fA-F]{33,}/g, "<felt>")
    .replace(/\b[0-9]{32,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
  return message ? message.slice(0, 240) : "unknown error";
}

function normalizeWalletTransactionError(error: unknown) {
  if (import.meta.env.DEV) {
    console.warn(
      "Wallet transaction failed",
      safeDebugErrorMessage(error)
    );
  }
  const message = walletErrorMessage(error);
  if (isUserRejectedWalletError(error)) {
    return new Error("Request cancelled in wallet.");
  }
  if (/too many requests|onfinality|rate limit|-32029/i.test(message)) {
    return new Error(
      "Wallet could not prepare the transaction. Please retry later."
    );
  }
  if (
    /requested contract address .*not deployed|contract_not_found|contract address .*is not deployed/i.test(
      message
    )
  ) {
    return new Error(
      "Zylith contracts are unavailable on the selected wallet network. Switch to Starknet Sepolia and retry."
    );
  }
  if (
    /signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted/i.test(
      message
    )
  ) {
    return new Error("Starknet wallet transaction timed out. Open your wallet and retry.");
  }
  if (
    /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
      message
    )
  ) {
    return new Error("Starknet wallet transaction failed. Check your connection and retry.");
  }
  return new Error("Starknet wallet could not submit the transaction. Please retry.");
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
  deployment: DeploymentConfig
): Promise<TransactionReceiptStatus | null> {
  const rpcUrl = deployment.rpc_url;
  if (!rpcUrl || !/^https?:\/\//i.test(rpcUrl)) return null;

  type ReceiptResponse = {
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
  };
  let receipt: ReceiptResponse = await starknetRpc<ReceiptResponse>(
    rpcUrl,
    "starknet_getTransactionReceipt",
    { transaction_hash: transactionHash }
  ).catch(async () =>
    starknetRpc<ReceiptResponse>(rpcUrl, "starknet_getTransactionReceipt", [
      transactionHash,
    ])
  );
  if (
    receipt.error &&
    /invalid.?params|invalid.?request/i.test(receipt.error.message ?? "")
  ) {
    receipt = await starknetRpc<ReceiptResponse>(
      rpcUrl,
      "starknet_getTransactionReceipt",
      [transactionHash]
    );
  }

  if (receipt.error) {
    const message = `${receipt.error.message ?? ""} ${JSON.stringify(
      receipt.error.data ?? ""
    )}`;
    if (/not.?found|unknown/i.test(message) || receipt.error.code === 29) {
      return { failed: false, notFound: true };
    }
    return null;
  }

  const result = receipt.result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const executionStatus = String(
    record.execution_status ?? record.executionStatus ?? record.status ?? ""
  ).toUpperCase();
  const finalityStatus = String(
    record.finality_status ?? record.finalityStatus ?? record.status ?? ""
  ).toUpperCase();
  const revertReason =
    typeof record.revert_reason === "string"
      ? record.revert_reason
      : typeof record.revertReason === "string"
      ? record.revertReason
      : undefined;
  if (
    /REVERT|REJECT/.test(executionStatus) ||
    /REVERT|REJECT/.test(finalityStatus)
  ) {
    return {
      failed: true,
      notFound: false,
      reason: revertReason || "Deposit transaction reverted.",
    };
  }
  const confirmed =
    /ACCEPTED|SUCCEEDED/.test(executionStatus) ||
    /ACCEPTED|SUCCEEDED/.test(finalityStatus);
  return { failed: false, notFound: false, confirmed };
}

async function fetchTransactionCalldata(
  transactionHash: string,
  deployment: DeploymentConfig
): Promise<string[] | null> {
  const rpcUrl = deployment.rpc_url;
  if (!rpcUrl || !/^https?:\/\//i.test(rpcUrl)) return null;

  type TransactionResponse = {
    result?: { calldata?: unknown };
    error?: { code?: number; message?: string; data?: unknown };
  };
  let transaction: TransactionResponse = await starknetRpc<TransactionResponse>(
    rpcUrl,
    "starknet_getTransactionByHash",
    { transaction_hash: transactionHash }
  ).catch(async () =>
    starknetRpc<TransactionResponse>(rpcUrl, "starknet_getTransactionByHash", [
      transactionHash,
    ])
  );
  if (
    transaction.error &&
    /invalid.?params|invalid.?request/i.test(transaction.error.message ?? "")
  ) {
    transaction = await starknetRpc<TransactionResponse>(
      rpcUrl,
      "starknet_getTransactionByHash",
      [transactionHash]
    );
  }
  if (transaction.error || !Array.isArray(transaction.result?.calldata)) {
    return null;
  }
  return transaction.result.calldata
    .filter((value): value is string => typeof value === "string")
    .map(normalizeFeltForComparison)
    .filter(Boolean);
}

async function sha256Json(value: unknown) {
  const stableJson = stableJsonStringify(value);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableJson)
  );
  return `0x${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

async function renewalFundingNoteLabels(
  strategy: PrivateStrategyRecord,
  notes: LocalNoteRecord[],
  packageSalt: string
) {
  return Promise.all(
    notes.map((note) =>
      sha256Json({
        domain: "zylith/renewal-funding-label-v1",
        strategy_id: strategy.id,
        package_salt: packageSalt,
        parent_secret: strategy.parent.parent_authorization_secret,
        note_commitment: normalizeFeltForComparison(note.note_commitment),
      })
    )
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

function normalizeLocalLiquidityPositionRecord(
  value: unknown
): LocalLiquidityPositionRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid private liquidity position record");
  }
  const record = value as Partial<LocalLiquidityPositionRecord>;
  const position = normalizeProtocolPrivateLiquidityPosition(record.position);
  const id = normalizeFeltForComparison(
    record.id || protocolLiquidityPositionId(position)
  );
  const positionCommitment = normalizeFeltForComparison(
    record.position_commitment
  );
  const pairId = normalizeText(record.pair_id || protocolLiquidityPairId(position));
  if (!id || !positionCommitment || !pairId) {
    throw new Error("Invalid private liquidity position record");
  }
  return {
    id,
    position,
    position_commitment: positionCommitment,
    pair_id: pairId,
    status: normalizeLiquidityPositionStatus(record.status),
    deployment_scope: normalizeText(record.deployment_scope),
    last_lifecycle_id: normalizeText(record.last_lifecycle_id),
    last_transition_commitment: normalizeFeltForComparison(
      record.last_transition_commitment
    ),
    last_batch_id: normalizeText(record.last_batch_id),
    last_epoch_id: nonNegativeInteger(record.last_epoch_id, 0),
    opened_at_unix_ms: nonNegativeInteger(record.opened_at_unix_ms, 0),
    updated_at_unix_ms: nonNegativeInteger(record.updated_at_unix_ms, 0),
    fill_attributions: Array.isArray(record.fill_attributions)
      ? record.fill_attributions
          .map((entry) => {
            try {
              return normalizeLiquidityAttributionPlaintext(entry);
            } catch {
              return null;
            }
          })
          .filter((entry): entry is LiquidityAttributionPlaintext =>
            Boolean(entry)
          )
          .slice(-512)
      : undefined,
  };
}

function normalizeProtocolPrivateLiquidityPosition(
  value: unknown
): ProtocolPrivateLiquidityPosition {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid private liquidity position preimage");
  }
  const position = { ...(value as ProtocolPrivateLiquidityPosition) };
  const positionId = normalizeFeltForComparison(position.position_id);
  if (!positionId) {
    throw new Error("Private liquidity position preimage is missing position_id");
  }
  position.position_id = positionId;
  return position;
}

function protocolLiquidityPositionId(
  position: ProtocolPrivateLiquidityPosition
) {
  const positionId = normalizeFeltForComparison(position.position_id);
  if (!positionId) {
    throw new Error("Private liquidity position preimage is missing position_id");
  }
  return positionId;
}

function protocolLiquidityPairId(position: ProtocolPrivateLiquidityPosition) {
  const pairId = normalizeText(position.pair_id);
  if (!pairId) {
    throw new Error("Private liquidity position preimage is missing pair_id");
  }
  return pairId;
}

function normalizeLiquidityPositionStatus(
  status: unknown
): LocalLiquidityPositionStatus {
  if (
    status === "pending_open" ||
    status === "active" ||
    status === "pending_reconfigure" ||
    status === "pending_close" ||
    status === "closed"
  ) {
    return status;
  }
  return "active";
}

function isPendingLiquidityPositionStatus(status: LocalLiquidityPositionStatus) {
  return (
    status === "pending_open" ||
    status === "pending_reconfigure" ||
    status === "pending_close"
  );
}

export function shouldReleasePendingLiquidityPositionOpen(
  batch: BatchSummary | null | undefined,
  now: number
) {
  if (!batch) return false;
  if (batch.status === "Cancelled") return true;
  if (batch.status !== "Closed") return false;
  return (
    now - batch.close_time_unix_ms >=
    PENDING_LIQUIDITY_POSITION_OPEN_RELEASE_GRACE_MS
  );
}

function normalizeCommitmentLike(value: unknown) {
  if (typeof value === "string") return normalizeFeltForComparison(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = record["0"] ?? record.value;
    return typeof candidate === "string"
      ? normalizeFeltForComparison(candidate)
      : "";
  }
  return "";
}

function normalizeLiquidityAttributionPlaintext(
  value: unknown
): LiquidityAttributionPlaintext {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid liquidity attribution plaintext");
  }
  const record = value as Partial<LiquidityAttributionPlaintext>;
  const attribution = normalizeLiquidityBandAttribution(record.attribution);
  const batchId = normalizeText(record.batch_id);
  const pairId = normalizeText(record.pair_id);
  const owner = normalizeText(record.liquidity_provider_public_key);
  const curveCommitment = normalizeFeltForComparison(record.curve_commitment);
  const outputNoteCommitment = normalizeCommitmentLike(
    record.output_note_commitment
  );
  const epochId = nonNegativeInteger(record.epoch_id, -1);
  if (
    record.version !== 1 ||
    !batchId ||
    !pairId ||
    !owner ||
    !curveCommitment ||
    !outputNoteCommitment ||
    epochId < 0 ||
    attribution.pair_id !== pairId
  ) {
    throw new Error("Invalid liquidity attribution plaintext");
  }
  return {
    version: 1,
    batch_id: batchId,
    pair_id: pairId,
    epoch_id: epochId,
    liquidity_provider_public_key: owner,
    curve_commitment: curveCommitment,
    output_note_commitment: outputNoteCommitment,
    attribution,
  };
}

function normalizeLiquidityBandAttribution(
  value: unknown
): LiquidityBandAttribution {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid liquidity band attribution");
  }
  const record = value as Partial<LiquidityBandAttribution>;
  const side = record.side === "Buy" || record.side === "Sell" ? record.side : null;
  const pairId = normalizeText(record.pair_id);
  const orderCommitment = normalizeCommitmentLike(record.order_commitment);
  const fundingNoteRef = normalizeCommitmentLike(record.funding_note_ref);
  const clearingPrice = decimalString(record.clearing_price, "clearing price");
  const filledBaseAmount = decimalString(
    record.filled_base_amount,
    "filled base amount"
  );
  const bands = Array.isArray(record.bands)
    ? record.bands.map((band) => normalizeLiquidityBandFillAttribution(band))
    : [];
  if (
    record.version !== 1 ||
    !pairId ||
    !orderCommitment ||
    !fundingNoteRef ||
    !side ||
    bands.length === 0
  ) {
    throw new Error("Invalid liquidity band attribution");
  }
  bands.sort((left, right) => left.band_index - right.band_index);
  return {
    version: 1,
    pair_id: pairId,
    order_commitment: orderCommitment,
    funding_note_ref: fundingNoteRef,
    side,
    clearing_price: clearingPrice,
    filled_base_amount: filledBaseAmount,
    bands,
  };
}

function normalizeLiquidityBandFillAttribution(
  value: unknown
): LiquidityBandAttribution["bands"][number] {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid liquidity band fill attribution");
  }
  const record = value as Partial<LiquidityBandAttribution["bands"][number]>;
  const bandIndex = nonNegativeInteger(record.band_index, -1);
  const bandPrice = decimalString(record.band_price, "band price");
  const bandBaseAmount = decimalString(record.band_base_amount, "band amount");
  const filledBaseAmount = decimalString(
    record.filled_base_amount,
    "band filled amount"
  );
  if (bandIndex < 0 || filledBaseAmount === "0" || bandBaseAmount === "0") {
    throw new Error("Invalid liquidity band fill attribution");
  }
  return {
    band_index: bandIndex,
    band_price: bandPrice,
    band_base_amount: bandBaseAmount,
    filled_base_amount: filledBaseAmount,
  };
}

function decimalString(value: unknown, label: string) {
  const normalized =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number"
        ? Number.isSafeInteger(value)
          ? value.toString()
          : ""
        : typeof value === "string"
          ? value.trim()
          : "";
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return normalized;
}

function quarantineLocalStore(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Local cache is recoverable from recovery artifacts or rescanning visible outputs.
  }
}

function randomU64() {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return ((BigInt(bytes[0]) << 32n) | BigInt(bytes[1])).toString();
}

function randomFeltHex() {
  const bytes = new Uint8Array(32);
  do {
    crypto.getRandomValues(bytes);
    bytes[0] &= 0x07;
  } while (bytes.every((byte) => byte === 0));
  return `0x${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function randomBasisPointsJitter(maxAbsoluteBps: number) {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const span = maxAbsoluteBps * 2 + 1;
  return 10_000 - maxAbsoluteBps + (random[0] % span);
}

function randomPadding(targetBytes: number) {
  const bytes = new Uint8Array(targetBytes);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minValue: number,
  maxValue: number
) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minValue, Math.min(maxValue, parsed));
}
