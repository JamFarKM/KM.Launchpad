import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Named in the copy, so a report says which surface failed. */
  where: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

/**
 * Turns a white screen into a readable fault.
 *
 * React unmounts the entire tree when a render throws, and with no boundary the result is a blank
 * page: no message, nothing in the UI, and the only trace in a console the user has to know to open.
 * "The app crashes when I open a pull request" was exactly that — a real bug, reported accurately,
 * with every diagnostic detail discarded by the framework's default behaviour.
 *
 * One boundary per page rather than one around the app, so the top bar survives and the reviewer can
 * navigate away from the broken surface instead of reloading and landing on it again.
 *
 * <b>This is a diagnostic, not a recovery.</b> It does not retry or swallow: the state that produced
 * the throw is still there, so it shows what happened, offers a copy button for the report, and stops.
 * Anything cleverer would hide the bug it exists to surface.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Logged as well as rendered: the console keeps the real stack with source-mapped frames, which
    // the component stack below deliberately doesn't try to replace.
    console.error(`[launchpad] ${this.props.where} failed to render`, error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  private report(): string {
    const { error, stack } = this.state;
    return [
      `Launchpad — ${this.props.where} failed to render`,
      `${error?.name ?? "Error"}: ${error?.message ?? "(no message)"}`,
      `URL: ${window.location.href}`,
      "",
      "Component stack:",
      (stack ?? "(none)").trim(),
      "",
      "Stack:",
      (error?.stack ?? "(none)").trim(),
    ].join("\n");
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="empty crash">
        <h3>{this.props.where} hit an error</h3>
        {/* The message first and unabbreviated. It is usually the whole diagnosis — "Cannot read
            properties of undefined (reading 'citations')" names the bug outright. */}
        <p className="crash-msg"><code>{error.name}: {error.message}</code></p>
        <p>
          Nothing was lost — this panel failed to draw, and the rest of Launchpad is still working.
          Copy the details if you want them looked at.
        </p>
        <div className="row" style={{ gap: 8, justifyContent: "center" }}>
          <button className="btn small primary" onClick={() => navigator.clipboard?.writeText(this.report())}>
            Copy details
          </button>
          <button className="btn small" onClick={() => window.location.reload()}>Reload</button>
        </div>
        {stack && (
          <details className="crash-stack">
            <summary>Component stack</summary>
            <pre>{stack.trim()}</pre>
          </details>
        )}
      </div>
    );
  }
}
