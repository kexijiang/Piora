"use client";

import { useMemo, useState } from "react";
import type { CompanionLibraryItem } from "@/lib/companion-store";
import { transferTreeRows } from "@/lib/transfer-workspace";
import { AliIcon } from "./AliIcon";
import styles from "./CompanionTransferStation.module.css";

export function TransferFileTree({ items, selectedId, folderId, query, onQuery, onOpen, onFolder, onMove, onCreateFolder, onRenameFolder, onDeleteFolder, onDeleteFile, disabled }: {
  items: CompanionLibraryItem[]; selectedId: string | null; folderId: string | null; query: string; disabled: boolean;
  onQuery: (query: string) => void; onOpen: (item: CompanionLibraryItem) => void; onFolder: (id: string | null) => void;
  onMove: (id: string, parentId: string | null) => void; onCreateFolder: (name: string) => Promise<boolean>;
  onRenameFolder: (name: string) => Promise<boolean>; onDeleteFolder: () => void;
  onDeleteFile: (id: string) => Promise<boolean>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<"create" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleting = items.find((item) => item.id === deleteId);
  const rows = useMemo(() => transferTreeRows(items, collapsed, query), [items, collapsed, query]);
  const folder = items.find((item) => item.id === folderId);
  const drop = (event: React.DragEvent, parentId: string | null) => {
    const id = event.dataTransfer.getData("application/x-piora-transfer-id");
    if (!id) return;
    event.preventDefault(); event.stopPropagation(); onMove(id, parentId);
  };
  return <nav className={styles.fileSidebar} aria-label="文件夹和文件">
    <div className={styles.fileSidebarHeader}>
      <button type="button" aria-pressed={folderId === null} onClick={() => onFolder(null)} onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-piora-transfer-id")) event.preventDefault(); }} onDrop={(event) => drop(event, null)}><AliIcon name="folder-open" size={14} />所有文件</button>
      <button type="button" title="新建文件夹" aria-label="新建文件夹" disabled={disabled} onClick={() => { setEditing("create"); setName(""); }}><AliIcon name="plus" size={14} /></button>
    </div>
    <label className={styles.search}><AliIcon name="search" size={14} /><input aria-label="搜索文档" placeholder="搜索文件…" value={query} onChange={(event) => onQuery(event.target.value)} /></label>
    {folder ? <div className={styles.folderActions}><span title={folder.title}>{folder.title}</span>
      <button type="button" aria-label="重命名文件夹" title="重命名文件夹" disabled={disabled} onClick={() => { setEditing("rename"); setName(folder.title); }}><AliIcon name="edit" size={12} /></button>
      <button type="button" aria-label="删除空文件夹" title="删除空文件夹" disabled={disabled || items.some((item) => item.parentId === folder.id)} onClick={onDeleteFolder}><AliIcon name="delete" size={12} /></button>
    </div> : null}
    {editing ? <form className={styles.folderForm} onSubmit={(event) => {
      event.preventDefault();
      void (editing === "create" ? onCreateFolder(name) : onRenameFolder(name)).then((ok) => { if (ok) setEditing(null); });
    }}><input autoFocus aria-label="文件夹名称" placeholder="文件夹名称" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); }} /><button type="submit" disabled={disabled || !name.trim()} aria-label="保存文件夹名称"><AliIcon name="check" size={13} /></button><button type="button" aria-label="取消" onClick={() => setEditing(null)}><AliIcon name="close" size={13} /></button></form> : null}
    <div className={styles.fileTree}>
      {rows.map(({ item, depth }) => <div key={item.id} className={styles.treeRow} data-selected={item.id === (selectedId ?? folderId)}><button type="button" className={styles.treeItem} style={{ paddingLeft: 10 + depth * 14 }} title={item.title}
        aria-current={item.id === (selectedId ?? folderId) ? "true" : undefined} aria-expanded={item.kind === "folder" ? Boolean(query) || !collapsed.has(item.id) : undefined}
        draggable={!disabled} onDragStart={(event) => { event.dataTransfer.setData("application/x-piora-transfer-id", item.id); event.dataTransfer.effectAllowed = "move"; }}
        onDragOver={(event) => { if (item.kind === "folder" && event.dataTransfer.types.includes("application/x-piora-transfer-id")) event.preventDefault(); }}
        onDrop={(event) => { if (item.kind === "folder") drop(event, item.id); }}
        onClick={() => {
          if (item.kind !== "folder") { onOpen(item); return; }
          onFolder(item.id); setCollapsed((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; });
        }}>
        {item.kind === "folder" ? <span className={styles.folderChevron}>{collapsed.has(item.id) && !query ? "›" : "⌄"}</span> : <span className={styles.folderChevron} />}
        <AliIcon name={item.kind === "folder" ? collapsed.has(item.id) ? "folder" : "folder-open" : item.kind === "image" ? "attachment" : "file"} size={14} /><span>{item.title || "未命名文档"}</span>
      </button>{item.kind !== "folder" ? <button type="button" className={styles.treeDelete} aria-label={`删除 ${item.title || "未命名文档"}`} title="删除文件" disabled={disabled} onClick={() => setDeleteId(item.id)}><AliIcon name="delete" size={13} /></button> : null}</div>)}
      {!rows.length ? <p className={styles.listEmpty}>{query ? "没有匹配的文件" : "还没有文件"}</p> : null}
    </div>
    {deleting ? <div className={styles.deleteConfirmation} role="alertdialog" aria-label="确认删除文件" onKeyDown={(event) => { if (event.key === "Escape" && !disabled) setDeleteId(null); }}>
      <p>删除「{deleting.title || "未命名文档"}」？</p>
      <div><button type="button" disabled={disabled} onClick={() => setDeleteId(null)}>取消</button><button type="button" disabled={disabled} onClick={() => { void onDeleteFile(deleting.id).then((removed) => { if (removed) setDeleteId(null); }); }}>确认删除</button></div>
    </div> : null}
    <small className={styles.fileCount}>{items.filter((item) => item.kind !== "folder").length} 个文件 · {items.filter((item) => item.kind === "folder").length} 个文件夹</small>
  </nav>;
}
