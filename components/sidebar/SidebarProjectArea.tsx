"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getProjectLabel, type SessionProjectGroup } from "@/lib/session-project-groups";
import type { SessionFlags } from "@/lib/session-flags";
import type { SessionInfo } from "@/lib/types";
import { AliIcon } from "../AliIcon";
import styles from "../SessionSidebar.module.css";
import { ProjectSessionGroup } from "./ProjectList";
import type { SessionMoveTarget } from "./TaskContextMenu";

interface Props {
  loading: boolean; error: string | null;
  handleDefaultCwd: () => Promise<void>; handleCustomPathClick: () => void;
  projectGroups: SessionProjectGroup[];
  selectedProject: string | null; collapsedProjectKeys: Set<string>; expandedProjectSessionKeys: Set<string>;
  setCollapsedProjectKeys: Dispatch<SetStateAction<Set<string>>>;
  setExpandedProjectSessionKeys: Dispatch<SetStateAction<Set<string>>>;
  selectedSessionId: string | null; runningSessionIds: Set<string>; unreadSessionIds: Set<string>; attentionSessionIds: Set<string>;
  moveTargets: SessionMoveTarget[];
  setSelectedCwd: Dispatch<SetStateAction<string | null>>; homeDir: string;
  handleSelectSessionFromList: (session: SessionInfo) => void; handleNewSessionInProject: (cwd: string) => void;
  loadSessions: (showLoading?: boolean) => Promise<void>; handleSessionDeletedWithUndo: (session: SessionInfo) => void;
  sessionFlags: SessionFlags;
  patchSessionFlag: (session: SessionInfo, patch: { pinned?: boolean; archived?: boolean }) => Promise<void>;
  duplicateSession: (session: SessionInfo) => Promise<void>; pinnedProjectRoots: Set<string>; projectAliases: Record<string, string>;
  markSessionUnread: (session: SessionInfo) => void;
  moveSession: (session: SessionInfo, target: SessionMoveTarget) => Promise<void>;
  togglePinnedProject: (root: string) => void; renameProject: (root: string, alias: string) => void; removeProject: (root: string) => void;
  onReorderProjects: (sourceRoot: string, targetRoot: string, position: "before" | "after") => void;
  sessionOrder: readonly string[];
  onReorderSessions: (sourceId: string, targetId: string, position: "before" | "after") => void;
}

const PROJECT_DRAG_HOLD_MS = 250;
const PROJECT_DRAG_CANCEL_DISTANCE = 7;

interface ProjectDragState {
  sourceRoot: string;
  targetRoot: string | null;
  position: "before" | "after";
}

