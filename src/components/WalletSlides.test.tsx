import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DepositSlide,
  WalletSlide,
  WithdrawSlide,
  privacyFundingStageLabel,
} from "./WalletSlides";
import { setWalletRuntime } from "../domain/browserWallet";

function DepositHarness() {
  const [asset, setAsset] = useState("STRK");
  return (
    <DepositSlide
      open
      onClose={vi.fn()}
      defaultAsset={asset}
      allAssets={["STRK", "USDC"]}
      starknetAddress="0xabc"
      walletReady
      onOpenWallet={vi.fn()}
      setSlideAsset={setAsset}
    />
  );
}

afterEach(() => {
  (window as typeof window & { starknet_ready?: unknown }).starknet_ready =
    undefined;
  setWalletRuntime(null);
});

describe("DepositSlide", () => {
  it("defaults to STRK for deposits", () => {
    render(<DepositHarness />);

    expect(screen.getByRole("combobox")).toHaveValue("STRK");
    expect(
      screen.getByRole("button", { name: "Deposit STRK" })
    ).toBeInTheDocument();
  });

  it("preserves the typed amount when switching the deposit asset", () => {
    render(<DepositHarness />);

    const amount = screen.getByPlaceholderText("0");
    fireEvent.change(amount, { target: { value: "2" } });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "USDC" },
    });

    expect(amount).toHaveValue("2");
    expect(
      screen.getByRole("button", { name: "Deposit USDC" })
    ).toBeInTheDocument();
  });

  it("submits the deposit when pressing Enter in the amount field", async () => {
    const submitDepositViaWallet = vi.fn().mockResolvedValue(undefined);
    setWalletRuntime({
      isReady: () => true,
      submitDepositViaWallet,
    } as never);
    render(<DepositHarness />);

    const amount = screen.getByPlaceholderText("0");
    fireEvent.change(amount, { target: { value: "2" } });
    fireEvent.keyDown(amount, { key: "Enter" });

    await waitFor(() => {
      expect(submitDepositViaWallet).toHaveBeenCalledWith(
        "STRK",
        "2000000000000000000"
      );
    });
  });

  it("authorizes trading inline before deposit submission", async () => {
    const onOpenWallet = vi.fn();
    let ready = false;
    const unlockWithWalletSignature = vi.fn(async () => {
      ready = true;
      return true;
    });
    const submitDepositViaWallet = vi.fn().mockResolvedValue(undefined);
    setWalletRuntime({
      isReady: () => ready,
      vaultAuthMode: () => "wallet-signature",
      unlockWithWalletSignature,
      submitDepositViaWallet,
    } as never);
    render(
      <DepositSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        allAssets={["STRK", "USDC"]}
        starknetAddress="0xabc"
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
      expect(submitDepositViaWallet).toHaveBeenCalledWith(
        "STRK",
        "2000000000000000000"
      );
    });
    expect(onOpenWallet).not.toHaveBeenCalled();
  });

  it("opens wallet setup from the deposit amount input when no Starknet wallet is connected", async () => {
    const onOpenWallet = vi.fn();
    let ready = false;
    const unlockWithWalletSignature = vi.fn(async () => {
      ready = true;
      return true;
    });
    const submitDepositViaWallet = vi.fn().mockResolvedValue(undefined);
    setWalletRuntime({
      isReady: () => ready,
      vaultAuthMode: () => "wallet-signature",
      unlockWithWalletSignature,
      submitDepositViaWallet,
    } as never);
    const { rerender } = render(
      <DepositSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        allAssets={["STRK", "USDC"]}
        starknetAddress={null}
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );

    const amount = screen.getByPlaceholderText("0");
    fireEvent.change(amount, { target: { value: "2" } });
    fireEvent.keyDown(amount, { key: "Enter" });
    expect(onOpenWallet).toHaveBeenCalledTimes(1);

    rerender(
      <DepositSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        allAssets={["STRK", "USDC"]}
        starknetAddress="0xabc"
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );
    fireEvent.keyDown(screen.getByPlaceholderText("0"), { key: "Enter" });
    expect(onOpenWallet).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
      expect(submitDepositViaWallet).toHaveBeenCalledWith(
        "STRK",
        "2000000000000000000"
      );
    });
  });

  it("opens wallet setup from the primary deposit button when disconnected", () => {
    const onOpenWallet = vi.fn();
    render(
      <DepositSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        allAssets={["STRK", "USDC"]}
        starknetAddress={null}
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Connect wallet to deposit" })
    );

    expect(onOpenWallet).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("Connect a Starknet wallet before depositing.")
    ).not.toBeInTheDocument();
  });

  it("formats private funding stages for the deposit progress line", () => {
    expect(
      privacyFundingStageLabel(
        "setup: funding deposit session from connected wallet"
      )
    ).toBe("Funding deposit session from connected wallet");
    expect(privacyFundingStageLabel("Private deposit proof failed")).toBe(
      "Deposit proof failed"
    );
  });
});

