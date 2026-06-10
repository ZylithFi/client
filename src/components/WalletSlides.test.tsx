import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepositSlide, WalletSlide, privacyFundingStageLabel } from "./WalletSlides";

const legacyReadyKey = `starknet_${["arg", "ent"].join("")}X`;

function DepositHarness() {
  const [asset, setAsset] = useState("STRK");
  return (
    <DepositSlide
      open
      onClose={vi.fn()}
      defaultAsset={asset}
      allAssets={["STRK", "USDC"]}
      starknetAddress="0xabc"
      onOpenWallet={vi.fn()}
      setSlideAsset={setAsset}
    />
  );
}

afterEach(() => {
  (window as typeof window & { starknet_ready?: unknown }).starknet_ready = undefined;
  delete (window as unknown as Record<string, unknown>)[legacyReadyKey];
});

describe("DepositSlide", () => {
  it("defaults to STRK for deposits", () => {
    render(<DepositHarness />);

    expect(screen.getByRole("combobox")).toHaveValue("STRK");
    expect(screen.getByRole("button", { name: "Deposit STRK" })).toBeInTheDocument();
  });

  it("preserves the typed amount when switching the deposit asset", () => {
    render(<DepositHarness />);

    const amount = screen.getByPlaceholderText("0");
    fireEvent.change(amount, { target: { value: "2" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "USDC" } });

    expect(amount).toHaveValue("2");
    expect(screen.getByRole("button", { name: "Deposit USDC" })).toBeInTheDocument();
  });

  it("formats private funding stages for the deposit progress line", () => {
    expect(privacyFundingStageLabel("setup: funding embedded signer from connected wallet")).toBe(
      "Funding embedded signer from connected wallet",
    );
    expect(privacyFundingStageLabel("Private deposit proof failed")).toBe("Deposit proof failed");
  });
});

describe("WalletSlide", () => {
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

    expect(await screen.findByText("No Starknet wallet found")).toBeInTheDocument();

    (window as unknown as Record<string, unknown>)[legacyReadyKey] = {
      id: "legacy-ready",
      name: "Legacy wallet",
      request: vi.fn(async () => null),
    };

    fireEvent.click(screen.getByRole("button", { name: "Scan wallets" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Ready X/i })).toBeInTheDocument();
    });
  });
});
