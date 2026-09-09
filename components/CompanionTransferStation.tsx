"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { markdownOutline } from "@/lib/markdown-outline";
import { MarkdownBody } from "./MarkdownBody";
import dynamic from "next/dynamic";
import type { CompanionLibraryItem } from "@/lib/companion-store";
import { createMarkdownDraft } from "@/lib/markdown-draft";
import { copyText } from "@/lib/clipboard";
import { AliIcon } from "./AliIcon";
import { CompanionStorageSettings } from "./CompanionStorageSettings";
import { TransferFileTree } from "./TransferFileTree";
import { TransferWorkspaceFrame, type TransferWorkspaceFrameHandle } from "./TransferWorkspaceFrame";
import { closeTransferTab, restoreTransferTabs, transferFolderPath, type TransferTabs } from "@/lib/transfer-workspace";
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

function MarkdownDocument({ item, write, onCreated, onDeleted, registerSave }: { item: CompanionLibraryItem; write: Write; onCreated: (item: CompanionLibraryItem) => void; onDeleted: () => void; registerSave: (id: string, save: (() => Promise<boolean>) | null) => void }) {
  const [controller] = useState(() => createMarkdownDraft(item, async (value) => {
    const items = await write("PATCH", { id: item.id, ...value });
    const saved = items.find((entry) => entry.id === item.id);
    if (!saved) throw new Error("保存响应缺少文档，草稿已保留。");
    return saved;
  }, typeof window === "undefined" ? undefined : window.localStorage));
  const draft = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [source, setSource] = useState(false);
  const [preview, setPreview] = useState(false);
  const [outlineVisible, setOutlineVisible] = useState(false);
  const outline = useMemo(() => markdownOutline(draft.content), [draft.content]);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const editor = useRef<MarkdownEditorHandle>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => controller.syncMetadata(item), [controller, item]);
  useEffect(() => { registerSave(item.id, controller.save); return () => registerSave(item.id, null); }, [controller, item.id, registerSave]);
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
      <button type="button" title="撤销 · Ctrl+Z" aria-label="撤销" disabled={preview} onClick={() => editor.current?.undo()}>↶</button>
      <button type="button" title="重做 · Ctrl+Shift+Z" aria-label="重做" disabled={preview} onClick={() => editor.current?.redo()}>↷</button>
      <button type="button" aria-label="插入标题" onClick={() => editor.current?.insert("## ")}>H₂</button>
      <button type="button" aria-label="加粗" title="加粗 · Ctrl+B" onClick={() => editor.current?.insert("**", "**")}><b>B</b></button>
      <button type="button" aria-label="斜体" title="斜体 · Ctrl+I" onClick={() => editor.current?.insert("*", "*")}><i>I</i></button>
      <button type="button" aria-label="插入列表" onClick={() => editor.current?.insert("\n- ")}>≡</button>
      <button type="button" aria-label="插入待办" onClick={() => editor.current?.insert("\n- [ ] ")}>☐</button>
      <button type="button" aria-label="插入引用" onClick={() => editor.current?.insert("\n> ")}>❞</button>
      <button type="button" aria-label="插入代码块" onClick={() => editor.current?.insert("\n```\n", "\n```\n")}>{"</>"}</button>
      <button type="button" aria-label="插入链接" onClick={() => editor.current?.insert("[", "](https://)")}>↗</button>
      <button type="button" aria-label="插入图片" disabled={actionPending} onClick={() => imageInput.current?.click()}><AliIcon name="attachment" size={15} /></button>
      <button type="button" aria-label="插入表格" onClick={() => editor.current?.insert("\n| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |\n")}>▦</button>
      <button type="button" aria-label="插入公式" onClick={() => editor.current?.insert("\n$$\n", "\n$$\n")}>∑</button>
      <span className={styles.toolbarSpace} />
      <button type="button" aria-pressed={outlineVisible} onClick={() => setOutlineVisible(!outlineVisible)}>大纲</button>
      <button type="button" title="查找与替换 · Ctrl+F / Ctrl+H" disabled={preview} onClick={() => editor.current?.search()}><AliIcon name="search" size={14} /></button>
      <button type="button" aria-pressed={source && !preview} onClick={() => { setPreview(false); setSource(!source); }}>{source ? "即时排版" : "源码"}</button>
      <button type="button" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? "编辑" : "阅读"}</button>
    </div>
    <input ref={imageInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file); event.target.value = ""; }} />
    <div className={styles.writingBody}>
      {outlineVisible ? <nav className={styles.outline} aria-label="文档大纲">{outline.length ? outline.map((heading) => <button type="button" key={heading.offset} title={heading.title} style={{ paddingLeft: 10 + (heading.level - 1) * 12 }} onClick={() => { setPreview(false); requestAnimationFrame(() => editor.current?.jumpTo(heading.offset)); }}>{heading.title || "无标题"}</button>) : <p>使用 # 标题建立大纲</p>}</nav> : null}
      <div className={styles.writingContent}>
        <div hidden={preview} className={styles.editorMount}><MarkdownEditor ref={editor} value={draft.content} source={source} onChange={(content) => { controller.update({ content }); setNotice(""); }} onSave={() => { void controller.save(); }} onImage={(file) => { void uploadImage(file); }} /></div>
        {preview ? <div className={styles.readingPreview}><MarkdownBody>{draft.content}</MarkdownBody></div> : null}
      </div>
    </div>
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
  const [tabs, setTabs] = useState<TransferTabs>({ ids: [], activeId: null });
  const [restored, setRestored] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [writingWidth, setWritingWidth] = useState(820);
  const [writingSize, setWritingSize] = useState(16);
  const [focusMode, setFocusMode] = useState(false);
  const widthRef = useRef(210);
  const stationRef = useRef<HTMLDivElement>(null);
  const workspaceFrame = useRef<TransferWorkspaceFrameHandle>(null);
  const sidebarResize = useResizablePanel({ ariaLabel: "调整文件列表宽度", cssVariable: "--transfer-sidebar-width", defaultWidth: 210, minWidth: 130, maxWidth: 420,
    getMaxWidth: () => Math.max(130, Math.min(420, (stationRef.current?.clientWidth ?? 800) * .45)), growthDirection: "right", storageKey: "piora:transfer-sidebar-width:v1", widthRef, panelRef: stationRef });
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem("piora:transfer-writing:v1") ?? "null"); if (saved) { if (Number.isFinite(saved.width)) setWritingWidth(Math.max(420, Math.min(1400, saved.width))); if (Number.isFinite(saved.size)) setWritingSize(Math.max(12, Math.min(24, saved.size))); } } catch { /* Optional layout. */ } }, []);
  const updateWriting = (width: number, size: number) => { setWritingWidth(width); setWritingSize(size); try { localStorage.setItem("piora:transfer-writing:v1", JSON.stringify({ width, size })); } catch { /* Layout still works. */ } };
  const saves = useRef(new Map<string, () => Promise<boolean>>());
  const closing = useRef(new Set<string>());
  const registerSave = useCallback((id: string, save: (() => Promise<boolean>) | null) => { if (save) saves.current.set(id, save); else saves.current.delete(id); }, []);
  const input = useRef<HTMLInputElement>(null);
  const selected = items.find((item) => item.id === tabs.activeId && item.kind !== "folder");
  const documents = tabs.ids.flatMap((id) => { const item = items.find((item) => item.id === id && item.kind !== "folder"); return item ? [item] : []; });
  useEffect(() => {
    if (!loaded || !restored) return;
    setTabs((current) => {
      const next = restoreTransferTabs(current, items);
      return next.activeId === current.activeId && next.ids.length === current.ids.length ? current : next;
    });
    if (folderId && !items.some((item) => item.id === folderId && item.kind === "folder")) setFolderId(null);
  }, [items, loaded, restored, folderId]);
  useEffect(() => {
    if (!loaded || restored) return;
    let saved: unknown = null;
    try { saved = JSON.parse(localStorage.getItem("piora:transfer-tabs:v1") ?? "null"); } catch { /* Optional UI state. */ }
    setTabs(restoreTransferTabs(saved, items)); setRestored(true);
  }, [items, loaded, restored]);
  useEffect(() => {
    if (!restored) return;
    try { localStorage.setItem("piora:transfer-tabs:v1", JSON.stringify(tabs)); } catch { /* Editing stays available. */ }
  }, [restored, tabs]);
  const open = (item: CompanionLibraryItem) => {
    if (item.kind === "folder") { setFolderId(item.id); return; }
    setTabs((current) => ({ ids: current.ids.includes(item.id) ? current.ids : [...current.ids, item.id], activeId: item.id }));
    setFolderId(item.parentId ?? null); setNotice("");
  };
  const close = async (id: string) => {
    if (closing.current.has(id)) return;
    closing.current.add(id);
    try {
      const save = saves.current.get(id);
      if (save && !await save()) { setTabs((current) => ({ ...current, activeId: id })); setNotice("文档尚未保存，已保留标签页。请重试保存或另存副本。"); return; }
      setTabs((current) => closeTransferTab(current, id));
    } finally { closing.current.delete(id); }
  };
  const mutateFolder = async (method: "POST" | "PATCH", value: unknown) => {
    setBusy(true);
    try { const result = await write(method, value); setNotice(""); return result; }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); return null; }
    finally { setBusy(false); }
  };
  const move = async (id: string, parentId: string | null) => {
    const save = saves.current.get(id);
    if (save && !await save()) { setNotice("请先保存文档，再移动文件。"); return; }
    const result = await mutateFolder("PATCH", { id, parentId });
    if (result) { setFolderId(parentId); setTabs((current) => ({ ...current })); }
  };
  const deleteFile = async (id: string): Promise<boolean> => {
    if (busy || pending || closing.current.has(id)) return false;
    closing.current.add(id); setBusy(true); setNotice("");
    try {
      const save = saves.current.get(id);
      if (save && !await save()) { setNotice("文档尚未保存，未删除文件。请先保存或另存副本。"); return false; }
      await write("PATCH", { id, remove: true });
      setTabs((current) => closeTransferTab(current, id));
      return true;
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { closing.current.delete(id); setBusy(false); }
  };
  const create = async (title = "未命名文档", content = "") => {
    setBusy(true);
    try { const result = await write("POST", { title, content, language: "markdown", parentId: folderId }); open(result[0]); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const importFiles = async (files: File[]) => {
    setBusy(true);
    try {
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          const result = await write("POST", { title: file.name, content: await imageData(file), kind: "image", parentId: folderId }); open(result[0]);
        } else {
          if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("请选择 .md、.markdown、.txt 或图片文件。");
          if (file.size > 2 * 1024 * 1024) throw new Error("文档文件过大，最多支持 200,000 字符。");
          const content = await file.text();
          if (content.length > 200_000) throw new Error("文档最多支持 200,000 字符。");
          const result = await write("POST", { title: file.name.replace(/\.(md|markdown|txt)$/i, ""), content, language: "markdown", parentId: folderId }); open(result[0]);
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
        <button type="button" aria-expanded={layoutOpen} onClick={() => setLayoutOpen(!layoutOpen)}>版式</button>
        <button type="button" aria-pressed={focusMode} onClick={() => setFocusMode(!focusMode)}>{focusMode ? "退出专注" : "专注"}</button>
        <button type="button" disabled={busy || pending || !loaded} onClick={() => input.current?.click()}>导入</button>
        <button className={styles.primary} type="button" disabled={busy || pending || !loaded} onClick={() => void create()}><AliIcon name="plus" size={14} />新建</button>
        <button type="button" aria-label="中转站存储位置" aria-expanded={settings} onClick={() => setSettings(!settings)}><AliIcon name="setting" size={16} /></button>
      </div>
    </header>
    <input ref={input} hidden type="file" accept=".md,.markdown,.txt,image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    {settings ? <CompanionStorageSettings scope="library" compact /> : null}
    {layoutOpen ? <div className={styles.layoutControls}><label>正文宽度 <input type="range" min="420" max="1400" step="20" value={writingWidth} onChange={(event) => updateWriting(Number(event.target.value), writingSize)} /><output>{writingWidth} px</output></label><label>字号 <input type="range" min="12" max="24" value={writingSize} onChange={(event) => updateWriting(writingWidth, Number(event.target.value))} /><output>{writingSize} px</output></label><button type="button" onClick={() => { sidebarResize.resetWidth(); workspaceFrame.current?.resetSize(); updateWriting(820, 16); }}>恢复默认</button><span>拖动左右边缘或底部调整大小</span></div> : null}
    {error || notice ? <div className={styles.error} role="alert"><span>{notice || error}</span><button type="button" onClick={() => { setNotice(""); void refresh().catch(() => {}); }}>重试</button></div> : null}
    <TransferWorkspaceFrame ref={workspaceFrame}>
    <div ref={stationRef} className={styles.workspace} data-focus={focusMode} style={{ "--writing-width": `${writingWidth}px`, "--writing-size": `${writingSize}px` } as CSSProperties}>
      {sidebarVisible ? <TransferFileTree items={items} selectedId={selected?.id ?? null} folderId={folderId} query={query} onQuery={setQuery} onOpen={open} onFolder={setFolderId} disabled={busy || pending || !loaded}
        onDeleteFile={deleteFile}
        onMove={(id, parentId) => { void move(id, parentId); }}
        onCreateFolder={async (title) => { const result = await mutateFolder("POST", { title, content: "", kind: "folder", parentId: folderId }); if (result) setFolderId(result[0].id); return Boolean(result); }}
        onRenameFolder={async (title) => Boolean(await mutateFolder("PATCH", { id: folderId, title }))}
        onDeleteFolder={() => { void mutateFolder("PATCH", { id: folderId, remove: true }).then((result) => { if (result) setFolderId(null); }); }} /> : null}
      {sidebarVisible && !focusMode ? <div className={styles.resizeHandle} {...sidebarResize.separatorProps} /> : null}
      <div className={styles.editorArea}>
      <div className={styles.tabBar}>
        <button type="button" aria-label={sidebarVisible ? "隐藏文件列表" : "显示文件列表"} title={sidebarVisible ? "隐藏文件列表" : "显示文件列表"} aria-expanded={sidebarVisible} onClick={() => setSidebarVisible(!sidebarVisible)}><AliIcon name="folder" size={15} /></button>
        <div className={styles.fileTabs} role="tablist" aria-label="中转站文件" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          if (index < 0 || !tabs.length) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          tabs[next].click(); tabs[next].focus();
        }}>{documents.map((item) => <div className={styles.fileTabGroup} data-active={selected?.id === item.id} key={item.id}><button type="button" role="tab" className={styles.fileTab}
          id={`transfer-tab-${item.id}`} aria-controls={`transfer-pane-${item.id}`} aria-selected={selected?.id === item.id} tabIndex={selected?.id === item.id || !documents.some((entry) => entry.id === selected?.id) ? 0 : -1}
          title={item.title || "未命名文档"} onClick={(event) => { open(item); event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}>
          <AliIcon name={item.kind === "image" ? "attachment" : "file"} size={14} /><span>{item.title || "未命名文档"}</span>
        </button><button type="button" className={styles.tabClose} aria-label={`关闭 ${item.title || "未命名文档"}`} title="关闭标签页" onClick={() => { void close(item.id); }}><AliIcon name="close" size={12} /></button></div>)}{!documents.length ? <span className={styles.listEmpty}>{loading ? "正在加载…" : "未打开文档"}</span> : null}</div>
        {documents.length ? <select className={styles.openTabsMenu} aria-label="所有已打开的标签页" title="所有已打开的标签页" value={selected?.id ?? ""} onChange={(event) => { const item = items.find((item) => item.id === event.target.value); if (item) open(item); }}><option value="" disabled>已打开</option>{documents.map((item) => <option key={item.id} value={item.id}>{item.title || "未命名文档"}</option>)}</select> : null}
      </div>
      <div className={styles.breadcrumb}>中转站{folderId ? ` / ${transferFolderPath(items, folderId)}` : ""}{selected ? ` / ${selected.title}` : ""}
        {selected ? <select aria-label="移动当前文件到文件夹" value={selected.parentId ?? ""} disabled={pending || busy} onChange={(event) => { void move(selected.id, event.target.value || null); }}><option value="">根目录</option>{items.filter((item) => item.kind === "folder").map((item) => <option key={item.id} value={item.id}>{transferFolderPath(items, item.id)}</option>)}</select> : null}
      </div>
      {documents.map((item) => <div key={item.id} className={styles.tabPane} role="tabpanel" id={`transfer-pane-${item.id}`} aria-labelledby={`transfer-tab-${item.id}`} hidden={item.id !== selected?.id}>
        {item.kind === "image" ? <article className={styles.imageDocument}>
          <h2>{item.title}</h2><div className={styles.largeImage} role="img" aria-label={item.title} style={{ backgroundImage: `url(${JSON.stringify(item.content)})` }} />
          <a href={item.content} download={item.title}>保存图片</a>
          <button type="button" onClick={() => void copyText(imageMarkdown(item)).then(() => setNotice("已复制图片 Markdown，可粘贴到文档中。")).catch(() => setNotice("复制失败"))}>复制 Markdown</button>
          <button type="button" disabled={pending} onClick={() => void write("PATCH", { id: item.id, remove: true }).then(() => setTabs((current) => closeTransferTab(current, item.id))).catch((cause) => setNotice(String(cause)))}>删除图片</button>
        </article> : <MarkdownDocument item={item} write={write} onCreated={open} registerSave={registerSave} onDeleted={() => setTabs((current) => closeTransferTab(current, item.id))} />}
      </div>)}
      {!selected ? <div className={styles.empty}>
        <AliIcon name="file" size={32} /><h2>{!loaded && error ? "暂时无法打开文档" : loading ? "正在打开中转站…" : "留一页，给此刻的想法"}</h2>
        <p>支持 Markdown 即时排版与自动保存。<br />也可以将文档或图片拖到这里。</p>
        <button className={styles.primary} type="button" disabled={busy || !loaded} onClick={() => void create()}>新建文档</button>
      </div> : null}
      </div>
    </div>
    </TransferWorkspaceFrame>
  </section>;
}
