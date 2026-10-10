import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./globals.css";
import "./finalui/styles.css";
import type { WalletOrder, WithdrawableNote } from "@zylith/sdk";
import { configureAssetDecimals, formatPrice, safeFromAtomicStr, toAtomicStr } from "./domain/assets";
import { applyStarknetAccountsChanged, connectedStarknetAddress, restoreConnectedStarknetWallet, selectedStarknetProvider, subscribeStarknetProviderEvents, subscribeWalletRuntime, walletRuntime } from "./domain/browserWallet";
import { defaultDepositAsset, defaultPair, enabledPairs, exchange, useDeploymentState } from "./domain/deployment";
import { orderOperationIsReconciling, type OrderRow, orderRows } from "./domain/orders";
import type { PendingDeposit, WalletBalance } from "./domain/shieldedBalances";
import { ticketReferenceIsFresh, type ReferencePriceSnapshot, type TicketSubmitIntent } from "./domain/tradeIntent";
import { takerPath, takerTabFromPath, type AppTab } from "./domain/appRoutes";
import { AppHeader } from "./finalui/components/AppHeader";
import { TradePage } from "./finalui/pages/TradePage";
import { AssetsPage } from "./finalui/pages/AssetsPage";
import { OrdersPage } from "./finalui/pages/OrdersPage";
import { DepositSlide, WalletSlide, WithdrawSlide } from "./components/WalletSlides";
import { FailureNotice } from "./components/FailureNotice";
import { failureFromCode, normalizeFailure, sanitizedDiagnosticReport, type NormalizedFailure } from "./domain/userFacingErrors";
import { sessionSet } from "./domain/safeSessionStorage";
import { normalizeFeltForComparison } from "./domain/felt";
import { useWalletState } from "./hooks/useWalletState";
import { ensureWalletChain, preflightWalletAction, readStarknetWalletChainId } from "./wallet/starknetProvider";

const LAST_TAKER_ROUTE_KEY = "zylith.nav.last_taker_route";
const REFERENCE_PRICE_POLL_MS = 5_000;

type WalletView = {
  balances: WalletBalance[];
  orders: WalletOrder[];
  pendingDeposits: PendingDeposit[];
  withdrawables: WithdrawableNote[];
};

const EMPTY_WALLET_VIEW: WalletView = { balances: [], orders: [], pendingDeposits: [], withdrawables: [] };

function positiveAtomic(value: string) {
  return /^(0|[1-9]\d{0,38})$/.test(value)
    && BigInt(value) > 0n
    && BigInt(value) <= ((1n << 128n) - 1n);
}

function readWalletView(starknetAddress: string | null): WalletView {
  const runtime = walletRuntime();
  if (!runtime?.isReady(starknetAddress)) return EMPTY_WALLET_VIEW;
  return {
    balances: runtime.getBalances(),
    orders: runtime.getOrders(),
    pendingDeposits: runtime.getPendingDeposits(),
    withdrawables: runtime.getWithdrawableNotes(),
  };
}

/** the wallet's balances, orders and transfers, re-read whenever the runtime changes. */
function useWalletView(walletReady: boolean, starknetAddress: string | null) {
  const [view, setView] = useState<WalletView>(EMPTY_WALLET_VIEW);
  useEffect(() => {
    const update = () => setView(readWalletView(starknetAddress));
    update();
    const unsubscribe = subscribeWalletRuntime(update);
    return unsubscribe;
  }, [starknetAddress, walletReady]);
  return view;
}

