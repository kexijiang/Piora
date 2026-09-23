"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import styles from "./TabBar.module.css";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: "source" | "preview" | "diff" | "edit";
  revealLine?: number;
  revealKey?: number;
  isDirty?: boolean;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  canReopenClosedTab: boolean;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseOtherTabs: (id: string) => void;
  onCloseTabsToRight: (id: string) => void;
  onMoveTab: (id: string, targetIndex: number) => void;
  onReopenClosedTab: () => void;
}

interface MenuState {
  tabId: string | null;
  x: number;
  y: number;
  returnFocusId: string | null;
}

export function TabBar({
  tabs,
  activeTabId,
  canReopenClosedTab,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onMoveTab,
  onReopenClosedTab,
}: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [scrollMetrics, setScrollMetrics] = useState({ viewport: 0, content: 0, left: 0 });

  const syncScrollMetrics = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const next = { viewport: list.clientWidth, content: list.scrollWidth, left: list.scrollLeft };
    setScrollMetrics((current) => current.viewport === next.viewport && current.content === next.content && current.left === next.left ? current : next);
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(syncScrollMetrics);
    const handleWheel = (event: WheelEvent) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? list.clientWidth : 1);
      const next = Math.max(0, Math.min(list.scrollWidth - list.clientWidth, list.scrollLeft + delta));
      if (Math.abs(next - list.scrollLeft) < 1) return;
      event.preventDefault();
      list.scrollLeft = next;
    };
    observer.observe(list);
    list.addEventListener("wheel", handleWheel, { passive: false });
    syncScrollMetrics();
    return () => { observer.disconnect(); list.removeEventListener("wheel", handleWheel); };
  }, [syncScrollMetrics]);

  useEffect(() => { syncScrollMetrics(); }, [tabs, syncScrollMetrics]);

  const maxTabScroll = Math.max(0, scrollMetrics.content - scrollMetrics.viewport);
  const tabsOverflow = maxTabScroll > 1;
  const canScrollLeft = scrollMetrics.left > 1;
  const canScrollRight = scrollMetrics.left < maxTabScroll - 1;

  const scrollTabs = (direction: -1 | 1) => {
    const list = listRef.current;
    if (!list) return;
    list.scrollBy({ left: direction * Math.max(120, list.clientWidth * 0.7), behavior: "smooth" });
  };

  useEffect(() => {
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !selected) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = selected.getBoundingClientRect();
    if (tabRect.left < listRect.left) list.scrollLeft -= listRect.left - tabRect.left;
    else if (tabRect.right > listRect.right) list.scrollLeft += tabRect.right - listRect.right;
    syncScrollMetrics();
  }, [activeTabId, tabs.length, syncScrollMetrics]);

  const focusTab = (id: string) => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-file-tab-id="${CSS.escape(id)}"]`)?.focus();
    });
  };

  const moveFocus = (currentId: string, direction: -1 | 1) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === currentId);
    if (currentIndex < 0 || tabs.length === 0) return;
    const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    onSelectTab(tabs[nextIndex].id);
    focusTab(tabs[nextIndex].id);
  };

  const openMenu = (tabId: string | null, x: number, y: number, returnFocusId: string | null) => {
    const width = 220;
    const estimatedHeight = Math.min(window.innerHeight - 16, 190 + tabs.length * 32);
    setMenu({
      tabId,
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - estimatedHeight - 8)),
      returnFocusId,
    });
  };

  const closeMenu = (restoreFocus = false) => {
    const returnFocusId = menu?.returnFocusId;
    setMenu(null);
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      if (returnFocusId) {
        const tab = document.querySelector<HTMLElement>(`[data-file-tab-id="${CSS.escape(returnFocusId)}"]`);
        if (tab) {
          tab.focus();
          return;
        }
      }
      moreButtonRef.current?.focus();
    });
  };

  useEffect(() => {
    if (!menu) return;
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)');
    firstItem?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const runMenuAction = (action: () => void) => {
    const returnFocusId = menu?.returnFocusId;
    setMenu(null);
    action();
    requestAnimationFrame(() => {
      if (returnFocusId) {
        const tab = document.querySelector<HTMLElement>(`[data-file-tab-id="${CSS.escape(returnFocusId)}"]`);
        if (tab) {
          tab.focus();
          return;
        }
      }
      moreButtonRef.current?.focus();
    });
  };

  const menuTabIndex = menu?.tabId ? tabs.findIndex((tab) => tab.id === menu.tabId) : -1;
  const menuTab = menuTabIndex >= 0 ? tabs[menuTabIndex] : null;

  return (
    <div className={`file-tab-root ${styles.root}`}>
      <div className={styles.scrollRegion} data-can-scroll-left={canScrollLeft || undefined} data-can-scroll-right={canScrollRight || undefined}>
      <div id="piora-file-tab-list" ref={listRef} className={`file-tab-list ${styles.list}`} role="tablist" aria-label={t("files.openFiles")} onScroll={syncScrollMetrics}>
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              className={`file-tab${isActive ? " is-active" : ""} ${styles.tab}`}
              data-dragging={draggedTabId === tab.id || undefined}
              data-drop-target={dropTargetId === tab.id || undefined}
              draggable
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              data-file-tab-id={tab.id}
              onClick={() => onSelectTab(tab.id)}
              onMouseEnter={() => setHoveredTab(tab.id)}
              onMouseLeave={() => setHoveredTab(null)}
              onContextMenu={(event: ReactMouseEvent) => {
                event.preventDefault();
                onSelectTab(tab.id);
                openMenu(tab.id, event.clientX, event.clientY, tab.id);
              }}
              onDragStart={(event) => {
                setDraggedTabId(tab.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/piora-file-tab", tab.id);
              }}
              onDragEnter={() => {
                if (draggedTabId && draggedTabId !== tab.id) setDropTargetId(tab.id);
              }}
              onDragOver={(event) => {
                if (!draggedTabId || draggedTabId === tab.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = draggedTabId ?? event.dataTransfer.getData("text/piora-file-tab");
                if (sourceId && sourceId !== tab.id) onMoveTab(sourceId, index);
                setDraggedTabId(null);
                setDropTargetId(null);
              }}
              onDragEnd={() => {
                setDraggedTabId(null);
                setDropTargetId(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  moveFocus(tab.id, -1);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  moveFocus(tab.id, 1);
                } else if (event.key === "Home" && tabs[0]) {
                  event.preventDefault();
                  onSelectTab(tabs[0].id);
                  focusTab(tabs[0].id);
                } else if (event.key === "End" && tabs[tabs.length - 1]) {
                  event.preventDefault();
                  onSelectTab(tabs[tabs.length - 1].id);
                  focusTab(tabs[tabs.length - 1].id);
                } else if (event.key === "Delete") {
                  event.preventDefault();
                  onCloseTab(tab.id);
                } else if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  openMenu(tab.id, rect.left + 12, rect.bottom, tab.id);
                }
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <span className={styles.icon} data-active={isActive || undefined}>{getFileIcon(tab.label, 13)}</span>
              <span className={styles.label} data-active={isActive || undefined} title={tab.filePath}>{tab.label}</span>
              {tab.isDirty && <span className={styles.dirty} title={t("files.unsavedChanges")} aria-label={t("files.unsavedChanges")} />}
              <button
                className={styles.closeButton}
                data-visible={isActive || hoveredTab === tab.id || hoveredClose === tab.id || undefined}
                onClick={(event) => { event.stopPropagation(); onCloseTab(tab.id); }}
                onMouseEnter={() => setHoveredClose(tab.id)}
                onMouseLeave={() => setHoveredClose(null)}
                title={t("i18n.close")}
                aria-label={`${t("i18n.close")} ${tab.label}`}
              >
                <AliIcon name="close" size={11} />
              </button>
            </div>
          );
        })}
      </div>
      </div>
      {tabsOverflow && <div className={styles.scrollButtons}>
        <button type="button" className={styles.scrollButton} disabled={!canScrollLeft} onClick={() => scrollTabs(-1)} aria-label={t("files.scrollTabsLeft")} title={t("files.scrollTabsLeft")}><span style={{ transform: "rotate(180deg)", display: "flex" }}><AliIcon name="chevron-right" size={13} /></span></button>
        <button type="button" className={styles.scrollButton} disabled={!canScrollRight} onClick={() => scrollTabs(1)} aria-label={t("files.scrollTabsRight")} title={t("files.scrollTabsRight")}><AliIcon name="chevron-right" size={13} /></button>
      </div>}
      <button
        ref={moreButtonRef}
        type="button"
        className={styles.moreButton}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        aria-label={t("files.tabActions")}
        title={t("files.tabActions")}
        disabled={tabs.length === 0 && !canReopenClosedTab}
        onClick={(event) => {
          if (menu) {
            closeMenu(true);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu(activeTabId || null, rect.right - 220, rect.bottom + 4, null);
        }}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {menu && createPortal(
        <div
          ref={menuRef}
          className={styles.menu}
          role="menu"
          aria-label={t("files.tabActions")}
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={onMenuKeyDown}
        >
          <div className={styles.menuHeading}>{t("files.openFiles")}</div>
          <div className={styles.openTabList}>{tabs.map((tab) => <button key={tab.id} type="button" role="menuitem" aria-current={tab.id === activeTabId ? "true" : undefined} title={tab.filePath} onClick={() => runMenuAction(() => onSelectTab(tab.id))}><span>{tab.label}</span>{tab.isDirty ? <small aria-label={t("files.unsavedChanges")}>●</small> : null}</button>)}</div>
          <div className={styles.separator} role="separator" />
          <button role="menuitem" disabled={!menuTab || menuTabIndex === 0} onClick={() => menuTab && runMenuAction(() => onMoveTab(menuTab.id, menuTabIndex - 1))}>{t("files.moveTabLeft")}</button>
          <button role="menuitem" disabled={!menuTab || menuTabIndex === tabs.length - 1} onClick={() => menuTab && runMenuAction(() => onMoveTab(menuTab.id, menuTabIndex + 1))}>{t("files.moveTabRight")}</button>
          <div className={styles.separator} role="separator" />
          <button role="menuitem" disabled={!menuTab} onClick={() => menuTab && runMenuAction(() => onCloseTab(menuTab.id))}>{t("files.closeTab")}</button>
          <button role="menuitem" disabled={!menuTab || tabs.length < 2} onClick={() => menuTab && runMenuAction(() => onCloseOtherTabs(menuTab.id))}>{t("files.closeOtherTabs")}</button>
          <button role="menuitem" disabled={!menuTab || menuTabIndex >= tabs.length - 1} onClick={() => menuTab && runMenuAction(() => onCloseTabsToRight(menuTab.id))}>{t("files.closeTabsToRight")}</button>
          <div className={styles.separator} role="separator" />
          <button role="menuitem" disabled={!canReopenClosedTab} onClick={() => runMenuAction(onReopenClosedTab)}>{t("files.reopenClosedTab")}</button>
        </div>,
        document.body,
      )}
    </div>
  );
}
