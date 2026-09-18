import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type {
  PairConfig,
  ReferencePriceSnapshot,
  TicketSubmitIntent,
} from "../../domain/tradeIntent";
import { safeFromAtomicStr } from "../../domain/assets";
import type { WalletBalance } from "../../domain/shieldedBalances";
import { ArrowUpRightIcon, ShieldIcon, SwapIcon } from "./Icons";
import { TokenIcon } from "./TokenIcon";
import { defaultTradeAmount, formatQuotedPrice } from "../lib/marketFormat";

type IntentSide = "buy" | "sell";

function positiveNumber(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatAmount(value: number, maximumFractionDigits = 8) {
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

export function IntentPanel({
  pair,
  balances,
  referencePrice,
  marketMidpoint,
  walletReady,
  hasPrivateBalance,
  submitting,
  submitError,
  onOpenWallet,
  onDeposit,
  onSubmit,
}: {
  pair: PairConfig | null;
  balances: WalletBalance[];
  referencePrice: ReferencePriceSnapshot | null;
  marketMidpoint: number;
  walletReady: boolean;
  hasPrivateBalance: boolean;
  submitting: boolean;
  submitError: string | null;
  onOpenWallet: () => void;
  onDeposit: () => void;
  onSubmit: (intent: TicketSubmitIntent) => Promise<boolean | void>;
}) {
  const [side, setSide] = useState<IntentSide>("buy");
  const [amount, setAmount] = useState(() => defaultTradeAmount(pair?.quote_asset_id ?? "USDC"));
  const signedMidpoint = positiveNumber(referencePrice?.displayPrice);
  const midpoint = marketMidpoint || signedMidpoint;
  const baseAsset = pair?.base_asset_id ?? "STRK";
  const quoteAsset = pair?.quote_asset_id ?? "USDC";
  const payAsset = side === "buy" ? quoteAsset : baseAsset;
  const receiveAsset = side === "buy" ? baseAsset : quoteAsset;
  const numericAmount = positiveNumber(amount);
  const output = useMemo(() => {
    if (!numericAmount || !midpoint) return 0;
    return side === "buy" ? numericAmount / midpoint : numericAmount * midpoint;
  }, [midpoint, numericAmount, side]);
  const fundingBalance = balances.find((balance) => balance.asset === payAsset);
  const available = walletReady && fundingBalance
    ? positiveNumber(safeFromAtomicStr(fundingBalance.available, payAsset, "0"))
    : 0;
  const priceProtectionBps = 30;
  const limitPrice = signedMidpoint > 0
    ? signedMidpoint * (side === "buy" ? 1 + priceProtectionBps / 10_000 : 1 - priceProtectionBps / 10_000)
    : 0;
  const canSubmit = Boolean(
    pair &&
    walletReady &&
    hasPrivateBalance &&
    !submitting &&
    numericAmount > 0 &&
    numericAmount <= available &&
    output > 0 &&
    limitPrice > 0,
  );

  useEffect(() => {
    setAmount(defaultTradeAmount(side === "buy" ? quoteAsset : baseAsset));
  }, [baseAsset, pair?.pair_id, quoteAsset, side]);

  function setMode(next: IntentSide) {
    setSide(next);
  }

  function quickFill(percent: number) {
    if (available <= 0) return;
    setAmount(String((available * percent) / 100));
  }

  async function submit() {
    if (!pair) return;
    if (!walletReady) {
      onOpenWallet();
      return;
    }
    if (!hasPrivateBalance) {
      onDeposit();
      return;
    }
    if (!canSubmit) return;
    const baseAmount = side === "buy" ? output : numericAmount;
    const ok = await onSubmit({
      pairId: pair.pair_id,
      side: side === "buy" ? "Buy" : "Sell",
      shape: "limit",
      stratKind: "Repeat",
      amount: String(baseAmount),
      limitPrice: String(limitPrice),
      minFill: "0",
      fillOrKill: false,
      durationHours: "4",
      childSize: "",
      priceLimit: "",
      jitter: 0,
      executionPreference: pair.external_match_enabled ? "PrivateThenExternal" : "PrivateOnly",
      keepTryingPrivate: false,
      retryHours: "4",
    });
    if (ok) setAmount("");
  }

  const actionLabel = submitting
    ? "Submitting..."
    : !walletReady
    ? "Connect wallet"
    : !hasPrivateBalance
    ? "Deposit"
    : "Submit order";

  return (
    <aside className="intent-panel" role="region" aria-label="Private order">
      <div className="intent-heading"><div><h2>Trade</h2></div></div>

      <div className="side-toggle" aria-label="Order side">
        <button type="button" className={side === "buy" ? "active buy" : ""} onClick={() => setMode("buy")}>Buy</button>
        <button type="button" className={side === "sell" ? "active sell" : ""} onClick={() => setMode("sell")}>Sell</button>
      </div>

      <div className="asset-card">
        <div className="asset-card-head"><span>{side === "buy" ? "You pay" : "You sell"}</span><small>{walletReady ? `Available ${formatAmount(available, 6)} ${payAsset}` : "Connect to view balance"}</small></div>
        <div className="asset-input-row">
          <input aria-label="Trade amount" inputMode="decimal" placeholder="0" value={amount} onChange={(event: ChangeEvent<HTMLInputElement>) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} />
          <button className="token-select" type="button"><TokenIcon token={payAsset}/><strong>{payAsset}</strong><span>⌄</span></button>
        </div>
        <div className="asset-card-foot"><span>{midpoint > 0 ? `≈ ${formatQuotedPrice(side === "buy" ? numericAmount : numericAmount * midpoint, quoteAsset)}` : "-"}</span><div className="quick-actions"><button type="button" disabled={!walletReady} onClick={() => quickFill(25)}>25%</button><button type="button" disabled={!walletReady} onClick={() => quickFill(50)}>50%</button><button type="button" disabled={!walletReady} onClick={() => quickFill(100)}>MAX</button></div></div>
      </div>

      <div className="swap-divider"><span/><button type="button" aria-label="Swap assets" onClick={() => setMode(side === "buy" ? "sell" : "buy")}><SwapIcon className="icon-16"/></button><span/></div>

      <div className="asset-card receive-card">
        <div className="asset-card-head"><span>You receive ~</span><small>Indicative at current BBO</small></div>
        <div className="asset-input-row">
          <div className="receive-value">{formatAmount(output, receiveAsset === quoteAsset ? 2 : 8)}</div>
          <button className="token-select" type="button"><TokenIcon token={receiveAsset}/><strong>{receiveAsset}</strong><span>⌄</span></button>
        </div>
        <div className="asset-card-foot"><span>{midpoint > 0 ? `≈ ${formatQuotedPrice(receiveAsset === quoteAsset ? output : output * midpoint, quoteAsset)}` : "-"}</span><span className="muted">Matched amount reprices each cross</span></div>
      </div>

      <div className="privacy-note"><ShieldIcon className="icon-18"/><p><strong>Private first.</strong><span>Your order crosses privately. Only unmatched residual is routed externally after the batch.</span></p></div>

      <div className="quote-details">
        <div><span>Execution</span><strong>Midpoint cross</strong></div>
        <div><span>Indicative BBO midpoint</span><strong>{formatQuotedPrice(midpoint, quoteAsset)}</strong></div>
        <div><span>Fee</span><strong>{pair?.taker_fee_bps ?? 4} bps</strong></div>
        <div><span>Residual route</span><strong>{pair?.external_match_enabled ? "Midpoint matcher" : "Private only"}</strong></div>
      </div>

      {numericAmount > available && walletReady && <p className="field-error">Amount exceeds your available {payAsset} balance.</p>}
      {submitError && <p className="field-error" role="alert">{submitError}</p>}
      <button className="primary-cta" type="button" aria-label={actionLabel} disabled={submitting || (walletReady && hasPrivateBalance && !canSubmit)} onClick={() => void submit()}><span>{actionLabel}</span><ArrowUpRightIcon className="icon-17"/></button>
      <p className="intent-footnote">The displayed BBO is indicative until your batch crosses.</p>
    </aside>
  );
}
