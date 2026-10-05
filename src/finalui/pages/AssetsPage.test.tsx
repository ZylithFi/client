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
});
