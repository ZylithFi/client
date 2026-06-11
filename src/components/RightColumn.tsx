import { useEffect, useState } from "react";
import { fromAtomicStr } from "../domain/assets";
import { fmtAddr } from "../domain/browserWallet";
import type { BatchSummary, PublicSettlementTranscript } from "../domain/auctionEpoch";
import { type LocalOrder, statusLabel, statusTone } from "../domain/orderLifecycle";
import { activeOrderFundingTotals } from "../domain/orderFunding";
import type { PendingDeposit, WalletBalance, WithdrawableNote } from "../domain/shieldedBalances";
import {
  activeSettlementOutputs,
  pendingDepositTotals,
  pendingWithdrawalOutputs,
  settlementBasisMs,
  settlementReadyAtMs,
  sumByAsset,
} from "../domain/noteLifecycle";
import { batchState, msToCountdown } from "../domain/uiFormat";

function ClaimSection({
  notes,
  settlementTranscripts,
  claimDelaySeconds,
  onClaim,
}: {
  notes: WithdrawableNote[];
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  claimDelaySeconds: number;
  onClaim: (note: WithdrawableNote) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const eligibleNotes = activeSettlementOutputs(notes);
  const pendingNotes = pendingWithdrawalOutputs(notes);
  const rows = eligibleNotes
    .map(note => {
      const readyAt = settlementReadyAtMs(note, settlementTranscripts, claimDelaySeconds);
      return {
        note,
        readyAt,
        remainingMs: readyAt === null ? Number.POSITIVE_INFINITY : Math.max(0, readyAt - now),
      };
    })
    .sort((a, b) => a.remainingMs - b.remainingMs || a.note.asset.localeCompare(b.note.asset));
  const hasReady = rows.some(row => row.readyAt !== null && row.remainingMs === 0);
  const readyCount = rows.filter(row => row.readyAt !== null && row.remainingMs === 0).length;
  const totalCount = rows.length + pendingNotes.length;

  useEffect(() => {
    if (totalCount === 0) setExpanded(false);
  }, [totalCount]);

  if (totalCount === 0) return null;

  return (
    <div className={`right-section claim-section compact ${hasReady ? "ready" : ""}`}>
      <button
        type="button"
        className="claim-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
      >
        <span>Notes</span>
        <em>
          {hasReady
            ? `${readyCount} ready`
            : rows.length > 0
              ? `${rows.length} output${rows.length === 1 ? "" : "s"}`
              : `${pendingNotes.length} withdrawal${pendingNotes.length === 1 ? "" : "s"}`}
        </em>
        <strong>{expanded ? "−" : "+"}</strong>
      </button>
      {expanded && (
        rows.length === 0 ? (
          <div className="claim-empty">{pendingNotes.length} withdrawal pending</div>
        ) : (
          <>
            {rows.map(row => {
              const disabled = row.readyAt === null || row.remainingMs > 0;
              return (
                <div key={row.note.note_commitment} className={`claim-row ${disabled ? "" : "ready"}`}>
                  <div className="claim-asset">{row.note.asset}</div>
                  <div>
                    <div className="claim-amount z-amt">{fromAtomicStr(row.note.amount, row.note.asset)}</div>
                    <div className="claim-delay">
                      {row.readyAt === null
                        ? "Waiting for settlement record"
                        : disabled ? `Claim delay ${msToCountdown(row.remainingMs)}` : fmtAddr(row.note.note_commitment)}
                    </div>
                  </div>
                  <button
                    className="claim-btn"
                    disabled={disabled}
                    onClick={() => onClaim(row.note)}
                  >
                    Withdraw
                  </button>
                </div>
              );
            })}
          </>
        )
      )}
    </div>
  );
}

export function RightColumn({
  activeBatch,
  activePairId,
  settlementTranscripts,
  online,
  allAssets,
  pairs,
  balances,
  pendingDeposits,
  withdrawableNotes,
  claimDelaySeconds,
  walletReady,
  starknetAddress,
  activeOrders,
  setOpenSlide,
  allOrders,
  onCancelOrder,
  onClaimNote,
}: {
  activeBatch: BatchSummary | null;
  activePairId: string;
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  online: boolean | null;
  allAssets: string[];
  pairs: Array<{
    pair_id: string;
    base_asset_id: string;
    quote_asset_id: string;
    price_base_scale?: string;
  }>;
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  withdrawableNotes: WithdrawableNote[];
  claimDelaySeconds: number;
  walletReady: boolean;
  starknetAddress: string | null;
  activeOrders: LocalOrder[];
  setOpenSlide: (v: "wallet" | "deposit" | "withdraw" | "recovery" | null) => void;
  allOrders: LocalOrder[];
  onCancelOrder: (order: LocalOrder) => void;
  onClaimNote: (note: WithdrawableNote) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const batchInfo = activeBatch ? batchState(activeBatch, now) : null;
  const msLeft = activeBatch ? activeBatch.close_time_unix_ms - now : 0;
  const batchOrders = activeBatch
    ? allOrders.filter(order => order.batchId === activeBatch.batch_id)
    : [];
  const depositTotals = pendingDepositTotals(pendingDeposits);
  const failedDepositTotals = sumByAsset(pendingDeposits.filter(deposit => deposit.failed));
  const failedDepositReasons = new Map(
    pendingDeposits
      .filter(deposit => deposit.failed)
      .map(deposit => [deposit.asset, deposit.failure_reason ?? "Deposit transaction was not confirmed"]),
  );
  const recognizedSettlementOutputs = withdrawableNotes.filter(note =>
    note.source === "settlement_output" &&
    (Boolean(note.pending_withdrawal_tx) || settlementBasisMs(note, settlementTranscripts) !== null),
  );
  const activeOrderTotals = activeOrderFundingTotals(activeOrders, pairs);
  const selectedPair = pairs.find(pair => pair.pair_id === activePairId);
  const relevantAssets = new Set<string>();
  if (selectedPair) {
    relevantAssets.add(selectedPair.base_asset_id);
    relevantAssets.add(selectedPair.quote_asset_id);
  }
  for (const asset of activeOrderTotals.keys()) relevantAssets.add(asset);
  const candidateAssets = relevantAssets.size > 0
    ? [
        ...allAssets.filter(asset => relevantAssets.has(asset)),
        ...[...relevantAssets].filter(asset => !allAssets.includes(asset)),
      ]
    : allAssets;
  const visibleAssets = candidateAssets.filter(asset => {
    const balance = balances.find(entry => entry.asset === asset);
    const available = balance ? BigInt(balance.available) : 0n;
    const locked = balance ? BigInt(balance.locked) : 0n;
    return available > 0n ||
      locked > 0n ||
      (activeOrderTotals.get(asset) ?? 0n) > 0n ||
      (depositTotals.get(asset) ?? 0n) > 0n ||
      (failedDepositTotals.get(asset) ?? 0n) > 0n;
  });

  return (
    <div className="ticket-col">
      <div className="right-section">
        <div className="right-hd">
          <span>Auction</span>
          {!batchInfo && online === false && (
            <span className="pill muted">Offline</span>
          )}
        </div>
        <div className="rb-row">
          <span>Status</span>
          {batchInfo ? (
            <span className={`status-dot-label ${batchInfo.tone} ${batchInfo.label.toLowerCase()}`}>
              {batchInfo.label}
            </span>
          ) : (
            <span className="z-amt">—</span>
          )}
        </div>
        <div className="rb-row">
          <span>Next clearing</span>
          <span className="z-amt">
            {activeBatch?.status === "Open" ? msToCountdown(msLeft) : "—"}
          </span>
        </div>
        <div className="rb-row">
          <span>Your orders</span>
          <span className="z-amt">{activeBatch ? batchOrders.length : "—"}</span>
        </div>
      </div>

      <div className="right-section right-assets-section">
        <div className="right-hd">
          <span>Assets</span>
        </div>
        {visibleAssets.map(asset => {
          const balance = balances.find(entry => entry.asset === asset);
          const available = balance && walletReady ? fromAtomicStr(balance.available, asset) : "—";
          const locked = balance && walletReady ? fromAtomicStr(balance.locked, asset) : "—";
          const activeOrderAmount = activeOrderTotals.get(asset) ?? 0n;
          const pendingDeposit = depositTotals.get(asset) ?? 0n;
          const failedDeposit = failedDepositTotals.get(asset) ?? 0n;
          const failedReason = failedDepositReasons.get(asset);
          return (
            <div key={asset} className="right-balance-card">
              <div className="right-bal-row">
                <span className="rb-asset">{asset}</span>
                <span className="rb-bal z-amt">{available}</span>
                <span className="rb-not">available</span>
              </div>
              {activeOrderAmount > 0n && (
                <div className="rb-detail-row">
                  <span>Active order size</span>
                  <strong>{fromAtomicStr(activeOrderAmount.toString(), asset)}</strong>
                </div>
              )}
              {balance && BigInt(balance.locked) > 0n && (
                <div className="rb-detail-row">
                  <span>Locked note capital</span>
                  <strong>{locked}</strong>
                </div>
              )}
              {pendingDeposit > 0n && (
                <div className="rb-detail-row">
                  <span>Pending deposit</span>
                  <strong>{fromAtomicStr(pendingDeposit.toString(), asset)}</strong>
                </div>
              )}
              {failedDeposit > 0n && (
                <div className="rb-detail-row danger" title={failedReason}>
                  <span>Failed deposit</span>
                  <strong>{fromAtomicStr(failedDeposit.toString(), asset)}</strong>
                </div>
              )}
            </div>
          );
        })}
        {visibleAssets.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--z-text-body)", lineHeight: 1.45 }}>
            No private asset balances
          </div>
        )}
        <div className="right-assets-actions">
          <button
            className="btn-ghost"
            onClick={() => setOpenSlide(walletReady && starknetAddress ? "deposit" : "wallet")}
          >Deposit</button>
          <button
            className="btn-ghost"
            onClick={() => setOpenSlide(walletReady ? "withdraw" : "wallet")}
          >Withdraw</button>
        </div>
      </div>

      <div className="right-section right-grow">
        <div className="right-hd">
          <span>Active</span>
          {activeOrders.length > 0 && (
            <span className="right-hd-meta">{activeOrders.length}</span>
          )}
        </div>
        {activeOrders.length === 0 ? (
          <div style={{ padding: "20px 0", fontSize: 11, color: "var(--z-text-body)", textAlign: "center" }}>
            No active orders
          </div>
        ) : (
          activeOrders.map(order => (
            <div key={order.ordRef} className="right-active-row">
              <span className={`active-side ${order.side === "Buy" ? "buy" : "sell"}`}>
                {order.side === "Buy" ? "B" : "S"}
              </span>
              <div className="active-body">
                <div className="active-top">
                  <span className="active-pair">{order.pair}</span>
                  <span className="active-shape">{order.wireMode}</span>
                </div>
                <div className="active-bot">
                  <span className="active-amt">{order.amount}</span>
                  {order.limitPrice && <span className="active-px">@ {order.limitPrice}</span>}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <span className={`pill ${statusTone(order.status)}`}>{statusLabel(order.status)}</span>
                {["queued", "in_batch"].includes(order.status) && (
                  <button
                    style={{ fontSize: 10, color: "var(--z-status-danger)", letterSpacing: "0.06em" }}
                    onClick={() => onCancelOrder(order)}
                  >cancel</button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {walletReady && (
        <ClaimSection
          notes={recognizedSettlementOutputs}
          settlementTranscripts={settlementTranscripts}
          claimDelaySeconds={claimDelaySeconds}
          onClaim={onClaimNote}
        />
      )}
    </div>
  );
}
