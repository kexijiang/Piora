"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionFlags } from "@/lib/session-flags";
import type { SessionInfo } from "@/lib/types";
import type { SessionTreeNode } from "@/lib/session-project-groups";
import { flattenTaskWindow, indexTaskTree, taskAncestorIds, type FlatTask } from "@/lib/sidebar-tree-window";
import { VirtualList, type VirtualListHandle } from "../VirtualList";
import styles from "../SessionSidebar.module.css";
import { TaskRow } from "./TaskRow";
import type { SessionMoveTarget } from "./TaskContextMenu";

interface CommonProps {
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  moveTargets: SessionMoveTarget[];
  flags: SessionFlags;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (session: SessionInfo, sessionIds?: string[]) => void;
  onFlagChange?: (session: SessionInfo, patch: { pinned?: boolean; archived?: boolean }) => void;
  onDuplicate?: (session: SessionInfo) => void;
  onMarkUnread: (session: SessionInfo) => void;
  onMoveSession: (session: SessionInfo, target: SessionMoveTarget) => Promise<void>;
  sessionOrder: readonly string[];
}

const SESSION_DRAG_HOLD_MS = 250;
const SESSION_DRAG_CANCEL_DISTANCE = 7;

interface SessionDragState {
  sourceId: string;
  sourceScope: string;
  targetId: string | null;
  position: "before" | "after";
}

