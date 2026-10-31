"use client";

import { useEffect, useState } from "react";
import { formatStatusDuration } from "@/lib/status-duration";
import { taskElapsedMs, type TaskTiming } from "@/lib/task-timing";

export function TaskDuration({ timing, busy, startedAt, phase, tokensPerSecond, hideSettled = false, t }: {
  timing: TaskTiming | null;
  busy: boolean;
  startedAt: number | null;
  phase: string;
  tokensPerSecond?: number | null;
  hideSettled?: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [now, setNow] = useState(() => Date.now());
  // A fresh send may be preparing before its durable dispatch receipt arrives.
  const current = busy && timing?.outcome && startedAt !== null && startedAt > timing.startedAt ? null : timing;
  const running = current ? !current.outcome : busy;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [running, current?.commandId]);

  if (!current && !busy) return null;
  if (!running && hideSettled) return null;
  const elapsed = current ? taskElapsedMs(current, now) : startedAt === null ? null : Math.max(0, now - startedAt);
  const outcome = running ? undefined : current?.outcome;
  const speed = running && busy && typeof tokensPerSecond === "number" && Number.isFinite(tokensPerSecond) && tokensPerSecond >= 0
    ? tokensPerSecond : null;
  const label = t(outcome ? `chat.taskDuration.${outcome}` : "chat.taskDuration.running");
  const color = running ? "var(--accent)" : outcome === "failed" ? "var(--status-failed)"
    : outcome === "completed" ? "var(--status-ready)" : "var(--text-muted)";
  return (
    <div data-task-duration data-state={outcome ?? "running"} title={t("chat.taskDuration.hint")}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minHeight: 30, padding: "4px 2px 8px", fontSize: "var(--text-sm)", color: "var(--text-muted)", minWidth: 0 }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span role="status" style={{ flexShrink: 0 }}>{label}</span>
      {elapsed !== null && <span aria-hidden="true" style={{ opacity: 0.4 }}>·</span>}
      {elapsed !== null && <span style={{ flexShrink: 0 }}>{t(running ? "chat.taskDuration.elapsed" : "chat.taskDuration.total")}</span>}
      <span data-task-duration-value role="timer" aria-live="off" style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: running ? "var(--accent)" : "var(--text)", flexShrink: 0 }}>
        {elapsed === null ? t(running ? "chat.taskDuration.preparing" : "chat.taskDuration.unknown") : formatStatusDuration(elapsed)}
      </span>
      {running && <>
        <span aria-hidden="true" style={{ opacity: 0.4 }}>·</span>
        <span data-task-duration-phase style={{ flex: "1 1 64px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{phase}</span>
      </>}
      {speed !== null && <span data-task-token-speed title={t("chat.taskDuration.speedHint")} aria-live="off"
        style={{ marginLeft: "auto", flexShrink: 0, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", color: "var(--accent)" }}>
        ≈{speed.toFixed(1)} t/s
      </span>}
    </div>
  );
}
