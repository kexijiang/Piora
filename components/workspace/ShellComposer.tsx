"use client";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { shellRequest } from "@/lib/shell/client";
import type { ShellCompletion, ShellInputMode, ShellReference, ShellSession } from "@/lib/shell/types";
import { AliIcon } from "../AliIcon";
import { ShellModelSelect } from "./ShellModelSelect";
import styles from "./SmartShell.module.css";

export interface ShellComposerHandle { fill(text: string, mode?: ShellInputMode): void; reference(value: ShellReference): void }
interface Props { session: ShellSession; onSubmit: (text: string, mode: ShellInputMode, references: ShellReference[]) => Promise<"accepted" | "ambiguous" | "failed">; onHistory: () => void; onError: (error: string) => void }
export const ShellComposer = forwardRef<ShellComposerHandle, Props>(function ShellComposer({ session, onSubmit, onHistory, onError }, ref) {
  const { t } = useI18n(); const listId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const storageKey = `piora-shell-draft:${session.id}`;
  const contextKey = `piora-shell-composer:${session.id}`;
  const [initialContext] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(contextKey) || "null");
      const mode: ShellInputMode = saved?.mode === "command" || saved?.mode === "agent" ? saved.mode : "auto";
      const references: ShellReference[] = Array.isArray(saved?.references) ? saved.references.filter((item: ShellReference) => item && ["file", "message", "command"].includes(item.kind) && typeof item.label === "string").slice(0, 12).map((item: ShellReference) => ({ kind: item.kind, label: item.label.slice(0, 300), ...(typeof item.path === "string" ? { path: item.path.slice(0, 4096) } : {}), ...(typeof item.text === "string" ? { text: item.text.slice(0, 16000) } : {}), ...(typeof item.sourceId === "string" ? { sourceId: item.sourceId.slice(0, 160) } : {}) })) : [];
      return { mode, references };
    } catch { return { mode: "auto" as ShellInputMode, references: [] as ShellReference[] }; }
  });
  const [text, setText] = useState(() => { try { return localStorage.getItem(storageKey) ?? session.draft; } catch { return session.draft; } });
  const [mode, setMode] = useState<ShellInputMode>(initialContext.mode);
  const [intent, setIntent] = useState("ambiguous");
  const [references, setReferences] = useState<ShellReference[]>(initialContext.references);
  const [suggestions, setSuggestions] = useState<ShellCompletion[]>([]);
  const [open, setOpen] = useState(false); const [selected, setSelected] = useState(-1);
  const [sending, setSending] = useState(false); const [ambiguous, setAmbiguous] = useState(false);
  const [addFile, setAddFile] = useState(false); const [file, setFile] = useState("");
  const currentText = useRef(text); const busy = useRef(false);
  useEffect(() => { try { localStorage.setItem(contextKey, JSON.stringify({ mode, references })); } catch (cause) { onError(String(cause)); } }, [contextKey, mode, references, onError]);
  const change = (value: string) => {
    currentText.current = value; setText(value); setAmbiguous(false); setSelected(-1);
    try { localStorage.setItem(storageKey, value); } catch (cause) { onError(String(cause)); }
  };
  useImperativeHandle(ref, () => ({ fill: (value, nextMode = "command") => { change(value); setMode(nextMode); input.current?.focus(); }, reference: value => { setReferences(current => [...current, value].slice(-12)); input.current?.focus(); } }));
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void shellRequest<{ completions: ShellCompletion[]; intent: string }>(`sessions/${session.id}/completions?q=${encodeURIComponent(text)}`, undefined, { signal: controller.signal }).then(result => { setSuggestions(result.completions.slice(0, 8)); setIntent(result.intent); }).catch(() => {});
    }, 100);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [text, session.id]);
  useEffect(() => {
    const timer = setTimeout(() => { void shellRequest(`sessions/${session.id}`, { draft: text }, { method: "PATCH" }).catch(cause => onError(String(cause))); }, 400);
    return () => clearTimeout(timer);
  }, [text, session.id, onError]);
  const choose = (value: string) => { change(value); setOpen(false); input.current?.focus(); };
  const submit = async (forced?: ShellInputMode) => {
    if (!currentText.current.trim() || busy.current || session.owner === "agent") return;
    const original = currentText.current; busy.current = true; setSending(true); setOpen(false);
    try {
      const result = await onSubmit(original, forced || mode, references);
      if (result === "accepted" && currentText.current === original) { change(""); setReferences(current => current.filter(item => !references.includes(item))); }
      else if (result === "ambiguous") setAmbiguous(true);
    } finally { busy.current = false; setSending(false); }
  };
  const visible = open && mode !== "agent" && suggestions.length > 0;
  const disabled = sending || session.owner === "agent";
  return <div className={styles.composer} onKeyDown={event => event.stopPropagation()}>
    {visible ? <div className={styles.suggestions}>
      <div className={styles.suggestionHeading}>{t("shell.suggestions")}</div>
      <div role="listbox" id={listId} aria-label={t("shell.history")}>{suggestions.map((item, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={selected === index} key={item.value} onMouseDown={event => event.preventDefault()} onClick={() => choose(item.value)} onMouseEnter={() => setSelected(index)} title={item.detail}><AliIcon name={item.kind === "directory" ? "folder" : item.kind === "file" ? "file" : "history"} size={14} /><span className={styles.suggestionContent}><code>{item.label}</code><small>{item.detail || t(`shell.completion.${item.kind}`)}</small></span></button>)}</div>
      <div className={styles.suggestionHint}>{t("shell.suggestionHint")}</div>
    </div> : null}
    {references.length ? <div className={styles.references}>{references.map((reference, index) => <button key={`${reference.label}:${index}`} title={t("shell.removeReference")} onClick={() => setReferences(items => items.filter((_, itemIndex) => itemIndex !== index))}>@ {reference.label} ×</button>)}</div> : null}
    {addFile ? <form className={styles.inlineInput} onSubmit={event => { event.preventDefault(); if (file.trim()) { setReferences(items => [...items, { kind: "file" as const, label: file, path: file }].slice(-12)); setFile(""); setAddFile(false); } }}><input aria-label={t("shell.filePath")} value={file} onChange={event => setFile(event.target.value)} placeholder={t("shell.filePath")} /><button type="submit">{t("shell.add")}</button></form> : null}
    {ambiguous ? <div className={styles.approval}><span>{t("shell.ambiguous")}</span><div><button onClick={() => { setMode("command"); void submit("command"); }}>{t("shell.command")}</button><button onClick={() => { setMode("agent"); void submit("agent"); }}>{t("shell.agent")}</button></div></div> : null}
    <form className={styles.inputFrame} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea ref={input} value={text} role="combobox" aria-label={t("shell.placeholder")} aria-autocomplete="list" aria-expanded={visible} aria-controls={visible ? listId : undefined} aria-activedescendant={visible && selected >= 0 ? `${listId}-${selected}` : undefined}
        placeholder={t("shell.placeholder")} spellCheck={false} onChange={event => { change(event.target.value); setOpen(true); }} onBlur={() => setOpen(false)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); return; }
          if (event.ctrlKey && event.key.toLowerCase() === "r") { event.preventDefault(); onHistory(); }
          else if (event.key === "Escape") { setOpen(false); setSelected(-1); }
          else if (event.key === "ArrowDown" && suggestions.length && mode !== "agent") { event.preventDefault(); setOpen(true); setSelected(index => (index + 1) % suggestions.length); }
          else if (event.key === "ArrowUp" && suggestions.length && mode !== "agent" && (!text.includes("\n") || visible)) { event.preventDefault(); setOpen(true); setSelected(index => index <= 0 ? suggestions.length - 1 : index - 1); }
          else if (visible && ((event.key === "Tab" && !event.shiftKey) || event.key === "Enter" && !event.shiftKey && selected >= 0)) { event.preventDefault(); choose(suggestions[Math.max(0, selected)].value); }
          else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
        }} />
      <div className={styles.inputBar}>
        <select aria-label={t("shell.auto")} value={mode} onChange={event => setMode(event.target.value as ShellInputMode)}>{["auto", "command", "agent"].map(value => <option key={value} value={value}>{t(`shell.${value}`)}{value === "auto" && intent !== "ambiguous" ? ` · ${t(`shell.${intent}`)}` : ""}</option>)}</select>
        <ShellModelSelect cwd={session.cwd} inherited value={session.model} onChange={model => { void shellRequest(`sessions/${session.id}`, { model }, { method: "PATCH" }).catch(cause => onError(String(cause))); }} />
        <button type="button" title={t("shell.addFile")} aria-label={t("shell.addFile")} onClick={() => setAddFile(value => !value)}><AliIcon name="file" size={14} /></button>
        <button type="button" title={t("shell.addSelection")} aria-label={t("shell.addSelection")} onMouseDown={event => event.preventDefault()} onClick={() => { const selection = window.getSelection()?.toString(); if (selection?.trim()) setReferences(items => [...items, { kind: "message" as const, label: selection.slice(0, 35), text: selection.slice(0, 16000) }].slice(-12)); }}>@</button>
        <button type="button" title={t("shell.history")} aria-label={t("shell.history")} onClick={onHistory}><AliIcon name="history" size={14} /></button>
        <span className={styles.spacer} />
        <button type="submit" className={styles.sendButton} title={t("shell.send")} aria-label={t("shell.send")} disabled={disabled || !text.trim()}><AliIcon name="send" size={17} /></button>
      </div>
    </form>
    <span className={styles.hint}>{t("shell.hint")}</span>
  </div>;
});
