import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  normalizeFailure,
  sanitizedDiagnosticReport,
  type NormalizedFailure,
} from "../domain/userFacingErrors";
import { FailureNotice } from "./FailureNotice";

type Props = {
  children: ReactNode;
  reload?: () => void;
  copyReport?: (report: string) => Promise<void> | void;
  appVersion?: string;
  network?: string;
};

type State = {
  failure: NormalizedFailure | null;
  reportCopyState: "idle" | "copied" | "failed";
};

function supportReference(): string | undefined {
  try {
    return globalThis.crypto?.randomUUID?.();
  } catch {
    return undefined;
  }
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failure: null, reportCopyState: "idle" };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      failure: normalizeFailure(error, {
        domain: "application",
        operation: "load",
        stage: "application-render",
        presentation: "fatal-screen",
        correlationId: supportReference(),
      }),
      reportCopyState: "idle",
    };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Never render or copy the raw exception. The normalized failure is the
    // complete public boundary; private wallet/order data may exist upstream.
  }

  private copyDiagnosticReport = async () => {
    const { failure } = this.state;
    if (!failure) return;
    const report = sanitizedDiagnosticReport(failure, {
      appVersion: this.props.appVersion,
      network: this.props.network,
      operation: "application-render",
    });
    const copy = this.props.copyReport
      ?? ((value: string) => navigator.clipboard.writeText(value));
    try {
      await copy(report);
      this.setState({ reportCopyState: "copied" });
    } catch {
      this.setState({ reportCopyState: "failed" });
    }
  };

  render() {
    if (this.state.failure) {
      return (
        <main className="app-load-failure">
          <FailureNotice failure={this.state.failure} />
          <div className="app-load-failure-actions">
            <button
              type="button"
              onClick={() => (this.props.reload ?? (() => window.location.reload()))()}
            >
              Reload Zylith
            </button>
            <button type="button" onClick={() => void this.copyDiagnosticReport()}>
              {this.state.reportCopyState === "copied"
                ? "Error report copied"
                : this.state.reportCopyState === "failed"
                ? "Copy failed, try again"
                : "Copy error report"}
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
