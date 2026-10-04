import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { setWalletRuntime } from "../domain/browserWallet";
import { useWalletState } from "./useWalletState";

function WalletStateProbe({ address, testId }: { address: string; testId: string }) {
  const state = useWalletState(address);
  return (
    <div data-testid={testId}>
      {`${state.runtimeStatus}:${state.walletReady}:${state.hasVault}`}
    </div>
  );
}

describe("useWalletState", () => {
  afterEach(() => setWalletRuntime(null));

  it("keeps concurrent snapshots stable and isolated by address", () => {
    setWalletRuntime({
      isReady: (address: string | null) => address === "0x1",
      hasVault: (address: string | null) => address === "0x2",
    } as never);

    render(
      <>
        <WalletStateProbe address="0x1" testId="first" />
        <WalletStateProbe address="0x2" testId="second" />
      </>,
    );

    expect(screen.getByTestId("first")).toHaveTextContent("ready:true:false");
    expect(screen.getByTestId("second")).toHaveTextContent("ready:false:true");
  });
});
