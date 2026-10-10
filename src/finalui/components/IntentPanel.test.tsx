import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairConfig } from "../../domain/tradeIntent";
import { configureAssetDecimals } from "../../domain/assets";
import type { DeploymentConfig } from "../../domain/deployment";
import { IntentPanel } from "./IntentPanel";
import { failureFromCode } from "../../domain/userFacingErrors";

const pair: PairConfig = {
  pair_id: "STRK/USDC",
  base_asset_id: "STRK",
  quote_asset_id: "USDC",
  min_order_amount: "1",
  min_order_quote_amount: "1",
  price_base_scale: "1000000000000000000",
  taker_fee_bps: 2,
  external_match_enabled: true,
  external_settlement_support_quote: "1",
  enabled: true,
};

const commonProps = {
  pair,
  balances: [],
  referencePrice: {
    displayPrice: "0.05",
    midpointPrice: "50000",
    priceBaseScale: "1000000000000000000",
    observedAtUnixMs: Date.now(),
    validUntilUnixMs: Date.now() + 10_000,
  },
  online: true,
  submitting: false,
  submitError: null,
  onOpenWallet: vi.fn(),
  onDeposit: vi.fn(),
  onSubmit: vi.fn(),
};

beforeEach(() => {
  configureAssetDecimals({
    market_registry: {
      assets: [
        { asset_id: "STRK", decimals: 18 },
        { asset_id: "USDC", decimals: 6 },
      ],
    },
  } as unknown as DeploymentConfig);
});

afterEach(() => configureAssetDecimals(null));

describe("IntentPanel", () => {
  it("keeps the full sizing form visible while private balance controls are gated", () => {
    render(<IntentPanel {...commonProps} walletReady={false} />);

    expect(screen.getByText("Connect to view balance")).toBeInTheDocument();
    expect(screen.getByLabelText("Trade amount")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "25%" })).toBeDisabled();
  });

  it("uses the authenticated signed midpoint for both estimates and execution", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Trade amount"), {
      target: { value: "100" },
    });
    expect(screen.getByText("≈ 1,999.6")).toBeInTheDocument();
    expect(screen.getByLabelText("External matching")).not.toBeChecked();
    expect(screen.queryByText("Residual route")).not.toBeInTheDocument();
    expect(screen.queryByText("Unfilled amount")).not.toBeInTheDocument();
    expect(screen.getByText("Midpoint")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit order" }));
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "Buy",
        payAmount: "100",
        midpointPrice: "50000",
        priceBaseScale: "1000000000000000000",
        external: false,
      })
    );
  });

  it("opts into external matching only when the user checks the box", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
        onSubmit={onSubmit}
      />
    );

    fireEvent.change(screen.getByLabelText("Trade amount"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByLabelText("External matching"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit order" }));
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        external: true,
      })
    );
  });

  it("disables external opt-in when the market has no matcher capability", () => {
    render(
      <IntentPanel
        {...commonProps}
        pair={{ ...pair, external_match_enabled: false }}
        walletReady={false}
      />
    );

    expect(screen.getByLabelText("External matching")).toBeDisabled();
    expect(screen.queryByText("Residual route")).not.toBeInTheDocument();
  });

  it("requests a deposit for the selected side's exact pay asset", () => {
    const onDeposit = vi.fn();
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000", locked: "0" }]}
        walletReady
        onDeposit={onDeposit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));

    expect(onDeposit).toHaveBeenCalledWith("STRK");
  });

  it("does not treat funds locked in orders as spendable", () => {
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "0", locked: "1000000" }]}
        walletReady
      />,
    );

    expect(screen.getByRole("button", { name: "Deposit" })).toBeEnabled();
  });

  it("does not display a nonzero small receive amount as zero", () => {
    render(
      <IntentPanel
        {...commonProps}
        pair={{
          ...pair,
          pair_id: "STRK/ETH",
          quote_asset_id: "ETH",
        }}
        referencePrice={{
          displayPrice: "0.000015637",
          midpointPrice: "15637",
          priceBaseScale: "1000000000000000000",
          observedAtUnixMs: Date.now(),
          validUntilUnixMs: Date.now() + 10_000,
        }}
        walletReady={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sell" }));

    expect(screen.getByText("≈ 0.000015633873")).toBeInTheDocument();
  });

  it("does not reinterpret malformed pasted amounts", () => {
    render(<IntentPanel {...commonProps} walletReady={false} />);
    const input = screen.getByLabelText("Trade amount");
    const original = (input as HTMLInputElement).value;

    fireEvent.change(input, {
      target: { value: "1abc.2.3" },
    });

    expect(input).toHaveValue(original);
  });

  it("submits at most once while the first submission is unresolved", async () => {
    let finish: ((value: boolean) => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText("Trade amount"), { target: { value: "100" } });
    const submit = screen.getByRole("button", { name: "Submit order" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => finish?.(true));
  });

  it("does not resubmit while an earlier order outcome is unknown", async () => {
    const onSubmit = vi.fn();
    const onRefreshStatus = vi.fn();
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
        onSubmit={onSubmit}
        onRefreshStatus={onRefreshStatus}
        submitError={failureFromCode("TRANSACTION_STATUS_UNKNOWN", {
          domain: "order",
          stage: "order-submission",
        })}
      />
    );
    fireEvent.change(screen.getByLabelText("Trade amount"), {
      target: { value: "100" },
    });

    const button = screen.getByRole("button", { name: "Checking order status" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    });
    expect(onRefreshStatus).toHaveBeenCalledTimes(1);
  });

  it("shows exact available, required, and reserved balance context", () => {
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "25000000", locked: "10000000" }]}
        walletReady
      />,
    );

    fireEvent.change(screen.getByLabelText("Trade amount"), { target: { value: "40" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Insufficient USDC");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Available: 25 USDC. Required: 40 USDC. 10 USDC is reserved in open orders.",
    );
  });

  it("shows the exact asset precision limit", () => {
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
      />,
    );

    fireEvent.change(screen.getByLabelText("Trade amount"), {
      target: { value: "1.0000001" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "USDC supports up to 6 decimal places.",
    );
  });

  it("treats zero as an invalid amount instead of a precision error", () => {
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
      />,
    );

    fireEvent.change(screen.getByLabelText("Trade amount"), {
      target: { value: "0" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Enter an amount");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/decimal/i);
  });

  it("fails closed while the signed-price service is offline", () => {
    render(
      <IntentPanel
        {...commonProps}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
        online={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Trade amount"), { target: { value: "100" } });
    expect(screen.getByRole("button", { name: "Submit order" })).toBeDisabled();
  });

  it("rejects a pay amount that cannot meet the market's base-size minimum", () => {
    render(
      <IntentPanel
        {...commonProps}
        pair={{ ...pair, min_order_amount: "1000000000000000000000" }}
        balances={[{ asset: "USDC", available: "1000000000", locked: "0" }]}
        walletReady
      />,
    );
    fireEvent.change(screen.getByLabelText("Trade amount"), { target: { value: "1" } });
    expect(screen.getByRole("alert")).toHaveAttribute(
      "data-error-code",
      "BELOW_MINIMUM"
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Minimum: 50 USDC");
    expect(screen.getByRole("button", { name: "Submit order" })).toBeDisabled();
  });
});
