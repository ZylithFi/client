import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DepositSlide } from "./WalletSlides";

function DepositHarness() {
  const [asset, setAsset] = useState("USDC");
  return (
    <DepositSlide
      open
      onClose={vi.fn()}
      defaultAsset={asset}
      allAssets={["USDC", "STRK"]}
      starknetAddress="0xabc"
      onOpenWallet={vi.fn()}
      setSlideAsset={setAsset}
    />
  );
}

describe("DepositSlide", () => {
  it("preserves the typed amount when switching the deposit asset", () => {
    render(<DepositHarness />);

    const amount = screen.getByPlaceholderText("0");
    fireEvent.change(amount, { target: { value: "2" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "STRK" } });

    expect(amount).toHaveValue("2");
    expect(screen.getByRole("button", { name: "Deposit STRK" })).toBeInTheDocument();
  });
});
