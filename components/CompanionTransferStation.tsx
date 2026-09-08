"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import type { CompanionLibraryItem } from "@/lib/companion-store";
import { createMarkdownDraft } from "@/lib/markdown-draft";
import { copyText } from "@/lib/clipboard";
import { AliIcon } from "./AliIcon";
import { CompanionStorageSettings } from "./CompanionStorageSettings";
import type { MarkdownEditorHandle } from "./MarkdownEditor";
import styles from "./CompanionTransferStation.module.css";

const MarkdownEditor = dynamic(() => import("./MarkdownEditor").then((module) => module.MarkdownEditor), { ssr: false, loading: () => <p role="status">正在打开编辑器…</p> });
type Write = (method: "POST" | "PATCH", input: unknown) => Promise<CompanionLibraryItem[]>;
interface Props {
  items: CompanionLibraryItem[]; loaded: boolean; loading: boolean; pending: boolean; error: string;
  write: Write; refresh: () => Promise<void>;
}

function downloadMarkdown(title: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `${(title || "未命名文档").replace(/[<>:"/\\|?*]/g, "_")}.md`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function imageData(file: File) {
  if (file.size > 8 * 1024 * 1024) throw new Error("单张图片不能超过 8 MB。");
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("支持 PNG、JPEG、WebP 和 GIF 图片。");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });
}
const imageMarkdown = (item: CompanionLibraryItem) => `![${item.title.replace(/[\[\]\\]/g, "_")}](${item.content})`;