describe("WithdrawSlide", () => {
  it("authorizes trading inline before withdrawal submission", async () => {
    const onOpenWallet = vi.fn();
    let ready = false;
    const unlockWithWalletSignature = vi.fn(async () => {
      ready = true;
      return true;
    });
    const submitStrk20Withdrawal = vi.fn().mockResolvedValue(undefined);
    setWalletRuntime({
      isReady: () => ready,
      vaultAuthMode: () => "wallet-signature",
      unlockWithWalletSignature,
      strk20WithdrawalAvailable: () => true,
      getWithdrawableNotes: () => [
        {
          note_commitment: "0xnote",
          batch_id: "batch-1",
          source: "settlement_output",
          asset: "STRK",
          amount: "1000000000000000000",
          locked: false,
          spent: false,
        },
      ],
      submitStrk20Withdrawal,
    } as never);
    render(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        defaultNoteCommitment={null}
        settlementTranscripts={{
          "batch-1": {
            batch_id: "batch-1",
            pair_id: "STRK/USDC",
            batch_epoch: 1,
            clearing_price: "1",
            settled_at_unix_ms: Date.now() - 1_000,
          },
        }}
        claimDelaySeconds={0}
        allAssets={["STRK"]}
        starknetAddress="0xabc"
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Authorize withdrawals" }));
    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
      expect(submitStrk20Withdrawal).toHaveBeenCalledWith({
        note_commitment: "0xnote",
        batch_id: "batch-1",
      });
    });
    expect(onOpenWallet).not.toHaveBeenCalled();
  });

  it("requires a Starknet wallet before withdrawal signature setup", () => {
    const onOpenWallet = vi.fn();
    render(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        defaultNoteCommitment={null}
        settlementTranscripts={{}}
        claimDelaySeconds={30}
        allAssets={["STRK"]}
        starknetAddress={null}
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );

    expect(
      screen.getByText("Connect a Starknet wallet to withdraw.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(onOpenWallet).toHaveBeenCalled();
  });

  it("opens wallet setup from the primary withdraw button when disconnected", () => {
    const onOpenWallet = vi.fn();
    render(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        defaultNoteCommitment={null}
        settlementTranscripts={{}}
        claimDelaySeconds={30}
        allAssets={["STRK"]}
        starknetAddress={null}
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Connect wallet to withdraw" })
    );

    expect(onOpenWallet).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("Connect a Starknet wallet before withdrawing.")
    ).not.toBeInTheDocument();
  });

  it("opens wallet setup from the withdrawal note selector when no Starknet wallet is connected", async () => {
    const onOpenWallet = vi.fn();
    let ready = false;
    const unlockWithWalletSignature = vi.fn(async () => {
      ready = true;
      return true;
    });
    setWalletRuntime({
      isReady: () => ready,
      vaultAuthMode: () => "wallet-signature",
      unlockWithWalletSignature,
      strk20WithdrawalAvailable: () => true,
      getWithdrawableNotes: () => [],
    } as never);
    const { container, rerender } = render(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        defaultNoteCommitment={null}
        settlementTranscripts={{}}
        claimDelaySeconds={30}
        allAssets={["STRK"]}
        starknetAddress={null}
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.keyDown(container.querySelector(".slide-body")!, { key: "Enter" });
    expect(onOpenWallet).toHaveBeenCalledTimes(1);

    rerender(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        defaultNoteCommitment={null}
        settlementTranscripts={{}}
        claimDelaySeconds={30}
        allAssets={["STRK"]}
        starknetAddress="0xabc"
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );
    fireEvent.keyDown(container.querySelector(".slide-body")!, { key: "Enter" });
    expect(onOpenWallet).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
    });
  });
});

