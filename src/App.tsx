import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./globals.css";
import {
  type LocalOrder,
  type LocalOrderStatus,
  type PrivateStrategySummary,
  isLiquidityPositionOrder,
  normalizeLocalOrder,
  ordersChanged,
  reconcileOrderLifecycle,
} from "./domain/orderLifecycle";
import {
  type PendingDeposit,
  type WalletBalance,
  type WithdrawableNote,
} from "./domain/shieldedBalances";
import {
  assetScale,
  configureAssetDecimals,
  formatClearingPrice,
  fromAtomicStr,
  toAtomicStr,
  toPriceAtomicStr,
} from "./domain/assets";
import {
  connectedStarknetAddress,
  restoreConnectedStarknetWallet,
  walletRuntime,
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
  type PublicSettlementTranscript,
  apiSubmittablePairBatch,
  lastClearingByPair,
  useBatches,
  useCoordinatorStatus,
  useDeployment,
  usePublicProofJobStatuses,
  usePublicSettlementTranscripts,
} from "./domain/auctionEpoch";
import { hasBatchSubmissionSafetyWindow } from "./domain/batchSubmission";
import { PairHeader, PairList, ReportsStrip } from "./components/MarketPanels";
import { RightColumn } from "./components/RightColumn";
import {
  liquidityPath,
  liquidityTabFromPath,
  takerPath,
  takerTabFromPath,
  type AppTab,
  type LiquidityTab,
  type Workspace,
} from "./domain/appRoutes";
import {
  TopNav,
} from "./components/TopNav";
import {
  DepositSlide,
  WalletSlide,
  WithdrawSlide,
} from "./components/WalletSlides";
import { AssetsScreen } from "./screens/AssetsScreen";
import { OrdersScreen } from "./screens/OrdersScreen";
import { userFacingErrorMessage } from "./domain/userFacingErrors";
import { sessionGet, sessionSet } from "./domain/safeSessionStorage";
import {
  normalizeFeltForComparison,
  privateReportOrderSyncKey,
} from "./domain/privateReportSync";
import { subscribePrivateSettlementReports } from "./domain/privateSettlementReportEvents";
import { claimableOutputs } from "./domain/noteLifecycle";
import { useWalletState } from "./hooks/useWalletState";
import {
  deleteLiquidityAutomationPackage,
  fetchLiquidityAutomationPackageResults,
  submitLiquidityAutomationPackage,
} from "./domain/liquidityAutomationRelay";
import {
  deleteSelfHostedRenewalPackage,
  fetchSelfHostedRenewalPackageResults,
  normalizeSelfRelayUrl,
  readSelfHostedRelayUrl,
  storeSelfHostedRelayUrl,
  submitSelfHostedRenewalPackage,
} from "./domain/selfHostedRenewalRelay";
import type { PrivateLiquidityPositionOpenRequest } from "@zylith/sdk";

const ReportsScreen = lazy(() =>
  import("./screens/ReportsScreen").then((module) => ({
    default: module.ReportsScreen,
  }))
);
const LiquidityWorkspace = lazy(() =>
  import("./screens/LiquidityScreens").then((module) => ({
    default: module.LiquidityWorkspace,
  }))
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
  stratKind: StratKind
): LocalOrder["wireMode"] {
  if (shape === "limit") return "Limit";
  if (shape === "curve") return resting ? "Resting" : "Liquidity Position";
  return stratKind;
}

function deploymentOrderScope(deployment: DeploymentConfig | null): string {
  return `${deployment?.chain_id ?? "unknown-chain"}:${
    deployment?.contracts?.auction_verifier ?? "unknown-verifier"
  }`;
}

