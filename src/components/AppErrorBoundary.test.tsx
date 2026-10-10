import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

function Broken(): never {
  throw new Error("private-order=buy-1000; signature=0xdeadbeef");
}

describe("AppErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("renders a usable recovery action when the application throws", () => {
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("Zylith could not load");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private-order");
    expect(screen.getByRole("button", { name: "Reload Zylith" })).toBeEnabled();
  });

  it("requests a page reload from the recovery action", () => {
    const reload = vi.fn();
    render(<AppErrorBoundary reload={reload}><Broken /></AppErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Reload Zylith" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("copies only allowlisted diagnostic metadata", async () => {
    const copyReport = vi.fn();
    render(
      <AppErrorBoundary
        copyReport={copyReport}
        appVersion="1.2.3"
        network="mainnet"
      >
        <Broken />
      </AppErrorBoundary>
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy error report" }));

    await vi.waitFor(() => expect(copyReport).toHaveBeenCalledTimes(1));
    const report = copyReport.mock.calls[0][0] as string;
    expect(report).toContain('"code": "APPLICATION_LOAD_FAILED"');
    expect(report).toContain('"appVersion": "1.2.3"');
    expect(report).not.toContain("private-order");
    expect(report).not.toContain("signature");
  });

  it("reports a failed copy action and allows another attempt", async () => {
    const copyReport = vi.fn().mockRejectedValueOnce(new Error("clipboard blocked"));
    render(<AppErrorBoundary copyReport={copyReport}><Broken /></AppErrorBoundary>);

    fireEvent.click(screen.getByRole("button", { name: "Copy error report" }));
    expect(await screen.findByRole("button", { name: "Copy failed, try again" }))
      .toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy failed, try again" }));
    await vi.waitFor(() => expect(copyReport).toHaveBeenCalledTimes(2));
  });
});
