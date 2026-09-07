"use client";

import {
  useEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  findJsonSyntaxIssue,
  runJsonWorkbenchAction,
  smartFormatJson,
  parseJsonValue,
  type JsonWorkbenchAction,
  type JsonWorkbenchOptions,
} from "@/lib/json-workbench";
import type { CompanionLibraryItem } from "@/lib/companion-store";
import { JsonCodeEditor, type JsonCodeEditorHandle, type JsonEditorShortcut } from "./JsonCodeEditor";
import styles from "./JsonWorkbench.module.css";
import { AliIcon } from "./AliIcon";
import { copyText, readClipboardText } from "@/lib/clipboard";

const STORAGE_KEY = "piora-json-workbench-v1";
const TEMP_DRAFT_ID = "temp";
const MAX_DRAFTS = 12;
const MAX_CONTENT_LENGTH = 200_000;
const MAX_LIBRARY_RESULT_LENGTH = 200_000;
const EMPTY_LIBRARY: readonly CompanionLibraryItem[] = [];

interface JsonDraft {
  content: string;
  favorite: boolean;
  id: string;
  title: string;
}

interface StoredWorkbench {
  activeId?: unknown;
  autoExtract?: unknown;
  drafts?: unknown;
  indent?: unknown;
  multiEscape?: unknown;
  temporaryTitle?: unknown;
  temporaryContent?: unknown;
  wrap?: unknown;
  fileRevision?: unknown;
  pending?: unknown;
}

interface TextTarget {
  end: number;
  kind: "all" | "number" | "quoted" | "selection";
  outerEnd?: number;
  outerStart?: number;
  start: number;
  text: string;
}

function workbenchFingerprint(value: StoredWorkbench | null | undefined): string {
  if (!value) return "";
  const drafts = Array.isArray(value.drafts) ? value.drafts.map((draft) =>
    draft && typeof draft === "object" ? [draft.id, draft.title, draft.content, draft.favorite === true] : null) : [];
  return JSON.stringify([value.activeId, value.autoExtract !== false, drafts, value.indent === 2 ? 2 : 4,
    value.multiEscape !== false, value.temporaryTitle, value.temporaryContent, value.wrap === true]);
}

interface SavedJsonResult {
  content: string;
  language: string;
  title: string;
}

interface Props {
  busy?: boolean;
  compact?: boolean;
  library?: readonly CompanionLibraryItem[];
  onSaveResult?: (result: SavedJsonResult) => boolean | void | Promise<boolean | void>;
}

const TEMP_DRAFT: JsonDraft = { content: "", favorite: true, id: TEMP_DRAFT_ID, title: "temp" };

const ACTION_LABELS: Record<Exclude<JsonWorkbenchAction, "format">, string> = {
  base64: "Base64",
  escape: "companion.json.escapeInline",
  "form-data": "form-data",
  get: "GET",
  minify: "companion.json.action.minify",
  "minify-escape": "companion.json.minifyEscapeInline",
  "multi-unescape": "companion.json.multiUnescapeInline",
  serialize: "serialize",
  timestamp: "companion.json.timestamp",
  unescape: "companion.json.action.unescape",
  unicode: "Unicode",
  url: "URL",
  utf8: "UTF-8",
};

function createDraft(title: string, content = ""): JsonDraft {
  return {
    content: content.slice(0, MAX_CONTENT_LENGTH),
    favorite: false,
    id: `json:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`,
    title: title.trim().slice(0, 80) || "JSON",
  };
}

function isUnescapedQuote(content: string, index: number): boolean {
  if (content[index] !== '"') return false;
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 0;
}

