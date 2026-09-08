"use client";

import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Compartment, EditorState, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder, WidgetType, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

class TextWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: TextWidget) { return this.text === other.text; }
  toDOM() { const span = document.createElement("span"); span.textContent = this.text; span.className = "md-marker"; return span; }
}

class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) { super(); }
  eq(other: ImageWidget) { return this.url === other.url && this.alt === other.alt; }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.src = this.url; img.alt = this.alt; img.className = "md-image";
    img.addEventListener("load", () => view.requestMeasure());
    return img;
  }
  ignoreEvent() { return false; }
}

function previewDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const active = state.selection.ranges.map((range) => ({ from: state.doc.lineAt(range.from).from, to: state.doc.lineAt(range.to).to }));
  const editing = (from: number, to: number) => active.some((range) => range.from <= to && range.to >= from);
  const hide = (from: number, to: number) => { if (from < to) decorations.push(Decoration.replace({}).range(from, to)); };
  syntaxTree(state).iterate({ enter(node) {
    const { name, from, to } = node;
    const line = state.doc.lineAt(from);
    const selected = editing(from, to);
    if (/^ATXHeading[1-6]$/.test(name)) decorations.push(Decoration.line({ class: `md-h${name.slice(-1)}` }).range(line.from));
    if (["StrongEmphasis", "Emphasis", "Strikethrough", "InlineCode", "Link"].includes(name)) {
      decorations.push(Decoration.mark({ class: `md-${name}` }).range(from, to));
    }
    if (name === "FencedCode") {
      for (let n = line.number; n <= state.doc.lineAt(to).number; n++) decorations.push(Decoration.line({ class: "md-code-line" }).range(state.doc.line(n).from));
    }
    if (name === "Blockquote") {
      for (let n = line.number; n <= state.doc.lineAt(to).number; n++) decorations.push(Decoration.line({ class: "md-quote" }).range(state.doc.line(n).from));
    }
    if (selected) return;
    if (name === "Image") {
      const match = /^!\[([^\]]*)\]\(([^\s)]+)\)$/.exec(state.doc.sliceString(from, to));
      if (match && /^(https?:\/\/|\/api\/companion\/library\/image\?|data:image\/(png|jpeg|webp|gif);base64,)/i.test(match[2])) {
        decorations.push(Decoration.replace({ widget: new ImageWidget(match[2], match[1]) }).range(from, to));
        return false;
      }
    }
    if (name === "HeaderMark" || name === "QuoteMark") hide(from, Math.min(to + 1, line.to));
    if (["EmphasisMark", "StrikethroughMark", "CodeMark"].includes(name)) hide(from, to);
    if (name === "ListMark" && /^[*+-]$/.test(state.doc.sliceString(from, to))) decorations.push(Decoration.replace({ widget: new TextWidget("•") }).range(from, to));
    if (name === "TaskMarker") decorations.push(Decoration.replace({ widget: new TextWidget(state.doc.sliceString(from, to).toLowerCase() === "[x]" ? "☑" : "☐") }).range(from, to));
    if (name === "Link") {
      const url = node.node.getChild("URL");
      if (url) {
        hide(from, from + 1);
        hide(url.from - 2, to);
        return false;
      }
    }
  } });
  return Decoration.set(decorations, true);
}

const livePreview = StateField.define<DecorationSet>({
  create: previewDecorations,
  update: (_decorations, transaction) => previewDecorations(transaction.state),
  provide: (field) => EditorView.decorations.from(field),
});

export interface MarkdownEditorHandle { insert(before: string, after?: string): void; focus(): void }
interface Props { value: string; source: boolean; onChange: (value: string) => void; onSave: () => void; onImage: (file: File) => void }

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor({ value, source, onChange, onSave, onImage }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave, onImage });
  callbacks.current = { onChange, onSave, onImage };
  const initial = useRef({ value, source });
  const mode = useRef(new Compartment());
  const syncing = useRef(false);
  const insert = (before: string, after = "") => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    view.dispatch({ changes: { from, to, insert: before + text + after }, selection: { anchor: from + before.length, head: from + before.length + text.length }, scrollIntoView: true });
    view.focus();
  };
  useImperativeHandle(ref, () => ({ insert, focus: () => viewRef.current?.focus() }));
  useEffect(() => {
    if (!container.current) return;
    const view = new EditorView({ parent: container.current, state: EditorState.create({ doc: initial.current.value, extensions: [
      markdown({ base: markdownLanguage }), history(), EditorView.lineWrapping,
      mode.current.of(initial.current.source ? [syntaxHighlighting(defaultHighlightStyle)] : [livePreview]),
      placeholder("从这里开始写作… 输入 # 标题、**粗体** 或 - 列表"),
      EditorView.contentAttributes.of({ "aria-label": "Markdown 正文", spellcheck: "false" }),
      keymap.of([
        { key: "Mod-s", run: () => { callbacks.current.onSave(); return true; } },
        { key: "Mod-b", run: () => { insert("**", "**"); return true; } },
        { key: "Mod-i", run: () => { insert("*", "*"); return true; } },
        ...defaultKeymap, ...historyKeymap,
      ]),
      EditorState.transactionFilter.of((transaction) => transaction.docChanged && transaction.newDoc.length > 200_000 ? [] : transaction),
      EditorView.updateListener.of((update) => { if (update.docChanged && !syncing.current) callbacks.current.onChange(update.state.doc.toString()); }),
      EditorView.domEventHandlers({ paste(event) {
        const file = Array.from(event.clipboardData?.files ?? []).find((entry) => entry.type.startsWith("image/"));
        if (!file) return false;
        event.preventDefault(); callbacks.current.onImage(file); return true;
      } }),
    ] }) });
    viewRef.current = view;
    return () => { viewRef.current = null; view.destroy(); };
  }, []);
  useEffect(() => { viewRef.current?.dispatch({ effects: mode.current.reconfigure(source ? [syntaxHighlighting(defaultHighlightStyle)] : [livePreview]) }); }, [source]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    syncing.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    syncing.current = false;
  }, [value]);
  return <div ref={container} className="pocket-markdown-editor" data-source={source} />;
});