export function SidebarProjectArea(props: Props) {
  const { t } = useI18n();
  const { loading, error, handleDefaultCwd, handleCustomPathClick, projectGroups, selectedProject, collapsedProjectKeys, expandedProjectSessionKeys, setCollapsedProjectKeys, setExpandedProjectSessionKeys, selectedSessionId, runningSessionIds, unreadSessionIds, attentionSessionIds, moveTargets, setSelectedCwd, homeDir, handleSelectSessionFromList, handleNewSessionInProject, loadSessions, handleSessionDeletedWithUndo, sessionFlags, patchSessionFlag, duplicateSession, markSessionUnread, moveSession, pinnedProjectRoots, projectAliases, togglePinnedProject, renameProject, removeProject, onReorderProjects, sessionOrder, onReorderSessions } = props;
  const allProjectsCollapsed = projectGroups.length > 0
    && projectGroups.every((group) => collapsedProjectKeys.has(group.key));
  const projectScrollRef = useRef<HTMLDivElement>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidateRef = useRef<{ pointerId: number; root: string; x: number; y: number } | null>(null);
  const dragRef = useRef<ProjectDragState | null>(null);
  const suppressClickRef = useRef<{ root: string; until: number } | null>(null);
  const [dragState, setDragState] = useState<ProjectDragState | null>(null);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }, []);

  const stopDragging = useCallback(() => {
    clearHoldTimer();
    candidateRef.current = null;
    dragRef.current = null;
    setDragState(null);
  }, [clearHoldTimer]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const candidate = candidateRef.current;
      if (!candidate || event.pointerId !== candidate.pointerId) return;
      const activeDrag = dragRef.current;
      if (!activeDrag) {
        if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > PROJECT_DRAG_CANCEL_DISTANCE) {
          clearHoldTimer();
          candidateRef.current = null;
        }
        return;
      }

      event.preventDefault();
      const scroll = projectScrollRef.current;
      if (scroll) {
        const bounds = scroll.getBoundingClientRect();
        if (event.clientY < bounds.top + 32) scroll.scrollTop -= 12;
        else if (event.clientY > bounds.bottom - 32) scroll.scrollTop += 12;
      }

      const element = document.elementFromPoint(event.clientX, event.clientY);
      const target = element?.closest<HTMLElement>("[data-project-drag-root]");
      const targetRoot = target?.dataset.projectDragRoot ?? null;
      if (!target || !targetRoot || targetRoot === activeDrag.sourceRoot) {
        if (activeDrag.targetRoot !== null) {
          const next = { ...activeDrag, targetRoot: null };
          dragRef.current = next;
          setDragState(next);
        }
        return;
      }
      const row = target.querySelector<HTMLElement>("[data-project-drag-handle]");
      const rect = (row ?? target).getBoundingClientRect();
      const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      if (activeDrag.targetRoot !== targetRoot || activeDrag.position !== position) {
        const next: ProjectDragState = { ...activeDrag, targetRoot, position };
        dragRef.current = next;
        setDragState(next);
      }
    };
    const finishPointer = (event: PointerEvent) => {
      const candidate = candidateRef.current;
      if (!candidate || event.pointerId !== candidate.pointerId) return;
      const activeDrag = dragRef.current;
      if (activeDrag) {
        suppressClickRef.current = { root: activeDrag.sourceRoot, until: Date.now() + 500 };
        if (activeDrag.targetRoot) {
          onReorderProjects(activeDrag.sourceRoot, activeDrag.targetRoot, activeDrag.position);
        }
      }
      stopDragging();
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", finishPointer);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", finishPointer);
    };
  }, [clearHoldTimer, onReorderProjects, stopDragging]);

  useEffect(() => stopDragging, [stopDragging]);

  const beginProjectDrag = useCallback((root: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    if ((event.target as Element).closest("[data-project-drag-ignore]")) return;
    clearHoldTimer();
    candidateRef.current = { pointerId: event.pointerId, root, x: event.clientX, y: event.clientY };
    holdTimerRef.current = setTimeout(() => {
      const candidate = candidateRef.current;
      if (!candidate || candidate.pointerId !== event.pointerId || candidate.root !== root) return;
      const next: ProjectDragState = { sourceRoot: root, targetRoot: null, position: "after" };
      dragRef.current = next;
      setDragState(next);
      window.getSelection()?.removeAllRanges();
    }, PROJECT_DRAG_HOLD_MS);
  }, [clearHoldTimer]);

  const suppressProjectClick = useCallback((root: string, event: ReactMouseEvent<HTMLElement>) => {
    const suppressed = suppressClickRef.current;
    if (!suppressed || suppressed.root !== root || Date.now() > suppressed.until) return;
    suppressClickRef.current = null;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <section className={styles.projectArea}>
      {/* Keep the Projects bar outside the session scroller so rows cannot cover it. */}
      {!loading && !error && (
        <div
          className={`sidebar-projects-header ${styles.sectionLabel} ${styles.projectsHeader}`}
        >
          <button
            type="button"
            className={styles.projectsHeaderToggle}
            onClick={() => {
              setCollapsedProjectKeys((previous) => {
                const shouldExpandAll = projectGroups.every((group) => previous.has(group.key));
                const next = new Set(previous);
                for (const group of projectGroups) {
                  if (shouldExpandAll) next.delete(group.key);
                  else next.add(group.key);
                }
                return next;
              });
            }}
            disabled={projectGroups.length === 0}
            title={t(allProjectsCollapsed ? "sidebar.expandAllProjects" : "sidebar.collapseAllProjects")}
            aria-label={t(allProjectsCollapsed ? "sidebar.expandAllProjects" : "sidebar.collapseAllProjects")}
            aria-expanded={!allProjectsCollapsed}
          >
            <span>{t("sidebar.projects")}</span>
            <AliIcon
              name="chevron-right"
              size={11}
              strokeWidth={1.8}
              className={allProjectsCollapsed ? undefined : styles.projectsHeaderChevronOpen}
            />
          </button>
          <div className={styles.sectionLabelActions}>
            <button
              type="button"
              className={styles.rowAction}
              onClick={() => void handleDefaultCwd()}
              title={t("sidebar.useDefaultDirectory")}
              aria-label={t("sidebar.useDefaultDirectory")}
            >
              <AliIcon name="home" size={12} />
            </button>
            <button
              type="button"
              className={styles.rowAction}
              onClick={handleCustomPathClick}
              title={t("sidebar.newProject")}
              aria-label={t("sidebar.newProject")}
            >
              <AliIcon name="plus" size={12} />
            </button>
          </div>
        </div>
      )}
      {/* Codex-style project folders with their conversations nested below. */}
      <div
        ref={projectScrollRef}
        data-session-drag-scroll
        className={`sidebar-project-scroll ${styles.projectScroll}`}
      >
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: "var(--text-sm)" }}>
            {error}
          </div>
        )}
        {!loading && !error && projectGroups.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            {t("sidebar.noSessions")}
          </div>
        )}
        {projectGroups.map((group) => (
          <ProjectSessionGroup
            key={group.key}
            group={group}
            homeDir={homeDir}
            isSelectedProject={selectedProject === group.projectRoot}
            isCollapsed={collapsedProjectKeys.has(group.key)}
            sessionsExpanded={expandedProjectSessionKeys.has(group.key)}
            selectedSessionId={selectedSessionId}
            runningSessionIds={runningSessionIds}
            unreadSessionIds={unreadSessionIds}
            moveTargets={moveTargets}
            attentionSessionIds={attentionSessionIds}
            onSelectProject={() => {
              setSelectedCwd(group.preferredCwd);
            }}
            onToggleProject={() => {
              setCollapsedProjectKeys((previous) => {
                const next = new Set(previous);
                if (next.has(group.key)) next.delete(group.key);
                else next.add(group.key);
                return next;
              });
            }}
            onToggleSessions={() => {
              setExpandedProjectSessionKeys((previous) => {
                const next = new Set(previous);
                if (next.has(group.key)) next.delete(group.key);
                else next.add(group.key);
                return next;
              });
            }}
            onSelectSession={handleSelectSessionFromList}
            onNewSession={handleNewSessionInProject}
            onRenamed={() => loadSessions()}
            onSessionDeleted={handleSessionDeletedWithUndo}
            sessionFlags={sessionFlags}
            onFlagChange={patchSessionFlag}
            onDuplicateSession={duplicateSession}
            onMarkUnread={markSessionUnread}
            onMoveSession={moveSession}
            isPinned={pinnedProjectRoots.has(group.projectRoot)}
            displayLabel={projectAliases[group.projectRoot] ?? getProjectLabel(group.projectRoot)}
            onTogglePinned={() => togglePinnedProject(group.projectRoot)}
            onRenameProject={(alias) => renameProject(group.projectRoot, alias)}
            onRemoveProject={() => removeProject(group.projectRoot)}
            isDragging={dragState?.sourceRoot === group.projectRoot}
            dropPosition={dragState?.targetRoot === group.projectRoot ? dragState.position : null}
            onProjectPointerDown={(event) => beginProjectDrag(group.projectRoot, event)}
            onProjectClickCapture={(event) => suppressProjectClick(group.projectRoot, event)}
            sessionOrder={sessionOrder}
            onReorderSessions={onReorderSessions}
          />
        ))}
      </div>
    </section>
  );
}
