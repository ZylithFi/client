import { useReducer } from "react";
import { assetScale, safeFromAtomicStr, toPriceAtomicStr } from "../domain/assets";
import { safeAtomicAmount } from "../domain/noteLifecycle";
import { runPrimaryActionOnEnter } from "../domain/primaryEnter";
import type { WalletBalance } from "../domain/shieldedBalances";
import { userFacingErrorMessage } from "../domain/userFacingErrors";

export type TicketShape = "limit" | "strategy";
export type StratKind = "Repeat";
export type ExecutionPreference = "PrivateOnly" | "PrivateThenExternal";

export type PairConfig = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  min_order_amount: string;
  price_base_scale?: string;
  taker_fee_bps?: number;
  external_match_enabled: boolean;
  enabled: boolean;
};

export type ReferencePriceSnapshot = {
  displayPrice: string;
  midpointPrice: string;
  priceBaseScale?: string;
  observedAtUnixMs?: number;
};

export type TicketSubmitIntent = {
  pairId?: string;
  side: "Buy" | "Sell";
  shape: TicketShape;
  stratKind: StratKind;
  amount: string;
  limitPrice: string;
  minFill: string;
  fillOrKill: boolean;
  durationHours: string;
  childSize: string;
  priceLimit: string;
  jitter: number;
  executionPreference: ExecutionPreference;
  keepTryingPrivate: boolean;
  retryHours: string;
  relayMode?: "SelfRelay" | "ZylithRelay";
  relayOperator?: "ZylithRelay" | "SelfHostedRelay";
  selfRelayUrl?: string;
};

export type FundingPreview = {
  asset: string;
  required: string;
  selected_total: string;
  expected_change: string;
  notes: Array<{
    note_commitment: string;
    asset: string;
    amount: string;
    source: "deposit" | "settlement_output";
  }>;
};

type OrderTicketState = {
  side: "Buy" | "Sell";
  shape: TicketShape;
  stratKind: StratKind;
  amount: string;
  limitPrice: string;
  minFill: string;
  fillOrKill: boolean;
  durationHours: string;
  childSize: string;
  priceLimit: string;
  jitter: number;
  priceProtectionBps: string;
  executionPreference: ExecutionPreference;
  keepTryingPrivate: boolean;
  retryHours: string;
  showAdv: boolean;
};

type TicketAction =
  | { type: "patch"; patch: Partial<OrderTicketState> }
  | { type: "resetAfterSubmit" };

const initialTicketState: OrderTicketState = {
  side: "Buy",
  shape: "limit",
  stratKind: "Repeat",
  amount: "",
  limitPrice: "",
  minFill: "",
  fillOrKill: false,
  durationHours: "4",
  childSize: "",
  priceLimit: "",
  jitter: 12,
  priceProtectionBps: "30",
  executionPreference: "PrivateThenExternal",
  keepTryingPrivate: false,
  retryHours: "4",
  showAdv: false,
};

function ticketReducer(state: OrderTicketState, action: TicketAction): OrderTicketState {
  if (action.type === "patch") return { ...state, ...action.patch };
  return {
    ...state,
    amount: "",
    limitPrice: "",
    minFill: "",
    fillOrKill: false,
    childSize: "",
    priceLimit: "",
    priceProtectionBps: "30",
    executionPreference: "PrivateThenExternal",
    keepTryingPrivate: false,
    retryHours: "4",
  };
}

function submitLabel(state: OrderTicketState, submitting: boolean) {
  if (submitting) return "Submitting...";
  return `${state.side}`;
}

