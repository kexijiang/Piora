"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  findJsonSyntaxIssue,
  runJsonWorkbenchAction,
  smartFormatJson,
  type JsonWorkbenchAction,
  type JsonWorkbenchOptions,
} from "@/lib/json-workbench";
import type { CompanionLibraryItem } from "@/lib/companion-store";
import { JsonCodeEditor, type JsonCodeEditorHandle, type JsonEditorShortcut } from "./JsonCodeEditor";
import styles from "./JsonWorkbench.module.css";

const STORAGE_KEY = "piora-json-workbench-v1";
const TEMP_DRAFT_ID = "temp";
const MAX_DRAFTS = 12;
const MAX_CONTENT_LENGTH = 200_000;
const MAX_LIBRARY_RESULT_LENGTH = 40_000;
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
  wrap?: unknown;
}

interface TextTarget {
  end: number;
  kind: "all" | "number" | "quoted" | "selection";
  outerEnd?: number;
  outerStart?: number;
  start: number;
  text: string;
}

interface SavedJsonResult {
  content: string;
  language: string;
  title: string;
}

interface HoverActionMenuProps {
  children: ReactNode;
  label: string;
}

interface Props {
  busy?: boolean;
  compact?: boolean;
  library?: readonly CompanionLibraryItem[];
  onSaveResult?: (result: SavedJsonResult) => boolean | void | Promise<boolean | void>;
}

const TEMP_DRAFT: JsonDraft = { content: "", favorite: true, id: TEMP_DRAFT_ID, title: "temp" };

function HoverActionMenu({ children, label }: HoverActionMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={styles.actionMenu}
      data-open={open ? "true" : "false"}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        className={styles.actionMenuTrigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>
      {open ? <div className={styles.menu} role="menu" onClick={() => setOpen(false)}>{children}</div> : null}
    </div>
  );
}

