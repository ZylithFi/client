import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./globals.css";
import {
  type LocalOrder,
  type LocalOrderStatus,
  type PrivateStrategySummary,
  loadOrders,
  ordersChanged,
  reconcileOrderLifecycle,
  saveOrders,
} from "./domain/orderLifecycle";
import { type PendingDeposit, type WalletBalance, type WithdrawableNote } from "./domain/shieldedBalances";
import {
  assetScale,
  configureAssetDecimals,
  formatClearingPrice,
  fromAtomicStr,
  toAtomicStr,
  toPriceAtomicStr,
} from "./domain/assets";
import {
  type RuntimeStatus,
  connectedStarknetAddress,
  walletRuntime,
  walletRuntimeStatus,
} from "./domain/browserWallet";
import {
  OrderTicket,
  type FundingPreview,
  type PairConfig,
  type StratKind,
  type TicketShape,
  type TicketSubmitIntent,
} from "./components/OrderTicket";
import {
  type BatchSummary,
  type DeploymentConfig,
  apiCurrentPairBatch,
  lastClearingByPair,
  useBatches,
  useCoordinatorStatus,
  useDeployment,
  usePublicProofJobStatuses,
  usePublicSettlementTranscripts,
} from "./domain/auctionEpoch";
import { PairHeader, PairList, ReportsStrip } from "./components/MarketPanels";
import { RightColumn } from "./components/RightColumn";
import { type AppTab, type LiquidityTab, type Workspace, TopNav } from "./components/TopNav";
import { DepositSlide, RecoverySlide, WalletSlide, WithdrawSlide } from "./components/WalletSlides";
import { AssetsScreen } from "./screens/AssetsScreen";
import { OrdersScreen } from "./screens/OrdersScreen";
import {
  loadUserPreferences,
  saveUserPreferences,
  type SubmissionTimingPreference,
  type UserPreferences,
  type WithdrawalRoutePreference,
} from "./domain/userPreferences";
import { userFacingErrorMessage } from "./domain/userFacingErrors";
import { claimableOutputs } from "./domain/noteLifecycle";
import { OFFLINE_RENEWAL_RELAY_RESULTS_EVENT } from "./offlineRenewalOperator";
import {
  fetchManagedRenewalPackageResults,
  submitManagedRenewalPackage,
} from "./domain/managedRenewalRelay";

const ReportsScreen = lazy(() =>
  import("./screens/ReportsScreen").then(module => ({ default: module.ReportsScreen })),
);
const LiquidityWorkspace = lazy(() =>
  import("./screens/LiquidityScreens").then(module => ({ default: module.LiquidityWorkspace })),
);

function genRef(): string {
  return `ORD-${Math.floor(1000 + Math.random() * 9000)}`;
}

