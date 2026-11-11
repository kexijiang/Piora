"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { LogWorkbench } from "./log-workbench/LogWorkbench.jsx";
import { RealtimeLogs } from "./log-workbench/RealtimeLogs";
import { LogSessionContext } from "./log-workbench/log-session";
import styles from "./log-workbench/HarmonyLogWorkbench.module.css";
import "./log-workbench/log-workbench.css";

export function HarmonyLogWorkbench({ active, serial, online, sessionId, onDraft, copy }: {
  active: boolean;
  serial: string;
  online: boolean;
  sessionId?: string | null;
  onDraft?: (text: string) => void;
  copy: (zh: string, en: string) => string;
}) {
  const [tab, setTab] = useState<"live" | "session">("live");
  const [visitedSession, setVisitedSession] = useState(false);
  const [file, setFile] = useState<{ sessionId: string; id: string }>();
  const id = useId();
  const showSession = useCallback((fileId?: string) => {
    if (fileId && sessionId) setFile({ sessionId, id: fileId });
    setVisitedSession(true); setTab("session");
  }, [sessionId]);
  const draft = useCallback((text: string) => {
    if (!sessionId || !onDraft) throw new Error(copy("请先打开一个会话", "Open a chat first"));
    onDraft(text);
  }, [sessionId, onDraft, copy]);
  const context = useMemo(() => ({ sessionId: sessionId ?? undefined, onOpenLogs: showSession, onAnalyze: draft }), [sessionId, showSession, draft]);
  return <LogSessionContext.Provider value={context}>
    <section className={styles.root} aria-label={copy("日志工作台", "Log workbench")}>
      <div className={styles.tabs} role="tablist" aria-label={copy("日志视图", "Log views")}>
        {(["live", "session"] as const).map(view => <button type="button" key={view} role="tab" id={`${id}-${view}`} aria-controls={`${id}-${view}-panel`} aria-selected={tab === view} tabIndex={tab === view ? 0 : -1} onClick={() => view === "session" ? showSession() : setTab("live")} onKeyDown={event => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "live" : event.key === "End" ? "session" : tab === "live" ? "session" : "live"; if (next === "session") showSession(); else setTab("live"); document.getElementById(`${id}-${next}`)?.focus(); }
        }}>{view === "live" ? copy("实时日志", "Live logs") : copy("会话日志", "Session logs")}</button>)}
        <span>{copy("导入和搜索在本机进行；加入对话后可编辑再发送", "Import and search locally; review the draft before sending")}</span>
      </div>
      <div id={`${id}-live-panel`} role="tabpanel" aria-labelledby={`${id}-live`} hidden={tab !== "live"} className={styles.pane}>
        <RealtimeLogs active={active} visible={active && tab === "live"} serial={serial} online={online} copy={copy} onSavedToSession={showSession} onShowSessionLogs={showSession} />
      </div>
      {visitedSession ? <div id={`${id}-session-panel`} role="tabpanel" aria-labelledby={`${id}-session`} hidden={tab !== "session"} className={`${styles.pane} piora-log-workbench log-workbench-shell`}>
        <LogWorkbench visible={active && tab === "session"} sessionId={sessionId ?? undefined} onDraft={draft} openFileId={file && file.sessionId === sessionId ? file.id : undefined} onOpenFileConsumed={() => setFile(undefined)} onRealtime={() => setTab("live")} />
      </div> : null}
    </section>
  </LogSessionContext.Provider>;
}
