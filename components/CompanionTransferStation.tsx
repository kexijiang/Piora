"use client";
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { CompanionLibraryItem } from "@/lib/companion-store";
import { copyText, readClipboardText } from "@/lib/clipboard";
import { AliIcon } from "./AliIcon";
import { CompanionStorageSettings } from "./CompanionStorageSettings";
import styles from "./CompanionTransferStation.module.css";

interface Props {
  items: CompanionLibraryItem[]; loaded: boolean; loading: boolean; pending: boolean; error: string;
  mutate: (method: "POST" | "PATCH", input: unknown) => Promise<boolean>;
  refresh: () => Promise<void>;
}
const KIND_LABELS = { note: "文字", code: "代码", command: "命令", image: "图片" };
async function imageData(file: Blob) {
  if (file.size > 8 * 1024 * 1024) throw new Error("单张图片不能超过 8 MB。");
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("支持 PNG、JPEG、WebP 和 GIF 图片。");
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("图片读取失败。")); reader.readAsDataURL(file); });
}
async function clipboardPng(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("图片读取失败。");
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片复制失败。")), "image/png"));
  } finally { bitmap.close(); }
}
export function CompanionTransferStation({ items, loaded, loading, pending, error, mutate, refresh }: Props) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "image" | "text">("all");
  const [settings, setSettings] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [localError, setLocalError] = useState("");
  const [preview, setPreview] = useState<CompanionLibraryItem | null>(null);
  const dragDepth = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  const visible = items.filter((item) => (filter === "all" || (filter === "image" ? item.kind === "image" : item.kind !== "image")) && `${item.title} ${item.kind === "image" ? "" : item.content}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
  const capture = async (text: string, title?: string, image = false) => {
    const saved = await mutate("POST", { content: text, title, kind: image ? "image" : /^\s*[\[{]/.test(text) ? "code" : "note" });
    if (saved) { setNotice("已暂存"); setLocalError(""); }
    return saved;
  };
  const captureFiles = async (files: File[]) => {
    for (const file of files) {
      try { if (!await capture(await imageData(file), file.name === "image.png" ? undefined : file.name, true)) break; }
      catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
    }
  };
  const paste = (event: ClipboardEvent) => {
    if (!event.clipboardData || event.defaultPrevented) return;
    const target = event.target;
    // Editing fields own text paste, including an EMPTY textarea. The page-wide
    // quick-capture shortcut must not consume the browser's insertion event.
    if (target instanceof Element && target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") && event.clipboardData.getData("text/plain")) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length) { event.preventDefault(); void captureFiles(files); return; }
    if (target instanceof Element && target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
    const text = event.clipboardData.getData("text/plain");
    if (text.trim()) { event.preventDefault(); void capture(text); }
  };
  const pasteRef = useRef(paste);
  pasteRef.current = paste;
  useEffect(() => {
    const listener = (event: ClipboardEvent) => pasteRef.current(event);
    document.addEventListener("paste", listener);
    return () => document.removeEventListener("paste", listener);
  }, []);
  const pasteButton = async () => {
    try {
      if (window.piDesktop?.clipboard) {
        const image = await window.piDesktop.clipboard.readImage();
        if (image) await capture(image, undefined, true);
        else { setDraft(await readClipboardText()); draftRef.current?.focus(); setLocalError(""); }
        return;
      }
      if (!navigator.clipboard.read) { setDraft(await readClipboardText()); draftRef.current?.focus(); setLocalError(""); return; }
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((type) => /^image\/(png|jpeg|webp|gif)$/.test(type));
        if (type) await capture(await imageData(await item.getType(type)), undefined, true);
        else if (item.types.includes("text/plain")) { setDraft(await (await item.getType("text/plain")).text()); draftRef.current?.focus(); setLocalError(""); }
      }
    } catch { setLocalError("请直接按 Ctrl / ⌘ + V，或把图片拖进来。"); }
  };
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (event.dataTransfer.files.length) void captureFiles(Array.from(event.dataTransfer.files));
    else { const text = event.dataTransfer.getData("text/plain"); if (text.trim()) void capture(text); }
  };
  const copy = async (item: CompanionLibraryItem) => {
    try {
      if (item.kind === "image" && window.piDesktop?.clipboard) {
        const blob = await clipboardPng(item.content);
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
        await window.piDesktop.clipboard.writeImage(data);
      } else if (item.kind === "image") await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardPng(item.content) })]);
      else await copyText(item.content);
      setNotice("已复制，可以粘贴到其他地方"); setLocalError("");
    } catch { setLocalError("剪贴板不可用，请在预览中复制文字或保存图片。"); }
  };
  return <section className={styles.station} aria-label="中转站" onDragEnter={(event) => { event.preventDefault(); dragDepth.current++; setDragging(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={() => { dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); }} onDrop={drop}>
    <header className={styles.heading}><div><h1>中转站</h1><p>随手放下，需要时带走。</p></div><button type="button" aria-label="中转站存储位置" aria-expanded={settings} onClick={() => setSettings(!settings)}><AliIcon name="setting" size={17} /></button></header>
    {settings ? <CompanionStorageSettings scope="library" compact /> : null}
    <div className={styles.capture} data-dragging={dragging}>
      <textarea ref={draftRef} aria-label="暂存内容" placeholder="写点什么，或直接粘贴、拖入图片…" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing && draft.trim() && !pending) { event.preventDefault(); void capture(draft).then((saved) => { if (saved) setDraft((current) => current === draft ? "" : current); }); } }} />
      <div><span><AliIcon name="attachment" size={13} />文字粘贴后暂存 · 图片直接存入</span>{draft.trim() ? <button className={styles.primary} disabled={pending} type="button" onClick={() => void capture(draft).then((saved) => { if (saved) setDraft((current) => current === draft ? "" : current); })}>暂存 <kbd>⌘ / Ctrl ↵</kbd></button> : <button type="button" onClick={() => void pasteButton()}><AliIcon name="copy" size={13} />粘贴</button>}</div>
    </div>
    <div className={styles.toolbar}><div className={styles.filters}>{(["all", "text", "image"] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{{ all: "全部", text: "文字", image: "图片" }[value]}</button>)}<small>{items.length}</small></div><label className={styles.search}><AliIcon name="search" size={14} /><input aria-label="搜索暂存内容" placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    <div className={styles.grid}>{visible.map((item) => <article className={styles.item} key={item.id}>
      <button className={styles.preview} type="button" aria-label={`预览 ${item.title}`} onClick={() => { setPreview(item); dialogRef.current?.showModal(); }}>{item.kind === "image" ? <span className={styles.image} role="img" aria-label={item.title} style={{ backgroundImage: `url(${JSON.stringify(item.content)})` }} /> : <pre>{item.content}</pre>}</button>
      <div className={styles.itemFooter}><span title={item.title}>{item.pinned ? <AliIcon name="pushpin" size={12} /> : null}{item.title}<small>{KIND_LABELS[item.kind]}</small></span><button type="button" title="复制" aria-label={`复制 ${item.title}`} onClick={() => void copy(item)}><AliIcon name="copy" size={14} /></button><button type="button" title={item.pinned ? "取消置顶" : "置顶"} aria-label={`${item.pinned ? "取消置顶" : "置顶"} ${item.title}`} aria-pressed={item.pinned} onClick={() => void mutate("PATCH", { id: item.id, pinned: !item.pinned })}><AliIcon name="pushpin" size={14} /></button><button type="button" title="移除" aria-label={`移除 ${item.title}`} onClick={() => void mutate("PATCH", { id: item.id, remove: true })}><AliIcon name="close" size={14} /></button></div>
    </article>)}</div>
    {!visible.length ? <div className={styles.empty}><AliIcon name="archive" size={29} /><b>{!loaded && error ? "中转站暂时未能打开" : !loaded && loading ? "正在打开中转站…" : query ? "没有找到相关内容" : filter !== "all" && items.length ? "还没有这类内容" : "给手边的东西，一个落脚点"}</b><span>{!loaded && error ? "可以继续编辑输入内容，点击下方重试加载。" : query ? "换个关键词试试" : "文字、链接、代码、图片，粘贴或拖入就好。"}</span></div> : null}
    <footer className={styles.status} role={error || localError ? "alert" : "status"} data-error={Boolean(error || localError)} title={localError || error}><span>{localError || error || (pending ? "正在暂存…" : notice || "保存在本机，直到你手动移除。")}</span>{error && <button type="button" onClick={() => void refresh().then(() => setLocalError("")).catch((cause: unknown) => setLocalError(cause instanceof Error ? cause.message : String(cause)))}>重试</button>}{localError && <button aria-label="关闭提示" onClick={() => setLocalError("")}><AliIcon name="close" size={12} /></button>}</footer>
    {dragging ? <div className={styles.dropOverlay}><AliIcon name="arrowdown" size={28} /><b>松手，放在这里</b></div> : null}
    <dialog ref={dialogRef} className={styles.dialog} onClick={(event) => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}><header><b>{preview?.title}</b><button type="button" aria-label="关闭预览" onClick={() => dialogRef.current?.close()}><AliIcon name="close" size={17} /></button></header>{preview?.kind === "image" ? <div className={styles.largeImage} role="img" aria-label={preview.title} style={{ backgroundImage: `url(${JSON.stringify(preview.content)})` }} /> : <pre>{preview?.content}</pre>}<footer>{preview ? <button type="button" onClick={() => void copy(preview)}>复制{preview.kind === "image" ? "图片" : "内容"}</button> : null}{preview?.kind === "image" ? <a href={preview.content} download={preview.title}>保存图片</a> : null}</footer></dialog>
  </section>;
}
