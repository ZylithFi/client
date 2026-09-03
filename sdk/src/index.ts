import type {
  BatchSummary,
  TicketSubmitIntent,
} from "./common.js";
import { ZylithRelaySdk, relayAccessHeaders } from "./relay.js";
import { ZylithTraderSdk } from "./trader.js";
import type {
  PrivateLiquidityPositionCloseRequest,
  PrivateLiquidityPositionOpenRequest,
  PrivateLiquidityPositionReconfigureRequest,
} from "./liquidity.js";
import type {
  LiquidityPositionWalletRuntime,
  PrivateLiquidityPositionLifecycleResult,
  PrivateLiquidityPositionOpenResult,
  PrivateOrderSubmission,
  PrivateReportRequest,
  TraderWalletRuntime,
} from "./wallet.js";
import type {
  OfflineRenewalPackage,
  PackageAuthFields,
  RelayPackageResults,
  RelayPackageStatus,
  SelfHostedRelayExecutor,
} from "./relay.js";
import type { PublicProofJobStatus, SettlementOutputWithdrawalOptions } from "./trader.js";

export {
  DEFAULT_ASSET_DECIMALS,
  DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
  DEFAULT_SDK_REQUEST_TIMEOUT_MS,
  DEFAULT_SDK_RESPONSE_MAX_BYTES,
  MAX_MARKET_OBSERVATION_FUTURE_SKEW_MS,
  MarketDataEngine,
  assetDecimals,
  assetScale,
  buildLiquidityOpsSnapshot,
  configureAssetDecimals,
  createHttpJsonPriceSource,
  createPairScopedPriceSource,
  createRatioPriceSource,
  createStarknetOraclePriceSource,
  fetchWithSdkTimeout,
  fromAtomicStr,
  normalizeSdkServiceUrl,
  parseBatchSummary,
  readJsonPath,
  readSdkJsonResponse,
  readSdkResponseText,
  sanitizeSdkErrorMessage,
  selectFairPrice,
  toAtomicStr,
  toPriceAtomicStr,
} from "./common.js";
export type {
  BatchSummary,
  FairPricePolicy,
  FairPriceResult,
  HttpJsonPriceSourceOptions,
  LiquidityOpsSnapshot,
  LocalOrder,
  MarketDataEngineOptions,
  MarketDataSource,
  MarketObservation,
  OrderSide,
  PairConfig,
  PendingExposure,
  PrivateStrategySummary,
  RatioPriceSourceOptions,
  RelayMode,
  SdkResponseReadOptions,
  StarknetOraclePriceSourceOptions,
  TicketSubmitIntent,
  WalletBalance,
  WithdrawableNote,
} from "./common.js";
export type {
  LiquidityPositionWalletRuntime,
  PrivateLiquidityPositionLifecycleAuthorization,
  PrivateLiquidityPositionLifecycleResult,
  PrivateLiquidityPositionOpenResult,
  PrivateOrderSubmission,
  PrivateReportRequest,
  TraderWalletRuntime,
} from "./wallet.js";
export * from "./liquidity.js";
export { relayAccessHeaders };
export type {
  OfflineRenewalPackage,
  OfflineRenewalRelayResult,
  PackageAuthFields,
  RelayPackageResults,
  RelayPackageStatus,
  SelfHostedRelayExecutor,
} from "./relay.js";
export type {
  PublicProofJobStatus,
  SdkRequestOptions,
  SettlementOutputWithdrawalOptions,
  WaitForSettlementOptions,
} from "./trader.js";

export type ZylithSdkOptions = {
  coordinatorUrl?: string;
  proverUrl?: string;
  relayUrl?: string;
  relay?: ZylithRelayRuntime;
  fetchImpl?: typeof fetch;
};

export type ZylithRelayRuntime = {
  registerPackage: (renewalPackage: OfflineRenewalPackage) => Promise<RelayPackageStatus>;
  packageStatus: (renewalPackage: PackageAuthFields) => Promise<RelayPackageStatus | null>;
  packageResults: (renewalPackage: PackageAuthFields) => Promise<RelayPackageResults | null>;
  tombstonePackage: (renewalPackage: PackageAuthFields) => Promise<boolean>;
  relaySelfHostedPackage: (
    renewalPackage: OfflineRenewalPackage,
    executor: SelfHostedRelayExecutor,
    options?: {
      coordinatorUrl?: string;
      proverUrl?: string;
      submittedOrderCommitments?: Iterable<string>;
      verifyPackage?: (renewalPackage: OfflineRenewalPackage) => Promise<boolean> | boolean;
    }
  ) => Promise<unknown[]>;
};

export class ZylithSdk {
  private readonly trader?: ZylithTraderSdk;
  private readonly relay?: ZylithRelayRuntime;

