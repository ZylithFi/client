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
  const depositableAssets = useMemo(() => allAssets.filter((asset) => Boolean(deployment?.token_addresses?.[asset])), [allAssets, deployment]);
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
  const [activePairId, setActivePairId] = useState("STRK/USDC");
  const activePair = pairs.find((pair) => pair.pair_id === activePairId) ?? pairs[0] ?? null;
  const [reference, setReference] = useState<{ pairId: string; price: ReferencePriceSnapshot } | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (!activePair) return;
    let cancelled = false;
    async function poll() {
      try {
        const price = await exchange().referencePrice(activePair!.pair_id);
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
  const [slideAsset, setSlideAsset] = useState("STRK");
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
            onDeposit={() => setOpenSlide("deposit")}
            onSubmit={handleSubmit}
            onViewOrders={() => changeTab("orders")}
          />
        )}
        {tab === "orders" && <OrdersPage orders={rows} onCancel={(row) => void handleCancel(row)} walletReady={walletReady} onConnectWallet={() => setOpenSlide("wallet")} />}
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
