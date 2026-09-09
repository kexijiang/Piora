import type { CompanionLibraryItem } from "./companion-store";

export interface TransferTabs { ids: string[]; activeId: string | null }
export function closeTransferTab(state: TransferTabs, id: string): TransferTabs {
  const index = state.ids.indexOf(id);
  const ids = state.ids.filter((value) => value !== id);
  return { ids, activeId: state.activeId === id ? ids[Math.min(index, ids.length - 1)] ?? null : state.activeId };
}
export function restoreTransferTabs(value: unknown, items: CompanionLibraryItem[]): TransferTabs {
  const saved = value as Partial<TransferTabs> | null;
  const files = new Set(items.filter((item) => item.kind !== "folder").map((item) => item.id));
  const ids = Array.isArray(saved?.ids) ? [...new Set(saved.ids.filter((id): id is string => typeof id === "string" && files.has(id)))] : [...files].slice(0, 1);
  return { ids, activeId: saved?.activeId && ids.includes(saved.activeId) ? saved.activeId : ids[0] ?? null };
}

export function transferFolderPath(items: CompanionLibraryItem[], id: string | null): string {
  const names: string[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = items.find((item) => item.id === id && item.kind === "folder");
    if (!folder) break;
    names.unshift(folder.title); id = folder.parentId ?? null;
  }
  return names.join(" / ");
}

export function transferTreeRows(items: CompanionLibraryItem[], collapsed: Set<string>, query: string) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visible = new Set<string>();
  const search = query.trim().toLocaleLowerCase();
  for (const item of items) {
    if (search && !`${item.title}\n${item.kind === "image" ? "" : item.content}`.toLocaleLowerCase().includes(search)) continue;
    visible.add(item.id);
    let parent = item.parentId;
    const seen = new Set([item.id]);
    while (parent && !seen.has(parent)) { seen.add(parent); visible.add(parent); parent = byId.get(parent)?.parentId; }
  }
  const children = new Map<string | null, CompanionLibraryItem[]>();
  for (const item of items) {
    const parent = item.parentId && byId.get(item.parentId)?.kind === "folder" ? item.parentId : null;
    const group = children.get(parent) ?? []; group.push(item); children.set(parent, group);
  }
  const rows: Array<{ item: CompanionLibraryItem; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    const group = children.get(parent) ?? [];
    group.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.title.localeCompare(b.title, "zh-CN", { numeric: true }));
    for (const item of group) {
      if (seen.has(item.id) || !visible.has(item.id)) continue;
      seen.add(item.id); rows.push({ item, depth });
      if (item.kind === "folder" && (search || !collapsed.has(item.id))) walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
