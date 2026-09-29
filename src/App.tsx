import { useCallback, useEffect, useMemo, useState } from "react";
import "./globals.css";
import "./finalui/styles.css";
import type { WalletOrder, WithdrawableNote } from "@zylith/sdk";
import { configureAssetDecimals, formatPrice, toAtomicStr, toPriceAtoms } from "./domain/assets";
import { connectedStarknetAddress, restoreConnectedStarknetWallet, subscribeWalletRuntime, walletRuntime } from "./domain/browserWallet";
import { enabledPairs, exchange, useDeploymentState } from "./domain/deployment";
import { type OrderRow, orderRows } from "./domain/orders";
import type { PendingDeposit, WalletBalance } from "./domain/shieldedBalances";
import type { ReferencePriceSnapshot, TicketSubmitIntent } from "./domain/tradeIntent";
import { takerPath, takerTabFromPath, type AppTab } from "./domain/appRoutes";
import { AppHeader } from "./finalui/components/AppHeader";
import { TradePage } from "./finalui/pages/TradePage";
import { AssetsPage } from "./finalui/pages/AssetsPage";
import { OrdersPage } from "./finalui/pages/OrdersPage";
import { DepositSlide, WalletSlide, WithdrawSlide } from "./components/WalletSlides";
import { userFacingErrorMessage } from "./domain/userFacingErrors";
import { sessionSet } from "./domain/safeSessionStorage";
import { useWalletState } from "./hooks/useWalletState";
import { ResidualCapacityFreezeRequiredError } from "./zylithWalletRuntime";

const LAST_TAKER_ROUTE_KEY = "zylith.nav.last_taker_route";
const REFERENCE_PRICE_POLL_MS = 5_000;
const WALLET_VIEW_POLL_MS = 2_000;

type WalletView = {
  balances: WalletBalance[];
  orders: WalletOrder[];
  pendingDeposits: PendingDeposit[];
  withdrawables: WithdrawableNote[];
};

const EMPTY_WALLET_VIEW: WalletView = { balances: [], orders: [], pendingDeposits: [], withdrawables: [] };

function readWalletView(): WalletView {
  const runtime = walletRuntime();
  if (!runtime?.isReady()) return EMPTY_WALLET_VIEW;
  return {
    balances: runtime.getBalances(),
    orders: runtime.getOrders(),
    pendingDeposits: runtime.getPendingDeposits(),
    withdrawables: runtime.getWithdrawableNotes(),
  };
}

