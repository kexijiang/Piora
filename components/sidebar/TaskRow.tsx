"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { confirmSessionDeletion } from "../confirm-session-deletion";
import { requestSessionDeletion } from "@/lib/session-delete-client";
import { useI18n } from "@/hooks/useI18n";
import { useTaskStatus } from "@/hooks/useTaskStatus";
import {
  STATUS_PRESENTATION,
  getTaskStatusPresentationKey,
  type TaskStatus,
} from "@/lib/task-status";
import { readSessionTitleModel, readSessionTitlePrompt } from "@/lib/session-title-settings";
import type { SessionInfo } from "@/lib/types";
import { AliIcon } from "../AliIcon";
import { cancelSessionPrefetch, prefetchSession } from "@/lib/session-prefetch";
import { TaskContextMenu, type SessionMoveTarget } from "./TaskContextMenu";
import styles from "./TaskRow.module.css";

export function TaskStatusIndicator({ status }: { status: TaskStatus }) {
  const { t } = useI18n();
  const presentationKey = getTaskStatusPresentationKey(status);
  if (presentationKey === "none") return null;
  const presentation = STATUS_PRESENTATION[presentationKey];
  const label = t(presentation.i18nKey);
  const color = `var(${presentation.colorVar})`;
  const spinning = presentationKey === "running";

  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color,
      }}
    >
      {spinning ? (
        <span className="sidebar-running-spinner" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
          <circle cx="7" cy="7" r={presentationKey === "unread" ? 2.5 : 3} fill="currentColor" />
          {presentationKey === "unread" ? (
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.25" opacity="0.38" />
          ) : null}
        </svg>
      )}
    </span>
  );
}

export function RunningSessionIndicator() {
  return <TaskStatusIndicator status={{ lifecycle: "active", runtime: "running", attention: "none" }} />;
}

export function UnreadSessionIndicator() {
  return <TaskStatusIndicator status={{ lifecycle: "active", runtime: "idle", attention: "unread" }} />;
}

