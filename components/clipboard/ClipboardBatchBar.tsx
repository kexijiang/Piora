"use client";
import { useClipboardI18n } from "./useClipboardI18n";
import type { ClipboardItem } from "@/desktop/src/clipboard-types";
import styles from "./ClipboardWorkspace.module.css";

export type ClipboardSelectionGroup = "text" | "files";
export const belongsToClipboardGroup = (item: ClipboardItem, group: ClipboardSelectionGroup) => group === "text" ? item.kind === "text" || item.kind === "link" : item.kind === "image" || item.kind === "files";

export function ClipboardBatchBar({ selected, busy, separator, customSeparator, restoreCount, onClear, onSeparator, onMerge, onGroup, onRestore, onMove, onToggle }: {
  selected: ClipboardItem[]; busy: boolean; separator: string; customSeparator: boolean; restoreCount: number;
  onClear: () => void; onSeparator: (separator: string, custom: boolean) => void; onMerge: () => void;
  onGroup: (group: ClipboardSelectionGroup) => void; onRestore: () => void;
  onMove: (index: number, direction: number) => void; onToggle: (item: ClipboardItem) => void;
}) {
  const { tr } = useClipboardI18n();
  const texts = selected.filter(item => belongsToClipboardGroup(item, "text")).length;
  const files = selected.length - texts, mixed = texts > 0 && files > 0;
  return <div className={styles.batch}>
    <div><strong>{tr("已选")} {selected.length} {tr("条")}</strong><button onClick={onClear}>{tr("取消选择")}</button>
      {mixed ? <><span>{tr("文字与文件分组使用，管理操作仍可一起执行")}</span><button onClick={() => onGroup("text")}>{tr("使用文字组（{count}）", { count: texts })}</button><button onClick={() => onGroup("files")}>{tr("使用图片和文件组（{count}）", { count: files })}</button></> : <>
        {texts ? <label>{tr("分隔符")} <select aria-label={tr("合并分隔符")} value={customSeparator ? "custom" : separator} onChange={event => onSeparator(event.target.value === "custom" ? "" : event.target.value, event.target.value === "custom")}><option value={"\n"}>{tr("换行")}</option><option value={"\n\n"}>{tr("空行")}</option><option value=" ">{tr("空格")}</option><option value=", ">{tr("逗号")}</option><option value="custom">{tr("自定义")}</option></select></label> : null}
        {texts && customSeparator ? <input aria-label={tr("自定义分隔符")} placeholder={tr("输入分隔符，可留空")} maxLength={100} value={separator} onChange={event => onSeparator(event.target.value, true)} /> : null}
        <span>{texts ? tr("合并结果：纯文本") : tr("合并结果：文件集合")}</span><button disabled={busy} onClick={onMerge}>{tr("合并预览")}</button>
      </>}
      {restoreCount ? <button onClick={onRestore}>{tr("恢复完整选择（{count}）", { count: restoreCount })}</button> : null}
    </div>
    <ol>{selected.map((item, index) => <li key={item.id}><span>{item.title}</span><button aria-label={tr("上移 {title}", { title: item.title })} disabled={!index} onClick={() => onMove(index, -1)}>↑</button><button aria-label={tr("下移 {title}", { title: item.title })} disabled={index === selected.length - 1} onClick={() => onMove(index, 1)}>↓</button><button aria-label={tr("取消选择 {title}", { title: item.title })} onClick={() => onToggle(item)}>×</button></li>)}</ol>
  </div>;
}
