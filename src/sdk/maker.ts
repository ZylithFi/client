import type { PairConfig, TicketSubmitIntent } from "../components/OrderTicket";
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
    const inventory = buildInventorySnapshot(
      input.pair,
      input.balances,
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
    const submitted = await wallet.submitPrivateOrder(intent);
    let relayStatus: RelayPackageStatus | undefined;
    if (submitted.offline_package?.relay_mode === "ZylithRelay") {
      if (!this.relay) throw new Error("Managed relay SDK is required for ZylithRelay packages");
      relayStatus = await this.relay.registerPackage(submitted.offline_package);
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
    return buildInventorySnapshot(pair, balances, pendingExposureFromOrders(orders), referencePrice);
  }

  pnl(pair: string, orders: LocalOrder[]) {
    return reconcileMakerPnl(pair, orders);
  }
}
