"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import Vditor from "vditor";
import { loadMarkdownEditorAssets, MARKDOWN_EDITOR_CDN } from "@/lib/markdown-editor-assets";
import { markdownOutline } from "@/lib/markdown-outline";
import { preserveMarkdownImageSizes } from "@/lib/markdown-editor-images";
import "vditor/dist/index.css";
import "./MarkdownEditor.css";

export interface MarkdownEditorHandle {
  insert(before: string, after?: string): void;
  focus(): void;
  search(): void;
  jumpTo(offset: number): void;
  flush(): Promise<boolean>;
  isBusy(): boolean;
  getHTML(): string;
}
interface Props { value: string; onChange(value: string): void; onSave(): void; onImage(file: File): Promise<string>; editorRef?: Ref<MarkdownEditorHandle> }

function destroyEditor(editor: Vditor) {
  // Vditor removes a page-global icon script on destroy, even while another
  // document is open. Retain the already-executed script for sibling editors.
  const icons = document.getElementById("vditorIconScript");
  clearTimeout(editor.vditor.wysiwyg?.afterRenderTimeoutId);
  clearTimeout(editor.vditor.ir?.processTimeoutId);
  editor.destroy();
  if (icons && !icons.isConnected) document.head.appendChild(icons);
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Vditor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const lastPublished = useRef(props.value);
  const baseline = useRef("");
  const uploads = useRef<Promise<void> | null>(null);
  const composing = useRef(false);
  const publishRef = useRef<() => void>(() => {});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);

  const sourceMode = () => {
    const editor = engine.current;
    if (!editor || uploads.current) return;
    if (editor.getCurrentMode() !== "sv") editor.vditor.toolbar!.elements!["edit-mode"].querySelector<HTMLButtonElement>('[data-mode="sv"]')?.click();
    return editor.vditor.sv!.element;
  };
  const openSearch = () => { if (sourceMode()) { setSearching(true); requestAnimationFrame(() => searchInput.current?.focus()); } };
  const find = (replace = false, all = false) => {
    const editor = engine.current, input = sourceMode();
    if (!editor || !input || !query) return;
    if (replace && all) {
      const matches = input.value.split(query).length - 1;
      const next = input.value.split(query).join(replacement);
      if (next.length > 200_000) { setSearchStatus("替换后超过 200,000 字符限制"); return; }
      editor.setValue(next); publishRef.current(); setSearchStatus(`已替换 ${matches} 处`); return;
    }
    if (replace && input.value.slice(input.selectionStart, input.selectionEnd) === query) { editor.insertMD(replacement); publishRef.current(); }
    const start = input.value.indexOf(query, input.selectionEnd);
    const found = start < 0 ? input.value.indexOf(query) : start;
    if (found < 0) { setSearchStatus("没有找到匹配内容"); return; }
    input.focus(); input.setSelectionRange(found, found + query.length);
    input.scrollTop = (input.value.slice(0, found).split("\n").length - 1) * parseFloat(getComputedStyle(input).lineHeight) - input.clientHeight / 2;
    setSearchStatus(`共 ${input.value.split(query).length - 1} 处匹配`);
  };
  // next/dynamic reserves `ref` for its loadable handle. The explicit prop
  // reaches this editor through that boundary; direct mounts can still use ref.
  useImperativeHandle(props.editorRef ?? ref, () => ({
    insert(before, after = "") { const editor = engine.current; if (editor && !uploads.current) { editor.focus(); editor.insertMD(before + editor.getSelection() + after); publishRef.current(); } },
    focus() { engine.current?.focus(); }, search: openSearch,
    async flush() { await uploads.current; publishRef.current(); return !composing.current && (engine.current?.getValue().length ?? 0) <= 200_000; },
    isBusy: () => Boolean(uploads.current) || composing.current || (engine.current?.getValue().length ?? 0) > 200_000,
    getHTML: () => engine.current?.getHTML() ?? "",
    jumpTo(offset) {
      const editor = engine.current;
      if (!editor || uploads.current) return;
      if (editor.getCurrentMode() === "sv") {
        const input = editor.vditor.sv!.element;
        input.focus(); input.setSelectionRange(offset, offset);
        input.scrollTop = input.value.slice(0, offset).split("\n").length * parseFloat(getComputedStyle(input).lineHeight) - 30;
      } else {
        const index = markdownOutline(latest.current.value).findIndex((entry) => entry.offset === offset);
        const heading = editor.vditor[editor.getCurrentMode()]!.element.querySelectorAll("h1,h2,h3,h4,h5,h6")[index];
        if (heading) { const range = document.createRange(); range.selectNodeContents(heading); range.collapse(true); editor.focus(); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); heading.scrollIntoView({ block: "start" }); }
      }
    },
  }));

  useEffect(() => {
    let disposed = false;
    let instance: Vditor | null = null;
    let ready = false;
    let overLimit = false;
    const element = document.createElement("div");
    host.current?.appendChild(element);
    const publish = () => {
      if (!ready || !instance || composing.current) return;
      const value = instance.getValue();
      if (value.length > 200_000) { overLimit = true; setError("文档最多支持 200,000 字符。请撤销或删减后保存。"); return; }
      if (overLimit) { overLimit = false; setError(""); }
      // Opening a document must not normalize and overwrite its original source.
      if (value === baseline.current) return;
      baseline.current = value; lastPublished.current = value; latest.current.onChange(value);
    };
    publishRef.current = publish;
    const upload = (files: File[]) => {
      if (!instance || uploads.current) return uploads.current ?? Promise.resolve();
      const editor = instance;
      const selection = getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      const input = editor.vditor.sv!.element;
      const start = input.selectionStart, end = input.selectionEnd;
      editor.disabled(); setUploading(true); setError("");
      const operation = (async () => {
        const inserted: string[] = [], failures: string[] = [];
        for (const file of files) {
          try { inserted.push(`![${file.name.replace(/[\[\]\\\r\n]/g, "_")}](${await latest.current.onImage(file)})`); }
          catch (cause) { failures.push(cause instanceof Error ? cause.message : String(cause)); }
        }
        if (disposed) return;
        editor.enable();
        if (editor.getCurrentMode() === "sv") input.setSelectionRange(start, end);
        else if (range && element.contains(range.startContainer)) { selection?.removeAllRanges(); selection?.addRange(range); }
        if (inserted.length) { editor.insertMD(`\n${inserted.join("\n\n")}\n`); publish(); }
        if (failures.length) setError(failures.join("；"));
      })().finally(() => { uploads.current = null; if (!disposed) { editor.enable(); setUploading(false); } });
      uploads.current = operation;
      return operation;
    };
    element.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.isComposing) return;
      if (event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); publish(); latest.current.onSave(); }
      if (["f", "h"].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); openSearch(); }
    }, true);
    element.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) { event.preventDefault(); event.stopPropagation(); void upload(files); }
    }, true);
    element.addEventListener("drop", (event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      if (instance?.getCurrentMode() !== "sv") {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (range && element.contains(range.startContainer)) { getSelection()?.removeAllRanges(); getSelection()?.addRange(range); }
      }
      void upload(files);
    }, true);
    element.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
    element.addEventListener("compositionstart", () => { composing.current = true; }, true);
    element.addEventListener("compositionend", () => { composing.current = false; queueMicrotask(publish); }, true);
    // The engine's delayed input callback is secondary; draft recovery receives
    // actual DOM input immediately, including Chinese composition completion.
    element.addEventListener("beforeinput", (event) => { if (ready && event.target instanceof Element && event.target.closest(".vditor-panel")) instance?.vditor.undo?.addToUndoStack(instance.vditor); }, true);
    element.addEventListener("input", (event) => queueMicrotask(() => { publish(); if (ready && event.target instanceof Element && event.target.closest(".vditor-panel")) instance?.vditor.undo?.addToUndoStack(instance.vditor); }));
    void loadMarkdownEditorAssets().then(() => {
      if (disposed) return;
      instance = new Vditor(element, {
        value: latest.current.value, mode: "wysiwyg", lang: "zh_CN", cdn: MARKDOWN_EDITOR_CDN,
        cache: { enable: false }, height: "100%", undoDelay: 150,
        placeholder: "从这里开始写作…", toolbarConfig: { pin: false },
        toolbar: ["headings", "bold", "italic", "strike", "|", "list", "ordered-list", "check", "quote", "|", "link", "upload", "table", "code", "|", "undo", "redo", "|", "edit-mode"],
        preview: { mode: "editor", theme: { current: "", path: "" }, hljs: { enable: false }, markdown: { sanitize: true, codeBlockPreview: false, autoSpace: false, fixTermTypo: false }, math: { engine: "KaTeX" } },
        hint: { emoji: {}, emojiPath: "" }, link: { isOpen: false }, image: { isPreview: false },
        upload: { handler: async (files) => { await upload(files); return null; }, accept: "image/png,image/jpeg,image/webp,image/gif", multiple: true },
        input: () => { if (!disposed) publish(); },
        customWysiwygToolbar(type, panel) {
          queueMicrotask(() => {
            if (disposed || !panel.isConnected) return;
            const bounds = panel.parentElement!.getBoundingClientRect(), rect = panel.getBoundingClientRect();
            const top = Math.max(bounds.top + 8, Math.min(rect.top, bounds.bottom - rect.height - 8));
            const left = Math.max(bounds.left + 8, Math.min(rect.left, bounds.right - rect.width - 8));
            panel.style.top = `${parseFloat(panel.style.top || "0") + top - rect.top}px`;
            panel.style.left = `${parseFloat(panel.style.left || "0") + left - rect.left}px`;
          });
          panel.querySelectorAll<HTMLInputElement>("input[placeholder]").forEach((input) => input.setAttribute("aria-label", input.placeholder));
          if (type !== "image" || !instance) return;
          const img = instance.vditor.wysiwyg!.element.querySelector<HTMLImageElement>("img[data-piora-selected]");
          if (!img) return;
          const label = document.createElement("label"); label.textContent = "宽度 ";
          const width = document.createElement("input"); width.type = "number"; width.min = "40"; width.max = "2400"; width.placeholder = "原始"; width.setAttribute("aria-label", "图片宽度（像素）"); width.value = img.getAttribute("width") ?? "";
          width.onchange = () => {
            if (!instance) return;
            instance.vditor.undo!.addToUndoStack(instance.vditor);
            if (width.value) { const pixels = Math.max(40, Math.min(2400, Number(width.value))); img.setAttribute("width", String(pixels)); img.style.width = `${pixels}px`; } else { img.removeAttribute("width"); img.style.removeProperty("width"); }
            instance.vditor.undo!.addToUndoStack(instance.vditor); publish();
          };
          label.appendChild(width); panel.appendChild(label);
        },
        after() {
          if (!instance) return;
          if (disposed) { destroyEditor(instance); element.remove(); return; }
          preserveMarkdownImageSizes(instance.vditor.lute!);
          instance.setValue(latest.current.value, true);
          ready = true; engine.current = instance; baseline.current = instance.getValue(); lastPublished.current = latest.current.value;
          for (const mode of ["wysiwyg", "ir", "sv"] as const) { const body = instance.vditor[mode]!.element; body.setAttribute("aria-label", mode === "sv" ? "Markdown 源码" : "Markdown 正文"); body.setAttribute("role", "textbox"); body.setAttribute("aria-multiline", "true"); }
          const sourceButton = element.querySelector('[data-mode="sv"]'); if (sourceButton) sourceButton.textContent = "Markdown 源码 ‹Ctrl+Alt+9›";
          element.querySelector('input[type="file"]')?.setAttribute("aria-label", "插入图片");
          element.addEventListener("click", (event) => { element.querySelectorAll("[data-piora-selected]").forEach((img) => img.removeAttribute("data-piora-selected")); if (event.target instanceof HTMLImageElement) event.target.setAttribute("data-piora-selected", "true"); }, true);
          setLoading(false);
        },
      });
    }).catch((cause) => { if (!disposed) { setError(String(cause instanceof Error ? cause.message : cause)); setLoading(false); } });
    return () => {
      publish(); disposed = true; engine.current = null;
      if (instance && ready) destroyEditor(instance);
      element.remove();
    };
    // One engine per document; autosaves and hidden tabs must retain selection
    // and native undo stacks. Callbacks and incoming values use refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  useEffect(() => {
    const editor = engine.current;
    if (!editor || props.value === lastPublished.current) return;
    editor.setValue(props.value); baseline.current = editor.getValue(); lastPublished.current = props.value;
  }, [props.value]);

  return <div className="pocket-markdown-editor" data-uploading={uploading}>
    {searching ? <div className="pocket-editor-search" role="search" aria-label="查找与替换 Markdown 源码">
      <input ref={searchInput} aria-label="查找内容" placeholder="查找源码" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") find(); if (event.key === "Escape") setSearching(false); }} />
      <input aria-label="替换为" placeholder="替换为" value={replacement} onChange={(event) => setReplacement(event.target.value)} />
      <button type="button" onClick={() => find()}>下一处</button><button type="button" onClick={() => find(true)}>替换</button><button type="button" onClick={() => find(true, true)}>全部替换</button><button type="button" aria-label="关闭查找" onClick={() => setSearching(false)}>×</button><span role="status">{searchStatus}</span>
    </div> : null}
    {loading ? <p role="status">正在打开编辑器…</p> : null}
    {uploading ? <p className="pocket-editor-notice" role="status">正在保存图片，完成后可继续编辑…</p> : null}
    {error ? <p className="pocket-editor-notice" role="alert">{error}{!engine.current ? <button type="button" onClick={() => { setLoading(true); setError(""); setAttempt((value) => value + 1); }}>重试</button> : <button type="button" onClick={() => setError("")}>关闭</button>}</p> : null}
    <div ref={host} className="pocket-editor-host" />
  </div>;
});
