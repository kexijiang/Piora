"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, useCallback, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";
import type { SessionFlags } from "@/lib/session-flags";
import {
  buildSessionProjectGroups,
  getProjectLabel,
} from "@/lib/session-project-groups";
import { DirectoryPicker } from "./DirectoryPicker";
import type { SessionSidebarHandle, SessionSidebarProps as Props } from "./sidebar/sidebar-types";
import { WorktreeSection } from "./sidebar/WorktreeSection";
import { useWorktreeState } from "./sidebar/useWorktreeState";
import { SidebarNavigation } from "./sidebar/SidebarNavigation";
import { SidebarProjectArea } from "./sidebar/SidebarProjectArea";
import { SidebarChatArea } from "./sidebar/SidebarChatArea";
import { SidebarFooter } from "./sidebar/SidebarFooter";
import { useSessionCatalog } from "./sidebar/useSessionCatalog";
import { useProjectPicker } from "./sidebar/useProjectPicker";
import { applyProjectOrder, applySessionOrder, getRecentProjects, moveProjectRoot, moveSessionId } from "./sidebar/sidebar-utils";
import { useSidebarState } from "./sidebar/useSidebarState";
import { SidebarShell } from "./sidebar/SidebarShell";
import { RoomSidebarSection } from "./RoomSidebarSection";
import { isProjectlessChatCwd } from "@/lib/projectless-chat-path";
import { ConversationSearchDialog } from "./ConversationSearchDialog";
import type { SessionMoveTarget } from "./sidebar/TaskContextMenu";

export type { SessionSidebarHandle } from "./sidebar/sidebar-types";

const ARCHIVED_SESSION_TOAST_DURATION_MS = 5_000;

