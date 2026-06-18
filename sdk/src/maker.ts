import {
  assetScale,
  authorizeDelegatedMakerCurve,
  authorizeManagedMakerCurvePolicy,
  buildInventorySnapshot,
  buildMakerOpsSnapshot,
  buildManagedCurvePlan,
  compileManagedCurveIntent,
  fromAtomicStr,
  pendingExposureFromOrders,
  reconcileMakerPnl,
  selectFairPrice,
  toAtomicStr,
  toPriceAtomicStr,
  validateManagedCurveDraft,
  type BatchSummary,
  type DelegatedMakerPermission,
  type FairPricePolicy,
  type FairPriceResult,
  type LocalOrder,
  type MakerOpsSnapshot,
  type ManagedMakerAuthorization,
  type ManagedCurveDraft,
  type ManagedCurvePlan,
  type ManagedRiskPolicy,
  type ManagedStrategyConfig,
  type MarketDataEngine,
  type MarketObservation,
  type PairConfig,
  type PrivateStrategySummary,
  type TicketSubmitIntent,
  type WalletBalance,
} from "./common.js";
import { type MakerWalletRuntime, type PrivateOrderSubmission } from "./wallet.js";
import { ZylithRelaySdk, type OfflineRenewalPackage, type RelayPackageResults, type RelayPackageStatus } from "./relay.js";

