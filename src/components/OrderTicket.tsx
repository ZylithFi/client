import { useReducer } from "react";
import { assetScale, fromAtomicStr, toPriceAtomicStr } from "../domain/assets";
import type { CurvePoint } from "../domain/makerCurves";
import { runPrimaryActionOnEnter } from "../domain/primaryEnter";
import type { WalletBalance } from "../domain/shieldedBalances";
import { userFacingErrorMessage } from "../domain/userFacingErrors";

export type TicketShape = "limit" | "strategy" | "curve";
export type StratKind = "TWAP" | "VWAP" | "Repeat";

export type PairConfig = {
  pair_id: string;
  base_asset_id: string;
  quote_asset_id: string;
  min_order_amount: string;
  price_base_scale?: string;
  taker_fee_bps?: number;
  maker_fee_bps?: number;
  relay_fee_bps?: number;
  enabled: boolean;
};

export type TicketSubmitIntent = {
  pairId?: string;
  side: "Buy" | "Sell";
  shape: TicketShape;
  stratKind: StratKind;
  resting: boolean;
  amount: string;
  limitPrice: string;
  minFill: string;
  fillOrKill: boolean;
  curvePoints: CurvePoint[];
  inventoryCap: string;
  durationHours: string;
  childSize: string;
  priceLimit: string;
  jitter: number;
  relayMode?: "SelfRelay" | "ZylithRelay";
  relayOperator?: "ZylithRelay" | "SelfHostedRelay" | "LocalBrowser";
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
  showAdv: boolean;
};

type TicketAction =
  | { type: "patch"; patch: Partial<OrderTicketState> }
  | { type: "resetAfterSubmit" }
  | { type: "forceShape"; shape: TicketShape };

const initialTicketState: OrderTicketState = {
  side: "Buy",
  shape: "limit",
  stratKind: "TWAP",
  amount: "",
  limitPrice: "",
  minFill: "",
  fillOrKill: false,
  durationHours: "4",
  childSize: "",
  priceLimit: "",
  jitter: 12,
  showAdv: false,
};

function ticketReducer(state: OrderTicketState, action: TicketAction): OrderTicketState {
  if (action.type === "patch") return { ...state, ...action.patch };
  if (action.type === "forceShape") return { ...state, shape: action.shape };
  return {
    ...state,
    amount: "",
    limitPrice: "",
    minFill: "",
    fillOrKill: false,
    childSize: "",
    priceLimit: "",
  };
}

function submitLabel(state: OrderTicketState, submitting: boolean) {
  if (submitting) return "Submitting...";
  if (state.shape === "strategy") return `Submit ${state.stratKind}`;
  return `Submit ${state.side}`;
}

function ShapeTab({
  active,
  gated,
  title,
  onClick,
}: {
  active: boolean;
  gated?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`shape-tab ${active ? "on" : ""} ${gated ? "maker-gated" : ""}`}
      onClick={onClick}
    >
      <span className="shape-tab-title">{title}</span>
    </button>
  );
}

