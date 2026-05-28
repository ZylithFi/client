import { useEffect, useMemo, useState } from "react";
import { fromAtomicStr } from "../domain/assets";
import type { PairConfig } from "../components/OrderTicket";
import type { PublicSettlementTranscript } from "../domain/auctionEpoch";
import type { LocalOrder } from "../domain/orderLifecycle";
import {
  activeOrderFundingTotals,
  orderFundingAmountAtomic,
  orderFundingAsset,
} from "../domain/orderFunding";
import type { PendingDeposit, WalletBalance, WithdrawableNote } from "../domain/shieldedBalances";
import {
  activeSettlementOutputs,
  pendingDepositTotals,
  settlementBasisMs,
  settlementReadyAtMs,
  sumByAsset,
} from "../domain/noteLifecycle";
import { msToCountdown } from "../domain/uiFormat";
import { noteConsolidationPlans } from "../domain/noteConsolidation";

function fmtAddr(value?: string): string {
  if (!value) return "—";
  if (value.length < 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

function pendingOrderAsset(order: LocalOrder, pairs: PairConfig[]): string {
  return orderFundingAsset(order, pairs);
}

function noteState(
  note: WithdrawableNote,
  transcripts: Record<string, PublicSettlementTranscript>,
  claimDelaySeconds: number,
  now: number,
): { label: string; settled: boolean; delay: string } {
  if (note.pending_withdrawal_tx) {
    return { label: "Pending withdrawal", settled: false, delay: fmtAddr(note.pending_withdrawal_tx) };
  }
  const readyAt = settlementReadyAtMs(note, transcripts, claimDelaySeconds);
  if (readyAt === null) {
    return { label: "Settled output", settled: true, delay: "Waiting for settlement record" };
  }
  if (now >= readyAt) {
    return { label: "Withdrawable", settled: true, delay: fmtAddr(note.note_commitment) };
  }
  return { label: "Claim delay", settled: false, delay: msToCountdown(readyAt - now) };
}

function amountOrDash(amount: string | bigint, asset: string) {
  return BigInt(amount) > 0n ? fromAtomicStr(amount.toString(), asset) : "—";
}

export function AssetsScreen({
  allAssets,
  pairs,
  balances,
  pendingDeposits,
  withdrawableNotes,
  settlementTranscripts,
  claimDelaySeconds,
  orders,
  walletReady,
  starknetAddress,
  onDeposit,
  onClaimNote,
}: {
  allAssets: string[];
  depositableAssets: string[];
  pairs: PairConfig[];
  balances: WalletBalance[];
  pendingDeposits: PendingDeposit[];
  withdrawableNotes: WithdrawableNote[];
  settlementTranscripts: Record<string, PublicSettlementTranscript>;
  claimDelaySeconds: number;
  orders: LocalOrder[];
  walletReady: boolean;
  starknetAddress: string | null;
  onDeposit: (asset?: string) => void;
  onWithdraw: (asset?: string, noteCommitment?: string) => void;
  onClaimNote: (note: WithdrawableNote) => void;
  onConnectWallet: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const pendingOrders = orders.filter(order =>
    ["queued", "in_batch", "proving", "settling"].includes(order.status),
  );
  const recognizedSettlementOutputs = useMemo(
    () => withdrawableNotes.filter(note =>
      note.source === "settlement_output" &&
      (Boolean(note.pending_withdrawal_tx) || settlementBasisMs(note, settlementTranscripts) !== null),
    ),
    [settlementTranscripts, withdrawableNotes],
  );
  const depositTotals = pendingDepositTotals(pendingDeposits);
  const failedDepositTotals = sumByAsset(pendingDeposits.filter(deposit => deposit.failed));
  const activeOrderTotals = activeOrderFundingTotals(pendingOrders, pairs);
  const activeOutputCount = activeSettlementOutputs(recognizedSettlementOutputs).length;
  const consolidationPlans = useMemo(
    () => noteConsolidationPlans(withdrawableNotes),
    [withdrawableNotes],
  );

  const assetUniverse = useMemo(() => {
    const assets = new Set(allAssets);
    for (const balance of balances) assets.add(balance.asset);
    for (const deposit of pendingDeposits) {
      assets.add(deposit.asset);
    }
    for (const note of recognizedSettlementOutputs) assets.add(note.asset);
    return [...assets];
  }, [allAssets, balances, pendingDeposits, recognizedSettlementOutputs]);
  if (!walletReady || !starknetAddress) {
    return (
      <div className="workspace-page">
        <div className="page-hd">
          <div className="page-title-block">
            <span className="page-title">ASSETS</span>
          </div>
        </div>
        <div className="table-zone">
          <div className="empty-zone">
            <div className="empty-mark">—</div>
            <div className="empty-body">Sign in to view assets.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-page assets-page">
      <div className="page-hd">
        <div className="page-title-block">
          <span className="page-title">ASSETS</span>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" onClick={() => onDeposit()}>
          Deposit
          </button>
        </div>
      </div>

      <div className="table-zone compact assets-table-zone">
        <table className="data-table asset-position-table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Available</th>
              <th>Active order size</th>
              <th>Locked capital</th>
              <th>Pending deposit</th>
              <th>Failed deposit</th>
            </tr>
          </thead>
          <tbody>
            {assetUniverse.map(asset => {
              const balance = balances.find(entry => entry.asset === asset);
              const available = balance?.available ?? "0";
              const locked = balance?.locked ?? "0";
              const activeOrderAmount = activeOrderTotals.get(asset) ?? 0n;
              const pendingDeposit = depositTotals.get(asset) ?? 0n;
              const failedDeposit = failedDepositTotals.get(asset) ?? 0n;
              return (
                <tr key={asset}>
                  <td className="ref">{asset}</td>
                  <td className={`num ${BigInt(available) === 0n ? "is-empty" : ""}`}>
                    {amountOrDash(available, asset)}
                  </td>
                  <td className={`num ${activeOrderAmount === 0n ? "is-empty" : ""}`}>
                    {amountOrDash(activeOrderAmount, asset)}
                  </td>
                  <td className={`num ${BigInt(locked) === 0n ? "is-empty" : ""}`}>
                    {amountOrDash(locked, asset)}
                  </td>
                  <td className={`num ${pendingDeposit === 0n ? "is-empty" : ""}`}>
                    {amountOrDash(pendingDeposit, asset)}
                  </td>
                  <td className={`num ${failedDeposit === 0n ? "is-empty" : "danger-text"}`}>
                    {amountOrDash(failedDeposit, asset)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <section className="asset-lifecycle">
        <div className="asset-section-hd">
          <h2>In-Flight Capital</h2>
          <span>{pendingOrders.length} active orders · {activeOutputCount} settlement outputs</span>
        </div>

        <div className="table-zone compact assets-table-zone">
          <table className="data-table asset-pipeline-table">
            <thead>
              <tr>
                <th>State</th>
                <th>Asset</th>
                <th>Amount</th>
                <th>Batch / Ref</th>
                <th>Availability</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pendingDeposits.map(deposit => (
                <tr key={`deposit:${deposit.note_commitment}`}>
                  <td>
                    <span className={deposit.failed ? "pill danger" : deposit.confirmed ? "pill good" : "pill warn"}>
                      {deposit.failed ? "Failed deposit" : deposit.confirmed ? "Activated" : "Pending deposit"}
                    </span>
                  </td>
                  <td>{deposit.asset}</td>
                  <td className="num">{fromAtomicStr(deposit.amount, deposit.asset)}</td>
                  <td className="ref">{fmtAddr(deposit.transaction_hash ?? deposit.note_commitment)}</td>
                  <td>
                    {deposit.failed
                      ? deposit.failure_reason ?? "Transaction was not confirmed"
                      : deposit.confirmed
                        ? "Available after scanner refresh"
                        : "Waiting for funding rail confirmation"}
                  </td>
                  <td />
                </tr>
              ))}

              {pendingOrders.map(order => (
                <tr key={`order:${order.ordRef}`}>
                  <td><span className="pill info">{order.status.replace("_", " ")}</span></td>
                  <td>{pendingOrderAsset(order, pairs)}</td>
                  <td className="num">
                    {fromAtomicStr(
                      orderFundingAmountAtomic(order, pairs).toString(),
                      pendingOrderAsset(order, pairs),
                    )}
                  </td>
                  <td className="ref">{order.batchId}</td>
                  <td>{order.status === "settling" ? "Awaiting output recognition" : "Locked until batch resolves"}</td>
                  <td />
                </tr>
              ))}

              {recognizedSettlementOutputs.map(note => {
                const state = noteState(note, settlementTranscripts, claimDelaySeconds, now);
                return (
                  <tr key={`note:${note.note_commitment}`}>
                    <td>
                      <span className={state.settled ? "pill good" : "pill warn"}>
                        {state.label}
                      </span>
                    </td>
                    <td>{note.asset}</td>
                    <td className="num">{fromAtomicStr(note.amount, note.asset)}</td>
                    <td className="ref">{note.batch_id ?? fmtAddr(note.note_commitment)}</td>
                    <td>{state.delay}</td>
                    <td>
                      {state.label === "Withdrawable" && (
                        <button
                          className="table-action"
                          onClick={() => onClaimNote(note)}
                        >
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}

              {pendingDeposits.length === 0 && pendingOrders.length === 0 && recognizedSettlementOutputs.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="asset-empty-inline">No private capital in flight.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {consolidationPlans.length > 0 && (
        <section className="asset-lifecycle">
          <div className="asset-section-hd">
            <h2>Note consolidation</h2>
            <span>{consolidationPlans.length} merge {consolidationPlans.length === 1 ? "plan" : "plans"}</span>
          </div>

          <div className="table-zone compact assets-table-zone">
            <table className="data-table asset-consolidation-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Source notes</th>
                  <th>Source amount</th>
                  <th>Target notes</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {consolidationPlans.map(plan => (
                  <tr key={plan.asset}>
                    <td>{plan.asset}</td>
                    <td className="num">{plan.sourceNoteCount}</td>
                    <td className="num">{plan.sourceAmountDisplay}</td>
                    <td className="num">{plan.targetNoteCount}</td>
                    <td className="tca-muted-cell">
                      Eligible for proved consolidation once the consolidation proving endpoint is enabled.
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
