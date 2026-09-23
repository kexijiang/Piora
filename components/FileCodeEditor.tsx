"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Compartment, EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { HighlightStyle, LanguageDescription, bracketMatching, codeFolding, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { openSearchPanel, search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { EditorView, GutterMarker, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { getFileName } from "@/lib/file-paths";
import type { EditorLineChange, EditorLineChangeKind } from "@/lib/file-editor-line-changes";
import "./FileCodeEditor.css";

export interface FileCodeEditorHandle {
  focus(): void;
  revealLine(line: number): void;
}

interface Props {
  value: string;
  filePath: string;
  ariaLabel: string;
  scrollTop: number;
  onChange(value: string): void;
  onCursorChange(position: { line: number; column: number }): void;
  onScrollChange(top: number): void;
  onSave(): void;
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
  value, filePath, ariaLabel, scrollTop, onChange, onCursorChange, onScrollChange, onSave, lineChanges, lineSeparator,
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialRef = useRef({ value, scrollTop, ariaLabel, lineSeparator });
  const callbacksRef = useRef({ onChange, onCursorChange, onScrollChange, onSave });
  const syncingRef = useRef(false);
  const [languageSlot] = useState(() => new Compartment());
  const [labelSlot] = useState(() => new Compartment());
  callbacksRef.current = { onChange, onCursorChange, onScrollChange, onSave };

  useImperativeHandle(forwardedRef, () => ({
    focus() { viewRef.current?.focus(); },
    revealLine(line) {
      const view = viewRef.current;
      if (!view) return;
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({
        selection: { anchor: target.from, head: target.to },
        effects: EditorView.scrollIntoView(target.from, { y: "center" }),
      });
      view.focus();
    },
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
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
        highlightActiveLine(), highlightSelectionMatches(), search(),
        syntaxHighlighting(fileHighlightStyle), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        languageSlot.of([]),
        labelSlot.of(EditorView.contentAttributes.of({ "aria-label": initialRef.current.ariaLabel, "aria-multiline": "true", spellcheck: "false" })),
        keymap.of([
          { key: "Mod-s", run: () => { callbacksRef.current.onSave(); return true; } },
          { key: "Mod-f", run: openSearchPanel },
          indentWithTab,
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap,
        ]),
        EditorView.updateListener.of((update) => {
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
    return () => {
      view.scrollDOM.removeEventListener("scroll", handleScroll);
      viewRef.current = null;
      view.destroy();
    };
  }, [labelSlot, languageSlot]);

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
    const description = LanguageDescription.matchFilename(languages, name);
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: languageSlot.reconfigure([]) });
    if (description) void description.load().then((support) => {
      if (!cancelled && viewRef.current === view) view.dispatch({ effects: languageSlot.reconfigure(support) });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [filePath, languageSlot]);

  return <div ref={hostRef} className="piora-file-code-editor file-editor-textarea" />;
});
