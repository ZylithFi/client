import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import exampleDeployment from "../../public/deployment.example.json";
import {
  DepositSlide,
  WalletSlide,
  WithdrawSlide,
  privacyFundingStageLabel,
} from "./WalletSlides";
import {
  clearSelectedStarknetProvider,
  connectStarknetProvider,
  setWalletRuntime,
} from "../domain/browserWallet";

vi.mock("../domain/deployment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../domain/deployment")>()),
  loadDeployment: vi.fn().mockResolvedValue(exampleDeployment),
}));

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

beforeEach(async () => {
  const provider = {
    account: { address: "0xabc" },
    request: vi.fn(async ({ type, method }: { type?: string; method?: string }) => {
      if (type === "wallet_requestAccounts") return [{ address: "0xabc" }];
      if (type === "wallet_requestChainId" || method === "wallet_requestChainId") {
        return "0x534e5f5345504f4c4941";
      }
      if (type === "wallet_supportedWalletApi") return ["0.10.4"];
      return null;
    }),
  };
  await connectStarknetProvider(provider as never, "test-wallet");
});

afterEach(() => {
  (window as typeof window & { starknet_ready?: unknown }).starknet_ready =
    undefined;
  clearSelectedStarknetProvider();
  setWalletRuntime(null);
});

describe("DepositSlide", () => {
  it("defaults to STRK for deposits", () => {
    render(<DepositHarness />);

    expect(screen.getByRole("combobox", { name: "Asset" })).toHaveValue("STRK");
    expect(
      screen.getByRole("button", { name: "Deposit STRK" })
    ).toBeInTheDocument();
  });

  it("blocks a new deposit while an earlier deposit is unresolved", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    setWalletRuntime({
      refresh,
      getPendingDeposits: () => [{
        note_commitment: "0xpending",
        asset: "STRK",
        amount: "1000000000000000000",
        requested_at_unix_ms: Date.now(),
        confirmed: false,
        failed: false,
      }],
    } as never);

    render(<DepositHarness />);

    expect(screen.getByRole("status")).toHaveAttribute(
      "data-error-code",
      "DEPOSIT_PENDING"
    );
    expect(screen.getByRole("button", { name: "Checking deposit status" }))
      .toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("checks private-wallet support without blocking ordinary wallet connection", async () => {
    const request = vi.fn(async ({ type }: { type: string }) => {
      if (type === "wallet_requestAccounts") return [{ address: "0xabc" }];
      if (type === "wallet_supportedWalletApi") return ["0.10.2"];
      throw new Error("unexpected wallet request");
    });
    await connectStarknetProvider({ request } as never, "standard-wallet");

    render(<DepositHarness />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/unsupported wallet/i);
      expect(screen.getByRole("button", { name: "Deposit STRK" })).toBeDisabled();
    });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "wallet_strk20Balances",
    }));
  });

  it("preserves the typed amount when switching the deposit asset", () => {
    render(<DepositHarness />);

    const amount = screen.getByPlaceholderText("0");
    fireEvent.change(amount, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Asset" }));
    fireEvent.click(screen.getByRole("option", { name: "USDC" }));

    expect(amount).toHaveValue("2");
    expect(
      screen.getByRole("button", { name: "Deposit USDC" })
    ).toBeInTheDocument();
  });

  it("closes the asset menu when the amount field receives focus", () => {
    render(<DepositHarness />);

    fireEvent.click(screen.getByRole("combobox", { name: "Asset" }));
    expect(screen.getByRole("listbox", { name: "Assets" })).toBeInTheDocument();

    fireEvent.focus(screen.getByPlaceholderText("0"));

    expect(
      screen.queryByRole("listbox", { name: "Assets" })
    ).not.toBeInTheDocument();
  });

  it("removes portalled asset options and makes the panel inert when closed", async () => {
    const props = {
      onClose: vi.fn(),
      defaultAsset: "STRK",
      allAssets: ["STRK", "USDC"],
      starknetAddress: "0xabc",
      walletReady: true,
      onOpenWallet: vi.fn(),
      setSlideAsset: vi.fn(),
    };
    const { rerender } = render(<DepositSlide open {...props} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Asset" }));
    expect(screen.getByRole("listbox", { name: "Assets" })).toBeInTheDocument();

    rerender(<DepositSlide open={false} {...props} />);

    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Assets" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { hidden: true })).toHaveProperty("inert", true);
    });
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

  it("renders ambiguous deposit failures as non-retryable status checks", async () => {
    setWalletRuntime({
      isReady: () => true,
      submitDepositViaWallet: vi.fn().mockRejectedValue(new Error("deposit failed")),
    } as never);
    render(<DepositHarness />);

    fireEvent.change(screen.getByPlaceholderText("0"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-error-code", "DEPOSIT_STATUS_UNKNOWN");
    expect(alert).toHaveAttribute("data-recovery", "check-status");
    expect(alert).toHaveAttribute("data-retry-safe", "false");
  });

  it("clears an ambiguous deposit blocker only after durable status reconciles", async () => {
    let pending = false;
    const runtime = {
      isReady: () => true,
      getPendingDeposits: () => pending ? [{
        note_commitment: "0xpending",
        asset: "STRK",
        amount: "2000000000000000000",
        requested_at_unix_ms: Date.now(),
        confirmed: false,
        failed: false,
      }] : [],
      submitDepositViaWallet: vi.fn(async () => {
        pending = true;
        throw new Error("deposit acknowledgement was lost");
      }),
    };
    setWalletRuntime(runtime as never);
    const props = {
      onClose: vi.fn(),
      defaultAsset: "STRK",
      allAssets: ["STRK"],
      starknetAddress: "0xabc",
      walletReady: true,
      onOpenWallet: vi.fn(),
      setSlideAsset: vi.fn(),
    };
    const { rerender } = render(<DepositSlide open {...props} />);
    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    expect(await screen.findByRole("alert")).toHaveAttribute(
      "data-error-code",
      "DEPOSIT_STATUS_UNKNOWN"
    );
    expect(screen.getByRole("button", { name: "Checking deposit status" })).toBeDisabled();

    pending = false;
    rerender(<DepositSlide open {...props} />);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Deposit STRK" })).toBeEnabled();
  });

  it("keeps a confirmed public transfer blocked until private credit arrives", () => {
    setWalletRuntime({
      isReady: () => true,
      getPendingDeposits: () => [{
        note_commitment: "0xpending",
        asset: "STRK",
        amount: "2000000000000000000",
        transaction_hash: "0x123",
        public_transaction_confirmed: true,
        requested_at_unix_ms: Date.now() - 60_000,
        confirmed: false,
        failed: false,
      }],
    } as never);

    render(<DepositHarness />);

    expect(screen.getByRole("status")).toHaveAttribute(
      "data-error-code",
      "DEPOSIT_CREDIT_PENDING",
    );
    expect(screen.getByText(/public funding is confirmed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checking deposit status" })).toBeDisabled();
  });

  it("fails closed and disables deposits for incompatible proof configuration", async () => {
    setWalletRuntime({
      isReady: () => true,
      getPendingDeposits: () => [],
      submitDepositViaWallet: vi.fn().mockRejectedValue(
        new Error("PROOF_VERSION_NOT_ALLOWED")
      ),
    } as never);
    render(<DepositHarness />);

    fireEvent.change(screen.getByPlaceholderText("0"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-error-code", "PROOF_VERSION_INCOMPATIBLE");
    expect(screen.getByRole("button", { name: "Deposit unavailable" }))
      .toBeDisabled();
  });

  it("requires changing a privacy-blocked amount before it can be submitted again", async () => {
    const submitDepositViaWallet = vi.fn().mockRejectedValue(
      new Error("Private deposit privacy warning: USER_LINKAGE"),
    );
    setWalletRuntime({
      isReady: () => true,
      getPendingDeposits: () => [],
      submitDepositViaWallet,
    } as never);
    render(<DepositHarness />);

    const amount = screen.getByPlaceholderText("0");
    fireEvent.change(amount, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    expect(await screen.findByRole("alertdialog")).toHaveAttribute(
      "data-error-code",
      "PRIVACY_SAFETY_BLOCK",
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit amount" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Deposit STRK" })).toBeDisabled();

    fireEvent.change(amount, { target: { value: "3" } });
    expect(screen.getByRole("button", { name: "Deposit STRK" })).toBeEnabled();
  });

  it("does not offer retry while deposit infrastructure is unavailable", async () => {
    setWalletRuntime({
      isReady: () => true,
      getPendingDeposits: () => [],
      submitDepositViaWallet: vi.fn().mockRejectedValue(
        new Error("Private deposit service is unavailable")
      ),
    } as never);
    render(<DepositHarness />);

    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    expect(await screen.findByRole("alert")).toHaveAttribute(
      "data-error-code",
      "DEPOSIT_UNAVAILABLE"
    );
    expect(screen.getByRole("button", { name: "Deposit unavailable" })).toBeDisabled();
  });

  it("treats wallet rejection as cancellation and allows a later fresh attempt", async () => {
    setWalletRuntime({
      isReady: () => true,
      getPendingDeposits: () => [],
      submitDepositViaWallet: vi.fn().mockRejectedValue(
        new Error("User rejected the request")
      ),
    } as never);
    render(<DepositHarness />);

    fireEvent.change(screen.getByPlaceholderText("0"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    expect(await screen.findByRole("status")).toHaveAttribute(
      "data-error-code",
      "WALLET_REQUEST_CANCELLED"
    );
    expect(screen.getByRole("button", { name: "Deposit STRK" })).toBeEnabled();
  });

  it("switches networks on explicit deposit intent without submitting on the same click", async () => {
    let chainId = "0x1";
    const request = vi.fn(async ({ type, method }: { type?: string; method?: string }) => {
      if (type === "wallet_requestAccounts") return [{ address: "0xabc" }];
      if (type === "wallet_supportedWalletApi") return ["0.10.4"];
      if (type === "wallet_requestChainId" || method === "wallet_requestChainId") return chainId;
      if (type === "wallet_switchStarknetChain") {
        chainId = exampleDeployment.chain_id;
        return true;
      }
      return null;
    });
    await connectStarknetProvider({ account: { address: "0xabc" }, request } as never, "switching-wallet");
    const submitDepositViaWallet = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue(undefined);
    setWalletRuntime({
      isReady: () => true,
      getPendingDeposits: () => [],
      submitDepositViaWallet,
      refresh,
    } as never);
    render(<DepositHarness />);

    const amount = screen.getByPlaceholderText("0");
    fireEvent.change(amount, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({
      type: "wallet_switchStarknetChain",
    })));
    expect(submitDepositViaWallet).not.toHaveBeenCalled();
    expect(amount).toHaveValue("2");

    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));
    await waitFor(() => expect(submitDepositViaWallet).toHaveBeenCalledTimes(1));
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

    fireEvent.change(screen.getByPlaceholderText("0"), {
      target: { value: "2" },
    });
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

  it("silently unlocks a remembered device session before depositing", async () => {
    let ready = false;
    const unlockWithDeviceSession = vi.fn(async () => {
      ready = true;
      return true;
    });
    const unlockWithWalletSignature = vi.fn();
    const submitDepositViaWallet = vi.fn().mockResolvedValue(undefined);
    setWalletRuntime({
      isReady: () => ready,
      hasVault: () => true,
      vaultAuthMode: () => "device-session",
      unlockWithDeviceSession,
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
        onOpenWallet={vi.fn()}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("0"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    await waitFor(() => {
      expect(unlockWithDeviceSession).toHaveBeenCalledWith("0xabc");
      expect(unlockWithWalletSignature).not.toHaveBeenCalled();
      expect(submitDepositViaWallet).toHaveBeenCalled();
    });
  });

  it("falls back to wallet reauthorization when the device session cannot open", async () => {
    let ready = false;
    const unlockWithDeviceSession = vi.fn().mockResolvedValue(false);
    const unlockWithWalletSignature = vi.fn(async () => {
      ready = true;
      return true;
    });
    const submitDepositViaWallet = vi.fn().mockResolvedValue(undefined);
    setWalletRuntime({
      isReady: () => ready,
      hasVault: () => true,
      vaultAuthMode: () => "device-session",
      unlockWithDeviceSession,
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
        onOpenWallet={vi.fn()}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("0"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));

    await waitFor(() => {
      expect(unlockWithDeviceSession).toHaveBeenCalledWith("0xabc");
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
      expect(submitDepositViaWallet).toHaveBeenCalled();
    });
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

  it("does not close a newly reopened deposit panel when an older deposit finishes", async () => {
    let finishDeposit!: () => void;
    const submitDepositViaWallet = vi.fn(() => new Promise<void>((resolve) => {
      finishDeposit = resolve;
    }));
    setWalletRuntime({ isReady: () => true, submitDepositViaWallet } as never);
    const onClose = vi.fn();
    const props = {
      onClose,
      defaultAsset: "STRK",
      allAssets: ["STRK"],
      starknetAddress: "0xabc",
      walletReady: true,
      onOpenWallet: vi.fn(),
      setSlideAsset: vi.fn(),
    };
    const { rerender } = render(<DepositSlide open {...props} />);
    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit STRK" }));
    await waitFor(() => expect(submitDepositViaWallet).toHaveBeenCalled());

    rerender(<DepositSlide open={false} {...props} />);
    rerender(<DepositSlide open {...props} />);
    finishDeposit();

    await waitFor(() => expect(submitDepositViaWallet).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("WithdrawSlide", () => {
  it("clears an ambiguous withdrawal blocker only after durable status reconciles", async () => {
    const note = {
      note_commitment: "0xnote",
      source: "output" as const,
      asset: "STRK",
      amount: "1000000000000000000",
      locked: false,
      spent: false,
      exit_stage: undefined as "requested" | "finalized" | undefined,
    };
    const unrelated = {
      ...note,
      note_commitment: "0xunrelated",
      amount: "2000000000000000000",
      locked: true,
      exit_stage: "requested" as const,
    };
    const withdraw = vi.fn(async () => {
      note.locked = true;
      note.exit_stage = "requested";
      throw new Error("withdrawal acknowledgement was lost");
    });
    setWalletRuntime({
      isReady: () => true,
      withdrawalAvailable: () => true,
      getWithdrawableNotes: () => [note, unrelated],
      withdraw,
    } as never);
    const props = {
      onClose: vi.fn(),
      defaultAsset: "STRK",
      allAssets: ["STRK"],
      starknetAddress: "0xabc",
      walletReady: true,
      onOpenWallet: vi.fn(),
      setSlideAsset: vi.fn(),
    };
    const { rerender } = render(<WithdrawSlide open {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw 1 STRK" }));

    expect(await screen.findByRole("alert")).toHaveAttribute(
      "data-error-code",
      "WITHDRAWAL_STATUS_UNKNOWN"
    );
    expect(screen.getByRole("button", { name: "Withdrawal unavailable" })).toBeDisabled();

    note.exit_stage = "finalized";
    rerender(<WithdrawSlide open {...props} />);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Receive privately" })).toBeEnabled();
  });

  it("requires an explicit action before receiving a matured exit privately", async () => {
    const claimWithdrawal = vi.fn().mockResolvedValue({ transaction_hash: "0x1" });
    setWalletRuntime({
      isReady: () => true,
      withdrawalAvailable: () => true,
      getWithdrawableNotes: () => [
        {
          note_commitment: "0xnote",
          source: "output",
          asset: "STRK",
          amount: "1000000000000000000",
          locked: true,
          spent: false,
          exit_stage: "finalized",
        },
      ],
      claimWithdrawal,
    } as never);

    render(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        allAssets={["STRK"]}
        starknetAddress="0xabc"
        walletReady
        onOpenWallet={vi.fn()}
        setSlideAsset={vi.fn()}
      />
    );

    expect(claimWithdrawal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Receive privately" }));
    await waitFor(() => expect(claimWithdrawal).toHaveBeenCalledWith("0xnote"));
  });

  it("never substitutes a different note if the displayed note becomes unavailable", async () => {
    let notes = [{
      note_commitment: "0xfirst",
      source: "output" as const,
      asset: "STRK",
      amount: "1000000000000000000",
      locked: false,
      spent: false,
    }];
    const withdraw = vi.fn();
    setWalletRuntime({
      isReady: () => true,
      vaultAuthMode: () => "wallet-signature",
      withdrawalAvailable: () => true,
      getWithdrawableNotes: () => notes,
      withdraw,
    } as never);

    render(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        allAssets={["STRK"]}
        starknetAddress="0xabc"
        walletReady
        onOpenWallet={vi.fn()}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Withdraw 1 STRK" }));
    notes = [{ ...notes[0], note_commitment: "0xsecond", amount: "2000000000000000000" }];
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/balance changed/i));
    expect(screen.getByRole("alert")).toHaveAttribute("data-recovery", "refresh-state");
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("authorizes trading without starting an unseen withdrawal", async () => {
    const onOpenWallet = vi.fn();
    let ready = false;
    const unlockWithWalletSignature = vi.fn(async () => {
      ready = true;
      return true;
    });
    const withdraw = vi.fn().mockResolvedValue({ nullifier: "0x1" });
    setWalletRuntime({
      isReady: () => ready,
      vaultAuthMode: () => "wallet-signature",
      unlockWithWalletSignature,
      withdrawalAvailable: () => true,
      getWithdrawableNotes: () => [
        {
          note_commitment: "0xnote",
          source: "output",
          asset: "STRK",
          amount: "1000000000000000000",
          locked: false,
          spent: false,
        },
      ],
      withdraw,
    } as never);
    render(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        allAssets={["STRK"]}
        starknetAddress="0xabc"
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Unlock private balance" })
    );
    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
      expect(withdraw).not.toHaveBeenCalled();
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
      withdrawalAvailable: () => true,
      getWithdrawableNotes: () => [],
    } as never);
    const { container, rerender } = render(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        allAssets={["STRK"]}
        starknetAddress={null}
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );

    fireEvent.keyDown(container.querySelector(".slide-body")!, {
      key: "Enter",
    });
    expect(onOpenWallet).toHaveBeenCalledTimes(1);

    rerender(
      <WithdrawSlide
        open
        onClose={vi.fn()}
        defaultAsset="STRK"
        allAssets={["STRK"]}
        starknetAddress="0xabc"
        walletReady={false}
        onOpenWallet={onOpenWallet}
        setSlideAsset={vi.fn()}
      />
    );
    fireEvent.keyDown(container.querySelector(".slide-body")!, {
      key: "Enter",
    });
    expect(onOpenWallet).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
    });
  });

  it("does not close a newly reopened withdrawal panel when an older withdrawal finishes", async () => {
    let finishWithdrawal!: () => void;
    const withdraw = vi.fn(() => new Promise<{ nullifier: string }>((resolve) => {
      finishWithdrawal = () => resolve({ nullifier: "0x1" });
    }));
    setWalletRuntime({
      isReady: () => true,
      withdrawalAvailable: () => true,
      getWithdrawableNotes: () => [{
        note_commitment: "0x10",
        source: "output",
        asset: "STRK",
        amount: "1",
        locked: false,
        spent: false,
      }],
      withdraw,
    } as never);
    const onClose = vi.fn();
    const props = {
      onClose,
      defaultAsset: "STRK",
      allAssets: ["STRK"],
      starknetAddress: "0xabc",
      walletReady: true,
      onOpenWallet: vi.fn(),
      setSlideAsset: vi.fn(),
    };
    const { rerender } = render(<WithdrawSlide open {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw 0.000000000000000001 STRK" }));
    await waitFor(() => expect(withdraw).toHaveBeenCalled());

    rerender(<WithdrawSlide open={false} {...props} />);
    rerender(<WithdrawSlide open {...props} />);
    finishWithdrawal();

    await waitFor(() => expect(withdraw).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("WalletSlide", () => {
  it("closes on Escape and does not finish into a different panel", async () => {
    let finishAuthorization!: (value: boolean) => void;
    let ready = false;
    const unlockWithWalletSignature = vi.fn(() => new Promise<boolean>((resolve) => {
      finishAuthorization = (value) => {
        ready = value;
        resolve(value);
      };
    }));
    setWalletRuntime({
      vaultAuthMode: () => "wallet-signature",
      isReady: () => ready,
      unlockWithWalletSignature,
    } as never);
    const onClose = vi.fn();
    const props = {
      onClose,
      runtimeStatus: "ready" as const,
      hasVault: true,
      starknetAddress: "0xabc",
      onStarknetConnected: vi.fn(),
      onStarknetDisconnected: vi.fn(),
    };
    const { rerender } = render(<WalletSlide open {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Unlock private balance" }));
    await waitFor(() => expect(unlockWithWalletSignature).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<WalletSlide open={false} {...props} />);
    finishAuthorization(true);
    await waitFor(() => expect(ready).toBe(true));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not expose recovery controls before Starknet connection", () => {
    const onStarknetConnected = vi.fn();
    const { rerender } = render(
      <WalletSlide
        open
        onClose={vi.fn()}
        runtimeStatus="ready"
        hasVault
        starknetAddress={null}
        onStarknetConnected={onStarknetConnected}
        onStarknetDisconnected={vi.fn()}
      />
    );

    expect(screen.queryByText("Recovery options")).not.toBeInTheDocument();
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

  it("unlocks signature vaults only after an explicit action", async () => {
    let ready = false;
    const unlockWithWalletSignature = vi.fn(async () => {
      ready = true;
      return true;
    });
    setWalletRuntime({
      vaultAuthMode: () => "wallet-signature",
      isReady: () => ready,
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
    expect(unlockWithWalletSignature).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock private balance" }));

    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledWith("0xabc");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("uses the selected wallet address when deciding whether to create or unlock", async () => {
    let ready = false;
    const unlockWithWalletSignature = vi.fn(async () => {
      ready = true;
      return true;
    });
    const createWalletWithWalletSignature = vi.fn().mockResolvedValue(true);
    setWalletRuntime({
      vaultAuthMode: (address?: string | null) =>
        address === "0xabc" ? "wallet-signature" : "none",
      isReady: () => ready,
      unlockWithWalletSignature,
      createWalletWithWalletSignature,
    } as never);
    (window as typeof window & { starknet_ready?: unknown }).starknet_ready = {
      id: "ready",
      name: "Ready",
      request: vi.fn(async ({ type, method }: { type?: string; method?: string }) =>
        type === "wallet_supportedWalletApi"
          ? ["0.10.4"]
          : type === "wallet_requestAccounts"
            ? [{ address: "0xabc" }]
            : type === "wallet_requestChainId" || method === "wallet_requestChainId"
              ? "0x534e5f5345504f4c4941"
            : null
      ),
      account: { address: "0xabc" },
    };
    const onClose = vi.fn();
    const onStarknetConnected = vi.fn();
    const { rerender } = render(
      <WalletSlide
        open
        onClose={onClose}
        runtimeStatus="ready"
        hasVault={false}
        starknetAddress={null}
        onStarknetConnected={onStarknetConnected}
        onStarknetDisconnected={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /Ready/i }));
    await waitFor(() => expect(onStarknetConnected).toHaveBeenCalledWith("0xabc"));
    rerender(
      <WalletSlide
        open
        onClose={onClose}
        runtimeStatus="ready"
        hasVault={false}
        starknetAddress="0xabc"
        onStarknetConnected={onStarknetConnected}
        onStarknetDisconnected={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Unlock private balance" })).toBeEnabled());
    expect(unlockWithWalletSignature).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock private balance" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Unlock private balance" }));
    await waitFor(() => expect(unlockWithWalletSignature).toHaveBeenCalledTimes(1));

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

    fireEvent.click(screen.getByRole("button", { name: "Unlock private balance" }));
    await waitFor(() => expect(unlockWithWalletSignature).toHaveBeenCalledTimes(2));
  });

  it("does not replace an existing private account when vault unlock misses", async () => {
    const unlockWithWalletSignature = vi.fn().mockResolvedValueOnce(false);
    const createWalletWithWalletSignature = vi.fn().mockResolvedValue(true);
    setWalletRuntime({
      vaultAuthMode: () => "wallet-signature",
      isReady: () => false,
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

    fireEvent.click(screen.getByRole("button", { name: "Unlock private balance" }));
    await waitFor(() => {
      expect(unlockWithWalletSignature).toHaveBeenCalledTimes(1);
      expect(createWalletWithWalletSignature).not.toHaveBeenCalled();
      expect(screen.getAllByText("Reconnect wallet")).toHaveLength(2);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when private authorization does not become ready", async () => {
    setWalletRuntime({
      vaultAuthMode: () => "none",
      isReady: () => false,
      createWalletWithWalletSignature: vi.fn().mockResolvedValue(false),
    } as never);
    const onClose = vi.fn();
    render(
      <WalletSlide
        open
        onClose={onClose}
        runtimeStatus="ready"
        hasVault={false}
        starknetAddress="0xabc"
        onStarknetConnected={vi.fn()}
        onStarknetDisconnected={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Enable private trading" }));
    await waitFor(() => {
      expect(screen.getAllByText("Reconnect wallet")).toHaveLength(2);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rescans and shows a Ready provider injected after the panel opens", async () => {
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
      name: "Ready",
      request: vi.fn(async () => null),
    };

    fireEvent.click(screen.getByRole("button", { name: "Scan wallets" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Ready/i })
      ).toBeInTheDocument();
    });
  });

  it("locks private trading when changing or disconnecting the Starknet wallet", () => {
    const lock = vi.fn();
    const suspend = vi.fn();
    const onStarknetDisconnected = vi.fn();
    setWalletRuntime({ lock, suspend } as never);
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

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(onStarknetDisconnected).toHaveBeenCalledTimes(2);
  });
});
