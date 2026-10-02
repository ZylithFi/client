import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type {
  PairConfig,
  ReferencePriceSnapshot,
  TicketSubmitIntent,
} from "../../domain/tradeIntent";
import { safeFromAtomicStr } from "../../domain/assets";
import type { WalletBalance } from "../../domain/shieldedBalances";
import { ShieldIcon, SwapIcon } from "./Icons";
import { TokenIcon } from "./TokenIcon";
import { defaultTradeAmount, formatQuotedPrice } from "../lib/marketFormat";

type IntentSide = "buy" | "sell";

function positiveNumber(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function decimalInput(value: string) {
  const sanitized = value.replace(/[^0-9.]/g, "");
  const separator = sanitized.indexOf(".");
  if (separator < 0) return sanitized;
  return `${sanitized.slice(0, separator + 1)}${sanitized
    .slice(separator + 1)
    .replaceAll(".", "")}`;
}

function formatAmount(value: number, maximumFractionDigits = 8) {
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

function formatEstimatedAmount(value: number, preferTwoDigits: boolean) {
  const rounded = formatAmount(value, preferTwoDigits ? 2 : 8);
  if (value <= 0 || Number(rounded.replaceAll(",", "")) > 0) return rounded;
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 18,
    maximumSignificantDigits: 8,
  });
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
  const [externalMatching, setExternalMatching] = useState(false);
  const [amount, setAmount] = useState(() =>
    defaultTradeAmount(pair?.quote_asset_id ?? "")
  );
  const signedMidpoint = positiveNumber(referencePrice?.displayPrice);
  const midpoint = marketMidpoint || signedMidpoint;
  const baseAsset = pair?.base_asset_id ?? "";
  const quoteAsset = pair?.quote_asset_id ?? "";
  const payAsset = side === "buy" ? quoteAsset : baseAsset;
  const receiveAsset = side === "buy" ? baseAsset : quoteAsset;
  const numericAmount = positiveNumber(amount);
  const output = useMemo(() => {
    if (!numericAmount || !midpoint) return 0;
    return side === "buy" ? numericAmount / midpoint : numericAmount * midpoint;
  }, [midpoint, numericAmount, side]);
  const fundingBalance = balances.find((balance) => balance.asset === payAsset);
  const available =
    walletReady && fundingBalance
      ? positiveNumber(
          safeFromAtomicStr(fundingBalance.available, payAsset, "0")
        )
      : 0;
  const priceProtectionBps = 30;
  const limitPrice =
    signedMidpoint > 0
      ? signedMidpoint *
        (side === "buy"
          ? 1 + priceProtectionBps / 10_000
          : 1 - priceProtectionBps / 10_000)
      : 0;
  const canSubmit = Boolean(
    pair &&
      walletReady &&
      hasPrivateBalance &&
      !submitting &&
      numericAmount > 0 &&
      numericAmount <= available &&
      output > 0 &&
      limitPrice > 0
  );

  useEffect(() => {
    setAmount(defaultTradeAmount(side === "buy" ? quoteAsset : baseAsset));
  }, [baseAsset, pair?.pair_id, quoteAsset, side]);

  useEffect(() => {
    setExternalMatching(false);
  }, [pair?.pair_id]);

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
    const ok = await onSubmit({
      pairId: pair.pair_id,
      side: side === "buy" ? "Buy" : "Sell",
      payAmount: amount,
      limitPrice: limitPrice.toFixed(12).replace(/\.?0+$/, ""),
      external: pair.external_match_enabled && externalMatching,
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
      <div className="intent-heading">
        <div>
          <h2>Trade</h2>
        </div>
      </div>

      <div className="side-toggle" aria-label="Order side">
        <button
          type="button"
          className={side === "buy" ? "active buy" : ""}
          onClick={() => setMode("buy")}
        >
          Buy
        </button>
        <button
          type="button"
          className={side === "sell" ? "active sell" : ""}
          onClick={() => setMode("sell")}
        >
          Sell
        </button>
      </div>

      <div className="asset-card">
        <div className="asset-card-head">
          <span>{side === "buy" ? "You pay" : "You sell"}</span>
          <small>
            {walletReady && pair
              ? `Available ${formatAmount(available, 6)} ${payAsset}`
              : walletReady
              ? "Market unavailable"
              : "Connect to view balance"}
          </small>
        </div>
        <div className="asset-input-row">
          <input
            aria-label="Trade amount"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setAmount(decimalInput(event.target.value))
            }
          />
          <button className="token-select" type="button">
            <TokenIcon token={payAsset} />
            <strong>{payAsset}</strong>
            <span>⌄</span>
          </button>
        </div>
        <div className="asset-card-foot">
          <span>
            {midpoint > 0
              ? `≈ ${formatQuotedPrice(
                  side === "buy" ? numericAmount : numericAmount * midpoint,
                  quoteAsset
                )}`
              : "Unavailable"}
          </span>
          <div className="quick-actions">
            <button
              type="button"
              disabled={!walletReady}
              onClick={() => quickFill(25)}
            >
              25%
            </button>
            <button
              type="button"
              disabled={!walletReady}
              onClick={() => quickFill(50)}
            >
              50%
            </button>
            <button
              type="button"
              disabled={!walletReady}
              onClick={() => quickFill(100)}
            >
              MAX
            </button>
          </div>
        </div>
      </div>

      <div className="swap-divider">
        <span />
        <button
          type="button"
          aria-label="Swap assets"
          onClick={() => setMode(side === "buy" ? "sell" : "buy")}
        >
          <SwapIcon className="icon-16" />
        </button>
        <span />
      </div>

      <div className="asset-card receive-card">
        <div className="asset-card-head">
          <span>You receive</span>
          <small>Estimated at current midpoint</small>
        </div>
        <div className="asset-input-row">
          <div className="receive-value">
            {pair
              ? `≈ ${formatEstimatedAmount(
                  output,
                  receiveAsset === quoteAsset,
                )}`
              : "Unavailable"}
          </div>
          <button className="token-select" type="button">
            <TokenIcon token={receiveAsset} />
            <strong>{receiveAsset}</strong>
            <span>⌄</span>
          </button>
        </div>
        <div className="asset-card-foot">
          <span>
            {midpoint > 0
              ? `≈ ${formatQuotedPrice(
                  receiveAsset === quoteAsset ? output : output * midpoint,
                  quoteAsset
                )}`
              : "Unavailable"}
          </span>
          <span className="muted">Final amount is determined at execution</span>
        </div>
      </div>

      <div className="privacy-note">
        <ShieldIcon className="icon-18" />
        <p>
          <strong>Private execution</strong>
          <span>Your order stays private and executes at the midpoint when matched.</span>
        </p>
      </div>

      <div className="execution-options" aria-label="Execution options">
        <label>
          <input
            type="checkbox"
            aria-label="External matching"
            checked={externalMatching}
            disabled={!pair?.external_match_enabled}
            onChange={(event) => setExternalMatching(event.target.checked)}
          />
          <span>
            <strong>External matching</strong>
            <small>Allow unfilled size to use external liquidity</small>
          </span>
        </label>
      </div>

      <div className="quote-details">
        <div>
          <span>Execution</span>
          <strong>Midpoint</strong>
        </div>
        <div>
          <span>Estimated price</span>
          <strong>{formatQuotedPrice(midpoint, quoteAsset)}</strong>
        </div>
        <div>
          <span>Fee</span>
          <strong>{pair ? `${pair.taker_fee_bps} bps` : "Unavailable"}</strong>
        </div>
      </div>

      {pair && numericAmount > available && walletReady && (
        <p className="field-error">
          Amount exceeds your available {payAsset} balance.
        </p>
      )}
      {submitError && (
        <p className="field-error" role="alert">
          {submitError}
        </p>
      )}
      <button
        className="primary-cta"
        type="button"
        aria-label={actionLabel}
        disabled={
          submitting || (walletReady && hasPrivateBalance && !canSubmit)
        }
        onClick={() => void submit()}
      >
        <span>{actionLabel}</span>
      </button>
    </aside>
  );
}