const ACTION_LABELS: Record<Exclude<JsonWorkbenchAction, "format">, string> = {
  base64: "Base64",
  escape: "companion.json.action.escape",
  "form-data": "form-data",
  get: "GET",
  minify: "companion.json.action.minify",
  "minify-escape": "companion.json.action.minifyEscape",
  "multi-unescape": "companion.json.action.multiUnescape",
  serialize: "serialize",
  timestamp: "timestamp",
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
  const editorRef = useRef<JsonCodeEditorHandle>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const preservePasteErrorRef = useRef(false);

  const activeDraft = drafts.find((draft) => draft.id === activeId) ?? drafts[0];
  const reusableLibrary = useMemo(() => library.filter((item) => item.kind !== "image"), [library]);
  const options: JsonWorkbenchOptions = { extractJson: autoExtract, indent, multiEscape, removeNbsp: true };

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as StoredWorkbench | null;
      if (parsed && typeof parsed === "object") {
        const nextDrafts = restoreDrafts(parsed.drafts, parsed.temporaryTitle);
        setDrafts(nextDrafts);
        setActiveId(typeof parsed.activeId === "string" && nextDrafts.some((draft) => draft.id === parsed.activeId)
          ? parsed.activeId : TEMP_DRAFT_ID);
        setAutoExtract(parsed.autoExtract !== false);
        setIndent(parsed.indent === 2 ? 2 : 4);
        setMultiEscape(parsed.multiEscape !== false);
        setWrap(parsed.wrap === true);
      }
    } catch {
      // A corrupt local draft must not prevent the workbench from opening.
    } finally {
      setRestored(true);
    }
  }, []);

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => {
      try {
        const storedDrafts = drafts.filter((draft) => draft.id !== TEMP_DRAFT_ID);
        const temporaryTitle = drafts.find((draft) => draft.id === TEMP_DRAFT_ID)?.title;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId, autoExtract, drafts: storedDrafts, indent, multiEscape, temporaryTitle, wrap }));
      } catch {
        // The editor remains usable when storage is unavailable or full.
      }
    }, 180);
    return () => window.clearTimeout(timer);
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
    const next = `${content.slice(0, target.start)}${replacement}${content.slice(target.end)}`.slice(0, MAX_CONTENT_LENGTH);
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
        updateDraft(activeDraft.id, { content: formatted.output.slice(0, MAX_CONTENT_LENGTH) });
        focusRange(Math.min(target.outerStart + result.output.length, formatted.output.length));
      } else {
        replaceRange(target, result.output);
      }
      announce(t("companion.json.converted"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const copyAction = async (action: "escape" | "form-data" | "minify" | "minify-escape") => {
    const target = resolveTarget(action);
    setError("");
    try {
      const result = runJsonWorkbenchAction(target.text, action, options);
      await navigator.clipboard.writeText(result.output);
      announce(t("companion.json.copied"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("companion.json.clipboardError"));
    }
  };

  const addDraft = (title?: string, content = "") => {
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
      const text = await navigator.clipboard.readText();
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

  return (
    <section className={styles.workbench} data-compact={compact ? "true" : "false"} aria-label={t("companion.json.title")}>
      <div className={styles.libraryBridge}>
        <select aria-label={t("companion.json.loadLibrary")} defaultValue="" onChange={(event) => {
          const item = reusableLibrary.find((entry) => entry.id === event.target.value);
          event.target.value = "";
          if (item) addDraft(item.title, item.content);
        }}>
          <option value="">{t("companion.json.loadLibrary")}</option>
          {reusableLibrary.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <button type="button" disabled={busy || !onSaveResult || !activeDraft.content.trim()} onClick={() => void saveResult()}>{t("companion.json.saveLibrary")}</button>
      </div>

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
        <button className={styles.primary} type="button" onClick={() => performAction("format")}>{t("companion.json.action.format")}</button>
        <HoverActionMenu label={t("companion.json.transformTools")}>
            {(["get", "url", "base64", "serialize", "timestamp", "unicode", "utf8"] as const).map((action) => (
              <button key={action} type="button" onClick={() => performAction(action)}>{labelFor(action)}</button>
            ))}
        </HoverActionMenu>
        <HoverActionMenu label={t("companion.json.action.unescape")}>
            <button type="button" onClick={() => performAction("unescape")}>{labelFor("unescape")}</button>
            <button type="button" onClick={() => performAction("multi-unescape")}>{labelFor("multi-unescape")}</button>
        </HoverActionMenu>
        <HoverActionMenu label={t("companion.json.copyTools")}>
            {(["minify", "form-data", "escape", "minify-escape"] as const).map((action) => (
              <button key={action} type="button" onClick={() => void copyAction(action)}>{labelFor(action)}</button>
            ))}
        </HoverActionMenu>
        <button type="button" onClick={() => void pasteClipboard()}>{t("companion.json.rawPaste")}</button>
      </div>

      <JsonCodeEditor
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
        placeholder={t("companion.json.placeholder")}
        wrap={wrap}
      />

      <div className={styles.settings}>
        <label>{t("companion.json.indent")}<select value={indent} onChange={(event) => setIndent(event.target.value === "2" ? 2 : 4)}><option value="2">2</option><option value="4">4</option></select></label>
        <label><input type="checkbox" checked={autoExtract} onChange={(event) => setAutoExtract(event.target.checked)} />{t("companion.json.autoExtract")}</label>
        <label><input type="checkbox" checked={multiEscape} onChange={(event) => setMultiEscape(event.target.checked)} />{t("companion.json.autoMultiEscape")}</label>
        <label><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />{t("companion.json.wrap")}</label>
        <button type="button" onClick={() => updateDraft(activeDraft.id, { favorite: !activeDraft.favorite })}>{activeDraft.favorite ? t("companion.json.unlockTab") : t("companion.json.lockTab")}</button>
        <button type="button" onClick={() => updateDraft(activeDraft.id, { content: "" })}>{t("companion.json.clear")}</button>
      </div>

      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      <footer className={styles.footer}>
        <span>{t("companion.json.characters", { count: activeDraft.content.length })}</span>
        <span>{t("companion.json.shortcut")}</span>
        <strong aria-live="polite">{notice}</strong>
      </footer>
    </section>
  );
}