  constructor(options: ZylithSdkOptions = {}) {
    if ((options.coordinatorUrl && !options.proverUrl) || (!options.coordinatorUrl && options.proverUrl)) {
      throw new Error("coordinatorUrl and proverUrl must be configured together");
    }
    if (options.relay && options.relayUrl) {
      throw new Error("configure either relay or relayUrl, not both");
    }

    this.relay = options.relay ?? (
      options.relayUrl
        ? new ZylithRelaySdk({ relayUrl: options.relayUrl, fetchImpl: options.fetchImpl })
        : undefined
    );
    this.trader = options.coordinatorUrl && options.proverUrl
      ? new ZylithTraderSdk({
          coordinatorUrl: options.coordinatorUrl,
          proverUrl: options.proverUrl,
          fetchImpl: options.fetchImpl,
        })
      : undefined;
  }

  submittableBatch(pair: string, options: import("./trader.js").SdkRequestOptions = {}): Promise<BatchSummary> {
    return this.requireTrader().submittableBatch(pair, options);
  }

  submitPrivateOrder(wallet: TraderWalletRuntime, order: TicketSubmitIntent): Promise<PrivateOrderSubmission> {
    return this.requireTrader().submitPrivateOrder(wallet, order);
  }

  openPrivateLiquidityPosition(
    wallet: LiquidityPositionWalletRuntime,
    request: PrivateLiquidityPositionOpenRequest,
    options: import("./trader.js").SdkRequestOptions = {}
  ): Promise<PrivateLiquidityPositionOpenResult> {
    return this.requireTrader().openPrivateLiquidityPosition(wallet, request, options);
  }

  reconfigurePrivateLiquidityPosition(
    wallet: LiquidityPositionWalletRuntime,
    pair: string,
    request: PrivateLiquidityPositionReconfigureRequest,
    options: import("./trader.js").SdkRequestOptions = {}
  ): Promise<PrivateLiquidityPositionLifecycleResult> {
    return this.requireTrader().reconfigurePrivateLiquidityPosition(wallet, pair, request, options);
  }

  closePrivateLiquidityPosition(
    wallet: LiquidityPositionWalletRuntime,
    pair: string,
    request: PrivateLiquidityPositionCloseRequest,
    options: import("./trader.js").SdkRequestOptions = {}
  ): Promise<PrivateLiquidityPositionLifecycleResult> {
    return this.requireTrader().closePrivateLiquidityPosition(wallet, pair, request, options);
  }

  proofStatus(
    batchId: string,
    options: import("./trader.js").SdkRequestOptions = {}
  ): Promise<PublicProofJobStatus | null> {
    return this.requireTrader().proofStatus(batchId, options);
  }

  waitForSettlement(
    batchId: string,
    options: import("./trader.js").WaitForSettlementOptions = {}
  ): Promise<PublicProofJobStatus> {
    return this.requireTrader().waitForSettlement(batchId, options);
  }

  recoverOutputs(wallet: TraderWalletRuntime, requests: PrivateReportRequest[]): Promise<unknown[]> {
    return this.requireTrader().recoverOutputs(wallet, requests);
  }

  withdraw(wallet: TraderWalletRuntime, noteCommitment: string, asset?: string): Promise<unknown> {
    return this.requireTrader().withdraw(wallet, noteCommitment, asset);
  }

  withdrawSettlementOutput(
    wallet: TraderWalletRuntime,
    options: SettlementOutputWithdrawalOptions = {}
  ): Promise<unknown> {
    return this.requireTrader().withdrawSettlementOutput(wallet, options);
  }

  registerPackage(renewalPackage: OfflineRenewalPackage): Promise<RelayPackageStatus> {
    return this.requireRelay().registerPackage(renewalPackage);
  }

  packageStatus(renewalPackage: PackageAuthFields): Promise<RelayPackageStatus | null> {
    return this.requireRelay().packageStatus(renewalPackage);
  }

  packageResults(renewalPackage: PackageAuthFields): Promise<RelayPackageResults | null> {
    return this.requireRelay().packageResults(renewalPackage);
  }

  tombstonePackage(renewalPackage: PackageAuthFields): Promise<boolean> {
    return this.requireRelay().tombstonePackage(renewalPackage);
  }

  relaySelfHostedPackage(
    renewalPackage: OfflineRenewalPackage,
    executor: SelfHostedRelayExecutor,
    options: {
      coordinatorUrl?: string;
      proverUrl?: string;
      submittedOrderCommitments?: Iterable<string>;
      verifyPackage?: (renewalPackage: OfflineRenewalPackage) => Promise<boolean> | boolean;
    } = {}
  ) {
    return this.requireRelay().relaySelfHostedPackage(renewalPackage, executor, options);
  }

  relayAccessHeaders(renewalPackage: PackageAuthFields): Record<string, string> {
    return relayAccessHeaders(renewalPackage);
  }

  private requireTrader(): ZylithTraderSdk {
    if (!this.trader) throw new Error("coordinatorUrl and proverUrl are required for trader operations");
    return this.trader;
  }

  private requireRelay(): ZylithRelayRuntime {
    if (!this.relay) throw new Error("relayUrl or relay is required for renewal relay operations");
    return this.relay;
  }
}
