import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssetsPage } from "./AssetsPage";

describe("AssetsPage", () => {
  it("opens deposits with the registry-selected STRK default", () => {
    const onDeposit = vi.fn();
    render(
      <AssetsPage
        allAssets={["ETH", "USDC", "STRK"]}
        defaultDepositAsset="STRK"
        balances={[]}
        pendingDeposits={[]}
        withdrawals={[]}
        walletConnected
        walletReady
        assetUnitPrices={{}}
        onConnectWallet={vi.fn()}
        onDeposit={onDeposit}
        onWithdraw={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    expect(onDeposit).toHaveBeenCalledWith("STRK");
  });

  it("offers a real recovery path for failed transfers", () => {
    const onDeposit = vi.fn();
    const onWithdraw = vi.fn();
    render(
      <AssetsPage
        allAssets={["STRK"]}
        defaultDepositAsset="STRK"
        balances={[]}
        pendingDeposits={[{
          note_commitment: "0xdeposit",
          asset: "STRK",
          amount: "1000000000000000000",
          confirmed: false,
          failed: true,
        }]}
        withdrawals={[]}
        walletConnected
        walletReady
        assetUnitPrices={{}}
        onConnectWallet={vi.fn()}
        onDeposit={onDeposit}
        onWithdraw={onWithdraw}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onDeposit).toHaveBeenCalledWith("STRK");
    expect(onWithdraw).not.toHaveBeenCalled();
  });
});
