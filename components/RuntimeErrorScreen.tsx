"use client";

import { useEffect, useMemo, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { formatRuntimeErrorReport, isPageAssetLoadError, runtimeErrorReference } from "@/lib/runtime-error-report";

interface RuntimeErrorScreenProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export function RuntimeErrorScreen({ error, reset }: RuntimeErrorScreenProps) {
  const chinese = useMemo(
    () => typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh"),
    [],
  );
  const [report, setReport] = useState("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const reference = runtimeErrorReference(error);
  const assetLoadError = isPageAssetLoadError(error);
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

  useEffect(() => {
    // Electron forwards renderer console errors into the local Piora log. In a
    // normal browser this still leaves a useful entry in DevTools.
    const details = formatRuntimeErrorReport(error, {
      version, time: new Date().toISOString(), runtime: window.piDesktop ? "Electron desktop" : "Browser",
      userAgent: navigator.userAgent,
    });
    setReport(details);
    setCopyStatus("idle");
    console.error("Piora caught an unrecoverable render error", details);
  }, [error, version]);

  return (
    <main style={styles.page}>
      <section style={styles.card} role="alert">
        <div style={styles.mark} aria-hidden="true">!</div>
        <h1 style={styles.title}>{chinese ? "Piora 页面遇到问题" : "Piora could not render this page"}</h1>
        <p style={styles.copy}>
          {chinese
            ? assetLoadError
              ? "页面资源加载失败，可以尝试重新加载。若仍出现此页面，请复制诊断信息用于排查。"
              : "页面渲染发生异常，具体原因见下方错误信息。可以先重试；若仍未恢复，请复制诊断信息用于排查。"
            : assetLoadError
              ? "A page asset failed to load. Try reloading; if this persists, copy the diagnostics for investigation."
              : "The page encountered a rendering error. See the error below; retry or copy the diagnostics if it persists."}
        </p>
        <p style={styles.errorSummary}>{error.name}: {error.message}</p>
        <div style={styles.actions}>
          <button type="button" style={styles.primaryButton} onClick={() => {
            // React.lazy retains a rejected import. Resetting its boundary
            // alone rethrows it; a fresh document must retry the asset graph.
            if (assetLoadError) window.location.reload();
            else reset();
          }}>
            {chinese ? "重试" : "Retry"}
          </button>
          <button type="button" style={styles.secondaryButton} onClick={() => window.location.reload()}>
            {chinese ? "重新加载" : "Reload"}
          </button>
          <button type="button" disabled={!report} style={styles.secondaryButton} onClick={() => {
            void copyText(report).then(() => setCopyStatus("copied")).catch(() => setCopyStatus("failed"));
          }}>
            {copyStatus === "copied" ? (chinese ? "已复制" : "Copied") : (chinese ? "复制诊断信息" : "Copy diagnostics")}
          </button>
        </div>
        {copyStatus === "failed" ? <p role="status" style={styles.copy}>{chinese ? "复制失败，请展开错误详情，选中文字后手动复制。" : "Copy failed. Expand the details and select the text to copy manually."}</p> : null}
        <details style={styles.details}>
          <summary style={{ cursor: "pointer" }}>{chinese ? "错误详情" : "Error details"}</summary>
          <pre style={styles.stack}>{report || error.stack || error.message}</pre>
        </details>
        <p style={styles.reference}>
          {chinese ? "版本" : "Version"} {version} · {chinese ? "错误编号" : "Error reference"} {reference}
        </p>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    boxSizing: "border-box",
    position: "relative",
    zIndex: 1,
    height: "100dvh",
    overflowY: "auto",
    display: "grid",
    placeItems: "center",
    padding: 24,
    background: "#111318",
    color: "#eceef2",
    fontFamily: "Segoe UI, system-ui, sans-serif",
  },
  card: {
    boxSizing: "border-box",
    width: "min(640px, 100%)",
    minWidth: 0,
    padding: 28,
    border: "1px solid #30343c",
    borderRadius: "var(--radius-panel, 12px)",
    background: "#191c22",
    boxShadow: "0 20px 60px rgba(0,0,0,.32)",
  },
  mark: {
    width: 34,
    height: 34,
    display: "grid",
    placeItems: "center",
    borderRadius: "var(--radius-control)",
    background: "#f0b45a",
    color: "#15171b",
    fontSize: "1.375rem",
    fontWeight: 800,
  },
  title: { margin: "18px 0 8px", fontSize: "1.375rem", lineHeight: 1.25 },
  copy: { margin: 0, color: "#aeb3bd", fontSize: ".875rem", lineHeight: 1.65 },
  actions: { display: "flex", flexWrap: "wrap", gap: 10, marginTop: 22 },
  errorSummary: { fontSize: ".8125rem", color: "#f0b45a", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  details: { marginTop: 18, color: "#aeb3bd", fontSize: ".8125rem" },
  stack: { maxHeight: "35dvh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text", fontSize: ".75rem" },
  primaryButton: {
    border: 0,
    borderRadius: "var(--radius-control)",
    padding: "9px 16px",
    background: "#eceef2",
    color: "#15171b",
    fontWeight: 650,
    cursor: "pointer",
  },
  secondaryButton: {
    border: "1px solid #3c414b",
    borderRadius: "var(--radius-control)",
    padding: "9px 16px",
    background: "transparent",
    color: "#eceef2",
    fontWeight: 650,
    cursor: "pointer",
  },
  reference: { margin: "18px 0 0", color: "#737985", fontSize: ".6875rem", overflowWrap: "anywhere" },
};