export function OrderTicket({
  pair,
  balances,
  referencePrice,
  walletReady,
  hasPrivateBalance,
  submitting,
  submitError,
  onOpenWallet,
  onDeposit,
  onPreviewFunding,
  onSubmit,
}: {
  pair: PairConfig | null;
  balances: WalletBalance[];
  referencePrice?: ReferencePriceSnapshot | null;
  walletReady: boolean;
  hasPrivateBalance: boolean;
  submitting: boolean;
  submitError: string | null;
  onOpenWallet: () => void;
  onDeposit: () => void;
  onPreviewFunding?: (intent: TicketSubmitIntent) => FundingPreview | null;
  onSubmit: (intent: TicketSubmitIntent) => Promise<boolean | void>;
}) {
  const [state, dispatch] = useReducer(ticketReducer, initialTicketState);

  if (!pair) {
    return (
      <div className="ticket-zone">
        <div className="ticket-scroll" style={{ alignItems: "center", justifyContent: "center", flex: 1, color: "var(--z-text-body)", fontSize: 12 }}>
          Select a pair
        </div>
      </div>
    );
  }

  const baseAsset = pair.base_asset_id;
  const quoteAsset = pair.quote_asset_id;
  const externalMatchEnabled = pair.external_match_enabled;
  const executionPreference = externalMatchEnabled
    ? state.executionPreference
    : "PrivateOnly";
  const priceBaseScaleValue = pair.price_base_scale ?? assetScale(baseAsset).toString();
  const fundingAsset = state.side === "Buy" ? quoteAsset : baseAsset;
  const fundingBal = balances.find(b => b.asset === fundingAsset);
  const fundingAvailable = fundingBal ? safeAtomicAmount(fundingBal.available) : 0n;
  const fundingLocked = fundingBal ? safeAtomicAmount(fundingBal.locked) : 0n;
  const availableDisplay = fundingBal && walletReady
    ? safeFromAtomicStr(fundingBal.available, fundingAsset)
    : null;
  const lockedDisplay = fundingBal && walletReady && fundingLocked > 0n
    ? safeFromAtomicStr(fundingBal.locked, fundingAsset)
    : null;
  const referenceQuoteAtomic = referenceQuoteAtomicPerBase(pair, referencePrice);
  const priceProtectionBps = normalizedProtectionBps(state.priceProtectionBps);
  const limitPrice = referenceQuoteAtomic === null
    ? ""
    : protectedLimitPrice(referenceQuoteAtomic, quoteAsset, state.side, priceProtectionBps);
  const protectionLabel = state.side === "Buy" ? "Max price" : "Min price";

  if (!walletReady) {
    return (
      <div className="ticket-zone ticket-gate-zone">
        <div className="ticket-state-gate">
          <div className="gate-title">Connect wallet to start.</div>
          <div className="gate-body">Choose a Starknet wallet to enable private trading.</div>
          <button className="btn-accent gate-primary" onClick={onOpenWallet}>
            Connect wallet
          </button>
        </div>
      </div>
    );
  }

  if (!hasPrivateBalance) {
    return (
      <div className="ticket-zone ticket-gate-zone">
        <div className="ticket-state-gate">
          <div className="gate-title">Deposit before trading.</div>
          <div className="gate-body">Add private funds before placing an order.</div>
          <button className="btn-accent gate-primary" onClick={onDeposit}>
            Deposit
          </button>
        </div>
      </div>
    );
  }

  function quickFill(pct: number) {
    if (!fundingBal || !walletReady) return;
    const portion = fundingAvailable * BigInt(pct) / 100n;
    if (portion <= 0n) return;
    if (state.side === "Sell") {
      dispatch({ type: "patch", patch: { amount: safeFromAtomicStr(portion, baseAsset, "0") } });
      return;
    }
    const price = BigInt(toPriceAtomicStr(limitPrice, quoteAsset));
    if (price <= 0n) return;
    const priceBaseScale = safeAtomicAmount(priceBaseScaleValue);
    if (priceBaseScale <= 0n) return;
    const baseAtomic = (portion * priceBaseScale) / price;
    dispatch({ type: "patch", patch: { amount: safeFromAtomicStr(baseAtomic, baseAsset, "0") } });
  }

  const canQuickFill = Boolean(
    walletReady &&
      fundingBal &&
      fundingAvailable > 0n &&
      (state.side === "Sell" || (() => {
        return Number.isFinite(Number(limitPrice)) && Number(limitPrice) > 0;
      })()),
  );
  const retryOptions = [
    { label: "1h", value: "1" },
    { label: "4h", value: "4" },
    { label: "12h", value: "12" },
  ];

  const canSubmit = walletReady && !submitting && (() => {
    if (fundingAvailable <= 0n) return false;
    return state.amount.trim() !== "" && limitPrice.trim() !== "";
  })();

  async function submitStandard() {
    const ok = await onSubmit({
      ...state,
      shape: "limit",
      stratKind: "Repeat",
      limitPrice,
      priceLimit: "",
      childSize: "",
      jitter: 0,
      executionPreference,
    });
    if (ok !== false) dispatch({ type: "resetAfterSubmit" });
  }

  const showSummary = state.amount.trim() !== "" && limitPrice.trim() !== "";
  const previewIntent: TicketSubmitIntent = {
    ...state,
    shape: "limit",
    stratKind: "Repeat",
    limitPrice,
    priceLimit: "",
    childSize: "",
    jitter: 0,
    executionPreference,
  };
  let fundingPreview: FundingPreview | null = null;
  let fundingPreviewError: string | null = null;
  if (showSummary && onPreviewFunding) {
    try {
      fundingPreview = onPreviewFunding(previewIntent);
    } catch (error) {
      fundingPreviewError = userFacingErrorMessage(error, "Funding preview unavailable.");
    }
  }

  return (
    <div
      className="ticket-zone"
      onKeyDown={event => {
        runPrimaryActionOnEnter(event, canSubmit, () => { void submitStandard(); });
      }}
    >
      <div className="ticket-scroll">
        <div className="side-segment" aria-label="Order side">
          <button
            type="button"
            className={`side-segment-btn buy ${state.side === "Buy" ? "on" : ""}`}
            onClick={() => dispatch({ type: "patch", patch: { side: "Buy" } })}
          >
            Buy
          </button>
          <button
            type="button"
            className={`side-segment-btn sell ${state.side === "Sell" ? "on" : ""}`}
            onClick={() => dispatch({ type: "patch", patch: { side: "Sell" } })}
          >
            Sell
          </button>
        </div>

        <div className="f-row">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <label className="f-label" style={{ marginBottom: 0 }}>Amount</label>
            <span className="avail-meta">
              {walletReady && availableDisplay !== null
                ? `${availableDisplay} ${fundingAsset} available`
                : "-"}
            </span>
          </div>
          <div className="amount-side-row">
            <div className="f-input-box">
              <input
                className="f-input"
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={state.amount}
                onChange={e => dispatch({ type: "patch", patch: { amount: e.target.value } })}
                disabled={!walletReady}
              />
              <span className="amount-quick-actions">
                <button type="button" className="quick-fill-btn" disabled={!canQuickFill} onClick={() => quickFill(25)}>25%</button>
                <button type="button" className="quick-fill-btn" disabled={!canQuickFill} onClick={() => quickFill(50)}>50%</button>
                <button type="button" className="quick-fill-btn" disabled={!canQuickFill} onClick={() => quickFill(100)}>Max</button>
              </span>
              <span className="f-unit">{baseAsset}</span>
            </div>
          </div>
          {walletReady && fundingAvailable <= 0n && (
            <div className="field-note warn">
              No available {fundingAsset} note for this {state.side.toLowerCase()}.
              {lockedDisplay ? ` ${lockedDisplay} ${fundingAsset} is locked in active orders.` : " Switch side or deposit this asset."}
            </div>
          )}
        </div>
        <>
          <div className="midpoint-ticket-panel">
            <div>
              <span>Midpoint</span>
              <strong>{referencePrice?.displayPrice ?? "-"}</strong>
            </div>
            <div>
              <span>{protectionLabel}</span>
              <strong>{limitPrice || "-"}</strong>
            </div>
          </div>

          <div className="f-row">
            <label className="f-label">Price protection</label>
            <div className="f-select-row" style={{ height: 36 }}>
              {["10", "30", "50", "100"].map(opt => (
                <button
                  key={opt}
                  type="button"
                  className={`f-select-opt ${state.priceProtectionBps === opt ? "on" : ""}`}
                  onClick={() => dispatch({ type: "patch", patch: { priceProtectionBps: opt } })}
                >
                  {Number(opt) / 100}%
                </button>
              ))}
            </div>
            {!referencePrice && (
              <div className="field-note warn">
                Waiting for the signed midpoint reference.
              </div>
            )}
          </div>
            {externalMatchEnabled && (
              <div className="f-row">
                <label className="f-label">Completion</label>
                <div className="f-select-row" style={{ height: 36 }}>
                  <button
                    type="button"
                    className={`f-select-opt ${executionPreference === "PrivateThenExternal" ? "on" : ""}`}
                    onClick={() => dispatch({
                      type: "patch",
                      patch: {
                        executionPreference: "PrivateThenExternal",
                        keepTryingPrivate: false,
                      },
                    })}
                  >
                    Match residual
                  </button>
                  <button
                    type="button"
                    className={`f-select-opt ${executionPreference === "PrivateOnly" ? "on" : ""}`}
                    onClick={() => dispatch({
                      type: "patch",
                      patch: { executionPreference: "PrivateOnly" },
                    })}
                  >
                    Private only
                  </button>
                </div>
              </div>
            )}
            {executionPreference === "PrivateOnly" && (
              <div className="f-row">
                <label className="f-check" style={{ marginBottom: 10 }}>
                  <input
                    type="checkbox"
                    aria-label="Keep trying privately"
                    checked={state.keepTryingPrivate}
                    onChange={e => dispatch({
                      type: "patch",
                      patch: { keepTryingPrivate: e.target.checked },
                    })}
                  />
                  Keep trying privately
                </label>
                {state.keepTryingPrivate && (
                  <div className="f-select-row" style={{ height: 34 }}>
                    {retryOptions.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`f-select-opt ${state.retryHours === opt.value ? "on" : ""}`}
                        onClick={() => dispatch({
                          type: "patch",
                          patch: { retryHours: opt.value },
                        })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button className="adv-toggle" onClick={() => dispatch({ type: "patch", patch: { showAdv: !state.showAdv } })}>
              <span>Advanced</span>
              <strong>{state.showAdv ? "⌃" : "⌄"}</strong>
            </button>
            {state.showAdv && (
              <>
                <div className="f-row">
                  <label className="f-label">Min fill</label>
                  <div className="f-input-box">
                    <input className="f-input" type="text" inputMode="decimal" placeholder="0"
                      value={state.minFill} onChange={e => dispatch({ type: "patch", patch: { minFill: e.target.value } })} />
                    <span className="f-unit">{baseAsset}</span>
                  </div>
                </div>
                <label className="f-check" style={{ marginBottom: 12 }}>
                  <input type="checkbox" checked={state.fillOrKill} onChange={e => dispatch({ type: "patch", patch: { fillOrKill: e.target.checked } })} />
                  Fill or kill
                </label>
              </>
            )}
        </>

        <>
          {showSummary && (
            <div className="worst-case">
                <div className="wc-eyebrow">Order summary</div>
                <div className="wc-row">
                  <span className="l">Amount</span>
                  <span className="r">{state.amount} {baseAsset}</span>
                </div>
                <div className="wc-row">
                  <span className="l">Midpoint</span>
                  <span className="r">{referencePrice?.displayPrice ?? "-"} {quoteAsset}</span>
                </div>
                <div className="wc-row">
                  <span className="l">{protectionLabel}</span>
                  <span className="r">{limitPrice} {quoteAsset}</span>
                </div>
                <div className="wc-row">
                  <span className="l">Protection</span>
                  <span className="r">{Number(priceProtectionBps) / 100}%</span>
                </div>
                <div className="wc-row">
                  <span className="l">Side</span>
                  <span className="r">{state.side}</span>
                </div>
                <div className="wc-row">
                  <span className="l">Completion</span>
                  <span className="r">
                    {executionPreference === "PrivateOnly"
                      ? state.keepTryingPrivate
                        ? `${state.retryHours}h private`
                        : "Private only"
                      : "Midpoint matcher"}
                  </span>
                </div>
                <div className="wc-divider" />
                <div className="wc-row">
                  <span className="l">Protocol fee</span>
                  <span className="r">{pair?.taker_fee_bps ?? 4} bps</span>
                </div>
                {fundingPreview && (
                  <>
                    <div className="wc-row">
                      <span className="l">Funding notes</span>
                      <span className="r">{fundingPreview.notes.length} note{fundingPreview.notes.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="funding-preview-list">
                      {fundingPreview.notes.map(note => (
                        <div key={note.note_commitment} className="funding-preview-row">
                          <span>{note.note_commitment.slice(0, 8)}…{note.note_commitment.slice(-4)}</span>
                          <strong>{safeFromAtomicStr(note.amount, note.asset)} {note.asset}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="wc-row">
                      <span className="l">Locked capital</span>
                      <span className="r">{safeFromAtomicStr(fundingPreview.selected_total, fundingPreview.asset)} {fundingPreview.asset}</span>
                    </div>
                    <div className="wc-row">
                      <span className="l">Expected change</span>
                      <span className="r">{safeFromAtomicStr(fundingPreview.expected_change, fundingPreview.asset)} {fundingPreview.asset}</span>
                    </div>
                  </>
                )}
                {fundingPreviewError && (
                  <div className="wc-note warn">{fundingPreviewError}</div>
                )}
                <div className="wc-row">
                  <span className="l">Settlement</span>
                  <span className="r">Clears automatically</span>
                </div>
            </div>
          )}

          {submitError && (
            <div style={{ fontSize: 11, color: "var(--z-status-danger)", marginBottom: 8, lineHeight: 1.45 }}>
              {submitError}
            </div>
          )}
          <button
            className={`submit-btn ${state.side === "Sell" ? "sell-mode" : "buy-mode"}`}
            aria-label={`${state.side} order`}
            disabled={!canSubmit}
            onClick={() => { void submitStandard(); }}
          >
            {submitLabel(state, submitting)}
          </button>
        </>
      </div>
    </div>
  );
}

function normalizedProtectionBps(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.min(1_000, Math.max(1, Math.round(parsed)));
}

function referenceQuoteAtomicPerBase(
  pair: PairConfig,
  referencePrice?: ReferencePriceSnapshot | null,
): bigint | null {
  if (!referencePrice) return null;
  try {
    const baseScale = assetScale(pair.base_asset_id);
    const priceBaseScale = BigInt(referencePrice.priceBaseScale ?? pair.price_base_scale ?? baseScale.toString());
    if (priceBaseScale <= 0n) return null;
    return (BigInt(referencePrice.midpointPrice) * baseScale) / priceBaseScale;
  } catch {
    return null;
  }
}

function protectedLimitPrice(
  quoteAtomicPerBase: bigint,
  quoteAsset: string,
  side: "Buy" | "Sell",
  protectionBps: number,
): string {
  const denominator = 10_000n;
  const bps = BigInt(protectionBps);
  const adjusted = side === "Buy"
    ? (quoteAtomicPerBase * (denominator + bps) + denominator - 1n) / denominator
    : (quoteAtomicPerBase * (denominator - bps)) / denominator;
  return safeFromAtomicStr(adjusted, quoteAsset, "0");
}
