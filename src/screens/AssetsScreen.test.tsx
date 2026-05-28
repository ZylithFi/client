import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssetsScreen } from "./AssetsScreen";

const baseProps = {
  allAssets: ["STRK", "ETH", "USDC", "STRKBTC"],
  depositableAssets: ["STRK", "ETH", "USDC", "STRKBTC"],
  pairs: [],
  balances: [],
  pendingDeposits: [],
  withdrawableNotes: [],
  settlementTranscripts: {},
  claimDelaySeconds: 900,
  orders: [],
  onDeposit: vi.fn(),
  onWithdraw: vi.fn(),
  onClaimNote: vi.fn(),
  onConnectWallet: vi.fn(),
};

describe("AssetsScreen", () => {
  it("gates asset data until the Zylith wallet and Starknet wallet are connected", () => {
    render(
      <AssetsScreen
        {...baseProps}
        walletReady={false}
        starknetAddress={null}
      />,
    );

    expect(screen.getByText("Sign in to view assets.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect wallet" })).not.toBeInTheDocument();
    expect(screen.queryByText("Private assets")).not.toBeInTheDocument();
    expect(screen.queryByText("STRK")).not.toBeInTheDocument();
  });

  it("renders empty balances as a dense assets ledger", () => {
    render(
      <AssetsScreen
        {...baseProps}
        walletReady
        starknetAddress="0xabc"
      />,
    );

    expect(screen.getByText("Active order size")).toBeInTheDocument();
    expect(screen.getByText("Locked capital")).toBeInTheDocument();
    expect(screen.getByText("Pending deposit")).toBeInTheDocument();
    expect(screen.getByText("Failed deposit")).toBeInTheDocument();
    expect(screen.getByText("In-Flight Capital")).toBeInTheDocument();
    expect(screen.getByText("No private capital in flight.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Deposit" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Withdraw/ })).not.toBeInTheDocument();
  });

  it("does not show deposit notes as settlement outputs", () => {
    render(
      <AssetsScreen
        {...baseProps}
        walletReady
        starknetAddress="0xabc"
        balances={[{ asset: "USDC", available: "10000000", locked: "0" }]}
        withdrawableNotes={[{
          note_commitment: "0xdeposit",
          source: "deposit",
          asset: "USDC",
          amount: "10000000",
          locked: false,
          spent: false,
          metadata_commitment: "0xmeta",
        }, {
          note_commitment: "0xstale-output",
          batch_id: "batch-missing-settlement",
          source: "settlement_output",
          asset: "USDC",
          amount: "5000000",
          locked: false,
          spent: false,
          metadata_commitment: "0xmeta2",
        }]}
      />,
    );

    expect(screen.queryByText("Settled output")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for settlement record")).not.toBeInTheDocument();
    expect(screen.getByText("No private capital in flight.")).toBeInTheDocument();
  });
});