function createTemporarySessionId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export const SessionSidebar = forwardRef<SessionSidebarHandle, Props>(function SessionSidebar({ selectedSessionId, selectedRoomId, onSelectSession, onSelectSearchResult, onSelectRoom, onNewSession, onRequestNewSession, initialSessionId, initialRoomId, skipInitialProjectSelection, onInitialRestoreDone, onInitialRoomRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onFocusFileSearch, onOpenSettings, activeProjectRoot }, ref) {
  const { t } = useI18n();
  const [sessionFlags, setSessionFlags] = useState<SessionFlags>({});
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [deletedSessionToast, setDeletedSessionToast] = useState<{ session: SessionInfo; key: number } | null>(null);
  const [archivedSessionToast, setArchivedSessionToast] = useState<SessionInfo | null>(null);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const deletedSessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    collapsedProjectKeys, setCollapsedProjectKeys,
    expandedProjectSessionKeys, setExpandedProjectSessionKeys,
    pinnedProjectRoots, setPinnedProjectRoots,
    rememberedProjectRoots, setRememberedProjectRoots,
    hiddenProjectRoots, setHiddenProjectRoots,
    projectAliases, setProjectAliases,
    projectOrder, setProjectOrder,
    sessionOrder, setSessionOrder,
  } = useSidebarState();
  const handlePickedProject = useCallback((cwd: string) => {
    onNewSession?.(createTemporarySessionId(), cwd);
  }, [onNewSession]);
  const {
    customPathOpen, setCustomPathOpen, customPathError, setCustomPathError,
    customPathValidating, commitCustomPath, handleCustomPathClick, handleDefaultCwd,
  } = useProjectPicker({ setSelectedCwd, setRememberedProjectRoots, setHiddenProjectRoots, onProjectSelected: handlePickedProject });
  const { allSessions, loading, error, runningSessionIds, unreadSessionIds, completionAnnouncement, loadSessions, markSessionUnread } = useSessionCatalog({ selectedSessionId, refreshKey });
  const {
    worktreeState, wtFilter, setWtFilter, wtDropdownOpen, setWtDropdownOpen,
    wtNewOpen, setWtNewOpen, wtNewBranch, setWtNewBranch, wtError, setWtError,
    wtBusy, wtConfirmRemove, setWtConfirmRemove, wtDropdownRef, wtNewInputRef,
    handleCreateWorktree, handleRemoveWorktree,
  } = useWorktreeState({ selectedCwd, setSelectedCwd, refreshKey });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sessions/flags")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: { flags?: SessionFlags }) => { if (!cancelled) setSessionFlags(data.flags ?? {}); })
      .catch(() => { /* Flags are optional; the task list remains usable. */ });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!archivedSessionToast) return;
    const archivedSessionId = archivedSessionToast.id;
    const timer = window.setTimeout(() => {
      setArchivedSessionToast((current) => current?.id === archivedSessionId ? null : current);
    }, ARCHIVED_SESSION_TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [archivedSessionToast]);

  const restoredRef = useRef(false);

  /** Resolve the project root for a cwd from the freshest data available */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd || isProjectlessChatCwd(cwd)) return null;
    if (worktreeState && worktreeState.forCwd === cwd) return worktreeState.projectRoot;
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) return worktreeState.projectRoot;
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [worktreeState, allSessions]);

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Auto-select cwd and restore session from URL on first load. Explicitly
  // added empty projects participate even before their first session exists.
  useEffect(() => {
    if (loading || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.projectless ? null : target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions.filter((session) => (
        !session.projectless
        && !sessionFlags[session.id]?.archived
        && !hiddenProjectRoots.has(session.projectRoot ?? session.cwd)
      )));
      for (const projectRoot of rememberedProjectRoots) {
        if (!hiddenProjectRoots.has(projectRoot) && !projects.includes(projectRoot)) projects.push(projectRoot);
      }
      if (projects.length > 0) setSelectedCwd(projects[0]);
    }
  }, [allSessions, hiddenProjectRoots, initialSessionId, loading, onInitialRestoreDone, onSelectSession, rememberedProjectRoots, selectedCwd, sessionFlags, skipInitialProjectSelection]);

  useImperativeHandle(ref, () => ({
    openProjectPicker: handleCustomPathClick,
    openConversationSearch() { setConversationSearchOpen(true); },
    focusPrimaryNavigation() { primaryActionRef.current?.focus({ preventScroll: true }); },
    focusFileSearch() { onFocusFileSearch?.(); },
  }), [handleCustomPathClick, onFocusFileSearch]);
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    // Agent sessions are process-owned and keep running independently of the
    // visible chat. Switching is therefore safe and must remain immediate.
    setSelectedCwd(s.projectless ? null : s.cwd || null);
    onSelectSession(s);
  }, [onSelectSession]);

  // Undo window after a session delete: the server keeps the file in trash for
  // 5s; this toast offers restore within the same window (task T-01).
  const handleSessionDeletedWithUndo = useCallback((session: SessionInfo) => {
    onSessionDeleted?.(session);
    setDeletedSessionToast((current) => ({ session, key: (current?.key ?? 0) + 1 }));
    loadSessions();
    if (deletedSessionTimerRef.current) clearTimeout(deletedSessionTimerRef.current);
    deletedSessionTimerRef.current = setTimeout(() => {
      setDeletedSessionToast(null);
      deletedSessionTimerRef.current = null;
    }, 5_000);
  }, [onSessionDeleted, loadSessions]);

  const handleUndoDelete = useCallback(async () => {
    const toast = deletedSessionToast;
    if (!toast) return;
    const { session, key } = toast;
    setDeletedSessionToast((current) => (current?.key === key ? null : current));
    if (deletedSessionTimerRef.current) clearTimeout(deletedSessionTimerRef.current);
    deletedSessionTimerRef.current = null;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/restore`, { method: "POST" });
      if (!response.ok) throw new Error("restore failed");
      loadSessions();
    } catch {
      // Restore failed (window already purged or IO error); refresh to show the
      // session is gone.
      loadSessions();
    }
  }, [deletedSessionToast, loadSessions]);

  const patchSessionFlag = useCallback(async (
    session: SessionInfo,
    patch: { pinned?: boolean; archived?: boolean },
  ) => {
    const previous = sessionFlags[session.id] ?? {};
    const optimistic = {
      ...previous,
      ...patch,
      ...(patch.pinned === true ? { pinnedAt: previous.pinnedAt ?? new Date().toISOString() } : {}),
    };
    setSessionFlags((flags) => ({ ...flags, [session.id]: optimistic }));
    if (patch.archived === true) setArchivedSessionToast(session);
    try {
      const response = await fetch("/api/sessions/flags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, ...patch }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { flag: SessionFlags[string] };
      setSessionFlags((flags) => ({ ...flags, [session.id]: data.flag }));
    } catch {
      setSessionFlags((flags) => ({ ...flags, [session.id]: previous }));
      if (patch.archived === true) setArchivedSessionToast(null);
    }
  }, [sessionFlags]);

  const undoArchive = useCallback(() => {
    const session = archivedSessionToast;
    if (!session) return;
    setArchivedSessionToast(null);
    void patchSessionFlag(session, { archived: false });
  }, [archivedSessionToast, patchSessionFlag]);

  const duplicateSession = useCallback(async (session: SessionInfo) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/duplicate`, { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } catch {
      // Keep the current task list intact if the source is still being written.
    }
  }, [loadSessions]);

  const handleNewSessionInProject = useCallback((cwd: string) => {
    // Pi will be spawned lazily when the user sends the first message.
    onNewSession?.(createTemporarySessionId(), cwd);
  }, [onNewSession]);

  const selectedProject = projectRootFor(selectedCwd);
  const activeSessions = useMemo(
    () => allSessions.filter((session) => !sessionFlags[session.id]?.archived),
    [allSessions, sessionFlags],
  );
  const projectlessSessions = useMemo(
    () => activeSessions.filter((session) => session.projectless),
    [activeSessions],
  );
  const projectSessions = useMemo(
    () => activeSessions.filter((session) => !session.projectless),
    [activeSessions],
  );
  const reorderSessions = useCallback((sourceId: string, targetId: string, position: "before" | "after") => {
    setSessionOrder((previous) => moveSessionId(
      applySessionOrder(activeSessions, previous, (session) => session.id).map((session) => session.id),
      sourceId,
      targetId,
      position,
    ));
  }, [activeSessions, setSessionOrder]);
  const visibleSessions = useMemo(
    () => projectSessions.filter((session) => !hiddenProjectRoots.has(session.projectRoot ?? session.cwd)),
    [hiddenProjectRoots, projectSessions],
  );
  const visibleRememberedProjects = useMemo(
    () => [...rememberedProjectRoots]
      .filter((projectRoot) => !hiddenProjectRoots.has(projectRoot))
      .map((cwd) => ({ cwd })),
    [hiddenProjectRoots, rememberedProjectRoots],
  );
  const projectGroups = useMemo(
    () => applyProjectOrder(buildSessionProjectGroups(
      visibleSessions,
      selectedCwd && selectedProject && !hiddenProjectRoots.has(selectedProject)
        ? { cwd: selectedCwd, projectRoot: selectedProject }
        : null,
      visibleRememberedProjects,
    ), projectOrder, (group) => group.projectRoot),
    [hiddenProjectRoots, projectOrder, selectedCwd, selectedProject, visibleRememberedProjects, visibleSessions],
  );
  const sessionMoveTargets = useMemo<SessionMoveTarget[]>(() => projectGroups.map((group) => ({
    cwd: group.preferredCwd,
    projectRoot: group.projectRoot,
    label: projectAliases[group.projectRoot] ?? getProjectLabel(group.projectRoot),
  })), [projectAliases, projectGroups]);
  const moveSession = useCallback(async (session: SessionInfo, target: SessionMoveTarget) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: target.cwd }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (selectedSessionId === session.id) {
      setSelectedCwd(target.cwd);
      onSelectSession({
        ...session,
        cwd: target.cwd,
        projectRoot: target.projectRoot,
        projectless: undefined,
        worktreeBranch: undefined,
      });
    }
    await loadSessions();
  }, [loadSessions, onSelectSession, selectedSessionId]);
  const pinnedProjectGroups = useMemo(
    () => projectGroups.filter((group) => pinnedProjectRoots.has(group.projectRoot)),
    [pinnedProjectRoots, projectGroups],
  );
  const togglePinnedProject = useCallback((projectRoot: string) => {
    setPinnedProjectRoots((previous) => {
      const next = new Set(previous);
      if (next.has(projectRoot)) next.delete(projectRoot);
      else next.add(projectRoot);
      return next;
    });
  }, [setPinnedProjectRoots]);
  const reorderProjects = useCallback((sourceRoot: string, targetRoot: string, position: "before" | "after") => {
    setProjectOrder(() => moveProjectRoot(
      projectGroups.map((group) => group.projectRoot),
      sourceRoot,
      targetRoot,
      position,
    ));
  }, [projectGroups, setProjectOrder]);
  const renameProject = useCallback((projectRoot: string, alias: string) => {
    setProjectAliases((previous) => {
      const next = { ...previous };
      const normalized = alias.trim().slice(0, 80);
      if (normalized && normalized !== getProjectLabel(projectRoot)) next[projectRoot] = normalized;
      else delete next[projectRoot];
      return next;
    });
  }, [setProjectAliases]);
  const removeProject = useCallback((projectRoot: string) => {
    const fallback = projectGroups.find((group) => group.projectRoot !== projectRoot);
    setRememberedProjectRoots((previous) => {
      if (!previous.has(projectRoot)) return previous;
      const next = new Set(previous);
      next.delete(projectRoot);
      return next;
    });
    setHiddenProjectRoots((previous) => {
      const next = new Set(previous);
      next.add(projectRoot);
      return next;
    });
    setPinnedProjectRoots((previous) => {
      if (!previous.has(projectRoot)) return previous;
      const next = new Set(previous);
      next.delete(projectRoot);
      return next;
    });
    setProjectAliases((previous) => {
      if (!(projectRoot in previous)) return previous;
      const next = { ...previous };
      delete next[projectRoot];
      return next;
    });
    if (selectedProject === projectRoot) setSelectedCwd(fallback?.preferredCwd ?? null);
  }, [projectGroups, selectedProject, setHiddenProjectRoots, setPinnedProjectRoots, setProjectAliases, setRememberedProjectRoots]);
  const attentionSessionIds = useMemo(() => {
    const ids = new Set<string>([...runningSessionIds, ...unreadSessionIds]);
    if (selectedSessionId) ids.add(selectedSessionId);
    return ids;
  }, [runningSessionIds, unreadSessionIds, selectedSessionId]);

  // Drop stale persisted keys when projects disappear. This keeps storage
  // bounded without changing the default state of newly discovered projects.
  useEffect(() => {
    if (loading || error) return;
    const validKeys = new Set(projectGroups.map((group) => group.key));
    const prune = (previous: Set<string>) => {
      const next = new Set([...previous].filter((key) => validKeys.has(key)));
      return next.size === previous.size ? previous : next;
    };
    setCollapsedProjectKeys(prune);
    setExpandedProjectSessionKeys(prune);
    setProjectOrder((previous) => {
      const next = previous.filter((root) => validKeys.has(root));
      return next.length === previous.length ? previous : next;
    });
  }, [projectGroups, loading, error, setCollapsedProjectKeys, setExpandedProjectSessionKeys, setProjectOrder]);

  useEffect(() => {
    if (loading || error) return;
    const validIds = new Set(activeSessions.map((session) => session.id));
    setSessionOrder((previous) => {
      const next = previous.filter((id) => validIds.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [activeSessions, error, loading, setSessionOrder]);

  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject === worktreeState.projectRoot
  );
  return (
    <>
    <SidebarShell>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {completionAnnouncement
          ? completionAnnouncement.count === 1
            ? t("sidebar.taskCompleted", { title: completionAnnouncement.title })
            : t("sidebar.tasksCompleted", { count: completionAnnouncement.count, title: completionAnnouncement.title })
          : ""}
      </div>
      {customPathOpen && (
        <DirectoryPicker
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      <SidebarNavigation
        onOpenConversationSearch={() => setConversationSearchOpen(true)}
        onFocusFileSearch={onFocusFileSearch}
        primaryActionRef={primaryActionRef}
        onOpenSettings={onOpenSettings}
        selectedCwd={selectedCwd}
        selectedCwdProp={selectedCwdProp}
        projectGroups={projectGroups}
        pinnedProjectGroups={pinnedProjectGroups}
        projectAliases={projectAliases}
        setSelectedCwd={setSelectedCwd}
        setCollapsedProjectKeys={setCollapsedProjectKeys}
        handleNewSessionInProject={handleNewSessionInProject}
        onRequestNewSession={onRequestNewSession}
        handleDefaultCwd={handleDefaultCwd}
        togglePinnedProject={togglePinnedProject}
      />
      <WorktreeSection
        showWorktreeSwitcher={showWorktreeSwitcher}
        worktreeState={worktreeState}
        selectedCwd={selectedCwd}
        homeDir={homeDir}
        wtFilter={wtFilter}
        setWtFilter={setWtFilter}
        wtDropdownOpen={wtDropdownOpen}
        setWtDropdownOpen={setWtDropdownOpen}
        wtNewOpen={wtNewOpen}
        setWtNewOpen={setWtNewOpen}
        wtNewBranch={wtNewBranch}
        setWtNewBranch={setWtNewBranch}
        wtError={wtError}
        setWtError={setWtError}
        wtBusy={wtBusy}
        wtConfirmRemove={wtConfirmRemove}
        setWtConfirmRemove={setWtConfirmRemove}
        wtDropdownRef={wtDropdownRef}
        wtNewInputRef={wtNewInputRef}
        setSelectedCwd={setSelectedCwd}
        handleCreateWorktree={handleCreateWorktree}
        handleRemoveWorktree={handleRemoveWorktree}
      />
      {onSelectRoom ? (
        <RoomSidebarSection
          sessions={activeSessions}
          selectedSessionId={selectedSessionId}
          selectedRoomId={selectedRoomId ?? null}
          activeProjectRoot={activeProjectRoot}
          initialRoomId={initialRoomId}
          refreshKey={refreshKey}
          onSelectRoom={onSelectRoom}
          onInitialRestoreDone={onInitialRoomRestoreDone}
        />
      ) : null}
      <SidebarProjectArea
        loading={loading} error={error}
        handleDefaultCwd={handleDefaultCwd} handleCustomPathClick={handleCustomPathClick}
        projectGroups={projectGroups} selectedProject={selectedProject}
        collapsedProjectKeys={collapsedProjectKeys} expandedProjectSessionKeys={expandedProjectSessionKeys}
        setCollapsedProjectKeys={setCollapsedProjectKeys} setExpandedProjectSessionKeys={setExpandedProjectSessionKeys}
        selectedSessionId={selectedSessionId} runningSessionIds={runningSessionIds} unreadSessionIds={unreadSessionIds}
        attentionSessionIds={attentionSessionIds} moveTargets={sessionMoveTargets} setSelectedCwd={setSelectedCwd} homeDir={homeDir}
        handleSelectSessionFromList={handleSelectSessionFromList} handleNewSessionInProject={handleNewSessionInProject}
        loadSessions={loadSessions} handleSessionDeletedWithUndo={handleSessionDeletedWithUndo}
        sessionFlags={sessionFlags} patchSessionFlag={patchSessionFlag}
        duplicateSession={duplicateSession} markSessionUnread={(session) => markSessionUnread(session.id)} moveSession={moveSession} pinnedProjectRoots={pinnedProjectRoots} projectAliases={projectAliases}
        togglePinnedProject={togglePinnedProject} renameProject={renameProject} removeProject={removeProject}
        onReorderProjects={reorderProjects}
        sessionOrder={sessionOrder} onReorderSessions={reorderSessions}
      />
      <SidebarChatArea
        sessions={projectlessSessions}
        selectedSessionId={selectedSessionId}
        runningSessionIds={runningSessionIds}
        unreadSessionIds={unreadSessionIds}
        moveTargets={sessionMoveTargets}
        sessionFlags={sessionFlags}
        onNewChat={() => onRequestNewSession?.()}
        onSelectSession={handleSelectSessionFromList}
        onRenamed={() => void loadSessions()}
        onSessionDeleted={handleSessionDeletedWithUndo}
        onFlagChange={patchSessionFlag}
        onDuplicate={duplicateSession}
        onMarkUnread={(session) => markSessionUnread(session.id)}
        onMoveSession={moveSession}
        sessionOrder={sessionOrder}
        onReorderSessions={reorderSessions}
      />
      <SidebarFooter
        deletedToast={deletedSessionToast}
        archivedToast={archivedSessionToast}
        onUndoDelete={handleUndoDelete}
        onUndoArchive={undoArchive}
      />
    </SidebarShell>
    {conversationSearchOpen ? (
      <ConversationSearchDialog
        sessions={allSessions}
        hasProject={Boolean(activeProjectRoot)}
        onClose={() => setConversationSearchOpen(false)}
        onSelect={(session, entryId) => {
          if (onSelectSearchResult) onSelectSearchResult(session, entryId);
          else onSelectSession(session);
        }}
        onSelectSession={onSelectSession}
        onOpenSettings={(key) => onOpenSettings?.(key)}
      />
    ) : null}
    </>
  );
});
