"use client";

import { json } from "@codemirror/lang-json";
import { isolateHistory } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as codeMirrorPlaceholder } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type JsonEditorShortcut = "close" | "cycle-backward" | "cycle-forward" | "format" | "new" | "paste-new" | "toggle-lock";
const pocketHighlighting = HighlightStyle.define([
  { tag: tags.propertyName, color: "color-mix(in srgb, #719fc2 75%, var(--text))" },
  { tag: tags.string, color: "color-mix(in srgb, #899b70 75%, var(--text))" },
  { tag: [tags.number, tags.bool, tags.null], color: "color-mix(in srgb, #b696cb 75%, var(--text))" },
  { tag: tags.punctuation, color: "var(--text-muted)" },
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
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncingRef = useRef(false);
  const callbacksRef = useRef({ onChange, onPasteText, onShortcut, onLimitExceeded });
  const documentIdRef = useRef(documentId);
  const documentsRef = useRef(new Map<string, EditorState>());
  const createStateRef = useRef<((doc: string) => EditorState) | null>(null);
  const maxLengthRef = useRef(maxLength);
  const initialValueRef = useRef(value);
  const initialOptionsRef = useRef({ ariaLabel, placeholder, wrap });
  const [optionsCompartment] = useState(() => new Compartment());

  callbacksRef.current = { onChange, onPasteText, onShortcut, onLimitExceeded };
  maxLengthRef.current = maxLength;

  const editorOptions = (next: { ariaLabel: string; placeholder: string; wrap: boolean }) => [
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
            { key: "Mod-Enter", run: runShortcut("format") },
            { key: "Mod-t", run: runShortcut("new") },
            { key: "Mod-n", run: runShortcut("paste-new") },
            { key: "Mod-Tab", run: runShortcut("cycle-forward") },
            { key: "Shift-Mod-Tab", run: runShortcut("cycle-backward") },
            { key: "Mod-l", run: runShortcut("toggle-lock") },
            { key: "Mod-q", run: runShortcut("close") },
          ]),
          basicSetup,
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
    view.dispatch({ effects: optionsCompartment.reconfigure(editorOptions({ ariaLabel, placeholder, wrap })) });
    const current = view.state.doc.toString();
    if (current === value) return;
    const selection = view.state.selection.main;
    const anchor = Math.min(selection.head, value.length);
    syncingRef.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor }, annotations: isolateHistory.of("full") });
    syncingRef.current = false;
  }, [documentId, value, ariaLabel, placeholder, wrap, optionsCompartment]);

  return <div ref={containerRef} className={className} data-wrap={wrap ? "true" : "false"} />;
});
