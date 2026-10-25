"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clearDraft, setDraft } from "@/lib/draft-store";
import { useI18n } from "@/hooks/useI18n";
import type { ChatCommandView } from "@/lib/chat-command-types";
import { AliIcon } from "./AliIcon";
import styles from "./ChatCommandCard.module.css";

export interface ChatCommandCardActions {
  retry(record: ChatCommandView): Promise<void>;
  restore(record: ChatCommandView, queryOnly?: boolean): Promise<void>;
  cancel(record: ChatCommandView): Promise<void>;
  copy(record: ChatCommandView): Promise<void>;
  openStats?(): void;
}

export function ChatCommandCard({ record, actions }: { record: ChatCommandView; actions: ChatCommandCardActions }) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const operation = record.operation;
  if (record.local && record.status === "accepted") return null;
  if (!operation) return null;
  const step = operation.steps[0];
  const queryStep = operation.steps[1];
  const finished = ["completed", "failed", "cancelled", "expired", "interrupted"].includes(record.status);
  const stepComplete = step.status === "completed";
  const status = stepComplete ? "completed" : finished ? record.status : operation.phase;
  const result = operation.result;
  const duration = (step.completedAt ?? operation.completedAt) && (step.startedAt ?? operation.startedAt)
    ? `${(((step.completedAt ?? operation.completedAt)! - (step.startedAt ?? operation.startedAt)!) / 1000).toFixed(1)}s` : null;
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setActionError(null);
    try { await action(); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };
  const cancellable = !record.local && (!finished && (record.status === "queued" || record.status === "accepted" || operation.phase === "waiting_client" || operation.steps.some(item => item.status === "running" && item.runId)));
  const failed = ["failed", "interrupted", "expired"].includes(status);
  return <section className={styles.card} aria-label={`/${operation.command.name} ${t(`chatCommands.${status}`)}`} data-command-id={record.commandId}>
    <header className={styles.header}>
      <button type="button" className={styles.summary} aria-expanded={expanded} aria-label={t(expanded ? "chatCommands.collapse" : "chatCommands.details")} onClick={() => setExpanded(value => !value)}>
        <span className={`${styles.indicator} ${stepComplete ? styles.success : failed ? styles.failure : ""}`}>
          <AliIcon name={stepComplete ? "check" : failed ? "warning" : "code"} size={15} />
        </span>
        <code>/{operation.command.name}</code>
        {operation.arguments && <span className={styles.preview}>{operation.arguments}</span>}
        <span className={`${styles.status} ${stepComplete ? styles.success : failed ? styles.failure : ""}`} role="status">{t(`chatCommands.${status}`)}</span>
        {duration && <span className={styles.duration}>{duration}</span>}
        <span className={styles.chevron} data-expanded={expanded}><AliIcon name="arrowright" size={11} /></span>
      </button>
      {cancellable && <button type="button" disabled={pending} className={styles.cancel} onClick={() => void run(() => actions.cancel(record))}>{t("chatCommands.cancel")}</button>}
    </header>
    {(record.errorMessage || result?.warnings?.length || result?.clientAction && !finished) && <div className={styles.feedback}>
      {record.errorMessage && <p role="alert" className={styles.failure}>{record.errorMessage}</p>}
      {result?.warnings?.map((warning, index) => <p key={index} className={styles.warning}>{warning}</p>)}
      {result?.clientAction && !finished && <button type="button" disabled={pending} onClick={() => void run(() => actions.copy(record))} className={styles.primary}><AliIcon name="copy" size={13} />{t("chatCommands.copy")} · {t("chatCommands.copyCharacters", { count: result.clientAction.characters })}</button>}
    </div>}
    {!expanded && result && <div className={styles.result}>
      {result.rename ? <span>{result.rename.before ? `${result.rename.before} → ` : ""}{result.rename.after}</span>
        : result.resources ? <span>{t("chatCommands.extensions", { count: result.resources.extensions })} · {t("chatCommands.skills", { count: result.resources.skills })} · {t("chatCommands.prompts", { count: result.resources.prompts })}</span>
        : result.compact?.tokensBefore !== undefined ? <span>{result.compact.tokensBefore.toLocaleString()} → {result.compact.tokensAfter?.toLocaleString() ?? "—"} tokens</span>
        : result.stats ? <span>{result.stats.totalMessages.toLocaleString(locale)} {t("chat.messages")} · {result.stats.tokens.total.toLocaleString(locale)} tokens</span>
        : result.details?.length ? <span>{result.details[0]}</span> : <span>{t(result.title)}</span>}
    </div>}
    {expanded && <div className={styles.body}>
      {result && <><strong>{t(result.title)}</strong>{result.message && <p>{t(result.message)}</p>}</>}
      {result?.resources && <div className={styles.resources}>
        <span>{t("chatCommands.extensions", { count: result.resources.extensions })}</span><span>{t("chatCommands.skills", { count: result.resources.skills })}</span><span>{t("chatCommands.prompts", { count: result.resources.prompts })}</span>
      </div>}
      {result?.rename && <p>{result.rename.before ? `${result.rename.before} → ` : ""}{result.rename.after}</p>}
      {result?.compact?.tokensBefore !== undefined && <p className={styles.numbers}>{result.compact.tokensBefore.toLocaleString()} → {result.compact.tokensAfter?.toLocaleString() ?? "—"} tokens</p>}
      {result?.stats && <p>{result.stats.totalMessages.toLocaleString(locale)} {t("chat.messages")} · {result.stats.tokens.total.toLocaleString(locale)} tokens</p>}
      <div className={styles.details}>
        <pre>{operation.rawText}</pre><time dateTime={new Date(record.acceptedAt).toISOString()}>{new Date(record.acceptedAt).toLocaleString(locale)}</time>
        {operation.command.sourceInfo && <p>{operation.command.sourceInfo.source} · {operation.command.sourceInfo.path}</p>}
        {result?.details?.map((detail, index) => <p key={index}>{detail}</p>)}{result?.compact?.summary && <p>{result.compact.summary}</p>}
      </div>
    </div>}
    {queryStep && <div className={styles.query}>
        <span>{t("chatCommands.query")} · {t(`chatCommands.${queryStep.status === "pending" ? "queryWaiting" : queryStep.status === "running" ? "model" : queryStep.status === "blocked" ? "failed" : queryStep.status}`)}</span><p>{operation.afterPrompt}</p>
        {queryStep.status === "blocked" && <p>{t("chatCommands.blockedQuery")}</p>}
        {finished && queryStep.status !== "completed" && <button type="button" disabled={pending} onClick={() => void run(() => actions.restore(record, true))}>{t("chatCommands.editQuery")}</button>}
    </div>}
    {(expanded || failed || result?.stats && actions.openStats) && <footer className={styles.footer}>
      {expanded && <span className={styles.meta}>{t(operation.command.source === "builtin" ? "chat.builtIn" : operation.command.source === "extension" ? "chat.extensions" : operation.command.source === "prompt" ? "chat.prompts" : "chat.skills")} · {record.local ? t("chatCommands.preparing") : t("chatCommands.saved")}</span>}
      <div className={styles.actions}>
        {result?.stats && actions.openStats && <button type="button" onClick={actions.openStats}>{t("chatCommands.stats")}</button>}
        {finished && (!queryStep || !stepComplete) && <button type="button" disabled={pending} onClick={() => void run(() => actions.retry(record))}>{t(record.status === "completed" ? "chatCommands.rerun" : "chatCommands.retry")}</button>}
        {finished && record.status !== "completed" && <button type="button" disabled={pending} onClick={() => void run(() => actions.restore(record))}>{t("chatCommands.restore")}</button>}
      </div>
    </footer>}
    {actionError && <div className={styles.actionError} role="alert">{actionError}</div>}
  </section>;
}

