"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { WorktreeEntry, WorktreeState } from "./sidebar-types";

export function useWorktreeState({ selectedCwd, setSelectedCwd, refreshKey }: {
  selectedCwd: string | null;
  setSelectedCwd: Dispatch<SetStateAction<string | null>>;
  refreshKey?: number;
}) {
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtFilter, setWtFilter] = useState("");
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!selectedCwd) { setWorktreeState(null); return; }
    let cancelled = false;
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((response) => response.json())
      .then((data: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        if (data.error || !data.projectRoot) { setWorktreeState(null); return; }
        setWorktreeState({
          forCwd: selectedCwd, projectRoot: data.projectRoot,
          isGit: data.isGit ?? false, isTopLevel: data.isTopLevel ?? false,
          worktrees: data.worktrees ?? [],
        });
      })
      .catch(() => { if (!cancelled) setWorktreeState(null); });
    return () => { cancelled = true; };
  }, [refreshKey, selectedCwd, wtRefreshKey]);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true); setWtError(null);
    try {
      const response = await fetch("/api/worktrees", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await response.json().catch(() => ({})) as { path?: string; error?: string };
      if (!response.ok || data.error || !data.path) { setWtError(data.error ?? `HTTP ${response.status}`); return; }
      setWtNewOpen(false); setWtNewBranch(""); setWtDropdownOpen(false);
      setWorktreeState((previous) => previous ? {
        ...previous, forCwd: data.path!,
        worktrees: [...previous.worktrees, { path: data.path!, branch, isMain: false }],
      } : previous);
      setSelectedCwd(data.path);
      setWtRefreshKey((key) => key + 1);
    } catch (error) { setWtError(error instanceof Error ? error.message : String(error)); }
    finally { setWtBusy(false); }
  }, [setSelectedCwd, worktreeState, wtBusy, wtNewBranch]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true); setWtError(null);
    try {
      const response = await fetch("/api/worktrees", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!response.ok) {
        if (data.dirty && !force) { setWtConfirmRemove(path); return; }
        setWtError(data.error ?? `HTTP ${response.status}`); return;
      }
      setWtConfirmRemove(null);
      if (selectedCwd === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((key) => key + 1);
    } catch (error) { setWtError(error instanceof Error ? error.message : String(error)); }
    finally { setWtBusy(false); }
  }, [selectedCwd, setSelectedCwd, worktreeState, wtBusy]);

  useEffect(() => {
    const reset = () => {
      setWtDropdownOpen(false); setWtNewOpen(false); setWtNewBranch("");
      setWtError(null); setWtConfirmRemove(null); setWtFilter("");
    };
    const close = (event: MouseEvent) => {
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(event.target as Node)) {
        reset();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const section = wtDropdownRef.current?.closest("section");
      if (!section?.contains(document.activeElement)) return;
      reset();
      section.querySelector<HTMLButtonElement>("[data-worktree-menu-trigger]")?.focus();
    };
    // The picker now participates in project layout. Dismiss on the completed
    // click, not mousedown, so removing it cannot move another button between
    // pointer-down and pointer-up. Capture still precedes that button's action.
    document.addEventListener("click", close, true);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("click", close, true); document.removeEventListener("keydown", onKeyDown); };
  }, []);

  return {
    worktreeState, wtFilter, setWtFilter, wtDropdownOpen, setWtDropdownOpen,
    wtNewOpen, setWtNewOpen, wtNewBranch, setWtNewBranch, wtError, setWtError,
    wtBusy, wtConfirmRemove, setWtConfirmRemove, wtDropdownRef, wtNewInputRef,
    handleCreateWorktree, handleRemoveWorktree,
  };
}
