"use client";
import { useState } from "react";
import type { ChatDraft } from "@/lib/draft-store";

type Item = { id: string; timestamp: number; preview: string; attachments: number };
export function PromptSubmissionArchive({ sessionId, onRestore }: { sessionId: string; onRestore: (draft: ChatDraft) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/submissions`;
  const load = async (offset = 0) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${endpoint}?offset=${offset}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "读取发送记录失败");
      setItems((old) => offset ? [...old, ...body.items] : body.items); setNextOffset(body.nextOffset);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  const restore = async (id: string) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${endpoint}?commandId=${encodeURIComponent(id)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "恢复失败");
      onRestore(body); setOpen(false);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  return <div style={{ position: "relative" }}>
    <button type="button" title="找回终止或失败前发送的原文和附件" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load(); }} style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>发送记录</button>
    {open && <section aria-label="发送记录" style={{ position: "absolute", bottom: "100%", right: 0, width: "min(400px, 80vw)", maxHeight: "50vh", overflowY: "auto", padding: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, zIndex: 50 }}>
      <p style={{ marginBottom: 8, fontSize: "var(--text-xs)" }}>恢复到输入框后可编辑并重新发送。</p>
      {!items.length && !busy && <p>暂无发送记录</p>}
      {items.map((item) => <button key={item.id} type="button" disabled={busy} onClick={() => void restore(item.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 0", borderBottom: "1px solid var(--border)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        <small style={{ color: "var(--text-muted)" }}>{new Date(item.timestamp).toLocaleString()}{item.attachments ? ` · ${item.attachments} 个附件` : ""}</small><div>{item.preview || "附件消息"}</div>
      </button>)}
      {nextOffset !== null && <button disabled={busy} onClick={() => void load(nextOffset)}>更早记录</button>}
      {busy && <p role="status">读取中…</p>}{error && <p role="alert">{error}</p>}
    </section>}
  </div>;
}
