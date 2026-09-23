"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Compartment, EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionSource } from "@codemirror/autocomplete";
import { HighlightStyle, LanguageDescription, bracketMatching, codeFolding, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { openSearchPanel, search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { EditorView, GutterMarker, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, hoverTooltip, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { getFileName } from "@/lib/file-paths";
import type { EditorLineChange, EditorLineChangeKind } from "@/lib/file-editor-line-changes";
import type { CodeDefinition, CodeIntelligenceMode, CodeIntelligenceResult } from "@/lib/code-intelligence-types";
import { createEditorSearchPanel, editorSearchChinese } from "@/lib/editor-search-panel";
import { useI18n } from "@/hooks/useI18n";
import "./EditorSearch.css";
import "./FileCodeEditor.css";

export interface FileCodeEditorHandle {
  focus(): void;
  revealLine(line: number, column?: number): void;
}

interface Props {
  value: string;
  filePath: string;
  cwd?: string;
  ariaLabel: string;
  scrollTop: number;
  onChange(value: string): void;
  onCursorChange(position: { line: number; column: number }): void;
  onScrollChange(top: number): void;
  onSave(): void;
  onNavigate?(target: CodeDefinition): void;
  onIntelligenceMode?(mode: CodeIntelligenceMode, message?: string): void;
  lineChanges: EditorLineChange[];
  lineSeparator: "\r\n" | "\r" | "\n";
}

const lineChangeEffect = StateEffect.define<EditorLineChange[]>();
class ChangeGutterMarker extends GutterMarker {
  constructor(readonly kind: EditorLineChangeKind) { super(); }
  eq(other: ChangeGutterMarker) { return this.kind === other.kind; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-file-change-marker";
    span.dataset.kind = this.kind;
    span.title = this.kind === "added" ? "新增 / Added" : this.kind === "deleted" ? "删除 / Deleted" : "修改 / Modified";
    return span;
  }
}
const lineChangeField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    let next = markers.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(lineChangeEffect)) continue;
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const change of effect.value) {
        if (change.line > transaction.state.doc.lines) continue;
        builder.add(transaction.state.doc.line(change.line).from, transaction.state.doc.line(change.line).from, new ChangeGutterMarker(change.kind));
      }
      next = builder.finish();
    }
    return next;
  },
});

const fileHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--file-code-comment)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: "var(--file-code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--file-code-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--file-code-number)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--file-code-type)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--file-code-function)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--file-code-property)" },
  { tag: [tags.tagName, tags.heading], color: "var(--file-code-tag)" },
  { tag: tags.link, color: "var(--file-code-link)", textDecoration: "underline" },
  { tag: tags.invalid, color: "var(--file-code-invalid)", textDecoration: "wavy underline" },
]);

