import type { OfflineRenewalPackage } from "./relay.js";
import type { PrivateStrategySummary, TicketSubmitIntent, WalletBalance, WithdrawableNote } from "./common.js";

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
  order_commitments: string[];
  orders?: Array<{ order_commitment: string; cancellation_secret: string }>;
};

export type TraderWalletRuntime = {
  submitPrivateOrder: (order: TicketSubmitIntent) => Promise<PrivateOrderSubmission>;
  syncPrivateSettlementReports?: (requests: PrivateReportRequest[]) => Promise<unknown[]>;
  scanNotes?: () => Promise<boolean>;
  submitHostedWithdrawal?: (request: { note_commitment: string; asset?: string }) => Promise<unknown>;
  getWithdrawableNotes?: () => WithdrawableNote[];
};

export type MakerWalletRuntime = {
  submitPrivateOrder: (order: TicketSubmitIntent) => Promise<PrivateOrderSubmission>;
  refreshPrivateStrategyPackage?: (strategyId: string) => Promise<OfflineRenewalPackage>;
  markPrivateStrategyRelayRegistered?: (strategyId: string) => Promise<boolean>;
  getPrivateStrategies?: () => PrivateStrategySummary[];
  getBalances?: () => WalletBalance[];
};
