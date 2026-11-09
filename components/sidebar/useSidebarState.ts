"use client";

import { useEffect, useState } from "react";
import {
  COLLAPSED_PROJECTS_STORAGE_KEY,
  EXPANDED_PROJECT_SESSIONS_STORAGE_KEY,
  HIDDEN_PROJECTS_STORAGE_KEY,
  PINNED_PROJECTS_STORAGE_KEY,
  PROJECT_ORDER_STORAGE_KEY,
  SESSION_ORDER_STORAGE_KEY,
  REMEMBERED_PROJECTS_STORAGE_KEY,
  loadProjectAliases,
  loadStoredStringList,
  loadStoredStringSet,
  saveProjectAliases,
  saveStoredStringList,
  saveStoredStringSet,
} from "./sidebar-utils";

/** Persistent expansion, project-registry, and alias state shared by the sidebar sections. */
export function useSidebarState() {
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(
    () => loadStoredStringSet(COLLAPSED_PROJECTS_STORAGE_KEY),
  );
  const [expandedProjectSessionKeys, setExpandedProjectSessionKeys] = useState<Set<string>>(
    () => loadStoredStringSet(EXPANDED_PROJECT_SESSIONS_STORAGE_KEY),
  );
  const [pinnedProjectRoots, setPinnedProjectRoots] = useState<Set<string>>(
    () => loadStoredStringSet(PINNED_PROJECTS_STORAGE_KEY),
  );
  const [rememberedProjectRoots, setRememberedProjectRoots] = useState<Set<string>>(() => new Set());
  const [hiddenProjectRoots, setHiddenProjectRoots] = useState<Set<string>>(() => new Set());
  const [projectRegistryHydrated, setProjectRegistryHydrated] = useState(false);
  const [projectAliases, setProjectAliases] = useState<Record<string, string>>(() => loadProjectAliases());
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadStoredStringList(PROJECT_ORDER_STORAGE_KEY));
  const [sessionOrder, setSessionOrder] = useState<string[]>(() => loadStoredStringList(SESSION_ORDER_STORAGE_KEY));

  useEffect(() => saveStoredStringSet(COLLAPSED_PROJECTS_STORAGE_KEY, collapsedProjectKeys), [collapsedProjectKeys]);
  useEffect(() => saveStoredStringSet(EXPANDED_PROJECT_SESSIONS_STORAGE_KEY, expandedProjectSessionKeys), [expandedProjectSessionKeys]);
  useEffect(() => saveStoredStringSet(PINNED_PROJECTS_STORAGE_KEY, pinnedProjectRoots), [pinnedProjectRoots]);
  useEffect(() => saveProjectAliases(projectAliases), [projectAliases]);
  useEffect(() => saveStoredStringList(PROJECT_ORDER_STORAGE_KEY, projectOrder), [projectOrder]);
  useEffect(() => saveStoredStringList(SESSION_ORDER_STORAGE_KEY, sessionOrder), [sessionOrder]);

  useEffect(() => {
    setRememberedProjectRoots(loadStoredStringSet(REMEMBERED_PROJECTS_STORAGE_KEY));
    setHiddenProjectRoots(loadStoredStringSet(HIDDEN_PROJECTS_STORAGE_KEY));
    setProjectRegistryHydrated(true);
  }, []);

  useEffect(() => {
    if (projectRegistryHydrated) saveStoredStringSet(REMEMBERED_PROJECTS_STORAGE_KEY, rememberedProjectRoots);
  }, [projectRegistryHydrated, rememberedProjectRoots]);

  useEffect(() => {
    if (projectRegistryHydrated) saveStoredStringSet(HIDDEN_PROJECTS_STORAGE_KEY, hiddenProjectRoots);
  }, [hiddenProjectRoots, projectRegistryHydrated]);

  return {
    collapsedProjectKeys, setCollapsedProjectKeys,
    expandedProjectSessionKeys, setExpandedProjectSessionKeys,
    pinnedProjectRoots, setPinnedProjectRoots,
    rememberedProjectRoots, setRememberedProjectRoots,
    hiddenProjectRoots, setHiddenProjectRoots,
    projectAliases, setProjectAliases,
    projectOrder, setProjectOrder,
    sessionOrder, setSessionOrder,
  };
}
