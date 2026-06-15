import type { PairConfig, TicketSubmitIntent } from "../components/OrderTicket";
import type { MarketDataEngine } from "../domain/marketData";
import { assetScale, fromAtomicStr, toAtomicStr, toPriceAtomicStr } from "../domain/assets";
import {
  authorizeDelegatedMakerCurve,
  buildInventorySnapshot,
  buildManagedCurvePlan,
  compileManagedCurveIntent,
  pendingExposureFromOrders,
  reconcileMakerPnl,
  selectFairPrice,
  type DelegatedMakerPermission,
  type FairPricePolicy,
  type ManagedCurveDraft,
  type ManagedCurvePlan,
  type ManagedRiskPolicy,
  type ManagedStrategyConfig,
  type MarketObservation,
} from "../domain/managedLiquidity";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";
import type { WalletBalance } from "../domain/shieldedBalances";
import type { BatchSummary } from "../domain/auctionEpoch";
import type { OfflineRenewalPackage } from "../offlineRenewalOperator";
import { ZylithRelaySdk, type RelayPackageResults, type RelayPackageStatus } from "./relay";

export type MakerWalletRuntime = {
  submitPrivateOrder: (order: TicketSubmitIntent) => Promise<{
    offline_package?: OfflineRenewalPackage;
    strategy_id?: string;
    order_id?: string;
  }>;
  refreshPrivateStrategyPackage?: (strategyId: string) => Promise<OfflineRenewalPackage>;
  markPrivateStrategyRelayRegistered?: (strategyId: string) => Promise<boolean>;
  getPrivateStrategies?: () => PrivateStrategySummary[];
  getBalances?: () => WalletBalance[];
};

export type MakerSdkOptions = {
  relay?: ZylithRelaySdk;
};

export class MakerCurveSubmissionError extends Error {
  readonly partial: boolean;
  readonly strategyId?: string;
  readonly offlinePackage?: OfflineRenewalPackage;