export type { MakerWalletRuntime } from "./wallet.js";

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

  authorizeCurve(curve: ManagedCurveDraft, permission: DelegatedMakerPermission, now = Date.now()) {
    return authorizeDelegatedMakerCurve(curve, curve.fairPrice, permission, now);
  }

  compileCurve(curve: ManagedCurveDraft): TicketSubmitIntent {
    const invalid = validateManagedCurveDraft(curve);
    if (invalid) throw new Error(invalid);
    return compileManagedCurveIntent(curve);
  }

  async submitCurve(
    wallet: MakerWalletRuntime,
    curve: ManagedCurveDraft,
    managedMakerAuthorization?: ManagedMakerAuthorization
  ): Promise<{
    offlinePackage?: OfflineRenewalPackage;
    relayStatus?: RelayPackageStatus;
    strategyId?: string;
  }> {
    const intent = this.compileCurve(curve);
    let submitted: PrivateOrderSubmission;
    try {
      submitted = managedMakerAuthorization
        ? await requiredDelegatedSubmit(wallet)(intent, managedMakerAuthorization)
        : await requiredDirectSubmit(wallet)(intent);
    } catch (error) {
      throw new MakerCurveSubmissionError(errorMessage(error), { partial: false, cause: error });
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
  submitPrivateOrder: (order: RawMakerOrderDraft) => Promise<PrivateOrderSubmission>;
};

export type MakerWalletRuntimeAdapterOptions = {
  runtime: RawMakerWalletRuntime;
  pairForIntent: (intent: TicketSubmitIntent) => PairConfig | null;
  currentBatch: (pair: PairConfig) => Promise<BatchSummary>;
  batchWindowMs?: number;
};

export function createMakerWalletRuntimeAdapter(
  options: MakerWalletRuntimeAdapterOptions
): MakerWalletRuntime {
  return {
    ...options.runtime,
    submitPrivateOrder: async (intent) => {
      const pair = options.pairForIntent(intent);
      if (!pair) throw new Error("Managed maker intent references an unknown pair");
      const batch = await options.currentBatch(pair);
      if (intent.shape !== "curve") throw new Error("Managed maker adapter only supports curve intents");
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

export type ManagedMakerRunnerRuntime = MakerWalletRuntime & {
  getBalances: () => WalletBalance[];
  getOrders: () => LocalOrder[];
  getPrivateStrategies?: () => PrivateStrategySummary[];
};

export type ManagedMakerRunnerStrategy = {
  id: string;
  pair: PairConfig;
  strategy: ManagedStrategyConfig;
  risk: ManagedRiskPolicy;
  permission?: DelegatedMakerPermission;
  managedMakerAuthorization?: ManagedMakerAuthorization;
  enabled?: boolean;
};

export type ManagedMakerRunnerState = {
  submittedEpochs: Record<string, ManagedMakerEpochSubmission>;
  failures: ManagedMakerFailure[];
  lastRunAt?: number;
};

export type ManagedMakerEpochSubmission = {
  strategyId: string;
  pair: string;
  batchId: string;
  epochId: number;
  submittedAt: number;
  curveCount: number;
  strategyIds: string[];
  packageIds: string[];
};

export type ManagedMakerFailure = {
  strategyId: string;
  pair: string;
  batchId?: string;
  epochId?: number;
  at: number;
  reason: string;
};

export type ManagedMakerRunnerStore = {
  loadState?: () => Promise<ManagedMakerRunnerState | null> | ManagedMakerRunnerState | null;
  saveState?: (state: ManagedMakerRunnerState) => Promise<void> | void;
};

export type ManagedMakerRunnerEvent =
  | { type: "submitted"; strategyId: string; pair: string; batchId: string; epochId: number; curveCount: number }
  | { type: "skipped"; strategyId: string; pair: string; batchId?: string; epochId?: number; reason: string }
  | { type: "failed"; strategyId: string; pair: string; batchId?: string; epochId?: number; reason: string };

export type ManagedMakerRunnerTelemetry = {
  submitted: number;
  skipped: number;
  failed: number;
  lastEventAt?: number;
  lastSubmittedAt?: number;
  lastSkippedAt?: number;
  lastFailedAt?: number;
  lastFailureReason?: string;
};

export type ManagedMakerRunnerOptions = {
  sdk: ZylithMakerSdk;
  runtime: ManagedMakerRunnerRuntime;
  marketData: MarketDataEngine;
  strategies: ManagedMakerRunnerStrategy[];
  currentBatch: (pair: PairConfig) => Promise<BatchSummary>;
  store?: ManagedMakerRunnerStore;
  now?: () => number;
  submissionSafetyBufferMs?: number;
  intervalMs?: number;
  maxFailuresRetained?: number;
  requireQuoteOnlyAuthorization?: boolean;
  onEvent?: (event: ManagedMakerRunnerEvent) => void;
};

export type ManagedMakerRunResult = {
  submitted: ManagedMakerEpochSubmission[];
  skipped: Array<{ strategyId: string; pair: string; batchId?: string; epochId?: number; reason: string }>;
  failed: ManagedMakerFailure[];
  state: ManagedMakerRunnerState;
};

export class ZylithManagedMakerRunner {
  private readonly sdk: ZylithMakerSdk;
  private readonly runtime: ManagedMakerRunnerRuntime;
  private readonly marketData: MarketDataEngine;
  private readonly strategies: ManagedMakerRunnerStrategy[];
  private readonly currentBatch: (pair: PairConfig) => Promise<BatchSummary>;
  private readonly store?: ManagedMakerRunnerStore;
  private readonly now: () => number;
  private readonly submissionSafetyBufferMs: number;
  private readonly intervalMs: number;
  private readonly maxFailuresRetained: number;
  private readonly requireQuoteOnlyAuthorization: boolean;
  private readonly onEvent?: (event: ManagedMakerRunnerEvent) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private state: ManagedMakerRunnerState = emptyState();
  private telemetry: ManagedMakerRunnerTelemetry = emptyTelemetry();

  constructor(options: ManagedMakerRunnerOptions) {
    this.sdk = options.sdk;
    this.runtime = options.runtime;
    this.marketData = options.marketData;
    this.strategies = options.strategies;
    this.currentBatch = options.currentBatch;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.submissionSafetyBufferMs = options.submissionSafetyBufferMs ?? 15_000;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.maxFailuresRetained = options.maxFailuresRetained ?? 50;
    this.requireQuoteOnlyAuthorization = options.requireQuoteOnlyAuthorization ?? false;
    this.onEvent = options.onEvent;
  }

  async runOnce(): Promise<ManagedMakerRunResult> {
    if (this.running) {
      return {
        submitted: [],
        skipped: [{ strategyId: "*", pair: "*", reason: "runner already active" }],
        failed: [],
        state: this.state,
      };
    }
    this.running = true;
    const submitted: ManagedMakerEpochSubmission[] = [];
    const skipped: ManagedMakerRunResult["skipped"] = [];
    const failed: ManagedMakerFailure[] = [];
    try {
      this.state = await this.loadState();
      const balances = this.runtime.getBalances();
      const orders = this.runtime.getOrders();
      for (const entry of this.strategies) {
        if (entry.enabled === false) {
          skipped.push(this.skip(entry, "strategy disabled"));
          continue;
        }
        try {
          const result = await this.runStrategy(entry, balances, orders);
          if (result.kind === "submitted") submitted.push(result.submission);
          if (result.kind === "skipped") skipped.push(result.skip);
        } catch (error) {
          const failure = this.recordFailure(entry, error);
          failed.push(failure);
        }
      }
      this.state.lastRunAt = this.now();
      await this.persistState();
      return { submitted, skipped, failed, state: this.state };
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async opsSnapshot(): Promise<MakerOpsSnapshot> {
    const strategies = this.runtime.getPrivateStrategies?.() ?? [];
    const orders = this.runtime.getOrders();
    const balances = this.runtime.getBalances();
    const fairPrices = await Promise.all(
      [...new Set(this.strategies.map((strategy) => strategy.pair.pair_id))]
        .map((pair) => this.marketData.fairPrice(pair))
    );
    return buildMakerOpsSnapshot({ strategies, orders, balances, fairPrices });
  }

  currentState(): ManagedMakerRunnerState {
    return cloneState(this.state);
  }

  telemetrySnapshot(): ManagedMakerRunnerTelemetry {
    return { ...this.telemetry };
  }

  private async runStrategy(
    entry: ManagedMakerRunnerStrategy,
    balances: WalletBalance[],
    orders: LocalOrder[]
  ): Promise<
    | { kind: "submitted"; submission: ManagedMakerEpochSubmission }
    | { kind: "skipped"; skip: ManagedMakerRunResult["skipped"][number] }
  > {
    const batch = await this.currentBatch(entry.pair);
    if (batch.status !== "Open") return { kind: "skipped", skip: this.skip(entry, `batch is ${batch.status}`, batch) };
    const remainingMs = batch.close_time_unix_ms - this.now();
    if (remainingMs <= this.submissionSafetyBufferMs) {
      return { kind: "skipped", skip: this.skip(entry, "inside submission safety buffer", batch) };
    }
    const key = epochKey(entry.id, batch.batch_id);
    if (this.state.submittedEpochs[key]) return { kind: "skipped", skip: this.skip(entry, "epoch already submitted", batch) };
    const plan = await this.sdk.buildCurvesFromMarketData({
      pair: entry.pair,
      balances,
      orders,
      marketData: this.marketData,
      strategy: entry.strategy,
      risk: entry.risk,
    });
    if (!plan.ok) return { kind: "skipped", skip: this.skip(entry, plan.reason, batch) };
    const curves = authorizedCurves(plan, entry, batch.epoch_id, this.now());
    if (curves.length === 0) {
      return { kind: "skipped", skip: this.skip(entry, "managed maker policy rejects all curves", batch) };
    }
    if (this.requireQuoteOnlyAuthorization && !entry.managedMakerAuthorization) {
      return { kind: "skipped", skip: this.skip(entry, "missing managed maker quote-only authorization", batch) };
    }
    if (entry.managedMakerAuthorization && !this.runtime.submitDelegatedPrivateOrder) {
      return { kind: "skipped", skip: this.skip(entry, "runtime cannot submit delegated managed maker orders", batch) };
    }
    const submission: ManagedMakerEpochSubmission = {
      strategyId: entry.id,
      pair: entry.pair.pair_id,
      batchId: batch.batch_id,
      epochId: batch.epoch_id,
      submittedAt: this.now(),
      curveCount: 0,
      strategyIds: [],
      packageIds: [],
    };
    this.state.submittedEpochs[key] = submission;
    await this.persistState();
    try {
      for (const curve of curves) {
        const result = await this.sdk.submitCurve(this.runtime, curve, entry.managedMakerAuthorization);
        if (result.strategyId) submission.strategyIds.push(result.strategyId);
        if (result.offlinePackage?.package_id) submission.packageIds.push(result.offlinePackage.package_id);
        submission.curveCount += 1;
        this.state.submittedEpochs[key] = submission;
        await this.persistState();
      }
    } catch (error) {
      if (error instanceof MakerCurveSubmissionError && error.partial) {
        if (error.strategyId) submission.strategyIds.push(error.strategyId);
        if (error.offlinePackage?.package_id) submission.packageIds.push(error.offlinePackage.package_id);
        this.state.submittedEpochs[key] = submission;
      } else if (!hasPartialSubmission(submission)) {
        delete this.state.submittedEpochs[key];
      }
      await this.persistState();
      throw error;
    }
    this.emit({
      type: "submitted",
      strategyId: entry.id,
      pair: entry.pair.pair_id,
      batchId: batch.batch_id,
      epochId: batch.epoch_id,
      curveCount: curves.length,
    });
    return { kind: "submitted", submission };
  }

  private skip(entry: ManagedMakerRunnerStrategy, reason: string, batch?: BatchSummary) {
    const skipped = {
      strategyId: entry.id,
      pair: entry.pair.pair_id,
      batchId: batch?.batch_id,
      epochId: batch?.epoch_id,
      reason,
    };
    this.emit({ type: "skipped", ...skipped });
    return skipped;
  }

  private recordFailure(entry: ManagedMakerRunnerStrategy, error: unknown): ManagedMakerFailure {
    const failure = {
      strategyId: entry.id,
      pair: entry.pair.pair_id,
      at: this.now(),
      reason: error instanceof Error ? error.message : String(error),
    };
    this.state.failures = [...this.state.failures, failure].slice(-this.maxFailuresRetained);
    this.emit({ type: "failed", ...failure });
    return failure;
  }

  private async loadState(): Promise<ManagedMakerRunnerState> {
    const loaded = await this.store?.loadState?.();
    return normalizeState(loaded);
  }

  private async persistState(): Promise<void> {
    await this.store?.saveState?.(cloneState(this.state));
  }

  private emit(event: ManagedMakerRunnerEvent): void {
    const now = this.now();
    this.telemetry.lastEventAt = now;
    if (event.type === "submitted") {
      this.telemetry.submitted += 1;
      this.telemetry.lastSubmittedAt = now;
    } else if (event.type === "skipped") {
      this.telemetry.skipped += 1;
      this.telemetry.lastSkippedAt = now;
    } else {
      this.telemetry.failed += 1;
      this.telemetry.lastFailedAt = now;
      this.telemetry.lastFailureReason = event.reason;
    }
    this.onEvent?.(event);
  }
}

function humanBalances(balances: WalletBalance[]): WalletBalance[] {
  return balances.map((balance) => ({
    asset: balance.asset,
    available: fromAtomicStr(balance.available, balance.asset),
    locked: fromAtomicStr(balance.locked, balance.asset),
  }));
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
  const curveBaseTotal = sortedCurvePoints.reduce((total, point) => total + BigInt(point.baseAmount), 0n);
  const curveEnvelopePrice =
    sortedCurvePoints.length > 0
      ? intent.side === "Buy"
        ? sortedCurvePoints[sortedCurvePoints.length - 1].price
        : sortedCurvePoints[0].price
      : "0";
  if (sortedCurvePoints.length < 3) {
    throw new MakerCurveSubmissionError("Maker curves require at least 3 filled bands.", {
      partial: false,
    });
  }
  const priceBaseScale = pair.price_base_scale ?? assetScale(pair.base_asset_id).toString();
  const atomicMakerInventoryCap = intent.inventoryCap.trim()
    ? toAtomicStr(intent.inventoryCap, pair.base_asset_id)
    : undefined;
  return {
    atomicCurvePoints: sortedCurvePoints,
    curveBaseTotal,
    curveEnvelopePrice,
    priceBaseScale,
    atomicMakerInventoryCap:
      atomicMakerInventoryCap && BigInt(atomicMakerInventoryCap) > 0n
        ? atomicMakerInventoryCap
        : undefined,
  };
}

function authorizedCurves(
  plan: ManagedCurvePlan & { ok: true },
  entry: ManagedMakerRunnerStrategy,
  epochId: number,
  now: number
): ManagedCurveDraft[] {
  return plan.curves.filter((curve) => {
    if (entry.permission && !authorizeDelegatedMakerCurve(curve, plan.fairPrice.price, entry.permission, now).ok) {
      return false;
    }
    if (entry.managedMakerAuthorization) {
      return authorizeManagedMakerCurvePolicy(
        curve,
        entry.pair,
        entry.managedMakerAuthorization.policy,
        epochId
      ).ok;
    }
    return true;
  });
}

function normalizeState(value: ManagedMakerRunnerState | null | undefined): ManagedMakerRunnerState {
  return {
    submittedEpochs: value?.submittedEpochs && typeof value.submittedEpochs === "object" ? { ...value.submittedEpochs } : {},
    failures: Array.isArray(value?.failures) ? [...value.failures] : [],
    lastRunAt: typeof value?.lastRunAt === "number" ? value.lastRunAt : undefined,
  };
}

function cloneState(state: ManagedMakerRunnerState): ManagedMakerRunnerState {
  return {
    submittedEpochs: { ...state.submittedEpochs },
    failures: [...state.failures],
    lastRunAt: state.lastRunAt,
  };
}

function emptyState(): ManagedMakerRunnerState {
  return { submittedEpochs: {}, failures: [] };
}

function emptyTelemetry(): ManagedMakerRunnerTelemetry {
  return { submitted: 0, skipped: 0, failed: 0 };
}

function epochKey(strategyId: string, batchId: string): string {
  return `${strategyId}:${batchId}`;
}

function hasPartialSubmission(submission: ManagedMakerEpochSubmission): boolean {
  return submission.curveCount > 0 || submission.strategyIds.length > 0 || submission.packageIds.length > 0;
}

function requiredDelegatedSubmit(wallet: MakerWalletRuntime): NonNullable<MakerWalletRuntime["submitDelegatedPrivateOrder"]> {
  if (!wallet.submitDelegatedPrivateOrder) {
    throw new Error("wallet runtime does not support quote-only delegated managed maker submission");
  }
  return wallet.submitDelegatedPrivateOrder.bind(wallet);
}

function requiredDirectSubmit(wallet: MakerWalletRuntime): NonNullable<MakerWalletRuntime["submitPrivateOrder"]> {
  if (!wallet.submitPrivateOrder) {
    throw new Error("wallet runtime does not support direct maker submission");
  }
  return wallet.submitPrivateOrder.bind(wallet);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