export default function App() {
  const { deployment, error: deploymentError } = useDeploymentState();
  const pairs = useMemo(() => enabledPairs(deployment), [deployment]);
  const initialPair = useMemo(() => defaultPair(deployment), [deployment]);
  const allAssets = useMemo(() => [...new Set(pairs.flatMap((pair) => [pair.base_asset_id, pair.quote_asset_id]))], [pairs]);
  const depositableAssets = useMemo(() => {
    const fundable = new Set(deployment?.market_registry.assets.filter((asset) => asset.enabled && asset.funding_enabled).map((asset) => asset.asset_id));
    return allAssets.filter((asset) => fundable.has(asset));
  }, [allAssets, deployment]);
  const preferredDepositAsset = useMemo(() => defaultDepositAsset(deployment), [deployment]);
  useEffect(() => configureAssetDecimals(deployment), [deployment]);

  const [tab, setTab] = useState<AppTab>(() => takerTabFromPath(window.location.pathname));
  const changeTab = useCallback((next: AppTab) => {
    const path = takerPath(next);
    setTab(next);
    sessionSet(LAST_TAKER_ROUTE_KEY, path);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  }, []);
  useEffect(() => {
    const canonicalPath = takerPath(takerTabFromPath(window.location.pathname));
    if (window.location.pathname !== canonicalPath) window.history.replaceState(null, "", canonicalPath);
    const onPop = () => {
      const next = takerTabFromPath(window.location.pathname);
      const nextPath = takerPath(next);
      if (window.location.pathname !== nextPath) window.history.replaceState(null, "", nextPath);
      setTab(next);
      sessionSet(LAST_TAKER_ROUTE_KEY, nextPath);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // market
  const [activePairId, setActivePairId] = useState("");
  const activePair = pairs.find((pair) => pair.pair_id === activePairId) ?? initialPair;
  useEffect(() => {
    if (activePair) setActivePairId(activePair.pair_id);
  }, [activePair?.pair_id]);
  const [reference, setReference] = useState<{ pairId: string; price: ReferencePriceSnapshot } | null>(null);
  const [assetUnitPrices, setAssetUnitPrices] = useState<Record<string, number>>({});
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (!activePair) return;
    let cancelled = false;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const prices = await exchange().referencePrices();
        const now = Date.now();
        const expectedPairs = new Set(pairs.map((pair) => pair.pair_id));
        const returnedPairs = new Set(prices.map((candidate) => candidate.pair));
        if (
          prices.length !== expectedPairs.size
          || returnedPairs.size !== expectedPairs.size
          || prices.some((candidate) => !expectedPairs.has(candidate.pair))
        ) {
          throw new Error("The reference-price batch does not match the deployment registry.");
        }
        const numeraire = deployment?.market_registry.objective_numeraire_asset_id;
        const nextAssetUnitPrices: Record<string, number> = numeraire ? { [numeraire]: 1 } : {};
        for (const candidate of prices) {
          const configuredPair = pairs.find((pair) => pair.pair_id === candidate.pair);
          const observedAt = candidate.observed_at_ms;
          const validUntil = candidate.valid_until_ms;
          const age = now - observedAt;
          if (
            !configuredPair
            || !positiveAtomic(candidate.midpoint)
            || !positiveAtomic(candidate.scale)
            || candidate.scale !== configuredPair.price_base_scale
            || !Number.isSafeInteger(observedAt)
            || observedAt <= 0
            || !Number.isSafeInteger(validUntil)
            || validUntil < now
            || validUntil < observedAt
            || validUntil - observedAt > (configuredPair.reference_attestation_ttl_ms ?? 15_000)
            || age < -5_000
            || age > (configuredPair.reference_max_age_ms ?? 15_000)
          ) throw new Error("The reference-price batch is stale or malformed.");
          if (!configuredPair || configuredPair.quote_asset_id !== numeraire) continue;
          const unitPrice = Number(formatPrice(candidate.midpoint, { ...configuredPair, price_base_scale: candidate.scale }));
          if (Number.isFinite(unitPrice) && unitPrice > 0) nextAssetUnitPrices[configuredPair.base_asset_id] = unitPrice;
        }
        const price = prices.find((candidate) => candidate.pair === activePair!.pair_id);
        if (!price) throw new Error("The reference-price batch is incomplete.");
        if (cancelled) return;
        setReference({
          pairId: activePair!.pair_id,
          price: {
            displayPrice: formatPrice(price.midpoint, { ...activePair!, price_base_scale: price.scale }),
            midpointPrice: price.midpoint,
            priceBaseScale: price.scale,
            observedAtUnixMs: price.observed_at_ms,
            validUntilUnixMs: price.valid_until_ms,
          },
        });
        setAssetUnitPrices(nextAssetUnitPrices);
        setOnline(true);
      } catch {
        if (!cancelled) {
          setReference(null);
          setAssetUnitPrices({});
          setOnline(false);
        }
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), REFERENCE_PRICE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activePair, deployment, pairs]);
  const referencePrice = reference && reference.pairId === activePair?.pair_id ? reference.price : null;

  // wallet
  const [openSlide, setOpenSlide] = useState<"wallet" | "deposit" | "withdraw" | null>(null);
  const [slideAsset, setSlideAsset] = useState("");
  useEffect(() => {
    if (!allAssets.includes(slideAsset)) {
      setSlideAsset(preferredDepositAsset || allAssets[0] || "");
    }
  }, [allAssets, preferredDepositAsset, slideAsset]);
  const [starknetAddress, setStarknetAddress] = useState<string | null>(() => connectedStarknetAddress());
  const walletSelectionRevision = useRef(0);
  const updateStarknetAddress = useCallback((next: string | null) => {
    walletSelectionRevision.current += 1;
    setStarknetAddress((previous) => {
      if (previous === next) return previous;
      if (previous) walletRuntime()?.suspend?.();
      return next;
    });
  }, []);
  const { runtimeStatus, walletReady, hasVault } = useWalletState(starknetAddress);
  const view = useWalletView(walletReady, starknetAddress);
  const rows = useMemo<OrderRow[]>(() => orderRows(view.orders, pairs, assetUnitPrices), [assetUnitPrices, pairs, view.orders]);

  useEffect(() => {
    let restoreInFlight = false;
    let retryTimer: number | null = null;
    let retryIndex = 0;
    const retryDelays = [250, 750, 2_000, 5_000] as const;
    const reconcile = (next: string | null) =>
      setStarknetAddress((previous) => {
        if (previous === next) return previous;
        if (previous) walletRuntime()?.suspend?.();
        return next;
      });
    const scheduleRetry = () => {
      if (retryTimer !== null || retryIndex >= retryDelays.length) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void restore();
      }, retryDelays[retryIndex++]!);
    };
    const restore = async () => {
      if (restoreInFlight) return;
      restoreInFlight = true;
      const revision = walletSelectionRevision.current;
      let restored = false;
      try {
        const next = await restoreConnectedStarknetWallet();
        if (next && revision === walletSelectionRevision.current) {
          reconcile(next);
          restored = true;
        }
      } catch {
        // silent restore never opens wallet ui; bounded retries handle late injection.
      } finally {
        restoreInFlight = false;
      }
      if (!restored) scheduleRetry();
    };
    const retryFromEvent = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      retryIndex = 0;
      void restore();
    };
    void restore();
    window.addEventListener("focus", retryFromEvent);
    window.addEventListener("starknet#initialized", retryFromEvent);
    return () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.removeEventListener("focus", retryFromEvent);
      window.removeEventListener("starknet#initialized", retryFromEvent);
    };
  }, []);

  const silentUnlockAttemptRef = useRef<string | null>(null);
  const [silentUnlockEvent, setSilentUnlockEvent] = useState(0);
  useEffect(() => {
    if (!starknetAddress || walletReady || runtimeStatus !== "ready") return;
    const runtime = walletRuntime();
    if (!runtime || runtime.vaultAuthMode?.(starknetAddress) !== "device-session") return;
    const attemptKey = starknetAddress.toLowerCase();
    if (silentUnlockAttemptRef.current === attemptKey) return;
    silentUnlockAttemptRef.current = attemptKey;
    void runtime.unlockWithDeviceSession(starknetAddress)
      .catch(() => false)
      .then(() => undefined);
  }, [runtimeStatus, silentUnlockEvent, starknetAddress, walletReady]);
  useEffect(() => {
    if (!starknetAddress) silentUnlockAttemptRef.current = null;
  }, [starknetAddress]);
  useEffect(() => {
    const retrySilentUnlock = () => {
      if (!starknetAddress || walletReady) return;
      silentUnlockAttemptRef.current = null;
      setSilentUnlockEvent((value) => value + 1);
    };
    window.addEventListener("focus", retrySilentUnlock);
    return () => window.removeEventListener("focus", retrySilentUnlock);
  }, [starknetAddress, walletReady]);

  useEffect(() => {
    if (!deployment) return;
    let cancelled = false;
    // a locked wallet clears the address but keeps the chosen provider: keep listening so an
    // unlock in the extension restores the session without a reload or a window focus.
    const provider = selectedStarknetProvider();
    if (!provider) return;
    const verifyNetwork = async () => {
      if (!starknetAddress) return;
      const chainId = await readStarknetWalletChainId(provider as never).catch(() => null);
      if (
        !cancelled
        && chainId
        && normalizeFeltForComparison(chainId)
          !== normalizeFeltForComparison(deployment.chain_id)
      ) {
        walletRuntime()?.suspend?.();
      }
    };
    const reconcileAccount = (accounts: unknown) => {
      const next = applyStarknetAccountsChanged(accounts);
      if (next !== starknetAddress) updateStarknetAddress(next);
      silentUnlockAttemptRef.current = null;
      setSilentUnlockEvent((value) => value + 1);
      void verifyNetwork();
    };
    const reconcileNetwork = () => {
      silentUnlockAttemptRef.current = null;
      setSilentUnlockEvent((value) => value + 1);
      void verifyNetwork();
    };
    const unsubscribeProviderEvents = subscribeStarknetProviderEvents(
      provider,
      reconcileAccount,
      reconcileNetwork,
    );
    void verifyNetwork();
    window.addEventListener("focus", verifyNetwork);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", verifyNetwork);
      unsubscribeProviderEvents();
    };
  }, [deployment, starknetAddress, updateStarknetAddress]);

  // orders
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<NormalizedFailure | null>(null);
  const submitReconciliationObservedRef = useRef(false);

  useEffect(() => {
    if (!submitError || !["unknown", "submitted"].includes(submitError.outcome)) return;
    const stillReconciling = orderOperationIsReconciling(submitError, rows);
    if (stillReconciling) {
      submitReconciliationObservedRef.current = true;
    } else if (submitReconciliationObservedRef.current) {
      submitReconciliationObservedRef.current = false;
      setSubmitError(null);
    }
  }, [rows, submitError]);

  async function handleSubmit(intent: TicketSubmitIntent) {
    const runtime = walletRuntime();
    const pair = pairs.find((candidate) => candidate.pair_id === intent.pairId);
    if (!runtime?.isReady(starknetAddress) || !pair) {
      setOpenSlide("wallet");
      return false;
    }
    setSubmitting(true);
    submitReconciliationObservedRef.current = false;
    setSubmitError(null);
    try {
      const provider = selectedStarknetProvider();
      if (!provider || !deployment || !starknetAddress) {
        setOpenSlide("wallet");
        return false;
      }
      try {
        const networkReadiness = await preflightWalletAction(
          provider,
          deployment,
          starknetAddress,
        );
        if (networkReadiness === "switched") {
          await runtime.refresh();
          return false;
        }
      } catch (error) {
        setSubmitError(normalizeFailure(error, {
          domain: "network",
          operation: "order",
          outcome: "not-submitted",
          stage: "order-preflight",
          presentation: "inline",
        }));
        return false;
      }
      if (!ticketReferenceIsFresh(intent, pair)) {
        throw new Error("The reference price is unavailable. Retry shortly.");
      }
      const limitPrice = intent.midpointPrice;
      // a buy spends quote: the base it buys at the limit is its size.
      const amount =
        intent.side === "Sell"
          ? toAtomicStr(intent.payAmount, pair.base_asset_id)
          : ((BigInt(toAtomicStr(intent.payAmount, pair.quote_asset_id)) * BigInt(pair.price_base_scale)) / BigInt(limitPrice)).toString();
      if (amount === "0") throw new Error("Enter a valid amount.");
      await runtime.submitOrder({ pair: pair.pair_id, side: intent.side, amount, limitPrice, external: intent.external });
      return true;
    } catch (error) {
      const payAsset = pair
        ? intent.side === "Sell" ? pair.base_asset_id : pair.quote_asset_id
        : undefined;
      const fundingBalance = payAsset
        ? view.balances.find((balance) => balance.asset === payAsset)
        : undefined;
      setSubmitError(normalizeFailure(error, {
        domain: "order",
        operation: "order",
        stage: "order-submission",
        presentation: "inline",
        asset: payAsset,
        requiredAmount: intent.payAmount,
        availableAmount: fundingBalance && payAsset
          ? safeFromAtomicStr(fundingBalance.available, payAsset, "0")
          : undefined,
        reservedAmount: fundingBalance && payAsset
          ? safeFromAtomicStr(fundingBalance.locked, payAsset, "0")
          : undefined,
      }));
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(row: OrderRow) {
    submitReconciliationObservedRef.current = false;
    setSubmitError(null);
    try {
      const runtime = walletRuntime();
      if (!runtime?.isReady(starknetAddress)) {
        throw new Error("Reconnect and authorize your wallet before cancelling this order.");
      }
      const provider = selectedStarknetProvider();
      if (!provider || !deployment || !starknetAddress) {
        setOpenSlide("wallet");
        return;
      }
      try {
        const networkReadiness = await preflightWalletAction(
          provider,
          deployment,
          starknetAddress,
        );
        if (networkReadiness === "switched") {
          await runtime.refresh();
          return;
        }
      } catch (error) {
        setSubmitError(normalizeFailure(error, {
          domain: "network",
          operation: "cancel",
          outcome: "not-submitted",
          operationId: row.id,
          stage: "cancellation-preflight",
          presentation: "inline",
        }));
        return;
      }
      await runtime.cancelOrder(row.id);
    } catch (error) {
      setSubmitError(normalizeFailure(error, {
        domain: "order",
        operation: "cancel",
        stage: "order-cancellation",
        presentation: "inline",
        operationId: row.id,
      }));
    }
  }

  async function refreshOperationStatus() {
    const runtime = walletRuntime();
    if (!runtime) {
      setSubmitError(failureFromCode("TRADING_UNAVAILABLE", {
        stage: "operation-reconciliation",
        presentation: "banner",
      }));
      return;
    }
    try {
      await runtime.refresh();
    } catch (error) {
      setSubmitError(normalizeFailure(error, {
        domain: "network",
        operation: "read",
        stage: "operation-reconciliation",
        presentation: "inline",
      }));
    }
  }

  async function switchWalletNetwork() {
    const provider = selectedStarknetProvider();
    if (!provider || !deployment) {
      setOpenSlide("wallet");
      return;
    }
    try {
      await ensureWalletChain(provider, deployment);
      setSubmitError(null);
      await refreshOperationStatus();
    } catch (error) {
      setSubmitError(normalizeFailure(error, {
        domain: "network",
        operation: "read",
        stage: "wallet-network-switch",
        presentation: "inline",
      }));
    }
  }

  async function copySubmitSupportDetails() {
    if (!submitError || !navigator.clipboard?.writeText) {
      throw new Error("Clipboard access is unavailable");
    }
    await navigator.clipboard.writeText(sanitizedDiagnosticReport(submitError));
  }

  return (
    <div className="app-shell">
      <AppHeader activePage={tab} starknetAddress={starknetAddress} walletReady={walletReady} onNavigate={changeTab} onWallet={() => setOpenSlide("wallet")} />

      <div>
        {deploymentError && (
          <FailureNotice
            className="slide-inline-notice"
            failure={failureFromCode("DEPLOYMENT_UNAVAILABLE", {
              stage: "deployment-load",
              presentation: "banner",
            })}
          />
        )}
        {tab === "trade" && (
          <TradePage
            pairs={pairs}
            pair={activePair}
            referencePrice={referencePrice}
            balances={view.balances}
            walletReady={walletReady}
            submitting={submitting}
            submitError={submitError}
            orders={rows}
            online={online}
            onSelectPair={setActivePairId}
            onOpenWallet={() => setOpenSlide("wallet")}
            onDeposit={(asset) => {
              setSlideAsset(asset || activePair?.quote_asset_id || allAssets[0] || "");
              setOpenSlide("deposit");
            }}
            onSubmit={handleSubmit}
            onViewOrders={() => changeTab("orders")}
            onRefreshStatus={refreshOperationStatus}
            onSwitchNetwork={switchWalletNetwork}
            onContactSupport={copySubmitSupportDetails}
            onDismissError={() => setSubmitError(null)}
          />
        )}
        {tab === "orders" && <OrdersPage orders={rows} error={submitError} onCancel={handleCancel} walletConnected={Boolean(starknetAddress)} walletReady={walletReady} onConnectWallet={() => setOpenSlide("wallet")} onRefreshStatus={refreshOperationStatus} onSwitchNetwork={switchWalletNetwork} onContactSupport={copySubmitSupportDetails} onDismissError={() => setSubmitError(null)} />}
        {tab === "assets" && (
          <AssetsPage
            allAssets={allAssets}
            defaultDepositAsset={preferredDepositAsset}
            balances={view.balances}
            pendingDeposits={view.pendingDeposits}
            withdrawals={view.withdrawables}
            walletConnected={Boolean(starknetAddress)}
            walletReady={walletReady}
            assetUnitPrices={assetUnitPrices}
            onDeposit={(asset) => {
              if (asset) setSlideAsset(asset);
              setOpenSlide("deposit");
            }}
            onWithdraw={(asset) => {
              if (asset) setSlideAsset(asset);
              setOpenSlide("withdraw");
            }}
            onConnectWallet={() => setOpenSlide("wallet")}
          />
        )}
      </div>

      <WalletSlide
        open={openSlide === "wallet"}
        onClose={() => setOpenSlide(null)}
        runtimeStatus={runtimeStatus}
        hasVault={hasVault}
        starknetAddress={starknetAddress}
        onStarknetConnected={updateStarknetAddress}
        onStarknetDisconnected={() => updateStarknetAddress(null)}
      />
      <DepositSlide
        open={openSlide === "deposit"}
        onClose={() => setOpenSlide(null)}
        defaultAsset={slideAsset}
        allAssets={depositableAssets}
        starknetAddress={starknetAddress}
        walletReady={walletReady}
        onOpenWallet={() => setOpenSlide("wallet")}
        setSlideAsset={setSlideAsset}
      />
      <WithdrawSlide
        open={openSlide === "withdraw"}
        onClose={() => setOpenSlide(null)}
        defaultAsset={slideAsset}
        allAssets={allAssets}
        starknetAddress={starknetAddress}
        walletReady={walletReady}
        onOpenWallet={() => setOpenSlide("wallet")}
        setSlideAsset={setSlideAsset}
      />
    </div>
  );
}
