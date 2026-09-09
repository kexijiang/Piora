"use client";
import { useEffect, useState, useRef } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { ModelErrorText } from "./ModelErrorText";

export function ProjectModelDialog({ projectRoot, name, onClose }: { projectRoot: string; name: string; onClose: () => void }) {
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const [models, setModels] = useState<Array<{ provider: string; id: string; name: string }>>([]);
  const [selected, setSelected] = useState(""); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ updated: number; running: number } | null>(null); const [error, setError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  useFocusTrap(dialog, true, { onEscape: () => { if (!busy) onClose(); } });
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`/api/models?cwd=${encodeURIComponent(projectRoot)}`, { signal: abort.signal }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error); setModels(data.modelList ?? []); }).catch((error) => { if (!abort.signal.aborted) setError(String(error)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [projectRoot]);
  const apply = async () => {
    const model = models.find((model) => JSON.stringify([model.provider, model.id]) === selected); if (!model) return;
    setBusy(true); setError("");
    try { const response = await fetch("/api/projects/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectRoot, provider: model.provider, modelId: model.id }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setResult(data); window.dispatchEvent(new CustomEvent("piora:project-model-changed", { detail: data })); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  return createPortal(<div style={{ position: "fixed", inset: 0, zIndex: 10001, display: "grid", placeItems: "center", background: "#0006", padding: 20 }} onKeyDown={(event) => { if (event.key === "Escape" && !busy) onClose(); }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="project-model-title" style={{ width: "min(480px,100%)", borderRadius: 12, padding: 24, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)" }}>
      <h3 id="project-model-title" style={{ marginTop: 0 }}>{zh ? "切换项目内所有会话的模型" : "Change model for all project sessions"}</h3><p style={{ overflowWrap: "anywhere" }}>{name}</p>
      <p style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: 1.7 }}>{zh ? "包含归档会话与工作树中的会话。正在运行的任务继续完成当前轮次，新模型从下一次发送开始使用。" : "Includes archived sessions and worktrees. Active tasks finish their current turn; the new model applies on the next send."}</p>
      <select autoFocus aria-label={zh ? "项目模型" : "Project model"} disabled={loading || busy} value={selected} onChange={(event) => { setSelected(event.target.value); setResult(null); }} style={{ width: "100%", padding: 10, color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6 }}><option value="">{loading ? zh ? "正在加载…" : "Loading…" : zh ? "选择已启用且可用的模型" : "Select an enabled, available model"}</option>{models.map((model) => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.name} · {model.provider}/{model.id}</option>)}</select>
      {error ? <p role="alert"><ModelErrorText value={error} /></p> : null}
      {result ? <p role="status">{zh ? `已更新 ${result.updated} 个会话，${result.running} 个运行中的任务将在下一轮使用新模型。` : `Updated ${result.updated} sessions. ${result.running} active tasks will use the model on their next turn.`}</p> : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}><button disabled={busy} onClick={onClose}>{zh ? "关闭" : "Close"}</button><button disabled={!selected || busy || !!result} onClick={() => void apply()}>{busy ? zh ? "正在更新…" : "Updating…" : zh ? "应用到全部会话" : "Apply to all sessions"}</button></div>
    </section></div>, document.body);
}