/** the wallet's balances, orders and transfers, re-read whenever the runtime changes. */
function useWalletView(walletReady: boolean) {
  const [view, setView] = useState<WalletView>(EMPTY_WALLET_VIEW);
  useEffect(() => {
    const update = () => setView(readWalletView());
    update();
    const unsubscribe = subscribeWalletRuntime(update);
    const timer = window.setInterval(update, WALLET_VIEW_POLL_MS);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [walletReady]);
  return view;
}

export default function App() {
  const { deployment, error: deploymentError } = useDeploymentState();
  const pairs = useMemo(() => enabledPairs(deployment), [deployment]);
  const allAssets = useMemo(() => [...new Set(pairs.flatMap((pair) => [pair.base_asset_id, pair.quote_asset_id]))], [pairs]);
  const depositableAssets = useMemo(() => {
    const fundable = new Set(deployment?.market_registry.assets.filter((asset) => asset.enabled && asset.funding_enabled).map((asset) => asset.asset_id));
    return allAssets.filter((asset) => fundable.has(asset));
  }, [allAssets, deployment]);
  useEffect(() => configureAssetDecimals(deployment), [deployment]);

  const [tab, setTab] = useState<AppTab>(() => takerTabFromPath(window.location.pathname));
  const changeTab = useCallback((next: AppTab) => {
    const path = takerPath(next);
    setTab(next);
    sessionSet(LAST_TAKER_ROUTE_KEY, path);
    window.history.pushState(null, "", path);
  }, []);
  useEffect(() => {
    if (window.location.pathname === "/" || window.location.pathname === "") window.history.replaceState(null, "", "/trade");
    const onPop = () => {
      const next = takerTabFromPath(window.location.pathname);
      setTab(next);
      sessionSet(LAST_TAKER_ROUTE_KEY, takerPath(next));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // market
  const [activePairId, setActivePairId] = useState("");
  const activePair = pairs.find((pair) => pair.pair_id === activePairId) ?? pairs[0] ?? null;
  useEffect(() => {
    if (activePair) setActivePairId(activePair.pair_id);
  }, [activePair?.pair_id]);
  const [reference, setReference] = useState<{ pairId: string; price: ReferencePriceSnapshot } | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (!activePair) return;
    let cancelled = false;
    async function poll() {
      try {
        const prices = await exchange().referencePrices();
        const expectedPairs = new Set(pairs.map((pair) => pair.pair_id));
        if (prices.length !== expectedPairs.size || prices.some((candidate) => !expectedPairs.has(candidate.pair))) {
          throw new Error("The reference-price batch does not match the deployment registry.");
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
          },
        });
        setOnline(true);
      } catch {
        if (!cancelled) setOnline(false);
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), REFERENCE_PRICE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activePair]);
  const referencePrice = reference && reference.pairId === activePair?.pair_id ? reference.price : null;

  // wallet
  const [openSlide, setOpenSlide] = useState<"wallet" | "deposit" | "withdraw" | null>(null);
  const [slideAsset, setSlideAsset] = useState("");
  useEffect(() => {
    if (!allAssets.includes(slideAsset)) setSlideAsset(allAssets[0] ?? "");
  }, [allAssets, slideAsset]);
  const [starknetAddress, setStarknetAddress] = useState<string | null>(() => connectedStarknetAddress());
  const { runtimeStatus, walletReady, hasVault } = useWalletState(starknetAddress);
  const view = useWalletView(walletReady);
  const rows = useMemo<OrderRow[]>(() => orderRows(view.orders, pairs), [view.orders, pairs]);

  useEffect(() => {
    const reconcile = (next: string | null) =>
      setStarknetAddress((previous) => {
        if (previous === next) return previous;
        if (previous) walletRuntime()?.lock();
        return next;
      });
    const restore = () => void restoreConnectedStarknetWallet().then(reconcile).catch(() => undefined);
    restore();
    const timer = window.setInterval(() => reconcile(connectedStarknetAddress()), 1_500);
    window.addEventListener("focus", restore);
    window.addEventListener("starknet#initialized", restore);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", restore);
      window.removeEventListener("starknet#initialized", restore);
    };
  }, []);

  // orders
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(intent: TicketSubmitIntent) {
    const runtime = walletRuntime();
    const pair = pairs.find((candidate) => candidate.pair_id === intent.pairId);
    if (!runtime?.isReady() || !pair) {
      setOpenSlide("wallet");
      return false;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const limitPrice = toPriceAtoms(intent.limitPrice, pair);
      if (limitPrice === "0") throw new Error("The reference price is unavailable. Retry shortly.");
      // a buy spends quote: the base it buys at the limit is its size.
      const amount =
        intent.side === "Sell"
          ? toAtomicStr(intent.payAmount, pair.base_asset_id)
          : ((BigInt(toAtomicStr(intent.payAmount, pair.quote_asset_id)) * BigInt(pair.price_base_scale)) / BigInt(limitPrice)).toString();
      if (amount === "0") throw new Error("Enter a valid amount.");
      await runtime.submitOrder({ pair: pair.pair_id, side: intent.side, amount, limitPrice, external: intent.external });
      return true;
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(row: OrderRow) {
    try {
      await walletRuntime()?.cancelOrder(row.id);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error, "Order cancellation failed. Retry."));
    }
  }

  async function handleRecover(row: OrderRow) {
    const runtime = walletRuntime();
    if (!runtime?.submitResidualRecovery || !runtime.finalizeResidualRecovery || !runtime.claimResidualRecovery) {
      setSubmitError("Residual recovery is unavailable in this wallet build.");
      return;
    }
    setSubmitError(null);
    try {
      let submission;
      try {
        submission = await runtime.submitResidualRecovery(row.id);
      } catch (error) {
        if (!(error instanceof ResidualCapacityFreezeRequiredError)) throw error;
        if (!runtime.freezeResidualRecoveryCapacity) throw error;
        await runtime.freezeResidualRecoveryCapacity(row.id);
        return;
      }
      if (!submission.already_requested) return;
      const finalized = await runtime.finalizeResidualRecovery(row.id);
      if (finalized.already_final) await runtime.claimResidualRecovery(row.id);
    } catch (error) {
      setSubmitError(userFacingErrorMessage(error, "Residual recovery failed. Retry."));
    }
  }

  return (
    <div className="app-shell">
      <AppHeader activePage={tab} starknetAddress={starknetAddress} walletReady={walletReady} onNavigate={changeTab} onWallet={() => setOpenSlide("wallet")} />

      <div>
        {deploymentError && (
          <div className="slide-inline-notice" role="alert">
            {deploymentError}. Trading is unavailable until the deployment manifest is corrected.
          </div>
        )}
        {tab === "trade" && (
          <TradePage
            pairs={pairs}
            pair={activePair}
            referencePrice={referencePrice}
            balances={view.balances}
            walletReady={walletReady}
            hasPrivateBalance={view.balances.some((balance) => BigInt(balance.available) > 0n || BigInt(balance.locked) > 0n)}
            submitting={submitting}
            submitError={submitError}
            orders={rows}
            online={online}
            onSelectPair={setActivePairId}
            onOpenWallet={() => setOpenSlide("wallet")}
            onDeposit={() => {
              setSlideAsset(activePair?.quote_asset_id ?? allAssets[0] ?? "");
              setOpenSlide("deposit");
            }}
            onSubmit={handleSubmit}
            onViewOrders={() => changeTab("orders")}
          />
        )}
        {tab === "orders" && <OrdersPage orders={rows} error={submitError} onCancel={(row) => void handleCancel(row)} onRecover={(row) => void handleRecover(row)} walletReady={walletReady} onConnectWallet={() => setOpenSlide("wallet")} />}
        {tab === "assets" && (
          <AssetsPage
            allAssets={allAssets}
            balances={view.balances}
            pendingDeposits={view.pendingDeposits}
            withdrawals={view.withdrawables}
            walletReady={walletReady}
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
        onStarknetConnected={setStarknetAddress}
        onStarknetDisconnected={() => setStarknetAddress(null)}
      />
      <DepositSlide
        open={openSlide === "deposit"}
        onClose={() => setOpenSlide(null)}
        defaultAsset={slideAsset}
        allAssets={depositableAssets.length > 0 ? depositableAssets : allAssets}
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