describe("WalletSlide", () => {
  it("does not expose recovery controls before Starknet connection", () => {
    render(
      <WalletSlide
        open
        onClose={vi.fn()}
        runtimeStatus="ready"
        hasVault
        starknetAddress={null}
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );

    expect(
      screen.queryByText("Recovery options")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Recover" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Starknet account")).toBeInTheDocument();
  });

  it("does not expose passphrase unlock after Starknet connection", () => {
    render(
      <WalletSlide
        open
        onClose={vi.fn()}
        runtimeStatus="ready"
        hasVault
        starknetAddress="0xabc"
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );

    expect(
      screen.queryByText("Connect a Starknet wallet first.")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Enter your passphrase")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Recovery options")).not.toBeInTheDocument();
    expect(screen.queryByText("Recover with phrase")).not.toBeInTheDocument();
  });

  it("auto-unlocks signature vaults without showing a passphrase field", async () => {
    const unlockWithWalletSignature = vi.fn().mockResolvedValue(true);
    setWalletRuntime({
      vaultAuthMode: () => "wallet-signature",
      unlockWithWalletSignature,
    } as never);
    const onClose = vi.fn();
    render(
      <WalletSlide
        open
        onClose={onClose}
        runtimeStatus="ready"
        hasVault
        starknetAddress="0xabc"
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );

    expect(
      screen.queryByPlaceholderText("Enter your passphrase")
    ).not.toBeInTheDocument();

    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("uses the selected wallet address when deciding whether to create or unlock", async () => {
    const unlockWithWalletSignature = vi.fn().mockResolvedValue(true);
    const createWalletWithWalletSignature = vi.fn().mockResolvedValue(true);
    setWalletRuntime({
      vaultAuthMode: (address?: string | null) =>
        address === "0xabc" ? "wallet-signature" : "none",
      isReady: () => false,
      unlockWithWalletSignature,
      createWalletWithWalletSignature,
    } as never);
    (window as typeof window & { starknet_ready?: unknown }).starknet_ready = {
      id: "ready",
      name: "Ready X",
      request: vi.fn(async ({ type }: { type?: string }) =>
        type === "wallet_requestAccounts" ? [{ address: "0xabc" }] : null
      ),
      account: { address: "0xabc" },
    };
    const onClose = vi.fn();
    render(
      <WalletSlide
        open
        onClose={onClose}
        runtimeStatus="ready"
        hasVault={false}
        starknetAddress={null}
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /Ready X/i }));

    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
      expect(createWalletWithWalletSignature).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("allows the same connected address to unlock again after the panel closes", async () => {
    const unlockWithWalletSignature = vi.fn().mockResolvedValue(true);
    setWalletRuntime({
      vaultAuthMode: () => "wallet-signature",
      isReady: () => false,
      unlockWithWalletSignature,
    } as never);
    const onClose = vi.fn();
    const { rerender } = render(
      <WalletSlide
        open
        onClose={onClose}
        runtimeStatus="ready"
        hasVault
        starknetAddress="0xabc"
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledTimes(1);
    });

    rerender(
      <WalletSlide
        open={false}
        onClose={onClose}
        runtimeStatus="ready"
        hasVault
        starknetAddress="0xabc"
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );
    rerender(
      <WalletSlide
        open
        onClose={onClose}
        runtimeStatus="ready"
        hasVault
        starknetAddress="0xabc"
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledTimes(2);
    });
  });

  it("falls back to fresh authorization after a stale vault unlock misses", async () => {
    const unlockWithWalletSignature = vi
      .fn()
      .mockResolvedValueOnce(false);
    const createWalletWithWalletSignature = vi.fn().mockResolvedValue(true);
    setWalletRuntime({
      vaultAuthMode: () => "wallet-signature",
      unlockWithWalletSignature,
      createWalletWithWalletSignature,
    } as never);
    const onClose = vi.fn();
    render(
      <WalletSlide
        open
        onClose={onClose}
        runtimeStatus="ready"
        hasVault
        starknetAddress="0xabc"
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledTimes(1);
      expect(createWalletWithWalletSignature).toHaveBeenCalledWith("0xabc");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("rescans and shows a Ready X provider injected after the panel opens", async () => {
    render(
      <WalletSlide
        open
        onClose={vi.fn()}
        runtimeStatus="ready"
        hasVault={false}
        starknetAddress={null}
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );

    expect(
      await screen.findByText("No Starknet wallet found")
    ).toBeInTheDocument();

    (window as typeof window & { starknet_ready?: unknown }).starknet_ready = {
      id: "ready",
      name: "Ready X",
      request: vi.fn(async () => null),
    };

    fireEvent.click(screen.getByRole("button", { name: "Scan wallets" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Ready X/i })
      ).toBeInTheDocument();
    });
  });

  it("locks private trading when changing or disconnecting the Starknet wallet", () => {
    const lock = vi.fn();
    const onStarknetDisconnected = vi.fn();
    setWalletRuntime({ lock } as never);
    render(
      <WalletSlide
        open
        onClose={vi.fn()}
        runtimeStatus="loading"
        hasVault={false}
        starknetAddress="0xabc"
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={onStarknetDisconnected}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Change wallet" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(lock).toHaveBeenCalledTimes(2);
    expect(onStarknetDisconnected).toHaveBeenCalledTimes(2);
  });
});
