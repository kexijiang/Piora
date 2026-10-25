"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { QuickAccessEntry, QuickAccessKind } from "@/desktop/src/quick-access-types";
import type { QuickAccessController } from "@/hooks/useQuickAccess";
import { useI18n } from "@/hooks/useI18n";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useAnchoredMenuPosition } from "@/hooks/useAnchoredMenuPosition";
import { quickAccessIsShortcut, quickAccessName, quickAccessPathKey, quickAccessScore } from "@/lib/quick-access";
import { AliIcon, type AliIconName } from "./AliIcon";
import styles from "./QuickAccess.module.css";

export function QuickAccessNotice({ controller }: { controller: QuickAccessController }) {
  const { t } = useI18n();
  if (!controller.error && !controller.notice) return null;
  return <div className={styles.notice} data-error={Boolean(controller.error)} role={controller.error ? "alert" : "status"}>
    <span>{controller.error ? t(controller.error) : controller.notice}</span>
    {controller.error ? <button type="button" disabled={controller.busy} onClick={() => void controller.refresh()}>{t("quickAccess.retry")}</button> : null}
    <button type="button" aria-label={t("quickAccess.dismiss")} onClick={controller.clearNotice}><AliIcon name="close" size={14} /></button>
  </div>;
}

export function QuickAccessHome({ controller, onViewAll }: { controller: QuickAccessController; onViewAll: () => void }) {
  const { t } = useI18n();
  const entries = controller.items;
  return <section className={`${styles.root} ${styles.home}`} aria-label={t("quickAccess.title")}>
    <div className={styles.sectionHeading}><span>{t("quickAccess.title")}</span><button type="button" onClick={onViewAll}>{t("quickAccess.viewAll")}<AliIcon name="chevron-right" size={12} /></button></div>
    {controller.loading ? <p className={styles.hint} role="status">{t("quickAccess.loading")}</p> : !controller.supported ? <p className={styles.hint}>{t("quickAccess.desktopOnly")}</p> : entries.length ? <div className={styles.pins}>{entries.map(item => <button key={item.id} type="button" className={styles.pin} title={item.path} disabled={controller.busy} onClick={() => void controller.open(item)}>
      <AliIcon name={item.kind === "folder" ? "folder" : quickAccessIsShortcut(item) ? "external-link" : "file"} size={17} className={styles.icon} /><span><b>{quickAccessName(item, t)}</b>{item.availability !== "available" ? <small>{t(`quickAccess.${item.availability}`)}</small> : null}</span>
    </button>)}</div> : <p className={styles.hint}>{t("quickAccess.emptyHint")}</p>}
  </section>;
}

function QuickAccessEditor({ item, controller, onClose }: { item: QuickAccessEntry | null; controller: QuickAccessController; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [target, setTarget] = useState(item?.path || "");
  const initialName = item ? quickAccessName(item, t) : "";
  const [name, setName] = useState(initialName);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const keepVisible = () => setPosition(current => {
      if (!current) return current;
      const next = constrainEditorPosition(element, current);
      return next.left === current.left && next.top === current.top ? current : next;
    });
    const observer = new ResizeObserver(keepVisible);
    observer.observe(element);
    window.addEventListener("resize", keepVisible);
    return () => { observer.disconnect(); window.removeEventListener("resize", keepVisible); };
  }, []);
  const pick = async (kind: QuickAccessKind) => {
    const value = await controller.pick(kind);
    if (value) setTarget(value);
  };
  return <dialog ref={dialog} className={styles.dialog} style={position ? { ...position, right: "auto", bottom: "auto", margin: 0 } : undefined} aria-labelledby="quick-access-editor-title" onCancel={event => { event.preventDefault(); if (!controller.busy) onClose(); }}>
    <h2 id="quick-access-editor-title" className={styles.dialogHandle}
      onPointerDown={event => {
        if (event.button !== 0 || !dialog.current) return;
        const bounds = dialog.current.getBoundingClientRect();
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId || !dialog.current) return;
        setPosition(constrainEditorPosition(dialog.current, { left: start.left + event.clientX - start.x, top: start.top + event.clientY - start.y }));
      }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    >{t(item ? "quickAccess.editTitle" : "quickAccess.addTitle")}</h2>
    <form onSubmit={async event => {
      event.preventDefault();
      if (controller.busy) return;
      const ok = await controller.mutate(item ? {
        type: "update", id: item.id,
        ...(name !== initialName ? { name } : {}),
        ...(target !== item.path ? { path: target } : {}),
      } : { type: "add", path: target, ...(name.trim() ? { name } : {}) });
      if (ok) onClose();
    }}>
      <label>{t("quickAccess.path")}<input autoFocus required value={target} onChange={event => setTarget(event.target.value)} placeholder={t("quickAccess.pathPlaceholder")} disabled={controller.busy} spellCheck={false} /></label>
      <div className={styles.pickers}><button type="button" disabled={controller.busy} onClick={() => void pick("file")}>{t("quickAccess.chooseFile")}</button><button type="button" disabled={controller.busy} onClick={() => void pick("folder")}>{t("quickAccess.chooseFolder")}</button></div>
      <label>{t("quickAccess.name")}<input value={name} maxLength={120} required={Boolean(item)} onChange={event => setName(event.target.value)} placeholder={t("quickAccess.namePlaceholder")} disabled={controller.busy} /></label>
      {item?.preset === "hosts" ? <p className={styles.hint}>{t("quickAccess.hostsHint")}</p> : null}
      {controller.error ? <p className={styles.error} role="alert">{t(controller.error)}</p> : null}
      <div className={styles.dialogActions}><button type="button" disabled={controller.busy} onClick={onClose}>{t("quickAccess.cancel")}</button><button className={styles.save} type="submit" disabled={controller.busy || !target.trim()}>{t("quickAccess.save")}</button></div>
    </form>
  </dialog>;
}