export interface ChatCommandQueueActions {
  recover(record: ChatCommandView): Promise<void>;
  cancel(record: ChatCommandView): Promise<void>;
  steer(record: ChatCommandView): Promise<void>;
  edit(record: ChatCommandView): Promise<string>;
  save(record: ChatCommandView, text: string): Promise<void>;
  resume(record: ChatCommandView): Promise<void>;
}

function QueuedCommandRow({ record, actions }: { record: ChatCommandView; actions: ChatCommandQueueActions }) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ bottom: number; right: number; maxHeight: number } | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const preparing = record.local === true;
  const draftKey = "queue-edit:" + record.commandId;
  const operation = record.operation;
  const preview = operation ? operation.steps[0]?.status === "completed" && operation.afterPrompt ? operation.afterPrompt : operation.rawText : record.preview ?? "";
  const run = async (action: () => Promise<void>) => {
    if (pending) return;
    setMenu(null); setPending(true); setError(null);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  const edit = () => run(async () => {
    const text = await actions.edit(record);
    setValue(text);
  });
  const editing = value !== null;
  useEffect(() => { if (editing) editor.current?.focus(); }, [editing]);
  const menuOpen = menu !== null;
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const dismiss = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenu(null);
    };
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setMenu({ bottom: window.innerHeight - rect.top + 6, right: Math.max(8, window.innerWidth - rect.right), maxHeight: Math.max(32, rect.top - 14) });
    };
    document.addEventListener("mousedown", dismiss);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { document.removeEventListener("mousedown", dismiss); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [menuOpen]);
  return <div className={styles.queueItem}>
    <div className={styles.queueRow}>
      <span className={styles.queueIcon} aria-hidden="true"><AliIcon name="menu" size={13} /></span>
      <button type="button" className={styles.queuePreview} title={preview} disabled={pending || preparing} onClick={() => void edit()}>{preparing ? t("chatCommands.preparing") + " · " : record.queuePaused ? t(editing ? "chatCommands.editing" : "chatCommands.paused") + " · " : ""}{preview}</button>
      {record.queuePaused && value === null && <button type="button" className={styles.queueMode} disabled={pending || preparing} onClick={() => void run(() => actions.resume(record))}>{t("chatCommands.resumeQueue")}</button>}
      <button type="button" className={styles.queueMode} disabled={pending || preparing || !!operation || !!record.queuePaused || value !== null} onClick={() => void run(() => actions.steer(record))}><AliIcon name="arrowdown" size={12} />{t("chat.steer")}</button>
      <button type="button" className={styles.queueAction} disabled={pending || preparing} title={t("chatCommands.cancel")} aria-label={t("chatCommands.cancel")} onClick={() => void run(() => actions.cancel(record))}><AliIcon name="delete" size={14} /></button>
      <button ref={trigger} type="button" className={styles.queueAction} disabled={pending || preparing || value !== null} title={t("chatCommands.options")} aria-label={t("chatCommands.options")} aria-haspopup="menu" aria-expanded={!!menu} onClick={event => {
        event.stopPropagation();
        if (event.detail > 1) return;
        const rect = trigger.current!.getBoundingClientRect();
        setMenu(menu ? null : { bottom: window.innerHeight - rect.top + 6, right: Math.max(8, window.innerWidth - rect.right), maxHeight: Math.max(32, rect.top - 14) });
      }}><AliIcon name="ellipsis" size={15} /></button>
    </div>
    {value !== null && <div className={styles.queueEditor}>
      <textarea ref={editor} aria-label={t("chatCommands.editMessage")} value={value} disabled={pending} onChange={event => { setValue(event.target.value); setDraft(draftKey, { value: event.target.value, images: [], files: [] }); }} />
      <div><span>{t("chatCommands.editingHint")}</span><button type="button" disabled={pending} onClick={() => void run(async () => { await actions.resume(record); clearDraft(draftKey); setValue(null); })}>{t("chatCommands.cancelEdit")}</button><button type="button" disabled={pending} onClick={() => void run(async () => { await actions.save(record, value); clearDraft(draftKey); setValue(null); })}>{t("chatCommands.saveQueue")}</button></div>
    </div>}
    {menu && createPortal(<div ref={menuRef} role="menu" aria-label={t("chatCommands.options")} className={styles.queueMenu} style={menu} onKeyDown={event => {
      const items = Array.from(menuRef.current!.querySelectorAll<HTMLButtonElement>("button"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") { setMenu(null); if (event.key === "Escape") { event.preventDefault(); trigger.current?.focus(); } }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    }}>
      <button type="button" role="menuitem" onClick={() => void edit()}>{t("chatCommands.editMessage")}</button>
      <button type="button" role="menuitem" onClick={() => void run(() => actions.cancel(record))}>{t("chatCommands.cancelQueue")}</button>
    </div>, document.body)}
    {error && <p role="alert" className={styles.queueError}>{error}</p>}
  </div>;
}

function UnsentCommandRow({ record, actions }: { record: ChatCommandView; actions: ChatCommandQueueActions }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recover = async () => {
    if (pending) return;
    setPending(true); setError(null);
    try { await actions.recover(record); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  return <div className={styles.queueItem}>
    <div className={styles.queueRow}>
      <span className={styles.queueIcon} aria-hidden="true"><AliIcon name="menu" size={13} /></span>
      <button type="button" className={styles.queuePreview} title={record.preview} disabled={pending} onClick={() => void recover()}>{record.preview}</button>
      <span className={styles.queueMode}>{t("chatCommands.unsent")}</span>
      <button type="button" className={styles.queueMode} disabled={pending} onClick={() => void recover()}>{t("chatCommands.editMessage")}</button>
    </div>
    {(error || record.errorMessage) && <p role="alert" className={styles.queueError}>{error || record.errorMessage}</p>}
  </div>;
}

export function ChatCommandQueue({ records, actions, pendingMessages, onRecall }: { records: ChatCommandView[]; actions: ChatCommandQueueActions; pendingMessages?: { steering: string[]; followUp: string[] } | null; onRecall?: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [recalling, setRecalling] = useState(false);
  const waiting = records.filter(record => record.status === "queued" || record.status === "accepted");
  const delivered = [...(pendingMessages?.steering ?? []).map(text => ({ text, label: t("chat.steer") })), ...(pendingMessages?.followUp ?? []).map(text => ({ text, label: t("chat.followUp") }))];
  const unsent = records.filter(record => !record.operation && ["failed", "interrupted", "expired"].includes(record.status));
  if (!waiting.length && !delivered.length && !unsent.length) return null;
  return <section className={styles.queue} aria-label={t("chatCommands.next")}>
    <div className={styles.queueList}>
      {delivered.map(({ text, label }, index) => <div key={`delivered-${index}`} className={styles.queueItem} role="status">
        <div className={styles.queueRow}>
          <span className={styles.queueIcon} aria-hidden="true"><AliIcon name="arrowright" size={13} /></span>
          <span className={styles.queuePreview} title={text}>{text}</span>
          <span className={styles.queueMode}>{label}</span>
          {index === 0 && onRecall && <button type="button" className={styles.queueAction} disabled={recalling} onClick={() => { setRecalling(true); void Promise.resolve().then(onRecall).finally(() => setRecalling(false)); }} title={t("chat.recallTitle")} aria-label={t("chat.recall")}><AliIcon name="history" size={14} /></button>}
        </div>
      </div>)}
      {unsent.map(record => <UnsentCommandRow key={record.commandId} record={record} actions={actions} />)}
      {waiting.map(record => <QueuedCommandRow key={record.commandId} record={record} actions={actions} />)}
    </div>
  </section>;
}
