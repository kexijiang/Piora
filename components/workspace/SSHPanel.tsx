"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useSSHSession } from "@/hooks/useSSHSession";
import { sshErrorText, sshRequest, SSHRequestError } from "@/lib/ssh/client";
import type { SSHSessionSnapshot, SSHSessionSummary } from "@/lib/ssh/types";
import { AliIcon } from "../AliIcon";
import { TerminalSurface, type TerminalSurfaceHandle } from "./TerminalSurface";
import { SSHConnectionDialog } from "./SSHConnectionDialog";
import { SSHFiles } from "./SSHFiles";
import styles from "./SSHPanel.module.css";

export function SSHPanel({ agentSessionId }: { agentSessionId?: string | null }) {
  const scope = agentSessionId || "manual";
  const { t } = useI18n();
  const [sessions, setSessions] = useState<SSHSessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const closingIds = useRef(new Set<string>());
  const [closing, setClosing] = useState<string[]>([]);
  const [closeError, setCloseError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const data = await sshRequest<{ sessions: SSHSessionSummary[] }>("/api/ssh/sessions?scope=" + encodeURIComponent(scope));
        if (alive) { setSessions(data.sessions); setLoaded(true); }
      } catch { if (alive) setLoaded(true); }
    };
    void refresh();
    const source = new EventSource("/api/ssh/sessions/events?scope=" + encodeURIComponent(scope));
    source.onmessage = event => { try { const value = JSON.parse(event.data) as { sessions: SSHSessionSummary[] }; if (alive && Array.isArray(value.sessions)) { setSessions(value.sessions); setLoaded(true); } } catch { /* refresh on next event */ } };
    source.onerror = () => void refresh();
    return () => { alive = false; source.close(); };
  }, [scope]);
  useEffect(() => {
    if (!loaded || newOpen) return;
    if (sessions.length === 0) { setNewOpen(true); return; }
    setSelected(current => {
      if (current && sessions.some(item => item.id === current)) return current;
      let remembered: string | null = null;
      try { remembered = sessionStorage.getItem("piora:ssh:v1:" + scope); } catch { /* storage unavailable */ }
      return remembered && sessions.some(item => item.id === remembered) ? remembered : sessions[0]?.id ?? null;
    });
  }, [loaded, sessions, scope, newOpen]);
  const select = (id: string | null) => {
    setNewOpen(id === null);
    setSelected(id);
    try { if (id) sessionStorage.setItem("piora:ssh:v1:" + scope, id); else sessionStorage.removeItem("piora:ssh:v1:" + scope); } catch { /* storage unavailable */ }
  };
  const closeTab = async (id: string) => {
    if (closingIds.current.has(id)) return;
    closingIds.current.add(id);
    setClosing([...closingIds.current]);
    setCloseError(null);
    try {
      try {
        await sshRequest(`/api/ssh/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (cause) {
        if (!(cause instanceof SSHRequestError && cause.status === 404)) throw cause;
      }
      setSessions(current => current.filter(item => item.id !== id));
      setSelected(current => current === id ? null : current);
      try {
        if (sessionStorage.getItem("piora:ssh:v1:" + scope) === id) sessionStorage.removeItem("piora:ssh:v1:" + scope);
      } catch { /* storage unavailable */ }
    } catch (cause) {
      setCloseError(sshErrorText(cause, t));
    } finally {
      closingIds.current.delete(id);
      setClosing([...closingIds.current]);
    }
  };
  return <section className={styles.multiRoot + " " + styles.root} aria-label="SSH">
    <nav className={styles.hostTabs} aria-label={t("ssh.hostTabs")}>
      {sessions.map(item => <div key={item.id} className={styles.hostTab} data-selected={selected === item.id}>
        <button type="button" className={styles.hostTabSelect} aria-current={selected === item.id ? "page" : undefined} onClick={() => select(item.id)} title={(item.hostName || item.host) + " · " + item.username + "@" + item.host}>
        <i data-connected={item.connected} /><span>{item.hostName || item.host + ":" + item.port}</span>{item.busy ? <span className={styles.tabBusy}>●</span> : null}
        </button>
        <button type="button" className={styles.hostTabClose} disabled={closing.includes(item.id)} onClick={() => void closeTab(item.id)} aria-label={t("ssh.closeTab") + " · " + (item.hostName || item.host + ":" + item.port)} title={t("ssh.closeTab")}><AliIcon name="close" size={14} /></button>
      </div>)}
      <button type="button" className={styles.addHost} onClick={() => select(null)} aria-label={t("ssh.addHost")} title={t("ssh.addHost")}><AliIcon name="plus" size={16} /><span>{t("ssh.addHost")}</span></button>
    </nav>
    {closeError ? <div className={styles.panelError} role="alert">{closeError}</div> : null}
    <div className={styles.hostContent}>{!loaded ? <div className={styles.centerState}>{t("ssh.restoring")}</div> : selected ? <SSHWorkspace key={selected} agentSessionId={agentSessionId} sessionId={selected} onClosed={() => select(null)} /> : <SSHConnectionDialog agentSessionId={agentSessionId} onConnected={snapshot => { setSessions(current => current.some(item => item.id === snapshot.id) ? current : [...current, snapshot]); select(snapshot.id); }} />}</div>
  </section>;
}

function SSHWorkspace({ agentSessionId, sessionId: selectedId, onClosed }: { agentSessionId?: string | null; sessionId: string; onClosed: () => void }) {
  const { t } = useI18n();
  const session = useSSHSession(agentSessionId || "manual", selectedId);
  const { snapshot, remember, streamReady } = session;
  const terminal = useRef<TerminalSurfaceHandle>(null);
  const root = useRef<HTMLElement>(null);
  const workarea = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const activeAction = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesMounted, setFilesMounted] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [wide, setWide] = useState(false);
  const [workspaceHeight, setWorkspaceHeight] = useState(0);
  const [split, setSplit] = useState({ wide: 65, narrow: 68 });
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 900));
    observer.observe(root.current);
    return () => { observer.disconnect(); activeAction.current?.abort(); };
  }, []);
  const sessionId = snapshot?.id;
  useEffect(() => {
    if (!workarea.current) return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceHeight(entry.contentRect.height));
    observer.observe(workarea.current);
    return () => observer.disconnect();
  }, [sessionId]);
  const action = async (name: string, method = "POST", payload: object = { action: name }) => {
    if (!snapshot || activeAction.current) return;
    const abort = new AbortController(); activeAction.current = abort;
    setBusy(name); setError(null); if (menu.current) menu.current.open = false;
    try {
      const data = await sshRequest<{ snapshot?: SSHSessionSnapshot }>(`/api/ssh/sessions/${snapshot.id}${method === "POST" ? "/actions" : ""}`, { method, headers: { "Content-Type": "application/json" }, ...(method !== "DELETE" ? { body: JSON.stringify(payload) } : {}), signal: abort.signal });
      if (!abort.signal.aborted) {
        if (method === "DELETE") { remember(null); setFilesOpen(false); setFilesMounted(false); onClosed(); }
        else if (data.snapshot) remember(data.snapshot);
      }
    } catch (cause) {
      if (!abort.signal.aborted) {
        if (method === "DELETE" && cause instanceof SSHRequestError && cause.status === 404) { remember(null); setFilesOpen(false); setFilesMounted(false); onClosed(); }
        else setError(sshErrorText(cause, t));
      }
    }
    finally { if (activeAction.current === abort) { activeAction.current = null; setBusy(null); } }
  };
  const maxShare = wide ? 75 : Math.max(35, Math.min(75, 100 * (workspaceHeight - 292) / Math.max(1, workspaceHeight)));
  const share = Math.min(wide ? split.wide : split.narrow, maxShare);
  const resize = (value: number) => setSplit(previous => ({ ...previous, [wide ? "wide" : "narrow"]: Math.max(wide ? 40 : 35, Math.min(maxShare, value)) }));
  const connected = !!snapshot?.connected && streamReady;
  const linked = snapshot?.mode === "agent-controlled";
  const sameTask = linked && snapshot.agentSessionId === agentSessionId;

  return <section ref={root} className={styles.root} aria-label="SSH">
    {session.restoring ? <div className={styles.centerState} role="status"><span className={styles.spinner} />{t("ssh.restoring")}</div> : session.restoreError ? <div className={styles.centerState} role="alert">{t("ssh.restoreError")}<button className={styles.secondary} onClick={session.retryRestore}>{t("ssh.retry")}</button></div> : !snapshot ? <div className={styles.centerState}>{t("ssh.offline")}<button className={styles.secondary} onClick={onClosed}>{t("ssh.addHost")}</button></div> : <>
      <header className={styles.hostHeader}>
        <div className={styles.identity}><h2 title={snapshot.host} tabIndex={0}>{snapshot.hostName || snapshot.host}</h2><p title={`${snapshot.username} · ${t("ssh.port")} ${snapshot.port}`}>{snapshot.username}@{snapshot.host} · {t("ssh.port")} {snapshot.port}</p></div>
        <span className={styles.status} data-connected={connected} role="status"><i />{t(!streamReady ? "ssh.syncing" : snapshot.connected ? "ssh.connected" : "ssh.offline")}</span>
        <details ref={menu} className={styles.more} onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary title={t("ssh.more")} aria-label={t("ssh.more")}><AliIcon name="ellipsis" size={19} /></summary>
          <div className={styles.menu}><button disabled={!!busy} onClick={() => void action("clear")}>{t("ssh.clear")}</button><button disabled={!!busy || !connected} onClick={() => void action("close")}>{t("ssh.disconnect")}</button>{!snapshot.connected ? <button disabled={!!busy} onClick={() => void action("delete", "DELETE")}>{t("ssh.newConnection")}</button> : null}</div>
        </details>
      </header>
      {error ? <div className={styles.panelError} role="alert">{error}</div> : null}
      {!snapshot.connected ? <div className={styles.offline}><span>{t(streamReady ? "ssh.offlineHint" : "ssh.syncing")}</span><button className={styles.secondary} disabled={!!busy || !streamReady} onClick={() => void action("start")}>{t(busy === "start" ? "ssh.connecting" : "ssh.reconnect")}</button></div> : null}
      <div ref={workarea} className={styles.workarea} data-files={filesOpen} style={{ "--terminal-share": `${share}%` } as CSSProperties}>
        <section className={styles.terminal} aria-label={t("ssh.terminal")}>
          <header className={styles.terminalHeader}><strong>{t("ssh.terminal")}</strong><span className={styles.terminalCwd} title={snapshot.cwd === "." ? t("ssh.cwdUnknown") : snapshot.cwd}>{snapshot.cwd === "." ? t("ssh.cwdUnknown") : snapshot.cwd}</span><div className={styles.tools}>
            <button aria-expanded={findOpen} onClick={() => setFindOpen(value => !value)}><AliIcon name="search" size={16} />{t("ssh.find")}</button>
            <button aria-expanded={filesOpen} aria-controls="ssh-remote-files" onClick={() => { setFilesOpen(value => !value); setFilesMounted(true); }}><AliIcon name="folder" size={16} />{t("ssh.fileToggle")}</button>
          </div></header>
          {findOpen ? <form className={styles.find} onSubmit={event => { event.preventDefault(); terminal.current?.search(query); }} onKeyDown={event => { if (event.key === "Escape") { setFindOpen(false); terminal.current?.search(""); terminal.current?.focus(); } }}>
            <input aria-label={t("ssh.find")} placeholder={t("ssh.findPlaceholder")} value={query} onChange={event => { setQuery(event.target.value); terminal.current?.search(event.target.value); }} autoFocus />
            <button type="button" aria-label={t("ssh.previous")} title={t("ssh.previous")} onClick={() => terminal.current?.search(query, true)}><AliIcon name="arrowup" size={15} /></button>
            <button type="submit" aria-label={t("ssh.next")} title={t("ssh.next")}><AliIcon name="arrowdown" size={15} /></button>
            <button type="button" aria-label={t("ssh.closeFind")} title={t("ssh.closeFind")} onClick={() => { setFindOpen(false); terminal.current?.search(""); terminal.current?.focus(); }}><AliIcon name="close" size={15} /></button>
          </form> : null}
          <div className={styles.terminalViewport}><TerminalSurface ref={terminal} terminalId={snapshot.id} transport="ssh" cwd="." subscribeToSSH={session.subscribe} inputEnabled={connected && !snapshot.busy && !linked} onError={setError} /></div>
          <footer className={styles.terminalFooter} role="status"><span>{t(snapshot.busy ? "ssh.executing" : linked ? "ssh.agentOwnsTerminal" : "ssh.interactive")}</span>{snapshot.busy ? <button type="button" disabled={!!busy} onClick={() => void action("stop")}>{t("ssh.stop")}</button> : null}</footer>
        </section>
        {filesOpen ? <div className={styles.splitter} role="separator" tabIndex={0} aria-label={t("ssh.split")} aria-orientation={wide ? "vertical" : "horizontal"} aria-valuemin={wide ? 40 : 35} aria-valuemax={Math.round(maxShare)} aria-valuenow={Math.round(share)}
          onKeyDown={event => { if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); resize(event.key === "Home" ? 35 : event.key === "End" ? 75 : share + (["ArrowRight", "ArrowDown"].includes(event.key) ? 3 : -3)); } }}
          onPointerDown={event => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); } }}
          onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = workarea.current?.getBoundingClientRect(); if (box) resize(100 * (wide ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height)); }}
          onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} /> : null}
        {filesMounted ? <div id="ssh-remote-files" className={styles.filesSlot} hidden={!filesOpen}><SSHFiles sessionId={snapshot.id} connected={connected} /></div> : null}
      </div>
      <footer className={styles.aiBar}><AliIcon name="brain" size={30} /><div className={styles.aiDescription}><strong>{t(linked ? sameTask ? "ssh.linked" : "ssh.linkedOther" : "ssh.manual")}</strong><p>{t(linked ? "ssh.linkedHint" : agentSessionId ? "ssh.manualHint" : "ssh.noTask")}</p></div>
        <button className={linked ? styles.secondary : styles.primary} disabled={!!busy || snapshot.busy || (!linked && (!agentSessionId || !connected))} onClick={() => void action("bind", "PATCH", { mode: linked ? "independent" : "agent-controlled", agentSessionId })}>{t(busy === "bind" ? "ssh.linking" : linked ? "ssh.unlink" : "ssh.link")}</button>
      </footer>
    </>}
  </section>;
}
