import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

function Broken(): never {
  throw new Error("render failed");
}

describe("AppErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("renders a usable recovery action when the application throws", () => {
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("Zylith could not load.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeEnabled();
  });

  it("requests a page reload from the recovery action", () => {
    const reload = vi.fn();
    render(<AppErrorBoundary reload={reload}><Broken /></AppErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