function ceilDivBigInt(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function wireMode(
  shape: TicketShape,
  resting: boolean,
  stratKind: StratKind,
): LocalOrder["wireMode"] {
  if (shape === "limit") return "Limit";
  if (shape === "curve") return resting ? "Resting" : "Maker Curve";
  return stratKind;
}

function deploymentOrderScope(deployment: DeploymentConfig | null): string {
  return `${deployment?.chain_id ?? "unknown-chain"}:${deployment?.contracts?.auction_verifier ?? "unknown-verifier"}`;
}

function walletOrderOwnerKey(deployment: DeploymentConfig | null): string | null {
  const accountId = walletRuntime()?.getPublicConfig?.()?.account_id ?? null;
  return accountId ? `${accountId}:${deploymentOrderScope(deployment)}` : null;
}

const SPENT_LOCK_STATUSES = new Set<LocalOrderStatus>(["filled", "partial"]);
const RELEASED_LOCK_STATUSES = new Set<LocalOrderStatus>([
  "no_fill",
  "rolled",
  "failed",
  "cancelled",
]);
const ACTIVE_ORDER_STATUSES = new Set<LocalOrderStatus>([
  "queued",
  "in_batch",
  "proving",
  "settling",
  "settled_pending_output",
]);
const PROOF_TRACKED_ORDER_STATUSES = new Set<LocalOrderStatus>([
  ...ACTIVE_ORDER_STATUSES,
  "no_fill",
  "stalled",
]);
const PRIVATE_REPORT_RECOVERY_STATUSES = new Set<LocalOrderStatus>([
  "proving",
  "settling",
  "settled_pending_output",
  "filled",
  "partial",
  "no_fill",
  "stalled",
]);
const LAST_TAKER_ROUTE_KEY = "zylith.nav.last_taker_route";
const LAST_LIQUIDITY_ROUTE_KEY = "zylith.nav.last_liquidity_route";

type ArrivalReferenceSnapshot = {
  price?: string;
  source?: "last_clearing";
  observedAt?: number;
};

type PrivateExecutionReportForApp = {
  batch_id: string;
  pair_id: string;
  order_commitment: string;
  funding_note_commitment?: string;
  funding_note_commitments?: string[];
  filled_amount: string;
  unfilled_amount: string;
  execution_price?: string | null;
};

type PrivateSettlementReportForApp = {
  batch_id: string;
  pair_id: string;
  batch_epoch: number;
  clearing_price: string;
  price_base_scale?: string;
  output_recovery_records?: unknown[];
  order_execution_reports?: PrivateExecutionReportForApp[];
};

function lastClearingReference(
  pair: PairConfig,
  lastClearingPrice: { batchId: string; epochId: number; clearingPrice: string; priceBaseScale?: string } | null,
): ArrivalReferenceSnapshot {
  if (!lastClearingPrice) return {};
  return {
    price: formatClearingPrice(lastClearingPrice, pair),
    source: "last_clearing",
    observedAt: Date.now(),
  };
}

function arrivalReferenceSnapshot(
  pair: PairConfig,
  lastClearingPrice: { batchId: string; epochId: number; clearingPrice: string; priceBaseScale?: string } | null,
): ArrivalReferenceSnapshot {
  return lastClearingReference(pair, lastClearingPrice);
}

function takerTabFromPath(path: string): AppTab {
  if (path === "/orders") return "orders";
  if (path === "/assets") return "assets";
  if (path === "/reports" || path === "/tca") return "reports";
  return "trade";
}

function liquidityTabFromPath(path: string): LiquidityTab {
  const segment = path.split("/")[2];
  if (segment === "curves") return "curves";
  if (segment === "orders") return "orders";
  if (segment === "inventory") return "inventory";
  if (segment === "analytics") return "analytics";
  return "curves";
}

function takerPath(tab: AppTab): string {
  return tab === "trade" ? "/trade" : tab === "reports" ? "/tca" : `/${tab}`;
}

function liquidityPath(tab: LiquidityTab): string {
  return `/liquidity/${tab}`;
}

function sessionGet(key: string, fallback: string): string {
  try {
    return sessionStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function sessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage can be disabled; route memory is convenience only.
  }
}

function normalizeFeltForComparison(value: string | undefined | null): string {
  if (!value) return "";
  try {
    return `0x${BigInt(value).toString(16)}`;
  } catch {
    const hex = value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
    return `0x${hex || "0"}`;
  }
}

function useWalletState(): {
  runtimeStatus: RuntimeStatus;
  walletReady: boolean;
  hasVault: boolean;
} {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(() => walletRuntimeStatus());
  const [walletReady, setWalletReady] = useState(() => Boolean(window.zylithWallet?.isReady()));
  const [hasVault, setHasVault] = useState(() => Boolean(window.zylithWallet?.hasVault()));

  useEffect(() => {
    function onReady() {
      setRuntimeStatus(walletRuntimeStatus());
    }
    window.addEventListener("zylith-wallet-runtime-ready", onReady);
    return () => window.removeEventListener("zylith-wallet-runtime-ready", onReady);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const w = walletRuntime();
      setRuntimeStatus(walletRuntimeStatus());
      setWalletReady(Boolean(w?.isReady()));
      setHasVault(Boolean(w?.hasVault()));
    }, 800);
    return () => clearInterval(t);
  }, []);

  return { runtimeStatus, walletReady, hasVault };
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const deployment = useDeployment();
  const coordinatorStatus = useCoordinatorStatus();
  const { batches, online } = useBatches();
  const recentSettlementTranscripts = usePublicSettlementTranscripts(batches);
  const { runtimeStatus, walletReady, hasVault } = useWalletState();

  const pairs = useMemo(
    () => deployment ? Object.values(deployment.product.pairs).filter(p => p.enabled) : [],
    [deployment],
  );
  const allAssets = useMemo(
    () => [...new Set(pairs.flatMap(p => [p.base_asset_id, p.quote_asset_id]))],
    [pairs],
  );
  const depositableAssets = useMemo(
    () => allAssets.filter(asset => Boolean(deployment?.token_addresses?.[asset])),
    [allAssets, deployment],
  );
  const batchByPair = batches.reduce<Record<string, BatchSummary>>((acc, b) => {
    const current = acc[b.pair_id];
    if (!current || b.epoch_id > current.epoch_id) {
      acc[b.pair_id] = b;
    }
    return acc;
  }, {});
  useEffect(() => {
    configureAssetDecimals(deployment);
  }, [deployment]);

  // Workspace-aware URL routing
  const initialWorkspace: Workspace = window.location.pathname.startsWith("/liquidity") ? "liquidity" : "taker";
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [tab, setTab] = useState<AppTab>(() => {
    return takerTabFromPath(window.location.pathname);
  });
  const [liquidityTab, setLiquidityTabState] = useState<LiquidityTab>(() => (
    liquidityTabFromPath(window.location.pathname)
  ));

  const changeTab = useCallback((t: AppTab) => {
    const path = takerPath(t);
    setWorkspace("taker");
    setTab(t);
    sessionSet(LAST_TAKER_ROUTE_KEY, path);
    window.history.pushState(null, "", path);
  }, []);

  const changeLiquidityTab = useCallback((t: LiquidityTab) => {
    const path = liquidityPath(t);
    setWorkspace("liquidity");
    setLiquidityTabState(t);
    sessionSet(LAST_LIQUIDITY_ROUTE_KEY, path);
    window.history.pushState(null, "", path);
  }, []);

  const navigatePath = useCallback((path: string, replace = false) => {
    if (path.startsWith("/liquidity")) {
      const nextLiquidityTab = liquidityTabFromPath(path);
      const normalizedPath = liquidityPath(nextLiquidityTab);
      setWorkspace("liquidity");
      setLiquidityTabState(nextLiquidityTab);
      sessionSet(LAST_LIQUIDITY_ROUTE_KEY, normalizedPath);
      if (replace) window.history.replaceState(null, "", normalizedPath);
      else window.history.pushState(null, "", normalizedPath);
      return;
    }
    const nextTab = takerTabFromPath(path);
    const normalizedPath = takerPath(nextTab);
    setWorkspace("taker");
    setTab(nextTab);
    sessionSet(LAST_TAKER_ROUTE_KEY, normalizedPath);
    if (replace) window.history.replaceState(null, "", normalizedPath);
    else window.history.pushState(null, "", normalizedPath);
  }, []);

  useEffect(() => {
    if (window.location.pathname === "/" || window.location.pathname === "") {
      window.history.replaceState(null, "", "/trade");
    } else if (window.location.pathname.startsWith("/liquidity")) {
      const normalizedPath = liquidityPath(liquidityTabFromPath(window.location.pathname));
      if (window.location.pathname !== normalizedPath) {
        window.history.replaceState(null, "", normalizedPath);
      }
    }
    const onPop = () => {
      const p = window.location.pathname;
      if (p.startsWith("/liquidity")) {
        const nextLiquidityTab = liquidityTabFromPath(p);
        setWorkspace("liquidity");
        setLiquidityTabState(nextLiquidityTab);
        sessionSet(LAST_LIQUIDITY_ROUTE_KEY, liquidityPath(nextLiquidityTab));
      } else {
        const nextTab = takerTabFromPath(p);
        setWorkspace("taker");
        setTab(nextTab);
        sessionSet(LAST_TAKER_ROUTE_KEY, takerPath(nextTab));
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Trade state
  const [activePairId, setActivePairId] = useState("STRK/USDC");
  const [liquidityPairId, setLiquidityPairId] = useState("STRK/USDC");
  const activePair = pairs.find(p => p.pair_id === activePairId) ?? pairs[0] ?? null;
  const activeBatch = activePair ? batchByPair[activePair.pair_id] ?? null : null;

  const [userPreferences, setUserPreferences] = useState<UserPreferences>(() => loadUserPreferences());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const updateSubmissionTiming = useCallback((value: SubmissionTimingPreference) => {
    setUserPreferences(previous => {
      const next = { ...previous, submissionTiming: value };
      saveUserPreferences(next);
      return next;
    });
  }, []);

  const updateWithdrawalRoute = useCallback((value: WithdrawalRoutePreference) => {
    setUserPreferences(previous => {
      const next = { ...previous, withdrawalRoute: value };
      saveUserPreferences(next);
      return next;
    });
  }, []);

  // UI state
  const [openSlide, setOpenSlide] = useState<"wallet" | "deposit" | "withdraw" | "recovery" | null>(null);
  const [slideAsset, setSlideAsset] = useState("USDC");
  const [claimNoteCommitment, setClaimNoteCommitment] = useState<string | null>(null);
  const [starknetAddress, setStarknetAddress] = useState<string | null>(() => {
    return connectedStarknetAddress();
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const next = connectedStarknetAddress();
      setStarknetAddress(previous => {
        if (!next) return previous;
        return previous === next ? previous : next;
      });
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  // Orders
  const [orderOwnerKey, setOrderOwnerKey] = useState<string | null>(() => walletOrderOwnerKey(null));
  const [orders, setOrders] = useState<LocalOrder[]>(() => loadOrders(orderOwnerKey));
  const orderBatchIds = useMemo(
    () => Array.from(new Set(
      orders
        .filter(order => PROOF_TRACKED_ORDER_STATUSES.has(order.status))
        .map(order => order.batchId)
        .filter(Boolean),
    )),
    [orders],
  );
  const orderSettlementTranscripts = usePublicSettlementTranscripts([], orderBatchIds);
  const settlementTranscripts = useMemo(
    () => ({ ...recentSettlementTranscripts, ...orderSettlementTranscripts }),
    [orderSettlementTranscripts, recentSettlementTranscripts],
  );
  const lastClearingPrices = lastClearingByPair(settlementTranscripts);
  const activeProofBatchIds = useMemo(
    () => Array.from(new Set(
      orders
        .filter(order => PROOF_TRACKED_ORDER_STATUSES.has(order.status))
        .map(order => order.batchId)
        .filter(Boolean),
    )),
    [orders],
  );
  const proofStatuses = usePublicProofJobStatuses(activeProofBatchIds);
  const privateReportRequestsInFlight = useRef<Set<string>>(new Set());
  const privateReportSyncedBatches = useRef<Set<string>>(new Set());
  const saveAndSet = useCallback((next: LocalOrder[]) => {
    setOrders(next);
    saveOrders(next, orderOwnerKey ?? walletOrderOwnerKey(deployment));
  }, [deployment, orderOwnerKey]);
  const prependAndSaveOrder = useCallback((order: LocalOrder) => {
    setOrders(previous => {
      const next = [order, ...previous];
      saveOrders(next, orderOwnerKey ?? walletOrderOwnerKey(deployment));
      return next;
    });
  }, [deployment, orderOwnerKey]);

  useEffect(() => {
    const nextOwnerKey = walletReady ? walletOrderOwnerKey(deployment) : null;
    if (nextOwnerKey === orderOwnerKey) return;
    setOrderOwnerKey(nextOwnerKey);
    setOrders(loadOrders(nextOwnerKey));
    privateReportRequestsInFlight.current.clear();
    privateReportSyncedBatches.current.clear();
  }, [deployment, walletReady, runtimeStatus, orderOwnerKey]);

  useEffect(() => {
    if (!walletReady || orders.length === 0 || pairs.length === 0) return;
    const w = walletRuntime();
    if (!w?.isReady() || !w.syncPrivateSettlementReports) return;
    const requests = Object.values(
      orders.reduce<Record<string, { batch_id: string; order_commitments: string[] }>>((acc, order) => {
        if (!order.batchId || !order.orderCommitment) return acc;
        if (!PRIVATE_REPORT_RECOVERY_STATUSES.has(order.status)) return acc;
        if (privateReportSyncedBatches.current.has(order.batchId)) return acc;
        if (privateReportRequestsInFlight.current.has(order.batchId)) return acc;
        const proofStatus = proofStatuses[order.batchId];
        const hasSettlementSignal =
          proofStatus?.state === "confirmed-onchain" ||
          Boolean(settlementTranscripts[order.batchId]) ||
          order.status === "filled" ||
          order.status === "partial";
        if (!hasSettlementSignal) return acc;
        if (proofStatus?.state === "confirmed-onchain" && proofStatus.matched_order_count === 0) return acc;
        const existing = acc[order.batchId] ?? { batch_id: order.batchId, order_commitments: [] };
        existing.order_commitments.push(order.orderCommitment);
        acc[order.batchId] = existing;
        return acc;
      }, {}),
    );
    if (requests.length === 0) return;
    requests.forEach(request => privateReportRequestsInFlight.current.add(request.batch_id));
    let cancelled = false;
    async function syncReports() {
      const reports = await w!.syncPrivateSettlementReports(requests)
        .catch(() => [] as PrivateSettlementReportForApp[]);
      if (cancelled) return;
      const requestedByBatch = new Map(
        requests.map(request => [
          request.batch_id,
          new Set(request.order_commitments.map(normalizeFeltForComparison)),
        ]),
      );
      const successfulBatchIds = new Set(
        reports
          .filter(report => {
            const requested = requestedByBatch.get(report.batch_id);
            if (!requested || requested.size === 0) return false;
            return (report.order_execution_reports ?? []).some(execution =>
              requested.has(normalizeFeltForComparison(execution.order_commitment)),
            );
          })
          .map(report => report.batch_id),
      );
      for (const batchId of successfulBatchIds) {
        privateReportSyncedBatches.current.add(batchId);
      }
      requests.forEach(request => {
        if (!successfulBatchIds.has(request.batch_id)) {
          privateReportRequestsInFlight.current.delete(request.batch_id);
        }
      });
      if (reports.length === 0) return;
      const reportByOrder = new Map<string, { report: PrivateSettlementReportForApp; execution: PrivateExecutionReportForApp }>();
      for (const report of reports as PrivateSettlementReportForApp[]) {
        for (const execution of report.order_execution_reports ?? []) {
          reportByOrder.set(normalizeFeltForComparison(execution.order_commitment), { report, execution });
        }
      }
      let changed = false;
      const nextOrders = orders.map(order => {
        const matched = reportByOrder.get(normalizeFeltForComparison(order.orderCommitment));
        if (!matched) return order;
        const pair = pairs.find(candidate => candidate.pair_id === matched.report.pair_id);
        if (!pair) return order;
        const filledAtomic = BigInt(matched.execution.filled_amount || "0");
        const unfilledAtomic = BigInt(matched.execution.unfilled_amount || "0");
        const clearingPrice = formatClearingPrice({
          batchId: matched.report.batch_id,
          epochId: matched.report.batch_epoch,
          clearingPrice: matched.execution.execution_price || matched.report.clearing_price,
          priceBaseScale: matched.report.price_base_scale,
        }, pair);
        if (filledAtomic <= 0n) {
          if (order.status === "no_fill" && order.clearingPrice === clearingPrice) return order;
          changed = true;
          return { ...order, status: "no_fill" as LocalOrderStatus, clearingPrice };
        }
        const nextStatus: LocalOrderStatus = unfilledAtomic > 0n ? "partial" : "filled";
        const filledAmount = fromAtomicStr(filledAtomic.toString(), pair.base_asset_id);
        if (
          order.status === nextStatus &&
          order.clearingPrice === clearingPrice &&
          order.filledAmount === filledAmount
        ) {
          return order;
        }
        changed = true;
        return {
          ...order,
          status: nextStatus,
          clearingPrice,
          filledAmount,
        };
      });
      if (changed) {
        saveAndSet(nextOrders);
        setBalanceTick(value => value + 1);
      } else if (reports.length > 0) {
        setBalanceTick(value => value + 1);
      }
    }
    void syncReports();
    return () => { cancelled = true; };
  }, [orders, pairs, proofStatuses, saveAndSet, settlementTranscripts, walletReady]);

  // Balance polling
  const [balanceTick, setBalanceTick] = useState(0);
  useEffect(() => {
    if (!walletReady) return;
    let cancelled = false;
    const refreshDeposits = async () => {
      const w = walletRuntime();
      if (w?.isReady()) {
        const changed = await w.refreshDepositState?.().catch(() => false);
        if (!cancelled && changed) setBalanceTick(v => v + 1);
      }
    };
    const refreshSettlementOutputs = async () => {
      const w = walletRuntime();
      if (w?.isReady()) {
        const changed = await w.syncSettlementOutputs?.().catch(() => false);
        if (!cancelled && changed) setBalanceTick(v => v + 1);
      }
    };
    void refreshDeposits();
    void refreshSettlementOutputs();
    const depositTimer = setInterval(() => { void refreshDeposits(); }, 5_000);
    const settlementTimer = setInterval(() => { void refreshSettlementOutputs(); }, 15_000);
    return () => {
      cancelled = true;
      clearInterval(depositTimer);
      clearInterval(settlementTimer);
    };
  }, [walletReady]);

  const wallet = walletRuntime();
  const balances: WalletBalance[] = walletReady ? wallet?.getBalances() ?? [] : [];
  const pendingDeposits: PendingDeposit[] = walletReady ? wallet?.getPendingDeposits?.() ?? [] : [];
  const withdrawableNotes: WithdrawableNote[] = walletReady ? wallet?.getWithdrawableNotes() ?? [] : [];
  const strategies: PrivateStrategySummary[] = walletReady ? wallet?.getPrivateStrategies?.() ?? [] : [];
  const claimDelaySeconds = deployment?.proof?.output_claim_delay_seconds ??
    deployment?.proof_config?.output_claim_delay_seconds ??
    0;
  const claimableOutputCount = walletReady
    ? claimableOutputs(withdrawableNotes, settlementTranscripts, claimDelaySeconds, Date.now()).length
    : 0;

  // Status updates from batch state changes
  useEffect(() => {
    const updated = reconcileOrderLifecycle({
      orders,
      batches,
      settlementTranscripts,
      proofStatuses,
      withdrawableNotes,
      pairs,
      formatClearingPrice: (price, pair) => formatClearingPrice(price, pair as PairConfig),
      noFillFallbackEpochs: 10,
      toAtomicStr,
      fromAtomicStr,
      assetScale,
    });
    if (ordersChanged(orders, updated)) {
      const w = walletRuntime();
      for (const next of updated) {
        const previous = orders.find(order => order.ordRef === next.ordRef);
        if (!previous || previous.status === next.status || !next.orderCommitment) continue;
        const fundingFallback = {
          asset: next.fundingAsset,
          amount: next.fundingAmount,
          batchId: next.batchId,
          noteCommitments: next.fundingNoteCommitments,
        };
        if (SPENT_LOCK_STATUSES.has(next.status)) {
          void w?.settlePrivateOrderLock?.(next.orderCommitment, "spent", fundingFallback)
            .finally(() => setBalanceTick(v => v + 1));
        }
        if (RELEASED_LOCK_STATUSES.has(next.status)) {
          void w?.settlePrivateOrderLock?.(next.orderCommitment, "released")
            .finally(() => setBalanceTick(v => v + 1));
        }
      }
      saveAndSet(updated);
    }
  }, [batches, balanceTick, settlementTranscripts, proofStatuses, pairs, orders, saveAndSet, withdrawableNotes]);

  useEffect(() => {
    if (!walletReady) return;
    const w = walletRuntime();
    if (!w?.isReady()) return;
    const terminalOrders = orders.filter(order =>
      order.orderCommitment &&
      (SPENT_LOCK_STATUSES.has(order.status) || RELEASED_LOCK_STATUSES.has(order.status)),
    );
    if (terminalOrders.length === 0) return;

    let cancelled = false;
    async function reconcileLocks() {
      let changed = false;
      for (const order of terminalOrders) {
        const outcome = SPENT_LOCK_STATUSES.has(order.status) ? "spent" : "released";
        changed = await w!.settlePrivateOrderLock(order.orderCommitment, outcome, {
          asset: order.fundingAsset,
          amount: order.fundingAmount,
          batchId: order.batchId,
          noteCommitments: order.fundingNoteCommitments,
        }).catch(() => false) || changed;
      }
      if (!cancelled && changed) setBalanceTick(v => v + 1);
    }
    void reconcileLocks();
    return () => { cancelled = true; };
  }, [orders, walletReady]);

  useEffect(() => {
    if (!walletReady) return;
    const onRelayResults = (event: Event) => {
      const detail = (event as CustomEvent<{
        package_id?: string;
        results?: Array<{
          slot_id?: string;
          order_commitment?: string;
          batch_id?: string;
          epoch_id?: number;
          status?: string;
          accepted?: { order_commitment?: string; batch_id?: string; accepted_at_unix_ms?: number };
        }>;
      }>).detail;
      if (!detail?.package_id || !Array.isArray(detail.results)) return;
      const w = walletRuntime();
      void w?.recordOfflineRenewalRelayResults?.(detail.package_id, detail.results)
        .then((changed: boolean | undefined) => {
          if (changed) setBalanceTick(value => value + 1);
        })
        .catch((error: unknown) => {
          setSubmitError(userFacingErrorMessage(error));
        });
    };
    window.addEventListener(OFFLINE_RENEWAL_RELAY_RESULTS_EVENT, onRelayResults);
    return () => window.removeEventListener(OFFLINE_RENEWAL_RELAY_RESULTS_EVENT, onRelayResults);
  }, [walletReady]);

  useEffect(() => {
    if (!walletReady) return;
    const packageIds = Array.from(new Set(
      strategies
        .map(strategy => strategy.offline_package)
        .filter((pkg): pkg is NonNullable<typeof pkg> => pkg?.relay_mode === "ZylithRelay")
        .map(pkg => pkg.package_id),
    ));
    if (packageIds.length === 0) return;
    let cancelled = false;
    async function syncManagedRelayResults() {
      const w = walletRuntime();
      if (!w?.isReady()) return;
      let changed = false;
      for (const packageId of packageIds) {
        const response = await fetchManagedRenewalPackageResults(packageId).catch((error: unknown) => {
          setSubmitError(userFacingErrorMessage(error));
          return null;
        });
        if (!response?.results?.length || cancelled) continue;
        changed = await w.recordOfflineRenewalRelayResults(packageId, response.results).catch(() => false) || changed;
      }
      if (!cancelled && changed) setBalanceTick(value => value + 1);
    }
    void syncManagedRelayResults();
    const timer = window.setInterval(() => { void syncManagedRelayResults(); }, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [walletReady, strategies]);

  const activeOrders = orders.filter(o =>
    ACTIVE_ORDER_STATUSES.has(o.status),
  );

  useEffect(() => {
    if (!walletReady || strategies.length === 0 || pairs.length === 0) return;
    const existingCommitments = new Set(
      orders.map(order => order.orderCommitment).filter(Boolean),
    );
    const existingMetadata = new Set(
      orders.map(order => order.expectedOutputMetadataCommitment).filter(Boolean),
    );
    const additions: LocalOrder[] = [];
    for (const strategy of strategies) {
      if (!strategy.side) continue;
      const pair = pairs.find(candidate => candidate.pair_id === strategy.pair);
      if (!pair) continue;
      const priceBaseScale = strategy.price_base_scale ?? pair.price_base_scale ?? assetScale(pair.base_asset_id).toString();
      const limitPriceAtomic = strategy.limit_price ?? "0";
      const fundingAsset = strategy.side === "Buy" ? pair.quote_asset_id : pair.base_asset_id;
      const fundingAmountAtomic = strategy.side === "Buy"
        ? ((BigInt(strategy.child_amount) * BigInt(limitPriceAtomic || "0")) / BigInt(priceBaseScale)).toString()
        : strategy.child_amount;
      const makerCurvePoints = strategy.maker_curve_points?.map(point => ({
        price: formatClearingPrice({
          batchId: strategy.id,
          epochId: 0,
          clearingPrice: point.price,
          priceBaseScale,
        }, pair),
        baseAmount: fromAtomicStr(point.base_amount, pair.base_asset_id),
      }));

      for (const child of strategy.submitted_children) {
        if (!child.order_commitment || child.submitted_at_unix_ms <= 0) continue;
        if (existingCommitments.has(child.order_commitment)) continue;
        if (
          child.expected_output_metadata_commitment &&
          existingMetadata.has(child.expected_output_metadata_commitment)
        ) {
          continue;
        }
        existingCommitments.add(child.order_commitment);
        if (child.expected_output_metadata_commitment) {
          existingMetadata.add(child.expected_output_metadata_commitment);
        }
        additions.push({
          ordRef: `STR-${strategy.id.slice(0, 8)}-${child.parent_child_index}`,
          orderCommitment: child.order_commitment,
          cancellationSecret: child.cancellation_secret ?? "",
          expectedOutputMetadataCommitment: child.expected_output_metadata_commitment,
          fundingNoteCommitments: child.funding_note_commitments,
          strategyId: strategy.id,
          batchId: child.batch_id,
          epochId: child.epoch_id,
          pair: strategy.pair,
          side: strategy.side,
          wireMode: strategy.mode === "Resting" ? "Resting" : strategy.mode,
          amount: fromAtomicStr(strategy.child_amount, pair.base_asset_id),
          fundingAsset,
          fundingAmount: fromAtomicStr(fundingAmountAtomic, fundingAsset),
          limitPrice: formatClearingPrice({
            batchId: child.batch_id,
            epochId: child.epoch_id,
            clearingPrice: limitPriceAtomic,
            priceBaseScale,
          }, pair),
          minFill: strategy.min_fill ? fromAtomicStr(strategy.min_fill, pair.base_asset_id) : "",
          fillOrKill: Boolean(strategy.fill_or_kill),
          status: "in_batch",
          submittedAt: child.submitted_at_unix_ms,
          makerCurvePoints,
        });
      }
    }
    if (additions.length > 0) {
      saveAndSet([...additions, ...orders]);
    }
  }, [walletReady, strategies, pairs, orders, saveAndSet]);

  // Submit order
  function pairForIntent(intent: TicketSubmitIntent) {
    if (intent.pairId) return pairs.find(pair => pair.pair_id === intent.pairId) ?? null;
    return activePair;
  }

  async function handleSubmit(intent: TicketSubmitIntent): Promise<boolean> {
    const w = walletRuntime();
    if (!w || !w.isReady()) { setSubmitError("Unlock Zylith wallet first."); return false; }
    const submitPair = pairForIntent(intent);
    if (!submitPair) { setSubmitError("Select a pair before submitting."); return false; }
    const expectedBatch = batchByPair[submitPair.pair_id] ?? null;
    if (!expectedBatch) { setSubmitError("This pair is not accepting orders right now. Please retry later."); return false; }

    setSubmitting(true); setSubmitError(null);
    try {
      const currentBatch = await apiCurrentPairBatch(
        submitPair.base_asset_id,
        submitPair.quote_asset_id,
      );
      if (currentBatch.status !== "Open") {
        setSubmitError("This batch is already closed. Please retry in the next epoch.");
        return false;
      }
      if (intent.shape === "strategy" && !coordinatorStatus?.batch_window_ms) {
        setSubmitError("Batch timing is still loading. Please retry later.");
        return false;
      }

      const wm = wireMode(intent.shape, intent.resting, intent.stratKind);
      const atomicCurvePoints = intent.shape === "curve"
        ? intent.curvePoints
            .filter(pt => pt.price.trim() && pt.baseAmount.trim())
            .map(pt => ({
              price: toPriceAtomicStr(pt.price, submitPair.quote_asset_id),
              baseAmount: toAtomicStr(pt.baseAmount, submitPair.base_asset_id),
            }))
        : undefined;
      const sortedCurvePoints = [...(atomicCurvePoints ?? [])]
        .sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0));
      const curveBaseTotal = sortedCurvePoints.reduce((total, pt) => total + BigInt(pt.baseAmount), 0n);
      const curveEnvelopePrice = sortedCurvePoints.length > 0
        ? (intent.side === "Buy" ? sortedCurvePoints[sortedCurvePoints.length - 1].price : sortedCurvePoints[0].price)
        : "0";
      const atomicAmount = intent.shape === "curve"
        ? (intent.inventoryCap.trim() ? toAtomicStr(intent.inventoryCap, submitPair.base_asset_id) : curveBaseTotal.toString())
        : toAtomicStr(intent.amount, submitPair.base_asset_id);
      const atomicPrice = intent.shape === "curve"
        ? curveEnvelopePrice
        : toPriceAtomicStr(intent.shape === "limit" ? intent.limitPrice : intent.priceLimit || "0", submitPair.quote_asset_id);
      const atomicMinFill = toAtomicStr(intent.minFill || "0", submitPair.base_asset_id);
      const priceBaseScale = submitPair.price_base_scale ?? assetScale(submitPair.base_asset_id).toString();
      const fundingAsset = intent.side === "Buy" ? submitPair.quote_asset_id : submitPair.base_asset_id;
      const fundingAmountAtomic = intent.side === "Buy"
        ? ((BigInt(atomicAmount) * BigInt(atomicPrice || "0")) / BigInt(priceBaseScale)).toString()
        : atomicAmount;

      const draft = {
        pair: submitPair.pair_id,
        side: intent.side,
        mode: wm,
        amount: atomicAmount,
        limitPrice: atomicPrice,
        minFill: atomicMinFill,
        fillOrKill: intent.fillOrKill,
        batchId: currentBatch.batch_id,
        makerCurvePoints: atomicCurvePoints,
        makerInventoryCap: intent.shape === "curve" && intent.inventoryCap.trim()
          ? toAtomicStr(intent.inventoryCap, submitPair.base_asset_id)
          : undefined,
        priceBaseScale,
        submissionTimingPreference: userPreferences.submissionTiming,
        durationBatches: (
          (intent.shape === "strategy" || (intent.shape === "curve" && intent.resting)) &&
          intent.durationHours &&
          coordinatorStatus?.batch_window_ms
        )
          ? Math.ceil((Number(intent.durationHours) * 3_600_000) / coordinatorStatus.batch_window_ms)
          : undefined,
        childAmount: intent.childSize ? toAtomicStr(intent.childSize, submitPair.base_asset_id) : undefined,
        randomizedSlicing: intent.jitter > 0,
        randomizedSlicingBps: intent.jitter * 100,
        offlineDelegation: intent.shape === "curve" && intent.resting && intent.relayMode === "ZylithRelay",
        relayMode: intent.relayMode ?? "SelfRelay",
      };

      const arrivalReference = arrivalReferenceSnapshot(
        submitPair,
        lastClearingPrices[submitPair.pair_id] ?? null,
      );
      const result = await w.submitPrivateOrder(draft);
      if (result.offline_package?.relay_mode === "ZylithRelay") {
        await submitManagedRenewalPackage(result.offline_package);
      }
      const submittedAt = Date.now();

      const newOrder: LocalOrder = {
        ordRef: genRef(),
        orderCommitment: result.order_commitment ?? result.first_child_order_commitment ?? "",
        cancellationSecret: result.cancellation_secret ?? result.first_child_cancellation_secret ?? "",
        expectedOutputMetadataCommitment: result.expected_output_metadata_commitment,
        fundingNoteCommitments: result.funding_note_commitments,
        strategyId: result.strategy_id,
        batchId: result.batch_id ?? result.first_child_batch_id ?? currentBatch.batch_id,
        epochId: currentBatch.epoch_id,
        pair: submitPair.pair_id,
        side: intent.side,
        wireMode: wm,
        amount: intent.shape === "curve" ? intent.inventoryCap || fromAtomicStr(curveBaseTotal.toString(), submitPair.base_asset_id) : intent.amount,
        fundingAsset,
        fundingAmount: fromAtomicStr(fundingAmountAtomic, fundingAsset),
        limitPrice: intent.shape === "limit" ? intent.limitPrice : intent.shape === "strategy" ? intent.priceLimit || "" : "",
        minFill: intent.minFill,
        fillOrKill: intent.fillOrKill,
        status: result.first_child_order_commitment || result.order_commitment ? "in_batch" : "queued",
        submittedAt,
        arrivalReferencePrice: arrivalReference.price,
        arrivalReferenceSource: arrivalReference.source,
        arrivalReferenceAt: arrivalReference.observedAt,
        makerCurvePoints: intent.shape === "curve"
          ? intent.curvePoints.filter(pt => pt.price.trim() && pt.baseAmount.trim())
          : undefined,
      };

      prependAndSaveOrder(newOrder);
      return true;
    } catch (e) {
      setSubmitError(userFacingErrorMessage(e));
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  function handleFundingPreview(intent: TicketSubmitIntent): FundingPreview | null {
    const w = walletRuntime();
    const previewPair = pairForIntent(intent);
    const previewBatch = previewPair ? batchByPair[previewPair.pair_id] ?? null : null;
    if (!w || !w.isReady() || !previewPair || !previewBatch) return null;

    const wm = wireMode(intent.shape, intent.resting, intent.stratKind);
    const priceBaseScale = previewPair.price_base_scale ?? assetScale(previewPair.base_asset_id).toString();
    const base = previewPair.base_asset_id;
    const quote = previewPair.quote_asset_id;
    const atomicCurvePoints = intent.shape === "curve"
      ? intent.curvePoints
          .filter(pt => pt.price.trim() && pt.baseAmount.trim())
          .map(pt => ({
            price: toPriceAtomicStr(pt.price, quote),
            baseAmount: toAtomicStr(pt.baseAmount, base),
          }))
      : undefined;
    const sortedCurvePoints = [...(atomicCurvePoints ?? [])]
      .sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0));
    const curveBaseTotal = sortedCurvePoints.reduce((total, pt) => total + BigInt(pt.baseAmount), 0n);
    const curveEnvelopePrice = sortedCurvePoints.length > 0
      ? (intent.side === "Buy" ? sortedCurvePoints[sortedCurvePoints.length - 1].price : sortedCurvePoints[0].price)
      : "0";
    const atomicPrice = intent.shape === "curve"
      ? curveEnvelopePrice
      : toPriceAtomicStr(intent.shape === "limit" ? intent.limitPrice : intent.priceLimit || "0", quote);
    let atomicAmount = intent.shape === "curve"
      ? (intent.inventoryCap.trim() ? toAtomicStr(intent.inventoryCap, base) : curveBaseTotal.toString())
      : toAtomicStr(intent.amount, base);
    let mode = wm;

    if (intent.shape === "strategy") {
      const durationBatches = coordinatorStatus?.batch_window_ms && intent.durationHours
        ? Math.max(1, Math.ceil((Number(intent.durationHours) * 3_600_000) / coordinatorStatus.batch_window_ms))
        : 1;
      atomicAmount = intent.childSize
        ? toAtomicStr(intent.childSize, base)
        : ceilDivBigInt(BigInt(atomicAmount), BigInt(durationBatches)).toString();
      mode = "Limit";
    }

    return w.previewFundingNotes({
      pair: previewPair.pair_id,
      side: intent.side,
      mode,
      amount: atomicAmount,
      limitPrice: atomicPrice,
      minFill: toAtomicStr(intent.minFill || "0", base),
      fillOrKill: intent.fillOrKill,
      batchId: previewBatch.batch_id,
      makerCurvePoints: atomicCurvePoints,
      makerInventoryCap: intent.shape === "curve" && intent.inventoryCap.trim()
        ? toAtomicStr(intent.inventoryCap, base)
        : undefined,
      priceBaseScale,
      submissionTimingPreference: userPreferences.submissionTiming,
    });
  }

  // Cancel order
  async function handleCancelOrder(order: LocalOrder) {
    const w = walletRuntime();
    const markCancelled = (cancelTransactionHash?: string) => {
      saveAndSet(orders.map(o =>
        o.ordRef === order.ordRef
          ? { ...o, status: "cancelled" as LocalOrderStatus, cancelTransactionHash }
          : o,
      ));
    };

    if (order.strategyId) {
      if (!w || !w.isReady()) {
        setSubmitError("Unlock Zylith wallet before cancelling this strategy.");
        return;
      }
      try {
        const result = await w.cancelPrivateStrategy(order.strategyId);
        markCancelled(result.parent_cancel_transaction_hash);
        return;
      } catch (error) {
        setSubmitError(userFacingErrorMessage(error));
        return;
      }
    } else if (order.cancellationSecret && w && w.isReady()) {
      try {
        await w.cancelPrivateOrder({
          batch_id: order.batchId,
          order_commitment: order.orderCommitment,
          cancellation_secret: order.cancellationSecret,
        });
      } catch { /* noop — still mark locally */ }
    }
    markCancelled();
  }

  async function handlePauseStrategy(strategyId: string) {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Unlock Zylith wallet before pausing this curve.");
      return;
    }
    try {
      await w.pausePrivateStrategy(strategyId);
      setBalanceTick(v => v + 1);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
    }
  }

  async function handleResumeStrategy(strategyId: string) {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Unlock Zylith wallet before resuming this curve.");
      return;
    }
    try {
      await w.resumePrivateStrategy(strategyId);
      setBalanceTick(v => v + 1);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
    }
  }

  async function handleRefreshStrategyPackage(strategyId: string) {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Unlock Zylith wallet before refreshing this package.");
      return;
    }
    try {
      const renewalPackage = await w.refreshPrivateStrategyPackage(strategyId);
      if (renewalPackage.relay_mode === "ZylithRelay") {
        await submitManagedRenewalPackage(renewalPackage);
      }
      setBalanceTick(v => v + 1);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
    }
  }

  function toggleLiquidityWorkspace() {
    if (workspace === "liquidity") {
      navigatePath(sessionGet(LAST_TAKER_ROUTE_KEY, "/trade"));
      return;
    }
    const remembered = sessionGet(LAST_LIQUIDITY_ROUTE_KEY, "/liquidity/curves");
    const path = liquidityPath(liquidityTabFromPath(remembered));
    window.open(`${window.location.origin}${path}`, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="app-shell">
      <TopNav
        workspace={workspace}
        tab={tab}
        liquidityTab={liquidityTab}
        setTab={changeTab}
        setLiquidityTab={changeLiquidityTab}
        onBrandClick={() => navigatePath("/trade")}
        onToggleLiquidity={toggleLiquidityWorkspace}
        activeOrderCount={activeOrders.length}
        claimableOutputCount={claimableOutputCount}
        walletReady={walletReady}
        submissionTimingPreference={userPreferences.submissionTiming}
        setSubmissionTimingPreference={updateSubmissionTiming}
        withdrawalRoutePreference={userPreferences.withdrawalRoute}
        setWithdrawalRoutePreference={updateWithdrawalRoute}
        starknetAddress={starknetAddress}
        onOpenWallet={() => setOpenSlide("wallet")}
        onDeposit={() => setOpenSlide("deposit")}
        onWithdraw={() => setOpenSlide("withdraw")}
        onRecovery={() => setOpenSlide("recovery")}
        onLock={() => { walletRuntime()?.lock(); }}
        onDisconnectWallet={() => setStarknetAddress(null)}
      />

      <main className="screen">
        {workspace === "taker" && tab === "trade" && (
          <div className="trade-grid">
            <PairList
              pairs={pairs}
              activePairId={activePair?.pair_id ?? activePairId}
              onSelect={setActivePairId}
              batchByPair={batchByPair}
              lastClearingPrices={lastClearingPrices}
            />

            <div className="trade-center">
              <PairHeader
                pair={activePair}
                lastClearing={activePair ? lastClearingPrices[activePair.pair_id] ?? null : null}
              />
              <OrderTicket
                pair={activePair}
                balances={balances}
                batchWindowMs={coordinatorStatus?.batch_window_ms ?? 0}
                walletReady={walletReady}
                hasPrivateBalance={balances.some(balance =>
                  BigInt(balance.available) > 0n || BigInt(balance.locked) > 0n,
                )}
                onOpenWallet={() => setOpenSlide("wallet")}
                onDeposit={() => setOpenSlide("deposit")}
                submitting={submitting}
                submitError={submitError}
                onPreviewFunding={handleFundingPreview}
                onSubmit={handleSubmit}
              />
              <ReportsStrip orders={orders} onOpenReports={() => changeTab("reports")} />
            </div>

            <RightColumn
              activeBatch={activeBatch}
              settlementTranscripts={settlementTranscripts}
              online={online}
              allAssets={allAssets}
              pairs={pairs}
              balances={balances}
              pendingDeposits={pendingDeposits}
              withdrawableNotes={withdrawableNotes}
              claimDelaySeconds={claimDelaySeconds}
              walletReady={walletReady}
              starknetAddress={starknetAddress}
              activeOrders={activeOrders}
              setOpenSlide={setOpenSlide}
              allOrders={orders}
              onCancelOrder={handleCancelOrder}
              onClaimNote={(note) => {
                setSlideAsset(note.asset);
                setClaimNoteCommitment(note.note_commitment);
                setOpenSlide("withdraw");
              }}
            />
          </div>
        )}

        {workspace === "taker" && tab === "orders" && (
          <OrdersScreen
            orders={orders}
            strategies={strategies}
            batches={batches}
            settlementTranscripts={settlementTranscripts}
            withdrawableNotes={withdrawableNotes}
            onCancel={order => { void handleCancelOrder(order); }}
            walletReady={walletReady}
          />
        )}

        {workspace === "taker" && tab === "assets" && (
          <AssetsScreen
            allAssets={allAssets}
            depositableAssets={depositableAssets}
            pairs={pairs}
            balances={balances}
            pendingDeposits={pendingDeposits}
            withdrawableNotes={withdrawableNotes}
            settlementTranscripts={settlementTranscripts}
            claimDelaySeconds={claimDelaySeconds}
            orders={orders}
            walletReady={walletReady}
            starknetAddress={starknetAddress}
            onDeposit={(asset) => {
              if (asset) setSlideAsset(asset);
              setOpenSlide("deposit");
            }}
            onWithdraw={(asset, noteCommitment) => {
              if (asset) setSlideAsset(asset);
              setClaimNoteCommitment(noteCommitment ?? null);
              setOpenSlide("withdraw");
            }}
            onClaimNote={(note) => {
              setSlideAsset(note.asset);
              setClaimNoteCommitment(note.note_commitment);
              setOpenSlide("withdraw");
            }}
            onConnectWallet={() => setOpenSlide("wallet")}
          />
        )}

        {workspace === "taker" && tab === "reports" && (
          <Suspense fallback={<div className="empty-zone"><div className="empty-mark">—</div><div className="empty-body">Loading reports</div></div>}>
            <ReportsScreen
              orders={orders}
              strategies={strategies}
              walletReady={walletReady}
              activeEpochId={activeBatch?.epoch_id ?? null}
              batchWindowMs={coordinatorStatus?.batch_window_ms ?? null}
            />
          </Suspense>
        )}

        {workspace === "liquidity" && (
          <Suspense fallback={<div className="empty-zone"><div className="empty-mark">—</div><div className="empty-body">Loading liquidity</div></div>}>
            <LiquidityWorkspace
              tab={liquidityTab}
              pairs={pairs}
              activePairId={liquidityPairId}
              setActivePairId={setLiquidityPairId}
              orders={orders}
              strategies={strategies}
              batches={batches}
              balances={balances}
              pendingDeposits={pendingDeposits}
              withdrawableNotes={withdrawableNotes}
              settlementTranscripts={settlementTranscripts}
              walletReady={walletReady}
              submitting={submitting}
              submitError={submitError}
              onPreviewFunding={handleFundingPreview}
              onSubmitCurve={handleSubmit}
              onCancelOrder={order => { void handleCancelOrder(order); }}
              onPauseStrategy={handlePauseStrategy}
              onResumeStrategy={handleResumeStrategy}
              onRefreshStrategyPackage={handleRefreshStrategyPackage}
              onDeposit={(asset) => {
                if (asset) setSlideAsset(asset);
                setOpenSlide("deposit");
              }}
              onWithdraw={(asset) => {
                if (asset) setSlideAsset(asset);
                setOpenSlide("withdraw");
              }}
              onNavigateCurves={() => changeLiquidityTab("curves")}
            />
          </Suspense>
        )}
      </main>

      <WalletSlide
        open={openSlide === "wallet"}
        onClose={() => setOpenSlide(null)}
        runtimeStatus={runtimeStatus}
        hasVault={hasVault}
        starknetAddress={starknetAddress}
        onStarknetConnected={setStarknetAddress}
        onStarknetDisconnected={() => setStarknetAddress(null)}
      />
      <DepositSlide
        open={openSlide === "deposit"}
        onClose={() => setOpenSlide(null)}
        defaultAsset={slideAsset}
        allAssets={depositableAssets.length > 0 ? depositableAssets : allAssets}
        starknetAddress={starknetAddress}
        onOpenWallet={() => setOpenSlide("wallet")}
        setSlideAsset={setSlideAsset}
      />
      <WithdrawSlide
        open={openSlide === "withdraw"}
        onClose={() => { setOpenSlide(null); setClaimNoteCommitment(null); }}
        defaultAsset={slideAsset}
        defaultNoteCommitment={claimNoteCommitment}
        settlementTranscripts={settlementTranscripts}
        claimDelaySeconds={claimDelaySeconds}
        withdrawalRoutePreference={userPreferences.withdrawalRoute}
        allAssets={allAssets}
        setSlideAsset={setSlideAsset}
      />
      <RecoverySlide
        open={openSlide === "recovery"}
        onClose={() => setOpenSlide(null)}
      />
    </div>
  );
}