export function OrderTicket({
  pair,
  balances,
  batchWindowMs,
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
  batchWindowMs: number;
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
  const priceBaseScaleValue = pair.price_base_scale ?? assetScale(baseAsset).toString();
  const fundingAsset = state.side === "Buy" ? quoteAsset : baseAsset;
  const fundingBal = balances.find(b => b.asset === fundingAsset);
  const fundingAvailable = fundingBal ? BigInt(fundingBal.available) : 0n;
  const fundingLocked = fundingBal ? BigInt(fundingBal.locked) : 0n;
  const availableDisplay = fundingBal && walletReady
    ? fromAtomicStr(fundingBal.available, fundingAsset)
    : null;
  const lockedDisplay = fundingBal && walletReady && fundingLocked > 0n
    ? fromAtomicStr(fundingBal.locked, fundingAsset)
    : null;

  if (!walletReady) {
    return (
      <div className="ticket-zone ticket-gate-zone">
        <div className="ticket-state-gate">
          <div className="gate-title">Connect wallet to start.</div>
          <div className="gate-body">Choose a Starknet wallet, then unlock the local Zylith wallet.</div>
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
          <div className="gate-body">Add funds to your Zylith wallet before placing an order.</div>
          <button className="btn-accent gate-primary" onClick={onDeposit}>
            Deposit
          </button>
        </div>
      </div>
    );
  }

  function quickFill(pct: number) {
    if (!fundingBal || !walletReady) return;
    const portion = BigInt(fundingBal.available) * BigInt(pct) / 100n;
    if (state.side === "Sell") {
      dispatch({ type: "patch", patch: { amount: fromAtomicStr(portion.toString(), baseAsset) } });
      return;
    }
    const priceInput = state.shape === "strategy" ? state.priceLimit : state.limitPrice;
    const price = BigInt(toPriceAtomicStr(priceInput, quoteAsset));
    if (price <= 0n) return;
    const priceBaseScale = BigInt(priceBaseScaleValue);
    const baseAtomic = (portion * priceBaseScale) / price;
    dispatch({ type: "patch", patch: { amount: fromAtomicStr(baseAtomic.toString(), baseAsset) } });
  }

  const canQuickFill = Boolean(
    walletReady &&
      fundingBal &&
      (state.side === "Sell" || (() => {
        const priceInput = state.shape === "strategy" ? state.priceLimit : state.limitPrice;
        return Number.isFinite(Number(priceInput)) && Number(priceInput) > 0;
      })()),
  );
  const durationOptions = [
    { label: "1h", value: "1" },
    { label: "4h", value: "4" },
    { label: "12h", value: "12" },
    { label: "24h", value: "24" },
  ];
  const batchTimingReady = batchWindowMs > 0;
  const strategyChildCount = batchTimingReady
    ? Math.max(1, Math.ceil((Number(state.durationHours || "0") * 3_600_000) / batchWindowMs))
    : null;
  const strategyChildSize = state.childSize.trim()
    ? state.childSize
    : state.amount.trim() && strategyChildCount !== null && strategyChildCount > 0
      ? (Number(state.amount) / strategyChildCount).toLocaleString("en-US", { maximumFractionDigits: 8 })
      : "auto";

  const canSubmit = walletReady && !submitting && (() => {
    if (fundingAvailable <= 0n) return false;
    if (state.shape === "limit") return state.amount.trim() !== "" && state.limitPrice.trim() !== "";
    if (state.shape === "strategy") return batchTimingReady && state.amount.trim() !== "" && state.priceLimit.trim() !== "";
    return false;
  })();

  async function submitStandard() {
    const ok = await onSubmit({
      ...state,
      resting: false,
      curvePoints: [],
      inventoryCap: "",
    });
    if (ok !== false) dispatch({ type: "resetAfterSubmit" });
  }

  const summaryPrice = state.shape === "limit" ? state.limitPrice : state.priceLimit;
  const showSummary = state.amount.trim() !== "" && summaryPrice.trim() !== "";
  const previewIntent: TicketSubmitIntent = {
    ...state,
    resting: false,
    curvePoints: [],
    inventoryCap: "",
  };
  let fundingPreview: FundingPreview | null = null;
  let fundingPreviewError: string | null = null;
  if (showSummary && state.shape !== "curve" && onPreviewFunding) {
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

        {state.shape !== "curve" && (
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
        )}

        <div
          className="ticket-shape-row"
          style={{ gridTemplateColumns: "1fr 1fr" }}
        >
          <ShapeTab
            title="Limit"
            active={state.shape === "limit"}
            onClick={() => dispatch({ type: "patch", patch: { shape: "limit" } })}
          />
          <ShapeTab
            title="Program"
            active={state.shape === "strategy"}
            onClick={() => dispatch({ type: "patch", patch: { shape: "strategy" } })}
          />
        </div>

        {state.shape === "limit" && (
          <>
            <div className="f-row">
              <label className="f-label">{state.side === "Buy" ? "Max price" : "Min price"}</label>
              <div className="f-input-box">
                <input className="f-input" type="text" inputMode="decimal" placeholder="0"
                  value={state.limitPrice} onChange={e => dispatch({ type: "patch", patch: { limitPrice: e.target.value } })} />
                <span className="f-unit">{quoteAsset}</span>
              </div>
            </div>
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
        )}

        {state.shape === "strategy" && (
          <>
            <div className="f-select-row" style={{ marginBottom: 14, height: 30 }}>
              {(["TWAP", "VWAP", "Repeat"] as StratKind[]).map(k => (
                <button key={k} className={`f-select-opt ${state.stratKind === k ? "on" : ""}`} onClick={() => dispatch({ type: "patch", patch: { stratKind: k } })}>{k}</button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              <div className="f-row" style={{ marginBottom: 0 }}>
                <label className="f-label">Duration</label>
                <div className="f-select-row" style={{ height: 36 }}>
                  {durationOptions.map(opt => (
                    <button
                      key={opt.value}
                      className={`f-select-opt ${state.durationHours === opt.value ? "on" : ""}`}
                      onClick={() => dispatch({ type: "patch", patch: { durationHours: opt.value } })}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>
              <div className="f-row" style={{ marginBottom: 0 }}>
                <label className="f-label">Child size</label>
                <div className="f-input-box" style={{ height: 36 }}>
                  <input className="f-input" type="text" inputMode="decimal" placeholder="auto"
                    value={state.childSize} onChange={e => dispatch({ type: "patch", patch: { childSize: e.target.value } })} style={{ fontSize: 14 }} />
                </div>
              </div>
            </div>
            <div className="f-row">
              <label className="f-label">Price limit</label>
              <div className="f-input-box">
                <input className="f-input" type="text" inputMode="decimal" placeholder="0"
                  value={state.priceLimit} onChange={e => dispatch({ type: "patch", patch: { priceLimit: e.target.value } })} />
                <span className="f-unit">{quoteAsset}</span>
              </div>
            </div>
            <div className="f-row">
              <label className="f-label">Randomness ±{state.jitter}%</label>
              <input className="z-range" type="range" min={0} max={40} value={state.jitter} onChange={e => dispatch({ type: "patch", patch: { jitter: Number(e.target.value) } })} />
            </div>
            <div className="strategy-explainer">
              <div className="strategy-preview">
                {strategyChildCount === null
                  ? "Auction timing loading"
                  : `${strategyChildCount} slice${strategyChildCount !== 1 ? "s" : ""} · ${strategyChildSize} ${baseAsset} each`}
              </div>
              {state.stratKind === "TWAP" && "TWAP splits your order into equal time-weighted slices."}
              {state.stratKind === "VWAP" && "VWAP-style execution uses a deterministic private weight schedule for child sizes; it does not depend on public venue volume."}
              {state.stratKind === "Repeat" && "Repeat submits the configured child size until the total amount is exhausted or the parent is cancelled."}
            </div>
          </>
        )}

        {state.shape !== "curve" && (
          <>
            {showSummary && (
              <div className="worst-case">
                <div className="wc-eyebrow">Order summary</div>
                <div className="wc-row">
                  <span className="l">Amount</span>
                  <span className="r">{state.amount} {baseAsset}</span>
                </div>
                <div className="wc-row">
                  <span className="l">{state.shape === "strategy" ? "Price limit" : state.side === "Buy" ? "Max price" : "Min price"}</span>
                  <span className="r">{summaryPrice} {quoteAsset}</span>
                </div>
                <div className="wc-row">
                  <span className="l">Side</span>
                  <span className="r">{state.side}</span>
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
                          <strong>{fromAtomicStr(note.amount, note.asset)} {note.asset}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="wc-row">
                      <span className="l">Locked capital</span>
                      <span className="r">{fromAtomicStr(fundingPreview.selected_total, fundingPreview.asset)} {fundingPreview.asset}</span>
                    </div>
                    <div className="wc-row">
                      <span className="l">Expected change</span>
                      <span className="r">{fromAtomicStr(fundingPreview.expected_change, fundingPreview.asset)} {fundingPreview.asset}</span>
                    </div>
                    {state.shape === "strategy" && (
                      <div className="wc-note">
                        Preview uses the next child slice; randomized slicing can move the final lock slightly.
                      </div>
                    )}
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
              disabled={!canSubmit}
              onClick={() => { void submitStandard(); }}
            >
              {submitLabel(state, submitting)}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