function quotedTarget(content: string, cursor: number): TextTarget | null {
  const lineStart = content.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const nextLine = content.indexOf("\n", cursor);
  const lineEnd = nextLine === -1 ? content.length : nextLine;
  let start = -1;
  for (let index = Math.min(cursor - 1, lineEnd - 1); index >= lineStart; index -= 1) {
    if (isUnescapedQuote(content, index)) {
      start = index;
      break;
    }
  }
  if (start === -1) return null;
  for (let end = Math.max(cursor, start + 1); end < lineEnd; end += 1) {
    if (isUnescapedQuote(content, end)) {
      return {
        end,
        kind: "quoted",
        outerEnd: end + 1,
        outerStart: start,
        start: start + 1,
        text: content.slice(start + 1, end),
      };
    }
  }
  return null;
}

function numberTarget(content: string, cursor: number): TextTarget | null {
  let start = cursor;
  let end = cursor;
  while (start > 0 && /\d/.test(content[start - 1])) start -= 1;
  while (end < content.length && /\d/.test(content[end])) end += 1;
  if (start === end) return null;
  const text = content.slice(start, end);
  return /^\d{10}$|^\d{13}$/.test(text) ? { end, kind: "number", start, text } : null;
}

function restoreDrafts(value: unknown, temporaryTitle?: unknown): JsonDraft[] {
  const restoredTemporaryTitle = typeof temporaryTitle === "string" ? temporaryTitle.trim().slice(0, 80) : "";
  const temporaryDraft = { ...TEMP_DRAFT, title: restoredTemporaryTitle || TEMP_DRAFT.title };
  if (!Array.isArray(value)) return [temporaryDraft];
  const restored = value.slice(0, MAX_DRAFTS - 1).flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const draft = candidate as Record<string, unknown>;
    const content = typeof draft.content === "string" ? draft.content.slice(0, MAX_CONTENT_LENGTH) : "";
    const title = typeof draft.title === "string" ? draft.title.trim().slice(0, 80) : "";
    const id = typeof draft.id === "string" && /^json:[a-zA-Z0-9-]+$/.test(draft.id) ? draft.id : `json:restored-${index + 1}`;
    return title ? [{ content, favorite: draft.favorite === true, id, title }] : [];
  });
  return [temporaryDraft, ...restored];
}

