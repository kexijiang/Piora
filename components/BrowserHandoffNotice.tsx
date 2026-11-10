"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { BrowserUserWaitSnapshot, BrowserUserWaitStatus } from "@/lib/browser-user-wait";
import { browserWaitPurpose, type BrowserWaitPurpose } from "@/lib/browser-wait-policy";

type Snapshot = { wait: BrowserUserWaitSnapshot | null; outcome?: { toolCallId: string; status: BrowserUserWaitStatus; endedAt: number; purpose?: BrowserWaitPurpose } | null };
export function BrowserHandoffNotice({ sessionId, busy, onWaitingChange }: { sessionId?: string; busy: boolean; onWaitingChange?: (waiting: boolean) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [snapshot, setSnapshot] = useState<{ id: string; data: Snapshot; receivedAt: number } | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<{ toolCallId: string; message: string } | null>(null);
  const opened = useRef<string | null>(null);
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
  const wait = snapshot && snapshot.id === sessionId ? snapshot.data.wait : null;
  const login = Boolean(wait && browserWaitPurpose(wait.reason, wait.purpose) === "login");
  useEffect(() => {
    if (!isWaiting || !login || !sessionId || !wait) return;
    const key = `${sessionId}:${wait.toolCallId}`;
    if (opened.current === key) return;
    opened.current = key;
    window.dispatchEvent(new CustomEvent("piora:open-agent-browser", { detail: { sessionId } }));
  }, [isWaiting, login, sessionId, wait]);
  useEffect(() => { onWaitingChange?.(isWaiting); return () => onWaitingChange?.(false); }, [isWaiting, onWaitingChange]);
  if (!snapshot || snapshot.id !== sessionId) return null;
  const data = snapshot?.data;
  const waiting = data?.wait?.backend === "desktop";
  const outcome = data?.outcome;
  if (login) {
    if (!wait || typeof wait.startedAt !== "number" || snapshot.receivedAt - wait.startedAt < 5 * 60_000) return null;
    const continueLogin = async () => {
      if (!sessionId || continuing) return;
      setContinuing(true);
      setContinueError(null);
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/browser-wait`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "continue", toolCallId: wait.toolCallId }),
        });
        if (!response.ok) throw new Error(zh ? "请重新核对当前浏览器状态。" : "Check the current browser state again.");
      } catch (error) {
        setContinueError({ toolCallId: wait.toolCallId, message: error instanceof Error ? error.message : String(error) });
      } finally { setContinuing(false); }
    };
    return <div className="browser-login-fallback" role="status" aria-live="polite" style={{ margin: "8px 16px", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
      <span>{zh ? "暂未识别到登录完成。请核对浏览器；若已登录，可手动继续。" : "Sign-in has not been confirmed yet. Check the browser; if you have signed in, you can continue manually."}</span>{" "}
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("piora:open-agent-browser", { detail: { sessionId } }))}>{zh ? "打开浏览器" : "Open browser"}</button>{" "}
      <button type="button" disabled={continuing} onClick={() => void continueLogin()}>{zh ? "我已登录，继续" : "I have signed in, continue"}</button>
      {continueError?.toolCallId === wait.toolCallId ? <p>{continueError.message}</p> : null}
    </div>;
  }
  if (!waiting && outcome?.purpose === "login") return null;
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