function MarkdownDocument({ item, write, onCreated, onDeleted }: { item: CompanionLibraryItem; write: Write; onCreated: (item: CompanionLibraryItem) => void; onDeleted: () => void }) {
  const [controller] = useState(() => createMarkdownDraft(item, async (value) => {
    const items = await write("PATCH", { id: item.id, ...value });
    const saved = items.find((entry) => entry.id === item.id);
    if (!saved) throw new Error("保存响应缺少文档，草稿已保留。");
    return saved;
  }, typeof window === "undefined" ? undefined : window.localStorage));
  const draft = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [source, setSource] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const editor = useRef<MarkdownEditorHandle>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    const flush = () => { if (document.visibilityState === "hidden") void controller.save(); };
    const leave = (event: BeforeUnloadEvent) => { const current = controller.getSnapshot(); if (current.dirty || current.saving) event.preventDefault(); };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("beforeunload", leave);
    return () => { document.removeEventListener("visibilitychange", flush); window.removeEventListener("beforeunload", leave); };
  }, [controller]);
  const action = async (run: () => Promise<void>) => {
    setActionPending(true); setNotice("");
    try { await run(); } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setActionPending(false); }
  };
  const uploadImage = (file: File) => action(async () => {
    const items = await write("POST", { content: await imageData(file), title: file.name, kind: "image" });
    editor.current?.insert(`\n${imageMarkdown(items[0])}\n`);
  });
  const remove = () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    void action(async () => {
      if (!await controller.save()) return;
      await write("PATCH", { id: item.id, remove: true }); onDeleted();
    });
  };
  return <article className={styles.document} aria-label="Markdown 文档">
    <div className={styles.documentHeader}>
      <input className={styles.title} aria-label="文档标题" maxLength={120} placeholder="未命名文档" value={draft.title} onChange={(event) => controller.update({ title: event.target.value })} />
      <div className={styles.documentActions}>
        <button type="button" title="导出 Markdown" aria-label="导出 Markdown" onClick={() => downloadMarkdown(draft.title, draft.content)}><AliIcon name="download" size={15} /></button>
        <button type="button" title="复制 Markdown" aria-label="复制 Markdown" onClick={() => void action(async () => { await copyText(draft.content); setNotice("已复制 Markdown"); })}><AliIcon name="copy" size={15} /></button>
        <button type="button" aria-label="删除文档" disabled={actionPending} onClick={remove}>{confirmDelete ? "确认删除" : <AliIcon name="delete" size={15} />}</button>
        {confirmDelete ? <button type="button" onClick={() => setConfirmDelete(false)}>取消</button> : null}
      </div>
    </div>
    <div className={styles.editorToolbar} role="toolbar" aria-label="Markdown 格式">
      <button type="button" aria-label="插入标题" onClick={() => editor.current?.insert("## ")}>H₂</button>
      <button type="button" aria-label="加粗" title="加粗 · Ctrl+B" onClick={() => editor.current?.insert("**", "**")}><b>B</b></button>
      <button type="button" aria-label="斜体" title="斜体 · Ctrl+I" onClick={() => editor.current?.insert("*", "*")}><i>I</i></button>
      <button type="button" aria-label="插入列表" onClick={() => editor.current?.insert("\n- ")}>≡</button>
      <button type="button" aria-label="插入待办" onClick={() => editor.current?.insert("\n- [ ] ")}>☐</button>
      <button type="button" aria-label="插入引用" onClick={() => editor.current?.insert("\n> ")}>❞</button>
      <button type="button" aria-label="插入代码块" onClick={() => editor.current?.insert("\n```\n", "\n```\n")}>{"</>"}</button>
      <button type="button" aria-label="插入链接" onClick={() => editor.current?.insert("[", "](https://)")}>↗</button>
      <button type="button" aria-label="插入图片" disabled={actionPending} onClick={() => imageInput.current?.click()}><AliIcon name="attachment" size={15} /></button>
      <span className={styles.toolbarSpace} /><button type="button" aria-pressed={source} onClick={() => setSource(!source)}>{source ? "即时排版" : "源码"}</button>
    </div>
    <input ref={imageInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file); event.target.value = ""; }} />
    <MarkdownEditor ref={editor} value={draft.content} source={source} onChange={(content) => { controller.update({ content }); setNotice(""); }} onSave={() => { void controller.save(); }} onImage={(file) => { void uploadImage(file); }} />
    <footer className={styles.documentStatus}>
      <span role={draft.error ? "alert" : "status"}>{draft.error || notice || (draft.saving ? "正在保存…" : draft.dirty ? draft.recovered ? "已恢复未保存草稿" : "尚未保存" : "已保存到本机")}</span>
      {draft.error ? <button type="button" disabled={actionPending} onClick={() => void action(async () => {
        const items = await write("POST", { title: `${draft.title || "未命名文档"}（副本）`, content: draft.content, language: "markdown" }); onCreated(items[0]);
      })}>另存副本</button> : null}
      {draft.dirty ? <button type="button" disabled={draft.saving} onClick={() => void controller.save()}>保存</button> : null}
      <small>{draft.content.length.toLocaleString()} 字符 · Markdown</small>
    </footer>
  </article>;
}