export function JsonWorkbench({ busy = false, compact = false, library = EMPTY_LIBRARY, onSaveResult }: Props) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<JsonDraft[]>([TEMP_DRAFT]);
  const [activeId, setActiveId] = useState(TEMP_DRAFT_ID);
  const [autoExtract, setAutoExtract] = useState(true);
  const [indent, setIndent] = useState<2 | 4>(4);
  const [multiEscape, setMultiEscape] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [restored, setRestored] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [storageMessage, setStorageMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const revisionRef = useRef<number | null>(null);
  const savedFingerprintRef = useRef("");
  const saveQueueRef = useRef(Promise.resolve());
  const saveGenerationRef = useRef(0);
  const importRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<JsonCodeEditorHandle>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const preservePasteErrorRef = useRef(false);

  const activeDraft = drafts.find((draft) => draft.id === activeId) ?? drafts[0];
  const reusableLibrary = useMemo(() => library.filter((item) => item.kind !== "image"), [library]);
  const options: JsonWorkbenchOptions = { extractJson: autoExtract, indent, multiEscape, removeNbsp: true };
  const deferredContent = useDeferredValue(activeDraft.content);
  const validation = useMemo(() => {
    if (!deferredContent.trim()) return "empty";
    try { parseJsonValue(deferredContent); return "valid"; } catch { return "invalid"; }
  }, [deferredContent]);

  useEffect(() => {
    const applyStored = (parsed: StoredWorkbench | null) => {
      if (parsed && typeof parsed === "object") {
        const nextDrafts = restoreDrafts(parsed.drafts, parsed.temporaryTitle);
        if (typeof parsed.temporaryContent === "string") nextDrafts[0].content = parsed.temporaryContent.slice(0, MAX_CONTENT_LENGTH);
        setDrafts(nextDrafts);
        setActiveId(typeof parsed.activeId === "string" && nextDrafts.some((draft) => draft.id === parsed.activeId)
          ? parsed.activeId : TEMP_DRAFT_ID);
        setAutoExtract(parsed.autoExtract !== false);
        setIndent(parsed.indent === 2 ? 2 : 4);
        setMultiEscape(parsed.multiEscape !== false);
        setWrap(parsed.wrap === true);
      }
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let disposed = false;
    let local: StoredWorkbench | null = null;
    try { local = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); } catch { /* The file is authoritative when a browser backup is corrupt. */ }
    void fetch("/api/companion/json-workspace", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || typeof payload.revision !== "number") throw new Error(payload.error || "JSON 草稿读取失败。");
      if (disposed) return;
      savedFingerprintRef.current = workbenchFingerprint(payload.workbench);
      const matchesFile = workbenchFingerprint(local) === savedFingerprintRef.current;
      const recover = local?.pending === true && !matchesFile;
      applyStored(recover || !payload.workbench ? local : payload.workbench);
      if (recover && local?.fileRevision !== payload.revision) {
        setStorageError(true); setStorageMessage("已恢复浏览器中未保存的内容；磁盘文件也有更新，请先导出备份再重新打开。");
      } else { revisionRef.current = payload.revision; setStorageError(false); }
    }).catch((cause: unknown) => {
      if (!disposed) { applyStored(local); setStorageError(true); setStorageMessage(`本地草稿读取失败，已使用浏览器备份：${String(cause)}`); }
    }).finally(() => { clearTimeout(timeout); if (!disposed) setRestored(true); });
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); };
  }, []);

  useEffect(() => {
    if (!restored) return;
    const generation = ++saveGenerationRef.current;
    const storedDrafts = drafts.filter((draft) => draft.id !== TEMP_DRAFT_ID);
    const temporaryTitle = drafts.find((draft) => draft.id === TEMP_DRAFT_ID)?.title;
    const temporaryContent = drafts.find((draft) => draft.id === TEMP_DRAFT_ID)?.content;
    const workbench = { activeId, autoExtract, drafts: storedDrafts, indent, multiEscape, temporaryTitle, temporaryContent, wrap };
    const backup = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...workbench, fileRevision: revisionRef.current, pending: true }));
      } catch { /* File saving can still succeed when browser storage is full. */ }
    };
    const persist = () => {
      const fingerprint = workbenchFingerprint(workbench);
      if (fingerprint === savedFingerprintRef.current) { setSaving(false); return; }
      backup();
      if (revisionRef.current === null) return;
      setSaving(true);
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        if (generation !== saveGenerationRef.current || revisionRef.current === null) {
          if (generation === saveGenerationRef.current) setSaving(false);
          return;
        }
        try {
          const response = await fetch("/api/companion/json-workspace", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workbench, revision: revisionRef.current }), signal: AbortSignal.timeout(12_000) });
          const payload = await response.json();
          if (!response.ok) { if (response.status === 409) revisionRef.current = null; throw new Error(payload.error || "JSON 草稿保存失败。"); }
          revisionRef.current = payload.revision;
          savedFingerprintRef.current = fingerprint;
          if (generation === saveGenerationRef.current) {
            setStorageError(false); setStorageMessage("");
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...workbench, fileRevision: payload.revision, pending: false })); } catch { /* The on-disk copy succeeded. */ }
          }
        } catch (cause) { setStorageError(true); setStorageMessage(String(cause)); }
        finally { if (generation === saveGenerationRef.current) setSaving(false); }
      });
    };
    const timer = window.setTimeout(persist, 350);
    window.addEventListener("pagehide", backup);
    return () => { window.clearTimeout(timer); window.removeEventListener("pagehide", backup); };
  }, [activeId, autoExtract, drafts, indent, multiEscape, restored, wrap]);

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!renamingId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId]);

  const announce = (message: string) => {
    setNotice(message);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(""), 1_800);
  };

  const syntaxErrorMessage = (input: string) => {
    const issue = findJsonSyntaxIssue(input, options);
    return issue ? {
      issue,
      message: t("companion.json.invalidAt", { column: issue.column, line: issue.line }),
    } : null;
  };

  const updateDraft = (id: string, patch: Partial<Pick<JsonDraft, "content" | "favorite" | "title">>) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
  };

  const startRenamingDraft = (draft: JsonDraft) => {
    setActiveId(draft.id);
    setRenameValue(draft.id === TEMP_DRAFT_ID && draft.title === TEMP_DRAFT.title ? t("companion.json.temporaryTab") : draft.title);
    setRenamingId(draft.id);
  };

  const finishRenamingDraft = (id: string, commit: boolean) => {
    if (commit) {
      const nextTitle = renameValue.trim().slice(0, 80);
      if (nextTitle) updateDraft(id, { title: nextTitle });
    }
    setRenamingId(null);
    setRenameValue("");
  };

  const focusRange = (start: number, end = start) => {
    window.requestAnimationFrame(() => {
      editorRef.current?.focusRange(start, end);
    });
  };

  const replaceRange = (target: Pick<TextTarget, "end" | "start">, replacement: string) => {
    const content = activeDraft.content;
    const next = `${content.slice(0, target.start)}${replacement}${content.slice(target.end)}`;
    if (next.length > MAX_CONTENT_LENGTH) throw new Error(t("companion.json.limitExceeded"));
    updateDraft(activeDraft.id, { content: next });
    focusRange(Math.min(target.start + replacement.length, next.length));
    return next;
  };

  const resolveTarget = (action: JsonWorkbenchAction): TextTarget => {
    const content = activeDraft.content;
    const { start, end } = editorRef.current?.getSelection() ?? { end: 0, start: 0 };
    if (start !== end) return { end, kind: "selection", start, text: content.slice(start, end) };
    if (action === "timestamp") {
      const number = numberTarget(content, start);
      if (number) return number;
    }
    if (!["format", "multi-unescape", "minify", "form-data", "escape", "minify-escape"].includes(action)) {
      const quoted = quotedTarget(content, start);
      if (quoted) return quoted;
    }
    return { end: content.length, kind: "all", start: 0, text: content };
  };

  const performAction = (action: JsonWorkbenchAction) => {
    const target = resolveTarget(action);
    setError("");
    try {
      const result = runJsonWorkbenchAction(target.text, action, options);
      if ((action === "format" || action === "multi-unescape") && result.kind !== "json") {
        const invalid = syntaxErrorMessage(target.text);
        if (invalid) {
          setError(invalid.message);
          focusRange(target.start + invalid.issue.offset);
          return;
        }
      }
      if (!result.changed) {
        announce(t("companion.json.noChange"));
        return;
      }
      if (target.kind === "quoted" && result.kind === "json" && target.outerStart !== undefined && target.outerEnd !== undefined) {
        const merged = `${activeDraft.content.slice(0, target.outerStart)}${result.output}${activeDraft.content.slice(target.outerEnd)}`;
        const formatted = smartFormatJson(merged, options);
        if (formatted.output.length > MAX_CONTENT_LENGTH) throw new Error(t("companion.json.limitExceeded"));
        updateDraft(activeDraft.id, { content: formatted.output });
        focusRange(Math.min(target.outerStart + result.output.length, formatted.output.length));
      } else {
        replaceRange(target, result.output);
      }
      announce(t("companion.json.converted"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const addDraft = (title?: string, content = "") => {
    if (content.length > MAX_CONTENT_LENGTH) { setError(t("companion.json.limitExceeded")); return; }
    if (drafts.length >= MAX_DRAFTS) {
      setError(t("companion.json.tooManyTabs"));
      return;
    }
    const draft = createDraft(title || `${t("companion.json.tab")} ${drafts.length}`, content);
    setDrafts((current) => [...current, draft]);
    setActiveId(draft.id);
    setError("");
    focusRange(0);
  };

  const closeDraft = (id: string) => {
    const index = drafts.findIndex((draft) => draft.id === id);
    const draft = drafts[index];
    if (!draft || draft.id === TEMP_DRAFT_ID || draft.favorite) return;
    const nextDrafts = drafts.filter((item) => item.id !== id);
    setDrafts(nextDrafts);
    if (activeId === id) setActiveId(nextDrafts[Math.max(0, index - 1)]?.id ?? TEMP_DRAFT_ID);
  };

  const pasteClipboard = async (intoNewDraft = false) => {
    setError("");
    try {
      const text = await readClipboardText();
      if (!text) return;
      const formatted = smartFormatJson(text, options);
      const output = formatted.kind === "json" ? formatted.output : text;
      const invalid = formatted.kind === "json" ? null : syntaxErrorMessage(text);
      if (intoNewDraft) {
        addDraft(undefined, output);
        if (invalid) setError(invalid.message);
        else announce(t("companion.json.autoFormatted"));
        return;
      }
      const selection = editorRef.current?.getSelection() ?? { end: 0, start: 0 };
      replaceRange(selection, output);
      if (invalid) {
        setError(invalid.message);
        focusRange(selection.start + invalid.issue.offset);
      } else {
        announce(t("companion.json.autoFormatted"));
      }
    } catch {
      setError(t("companion.json.clipboardError"));
    }
  };

  const formatPastedText = (pasted: string): string | null => {
    try {
      const formatted = smartFormatJson(pasted, options);
      if (formatted.kind !== "json") {
        const invalid = syntaxErrorMessage(pasted);
        if (invalid) {
          preservePasteErrorRef.current = true;
          setError(invalid.message);
          const selection = editorRef.current?.getSelection() ?? { start: 0 };
          window.requestAnimationFrame(() => focusRange(selection.start + invalid.issue.offset));
        }
        return null;
      }
      setError("");
      announce(t("companion.json.autoFormatted"));
      return formatted.output;
    } catch {
      const invalid = syntaxErrorMessage(pasted);
      if (invalid) {
        preservePasteErrorRef.current = true;
        setError(invalid.message);
      }
      return null;
    }
  };

  const cycleDraft = (backward: boolean) => {
    const current = drafts.findIndex((draft) => draft.id === activeDraft.id);
    const next = (current + (backward ? -1 : 1) + drafts.length) % drafts.length;
    setActiveId(drafts[next].id);
  };

  const handleEditorShortcut = (shortcut: JsonEditorShortcut) => {
    if (shortcut === "format") performAction("format");
    else if (shortcut === "new") addDraft();
    else if (shortcut === "paste-new") void pasteClipboard(true);
    else if (shortcut === "cycle-forward") cycleDraft(false);
    else if (shortcut === "cycle-backward") cycleDraft(true);
    else if (shortcut === "toggle-lock") updateDraft(activeDraft.id, { favorite: !activeDraft.favorite });
    else if (shortcut === "close") closeDraft(activeDraft.id);
  };

  const saveResult = async () => {
    if (!onSaveResult || !activeDraft.content.trim()) return;
    if (activeDraft.content.length > MAX_LIBRARY_RESULT_LENGTH) {
      setError(t("companion.json.outputTooLarge"));
      return;
    }
    setError("");
    try {
      const title = activeDraft.id === TEMP_DRAFT_ID ? `${t("companion.json.title")} ${new Date().toLocaleString()}` : activeDraft.title;
      const accepted = await onSaveResult({ content: activeDraft.content, language: "json", title: title.slice(0, 120) });
      if (accepted === false) throw new Error(t("companion.json.saveFailed"));
      announce(t("companion.json.saved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("companion.json.saveFailed"));
    }
  };

  const labelFor = (action: Exclude<JsonWorkbenchAction, "format">) => {
    const label = ACTION_LABELS[action];
    return label.startsWith("companion.") ? t(label) : label;
  };
  const copyCurrent = async () => {
    setError("");
    try { await copyText(activeDraft.content); announce(t("companion.json.copied")); }
    catch { setError(t("companion.json.clipboardError")); }
  };
  const exportCurrent = () => {
    const url = URL.createObjectURL(new Blob([activeDraft.content], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${activeDraft.title.replace(/[<>:"/\\|?*]/g, "_") || "document"}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!restored) return <div role="status">正在读取 JSON 草稿…</div>;
  return (
    <section className={styles.workbench} data-compact={compact ? "true" : "false"} aria-label={t("companion.json.title")}>
      <div className={styles.workbenchHeading}><div><span className={styles.fileBadge}><AliIcon name="code" size={19} /></span><h1>JSON<span>{t("companion.json.workspaceSubtitle")}</span></h1></div></div>
      <input ref={importRef} type="file" hidden accept=".json,.txt,.jsonl,application/json,text/plain" onChange={async (event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        if (file.size > MAX_CONTENT_LENGTH * 4) { setError(t("companion.json.limitExceeded")); return; }
        try { addDraft(file.name.replace(/\.json$/i, ""), await file.text()); }
        catch { setError(t("companion.json.importFailed")); }
      }} />
      <div className={styles.tabs} role="tablist" aria-label={t("companion.json.tabs")}>
        {drafts.map((draft) => (
          <div
            className={styles.tab}
            data-active={draft.id === activeDraft.id ? "true" : "false"}
            data-locked={draft.favorite ? "true" : "false"}
            key={draft.id}
          >
            {renamingId === draft.id ? (
              <input
                ref={renameInputRef}
                className={styles.tabRenameInput}
                value={renameValue}
                maxLength={80}
                aria-label={t("companion.json.renamePrompt")}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => finishRenamingDraft(draft.id, true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); finishRenamingDraft(draft.id, true); }
                  if (event.key === "Escape") { event.preventDefault(); finishRenamingDraft(draft.id, false); }
                }}
              />
            ) : (
              <button type="button" role="tab" aria-selected={draft.id === activeDraft.id} title={t("companion.json.renameHint")} onClick={() => setActiveId(draft.id)} onDoubleClick={() => startRenamingDraft(draft)}>
                {draft.id === TEMP_DRAFT_ID && draft.title === TEMP_DRAFT.title ? t("companion.json.temporaryTab") : draft.title}
              </button>
            )}
            {draft.id !== TEMP_DRAFT_ID ? <button type="button" disabled={draft.favorite} onClick={() => closeDraft(draft.id)} aria-label={t("companion.json.closeTab", { title: draft.title })}>×</button> : null}
          </div>
        ))}
        <button className={styles.addTab} type="button" disabled={drafts.length >= MAX_DRAFTS} onClick={() => addDraft()} aria-label={t("companion.json.addTab")}>+</button>
      </div>

      <div className={styles.actionBar}>
        <button className={styles.primary} type="button" disabled={!activeDraft.content.trim()} title="Ctrl / ⌘ + Enter" onClick={() => performAction("format")}>{t("companion.json.action.format")}</button>
        <button type="button" disabled={!activeDraft.content.trim()} onClick={() => performAction("minify")}>{t("companion.json.compress")}</button>
        <button type="button" disabled={!activeDraft.content} onClick={() => void copyCurrent()}>{t("companion.json.copy")}</button>
        <span className={styles.toolbarHint}>{t("companion.json.selectionHint")}</span>
      </div>
      <div className={styles.editorArea}>
      <JsonCodeEditor
        documentId={activeDraft.id}
        maxLength={MAX_CONTENT_LENGTH}
        onLimitExceeded={() => setError(t("companion.json.limitExceeded"))}
        ref={editorRef}
        className={styles.editorHost}
        ariaLabel={t("companion.json.editorLabel")}
        value={activeDraft.content}
        onChange={(content) => {
          updateDraft(activeDraft.id, { content: content.slice(0, MAX_CONTENT_LENGTH) });
          if (preservePasteErrorRef.current) preservePasteErrorRef.current = false;
          else setError("");
        }}
        onPasteText={formatPastedText}
        onShortcut={handleEditorShortcut}
        placeholder=""
        wrap={wrap}
      />
      {!activeDraft.content ? <div className={styles.editorEmpty}><span>{"{ }"}</span><b>{t("companion.json.emptyTitle")}</b><p>{t("companion.json.emptyHint")}</p><div><button type="button" className={styles.primary} onClick={() => void pasteClipboard()}>{t("companion.json.rawPaste")}</button><button type="button" onClick={() => importRef.current?.click()}>{t("companion.json.import")}</button></div><button type="button" onClick={() => updateDraft(activeDraft.id, { content: '{\n  "hello": "Piora",\n  "lightweight": true,\n  "tools": ["JSON", "Focus", "Notes"]\n}' })}>{t("companion.json.example")}</button></div> : null}
      </div>

      <div className={styles.quickTools} aria-label={t("companion.json.transformTools")}>
        <div className={styles.transformRow}>
          {(["get", "url", "base64", "serialize", "timestamp", "unicode", "utf8", "unescape", "multi-unescape", "escape", "minify-escape", "form-data"] as const).map((action) => (
            <button key={action} type="button" disabled={!activeDraft.content.trim()} onClick={() => performAction(action)}>{labelFor(action)}</button>
          ))}
        </div>
        <div className={styles.fileActions}>
          {reusableLibrary.length > 0 && <select aria-label={t("companion.json.loadLibrary")} value="" onChange={(event) => { const item = reusableLibrary.find((entry) => entry.id === event.target.value); if (item) addDraft(item.title, item.content); }}><option value="">{t("companion.json.loadLibrary")}</option>{reusableLibrary.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}
          <button type="button" onClick={() => importRef.current?.click()}><AliIcon name="upload" size={13} />{t("companion.json.import")}</button>
          <button type="button" disabled={!activeDraft.content} onClick={exportCurrent}><AliIcon name="download" size={13} />{t("companion.json.export")}</button>
          <button type="button" disabled={busy || !onSaveResult || !activeDraft.content.trim()} onClick={() => void saveResult()}><AliIcon name="bookmark" size={13} />{t("companion.json.saveLibrary")}</button>
          <button type="button" disabled={!activeDraft.content} onClick={() => updateDraft(activeDraft.id, { content: "" })}><AliIcon name="delete" size={13} />{t("companion.json.clear")}</button>
        </div>
      </div>
      <footer className={styles.footer}>
        <label className={styles.indentControl}>{t("companion.json.indent")}<select aria-label={t("companion.json.indent")} value={indent} onChange={(event) => setIndent(event.target.value === "2" ? 2 : 4)}><option value="2">2</option><option value="4">4</option></select></label>
        <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>{t("companion.json.wrap")}</button>
        <span className={styles.validation} data-state={validation}>{t(`companion.json.state.${validation}`)}</span>
        <span>{t("companion.json.characters", { count: activeDraft.content.length })}</span>
        <span className={styles.autosave}>{saving ? "保存中…" : storageError ? "未同步到文件" : "已保存本地"}</span>
        <span className={styles.feedback} data-error={Boolean(error || storageError)} role={error || storageError ? "alert" : "status"} title={error || storageMessage || notice}><span>{error || (storageError ? storageMessage || t("companion.json.storageError") : notice)}</span>{error && <button type="button" onClick={() => setError("")} aria-label={t("i18n.close")}><AliIcon name="close" size={11} /></button>}</span>
      </footer>
    </section>
  );
}