export const TaskRow = memo(function TaskRow({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  pinned = false,
  archived = false,
  onTogglePinned,
  onToggleArchived,
  onDuplicate,
  moveTargets,
  onMarkUnread,
  onMoveSession,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (session: SessionInfo, sessionIds?: string[]) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  pinned?: boolean;
  archived?: boolean;
  onTogglePinned?: () => void;
  onToggleArchived?: () => void;
  onDuplicate?: () => void;
  moveTargets: SessionMoveTarget[];
  onMarkUnread: () => void;
  onMoveSession: (target: SessionMoveTarget) => Promise<void>;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renamePending = useRef(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [optimizingTitle, setOptimizingTitle] = useState(false);
  const [titleOptimizationError, setTitleOptimizationError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleViewportRef = useRef<HTMLSpanElement>(null);
  const titleTextRef = useRef<HTMLSpanElement>(null);
  const titleOptimizationAbortRef = useRef<AbortController | null>(null);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskStatus = useTaskStatus({
    sessionId: session.id,
    isViewing: isSelected,
    hasUnreadResult: Boolean(isUnread),
    fallbackRuntime: isRunning ? "running" : "idle",
  });
  const taskStatusPresentationKey = getTaskStatusPresentationKey(taskStatus);
  const title = session.name || session.firstMessage || t("sidebar.newConversation");

  useEffect(() => {
    const viewport = titleViewportRef.current;
    const text = titleTextRef.current;
    if (!isSelected || renaming || !viewport || !text) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    let lastMeasurement = "";
    const update = () => {
      const distance = Math.max(0, Math.ceil(text.scrollWidth - viewport.getBoundingClientRect().width));
      const measurement = `${distance}:${reducedMotion.matches}`;
      if (measurement === lastMeasurement) return;
      lastMeasurement = measurement;
      animation?.cancel();
      delete viewport.dataset.scrolling;
      if (distance <= 1 || reducedMotion.matches) return;
      viewport.dataset.scrolling = "true";
      const travel = Math.max(1_000, distance / 24 * 1_000);
      const duration = 1_500 + travel + 2_000;
      animation = text.animate([
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: 1_500 / duration },
        { transform: `translateX(-${distance}px)`, offset: (1_500 + travel) / duration },
        { transform: `translateX(-${distance}px)`, offset: 1 },
      ], { duration, iterations: Infinity, easing: "linear" });
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(text);
    reducedMotion.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      reducedMotion.removeEventListener("change", update);
      animation?.cancel();
      delete viewport.dataset.scrolling;
    };
  }, [isSelected, renaming, title]);

  useEffect(() => () => {
    titleOptimizationAbortRef.current?.abort();
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    cancelSessionPrefetch(session.id);
  }, [session.id]);

  const startRename = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRenameValue(title);
    setRenameError(null);
    setTitleOptimizationError(null);
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [title]);

  const commitRename = useCallback(async () => {
    if (optimizingTitle || renamePending.current) return;
    const name = renameValue.trim();
    if (name === title) { setRenaming(false); return; }
    renamePending.current = true;
    setRenameError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      setRenaming(false);
      onRenamed?.();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
      setRenaming(true);
    } finally {
      renamePending.current = false;
    }
  }, [onRenamed, optimizingTitle, renameValue, session.id, title]);

  const optimizeTitle = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (optimizingTitle) return;
    const controller = new AbortController();
    titleOptimizationAbortRef.current?.abort();
    titleOptimizationAbortRef.current = controller;
    setOptimizingTitle(true);
    setTitleOptimizationError(null);
    try {
      const titleModel = readSessionTitleModel(window.localStorage);
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/auto-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          apply: false,
          currentTitle: renameValue.trim() || title,
          instructions: readSessionTitlePrompt(window.localStorage),
          ...(titleModel ?? {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title?.trim()) throw new Error(body.error || `HTTP ${response.status}`);
      setRenameValue(body.title.trim());
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (reason) {
      if (controller.signal.aborted) return;
      setTitleOptimizationError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (titleOptimizationAbortRef.current === controller) {
        titleOptimizationAbortRef.current = null;
        setOptimizingTitle(false);
      }
    }
  }, [optimizingTitle, renameValue, session.id, title]);

  const cancelTitleOptimization = useCallback((event?: React.SyntheticEvent) => {
    event?.stopPropagation();
    titleOptimizationAbortRef.current?.abort();
    titleOptimizationAbortRef.current = null;
    setOptimizingTitle(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const performDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const expectedIds = await confirmSessionDeletion(session.id, title, t);
      if (!expectedIds) return;
      const result = await requestSessionDeletion(session.id, expectedIds);
      onDeleted?.(session, result.sessionIds);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }, [deleting, onDeleted, session, t, title]);

  const handleDeleteClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const itemHeight = "max(31px, calc(var(--text-sm) + 16px))";
  const mutationError = renameError || deleteError;
  const rowBackground = isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent";

  return (
    <div
      className={`sidebar-session-row${isSelected ? " is-selected" : ""}`}
      onClick={deleting || renaming ? undefined : onClick}
      onMouseEnter={() => {
        setHovered(true);
        if (!isSelected && !isRunning) {
          if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
          prefetchTimerRef.current = setTimeout(() => {
            prefetchTimerRef.current = null;
            prefetchSession(session);
          }, 200);
        }
      }}
      onPointerDown={() => {
        if (prefetchTimerRef.current) {
          clearTimeout(prefetchTimerRef.current);
          prefetchTimerRef.current = null;
        }
        if (!isSelected && !isRunning) prefetchSession(session, { keepOnMouseLeave: true });
      }}
      onMouseLeave={() => {
        setHovered(false);
        if (prefetchTimerRef.current) {
          clearTimeout(prefetchTimerRef.current);
          prefetchTimerRef.current = null;
        }
        cancelSessionPrefetch(session.id);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuAnchor({ x: event.clientX, y: event.clientY });
      }}
      style={{
        position: "relative",
        height: mutationError ? "auto" : itemHeight,
        minHeight: itemHeight,
        flexWrap: mutationError ? "wrap" : "nowrap",
        width: "calc(100% - 12px)",
        margin: "2px 6px",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 8 : 8,
        paddingRight: 5,
        cursor: deleting || renaming ? "default" : "pointer",
        background: rowBackground,
        border: "1px solid transparent",
        borderRadius: "var(--radius-control)",
        transition: "background 0.1s, border-color 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {mutationError && <span role="alert" className={styles.mutationError}>{renameError || t("trash.failed", { error: deleteError! })}</span>}
      {renaming ? (
        <div
          className={`${styles.renameEditor}${titleOptimizationError ? ` ${styles.renameEditorError}` : ""}`}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void commitRename();
          }}
        >
          <input
            className={styles.renameInput}
            ref={inputRef}
            value={renameValue}
            onChange={(event) => {
              setRenameValue(event.target.value);
              setRenameError(null);
              setTitleOptimizationError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void commitRename();
              if (event.key === "Escape") {
                cancelTitleOptimization();
                setRenameError(null);
                setRenaming(false);
              }
            }}
            autoFocus
            aria-invalid={Boolean(titleOptimizationError || renameError)}
          />
          <button
            className={`${styles.renameAiButton}${optimizingTitle ? ` ${styles.renameAiButtonLoading}` : ""}${titleOptimizationError ? ` ${styles.renameAiButtonError}` : ""}`}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => { if (optimizingTitle) cancelTitleOptimization(event); else void optimizeTitle(event); }}
            title={optimizingTitle ? t("sidebar.cancelTitleOptimization") : titleOptimizationError ? t("sidebar.optimizeTitleFailed", { error: titleOptimizationError }) : t("sidebar.optimizeTitle")}
            aria-label={optimizingTitle ? t("sidebar.cancelTitleOptimization") : t("sidebar.optimizeTitle")}
          >
            <AliIcon className={styles.renameAiIcon} name={optimizingTitle ? "close" : "sparkles"} size={15} strokeWidth={1.75} />
          </button>
          <span className={styles.srOnly} aria-live="polite">
            {titleOptimizationError ? t("sidebar.optimizeTitleFailed", { error: titleOptimizationError }) : optimizingTitle ? t("sidebar.optimizingTitle") : ""}
          </span>
        </div>
      ) : (
        <>
          {depth > 0 ? <AliIcon name="fork" size={10} style={{ color: "var(--text-dim)" }} /> : null}
          <div style={{ flex: 1, minWidth: 0, paddingRight: hovered ? 64 : 0 }}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, fontSize: "var(--text-sm)", fontWeight: isSelected ? 500 : 400, lineHeight: 1.4, color: "var(--text)" }}
              title={title}
            >
              <span ref={titleViewportRef} className={styles.titleViewport}>
                <span ref={titleTextRef} className={styles.titleText}>{title}</span>
              </span>
            </div>
          </div>

          {pinned ? (
            <span title={t("sidebar.pinned")} aria-label={t("sidebar.pinned")} style={{ color: "var(--accent)", display: "inline-flex", flexShrink: 0 }}>
              <AliIcon name="pushpin" size={11} />
            </span>
          ) : null}

          {taskStatusPresentationKey !== "none" ? (
            <TaskStatusIndicator status={taskStatus} />
          ) : null}
          {taskStatusPresentationKey === "none" && session.worktreeBranch ? (
            <span title={`Worktree: ${session.worktreeBranch}`} style={{ color: "var(--text-dim)", display: "inline-flex" }}>
              <AliIcon name="branches" size={11} />
            </span>
          ) : null}

          {hasChildren ? (
            <button
              onClick={(event) => { event.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? t("sidebar.expandForks") : t("sidebar.collapseForks")}
              aria-label={collapsed ? t("sidebar.expandForks") : t("sidebar.collapseForks")}
              aria-expanded={!collapsed}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0, background: "none",
                border: "none", color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s",
              }}
            >
              <AliIcon name="arrowdown" size={10} />
            </button>
          ) : null}

          {/* Keep hover actions clear of the branch toggle without reflowing the row. */}
          <div
            aria-hidden={!hovered}
            style={{
              position: "absolute", right: hasChildren ? 30 : 4, top: 0, height: itemHeight, zIndex: 2,
              display: "flex", alignItems: "center", gap: 4, paddingLeft: 14,
              opacity: hovered ? 1 : 0, visibility: hovered ? "visible" : "hidden",
              pointerEvents: hovered ? "auto" : "none",
              background: `linear-gradient(to right, transparent, ${isSelected ? "var(--bg-selected)" : "var(--bg-hover)"} 38%)`,
            }}
          >
            <RowActionButton label={t("sidebar.rename")} icon="edit" onClick={startRename} />
            <RowActionButton
              label={t("sidebar.delete")}
              icon="delete"
              danger
              onClick={handleDeleteClick}
            />
          </div>
        </>
      )}
      {menuAnchor && (
        <TaskContextMenu
          anchor={menuAnchor}
          session={session}
          pinned={pinned}
          archived={archived}
          unread={Boolean(isUnread)}
          running={Boolean(isRunning)}
          moveTargets={moveTargets}
          onPin={() => onTogglePinned?.()}
          onMarkUnread={onMarkUnread}
          onMove={onMoveSession}
          onRename={() => {
            setRenameValue(title);
            setTitleOptimizationError(null);
            setRenaming(true);
            setTimeout(() => inputRef.current?.select(), 0);
          }}
          onArchive={() => onToggleArchived?.()}
          onDuplicate={() => onDuplicate?.()}
          onDelete={() => void performDelete()}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </div>
  );
});

function RowActionButton({
  label,
  icon,
  danger = false,
  active = false,
  onClick,
}: {
  label: string;
  icon: "pushpin" | "edit" | "delete";
  danger?: boolean;
  active?: boolean;
  onClick: (event: React.MouseEvent) => void;
}) {
  const normalColor = active ? "var(--accent)" : "var(--text-muted)";
  const hoverColor = danger ? "var(--status-failed)" : "var(--accent)";
  const hoverBackground = danger
    ? "color-mix(in srgb, var(--status-failed) 8%, transparent)"
    : "var(--bg-selected)";
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 23, height: 23, padding: 0, background: "var(--bg-hover)",
        border: "none", borderRadius: "var(--radius-control)", color: normalColor, cursor: "pointer",
        flexShrink: 0, transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = hoverBackground;
        event.currentTarget.style.color = hoverColor;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "var(--bg-hover)";
        event.currentTarget.style.color = normalColor;
      }}
    >
      <AliIcon name={icon} size={14} />
    </button>
  );
}
