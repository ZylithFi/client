import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setWalletRuntime } from "../domain/browserWallet";
import { TopNav } from "./TopNav";

const baseProps = {
  workspace: "taker" as const,
  tab: "trade" as const,
  liquidityTab: "positions" as const,
  setTab: vi.fn(),
  setLiquidityTab: vi.fn(),
  onBrandClick: vi.fn(),
  onToggleLiquidity: vi.fn(),
  activeOrderCount: 0,
  claimableOutputCount: 0,
  walletReady: true,
  starknetAddress: "0xabcdef1234567890",
  onOpenWallet: vi.fn(),
  onDeposit: vi.fn(),
  onWithdraw: vi.fn(),
  onLock: vi.fn(),
  onDisconnectWallet: vi.fn(),
};

afterEach(() => {
  setWalletRuntime(null);
  vi.restoreAllMocks();
});

describe("TopNav wallet session controls", () => {
  it("shows the connected address instead of a separate authorize mode", () => {
    const props = { ...baseProps, walletReady: false };
    render(<TopNav {...props} />);

    expect(screen.getByRole("button", { name: /0xabcd/i })).toBeInTheDocument();
    expect(screen.queryByText("AUTHORIZE")).not.toBeInTheDocument();
  });

  it("locks private trading before disconnecting the Starknet wallet", () => {
    const props = { ...baseProps, onLock: vi.fn(), onDisconnectWallet: vi.fn() };
    setWalletRuntime({ getBalances: () => [] } as never);

    render(<TopNav {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /0xabcd/i }));
    fireEvent.click(screen.getByRole("button", { name: /Disconnect wallet/i }));

    expect(props.onLock).toHaveBeenCalledTimes(1);
    expect(props.onDisconnectWallet).toHaveBeenCalledTimes(1);
  });

  it("locks private trading before switching Starknet wallets", () => {
    const props = { ...baseProps, onLock: vi.fn(), onDisconnectWallet: vi.fn() };
    setWalletRuntime({ getBalances: () => [] } as never);

    render(<TopNav {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /0xabcd/i }));
    fireEvent.click(screen.getByRole("button", { name: "Switch wallet" }));

    expect(props.onLock).toHaveBeenCalledTimes(1);
    expect(props.onDisconnectWallet).toHaveBeenCalledTimes(1);
    expect(props.onOpenWallet).toHaveBeenCalledTimes(1);
  });
});
