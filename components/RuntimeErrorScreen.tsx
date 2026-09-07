"use client";

import { useEffect, useMemo } from "react";

interface RuntimeErrorScreenProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export function RuntimeErrorScreen({ error, reset }: RuntimeErrorScreenProps) {
  const chinese = useMemo(
    () => typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh"),
    [],
  );

  useEffect(() => {
    // Electron forwards renderer console errors into the local Piora log. In a
    // normal browser this still leaves a useful entry in DevTools.
    console.error(
      "Piora caught an unrecoverable render error",
      error.stack ?? error.message,
    );
  }, [error]);

  const reference = error.digest ? ` · ${error.digest}` : "";
  return (
    <main style={styles.page}>
      <section style={styles.card} role="alert">
        <div style={styles.mark} aria-hidden="true">!</div>
        <h1 style={styles.title}>{chinese ? "Piora 页面遇到问题" : "Piora could not render this page"}</h1>
        <p style={styles.copy}>
          {chinese
            ? "可能是升级后残留的页面缓存。Piora 已记录具体错误，你可以先重试；若仍未恢复，请重新加载应用。"
            : "This can be caused by stale page assets after an upgrade. Piora recorded the error; retry first, then reload if needed."}
        </p>
        <div style={styles.actions}>
          <button type="button" style={styles.primaryButton} onClick={() => reset()}>
            {chinese ? "重试" : "Retry"}
          </button>
          <button type="button" style={styles.secondaryButton} onClick={() => window.location.reload()}>
            {chinese ? "重新加载" : "Reload"}
          </button>
        </div>
        <p style={styles.reference}>
          {chinese ? "错误编号" : "Error reference"}{reference || " · client-render"}
        </p>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: "relative",
    zIndex: 1,
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    padding: 24,
    background: "#111318",
    color: "#eceef2",
    fontFamily: "Segoe UI, system-ui, sans-serif",
  },
  card: {
    width: "min(480px, 100%)",
    padding: 28,
    border: "1px solid #30343c",
    borderRadius: 16,
    background: "#191c22",
    boxShadow: "0 20px 60px rgba(0,0,0,.32)",
  },
  mark: {
    width: 34,
    height: 34,
    display: "grid",
    placeItems: "center",
    borderRadius: 10,
    background: "#f0b45a",
    color: "#15171b",
    fontSize: "1.375rem",
    fontWeight: 800,
  },
  title: { margin: "18px 0 8px", fontSize: "1.375rem", lineHeight: 1.25 },
  copy: { margin: 0, color: "#aeb3bd", fontSize: ".875rem", lineHeight: 1.65 },
  actions: { display: "flex", gap: 10, marginTop: 22 },
  primaryButton: {
    border: 0,
    borderRadius: 9,
    padding: "9px 16px",
    background: "#eceef2",
    color: "#15171b",
    fontWeight: 650,
    cursor: "pointer",
  },
  secondaryButton: {
    border: "1px solid #3c414b",
    borderRadius: 9,
    padding: "9px 16px",
    background: "transparent",
    color: "#eceef2",
    fontWeight: 650,
    cursor: "pointer",
  },
  reference: { margin: "18px 0 0", color: "#737985", fontSize: ".6875rem" },
};
