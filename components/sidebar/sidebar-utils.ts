import type { SessionInfo } from "@/lib/types";

export const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
export const COLLAPSED_PROJECTS_STORAGE_KEY = "piora:sidebar-collapsed-projects:v1";
export const EXPANDED_PROJECT_SESSIONS_STORAGE_KEY = "piora:sidebar-expanded-project-sessions:v1";
export const PINNED_PROJECTS_STORAGE_KEY = "piora:sidebar-pinned-projects:v1";
export const PROJECT_ALIASES_STORAGE_KEY = "piora:sidebar-project-aliases:v1";
export const REMEMBERED_PROJECTS_STORAGE_KEY = "piora:sidebar-remembered-projects:v1";
export const HIDDEN_PROJECTS_STORAGE_KEY = "piora:sidebar-hidden-projects:v1";
export const PROJECT_ORDER_STORAGE_KEY = "piora:sidebar-project-order:v1";
export const SESSION_ORDER_STORAGE_KEY = "piora:sidebar-session-order:v1";
export const RUNNING_SESSIONS_POLL_MS = 2500;

export function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
  } catch { return new Set(); }
}

export function saveUnreadSessionIds(ids: Set<string>): void {
  saveStoredStringSet(UNREAD_SESSIONS_STORAGE_KEY, ids);
}

export function loadStoredStringSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === "string")) : new Set();
  } catch { return new Set(); }
}

export function saveStoredStringSet(key: string, values: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (values.size === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify([...values]));
  } catch { /* Sidebar remains usable without persistence. */ }
}

export function loadStoredStringList(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0))];
  } catch { return []; }
}

export function saveStoredStringList(key: string, values: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    if (values.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(values));
  } catch { /* Sidebar remains usable without persistence. */ }
}

/** Apply the saved order first and append newly discovered projects naturally. */
export function applyProjectOrder<T>(items: readonly T[], order: readonly string[], getRoot: (item: T) => string): T[] {
  const rank = new Map(order.map((root, index) => [root, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(getRoot(item)) }))
    .sort((left, right) => {
      if (left.rank !== undefined && right.rank !== undefined) return left.rank - right.rank;
      if (left.rank !== undefined) return -1;
      if (right.rank !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

/** Remember every displayed project, so activity updates cannot reshuffle unranked rows. */
export function reconcileProjectOrder(previous: string[], visibleRoots: readonly string[]): string[] {
  const remaining = new Set(visibleRoots);
  const next = previous.filter((root) => remaining.delete(root));
  next.push(...remaining);
  return next.length === previous.length && next.every((root, index) => root === previous[index])
    ? previous
    : next;
}

export function moveProjectRoot(
  roots: readonly string[],
  sourceRoot: string,
  targetRoot: string,
  position: "before" | "after",
): string[] {
  if (sourceRoot === targetRoot || !roots.includes(sourceRoot) || !roots.includes(targetRoot)) return [...roots];
  const next = roots.filter((root) => root !== sourceRoot);
  const targetIndex = next.indexOf(targetRoot);
  next.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceRoot);
  return next;
}

/** New sessions lead the regular section; existing rows retain their saved order. */
export function applySessionOrder<T>(
  items: readonly T[],
  order: readonly string[],
  getId: (item: T) => string,
  isPinned?: (item: T) => boolean,
): T[] {
  const known = new Set(order);
  const regularOrder = (rows: readonly T[]) => [
    ...rows.filter((item) => !known.has(getId(item))),
    ...applyProjectOrder(rows.filter((item) => known.has(getId(item))), order, getId),
  ];
  if (!isPinned) return regularOrder(items);
  const pinned: T[] = [];
  const regular: T[] = [];
  for (const item of items) (isPinned(item) ? pinned : regular).push(item);
  return [
    ...applyProjectOrder(pinned, order, getId),
    ...regularOrder(regular),
  ];
}

export function moveSessionId(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  position: "before" | "after",
): string[] {
  return moveProjectRoot(ids, sourceId, targetId, position);
}

export function loadProjectAliases(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROJECT_ALIASES_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([root, alias]) => root && typeof alias === "string" && alias.trim())
      .map(([root, alias]) => [root, String(alias).trim().slice(0, 80)]));
  } catch { return {}; }
}

export function saveProjectAliases(aliases: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(aliases).length === 0) window.localStorage.removeItem(PROJECT_ALIASES_STORAGE_KEY);
    else window.localStorage.setItem(PROJECT_ALIASES_STORAGE_KEY, JSON.stringify(aliases));
  } catch { /* Sidebar remains usable without persistence. */ }
}

export function getRecentProjects(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const previous = latestByRoot.get(root);
    if (!previous || session.modified > previous) latestByRoot.set(root, session.modified);
  }
  return [...latestByRoot].sort((left, right) => right[1].localeCompare(left[1])).map(([root]) => root);
}

export function displayCwd(cwd: string, homeDir?: string): string {
  return homeDir && cwd.startsWith(homeDir) ? `~${cwd.slice(homeDir.length)}` : cwd;
}