  constructor(
    message: string,
    options: {
      partial: boolean;
      strategyId?: string;
      offlinePackage?: OfflineRenewalPackage;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "MakerCurveSubmissionError";
    this.partial = options.partial;
    this.strategyId = options.strategyId;
    this.offlinePackage = options.offlinePackage;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export type RawMakerOrderMode = "Limit" | "Maker Curve" | "TWAP" | "VWAP" | "Repeat" | "Resting";

export type RawMakerOrderDraft = {
  pair: string;
  side: "Buy" | "Sell";
  mode: RawMakerOrderMode;
  amount: string;
  limitPrice: string;
  minFill: string;
  fillOrKill: boolean;
  batchId: string;
  batchWindowMs?: number;
  childAmount?: string;
  durationBatches?: number;
  randomizedSlicing?: boolean;
  randomizedSlicingBps?: number;
  priceBaseScale?: string;
  offlineDelegation?: boolean;
  makerCurvePoints?: Array<{ price: string; baseAmount: string }>;
  makerInventoryCap?: string;
  relayMode?: "SelfRelay" | "ZylithRelay";
};

export type RawMakerWalletRuntime = Omit<MakerWalletRuntime, "submitPrivateOrder"> & {
  submitPrivateOrder: (order: RawMakerOrderDraft) => ReturnType<MakerWalletRuntime["submitPrivateOrder"]>;
};

export type MakerWalletRuntimeAdapterOptions = {
  runtime: RawMakerWalletRuntime;
  pairForIntent: (intent: TicketSubmitIntent) => PairConfig | null;
  currentBatch: (pair: PairConfig) => Promise<BatchSummary>;
  batchWindowMs?: number;
};

export class ZylithMakerSdk {
  private readonly relay?: ZylithRelaySdk;

  constructor(options: MakerSdkOptions = {}) {
    this.relay = options.relay;
  }

  buildCurves(input: {
    pair: PairConfig;
    balances: WalletBalance[];
    orders: LocalOrder[];
    marketObservations: MarketObservation[];
    fairPricePolicy: FairPricePolicy;
    strategy: ManagedStrategyConfig;
    risk: ManagedRiskPolicy;
    now?: number;
  }): ManagedCurvePlan {
    const fairPrice = selectFairPrice(
      input.pair.pair_id,
      input.marketObservations,
      input.fairPricePolicy,
      input.now
    );
    const balances = humanBalances(input.balances);
    const inventory = buildInventorySnapshot(
      input.pair,
      balances,
      pendingExposureFromOrders(input.orders),
      fairPrice.ok ? fairPrice.price : undefined
    );
    return buildManagedCurvePlan({
      pair: input.pair,
      fairPrice,
      inventory,
      config: input.strategy,
      risk: input.risk,
    });
  }

  async buildCurvesFromMarketData(input: {
    pair: PairConfig;
    balances: WalletBalance[];
    orders: LocalOrder[];
    marketData: MarketDataEngine;
    strategy: ManagedStrategyConfig;
    risk: ManagedRiskPolicy;
  }): Promise<ManagedCurvePlan> {
    const fairPrice = await input.marketData.fairPrice(input.pair.pair_id);
    const balances = humanBalances(input.balances);
    const inventory = buildInventorySnapshot(
      input.pair,
      balances,
      pendingExposureFromOrders(input.orders),
      fairPrice.ok ? fairPrice.price : undefined
    );
    return buildManagedCurvePlan({
      pair: input.pair,
      fairPrice,
      inventory,
      config: input.strategy,
      risk: input.risk,
    });
  }

  authorizeCurve(
    curve: ManagedCurveDraft,
    permission: DelegatedMakerPermission,
    now = Date.now()
  ) {
    return authorizeDelegatedMakerCurve(curve, curve.fairPrice, permission, now);
  }

  compileCurve(curve: ManagedCurveDraft): TicketSubmitIntent {
    return compileManagedCurveIntent(curve);
  }

  async submitCurve(wallet: MakerWalletRuntime, curve: ManagedCurveDraft): Promise<{
    offlinePackage?: OfflineRenewalPackage;
    relayStatus?: RelayPackageStatus;
    strategyId?: string;
  }> {
    const intent = this.compileCurve(curve);
    let submitted: Awaited<ReturnType<MakerWalletRuntime["submitPrivateOrder"]>>;
    try {
      submitted = await wallet.submitPrivateOrder(intent);
    } catch (error) {
      throw new MakerCurveSubmissionError(errorMessage(error), {
        partial: false,
        cause: error,
      });
    }
    let relayStatus: RelayPackageStatus | undefined;
    if (submitted.offline_package?.relay_mode === "ZylithRelay") {
      if (!this.relay) {
        throw new MakerCurveSubmissionError("Managed relay SDK is required for ZylithRelay packages", {
          partial: true,
          strategyId: submitted.strategy_id ?? submitted.order_id,
          offlinePackage: submitted.offline_package,
        });
      }
      try {
        relayStatus = await this.relay.registerPackage(submitted.offline_package);
      } catch (error) {
        throw new MakerCurveSubmissionError(`relay registration failed: ${errorMessage(error)}`, {
          partial: true,
          strategyId: submitted.strategy_id ?? submitted.order_id,
          offlinePackage: submitted.offline_package,
          cause: error,
        });
      }
      if (submitted.strategy_id && wallet.markPrivateStrategyRelayRegistered) {
        await wallet.markPrivateStrategyRelayRegistered(submitted.strategy_id);
      }
    }
    return {
      offlinePackage: submitted.offline_package,
      relayStatus,
      strategyId: submitted.strategy_id ?? submitted.order_id,
    };
  }

  async refreshPackage(wallet: MakerWalletRuntime, strategyId: string): Promise<{
    renewalPackage: OfflineRenewalPackage;
    relayStatus?: RelayPackageStatus;
  }> {
    if (!wallet.refreshPrivateStrategyPackage) throw new Error("Wallet runtime cannot refresh strategy packages");
    const renewalPackage = await wallet.refreshPrivateStrategyPackage(strategyId);
    let relayStatus: RelayPackageStatus | undefined;
    if (renewalPackage.relay_mode === "ZylithRelay") {
      if (!this.relay) throw new Error("Managed relay SDK is required for ZylithRelay packages");
      relayStatus = await this.relay.registerPackage(renewalPackage);
      await wallet.markPrivateStrategyRelayRegistered?.(strategyId);
    }
    return { renewalPackage, relayStatus };
  }

  async relayResults(renewalPackage: OfflineRenewalPackage): Promise<RelayPackageResults | null> {
    if (!this.relay) return null;
    return this.relay.packageResults({
      package_id: renewalPackage.package_id,
      package_commitment: renewalPackage.package_commitment,
      parent_cancel_authority: renewalPackage.parent_cancel_authority,
      relay_authorization: renewalPackage.relay_authorization,
    });
  }

  inventory(pair: PairConfig, balances: WalletBalance[], orders: LocalOrder[], referencePrice?: number) {
    return buildInventorySnapshot(pair, humanBalances(balances), pendingExposureFromOrders(orders), referencePrice);
  }

  pnl(pair: string, orders: LocalOrder[]) {
    return reconcileMakerPnl(pair, orders);
  }
}

function humanBalances(balances: WalletBalance[]): WalletBalance[] {
  return balances.map((balance) => ({
    asset: balance.asset,
    available: fromAtomicStr(balance.available, balance.asset),
    locked: fromAtomicStr(balance.locked, balance.asset),
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMakerWalletRuntimeAdapter(
  options: MakerWalletRuntimeAdapterOptions
): MakerWalletRuntime {
  return {
    ...options.runtime,
    submitPrivateOrder: async (intent) => {
      const pair = options.pairForIntent(intent);
      if (!pair) throw new Error("Managed maker intent references an unknown pair");
      const batch = await options.currentBatch(pair);
      if (intent.shape !== "curve") {
        throw new Error("Managed maker adapter only supports curve intents");
      }
      const curve = compileRawCurveIntent(intent, pair);
      return options.runtime.submitPrivateOrder({
        pair: pair.pair_id,
        side: intent.side,
        mode: intent.resting ? "Resting" : "Maker Curve",
        amount: curve.curveBaseTotal.toString(),
        limitPrice: curve.curveEnvelopePrice,
        minFill: toAtomicStr(intent.minFill || "0", pair.base_asset_id),
        fillOrKill: intent.fillOrKill,
        batchId: batch.batch_id,
        batchWindowMs: options.batchWindowMs,
        makerCurvePoints: curve.atomicCurvePoints,
        makerInventoryCap: curve.atomicMakerInventoryCap,
        priceBaseScale: curve.priceBaseScale,
        durationBatches:
          intent.resting && intent.durationHours && options.batchWindowMs
            ? Math.ceil((Number(intent.durationHours) * 3_600_000) / options.batchWindowMs)
            : undefined,
        childAmount: intent.childSize ? toAtomicStr(intent.childSize, pair.base_asset_id) : undefined,
        randomizedSlicing: intent.jitter > 0,
        randomizedSlicingBps: intent.jitter * 100,
        offlineDelegation:
          intent.resting &&
          (intent.relayMode === "ZylithRelay" || intent.relayOperator === "SelfHostedRelay"),
        relayMode: intent.relayMode ?? "SelfRelay",
      });
    },
  };
}

function compileRawCurveIntent(intent: TicketSubmitIntent, pair: PairConfig) {
  const atomicCurvePoints = intent.curvePoints
    .filter((point) => point.price.trim() && point.baseAmount.trim())
    .map((point) => ({
      price: toPriceAtomicStr(point.price, pair.quote_asset_id),
      baseAmount: toAtomicStr(point.baseAmount, pair.base_asset_id),
    }));
  const sortedCurvePoints = [...atomicCurvePoints].sort((left, right) =>
    BigInt(left.price) < BigInt(right.price)
      ? -1
      : BigInt(left.price) > BigInt(right.price)
        ? 1
        : 0
  );
  const curveBaseTotal = sortedCurvePoints.reduce(
    (total, point) => total + BigInt(point.baseAmount),
    0n
  );
  const curveEnvelopePrice =
    sortedCurvePoints.length > 0
      ? intent.side === "Buy"
        ? sortedCurvePoints[sortedCurvePoints.length - 1].price
        : sortedCurvePoints[0].price
      : "0";
  const priceBaseScale = pair.price_base_scale ?? assetScale(pair.base_asset_id).toString();
  const atomicMakerInventoryCap = intent.inventoryCap.trim()
    ? toAtomicStr(intent.inventoryCap, pair.base_asset_id)
    : undefined;
  return {
    atomicCurvePoints,
    curveBaseTotal,
    curveEnvelopePrice,
    priceBaseScale,
    atomicMakerInventoryCap:
      atomicMakerInventoryCap && BigInt(atomicMakerInventoryCap) > 0n
        ? atomicMakerInventoryCap
        : undefined,
  };
}
