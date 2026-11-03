"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { BrowserUserWaitSnapshot, BrowserUserWaitStatus } from "@/lib/browser-user-wait";

type Snapshot = { wait: BrowserUserWaitSnapshot | null; outcome?: { toolCallId: string; status: BrowserUserWaitStatus; endedAt: number } | null };
export function BrowserHandoffNotice({ sessionId, busy, onWaitingChange }: { sessionId?: string; busy: boolean; onWaitingChange?: (waiting: boolean) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [snapshot, setSnapshot] = useState<{ id: string; data: Snapshot; receivedAt: number } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/browser-wait`, { signal: controller.signal, cache: "no-store" });
        if (response.ok) { const data: Snapshot = await response.json(); if (!controller.signal.aborted) setSnapshot({ id: sessionId, data, receivedAt: Date.now() }); }
      } catch { /* Reconcile again without turning a network interruption into a resumed notice. */ }
      if (busy && !controller.signal.aborted) timer = setTimeout(refresh, 1500);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, busy]);
  const isWaiting = snapshot?.id === sessionId && snapshot?.data.wait?.backend === "desktop";
  useEffect(() => { onWaitingChange?.(isWaiting); return () => onWaitingChange?.(false); }, [isWaiting, onWaitingChange]);
  if (snapshot?.id !== sessionId) return null;
  const data = snapshot?.data;
  const waiting = data?.wait?.backend === "desktop";
  const outcome = data?.outcome;
  if (!waiting && (!outcome || (snapshot?.receivedAt ?? 0) - outcome.endedAt > 60_000)) return null;
  const result = outcome?.status === "continued" ? (zh ? "浏览器操作已确认，助手已获准继续。" : "Browser step confirmed. The assistant may continue.")
    : outcome?.status === "timeout" ? (zh ? "等待浏览器操作已超时，未确认完成。" : "Browser handoff timed out without confirmation.")
    : (zh ? "浏览器接手已取消，未确认完成。" : "Browser handoff cancelled without confirmation.");
  return <aside role="status" aria-live="polite" className="browser-handoff-notice" style={{ margin: "8px 16px", padding: "12px 16px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)" }}>
    <strong>{waiting ? (zh ? "等待用户操作" : "Waiting for you") : (zh ? "浏览器状态" : "Browser status")}</strong>
    <p>{waiting ? (zh ? "请在右侧浏览器完成登录、验证码或确认，然后点击“已完成，继续”。" : "Complete the login, verification or confirmation in the browser panel, then choose Done, continue.") : result}</p>
    {waiting ? <><p>{data?.wait?.reason}</p><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("piora:open-agent-browser", { detail: { sessionId } }))}>{zh ? "打开浏览器接手" : "Open browser"}</button></> : null}
  </aside>;
}