export const FileCodeEditor = forwardRef<FileCodeEditorHandle, Props>(function FileCodeEditor({
  value, filePath, cwd, ariaLabel, scrollTop, onChange, onCursorChange, onScrollChange, onSave, onNavigate, onIntelligenceMode, lineChanges, lineSeparator,
}, forwardedRef) {
  const { locale } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialRef = useRef({ value, scrollTop, ariaLabel, lineSeparator });
  const callbacksRef = useRef({ onChange, onCursorChange, onScrollChange, onSave, onNavigate, onIntelligenceMode });
  const syncingRef = useRef(false);
  const versionRef = useRef(Date.now());
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef<CodeIntelligenceMode | null>(null);
  const modeMessageRef = useRef<string | undefined>(undefined);
  const [definitionTargets, setDefinitionTargets] = useState<CodeDefinition[] | null>(null);
  const [languageSlot] = useState(() => new Compartment());
  const [labelSlot] = useState(() => new Compartment());
  callbacksRef.current = { onChange, onCursorChange, onScrollChange, onSave, onNavigate, onIntelligenceMode };
  const intelligenceEnabled = /\.(?:ets|tsx?|jsx?)$/i.test(filePath);

  const requestIntelligence = useCallback(async (action: "sync" | "close" | "definition" | "completion" | "hover" | "status", view?: EditorView, offset?: number, signal?: AbortSignal): Promise<CodeIntelligenceResult> => {
    const response = await fetch("/api/code-intelligence", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ action, filePath, cwd, ...(view ? { content: view.state.doc.toString(), version: versionRef.current } : {}), ...(offset === undefined ? {} : { offset }) }),
    });
    if (!response.ok) throw new Error(`Code intelligence: HTTP ${response.status}`);
    const result = await response.json() as CodeIntelligenceResult;
    if (modeRef.current !== result.mode || modeMessageRef.current !== result.message) {
      modeRef.current = result.mode;
      modeMessageRef.current = result.message;
      callbacksRef.current.onIntelligenceMode?.(result.mode, result.message);
    }
    return result;
  }, [cwd, filePath]);

  const goToDefinition = useCallback(async (view: EditorView, offset: number) => {
    if (!intelligenceEnabled) return;
    const requestedVersion = versionRef.current;
    try {
      const result = await requestIntelligence("definition", view, offset);
      if (viewRef.current !== view || versionRef.current !== requestedVersion) return;
      const targets = result.definitions ?? [];
      if (targets.length === 1) callbacksRef.current.onNavigate?.(targets[0]);
      else setDefinitionTargets(targets.length ? targets : null);
    } catch { setDefinitionTargets(null); }
  }, [intelligenceEnabled, requestIntelligence]);

  useImperativeHandle(forwardedRef, () => ({
    focus() { viewRef.current?.focus(); },
    revealLine(line, column) {
      const view = viewRef.current;
      if (!view) return;
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      const position = column ? Math.min(target.to, target.from + Math.max(0, column - 1)) : target.from;
      const end = column ? Math.min(target.to, position + (view.state.doc.sliceString(position, target.to).match(/^[\w$]+/)?.[0].length ?? 0)) : target.to;
      view.dispatch({
        selection: { anchor: position, head: end },
        effects: EditorView.scrollIntoView(position, { y: "center" }),
      });
      view.focus();
    },
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const completionSource: CompletionSource = async (context) => {
      if (!intelligenceEnabled) return null;
      const match = context.matchBefore(/[\w$]*$/);
      if (!context.explicit && !match?.text && context.state.doc.sliceString(Math.max(0, context.pos - 1), context.pos) !== ".") return null;
      try {
        const requestedVersion = versionRef.current;
        const result = await requestIntelligence("completion", context.view ?? viewRef.current ?? undefined, context.pos);
        if (context.aborted || versionRef.current !== requestedVersion || !result.suggestions?.length) return null;
        return {
          from: match?.from ?? context.pos,
          options: result.suggestions.map((item) => ({
            label: item.label,
            type: item.kind || undefined,
            detail: item.detail,
            info: [item.detail, item.documentation].filter(Boolean).join("\n") || undefined,
            apply: (item.insertText ?? item.label).replace(/\$\{\d+:([^}]+)\}/g, "$1").replace(/\$\d+/g, ""),
          })),
          validFor: /^[\w$]*$/,
        };
      } catch { return null; }
    };
    const state = EditorState.create({
      doc: initialRef.current.value,
      extensions: [
        EditorState.tabSize.of(2), indentUnit.of("  "), EditorState.lineSeparator.of(initialRef.current.lineSeparator),
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(),
        lineChangeField, gutter({ class: "cm-file-change-gutter", markers: (view) => view.state.field(lineChangeField) }),
        indentOnInput(), bracketMatching(), closeBrackets(), codeFolding(), foldGutter({ markerDOM(open) {
          const icon = document.createElement("span");
          icon.className = "cm-file-fold-chevron";
          icon.dataset.open = String(open);
          icon.title = open ? "折叠代码 / Fold code" : "展开代码 / Unfold code";
          icon.setAttribute("aria-label", icon.title);
          return icon;
        } }),
        highlightActiveLine(), highlightSelectionMatches(), search({ top: true, createPanel: (view) => createEditorSearchPanel(view, { floating: true }) }),
        EditorState.phrases.of(locale === "zh-CN" ? editorSearchChinese : {}),
        ...(intelligenceEnabled ? [
          autocompletion({ override: [completionSource], activateOnTyping: true }),
          hoverTooltip(async (view, pos) => {
            const requestedVersion = versionRef.current;
            try {
              const result = await requestIntelligence("hover", view, pos);
              if (!result.hover || viewRef.current !== view || versionRef.current !== requestedVersion) return null;
              return { pos, above: true, create() {
                const dom = document.createElement("div"); dom.textContent = result.hover!; return { dom };
              } };
            } catch { return null; }
          }, { hoverTime: 550 }),
          EditorView.domEventHandlers({ click(event, view) {
            if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            event.preventDefault(); void goToDefinition(view, pos); return true;
          } }),
        ] : []),
        syntaxHighlighting(fileHighlightStyle), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        languageSlot.of([]),
        labelSlot.of(EditorView.contentAttributes.of({ "aria-label": initialRef.current.ariaLabel, "aria-multiline": "true", spellcheck: "false" })),
        keymap.of([
          { key: "Mod-s", run: () => { callbacksRef.current.onSave(); return true; } },
          { key: "Mod-f", run: openSearchPanel },
          { key: "F12", run: (view) => { void goToDefinition(view, view.state.selection.main.head); return intelligenceEnabled; } },
          indentWithTab,
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && intelligenceEnabled) {
            versionRef.current = Math.max(Date.now(), versionRef.current + 1);
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
            syncTimerRef.current = setTimeout(() => { void requestIntelligence("sync", update.view).catch(() => {}); }, 180);
          }
          if (update.docChanged && !syncingRef.current) callbacksRef.current.onChange(update.state.doc.sliceString(0, update.state.doc.length, update.state.lineBreak));
          if (update.selectionSet || update.docChanged) {
            const position = update.state.selection.main.head;
            const line = update.state.doc.lineAt(position);
            callbacksRef.current.onCursorChange({ line: line.number, column: position - line.from + 1 });
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    const handleScroll = () => callbacksRef.current.onScrollChange(view.scrollDOM.scrollTop);
    view.scrollDOM.addEventListener("scroll", handleScroll, { passive: true });
    view.scrollDOM.scrollTop = initialRef.current.scrollTop;
    if (intelligenceEnabled) void requestIntelligence("status", view).catch(() => {});
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      if (intelligenceEnabled) void requestIntelligence("close").catch(() => {});
      view.scrollDOM.removeEventListener("scroll", handleScroll);
      viewRef.current = null;
      view.destroy();
    };
  }, [goToDefinition, intelligenceEnabled, labelSlot, languageSlot, locale, requestIntelligence]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.sliceString(0, view.state.doc.length, view.state.lineBreak);
    if (current === value) return;
    const head = Math.min(view.state.selection.main.head, value.replace(/\r\n?/g, "\n").length);
    syncingRef.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor: head } });
    syncingRef.current = false;
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: lineChangeEffect.of(lineChanges) });
  }, [lineChanges]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: labelSlot.reconfigure(EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-multiline": "true", spellcheck: "false" })) });
  }, [ariaLabel, labelSlot]);

  useEffect(() => {
    let cancelled = false;
    const name = getFileName(filePath);
    // CodeMirror's filename list omits ArkTS, JSON5 and Harmony markup.
    // Their closest supported grammars keep editing features and colors available.
    const languageName = /\.ets$/i.test(name) ? `${name.slice(0, -4)}.ts`
      : /\.json5$/i.test(name) ? `${name.slice(0, -6)}.js`
        : /\.hml$/i.test(name) ? `${name.slice(0, -4)}.html` : name;
    const description = LanguageDescription.matchFilename(languages, languageName);
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: languageSlot.reconfigure([]) });
    if (description) void description.load().then((support) => {
      if (!cancelled && viewRef.current === view) view.dispatch({ effects: languageSlot.reconfigure(support) });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [filePath, languageSlot]);

  return <div className="piora-file-code-editor-wrap">
    <div ref={hostRef} className="piora-file-code-editor file-editor-textarea" />
    {definitionTargets?.length ? <div className="piora-definition-picker" role="listbox" aria-label={locale === "zh-CN" ? "选择定义" : "Choose definition"}>
      <div>{locale === "zh-CN" ? "找到多个定义" : "Multiple definitions"}</div>
      {definitionTargets.map((target, index) => <button key={`${target.filePath}:${target.line}:${target.column}:${index}`} type="button" role="option" aria-selected={false}
        onClick={() => { callbacksRef.current.onNavigate?.(target); setDefinitionTargets(null); }}>
        {target.name ?? target.filePath.split(/[\\/]/).pop()}<small title={target.filePath}>{target.filePath}:{target.line}:{target.column}</small>
      </button>)}
    </div> : null}
  </div>;
});
