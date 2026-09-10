"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useSmartShell } from "@/hooks/useSmartShell";
import { useAgentTerminal } from "@/hooks/useAgentTerminal";
import { copyText } from "@/lib/clipboard";
import { stripAnsi } from "@/lib/ansi";
import { shellRequest, resolveShellOutputFile } from "@/lib/shell/client";
import { migrateLegacyShellHistory } from "@/lib/shell/legacy-history";
import type { CommandBlock, ShellReference, ShellRun } from "@/lib/shell/types";
import { AliIcon } from "../AliIcon";
import { MarkdownBody } from "../MarkdownBody";
import { VirtualList } from "../VirtualList";
import { TerminalSurface } from "./TerminalSurface";
import { ShellComposer, type ShellComposerHandle } from "./ShellComposer";
import { ShellHistory } from "./ShellHistory";
import { ShellFavoriteButton } from "./ShellFavoriteButton";
import styles from "./SmartShell.module.css";

export interface SmartShellPanelProps { cwd: string; sessionId?: string | null; onClose?: () => void; onToChat?: (text: string) => void; onOpenFile?: (file: string) => void; onOpenUrl?: (url: string) => void; onSettings?: () => void }
const CommandCard = memo(function CommandCard({ block, onEdit, onReference, onToChat, onOpenFile, onOpenUrl, onError }: { block: CommandBlock; onEdit: (value: string, agent?: boolean) => void; onReference: (reference: ShellReference) => void; onToChat?: (text: string) => void; onOpenFile?: (file: string) => void; onOpenUrl?: (url: string) => void; onError: (error: string) => void }) {
  const { t } = useI18n(); const [expanded, setExpanded] = useState(true);
  const output = useMemo(() => stripAnsi(block.output), [block.output]);
  const links = useMemo(() => [...new Set(output.match(/https?:\/\/[^\s<>"\x1b]+/g) || [])].slice(0, 5), [output]);
  const files = useMemo(() => [...new Set(output.match(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])[^\r\n"<>|]*?\.[a-zA-Z0-9]{1,8}(?::\d+(?::\d+)?)?/g) || [])].slice(0, 5), [output]);
  const reference: ShellReference = { kind: "command", label: block.command.slice(0, 55), sourceId: block.id, text: `$ ${block.command}\n[cwd: ${block.cwd}]\n${output.slice(-16000)}` };
  const copy = (value: string) => { void copyText(value).catch(cause => onError(String(cause))); };
  return <article className={styles.block} data-status={block.status}>
    <div className={styles.blockHeading}><button aria-expanded={expanded} onClick={() => setExpanded(value => !value)} aria-label={block.command}>{expanded ? "⌄" : "›"}</button><code>{block.command}</code><small>{t(`shell.status.${block.status}`)}</small></div>
    <div className={styles.blockMeta}><span title={block.cwd}>{block.cwd}</span><span>{block.source === "shell-agent" ? "Agent" : block.shell}</span>{block.endedAt && block.startedAt ? <span>{((block.endedAt - block.startedAt) / 1000).toFixed(1)}s</span> : null}{block.exitCode !== null ? <span>exit {block.exitCode}</span> : null}</div>
    {expanded ? <><pre>{output || t("shell.noOutput")}</pre>{block.outputTruncated ? <div className={styles.hint}>{t("shell.outputTruncated")}</div> : null}{links.length || files.length ? <div className={styles.blockActions}>{links.map(url => <button key={url} onClick={() => onOpenUrl?.(url.replace(/[),.;]+$/, ""))}>{url}</button>)}{files.map(file => <button key={file} onClick={() => { const resolved = resolveShellOutputFile(file, block.cwd); if (resolved) onOpenFile?.(resolved); }}>{file}</button>)}</div> : null}</> : null}
    <div className={styles.blockActions}>
      <button title={t("shell.copyCommand")} aria-label={t("shell.copyCommand")} onClick={() => copy(block.command)}><AliIcon name="copy" size={12} /></button>
      <button onClick={() => copy(output)}>{t("shell.copyOutput")}</button><button onClick={() => onEdit(block.command)}>{t("shell.edit")}</button>
      <button onClick={() => onReference(reference)}>{t("shell.reference")}</button>
      <ShellFavoriteButton id={block.id} onError={onError} />
      {onToChat ? <button onClick={() => onToChat(reference.text!)}>{t("shell.toChat")}</button> : null}
      {block.status === "failed" ? <><button onClick={() => { onReference(reference); onEdit(`${t("shell.explain")}: ${block.command}`, true); }}>{t("shell.explain")}</button><button className={styles.primary} onClick={() => { onReference(reference); onEdit(`${t("shell.fix")}: ${block.command}`, true); }}>{t("shell.fix")}</button></> : null}
    </div>
  </article>;
});

function RunCard({ run, action, onContinue, onToChat, onOpenFile }: { run: ShellRun; action: (body: object) => Promise<unknown>; onContinue: () => void; onToChat?: (text: string) => void; onOpenFile?: (file: string) => void }) {
  const { t } = useI18n(); const [answer, setAnswer] = useState("");
  const act = (body: object) => { void action(body).catch(() => {}); };
  return <article className={styles.run} data-status={run.status}>
    <div className={styles.runPrompt}><AliIcon name="code" size={16} /><span>{run.prompt}</span></div>
    <div className={styles.blockMeta}><span>{run.model ? `${run.model.provider}/${run.model.modelId}` : "Agent"}</span><span>{t(`shell.status.${run.status}`)}</span><span>{run.steps}</span></div>
    {run.response ? <MarkdownBody className={styles.response} isStreaming={run.status === "running"} onOpenFile={onOpenFile}>{run.response}</MarkdownBody> : null}
    {run.approval ? <div className={styles.approval}><strong>{t("shell.approval")}</strong><pre>{run.approval.command}</pre><code>{run.approval.cwd}</code><p>{run.approval.reason}</p><div><button className={styles.primary} onClick={() => act({ action: "approve", id: run.approval!.id })}>{t("shell.approve")}</button><button onClick={() => act({ action: "reject", id: run.approval!.id })}>{t("shell.reject")}</button></div></div> : null}
    {run.status === "awaiting_input" && run.question ? <form className={styles.approval} onSubmit={event => { event.preventDefault(); act({ action: "answer", id: run.id, answer }); setAnswer(""); }}><p>{run.question}</p><input value={answer} aria-label={t("shell.answer")} onChange={event => setAnswer(event.target.value)} /><div><button type="submit" disabled={!answer.trim()}>{t("shell.answer")}</button><button type="button" onClick={() => act({ action: "takeover" })}>{t("shell.takeover")}</button></div></form> : null}
    {run.error ? <div className={styles.error}>{run.error}</div> : null}
    <div className={styles.blockActions}>{["completed", "failed", "cancelled", "interrupted"].includes(run.status) ? <button onClick={onContinue}>{t("shell.continue")}</button> : null}{onToChat && run.response ? <button onClick={() => onToChat(`${run.prompt}\n\n${run.response}`)}>{t("shell.toChat")}</button> : null}</div>
  </article>;
}

export function SmartShellPanel({ cwd, sessionId, onClose, onToChat, onOpenFile, onOpenUrl, onSettings }: SmartShellPanelProps) {
  const { t } = useI18n(); const shell = useSmartShell(cwd); const main = useAgentTerminal(sessionId);
  const [view, setView] = useState<"blocks" | "native" | "main" | "history">("blocks");
  const composer = useRef<ShellComposerHandle>(null); const scroller = useRef<HTMLDivElement>(null);
  const state = shell.snapshot?.session;
  const duplicateTitles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of shell.sessions) counts.set(session.title, (counts.get(session.title) || 0) + 1);
    return counts;
  }, [shell.sessions]);
  const rows = useMemo(() => {
    if (!shell.snapshot) return [];
    return [...shell.snapshot.commands.map(block => ({ kind: "command" as const, id: block.id, timestamp: block.startedAt || Number.MAX_SAFE_INTEGER, block })), ...shell.snapshot.runs.map(run => ({ kind: "run" as const, id: run.id, timestamp: run.startedAt, run }))].sort((a, b) => a.timestamp - b.timestamp);
  }, [shell.snapshot]);
  const rowMap = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows]);
  const keys = useMemo(() => rows.map(row => row.id), [rows]);
  const fill = (text: string, agent = false) => { setView("blocks"); composer.current?.fill(text, agent ? "agent" : "command"); };
  const reference = (value: ShellReference) => composer.current?.reference(value);
  const act = (body: object) => { void shell.action(body).catch(() => {}); };
  const native = view === "native" || view === "blocks" && state?.integration === "unavailable";
  const reportError = shell.setError;
  useEffect(() => {
    void Promise.resolve().then(() => migrateLegacyShellHistory(localStorage, entries => shellRequest("history/migrate", { entries }))).catch(cause => reportError(String(cause)));
  }, [reportError]);
  return <section className={styles.root} aria-label={t("shell.title")}>
    <header className={styles.header}><div className={styles.brand}><AliIcon name="code" size={18} /><strong>{t("shell.title")}</strong></div>{onSettings ? <button title={t("shell.settings")} aria-label={t("shell.settings")} onClick={onSettings}><AliIcon name="setting" size={15} /></button> : null}<button title={t("shell.new")} aria-label={t("shell.new")} onClick={() => void shell.create()}><AliIcon name="plus" size={16} /></button>{onClose ? <button title={t("workspace.closeTool")} aria-label={t("workspace.closeTool")} onClick={onClose}><AliIcon name="close" size={15} /></button> : null}</header>
    <div className={styles.tabs} role="tablist" aria-label={t("shell.title")}>{shell.sessions.map(session => <div key={session.id} className={styles.terminalTab} data-active={session.id === shell.activeId}><button role="tab" aria-selected={session.id === shell.activeId} title={`${session.cwd} · ${session.profile.label}`} onClick={() => shell.select(session.id)}>{session.activeRunId || session.activeCommandId ? "● " : ""}{session.title || session.profile.label}{(duplicateTitles.get(session.title) || 0) > 1 ? ` · ${session.id.slice(0, 4)}` : ""}</button><button title={t("shell.close")} aria-label={`${t("shell.close")} ${session.title}`} disabled={Boolean(session.activeRunId || session.activeCommandId)} onClick={() => void shell.close(session.id)}>×</button></div>)}</div>
    <div className={styles.locationBar}><span className={styles.cwd} title={state?.cwd || cwd}><AliIcon name="folder" size={14} />{state?.cwd || cwd}</span><span className={styles.status} data-ready={state?.connected && shell.connected}><i />{state?.profile.label || t("shell.connecting")}</span></div>
    <div className={styles.toolbar}><div className={styles.views} role="tablist">{(["blocks", "native", "main", "history"] as const).map(value => <button key={value} role="tab" aria-selected={view === value} onClick={() => setView(value)}>{t(value === "main" ? "shell.mainCommands" : `shell.${value}`)}</button>)}</div></div>
    {shell.error ? <div className={styles.error} role="alert">{shell.error}<button onClick={() => shell.setError("")}>×</button></div> : null}
    {shell.pending.filter(item => item.terminalId === shell.activeId).map(item => <div className={styles.recovery} key={item.clientRequestId}><div>{t("shell.recovery")}</div><code>{item.text.slice(0, 100)}</code><button onClick={() => void shell.submit(item.text, item.mode, item.references, item)}>{t("shell.retry")}</button></div>)}
    <div className={styles.body}>
      {state ? <div hidden={!native} className={styles.native}><TerminalSurface key={state.id} cwd={state.initialCwd} terminalId={state.id} subscribeToShell={shell.subscribe} inputEnabled={state.owner === "human"} onError={shell.setError} /></div> : null}
      {view === "history" && state ? <ShellHistory terminalId={state.id} cwd={state.cwd} onChoose={command => fill(command)} /> : view === "main" ? <div className={styles.scroll}>{main.commands.map(item => <article className={styles.block} key={item.id}><div className={styles.blockHeading}><code>{item.command}</code><small>{t(`shell.status.${item.status}`)}</small></div><pre>{stripAnsi(item.output)}</pre><div className={styles.blockActions}><button onClick={() => fill(item.command)}>{t("shell.edit")}</button><button onClick={() => reference({ kind: "command", label: item.command.slice(0, 50), sourceId: item.id, text: `$ ${item.command}\n${stripAnsi(item.output).slice(-16000)}` })}>{t("shell.reference")}</button></div></article>)}</div> : !native ? rows.length ? <div className={styles.scroll} ref={scroller}>{shell.hasOlder || shell.loadingOlder ? <div className={styles.blockActions}><button disabled={shell.loadingOlder} onClick={() => void shell.loadOlder()}>{t("shell.loadMore")}</button></div> : null}<VirtualList keys={keys} estimate={180} scrollContainer={scroller} initialTail renderItem={key => {
        const row = rowMap.get(key)!;
        return row.kind === "command" ? <CommandCard block={row.block} onEdit={fill} onReference={reference} onToChat={onToChat} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} onError={shell.setError} /> : <RunCard run={row.run} action={shell.action} onContinue={() => fill(`${t("shell.continue")}: ${row.run.prompt}`, true)} onToChat={onToChat} onOpenFile={onOpenFile} />;
      }} /></div> : <div className={styles.empty}><AliIcon name="code" size={34} /><strong>{t("shell.empty")}</strong><p>{t("shell.startHint")}</p>{!state ? <button onClick={() => void shell.create()}>{t("shell.new")}</button> : null}</div> : null}
    </div>
    {state ? <><div className={styles.controlBar}><span className={styles.status} data-ready={state.connected}><i />{state.owner === "agent" ? t("shell.agentWorking") : state.activeCommandId ? t("shell.busy") : t(state.connected ? "shell.ready" : "shell.offline")}</span><div className={styles.controlActions}>{state.owner === "agent" ? <button className={styles.outline} onClick={() => { setView("native"); act({ action: "takeover" }); }}>{t("shell.takeover")}</button> : <><button title={t("shell.clear")} aria-label={t("shell.clear")} onClick={() => act({ action: "clear" })}><AliIcon name="clear" size={13} /></button><button title={t("shell.restart")} aria-label={t("shell.restart")} disabled={Boolean(state.activeCommandId)} onClick={() => act({ action: "restart" })}><AliIcon name="reload" size={13} /></button></>}{state.activeRunId || state.activeCommandId ? <button className={styles.outline} title={t("shell.cancel")} aria-label={t("shell.cancel")} onClick={() => act({ action: "cancel" })}><span className={styles.stopIcon} /></button> : null}</div></div>
      {state.integration === "unavailable" ? <div className={styles.error}>{t("shell.integrationUnavailable")}</div> : null}
      <ShellComposer key={state.id} ref={composer} session={state} onSubmit={shell.submit} onHistory={() => setView("history")} onError={shell.setError} />
    </> : null}
  </section>;
}
