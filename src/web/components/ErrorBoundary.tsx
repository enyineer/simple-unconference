// Generic React error boundary. Wrap any subtree to keep a thrown render
// error from blanking the whole page. Renders a themed fallback that lets
// the user retry, and surfaces the error message in a collapsible block.
//
// Error boundaries have to be class components — there's no functional
// equivalent for componentDidCatch / getDerivedStateFromError as of React 19.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown above the message. Defaults to "Something went wrong." */
  title?: string;
  /** Optional reset hook — called when the user clicks "Try again". */
  onReset?: () => void;
  /** When this key changes, the boundary resets (e.g. on route change). */
  resetKey?: string | number;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console so devtools shows a clean stack alongside the
    // friendly fallback below.
    console.error("Caught by ErrorBoundary:", error, info);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const title = this.props.title ?? "Something went wrong.";
    return (
      <div
        role="alert"
        style={{
          margin: 24,
          padding: 16,
          borderRadius: 8,
          border: "1px solid var(--fgColor-danger, var(--uncon-danger, #d1242f))",
          background: "var(--bgColor-muted, var(--uncon-bg-subtle, #fff5f5))",
          color: "var(--fgColor-default, var(--uncon-fg, #111))",
          maxWidth: 720,
        }}
      >
        <div style={{
          fontWeight: 600, fontSize: 16, marginBottom: 8,
          color: "var(--fgColor-danger, var(--uncon-danger, #d1242f))",
        }}>
          {title}
        </div>
        <div style={{ fontSize: 13, marginBottom: 12, opacity: 0.85 }}>
          The page hit an error and stopped rendering. The rest of the app should still
          work — try again, or reload if it persists.
        </div>
        <details style={{ fontSize: 12, marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))" }}>
            Show error details
          </summary>
          <pre style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            marginTop: 8,
            padding: 8,
            borderRadius: 4,
            background: "var(--bgColor-default, var(--uncon-bg, #fff))",
            border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 11,
          }}>
            {error.name}: {error.message}
            {error.stack ? "\n\n" + error.stack : ""}
          </pre>
        </details>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={this.reset}
            style={{
              border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
              background: "var(--bgColor-default, var(--uncon-bg, #fff))",
              color: "var(--fgColor-default, var(--uncon-fg, #111))",
              padding: "6px 14px", borderRadius: 6, fontSize: 13, cursor: "pointer",
            }}
          >Try again</button>
          <button
            type="button"
            onClick={() => location.reload()}
            style={{
              border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
              background: "transparent",
              color: "var(--fgColor-default, var(--uncon-fg, #111))",
              padding: "6px 14px", borderRadius: 6, fontSize: 13, cursor: "pointer",
            }}
          >Reload page</button>
        </div>
      </div>
    );
  }
}
