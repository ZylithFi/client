import type { PairConfig } from "../components/OrderTicket";
import type { BatchSummary } from "../domain/auctionEpoch";
import type { MarketDataEngine } from "../domain/marketData";
import {
  authorizeDelegatedMakerCurve,
  buildMakerOpsSnapshot,
  type DelegatedMakerPermission,
  type FairPriceResult,
  type MakerOpsSnapshot,
  type ManagedCurveDraft,
  type ManagedCurvePlan,
  type ManagedRiskPolicy,
  type ManagedStrategyConfig,
} from "../domain/managedLiquidity";
import type { LocalOrder, PrivateStrategySummary } from "../domain/orderLifecycle";
import type { WalletBalance } from "../domain/shieldedBalances";
import { ZylithMakerSdk, type MakerWalletRuntime } from "./maker";

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
  private readonly onEvent?: (event: ManagedMakerRunnerEvent) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private state: ManagedMakerRunnerState = emptyState();

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

  private async runStrategy(
    entry: ManagedMakerRunnerStrategy,
    balances: WalletBalance[],
    orders: LocalOrder[]
  ): Promise<
    | { kind: "submitted"; submission: ManagedMakerEpochSubmission }
    | { kind: "skipped"; skip: ManagedMakerRunResult["skipped"][number] }
  > {
    const batch = await this.currentBatch(entry.pair);
    if (batch.status !== "Open") {
      return { kind: "skipped", skip: this.skip(entry, `batch is ${batch.status}`, batch) };
    }
    const remainingMs = batch.close_time_unix_ms - this.now();
    if (remainingMs <= this.submissionSafetyBufferMs) {
      return { kind: "skipped", skip: this.skip(entry, "inside submission safety buffer", batch) };
    }
    const key = epochKey(entry.id, batch.batch_id);
    if (this.state.submittedEpochs[key]) {
      return { kind: "skipped", skip: this.skip(entry, "epoch already submitted", batch) };
    }
    const plan = await this.sdk.buildCurvesFromMarketData({
      pair: entry.pair,
      balances,
      orders,
      marketData: this.marketData,
      strategy: entry.strategy,
      risk: entry.risk,
    });
    if (!plan.ok) {
      return { kind: "skipped", skip: this.skip(entry, plan.reason, batch) };
    }
    const curves = authorizedCurves(plan, entry.permission, this.now());
    if (curves.length === 0) {
      return { kind: "skipped", skip: this.skip(entry, "delegated permission rejects all curves", batch) };
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
    for (const curve of curves) {
      const result = await this.sdk.submitCurve(this.runtime, curve);
      if (result.strategyId) submission.strategyIds.push(result.strategyId);
      if (result.offlinePackage?.package_id) submission.packageIds.push(result.offlinePackage.package_id);
      submission.curveCount += 1;
      this.state.submittedEpochs[key] = submission;
      await this.persistState();
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
    this.onEvent?.(event);
  }
}

function authorizedCurves(
  plan: ManagedCurvePlan & { ok: true },
  permission: DelegatedMakerPermission | undefined,
  now: number
): ManagedCurveDraft[] {
  if (!permission) return plan.curves;
  return plan.curves.filter((curve) =>
    authorizeDelegatedMakerCurve(curve, plan.fairPrice.price, permission, now).ok
  );
}

function normalizeState(value: ManagedMakerRunnerState | null | undefined): ManagedMakerRunnerState {
  return {
    submittedEpochs: value?.submittedEpochs && typeof value.submittedEpochs === "object"
      ? { ...value.submittedEpochs }
      : {},
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

function epochKey(strategyId: string, batchId: string): string {
  return `${strategyId}:${batchId}`;
}
