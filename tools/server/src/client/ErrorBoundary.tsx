import { Component, ReactNode } from "react";

/**
 * A last-resort boundary around the whole app. The client is a pure SPA — when a render throws there
 * is NO server-side shell to fall back to, so an uncaught error would leave a blank WHITE PAGE with
 * no way to recover but to guess-and-reload. This catches it and shows the error plus a Reload button
 * (a reload re-fetches everything — the usual cure once a transient cause, e.g. a server restart, is
 * past). `reset` also lets a re-render try again without a full reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("yamlover UI crashed:", error);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h1>Something went wrong</h1>
        <p>The viewer hit an error and stopped rendering.</p>
        <pre>{error.message}</pre>
        <div className="crash-actions">
          <button onClick={() => this.setState({ error: null })}>Try again</button>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
