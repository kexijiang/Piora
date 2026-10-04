import type { HarmonyFileScope } from "./device-files";

// Persist view choices, never device directory listings or permission results.
export interface DeviceFolderView {
  expandedPaths: string[];
  renderCounts: Record<string, number>;
  scrollTop: number;
  extraRoot: string;
}

export function deviceFolderViewKey(serial: string, scope: HarmonyFileScope): string {
  return `piora-harmony-folder-view:${JSON.stringify([serial, scope.kind, scope.kind === "sandbox" ? scope.bundleName : ""])}`;
}

export function parseDeviceFolderView(raw: string | null, scope: HarmonyFileScope): DeviceFolderView | null {
  if (!raw || raw.length > 2_400_000) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.expandedPaths)) return null;
    const validPath = (path: unknown): path is string => typeof path === "string" && path.length > 0 && path.length <= 4096
      && !/[\u0000-\u001f]/.test(path) && !path.split("/").some(part => part === "." || part === "..")
      && (scope.kind === "shared" ? path.startsWith("/") : /^data\/storage\/el[12]\/(?:base|database)(?:\/|$)/.test(path));
    const expandedPaths = [...new Set<string>(value.expandedPaths.filter(validPath))].slice(0, 256);
    const renderCounts = Object.fromEntries(Object.entries(value.renderCounts && typeof value.renderCounts === "object" ? value.renderCounts : {})
      .filter(([path, count]) => validPath(path) && typeof count === "number" && Number.isSafeInteger(count) && count >= 200 && count <= 100_000)
      .slice(0, 256)) as Record<string, number>;
    return { expandedPaths, renderCounts, scrollTop: typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop)
      ? Math.max(0, Math.min(10_000_000, value.scrollTop)) : 0, extraRoot: validPath(value.extraRoot) ? value.extraRoot : "" };
  } catch { return null; }
}

export function readDeviceFolderView(storage: Pick<Storage, "getItem">, key: string, scope: HarmonyFileScope): DeviceFolderView | null {
  try { return parseDeviceFolderView(storage.getItem(key), scope); } catch { return null; }
}

export function writeDeviceFolderView(storage: Pick<Storage, "setItem">, key: string, view: DeviceFolderView): void {
  try { storage.setItem(key, JSON.stringify({ version: 1, expandedPaths: view.expandedPaths.slice(0, 256),
    renderCounts: Object.fromEntries(Object.entries(view.renderCounts).slice(0, 256)), scrollTop: view.scrollTop, extraRoot: view.extraRoot })); }
  catch { /* View continuity is optional; file drafts have separate durable storage. */ }
}
