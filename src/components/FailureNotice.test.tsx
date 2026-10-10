import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { failureFromCode } from "../domain/userFacingErrors";
import { FailureNotice } from "./FailureNotice";

describe("FailureNotice", () => {
  it("renders the requested surface and runs its verified recovery action", async () => {
    const checkStatus = vi.fn().mockResolvedValue(undefined);
    render(
      <FailureNotice
        failure={failureFromCode("DEPOSIT_STATUS_UNKNOWN")}
        actions={{ checkStatus }}
      />,
    );

    const status = screen.getByRole("alert");
    expect(status).toHaveAttribute("data-presentation", "status-screen");
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(checkStatus).toHaveBeenCalledTimes(1));
  });

  it("never exposes a retry action when replay is not proven safe", () => {
    const retry = vi.fn();
    const failure = {
      ...failureFromCode("DEPOSIT_STATUS_UNKNOWN"),
      recovery: "retry" as const,
      retrySafe: false,
    };
    render(<FailureNotice failure={failure} actions={{ retry }} />);

    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("uses a neutral status surface for wallet cancellation", async () => {
    const dismiss = vi.fn();
    render(
      <FailureNotice
        failure={failureFromCode("WALLET_REQUEST_CANCELLED")}
        actions={{ dismiss }}
      />,
    );

    expect(screen.getByRole("status")).toHaveAttribute("data-presentation", "toast");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
  });

  it("portals privacy-critical blockers as modal dialogs", async () => {
    const editInput = vi.fn();
    render(
      <FailureNotice
        failure={failureFromCode("PRIVACY_SAFETY_BLOCK")}
        actions={{ editInput }}
      />,
    );

    expect(screen.getByRole("alertdialog")).toHaveAttribute("aria-modal", "true");
    fireEvent.click(screen.getByRole("button", { name: "Edit amount" }));
    await waitFor(() => expect(editInput).toHaveBeenCalledTimes(1));
  });

  it("does not invent an action when the owning flow supplies none", () => {
    render(<FailureNotice failure={failureFromCode("DEPOSIT_UNAVAILABLE")} />);

    expect(screen.getByRole("alert")).toHaveAttribute("data-presentation", "banner");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("contains recovery-action failures instead of crashing the flow", async () => {
    render(
      <FailureNotice
        failure={failureFromCode("NETWORK_REQUEST_FAILED")}
        actions={{ retry: vi.fn().mockRejectedValue(new Error("offline")) }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("That action could not be completed. Try again."))
      .toBeInTheDocument();
  });

  it("does not report support details as copied when clipboard access fails", async () => {
    render(
      <FailureNotice
        failure={failureFromCode("PRIVATE_STATE_DAMAGED")}
        actions={{ contactSupport: vi.fn().mockRejectedValue(new Error("clipboard denied")) }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy support details" }));
    expect(await screen.findByText("That action could not be completed. Try again."))
      .toBeInTheDocument();
    expect(screen.queryByText("Support details copied")).not.toBeInTheDocument();
  });

  it("lets Escape dismiss a blocking modal", async () => {
    const dismiss = vi.fn();
    render(
      <FailureNotice
        failure={failureFromCode("PRIVACY_SAFETY_BLOCK")}
        actions={{ editInput: vi.fn(), dismiss }}
      />,
    );

    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
  });
});
