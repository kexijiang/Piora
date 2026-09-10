"use client";
import { useClipboardI18n } from "./useClipboardI18n";
import { useEffect, useRef, useState, type RefObject } from "react";
import { AliIcon } from "@/components/AliIcon";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import type { ClipboardFilter, ClipboardStatus } from "@/desktop/src/clipboard-types";
import styles from "./ClipboardWorkspace.module.css";

export type ClipboardToolbarAction = "settings" | "record" | "shelf" | "manager" | "hide" | "capture" | "export" | "import" | "clear";
type View = { text: string; filter: ClipboardFilter; source: string; after: string; before: string; preview: boolean };
export function ClipboardToolbar({ surface, view, status, busy, search, onView, onAction }: {
  surface: "quick" | "manager" | "shelf"; view: View; status: ClipboardStatus | null; busy: boolean;
  search: RefObject<HTMLInputElement | null>; onView: (view: Partial<View>) => void; onAction: (action: ClipboardToolbarAction) => void;
}) {
  const { tr } = useClipboardI18n();
  const [panel, setPanel] = useState<"more" | "source" | "time" | null>(null);
  const root = useRef<HTMLDivElement>(null), popover = useRef<HTMLDivElement>(null);
  useFocusTrap(popover, panel !== null, { onEscape: () => setPanel(null) });
  useEffect(() => {
    if (!panel) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setPanel(null); };
    document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close);
  }, [panel]);
  const action = (value: ClipboardToolbarAction) => { setPanel(null); onAction(value); };
  const more = <button className={styles.iconButton} aria-label={tr("剪贴板更多操作")} title={tr("更多操作")} aria-haspopup="dialog" aria-expanded={panel === "more"} onClick={() => setPanel(panel === "more" ? null : "more")}><AliIcon name="ellipsis" size={18} /></button>;
  const settings = <button className={styles.iconButton} aria-label={tr("剪贴板设置")} title={tr("记录与存储设置")} onClick={() => action("settings")}><AliIcon name="setting" size={18} /></button>;
  const shelf = <button className={surface === "manager" ? styles.secondary : styles.iconButton} aria-label={tr("屏幕暂存")} title={tr("屏幕暂存")} onClick={() => action("shelf")}><AliIcon name="pushpin" size={17} />{surface === "manager" ? tr("屏幕暂存") : null}</button>;
  const filters: Array<[ClipboardFilter, string]> = [["all", tr("全部")], ["text", tr("文字")], ["image", tr("图片")], ["files", tr("文件")], ["starred", tr("收藏")]];
  return <div ref={root} className={styles.toolbar}>
    {surface !== "quick" ? <header className={styles.chrome}>
      <span className={styles.brandIcon}><AliIcon name={surface === "shelf" ? "pushpin" : "copy"} size={21} /></span>
      <strong>{surface === "shelf" ? tr("屏幕暂存") : tr("剪贴板")}</strong>
      {surface === "shelf" ? <span className={styles.count}>{status?.shelf ?? 0}</span> : <span className={styles.breadcrumb}><AliIcon name="chevron-right" size={14} />{tr("随身仓")}</span>}
      <span className={styles.spacer} />
      {surface === "manager" ? <><button className={styles.recording} disabled={!status || busy} aria-label={status?.settings.enabled ? tr("暂停记录") : tr("开启记录")} onClick={() => action("record")}><i data-enabled={status?.settings.enabled && (!status.storage || status.storage === "ready") && !status.locked && status.budgetState !== "full"} />{status?.storage && status.storage !== "ready" ? tr("存储中断") : status?.locked ? tr("锁屏暂停") : status?.budgetState === "full" ? tr("容量不足") : status?.settings.enabled ? tr("记录中") : tr("已暂停")}</button>{shelf}</> : null}
      {more}{surface === "manager" ? settings : <button className={styles.iconButton} aria-label={tr("隐藏剪贴板")} title={tr("隐藏窗口，保留内容")} onClick={() => action("hide")}><AliIcon name="close" size={19} /></button>}
    </header> : null}
    {surface === "shelf" ? <p className={styles.shelfHint}>{tr("常用内容，随手取用")}</p> : <>
      <div className={styles.searchRow}><div className={styles.search}><AliIcon name="search" size={20} /><input ref={search} aria-label={tr("搜索剪贴板")} maxLength={1000} placeholder={surface === "quick" ? tr("搜索剪贴板…") : tr("搜索内容、备注…")} value={view.text} onChange={event => onView({ text: event.target.value })} autoFocus={surface === "quick"} />{view.text ? <button className={styles.iconButton} aria-label={tr("清空搜索")} onClick={() => onView({ text: "" })}><AliIcon name="close" size={14} /></button> : surface === "manager" ? <kbd>Ctrl F</kbd> : null}</div>{surface === "quick" ? <>{shelf}{settings}<button className={styles.escape} aria-label={tr("隐藏剪贴板")} onClick={() => action("hide")}>Esc</button></> : null}</div>
      <div className={styles.filterRow}><nav className={styles.filters} aria-label={tr("内容类型")}>{filters.map(([id, label]) => <button key={id} aria-pressed={view.filter === id} onClick={() => onView({ filter: id })}>{label}</button>)}{view.filter === "trash" ? <button aria-pressed="true" onClick={() => onView({ filter: "trash" })}>{tr("回收站")}</button> : null}</nav><span className={styles.spacer} />
        {surface === "manager" ? <><button className={styles.filterButton} aria-expanded={panel === "source"} aria-haspopup="dialog" data-active={Boolean(view.source)} onClick={() => setPanel(panel === "source" ? null : "source")}>{tr("来源")} <span aria-hidden="true">⌄</span></button><button className={styles.filterButton} aria-expanded={panel === "time"} aria-haspopup="dialog" data-active={Boolean(view.after || view.before)} onClick={() => setPanel(panel === "time" ? null : "time")}>{tr("时间")} <span aria-hidden="true">⌄</span></button></> : more}
        <button className={styles.iconButton} aria-label={tr("预览")} title={tr("切换预览 · Alt P")} aria-pressed={view.preview} onClick={() => onView({ preview: !view.preview })}><AliIcon name="layout" size={18} /></button>
      </div>
      {view.source || view.after || view.before ? <div className={styles.activeConditions}>{view.source ? <button onClick={() => onView({ source: "" })}>{status?.sources.find(source => source.executable === view.source)?.name || view.source}<AliIcon name="close" size={12} /></button> : null}{view.after || view.before ? <button onClick={() => onView({ after: "", before: "" })}>{view.after || tr("不限")} — {view.before || tr("不限")}<AliIcon name="close" size={12} /></button> : null}</div> : null}
    </>}
    {panel ? <div ref={popover} role="dialog" aria-label={panel === "more" ? tr("剪贴板更多操作") : panel === "source" ? tr("按来源筛选") : tr("按时间筛选")} className={`${styles.popover} ${panel === "more" ? styles.moreMenu : ""}`}>
      {panel === "more" ? <>{surface !== "manager" ? <button onClick={() => action("manager")}><AliIcon name="layout" size={16} />{tr("打开管理页")}</button> : null}<button disabled={!status || busy} onClick={() => action("record")}>{status?.settings.enabled ? tr("暂停记录") : tr("开启记录")}</button><button disabled={busy} onClick={() => action("capture")}><AliIcon name="copy" size={16} />{tr("收录当前")}</button>{surface !== "shelf" ? <button onClick={() => { setPanel(null); onView({ filter: "trash" }); }}><AliIcon name="clear" size={16} />{tr("回收站")}</button> : null}{surface === "manager" ? <><hr /><button disabled={busy} onClick={() => action("export")}>{tr("导出历史…")}</button><button disabled={busy} onClick={() => action("import")}>{tr("导入合并…")}</button><p>{tr("归档未加密；密码保护请使用应用完整备份。原文件保留为路径引用。")}</p><hr /><button className={styles.danger} disabled={busy} onClick={() => action("clear")}>{view.filter === "trash" ? tr("清空回收站…") : tr("清理历史…")}</button></> : <button onClick={() => action("settings")}>{tr("记录与存储设置")}</button>}</> : panel === "source" ? <label>{tr("来源应用")}<select aria-label={tr("来源应用")} value={view.source} onChange={event => { onView({ source: event.target.value }); setPanel(null); }}><option value="">{tr("所有来源")}</option>{status?.sources.filter(source => source.executable).map(source => <option key={source.executable} value={source.executable}>{source.name}</option>)}</select></label> : <><label>{tr("从")}<input aria-label={tr("开始日期")} type="date" value={view.after} onChange={event => onView({ after: event.target.value })} /></label><label>{tr("至")}<input aria-label={tr("结束日期")} type="date" value={view.before} onChange={event => onView({ before: event.target.value })} /></label><button className={styles.secondary} onClick={() => setPanel(null)}>{tr("完成")}</button></>}
    </div> : null}
  </div>;
}
