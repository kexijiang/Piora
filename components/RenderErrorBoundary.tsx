"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AliIcon } from "./AliIcon";

interface RenderErrorBoundaryProps {
  children: ReactNode;
  /** Changes whenever the wrapped content changes shape (e.g. each streaming fragment or panel refresh). */
  resetKey: string;
  fallbackLabel: string;
  errorTitle?: string;
}

interface RenderErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

/**
 * Generic render isolation boundary. One malformed or partially-streamed
 * message or panel payload — very common with fragmented streaming tool-call
 * inputs and polled device data — must degrade into a skipped surface instead
 * of crashing the whole renderer into the global error screen. While live
 * data keeps arriving the resetKey changes with every fragment, so the
 * boundary automatically retries and recovers as soon as the data becomes
 * renderable again.
 */
export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  state: RenderErrorBoundaryState = { hasError: false, errorMessage: null };

  static getDerivedStateFromError(error: unknown): RenderErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Electron forwards renderer console errors into the local Piora log, so
    // isolated-surface crashes stay diagnosable after the page survives them.
    console.error(
      "Piora could not render an isolated surface",
      error.stack ?? error.message,
      info.componentStack,
    );
  }

  componentDidUpdate(previousProps: RenderErrorBoundaryProps): void {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, errorMessage: null });
    }
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        role="alert"
        data-render-fallback
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          margin: "8px 0",
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          fontSize: "var(--text-sm)",
        }}
        title={this.state.errorMessage ?? undefined}
      >
        <AliIcon name="warning" size={14} style={{ color: "var(--status-failed)", flexShrink: 0 }} />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {this.props.fallbackLabel}
        </span>
        {this.props.errorTitle && this.state.errorMessage ? (
          <span
            style={{
              color: "var(--text-dim)",
              fontSize: "var(--text-xs)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {this.props.errorTitle}: {this.state.errorMessage}
          </span>
        ) : null}
      </div>
    );
  }
}