export function CompanionTransferStation({ items, loaded, loading, pending, error, write, refresh }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [openedIds, setOpenedIds] = useState<Set<string>>(() => new Set());
  const input = useRef<HTMLInputElement>(null);
  const selected = items.find((item) => item.id === selectedId) ?? items.find((item) => item.kind !== "image") ?? items[0];
  const documents = useMemo(() => items.filter((item) => `${item.title}\n${item.kind === "image" ? "" : item.content}`.toLowerCase().includes(query.toLowerCase())), [items, query]);
  const open = (item: CompanionLibraryItem) => {
    setOpenedIds((current) => new Set([...current, ...(selected ? [selected.id] : []), item.id]));
    setSelectedId(item.id); setNotice("");
  };
  const create = async (title = "未命名文档", content = "") => {
    setBusy(true);
    try { const result = await write("POST", { title, content, language: "markdown" }); open(result[0]); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const importFiles = async (files: File[]) => {
    setBusy(true);
    try {
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          const result = await write("POST", { title: file.name, content: await imageData(file), kind: "image" }); open(result[0]);
        } else {
          if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("请选择 .md、.markdown、.txt 或图片文件。");
          if (file.size > 2 * 1024 * 1024) throw new Error("文档文件过大，最多支持 200,000 字符。");
          const content = await file.text();
          if (content.length > 200_000) throw new Error("文档最多支持 200,000 字符。");
          const result = await write("POST", { title: file.name.replace(/\.(md|markdown|txt)$/i, ""), content, language: "markdown" }); open(result[0]);
        }
      }
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className={styles.station} aria-label="中转站" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); void importFiles(Array.from(event.dataTransfer.files));
  }}>
    <header className={styles.heading}>
      <div><h1>中转站 <span>Markdown</span></h1><p>随手记录，安心写作。</p></div>
      <div className={styles.headingActions}>
        <button type="button" disabled={busy || pending || !loaded} onClick={() => input.current?.click()}>导入</button>
        <button className={styles.primary} type="button" disabled={busy || pending || !loaded} onClick={() => void create()}><AliIcon name="plus" size={14} />新建</button>
        <button type="button" aria-label="中转站存储位置" aria-expanded={settings} onClick={() => setSettings(!settings)}><AliIcon name="setting" size={16} /></button>
      </div>
    </header>
    <input ref={input} hidden type="file" accept=".md,.markdown,.txt,image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    {settings ? <CompanionStorageSettings scope="library" compact /> : null}
    {error || notice ? <div className={styles.error} role="alert"><span>{notice || error}</span><button type="button" onClick={() => { setNotice(""); void refresh().catch(() => {}); }}>重试</button></div> : null}
    <div className={styles.workspace}>
      <div className={styles.tabBar}>
        <div className={styles.fileTabs} role="tablist" aria-label="中转站文件" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          if (index < 0 || !tabs.length) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          tabs[next].click(); tabs[next].focus();
        }}>{documents.map((item) => <button type="button" role="tab" className={styles.fileTab} key={item.id}
          id={`transfer-tab-${item.id}`} aria-controls={`transfer-pane-${item.id}`} aria-selected={selected?.id === item.id} tabIndex={selected?.id === item.id || !documents.some((entry) => entry.id === selected?.id) ? 0 : -1}
          title={item.title || "未命名文档"} onClick={(event) => { open(item); event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}>
          <AliIcon name={item.kind === "image" ? "attachment" : "file"} size={14} /><span>{item.title || "未命名文档"}</span>
        </button>)}{!documents.length ? <span className={styles.listEmpty}>{query ? "没有匹配的文件" : loading ? "正在加载…" : "还没有文件"}</span> : null}</div>
        <label className={styles.search}><AliIcon name="search" size={14} /><input aria-label="搜索文档" placeholder="搜索文档…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      </div>
      {items.filter((item) => item.id === selected?.id || openedIds.has(item.id)).map((item) => <div key={item.id} className={styles.tabPane} role="tabpanel" id={`transfer-pane-${item.id}`} aria-labelledby={`transfer-tab-${item.id}`} hidden={item.id !== selected?.id}>
        {item.kind === "image" ? <article className={styles.imageDocument}>
          <h2>{item.title}</h2><div className={styles.largeImage} role="img" aria-label={item.title} style={{ backgroundImage: `url(${JSON.stringify(item.content)})` }} />
          <a href={item.content} download={item.title}>保存图片</a>
          <button type="button" onClick={() => void copyText(imageMarkdown(item)).then(() => setNotice("已复制图片 Markdown，可粘贴到文档中。")).catch(() => setNotice("复制失败"))}>复制 Markdown</button>
          <button type="button" disabled={pending} onClick={() => void write("PATCH", { id: item.id, remove: true }).catch((cause) => setNotice(String(cause)))}>删除图片</button>
        </article> : <MarkdownDocument item={item} write={write} onCreated={open} onDeleted={() => setSelectedId(null)} />}
      </div>)}
      {!selected ? <div className={styles.empty}>
        <AliIcon name="file" size={32} /><h2>{!loaded && error ? "暂时无法打开文档" : loading ? "正在打开中转站…" : "留一页，给此刻的想法"}</h2>
        <p>支持 Markdown 即时排版与自动保存。<br />也可以将文档或图片拖到这里。</p>
        <button className={styles.primary} type="button" disabled={busy || !loaded} onClick={() => void create()}>新建文档</button>
      </div> : null}
    </div>
  </section>;
}
