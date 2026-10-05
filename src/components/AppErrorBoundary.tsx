import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<
  { children: ReactNode; reload?: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // the fallback keeps a render failure from leaving an empty application.
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="app-load-failure" role="alert">
          <p>Zylith could not load.</p>
          <button type="button" onClick={() => (this.props.reload ?? (() => window.location.reload()))()}>
            Reload
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
