"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useAgentTerminal } from "@/hooks/useAgentTerminal";
import { copyText } from "@/lib/clipboard";
import { AliIcon } from "../AliIcon";
import { TerminalSurface, type TerminalSurfaceHandle } from "./TerminalSurface";
import styles from "./TerminalPanel.module.css";

export function CommandPanel({ cwd, sessionId, onClose }: { cwd?: string | null; sessionId?: string | null; onClose?: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"shell" | "agent">("shell");
  const [connected, setConnected] = useState(false);
  const [shell, setShell] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [finding, setFinding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const surface = useRef<TerminalSurfaceHandle>(null);
  const agent = useAgentTerminal(sessionId);
  const running = agent.commands.filter((item) => item.status === "running").length;
  const folder = cwd?.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop();
  const action = async (value: "restart" | "clear") => {
    try {
      const response = await fetch("/api/terminal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, action: value }) });
      if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
      setError(""); surface.current?.focus();
    } catch (cause) { setError(String(cause)); }
  };
  return <section className={styles.root} aria-label={t("commandPanel.title")}>
    <header className={styles.header}>
      <span className={styles.brand}><AliIcon name="code" size={17} /></span>
      <div className={styles.identity}><strong>{t("commandPanel.title")}</strong><span title={cwd ?? ""}>{folder || t("commandPanel.noWorkspace")}</span></div>
      <span className={styles.connection} data-connected={connected}><i />{connected ? shell : t("terminal.offline")}</span>
      {onClose && <button onClick={onClose} title={t("workspace.closeTool")} aria-label={t("workspace.closeTool")}><AliIcon name="close" size={14} /></button>}
    </header>
    <div className={styles.tabbar}>
      <div role="tablist" aria-label={t("commandPanel.title")}>
        <button role="tab" aria-selected={tab === "shell"} onClick={() => setTab("shell")}><AliIcon name="code" size={13} />{t("terminal.shell")}</button>
        <button role="tab" aria-selected={tab === "agent"} onClick={() => setTab("agent")}><AliIcon name="activity" size={13} />{t("terminal.agent")}<span className={styles.count} data-running={running > 0}>{running || agent.commands.length}</span></button>
      </div>
      <div className={styles.actions}>
        <button aria-label={t("commandPanel.findOutput")} title={t("commandPanel.findOutput")} aria-pressed={finding} onClick={() => setFinding(!finding)}><AliIcon name="search" size={14} /></button>
        {tab === "shell" && <><button disabled={!cwd} onClick={() => void action("clear")} title={t("commandPanel.clearOutput")} aria-label={t("commandPanel.clearOutput")}><AliIcon name="clear" size={14} /></button><button disabled={!cwd} onClick={() => void action("restart")} title={t("commandPanel.restart")} aria-label={t("commandPanel.restart")}><AliIcon name="reload" size={14} /></button></>}
      </div>
    </div>
    {finding && <div className={styles.find}><AliIcon name="search" size={13} /><input autoFocus value={query} placeholder={t("commandPanel.findOutput")} aria-label={t("commandPanel.findOutput")} onChange={(event) => { setQuery(event.target.value); surface.current?.search(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") surface.current?.search(query, event.shiftKey); if (event.key === "Escape") { setFinding(false); surface.current?.focus(); } }} /><button onClick={() => { setFinding(false); setQuery(""); surface.current?.search(""); }} aria-label={t("i18n.close")}><AliIcon name="close" size={13} /></button></div>}
    {(error || agent.error) && <div className={styles.error} role="alert">{error || agent.error}</div>}
    <div className={styles.body} role="tabpanel">
      {tab === "shell" ? cwd ? <TerminalSurface key={cwd} ref={surface} cwd={cwd} onStatus={(ready, name) => { setConnected(ready); setShell(name); }} onError={setError} /> : <div className={styles.empty}><AliIcon name="folder-open" size={28} /><strong>{t("commandPanel.noWorkspace")}</strong><p>{t("commandPanel.noWorkspaceDescription")}</p></div> : <div className={styles.feed}>
        <div className={styles.feedHeading}><span>{t("terminal.sessionCommands")}</span><span>{running ? t("terminal.runningCount", { count: running }) : t("terminal.synced")}</span></div>
        {agent.commands.length ? agent.commands.filter((item) => !query || `${item.command} ${item.output}`.toLowerCase().includes(query.toLowerCase())).map((item, index) => <article className={styles.command} key={item.id} data-status={item.status}>
          <button className={styles.commandTrigger} aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
            <span className={styles.ordinal}>{String(index + 1).padStart(2, "0")}</span><code>{item.command}</code><span className={styles.commandState}>{t(`terminal.${item.status}`)}</span><AliIcon name="chevron-right" style={{ transform: expanded === item.id ? "rotate(90deg)" : undefined }} size={12} />
          </button>
          {expanded === item.id && <><div className={styles.commandToolbar}><span>{t("terminal.output")}</span><button title={t("terminal.copyOutput")} aria-label={t("terminal.copyOutput")} onClick={() => { void copyText(item.output).catch((cause) => setError(String(cause))); }}><AliIcon name="copy" size={12} /></button></div><div className={styles.commandOutput}>{item.output ? <TerminalSurface ref={surface} key={`${sessionId}:${item.id}`} readOnly output={item.output} onError={setError} /> : <p>{t("terminal.noOutput")}</p>}</div></>}
        </article>) : <div className={styles.empty}><span className={styles.emptyMark}><AliIcon name="activity" size={26} /></span><strong>{t("terminal.agentEmpty")}</strong><p>{sessionId ? t("terminal.agentEmptyBody") : t("terminal.selectSession")}</p><span className={styles.hint}>$ <span>command</span> → output</span></div>}
      </div>}
    </div>
    <footer className={styles.footer}><span><i data-live={tab === "agent" ? running > 0 : connected} />{tab === "agent" ? t("terminal.linked") : "PTY"}</span><span>{tab === "shell" ? t("terminal.keyboardHint") : t("terminal.agentHint")}</span><span>UTF-8</span></footer>
  </section>;
}
