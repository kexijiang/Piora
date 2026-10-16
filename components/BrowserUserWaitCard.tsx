"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ToolResultMessage } from "@/lib/types";

const OPEN_AGENT_BROWSER_EVENT = "piora:open-agent-browser";

function resultText(result?: ToolResultMessage): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function statusKey(result?: ToolResultMessage): string | null {
  const details = result?.details;
  const status = details && typeof details === "object" ? (details as { status?: unknown }).status : undefined;
  if (status === "continued") return "browser.waitContinued";
  if (status === "cancelled") return "browser.waitCancelled";
  if (status === "timeout") return "browser.waitTimeout";
  if (status === "aborted") return "browser.waitAborted";
  return null;
}

export function BrowserUserWaitCard({
  sessionId,
  reason,
  result,
  historical,
}: {
  sessionId?: string;
  reason: string;
  result?: ToolResultMessage;
  historical: boolean;
}) {
  const { t } = useI18n();
  const running = !historical && (!result || result.isStreaming === true);
  const [backend, setBackend] = useState<"desktop" | "playwright" | null>(null);
  const [busy, setBusy] = useState<"continue" | "cancel" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!running || !sessionId) return;
    let cancelled = false;
    let timer = 0;
    const load = async () => {
      if (cancelled) return;
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/browser-wait`, { cache: "no-store" });
        const payload = await response.json() as { wait?: { backend?: unknown } | null };
        if (cancelled) return;
        if (payload.wait) {
          setBackend(payload.wait.backend === "desktop" ? "desktop" : "playwright");
          return;
        }
      } catch {
        // The card still shows the reason from the tool call.
      }
      timer = window.setTimeout(() => void load(), 1000);
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [running, sessionId]);

  const decide = async (decision: "continue" | "cancel") => {
    if (!sessionId || busy) return;
    setBusy(decision);
    setNote(null);
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/browser-wait`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        setNote(payload?.error || t("browser.actionFailed"));
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : t("browser.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const finishedKey = statusKey(result);
  return <section className="browser-user-wait" aria-live="polite">
    <p className="browser-user-wait-title">{t("browser.waitTitle")}</p>
    {running ? <p className="browser-user-wait-reason">{reason}</p> : <p className="browser-user-wait-status">{finishedKey ? t(finishedKey) : (resultText(result) || reason)}</p>}
    {running ? <div className="browser-user-wait-actions">
      {backend === "desktop" ? <button type="button" onClick={() => {
        if (!sessionId) return;
        window.dispatchEvent(new CustomEvent(OPEN_AGENT_BROWSER_EVENT, { detail: { sessionId } }));
      }}>{t("browser.waitOpenBrowser")}</button> : null}
      <button type="button" disabled={!sessionId || busy !== null} onClick={() => void decide("continue")}>{t("browser.waitContinue")}</button>
      <button type="button" disabled={!sessionId || busy !== null} onClick={() => void decide("cancel")}>{t("browser.waitCancel")}</button>
    </div> : null}
    {note ? <p className="browser-user-wait-status">{note}</p> : null}
  </section>;
}
