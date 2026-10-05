import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  orderQuoteValue,
  type PairConfig,
  type ReferencePriceSnapshot,
  type TicketSubmitIntent,
} from "../../domain/tradeIntent";
import { safeFromAtomicStr, toAtomicStr } from "../../domain/assets";
import type { WalletBalance } from "../../domain/shieldedBalances";
import { ShieldIcon, SwapIcon } from "./Icons";
import { TokenIcon } from "./TokenIcon";
import { defaultTradeAmount, formatQuotedPrice } from "../lib/marketFormat";

type IntentSide = "buy" | "sell";

function positiveNumber(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function validDecimalInput(value: string) {
  return value === "" || (value.length <= 64 && /^\d+(?:\.\d*)?$/.test(value));
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
  online,
  walletReady,
  submitting,
  submitError,
  onOpenWallet,
  onDeposit,
  onSubmit,
}: {
  pair: PairConfig | null;
  balances: WalletBalance[];
  referencePrice: ReferencePriceSnapshot | null;
  online: boolean;
  walletReady: boolean;
  submitting: boolean;
  submitError: string | null;
  onOpenWallet: () => void;
  onDeposit: (asset: string) => void;
  onSubmit: (intent: TicketSubmitIntent) => Promise<boolean | void>;
}) {
  const [side, setSide] = useState<IntentSide>("buy");
  const [externalMatching, setExternalMatching] = useState(false);
  const [amount, setAmount] = useState(() =>
    defaultTradeAmount(pair?.quote_asset_id ?? "")
  );
  const submitInFlight = useRef(false);
  const signedMidpoint = positiveNumber(referencePrice?.displayPrice);
  const midpoint = signedMidpoint;
  const baseAsset = pair?.base_asset_id ?? "";
  const quoteAsset = pair?.quote_asset_id ?? "";
  const payAsset = side === "buy" ? quoteAsset : baseAsset;
  const receiveAsset = side === "buy" ? baseAsset : quoteAsset;
  const numericAmount = positiveNumber(amount);
  const output = useMemo(() => {
    if (!numericAmount || !midpoint) return 0;
    const gross = side === "buy" ? numericAmount / midpoint : numericAmount * midpoint;
    return gross * (1 - (pair?.taker_fee_bps ?? 0) / 10_000);
  }, [midpoint, numericAmount, pair?.taker_fee_bps, side]);
  const fundingBalance = balances.find((balance) => balance.asset === payAsset);
  const availableAtoms = fundingBalance && /^\d+$/.test(fundingBalance.available)
    ? BigInt(fundingBalance.available)
    : 0n;
  const hasSpendableBalance = availableAtoms > 0n;
  let amountAtoms: bigint | null = null;
  if (amount && payAsset) {
    try {
      amountAtoms = BigInt(toAtomicStr(amount, payAsset));
    } catch {
      amountAtoms = null;
    }
  }
  let orderBaseAtoms: bigint | null = null;
  if (pair && amountAtoms !== null) {
    if (side === "sell") {
      orderBaseAtoms = amountAtoms;
    } else if (/^\d+$/.test(referencePrice?.midpointPrice ?? "")) {
      const midpointAtoms = BigInt(referencePrice!.midpointPrice);
      if (midpointAtoms > 0n) {
        orderBaseAtoms =
          (amountAtoms * BigInt(pair.price_base_scale)) / midpointAtoms;
      }
    }
  }
  let orderQuoteAtoms: bigint | null = null;
  if (pair && orderBaseAtoms !== null && /^\d+$/.test(referencePrice?.midpointPrice ?? "")) {
    try {
      orderQuoteAtoms = orderQuoteValue(orderBaseAtoms.toString(), referencePrice!.midpointPrice, pair);
    } catch {
      orderQuoteAtoms = null;
    }
  }
  const meetsMinimum = Boolean(
    pair &&
      orderBaseAtoms !== null &&
      orderBaseAtoms >= BigInt(pair.min_order_amount) &&
      orderQuoteAtoms !== null &&
      orderQuoteAtoms >= BigInt(pair.min_order_quote_amount)
  );
  const belowMinimum = Boolean(
    pair &&
      amountAtoms !== null &&
      amountAtoms > 0n &&
      orderBaseAtoms !== null &&
      !meetsMinimum
  );
  const available =
    walletReady && fundingBalance
      ? positiveNumber(
          safeFromAtomicStr(fundingBalance.available, payAsset, "0")
        )
      : 0;
  const limitPrice = signedMidpoint;
  const canSubmit = Boolean(
    pair &&
      walletReady &&
      hasSpendableBalance &&
      online &&
      !submitting &&
      amountAtoms !== null &&
      amountAtoms > 0n &&
      amountAtoms <= availableAtoms &&
      meetsMinimum &&
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
    const availableAtoms = fundingBalance?.available;
    if (!availableAtoms || !payAsset) return;
    try {
      const filledAtoms = (BigInt(availableAtoms) * BigInt(percent)) / 100n;
      setAmount(safeFromAtomicStr(filledAtoms, payAsset, "0"));
    } catch {
      setAmount("");
    }
  }

  async function submit() {
    if (!pair) return;
    if (!walletReady) {
      onOpenWallet();
      return;
    }
    if (!hasSpendableBalance) {
      onDeposit(payAsset);
      return;
    }
    if (!canSubmit || submitInFlight.current) return;
    submitInFlight.current = true;
    try {
      const ok = await onSubmit({
        pairId: pair.pair_id,
        side: side === "buy" ? "Buy" : "Sell",
        payAmount: amount,
        midpointPrice: referencePrice!.midpointPrice,
        priceBaseScale: referencePrice!.priceBaseScale,
        observedAtUnixMs: referencePrice!.observedAtUnixMs,
        validUntilUnixMs: referencePrice!.validUntilUnixMs,
        external: pair.external_match_enabled && externalMatching,
      });
      if (ok) setAmount("");
    } finally {
      submitInFlight.current = false;
    }
  }

  const actionLabel = submitting
    ? "Submitting..."
    : !walletReady
    ? "Connect wallet"
    : !hasSpendableBalance
    ? "Deposit"
    : "Submit order";

  return (
    <aside className="intent-panel" role="region" aria-label="Private order">
      <div className="intent-heading">
        <div>
          <h2>Trade</h2>
        </div>
      </div>

      <div className="side-toggle" role="group" aria-label="Order side">
        <button
          type="button"
          className={side === "buy" ? "active buy" : ""}
          aria-pressed={side === "buy"}
          onClick={() => setMode("buy")}
        >
          Buy
        </button>
        <button
          type="button"
          className={side === "sell" ? "active sell" : ""}
          aria-pressed={side === "sell"}
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
            maxLength={64}
            placeholder="0"
            value={amount}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              if (validDecimalInput(event.target.value)) setAmount(event.target.value);
            }}
          />
          <div className="token-select" aria-label={`Pay with ${payAsset}`}>
            <TokenIcon token={payAsset} />
            <strong>{payAsset}</strong>
          </div>
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
          <div className="token-select" aria-label={`Receive ${receiveAsset}`}>
            <TokenIcon token={receiveAsset} />
            <strong>{receiveAsset}</strong>
          </div>
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

      {pair && amountAtoms !== null && amountAtoms > availableAtoms && walletReady && (
        <p className="field-error">
          Amount exceeds your available {payAsset} balance.
        </p>
      )}
      {amount && (amountAtoms === null || amountAtoms === 0n) && (
        <p className="field-error">Enter an amount supported by {payAsset} precision.</p>
      )}
      {belowMinimum && (
        <p className="field-error">Order is below the {pair!.pair_id} minimum.</p>
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
          submitting || (walletReady && hasSpendableBalance && !canSubmit)
        }
        onClick={() => void submit()}
      >
        <span>{actionLabel}</span>
      </button>
    </aside>
  );
}