function walletOrderOwnerKey(
  deployment: DeploymentConfig | null
): string | null {
  const accountId = walletRuntime()?.getPublicConfig?.()?.account_id ?? null;
  return accountId ? `${accountId}:${deploymentOrderScope(deployment)}` : null;
}

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
  "proof_failed",
  "stalled",
]);
const PRIVATE_REPORT_RECOVERY_STATUSES = new Set<LocalOrderStatus>([
  "in_batch",
  "proving",
  "settling",
  "settled_pending_output",
  "filled",
  "partial",
  "no_fill",
  "proof_failed",
  "stalled",
]);
const PRIVATE_REPORT_RETRY_MS = 3_000;
const PRIVATE_REPORT_READY_STATUSES = new Set<LocalOrderStatus>([
  "settled_pending_output",
  "filled",
  "partial",
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
  funding_note_commitments?: string[];
  filled_amount: string;
  unfilled_amount: string;
  execution_price?: string | null;
};

type PrivateSettlementReportForApp = {
  batch_id: string;
  pair_id: string;
  batch_epoch: number;
  settled_at_unix_ms?: number;
  clearing_price: string;
  price_base_scale?: string;
  output_recovery_records?: unknown[];
  order_execution_reports?: PrivateExecutionReportForApp[];
};

function lastClearingReference(
  pair: PairConfig,
  lastClearingPrice: {
    batchId: string;
    epochId: number;
    clearingPrice: string;
    priceBaseScale?: string;
  } | null
): ArrivalReferenceSnapshot {
  if (!lastClearingPrice) return {};
  return {
    price: formatClearingPrice(lastClearingPrice, pair),
    source: "last_clearing",
    observedAt: Date.now(),
  };
}

function displayBatchForPair(
  current: BatchSummary | undefined,
  candidate: BatchSummary,
) {
  if (!current) return candidate;
  const currentOpen = current.status === "Open";
  const candidateOpen = candidate.status === "Open";
  if (currentOpen && candidateOpen) {
    return candidate.epoch_id < current.epoch_id ? candidate : current;
  }
  if (candidateOpen !== currentOpen) return candidateOpen ? candidate : current;
  return candidate.epoch_id > current.epoch_id ? candidate : current;
}

async function resolveTicketSubmissionBatch(
  pair: PairConfig,
  displayedBatch: BatchSummary | null | undefined,
  batchWindowMs?: number,
): Promise<BatchSummary> {
  if (
    displayedBatch?.status === "Open" &&
    hasBatchSubmissionSafetyWindow(
      displayedBatch.close_time_unix_ms,
      Date.now(),
      batchWindowMs,
    )
  ) {
    return displayedBatch;
  }
  const [base, quote] = pair.pair_id.split("/");
  if (!base || !quote) throw new Error(`Invalid pair ${pair.pair_id}`);
  const submittable = await apiSubmittablePairBatch(base, quote);
  if (submittable.status !== "Open") {
    throw new Error("This pair is not accepting orders right now.");
  }
  return submittable;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const deployment = useDeployment();
  const coordinatorStatus = useCoordinatorStatus();
  const { batches, online } = useBatches();
  const recentSettlementTranscripts = usePublicSettlementTranscripts(batches);

  const pairs = useMemo(
    () =>
      deployment
        ? Object.values(deployment.product.pairs).filter((p) => p.enabled)
        : [],
    [deployment]
  );
  const allAssets = useMemo(
    () => [
      ...new Set(pairs.flatMap((p) => [p.base_asset_id, p.quote_asset_id])),
    ],
    [pairs]
  );
  const depositableAssets = useMemo(
    () =>
      allAssets.filter((asset) =>
        Boolean(deployment?.token_addresses?.[asset])
      ),
    [allAssets, deployment]
  );
  const batchByPair = batches.reduce<Record<string, BatchSummary>>((acc, b) => {
    acc[b.pair_id] = displayBatchForPair(acc[b.pair_id], b);
    return acc;
  }, {});
  useEffect(() => {
    configureAssetDecimals(deployment);
  }, [deployment]);

  // Workspace-aware URL routing
  const initialWorkspace: Workspace = window.location.pathname.startsWith(
    "/liquidity"
  )
    ? "liquidity"
    : "taker";
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [tab, setTab] = useState<AppTab>(() => {
    return takerTabFromPath(window.location.pathname);
  });
  const [liquidityTab, setLiquidityTabState] = useState<LiquidityTab>(() =>
    liquidityTabFromPath(window.location.pathname)
  );

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
      const normalizedPath = liquidityPath(
        liquidityTabFromPath(window.location.pathname)
      );
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
  const activePair =
    pairs.find((p) => p.pair_id === activePairId) ?? pairs[0] ?? null;
  const activeBatch = activePair
    ? batchByPair[activePair.pair_id] ?? null
    : null;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // UI state
  const [openSlide, setOpenSlide] = useState<
    "wallet" | "deposit" | "withdraw" | null
  >(null);
  const [slideAsset, setSlideAsset] = useState("STRK");
  const [claimNoteCommitment, setClaimNoteCommitment] = useState<string | null>(
    null
  );
  const [starknetAddress, setStarknetAddress] = useState<string | null>(() => {
    return connectedStarknetAddress();
  });
  const { runtimeStatus, walletReady, hasVault } =
    useWalletState(starknetAddress);

  function reconcileConnectedStarknetAddress(
    previous: string | null,
    next: string | null
  ) {
    if (previous === next) return previous;
    if (previous) walletRuntime()?.lock();
    return next;
  }

  useEffect(() => {
    let cancelled = false;
    const restore = () => {
      void restoreConnectedStarknetWallet()
        .then((address) => {
          if (!cancelled) {
            setStarknetAddress((previous) =>
              reconcileConnectedStarknetAddress(previous, address)
            );
          }
        })
        .catch(() => undefined);
    };
    restore();
    window.addEventListener("focus", restore);
    window.addEventListener("starknet#initialized", restore);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", restore);
      window.removeEventListener("starknet#initialized", restore);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const next = connectedStarknetAddress();
      setStarknetAddress((previous) => {
        return reconcileConnectedStarknetAddress(previous, next);
      });
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  // Orders
  const [orderOwnerKey, setOrderOwnerKey] = useState<string | null>(() =>
    walletOrderOwnerKey(null)
  );
  const [orders, setOrders] = useState<LocalOrder[]>([]);
  const [ordersHydratedForOwner, setOrdersHydratedForOwner] = useState(false);
  const ordersRef = useRef(orders);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);
  const orderBatchIds = useMemo(
    () =>
      Array.from(
        new Set(
          orders
            .filter((order) => PROOF_TRACKED_ORDER_STATUSES.has(order.status))
            .map((order) => order.batchId)
            .filter(Boolean)
        )
      ),
    [orders]
  );
  const orderSettlementTranscripts = usePublicSettlementTranscripts(
    [],
    orderBatchIds
  );
  const publicSettlementTranscripts = useMemo(
    () => ({ ...recentSettlementTranscripts, ...orderSettlementTranscripts }),
    [orderSettlementTranscripts, recentSettlementTranscripts]
  );
  const [privateSettlementTranscripts, setPrivateSettlementTranscripts] =
    useState<Record<string, PublicSettlementTranscript>>({});
  const settlementTranscripts = useMemo(
    () => ({ ...privateSettlementTranscripts, ...publicSettlementTranscripts }),
    [privateSettlementTranscripts, publicSettlementTranscripts]
  );
  const lastClearingPrices = lastClearingByPair(settlementTranscripts);
  const activeProofBatchIds = useMemo(
    () =>
      Array.from(
        new Set(
          orders
            .filter((order) => PROOF_TRACKED_ORDER_STATUSES.has(order.status))
            .map((order) => order.batchId)
            .filter(Boolean)
        )
      ),
    [orders]
  );
  const proofStatuses = usePublicProofJobStatuses(activeProofBatchIds);
  const privateReportRequestsInFlight = useRef<Set<string>>(new Set());
  const privateReportSyncedOrders = useRef<Set<string>>(new Set());
  const privateReportLastAttemptAt = useRef<Map<string, number>>(new Map());
  const [privateReportRetryTick, setPrivateReportRetryTick] = useState(0);
  const [balanceTick, setBalanceTick] = useState(0);
  const persistOrders = useCallback((next: LocalOrder[]) => {
    const w = walletRuntime();
    if (w?.isReady() && w.saveLocalOrders) {
      void w.saveLocalOrders(next).catch(() => undefined);
    }
  }, []);
  const saveAndSet = useCallback(
    (next: LocalOrder[]) => {
      ordersRef.current = next;
      setOrders(next);
      persistOrders(next);
    },
    [persistOrders]
  );
  const prependAndSaveOrder = useCallback(
    (order: LocalOrder) => {
      setOrders((previous) => {
        const next = [order, ...previous];
        ordersRef.current = next;
        persistOrders(next);
        return next;
      });
    },
    [persistOrders]
  );

  const applyPrivateSettlementReports = useCallback(
    (reports: PrivateSettlementReportForApp[]) => {
      if (reports.length === 0) return;
      setPrivateSettlementTranscripts((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const report of reports) {
          const candidate: PublicSettlementTranscript = {
            batch_id: report.batch_id,
            pair_id: report.pair_id,
            batch_epoch: report.batch_epoch,
            clearing_price: report.clearing_price,
            price_base_scale: report.price_base_scale,
            settled_at_unix_ms: report.settled_at_unix_ms,
            loaded_at_unix_ms: Date.now(),
          };
          const existing = next[report.batch_id];
          if (
            existing?.clearing_price === candidate.clearing_price &&
            existing?.price_base_scale === candidate.price_base_scale &&
            existing?.settled_at_unix_ms === candidate.settled_at_unix_ms
          ) {
            continue;
          }
          next[report.batch_id] = candidate;
          changed = true;
        }
        return changed ? next : prev;
      });

      const reportByOrder = new Map<
        string,
        {
          report: PrivateSettlementReportForApp;
          execution: PrivateExecutionReportForApp;
        }
      >();
      for (const report of reports) {
        for (const execution of report.order_execution_reports ?? []) {
          reportByOrder.set(
            normalizeFeltForComparison(execution.order_commitment),
            { report, execution }
          );
        }
      }

      const successfulOrderKeys = new Set<string>();
      const lockUpdates: Promise<unknown>[] = [];
      const walletForLockUpdates = walletRuntime();
      let changed = false;
      const nextOrders = ordersRef.current.map((order) => {
        const matched = reportByOrder.get(
          normalizeFeltForComparison(order.orderCommitment)
        );
        if (!matched) return order;
        const pair = pairs.find(
          (candidate) => candidate.pair_id === matched.report.pair_id
        );
        if (!pair) return order;
        const syncKey = privateReportOrderSyncKey(
          matched.report.batch_id,
          matched.execution.order_commitment
        );
        const filledAtomic = BigInt(matched.execution.filled_amount || "0");
        const unfilledAtomic = BigInt(matched.execution.unfilled_amount || "0");
        const clearingPrice = formatClearingPrice(
          {
            batchId: matched.report.batch_id,
            epochId: matched.report.batch_epoch,
            clearingPrice:
              matched.execution.execution_price ||
              matched.report.clearing_price,
            priceBaseScale: matched.report.price_base_scale,
          },
          pair
        );
        const reportFundingCommitments = [
          ...(matched.execution.funding_note_commitments ?? []),
        ].filter((value): value is string => Boolean(value));
        const settlementFunding = {
          asset: order.fundingAsset,
          amount: order.fundingAmount,
          batchId: order.batchId,
          noteCommitments:
            reportFundingCommitments.length > 0
              ? reportFundingCommitments
              : order.fundingNoteCommitments,
        };
        if (filledAtomic <= 0n) {
          if (syncKey) successfulOrderKeys.add(syncKey);
          if (walletForLockUpdates?.settlePrivateOrderLock) {
            lockUpdates.push(
              walletForLockUpdates
                .settlePrivateOrderLock(
                  order.orderCommitment,
                  "released",
                  settlementFunding
                )
                .catch(() => false)
            );
          }
          if (
            order.status === "no_fill" &&
            order.clearingPrice === clearingPrice
          )
            return order;
          changed = true;
          return {
            ...order,
            status: "no_fill" as LocalOrderStatus,
            clearingPrice,
          };
        }
        const nextStatus: LocalOrderStatus =
          unfilledAtomic > 0n ? "partial" : "filled";
        const filledAmount = fromAtomicStr(
          filledAtomic.toString(),
          pair.base_asset_id
        );
        if (syncKey) successfulOrderKeys.add(syncKey);
        if (walletForLockUpdates?.settlePrivateOrderLock) {
          lockUpdates.push(
            walletForLockUpdates
              .settlePrivateOrderLock(
                order.orderCommitment,
                "spent",
                settlementFunding
              )
              .catch(() => false)
          );
        }
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
      successfulOrderKeys.forEach((syncKey) =>
        privateReportSyncedOrders.current.add(syncKey)
      );
      if (changed) {
        saveAndSet(nextOrders);
      }
      setBalanceTick((value) => value + 1);
      if (lockUpdates.length > 0) {
        void Promise.all(lockUpdates).finally(() =>
          setBalanceTick((value) => value + 1)
        );
      }
    },
    [pairs, saveAndSet]
  );

  useEffect(() => {
    const nextOwnerKey = walletReady ? walletOrderOwnerKey(deployment) : null;
    if (nextOwnerKey === orderOwnerKey) return;
    ordersRef.current = [];
    setOrders([]);
    setOrderOwnerKey(nextOwnerKey);
    setOrdersHydratedForOwner(false);
    let cancelled = false;
    async function loadWalletOrders() {
      const activeDeploymentScope = deploymentOrderScope(deployment);
      const w = walletRuntime();
      const loadedOrders =
        w?.isReady() && w.loadLocalOrders
          ? (await w.loadLocalOrders().catch(() => [] as LocalOrder[]))
              .map(normalizeLocalOrder)
              .filter(
                (order) => order.deployment_scope === activeDeploymentScope
              )
          : [];
      if (cancelled) return;
      ordersRef.current = loadedOrders;
      setOrders(loadedOrders);
      setOrdersHydratedForOwner(true);
    }
    void loadWalletOrders();
    privateReportRequestsInFlight.current.clear();
    privateReportSyncedOrders.current.clear();
    privateReportLastAttemptAt.current.clear();
    setPrivateSettlementTranscripts({});
    return () => {
      cancelled = true;
    };
  }, [deployment, walletReady, runtimeStatus, orderOwnerKey]);

  useEffect(() => {
    if (
      !walletReady ||
      !ordersHydratedForOwner ||
      orders.length === 0 ||
      pairs.length === 0
    )
      return;
    const w = walletRuntime();
    if (!w?.isReady() || !w.syncPrivateSettlementReports) return;
    const reportAttemptNow = Date.now();
    const requests = Object.values(
      orders.reduce<
        Record<
          string,
          {
            batch_id: string;
            orders: Array<{
              order_commitment: string;
              cancellation_secret: string;
            }>;
          }
        >
      >((acc, order) => {
        if (
          !order.batchId ||
          !order.orderCommitment ||
          !order.cancellationSecret
        )
          return acc;
        if (!PRIVATE_REPORT_RECOVERY_STATUSES.has(order.status)) return acc;
        const syncKey = privateReportOrderSyncKey(
          order.batchId,
          order.orderCommitment
        );
        if (!syncKey || privateReportSyncedOrders.current.has(syncKey))
          return acc;
        if (privateReportRequestsInFlight.current.has(order.batchId))
          return acc;
        const lastAttemptAt =
          privateReportLastAttemptAt.current.get(syncKey) ?? 0;
        if (reportAttemptNow - lastAttemptAt < PRIVATE_REPORT_RETRY_MS)
          return acc;
        const proofStatus = proofStatuses[order.batchId];
        const hasProofReportSignal = Boolean(
          proofStatus?.state === "confirmed-onchain"
        );
        const hasSettlementSignal =
          hasProofReportSignal ||
          Boolean(settlementTranscripts[order.batchId]) ||
          PRIVATE_REPORT_READY_STATUSES.has(order.status);
        if (!hasSettlementSignal) return acc;
        const existing = acc[order.batchId] ?? {
          batch_id: order.batchId,
          orders: [],
        };
        if (
          !existing.orders.some(
            (entry) =>
              normalizeFeltForComparison(entry.order_commitment) ===
              normalizeFeltForComparison(order.orderCommitment)
          )
        ) {
          existing.orders.push({
            order_commitment: order.orderCommitment,
            cancellation_secret: order.cancellationSecret,
          });
        }
        acc[order.batchId] = existing;
        return acc;
      }, {})
    );
    if (requests.length === 0) return;
    requests.forEach((request) => {
      privateReportRequestsInFlight.current.add(request.batch_id);
      request.orders.forEach((order) => {
        const syncKey = privateReportOrderSyncKey(
          request.batch_id,
          order.order_commitment
        );
        if (syncKey)
          privateReportLastAttemptAt.current.set(syncKey, reportAttemptNow);
      });
    });
    let cancelled = false;
    async function syncReports() {
      const reports = await w!
        .syncPrivateSettlementReports(requests)
        .catch(() => [] as PrivateSettlementReportForApp[]);
      requests.forEach((request) =>
        privateReportRequestsInFlight.current.delete(request.batch_id)
      );
      if (cancelled) return;
      if (reports.length === 0) return;
      applyPrivateSettlementReports(reports as PrivateSettlementReportForApp[]);
    }
    void syncReports();
    return () => {
      cancelled = true;
    };
  }, [
    applyPrivateSettlementReports,
    orders,
    ordersHydratedForOwner,
    pairs,
    privateReportRetryTick,
    proofStatuses,
    settlementTranscripts,
    walletReady,
  ]);

  useEffect(() => {
    return subscribePrivateSettlementReports((count) => {
      if (count > 0) setPrivateReportRetryTick((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    if (!walletReady || !ordersHydratedForOwner || orders.length === 0) return;
    const hasPendingPrivateReport = orders.some((order) => {
      if (!order.batchId || !order.orderCommitment) return false;
      if (!PRIVATE_REPORT_RECOVERY_STATUSES.has(order.status)) return false;
      const syncKey = privateReportOrderSyncKey(
        order.batchId,
        order.orderCommitment
      );
      if (!syncKey || privateReportSyncedOrders.current.has(syncKey))
        return false;
      if (privateReportRequestsInFlight.current.has(order.batchId))
        return false;
      const proofStatus = proofStatuses[order.batchId];
      return (
        proofStatus?.state === "confirmed-onchain" ||
        Boolean(settlementTranscripts[order.batchId]) ||
        PRIVATE_REPORT_READY_STATUSES.has(order.status)
      );
    });
    if (!hasPendingPrivateReport) return;
    const retryTimer = setInterval(() => {
      setPrivateReportRetryTick((value) => value + 1);
    }, PRIVATE_REPORT_RETRY_MS);
    return () => clearInterval(retryTimer);
  }, [
    orders,
    ordersHydratedForOwner,
    proofStatuses,
    settlementTranscripts,
    walletReady,
  ]);

  // Balance polling
  useEffect(() => {
    if (!walletReady || !ordersHydratedForOwner) return;
    let cancelled = false;
    const refreshDeposits = async () => {
      const w = walletRuntime();
      if (w?.isReady()) {
        const changed = await w.refreshDepositState?.().catch(() => false);
        if (!cancelled && changed) setBalanceTick((v) => v + 1);
      }
    };
    const refreshPublicArtifacts = async () => {
      const w = walletRuntime();
      if (w?.isReady()) {
        const changed = await w.scanNotes?.().catch(() => false);
        if (!cancelled && changed) setBalanceTick((v) => v + 1);
      }
    };
    const pruneStaleSettlementOutputs = async () => {
      const w = walletRuntime();
      if (w?.isReady()) {
        const changed = await w
          .pruneUnsettledSettlementOutputs?.()
          .catch(() => false);
        if (!cancelled && changed) setBalanceTick((v) => v + 1);
      }
    };
    void refreshDeposits();
    void refreshPublicArtifacts();
    void pruneStaleSettlementOutputs();
    const depositTimer = setInterval(() => {
      void refreshDeposits();
    }, 5_000);
    const publicArtifactTimer = setInterval(() => {
      void refreshPublicArtifacts();
    }, 30_000);
    const pruneTimer = setInterval(() => {
      void pruneStaleSettlementOutputs();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(depositTimer);
      clearInterval(publicArtifactTimer);
      clearInterval(pruneTimer);
    };
  }, [walletReady, ordersHydratedForOwner]);

  const wallet = walletRuntime();
  const balances: WalletBalance[] = walletReady
    ? wallet?.getBalances() ?? []
    : [];
  const pendingDeposits: PendingDeposit[] = walletReady
    ? wallet?.getPendingDeposits?.() ?? []
    : [];
  const withdrawableNotes: WithdrawableNote[] = walletReady
    ? wallet?.getWithdrawableNotes() ?? []
    : [];
  const noteConsolidationAvailable = walletReady
    ? wallet?.noteConsolidationAvailable?.() ?? false
    : false;
  const strategies: PrivateStrategySummary[] = walletReady
    ? wallet?.getPrivateStrategies?.() ?? []
    : [];
  const claimDelaySeconds = deployment?.proof?.output_claim_delay_seconds ?? 0;

  // Status updates from batch state changes
  useEffect(() => {
    if (!walletReady || !ordersHydratedForOwner) return;
    const updated = reconcileOrderLifecycle({
      orders,
      batches,
      settlementTranscripts,
      proofStatuses,
      withdrawableNotes,
      pairs,
      formatClearingPrice: (price, pair) =>
        formatClearingPrice(price, pair as PairConfig),
      noFillDisplayAfterEpochs: 10,
      toAtomicStr,
      fromAtomicStr,
      assetScale,
    });
    if (ordersChanged(orders, updated)) {
      saveAndSet(updated);
    }
  }, [
    batches,
    balanceTick,
    settlementTranscripts,
    proofStatuses,
    pairs,
    orders,
    ordersHydratedForOwner,
    saveAndSet,
    walletReady,
    withdrawableNotes,
  ]);

  useEffect(() => {
    if (!walletReady || !ordersHydratedForOwner) return;
    const renewalPackages = Array.from(
      new Map(
        strategies
          .filter((strategy) =>
            ["active", "delegated", "pending_relay", "paused"].includes(
              strategy.status
            )
          )
          .map((strategy) => strategy.offline_package)
          .filter(
            (pkg): pkg is NonNullable<typeof pkg> =>
              pkg?.relay_mode === "ZylithRelay" ||
              (pkg?.relay_mode === "SelfRelay" &&
                Boolean(readSelfHostedRelayUrl(pkg.package_id)))
          )
          .map((pkg) => [pkg.package_id, pkg] as const)
      ).values()
    );
    if (renewalPackages.length === 0) return;
    let cancelled = false;
    let timer: number | null = null;
    async function syncLiquidityAutomationRelayResults() {
      const w = walletRuntime();
      if (!w?.isReady()) return;
      let changed = false;
      for (const renewalPackage of renewalPackages) {
        const response = await (renewalPackage.relay_mode === "ZylithRelay"
          ? fetchLiquidityAutomationPackageResults(renewalPackage)
          : fetchSelfHostedRenewalPackageResults(
              readSelfHostedRelayUrl(renewalPackage.package_id),
              renewalPackage
            )
        ).catch((error: unknown) => {
          setSubmitError(userFacingErrorMessage(error));
          return undefined;
        });
        if (response === undefined) continue;
        if (!response) continue;
        if (!response?.results?.length || cancelled) continue;
        changed =
          (await w
            .recordOfflineRenewalRelayResults(
              renewalPackage.package_id,
              response.results
            )
            .catch(() => false)) || changed;
      }
      if (!cancelled && changed) setBalanceTick((value) => value + 1);
    }
    function scheduleNextRelayPoll(initial = false) {
      if (cancelled) return;
      const baseDelay = initial ? 2_000 : 18_000;
      const jitter = Math.floor(Math.random() * 9_000);
      timer = window.setTimeout(() => {
        void syncLiquidityAutomationRelayResults().finally(() =>
          scheduleNextRelayPoll(false)
        );
      }, baseDelay + jitter);
    }
    scheduleNextRelayPoll(true);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [walletReady, ordersHydratedForOwner, strategies]);

  const renderOrders = orders;
  const renderStrategies = strategies;
  const renderLiquidityOrders = useMemo(
    () => renderOrders.filter(isLiquidityPositionOrder),
    [renderOrders]
  );
  const renderTakerOrders = useMemo(
    () => renderOrders.filter((order) => !isLiquidityPositionOrder(order)),
    [renderOrders]
  );
  const renderBatches = batches;
  const renderSettlementTranscripts = settlementTranscripts;
  const renderBalances = balances;
  const renderPendingDeposits = pendingDeposits;
  const renderWithdrawableNotes = withdrawableNotes;
  const renderWalletReady = walletReady;
  const renderOnline = online;
  const renderBatchByPair = useMemo(
    () =>
      renderBatches.reduce<Record<string, BatchSummary>>((acc, b) => {
        acc[b.pair_id] = displayBatchForPair(acc[b.pair_id], b);
        return acc;
      }, {}),
    [renderBatches]
  );
  const renderActiveBatch = activePair
    ? renderBatchByPair[activePair.pair_id] ?? null
    : null;
  const renderLastClearingPrices = useMemo(
    () => lastClearingByPair(renderSettlementTranscripts),
    [renderSettlementTranscripts]
  );
  const claimableOutputCount = renderWalletReady
    ? claimableOutputs(
        renderWithdrawableNotes,
        renderSettlementTranscripts,
        claimDelaySeconds,
        Date.now()
      ).length
    : 0;
  const activeTakerOrders = renderTakerOrders.filter((o) =>
    ACTIVE_ORDER_STATUSES.has(o.status)
  );

  useEffect(() => {
    if (
      !walletReady ||
      !ordersHydratedForOwner ||
      strategies.length === 0 ||
      pairs.length === 0
    )
      return;
    const existingCommitments = new Set(
      orders.map((order) => order.orderCommitment).filter(Boolean)
    );
    const existingMetadata = new Set(
      orders
        .map((order) => order.expectedOutputMetadataCommitment)
        .filter(Boolean)
    );
    const additions: LocalOrder[] = [];
    for (const strategy of strategies) {
      if (!strategy.side) continue;
      const pair = pairs.find(
        (candidate) => candidate.pair_id === strategy.pair
      );
      if (!pair) continue;
      const priceBaseScale =
        strategy.price_base_scale ??
        pair.price_base_scale ??
        assetScale(pair.base_asset_id).toString();
      const limitPriceAtomic = strategy.limit_price ?? "0";
      const fundingAsset =
        strategy.side === "Buy" ? pair.quote_asset_id : pair.base_asset_id;
      const fundingAmountAtomic =
        strategy.side === "Buy"
          ? (
              (BigInt(strategy.child_amount) *
                BigInt(limitPriceAtomic || "0")) /
              BigInt(priceBaseScale)
            ).toString()
          : strategy.child_amount;
      for (const child of strategy.submitted_children) {
        if (!child.order_commitment || child.submitted_at_unix_ms <= 0)
          continue;
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
          expectedOutputMetadataCommitment:
            child.expected_output_metadata_commitment,
          fundingNoteCommitments: child.funding_note_commitments,
          strategyId: strategy.id,
          batchId: child.batch_id,
          epochId: child.epoch_id,
          pair: strategy.pair,
          side: strategy.side,
          wireMode: strategy.mode,
          amount: fromAtomicStr(strategy.child_amount, pair.base_asset_id),
          fundingAsset,
          fundingAmount: fromAtomicStr(fundingAmountAtomic, fundingAsset),
          limitPrice: formatClearingPrice(
            {
              batchId: child.batch_id,
              epochId: child.epoch_id,
              clearingPrice: limitPriceAtomic,
              priceBaseScale,
            },
            pair
          ),
          minFill: strategy.min_fill
            ? fromAtomicStr(strategy.min_fill, pair.base_asset_id)
            : "",
          fillOrKill: Boolean(strategy.fill_or_kill),
          status: "in_batch",
          submittedAt: child.submitted_at_unix_ms,
          relayMode: strategy.offline_package?.relay_mode ?? "SelfRelay",
          relayFeeBps:
            strategy.offline_package?.relay_mode === "ZylithRelay"
              ? pair.relay_fee_bps ?? 0
              : 0,
        });
      }
    }
    if (additions.length > 0) {
      saveAndSet([...additions, ...orders]);
    }
  }, [
    walletReady,
    ordersHydratedForOwner,
    strategies,
    pairs,
    orders,
    saveAndSet,
  ]);

  // Submit order
  function pairForIntent(intent: TicketSubmitIntent) {
    if (intent.pairId)
      return pairs.find((pair) => pair.pair_id === intent.pairId) ?? null;
    return activePair;
  }

  async function handleSubmit(intent: TicketSubmitIntent): Promise<boolean> {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Connect a Starknet wallet first.");
      return false;
    }
    const submitPair = pairForIntent(intent);
    if (!submitPair) {
      setSubmitError("Select a pair before submitting.");
      return false;
    }
    const provisionalBatch = batchByPair[submitPair.pair_id] ?? null;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (intent.shape === "strategy" && !coordinatorStatus?.batch_window_ms) {
        setSubmitError("Auction timing is still loading. Please retry later.");
        return false;
      }
      const submissionBatch = await resolveTicketSubmissionBatch(
        submitPair,
        provisionalBatch,
        coordinatorStatus?.batch_window_ms,
      );

      const wm = wireMode(intent.shape, intent.resting, intent.stratKind);
      if (intent.shape === "curve") {
        setSubmitError(
          "Open liquidity through the private position lifecycle, not curve orders."
        );
        return false;
      }
      const atomicAmount = toAtomicStr(intent.amount, submitPair.base_asset_id);
      const atomicPrice =
        toPriceAtomicStr(
          intent.shape === "limit"
            ? intent.limitPrice
            : intent.priceLimit || "0",
          submitPair.quote_asset_id
        );
      const atomicMinFill = toAtomicStr(
        intent.minFill || "0",
        submitPair.base_asset_id
      );
      const priceBaseScale =
        submitPair.price_base_scale ??
        assetScale(submitPair.base_asset_id).toString();
      const fundingAsset =
        intent.side === "Buy"
          ? submitPair.quote_asset_id
          : submitPair.base_asset_id;
      const fundingAmountAtomic =
        intent.side === "Buy"
          ? (
              (BigInt(atomicAmount) * BigInt(atomicPrice || "0")) /
              BigInt(priceBaseScale)
            ).toString()
          : atomicAmount;

      const orderRelayMode = intent.relayMode ?? "SelfRelay";
      const draft = {
        pair: submitPair.pair_id,
        side: intent.side,
        mode: wm,
        amount: atomicAmount,
        limitPrice: atomicPrice,
        minFill: atomicMinFill,
        fillOrKill: intent.fillOrKill,
        batchId: submissionBatch.batch_id,
        batchWindowMs: coordinatorStatus?.batch_window_ms,
        priceBaseScale,
        durationBatches:
          intent.shape === "strategy" &&
          intent.durationHours &&
          coordinatorStatus?.batch_window_ms
            ? Math.ceil(
                (Number(intent.durationHours) * 3_600_000) /
                  coordinatorStatus.batch_window_ms
              )
            : undefined,
        childAmount: intent.childSize
          ? toAtomicStr(intent.childSize, submitPair.base_asset_id)
          : undefined,
        randomizedSlicing: intent.jitter > 0,
        randomizedSlicingBps: intent.jitter * 100,
        offlineDelegation: false,
        relayMode: orderRelayMode,
      };

      const arrivalReference = lastClearingReference(
        submitPair,
        lastClearingPrices[submitPair.pair_id] ?? null
      );
      const result = await w.submitPrivateOrder(draft);
      if (result.offline_package?.relay_mode === "ZylithRelay") {
        try {
          const relayStatus = await submitLiquidityAutomationPackage(
            result.offline_package
          );
          await w
            .markPrivateStrategyRelayRegistered?.(
              result.offline_package.package_id,
              relayStatus ?? undefined
            )
            .catch(() => false);
          setBalanceTick((v) => v + 1);
        } catch (relayError) {
          setBalanceTick((v) => v + 1);
          throw relayError;
        }
      }
      if (
        result.offline_package?.relay_mode === "SelfRelay" &&
        intent.relayOperator === "SelfHostedRelay"
      ) {
        const endpointUrl = normalizeSelfRelayUrl(intent.selfRelayUrl ?? "");
        if (!endpointUrl) {
          await w
            .discardPreparedPrivateStrategy?.(result.offline_package.package_id)
            .catch(() => false);
          setBalanceTick((v) => v + 1);
          throw new Error("Self-hosted relay endpoint is invalid or missing");
        }
        try {
          const relayStatus = await submitSelfHostedRenewalPackage(
            endpointUrl,
            result.offline_package
          );
          storeSelfHostedRelayUrl(
            result.offline_package.package_id,
            endpointUrl
          );
          await w
            .markPrivateStrategyRelayRegistered?.(
              result.offline_package.package_id,
              relayStatus ?? undefined
            )
            .catch(() => false);
          setBalanceTick((v) => v + 1);
        } catch (relayError) {
          setBalanceTick((v) => v + 1);
          throw relayError;
        }
      }
      const materializedOrderCommitment =
        result.order_commitment ?? result.first_child_order_commitment ?? "";
      if (!materializedOrderCommitment) {
        setBalanceTick((v) => v + 1);
        return true;
      }

      const submittedAt = Date.now();
      const acceptedBatchId =
        result.batch_id ??
        result.first_child_batch_id ??
        submissionBatch.batch_id;
      const acceptedEpochId =
        result.epoch_id ??
        result.first_child_epoch_id ??
        renderBatches.find((batch) => batch.batch_id === acceptedBatchId)
          ?.epoch_id ??
        submissionBatch.epoch_id;

      const newOrder: LocalOrder = {
        deployment_scope: deploymentOrderScope(deployment),
        ordRef: genRef(),
        orderCommitment: materializedOrderCommitment,
        cancellationSecret:
          result.cancellation_secret ??
          result.first_child_cancellation_secret ??
          "",
        expectedOutputMetadataCommitment:
          result.expected_output_metadata_commitment,
        fundingNoteCommitments: result.funding_note_commitments,
        strategyId: result.strategy_id,
        batchId: acceptedBatchId,
        epochId: acceptedEpochId,
        pair: submitPair.pair_id,
        side: intent.side,
        wireMode: wm,
        amount: intent.amount,
        fundingAsset,
        fundingAmount: fromAtomicStr(fundingAmountAtomic, fundingAsset),
        limitPrice:
          intent.shape === "limit"
            ? intent.limitPrice
            : intent.shape === "strategy"
            ? intent.priceLimit || ""
            : "",
        minFill: intent.minFill,
        fillOrKill: intent.fillOrKill,
        status:
          result.first_child_order_commitment || result.order_commitment
            ? "in_batch"
            : "queued",
        submittedAt,
        arrivalReferencePrice: arrivalReference.price,
        arrivalReferenceSource: arrivalReference.source,
        arrivalReferenceAt: arrivalReference.observedAt,
        relayMode: orderRelayMode,
        relayFeeBps: 0,
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

  async function handleOpenPosition(
    request: PrivateLiquidityPositionOpenRequest
  ): Promise<boolean> {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Connect a Starknet wallet first.");
      return false;
    }
    const submitPair =
      pairs.find((pair) => pair.pair_id === request.pairId) ?? null;
    if (!submitPair) {
      setSubmitError("Select a pair before opening a position.");
      return false;
    }
    const provisionalBatch = batchByPair[submitPair.pair_id] ?? null;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const submissionBatch = await resolveTicketSubmissionBatch(
        submitPair,
        provisionalBatch,
        coordinatorStatus?.batch_window_ms
      );
      await w.openPrivateLiquidityPosition(request, submissionBatch);
      setBalanceTick((value) => value + 1);
      return true;
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  function handleFundingPreview(
    intent: TicketSubmitIntent
  ): FundingPreview | null {
    const w = walletRuntime();
    const previewPair = pairForIntent(intent);
    const previewBatch = previewPair
      ? batchByPair[previewPair.pair_id] ?? null
      : null;
    if (!w || !w.isReady() || !previewPair || !previewBatch) return null;
    if (intent.shape === "curve") return null;

    const wm = wireMode(intent.shape, intent.resting, intent.stratKind);
    const priceBaseScale =
      previewPair.price_base_scale ??
      assetScale(previewPair.base_asset_id).toString();
    const base = previewPair.base_asset_id;
    const quote = previewPair.quote_asset_id;
    const atomicPrice =
      toPriceAtomicStr(
        intent.shape === "limit" ? intent.limitPrice : intent.priceLimit || "0",
        quote
      );
    let atomicAmount = toAtomicStr(intent.amount, base);
    let mode = wm;

    if (intent.shape === "strategy") {
      const durationBatches =
        coordinatorStatus?.batch_window_ms && intent.durationHours
          ? Math.max(
              1,
              Math.ceil(
                (Number(intent.durationHours) * 3_600_000) /
                  coordinatorStatus.batch_window_ms
              )
            )
          : 1;
      atomicAmount = intent.childSize
        ? toAtomicStr(intent.childSize, base)
        : ceilDivBigInt(
            BigInt(atomicAmount),
            BigInt(durationBatches)
          ).toString();
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
      priceBaseScale,
    });
  }

  // Cancel order
  async function cleanupLiquidityAutomationStrategyPackage(strategyId: string) {
    const renewalPackage = strategies.find(
      (strategy) => strategy.id === strategyId
    )?.offline_package;
    if (!renewalPackage) return;
    if (renewalPackage.relay_mode === "ZylithRelay") {
      await deleteLiquidityAutomationPackage(renewalPackage);
      return;
    }
    if (renewalPackage.relay_mode === "SelfRelay") {
      await deleteSelfHostedRenewalPackage(
        readSelfHostedRelayUrl(renewalPackage.package_id),
        renewalPackage
      );
    }
  }

  async function handleCancelOrder(order: LocalOrder) {
    const w = walletRuntime();
    const markCancelled = (cancelTransactionHash?: string) => {
      saveAndSet(
        orders.map((o) =>
          o.ordRef === order.ordRef
            ? {
                ...o,
                status: "cancelled" as LocalOrderStatus,
                cancelTransactionHash,
              }
            : o
        )
      );
    };

    if (order.strategyId) {
      if (!w || !w.isReady()) {
        setSubmitError("Connect wallet before cancelling this strategy.");
        return;
      }
      try {
        const result = await w.cancelPrivateStrategy(order.strategyId);
        await cleanupLiquidityAutomationStrategyPackage(order.strategyId).catch(
          (error: unknown) => {
            setSubmitError(userFacingErrorMessage(error));
          }
        );
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
      } catch (error) {
        setSubmitError(
          userFacingErrorMessage(error, "Order cancellation is still pending.")
        );
        return;
      }
    }
    markCancelled();
  }

  async function handleCancelStrategy(strategyId: string) {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Connect wallet before cancelling this strategy.");
      return;
    }
    try {
      await w.cancelPrivateStrategy(strategyId);
      await cleanupLiquidityAutomationStrategyPackage(strategyId).catch(
        (error: unknown) => {
          setSubmitError(userFacingErrorMessage(error));
        }
      );
      setBalanceTick((v) => v + 1);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
    }
  }

  async function handlePauseStrategy(strategyId: string) {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Connect wallet before pausing this curve.");
      return;
    }
    try {
      await w.pausePrivateStrategy(strategyId);
      setBalanceTick((v) => v + 1);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
    }
  }

  async function handleResumeStrategy(strategyId: string) {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Connect wallet before resuming this curve.");
      return;
    }
    try {
      await w.resumePrivateStrategy(strategyId);
      setBalanceTick((v) => v + 1);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
    }
  }

  async function handleRefreshStrategyPackage(strategyId: string) {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Connect wallet before refreshing this package.");
      return;
    }
    try {
      const renewalPackage = await w.refreshPrivateStrategyPackage(strategyId);
      if (renewalPackage.relay_mode === "ZylithRelay") {
        const relayStatus = await submitLiquidityAutomationPackage(renewalPackage);
        await w
          .markPrivateStrategyRelayRegistered?.(
            renewalPackage.package_id,
            relayStatus ?? undefined
          )
          .catch(() => false);
      } else if (renewalPackage.relay_mode === "SelfRelay") {
        const endpointUrl = readSelfHostedRelayUrl(renewalPackage.package_id);
        if (endpointUrl) {
          const relayStatus = await submitSelfHostedRenewalPackage(
            endpointUrl,
            renewalPackage
          );
          await w
            .markPrivateStrategyRelayRegistered?.(
              renewalPackage.package_id,
              relayStatus ?? undefined
            )
            .catch(() => false);
        }
      }
      setBalanceTick((v) => v + 1);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
    }
  }

  async function handleConsolidateNotes(plan: {
    sourceNoteCommitments: string[];
    targetAmounts: string[];
  }) {
    const w = walletRuntime();
    if (!w || !w.isReady()) {
      setSubmitError("Connect wallet before consolidating notes.");
      return;
    }
    try {
      const result = await w.consolidateNotes(plan);
      setPrivateSettlementTranscripts((prev) => ({
        ...prev,
        [result.consolidation_id]: {
          batch_id: result.consolidation_id,
          pair_id: "CONSOLIDATION",
          batch_epoch: 0,
          clearing_price: "0",
          price_base_scale: "1",
          settled_at_unix_ms: result.settled_at_unix_ms ?? Date.now(),
          loaded_at_unix_ms: Date.now(),
        },
      }));
      setBalanceTick((v) => v + 1);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
      throw error;
    }
  }

  function toggleLiquidityWorkspace() {
    if (workspace === "liquidity") {
      navigatePath(sessionGet(LAST_TAKER_ROUTE_KEY, "/trade"));
      return;
    }
    const remembered = sessionGet(
      LAST_LIQUIDITY_ROUTE_KEY,
      "/liquidity/positions"
    );
    const path = liquidityPath(liquidityTabFromPath(remembered));
    window.open(
      `${window.location.origin}${path}`,
      "_blank",
      "noopener,noreferrer"
    );
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
        activeOrderCount={activeTakerOrders.length}
        claimableOutputCount={claimableOutputCount}
        walletReady={renderWalletReady}
        starknetAddress={starknetAddress}
        onOpenWallet={() => setOpenSlide("wallet")}
        onDeposit={() => setOpenSlide("deposit")}
        onWithdraw={() => setOpenSlide("withdraw")}
        onLock={() => {
          walletRuntime()?.lock();
        }}
        onDisconnectWallet={() => setStarknetAddress(null)}
      />

      <main className="screen">
        {workspace === "taker" && tab === "trade" && (
          <div className="trade-grid">
            <PairList
              pairs={pairs}
              activePairId={activePair?.pair_id ?? activePairId}
              onSelect={setActivePairId}
              batchByPair={renderBatchByPair}
              lastClearingPrices={renderLastClearingPrices}
            />

            <div className="trade-center">
              <PairHeader
                pair={activePair}
                lastClearing={
                  activePair
                    ? renderLastClearingPrices[activePair.pair_id] ?? null
                    : null
                }
              />
              <OrderTicket
                pair={activePair}
                balances={renderBalances}
                batchWindowMs={coordinatorStatus?.batch_window_ms ?? 0}
                walletReady={renderWalletReady}
                hasPrivateBalance={renderBalances.some(
                  (balance) =>
                    BigInt(balance.available) > 0n ||
                    BigInt(balance.locked) > 0n
                )}
                onOpenWallet={() => setOpenSlide("wallet")}
                onDeposit={() => setOpenSlide("deposit")}
                submitting={submitting}
                submitError={submitError}
                onPreviewFunding={handleFundingPreview}
                onSubmit={handleSubmit}
              />
              <ReportsStrip
                orders={renderTakerOrders}
                onOpenReports={() => changeTab("reports")}
              />
            </div>

            <RightColumn
              activeBatch={renderActiveBatch}
              activePairId={activePairId}
              batchWindowMs={coordinatorStatus?.batch_window_ms ?? null}
              settlementTranscripts={renderSettlementTranscripts}
              online={renderOnline}
              allAssets={allAssets}
              pairs={pairs}
              balances={renderBalances}
              pendingDeposits={renderPendingDeposits}
              withdrawableNotes={renderWithdrawableNotes}
              claimDelaySeconds={claimDelaySeconds}
              walletReady={renderWalletReady}
              starknetAddress={starknetAddress}
              activeOrders={activeTakerOrders}
              setOpenSlide={setOpenSlide}
              allOrders={renderTakerOrders}
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
            orders={renderTakerOrders}
            onCancel={(order) => {
              void handleCancelOrder(order);
            }}
            walletReady={renderWalletReady}
          />
        )}

        {workspace === "taker" && tab === "assets" && (
          <AssetsScreen
            allAssets={allAssets}
            depositableAssets={depositableAssets}
            pairs={pairs}
            balances={renderBalances}
            pendingDeposits={renderPendingDeposits}
            withdrawableNotes={renderWithdrawableNotes}
            settlementTranscripts={renderSettlementTranscripts}
            claimDelaySeconds={claimDelaySeconds}
            orders={renderOrders}
            walletReady={renderWalletReady}
            noteConsolidationAvailable={noteConsolidationAvailable}
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
            onConsolidateNotes={handleConsolidateNotes}
            onConnectWallet={() => setOpenSlide("wallet")}
          />
        )}

        {workspace === "taker" && tab === "reports" && (
          <Suspense
            fallback={
              <div className="empty-zone">
                <div className="empty-mark">-</div>
                <div className="empty-body">Loading reports</div>
              </div>
            }
          >
            <ReportsScreen
              orders={renderTakerOrders}
              strategies={[]}
              walletReady={renderWalletReady}
              activeEpochId={renderActiveBatch?.epoch_id ?? null}
              batchWindowMs={coordinatorStatus?.batch_window_ms ?? null}
            />
          </Suspense>
        )}

        {workspace === "liquidity" && (
          <Suspense
            fallback={
              <div className="empty-zone">
                <div className="empty-mark">-</div>
                <div className="empty-body">Loading liquidity</div>
              </div>
            }
          >
            <LiquidityWorkspace
              tab={liquidityTab}
              pairs={pairs}
              activePairId={liquidityPairId}
              setActivePairId={setLiquidityPairId}
              orders={renderLiquidityOrders}
              strategies={renderStrategies}
              batches={renderBatches}
              balances={renderBalances}
              pendingDeposits={renderPendingDeposits}
              withdrawableNotes={renderWithdrawableNotes}
              settlementTranscripts={renderSettlementTranscripts}
              walletReady={renderWalletReady}
              submitting={submitting}
              submitError={submitError}
              onOpenPosition={handleOpenPosition}
              onCancelOrder={(order) => {
                void handleCancelOrder(order);
              }}
              onCancelStrategy={handleCancelStrategy}
              onPauseStrategy={handlePauseStrategy}
              onResumeStrategy={handleResumeStrategy}
              onDeposit={(asset) => {
                if (asset) setSlideAsset(asset);
                setOpenSlide("deposit");
              }}
              onWithdraw={(asset) => {
                if (asset) setSlideAsset(asset);
                setOpenSlide("withdraw");
              }}
              onNavigatePositions={() => changeLiquidityTab("positions")}
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
        walletReady={renderWalletReady}
        onOpenWallet={() => setOpenSlide("wallet")}
        setSlideAsset={setSlideAsset}
      />
      <WithdrawSlide
        open={openSlide === "withdraw"}
        onClose={() => {
          setOpenSlide(null);
          setClaimNoteCommitment(null);
        }}
        defaultAsset={slideAsset}
        defaultNoteCommitment={claimNoteCommitment}
        settlementTranscripts={renderSettlementTranscripts}
        claimDelaySeconds={claimDelaySeconds}
        allAssets={allAssets}
        starknetAddress={starknetAddress}
        walletReady={renderWalletReady}
        onOpenWallet={() => setOpenSlide("wallet")}
        setSlideAsset={setSlideAsset}
      />
    </div>
  );
}
