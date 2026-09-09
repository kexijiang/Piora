"use client";

import { json } from "@codemirror/lang-json";
import { isolateHistory, history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, foldGutter, codeFolding, indentOnInput, bracketMatching, foldKeymap } from "@codemirror/language";
import { search, openSearchPanel, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { createEditorSearchPanel, editorSearchChinese } from "@/lib/editor-search-panel";
import { useI18n } from "@/hooks/useI18n";
import "./EditorSearch.css";
import { tags } from "@lezer/highlight";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as codeMirrorPlaceholder, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type JsonEditorShortcut = "close" | "cycle-backward" | "cycle-forward" | "format" | "new" | "paste-new" | "toggle-lock";
const pocketHighlighting = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--json-key)", fontWeight: "500" },
  { tag: tags.string, color: "var(--json-string)" },
  { tag: tags.number, color: "var(--json-number)" },
  { tag: tags.bool, color: "var(--json-boolean)", fontWeight: "500" },
  { tag: tags.null, color: "var(--json-null)", fontStyle: "italic" },
  { tag: tags.punctuation, color: "var(--json-punctuation)" },
]);

export interface JsonCodeEditorHandle {
  focusRange: (start: number, end?: number) => void;
  getSelection: () => { end: number; start: number };
}

interface Props {
  documentId: string;
  maxLength: number;
  onLimitExceeded: () => void;
  ariaLabel: string;
  className?: string;
  onChange: (value: string) => void;
  onPasteText: (text: string) => string | null;
  onShortcut: (shortcut: JsonEditorShortcut) => void;
  placeholder: string;
  value: string;
  wrap: boolean;
}

export const JsonCodeEditor = forwardRef<JsonCodeEditorHandle, Props>(function JsonCodeEditor({
  documentId,
  maxLength,
  onLimitExceeded,
  ariaLabel,
  className,
  onChange,
  onPasteText,
  onShortcut,
  placeholder,
  value,
  wrap,
}, forwardedRef) {
  const { locale } = useI18n();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncingRef = useRef(false);
  const callbacksRef = useRef({ onChange, onPasteText, onShortcut, onLimitExceeded });
  const documentIdRef = useRef(documentId);
  const documentsRef = useRef(new Map<string, EditorState>());
  const createStateRef = useRef<((doc: string) => EditorState) | null>(null);
  const maxLengthRef = useRef(maxLength);
  const initialValueRef = useRef(value);
  const initialOptionsRef = useRef({ ariaLabel, placeholder, wrap, locale });
  const [optionsCompartment] = useState(() => new Compartment());

  callbacksRef.current = { onChange, onPasteText, onShortcut, onLimitExceeded };
  maxLengthRef.current = maxLength;

  const editorOptions = (next: { ariaLabel: string; placeholder: string; wrap: boolean; locale: string }) => [
    EditorState.phrases.of(next.locale === "zh-CN" ? { ...editorSearchChinese, "Fold code": "折叠代码", "Unfold code": "展开代码" } : {}),
    next.wrap ? EditorView.lineWrapping : [],
    codeMirrorPlaceholder(next.placeholder),
    EditorView.contentAttributes.of({ "aria-label": next.ariaLabel, "aria-multiline": "true", spellcheck: "false" }),
  ];

  useImperativeHandle(forwardedRef, () => ({
    focusRange(start, end = start) {
      const view = viewRef.current;
      if (!view) return;
      const length = view.state.doc.length;
      const anchor = Math.max(0, Math.min(start, length));
      const head = Math.max(0, Math.min(end, length));
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
      view.focus();
    },
    getSelection() {
      const selection = viewRef.current?.state.selection.main;
      return selection ? { end: selection.to, start: selection.from } : { end: 0, start: 0 };
    },
  }), []);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const runShortcut = (shortcut: JsonEditorShortcut) => () => {
      callbacksRef.current.onShortcut(shortcut);
      return true;
    };
    const createState = (doc: string) => EditorState.create({
        doc,
        extensions: [
          EditorState.transactionFilter.of((transaction) => {
            if (transaction.docChanged && transaction.newDoc.length > maxLengthRef.current) {
              queueMicrotask(() => callbacksRef.current.onLimitExceeded());
              return [];
            }
            return transaction;
          }),
          keymap.of([
            { key: "Mod-h", run: openSearchPanel },
            { key: "Mod-Enter", run: runShortcut("format") },
            { key: "Mod-t", run: runShortcut("new") },
            { key: "Mod-n", run: runShortcut("paste-new") },
            { key: "Mod-Tab", run: runShortcut("cycle-forward") },
            { key: "Shift-Mod-Tab", run: runShortcut("cycle-backward") },
            { key: "Mod-l", run: runShortcut("toggle-lock") },
            { key: "Mod-q", run: runShortcut("close") },
          ]),
          search({ top: true, createPanel: createEditorSearchPanel }),
          lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
          EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
          foldGutter({ markerDOM(open) {
            const marker = document.createElement("span"); marker.className = "piora-fold-chevron"; marker.dataset.open = String(open);
            marker.title = localeRef.current === "zh-CN" ? open ? "折叠代码" : "展开代码" : open ? "Fold code" : "Unfold code"; marker.setAttribute("aria-label", marker.title);
            return marker;
          } }),
          codeFolding({ placeholderDOM(view, onclick) {
            const marker = document.createElement("button"); marker.type = "button"; marker.className = "piora-fold-placeholder";
            marker.textContent = "···"; marker.setAttribute("aria-label", view.state.phrase("Unfold code")); marker.onclick = onclick; return marker;
          } }),
          json(),
          syntaxHighlighting(pocketHighlighting),
          optionsCompartment.of(editorOptions(initialOptionsRef.current)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncingRef.current) callbacksRef.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(event, currentView) {
              const text = event.clipboardData?.getData("text") ?? "";
              if (!text) return false;
              const replacement = callbacksRef.current.onPasteText(text);
              if (replacement === null) return false;
              event.preventDefault();
              const selection = currentView.state.selection.main;
              currentView.dispatch({
                changes: { from: selection.from, to: selection.to, insert: replacement },
                selection: { anchor: selection.from + replacement.length },
                scrollIntoView: true,
              });
              return true;
            },
          }),
        ],
      });
    createStateRef.current = createState;
    const view = new EditorView({ parent, state: createState(initialValueRef.current) });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [optionsCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (documentIdRef.current !== documentId && createStateRef.current) {
      documentsRef.current.set(documentIdRef.current, view.state);
      // Keep undo/selection isolated per document, with a bounded cache for closed tabs.
      if (documentsRef.current.size > 12) documentsRef.current.delete(documentsRef.current.keys().next().value!);
      view.setState(documentsRef.current.get(documentId) ?? createStateRef.current(value));
      documentIdRef.current = documentId;
    }
    view.dispatch({ effects: optionsCompartment.reconfigure(editorOptions({ ariaLabel, placeholder, wrap, locale })) });
    const current = view.state.doc.toString();
    if (current === value) return;
    const selection = view.state.selection.main;
    const anchor = Math.min(selection.head, value.length);
    syncingRef.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor }, annotations: isolateHistory.of("full") });
    syncingRef.current = false;
  }, [documentId, value, ariaLabel, placeholder, wrap, locale, optionsCompartment]);

  return <div ref={containerRef} className={`piora-json-code-editor ${className ?? ""}`} data-wrap={wrap ? "true" : "false"} />;
});