export function TaskList({ nodes, scope, onReorderSessions, onSelectSession: selectSession, ...props }: CommonProps & {
  nodes: SessionTreeNode[];
  scope: string;
  onReorderSessions: (sourceId: string, targetId: string, position: "before" | "after") => void;
}) {
  const { t } = useI18n();
  const storageKey = "piora:expanded-branches:v1:" + scope;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const index = useMemo(() => indexTaskTree(nodes, props.flags, props.sessionOrder), [nodes, props.flags, props.sessionOrder]);
  const ancestors = useMemo(() => taskAncestorIds(index.parents, props.selectedSessionId), [index, props.selectedSessionId]);
  const ancestorKey = JSON.stringify(ancestors);
  const listRef = useRef<VirtualListHandle>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      setExpanded(new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []));
    } catch { setExpanded(new Set()); }
  }, [storageKey]);
  useEffect(() => {
    const parents = JSON.parse(ancestorKey) as string[];
    setExpanded((current) => parents.some((id) => !current.has(id)) ? new Set([...current, ...parents]) : current);
  }, [ancestorKey, props.selectedSessionId, storageKey]);
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* Optional preference. */ }
      return next;
    });
  }, [storageKey]);
  const rows = useMemo(() => flattenTaskWindow(index, expanded), [index, expanded]);
  const keys = useMemo(() => rows.map((row) => row.session.id), [rows]);
  const lastRevealed = useRef<string | null>(null);
  const onSelectSession = useCallback((session: SessionInfo) => {
    // Direct selection already targets a visible row. Keep its position instead
    // of re-centering it when the selected-session effect runs.
    lastRevealed.current = session.id;
    listRef.current?.cancelNavigation();
    selectSession(session);
  }, [selectSession]);
  useEffect(() => {
    const selected = props.selectedSessionId;
    if (selected && selected !== lastRevealed.current && keys.includes(selected)) {
      listRef.current?.scrollToKey(selected);
      lastRevealed.current = selected;
    } else if (!selected) lastRevealed.current = null;
  }, [keys, props.selectedSessionId]);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidateRef = useRef<{ pointerId: number; session: SessionInfo; scope: string; x: number; y: number; scroll: HTMLElement | null; element: HTMLElement } | null>(null);
  const dragRef = useRef<SessionDragState | null>(null);
  const suppressClickRef = useRef<{ sessionId: string; until: number } | null>(null);
  const previousBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const [dragState, setDragState] = useState<SessionDragState | null>(null);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }, []);

  const stopDragging = useCallback(() => {
    clearHoldTimer();
    const candidate = candidateRef.current;
    if (candidate?.element.hasPointerCapture(candidate.pointerId)) {
      candidate.element.releasePointerCapture(candidate.pointerId);
    }
    candidateRef.current = null;
    dragRef.current = null;
    setDragState(null);
    if (previousBodyStyleRef.current) {
      document.body.style.cursor = previousBodyStyleRef.current.cursor;
      document.body.style.userSelect = previousBodyStyleRef.current.userSelect;
      previousBodyStyleRef.current = null;
    }
  }, [clearHoldTimer]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const candidate = candidateRef.current;
    if (!candidate || event.pointerId !== candidate.pointerId) return;
    event.stopPropagation();
    const activeDrag = dragRef.current;
    if (!activeDrag) {
      if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > SESSION_DRAG_CANCEL_DISTANCE) {
        stopDragging();
      }
      return;
    }

    event.preventDefault();
    const scroll = candidate.scroll;
    if (scroll) {
      const bounds = scroll.getBoundingClientRect();
      if (event.clientY < bounds.top + 32) scroll.scrollTop -= 12;
      else if (event.clientY > bounds.bottom - 32) scroll.scrollTop += 12;
    }

    const element = document.elementFromPoint(event.clientX, event.clientY);
    const target = element?.closest<HTMLElement>("[data-session-drag-id]");
    const targetId = target?.dataset.sessionDragId ?? null;
    const targetScope = target?.dataset.sessionDragScope ?? null;
    if (!target || !targetId || targetId === activeDrag.sourceId || targetScope !== activeDrag.sourceScope) {
      if (activeDrag.targetId !== null) {
        const next = { ...activeDrag, targetId: null };
        dragRef.current = next;
        setDragState(next);
      }
      return;
    }
    const row = target.querySelector<HTMLElement>(":scope > [data-session-drag-row]");
    const rect = (row ?? target).getBoundingClientRect();
    const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (activeDrag.targetId !== targetId || activeDrag.position !== position) {
      const next: SessionDragState = { ...activeDrag, targetId, position };
      dragRef.current = next;
      setDragState(next);
    }
  }, [stopDragging]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const candidate = candidateRef.current;
    if (!candidate || event.pointerId !== candidate.pointerId) return;
    event.stopPropagation();
    const activeDrag = dragRef.current;
    if (activeDrag) {
      suppressClickRef.current = { sessionId: activeDrag.sourceId, until: Date.now() + 500 };
      if (activeDrag.targetId) {
        onReorderSessions(activeDrag.sourceId, activeDrag.targetId, activeDrag.position);
      }
    } else if (event.type === "pointerup") {
      // Pointer capture keeps long-press dragging reliable, but it retargets the
      // browser's synthesized click to this outer wrapper. Select explicitly on
      // a short release, then consume only that one retargeted click below.
      suppressClickRef.current = { sessionId: candidate.session.id, until: Date.now() + 500 };
      onSelectSession(candidate.session);
    }
    stopDragging();
  }, [onReorderSessions, onSelectSession, stopDragging]);

  useEffect(() => stopDragging, [stopDragging]);

  const beginSessionDrag = useCallback((session: SessionInfo, sourceScope: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    if ((event.target as Element).closest("button, input, textarea, select, a, [role='menu'], [data-session-drag-ignore]")) return;
    event.stopPropagation();
    clearHoldTimer();
    event.currentTarget.setPointerCapture(event.pointerId);
    candidateRef.current = {
      pointerId: event.pointerId,
      session,
      scope: sourceScope,
      x: event.clientX,
      y: event.clientY,
      scroll: event.currentTarget.closest<HTMLElement>("[data-session-drag-scroll]"),
      element: event.currentTarget,
    };
    holdTimerRef.current = setTimeout(() => {
      const candidate = candidateRef.current;
      if (!candidate || !candidate.element.isConnected || candidate.pointerId !== event.pointerId || candidate.session.id !== session.id) return;
      const next: SessionDragState = { sourceId: session.id, sourceScope, targetId: null, position: "after" };
      dragRef.current = next;
      setDragState(next);
      previousBodyStyleRef.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
    }, SESSION_DRAG_HOLD_MS);
  }, [clearHoldTimer]);

  const suppressSessionClick = useCallback((sessionId: string, event: ReactMouseEvent<HTMLElement>) => {
    const suppressed = suppressClickRef.current;
    if (!suppressed || suppressed.sessionId !== sessionId || Date.now() > suppressed.until) return;
    suppressClickRef.current = null;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const navigateRow = (row: FlatTask, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const position = keys.indexOf(row.session.id);
    let target: string | undefined;
    if (event.key === "ArrowDown") target = keys[Math.min(keys.length - 1, position + 1)];
    else if (event.key === "ArrowUp") target = keys[Math.max(0, position - 1)];
    else if (event.key === "Home") target = keys[0];
    else if (event.key === "End") target = keys.at(-1);
    else if (event.key === "ArrowRight" && row.hasChildren && row.collapsed) toggleExpanded(row.session.id);
    else if (event.key === "ArrowLeft") {
      if (row.hasChildren && !row.collapsed) toggleExpanded(row.session.id);
      else target = row.parentId ?? undefined;
    } else if (event.key === "Enter" || event.key === " ") onSelectSession(row.session);
    else return;
    event.preventDefault();
    if (target) {
      listRef.current?.scrollToKey(target);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-session-drag-id="${CSS.escape(target!)}"]`)?.focus({ preventScroll: true }));
    }
  };
  return <div role="tree" aria-label={t("sidebar.chats")}><VirtualList keys={keys} estimate={35} handleRef={listRef} pinnedKeys={dragState ? [dragState.sourceId] : []} renderItem={(_key, index) => {
    const row = rows[index];
    return <SessionTreeItem row={row} scope={scope + ":" + (row.parentId ?? "root") + ":" + (props.flags[row.session.id]?.pinned ? "pinned" : "regular")}
      dragState={dragState} onToggleCollapse={toggleExpanded} onKeyDown={(event) => navigateRow(row, event)}
      onPointerDown={beginSessionDrag} onPointerMove={handlePointerMove} onPointerEnd={finishPointer}
      onClickCapture={suppressSessionClick} onSelectSession={onSelectSession} {...props} />;
  }} /></div>;
}

export function SessionTreeItem({ row, scope, dragState, onPointerDown, onPointerMove, onPointerEnd, onClickCapture, onToggleCollapse, onKeyDown, ...props }: CommonProps & {
  row: FlatTask;
  onToggleCollapse: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  scope: string;
  dragState: SessionDragState | null;
  onPointerDown: (session: SessionInfo, scope: string, event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClickCapture: (sessionId: string, event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { session, depth, collapsed, hasChildren } = row;
  const flag = props.flags[session.id] ?? {};
  const { onSelectSession: selectSession, onFlagChange: changeFlag, onDuplicate: duplicateSession } = props;
  const handleSelectSession = useCallback(() => selectSession(session), [session, selectSession]);
  const handleToggleCollapse = useCallback(() => onToggleCollapse(session.id), [onToggleCollapse, session.id]);
  const handleTogglePinned = useCallback(
    () => changeFlag?.(session, { pinned: !flag.pinned }),
    [changeFlag, flag.pinned, session],
  );
  const handleToggleArchived = useCallback(
    () => changeFlag?.(session, { archived: true }),
    [changeFlag, session],
  );
  const handleDuplicate = useCallback(() => duplicateSession?.(session), [duplicateSession, session]);

  return (
    <div
      className={`${styles.sessionDragItem}${dragState?.sourceId === session.id ? ` ${styles.sessionDragging}` : ""}${dragState?.targetId === session.id && dragState.position === "before" ? ` ${styles.sessionDropBefore}` : ""}${dragState?.targetId === session.id && dragState.position === "after" ? ` ${styles.sessionDropAfter}` : ""}`}
      data-session-drag-id={session.id}
      role="treeitem"
      tabIndex={0}
      aria-label={session.name || session.firstMessage || session.id}
      aria-level={depth + 1}
      aria-selected={session.id === props.selectedSessionId}
      aria-expanded={hasChildren ? !collapsed : undefined}
      onKeyDown={onKeyDown}
      data-session-drag-scope={scope}
      onPointerDown={(event) => onPointerDown(session, scope, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={(event) => onClickCapture(session.id, event)}
    >
      <div data-session-drag-row style={{ position: "relative" }}>
        {depth > 0 && <div aria-hidden="true" style={{ position: "absolute", left: Math.min(depth, 6) * 12 + 6, top: 0, bottom: 0, width: 1, background: "var(--border)", pointerEvents: "none" }} />}
        <TaskRow
          session={session}
          isSelected={session.id === props.selectedSessionId}
          isRunning={props.runningSessionIds.has(session.id)}
          isUnread={props.unreadSessionIds.has(session.id)}
          moveTargets={props.moveTargets.filter((target) => target.projectRoot !== session.projectRoot)}
          onClick={handleSelectSession}
          onRenamed={props.onRenamed}
          onDeleted={props.onSessionDeleted}
          depth={Math.min(depth, 6)}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={handleToggleCollapse}
          pinned={Boolean(flag.pinned)}
          archived={false}
          onTogglePinned={handleTogglePinned}
          onToggleArchived={handleToggleArchived}
          onDuplicate={handleDuplicate}
          onMarkUnread={() => props.onMarkUnread(session)}
          onMoveSession={(target) => props.onMoveSession(session, target)}
        />
      </div>

    </div>
  );
}
