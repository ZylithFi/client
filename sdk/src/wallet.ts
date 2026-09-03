import type { OfflineRenewalPackage } from "./relay.js";
import type {
  PrivateLiquidityPositionLifecycleAuthorizationRequest,
  PrivateLiquidityPositionLifecycleRequest,
  PrivateLiquidityPositionOpenRequest,
} from "./liquidity.js";
import type {
  BatchSummary,
  TicketSubmitIntent,
  WithdrawableNote,
} from "./common.js";

export type PrivateOrderSubmission = {
  order_id?: string;
  order_commitment?: string;
  batch_id?: string;
  epoch_id?: number;
  status?: string;
  offline_package?: OfflineRenewalPackage;
  strategy_id?: string;
};

export type PrivateReportRequest = {
  batch_id: string;
  orders?: Array<{ order_commitment: string; cancellation_secret: string }>;
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

export type PrivateLiquidityPositionLifecycleResult = {
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

export type TraderWalletRuntime = {
  submitPrivateOrder: (order: TicketSubmitIntent) => Promise<PrivateOrderSubmission>;
  syncPrivateSettlementReports?: (requests: PrivateReportRequest[]) => Promise<unknown[]>;
  scanNotes?: () => Promise<boolean>;
  submitStrk20Withdrawal?: (request: { note_commitment: string; asset?: string }) => Promise<unknown>;
  getWithdrawableNotes?: () => WithdrawableNote[];
};

export type LiquidityPositionWalletRuntime = {
  openPrivateLiquidityPosition?: (
    request: PrivateLiquidityPositionOpenRequest,
    candidateBatch?: BatchSummary
  ) => Promise<PrivateLiquidityPositionOpenResult>;
  reconfigurePrivateLiquidityPosition?: (
    request: Extract<
      PrivateLiquidityPositionLifecycleRequest,
      { kind: "ReconfigurePrivateLiquidityPosition" }
    >,
    candidateBatch?: BatchSummary
  ) => Promise<PrivateLiquidityPositionLifecycleResult>;
  closePrivateLiquidityPosition?: (
    request: Extract<
      PrivateLiquidityPositionLifecycleRequest,
      { kind: "ClosePrivateLiquidityPosition" }
    >,
    candidateBatch?: BatchSummary
  ) => Promise<PrivateLiquidityPositionLifecycleResult>;
  authorizePrivateLiquidityPositionOpen?: (
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest
  ) => PrivateLiquidityPositionLifecycleAuthorization;
  authorizePrivateLiquidityPositionReconfigure?: (
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest
  ) => PrivateLiquidityPositionLifecycleAuthorization;
  authorizePrivateLiquidityPositionClose?: (
    request: PrivateLiquidityPositionLifecycleAuthorizationRequest
  ) => PrivateLiquidityPositionLifecycleAuthorization;
};
