import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader";

describe("AppHeader", () => {
  it("uses Connect wallet until the private wallet is ready", () => {
    const onWallet = vi.fn();
    render(
      <AppHeader
        activePage="trade"
        starknetAddress="0x1234567890"
        walletReady={false}
        onNavigate={() => undefined}
        onWallet={onWallet}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(onWallet).toHaveBeenCalledOnce();
    expect(screen.queryByText("Authorize trading")).not.toBeInTheDocument();
  });
});