function constrainEditorPosition(element: HTMLDialogElement, position: { left: number; top: number }) {
  const bounds = element.getBoundingClientRect();
  return {
    left: Math.max(16, Math.min(position.left, window.innerWidth - bounds.width - 16)),
    top: Math.max(16, Math.min(position.top, window.innerHeight - bounds.height - 16)),
  };
}

function ItemMenu({ item, anchor, controller, canMoveUp, canMoveDown, onMove, onEdit, onClose }: {
  item: QuickAccessEntry; anchor: RefObject<HTMLButtonElement | null>; controller: QuickAccessController;
  canMoveUp: boolean; canMoveDown: boolean; onMove: (direction: -1 | 1) => void; onEdit: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const menu = useRef<HTMLDivElement>(null);
  const position = useAnchoredMenuPosition(anchor, true);
  useFocusTrap(menu, Boolean(position), { onEscape: onClose });
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [anchor, onClose]);
  const action = (label: string, icon: AliIconName, run: () => unknown, disabled = false, danger = false) => <button type="button" role="menuitem" key={label} disabled={disabled || controller.busy} className={danger ? styles.remove : undefined} onClick={() => { onClose(); run(); }}><AliIcon name={icon} size={14} />{t(`quickAccess.${label}`)}</button>;
  if (!position) return null;
  return createPortal(<div ref={menu} className={styles.menu} role="menu" aria-label={t("quickAccess.menu", { name: quickAccessName(item, t) })} style={position} onKeyDown={event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    {action("open", "external-link", () => void controller.open(item), item.availability !== "available")}
    {item.preset === "hosts" ? action("admin", "edit", () => void controller.open(item, "edit-admin"), item.availability !== "available") : null}
    {action("reveal", "folder-open", () => void controller.open(item, "reveal"), item.availability !== "available")}
    {action("copy", "copy", () => void controller.open(item, "copy"))}
    {action("edit", "edit", onEdit)}
    {action(item.pinned ? "unpin" : "pin", "pushpin", () => void controller.mutate({ type: "update", id: item.id, pinned: !item.pinned }))}
    {action("moveUp", "arrowup", () => onMove(-1), !canMoveUp)}
    {action("moveDown", "arrowdown", () => onMove(1), !canMoveDown)}
    {action("remove", "clear", () => void controller.mutate({ type: "remove", id: item.id }), false, true)}
  </div>, document.body);
}

function AccessRow({ item, controller, dragOver, onDragOver, onDrop, onDrag, onEdit, onMove, canMoveUp, canMoveDown, sortable }: {
  item: QuickAccessEntry; controller: QuickAccessController; dragOver: boolean;
  onDragOver: () => void; onDrop: (id: string) => void; onDrag: (id: string | null) => void;
  onEdit: () => void; onMove: (direction: -1 | 1) => void; canMoveUp: boolean; canMoveDown: boolean; sortable: boolean;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const name = quickAccessName(item, t);
  return <li className={styles.row} data-drag-over={dragOver} onDragOver={event => { if (sortable && event.dataTransfer.types.includes("application/x-piora-quick-access")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; onDragOver(); } }} onDrop={event => {
    event.preventDefault(); if (sortable) onDrop(event.dataTransfer.getData("application/x-piora-quick-access"));
  }}>
    <span className={styles.grip} draggable={sortable && !controller.busy} title={t("quickAccess.drag")} aria-hidden="true" onDragStart={event => { event.dataTransfer.setData("application/x-piora-quick-access", item.id); event.dataTransfer.effectAllowed = "move"; onDrag(item.id); }} onDragEnd={() => onDrag(null)}><AliIcon name="menu" size={13} /></span>
    <button type="button" className={styles.rowMain} disabled={controller.busy} title={item.path} onClick={() => void controller.open(item)}>
      <AliIcon className={styles.icon} name={item.kind === "folder" ? "folder" : quickAccessIsShortcut(item) ? "external-link" : "file"} size={20} />
      <span className={styles.metadata}><span className={styles.name}><span>{name}</span>{item.pinned ? <AliIcon name="pushpin" size={11} aria-label={t("quickAccess.pinned")} /> : null}</span><span className={styles.path}>{item.path}</span>{item.availability !== "available" ? <span className={styles.warning}>{t(`quickAccess.${item.availability}`)}</span> : null}</span>
    </button>
    <button ref={anchor} type="button" className={styles.more} aria-label={t("quickAccess.menu", { name })} aria-haspopup="menu" aria-expanded={menuOpen} disabled={controller.busy} onClick={() => setMenuOpen(value => !value)}><AliIcon name="ellipsis" size={17} /></button>
    {menuOpen ? <ItemMenu item={item} anchor={anchor} controller={controller} canMoveUp={canMoveUp} canMoveDown={canMoveDown} onMove={onMove} onEdit={onEdit} onClose={() => setMenuOpen(false)} /> : null}
  </li>;
}

export function QuickAccess({ controller }: { controller: QuickAccessController }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | QuickAccessKind>("all");
  const [editor, setEditor] = useState<{ item: QuickAccessEntry | null } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const entries = controller.items.map(item => ({ item, score: quickAccessScore(item, query, quickAccessName(item, t)) })).filter(({ item, score }) => score >= 0 && (filter === "all" || item.kind === filter)).sort((a, b) => b.score - a.score).map(({ item }) => item);
  const sortable = !query.trim() && filter === "all" && !controller.busy;
  const move = (from: string, to: string) => {
    const items = [...controller.items];
    const origin = items.findIndex(item => item.id === from), destination = items.findIndex(item => item.id === to);
    if (origin < 0 || destination < 0 || origin === destination || items[origin].pinned !== items[destination].pinned) return;
    items.splice(destination, 0, ...items.splice(origin, 1));
    void controller.mutate({ type: "reorder", ids: items.map(item => item.id) });
  };
  const platform = typeof window === "undefined" ? undefined : window.piDesktop?.platform;
  const defaults = controller.presets.filter(preset => !controller.items.some(item => item.preset === preset.id || quickAccessPathKey(item.path, platform) === quickAccessPathKey(preset.path, platform)));
  return <div className={styles.root}>
    <div className={styles.heading}><div><h1>{t("quickAccess.title")}</h1><p>{t("quickAccess.description")}</p></div><button type="button" className={styles.add} disabled={!controller.supported || controller.loading || controller.busy} onClick={() => { controller.clearNotice(); setEditor({ item: null }); }}><AliIcon name="plus" size={15} />{t("quickAccess.add")}</button></div>
    <QuickAccessNotice controller={controller} />
    {!controller.supported && !controller.loading ? <div className={styles.empty}><AliIcon name="folder-open" size={30} /><p>{t("quickAccess.desktopOnly")}</p></div> : <>
      <div className={styles.toolbar}><input className={styles.search} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("quickAccess.search")} aria-label={t("quickAccess.search")} /><div className={styles.filters} role="group" aria-label={t("quickAccess.title")}>{(["all", "folder", "file"] as const).map(kind => <button key={kind} type="button" aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{t(`quickAccess.${kind}`)}</button>)}</div></div>
      {controller.loading ? <p role="status">{t("quickAccess.loading")}</p> : entries.length ? <ul className={styles.list} aria-label={t("quickAccess.title")}>{entries.map(item => {
        const index = controller.items.findIndex(entry => entry.id === item.id);
        const up = controller.items[index - 1], down = controller.items[index + 1];
        return <AccessRow key={item.id} item={item} controller={controller} sortable={sortable} dragOver={dragged !== null && dragOver === item.id} onDragOver={() => { if (controller.items.find(entry => entry.id === dragged)?.pinned === item.pinned) setDragOver(item.id); }} onDrop={id => { if (id === dragged) move(id, item.id); setDragged(null); setDragOver(null); }} onDrag={id => { setDragged(id); if (!id) setDragOver(null); }} onEdit={() => { controller.clearNotice(); setEditor({ item }); }} canMoveUp={Boolean(sortable && up?.pinned === item.pinned)} canMoveDown={Boolean(sortable && down?.pinned === item.pinned)} onMove={direction => { const adjacent = controller.items[index + direction]; if (adjacent) move(item.id, adjacent.id); }} />;
      })}</ul> : <div className={styles.empty}><AliIcon name="folder-open" size={30} /><b>{t(controller.items.length ? "quickAccess.noMatches" : "quickAccess.empty")}</b>{!controller.items.length ? <p>{t("quickAccess.emptyHint")}</p> : null}</div>}
      {defaults.length ? <div className={styles.defaults}><span>{t("quickAccess.defaults")}</span>{defaults.map(preset => <button type="button" key={preset.id} disabled={controller.busy} onClick={() => void controller.mutate({ type: "preset", preset: preset.id })}>＋ {t(`quickAccess.preset.${preset.id}`)}</button>)}</div> : null}
    </>}
    {editor ? <QuickAccessEditor item={editor.item} controller={controller} onClose={() => setEditor(null)} /> : null}
  </div>;
}
