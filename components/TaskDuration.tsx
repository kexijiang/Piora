"use client";

import { useEffect, useState } from "react";
import { TaskActivityIcon } from "./TaskActivityIcon";
import { TaskPhaseActivity } from "./TaskPhaseActivity";
import { formatStatusDuration } from "@/lib/status-duration";
import { taskElapsedMs, type TaskTiming } from "@/lib/task-timing";

const layoutCss = `
.piora-task-line { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; column-gap: 16px; row-gap: 6px; }
.piora-task-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; grid-column: 1; grid-row: 1; }
.piora-task-speed { grid-column: 2; grid-row: 1; justify-self: center; }
.piora-task-phase { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1 1 64px; }
@container piora-task (max-width: 640px) {
  .piora-task-summary { grid-column: 1 / -1; }
  .piora-task-speed { grid-row: 2; }
}
`;

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
      style={{ containerType: "inline-size", containerName: "piora-task", minHeight: 30, padding: "4px 2px 8px", fontSize: "var(--text-sm)", color: "var(--text-muted)", minWidth: 0 }}>
      <style>{layoutCss}</style>
      <div className="piora-task-line">
      <span className="piora-task-summary">
      {running ? <TaskActivityIcon /> : <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />}
      <span role="status" style={{ flexShrink: 0 }}>{label}</span>
      {elapsed !== null && <span aria-hidden="true" style={{ opacity: 0.4 }}>·</span>}
      {elapsed !== null && <span style={{ flexShrink: 0 }}>{t(running ? "chat.taskDuration.elapsed" : "chat.taskDuration.total")}</span>}
      <span data-task-duration-value role="timer" aria-live="off" style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: running ? "var(--accent)" : "var(--text)", flexShrink: 0 }}>
        {elapsed === null ? t(running ? "chat.taskDuration.preparing" : "chat.taskDuration.unknown") : formatStatusDuration(elapsed)}
      </span>
      {running && <span className="piora-task-phase">
        <span aria-hidden="true" style={{ opacity: 0.4 }}>·</span>
        <span data-task-duration-phase style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{phase}</span>
        <TaskPhaseActivity />
      </span>}
      </span>
      {speed !== null && <span data-task-token-speed className="piora-task-speed" title={t("chat.taskDuration.speedHint")} aria-live="off"
        style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", color: "var(--text)", lineHeight: "24px" }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>≈{speed.toFixed(1)}</span>{" "}
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>t/s</span>
      </span>}
      </div>
    </div>
  );
}
